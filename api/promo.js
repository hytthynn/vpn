export const config = { runtime: 'edge' };

import {
  encodePromoData,
  extendSubscription,
  findUser,
  isAdminDescription,
  listPromos,
  panelDelete,
  panelPatch,
  panelPost,
} from './_panel.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function normalizePromoCode(input = '') {
  return String(input).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function parseDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return null;
  return days;
}

function parseActivationLimit(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 100000) return null;
  return count;
}

function toPublicPromo(promo) {
  const redemptionsCount = Array.isArray(promo.redemptions) ? promo.redemptions.length : 0;
  const activationLimit = Number(promo.activationLimit ?? 1);

  return {
    uuid: promo.uuid,
    code: promo.code,
    days: promo.days,
    activationLimit,
    remainingActivations: Math.max(0, activationLimit - redemptionsCount),
    active: promo.active !== false,
    createdAt: promo.createdAt,
    updatedAt: promo.updatedAt,
    createdBy: promo.createdBy ?? '',
    redemptionsCount,
  };
}

async function getPromoByCode(code) {
  const promos = await listPromos();
  return promos.find((promo) => String(promo.code).toUpperCase() === code) || null;
}

async function getPromoByUuid(uuid) {
  const promos = await listPromos();
  return promos.find((promo) => promo.uuid === uuid) || null;
}

async function requireAdmin(telegramId) {
  if (!telegramId) {
    return { error: json({ error: 'missing telegramId' }, 400) };
  }

  const user = await findUser(telegramId);
  if (!user) {
    return { error: json({ error: 'admin user not found' }, 404) };
  }

  if (!isAdminDescription(user.description || '')) {
    return { error: json({ error: 'forbidden' }, 403) };
  }

  return { user };
}

function buildPromoPayload({ code, days, activationLimit, adminUser }) {
  const now = new Date().toISOString();

  return {
    kind: 'promo',
    code,
    days,
    activationLimit,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: String(adminUser.telegramId ?? adminUser.tgId ?? ''),
    createdByUuid: adminUser.uuid,
    redemptions: [],
  };
}

function buildPromoStorageUser(code) {
  const stamp = Date.now();
  const suffix = Math.random().toString(36).slice(2, 7);
  const syntheticTelegramId = Number(`8${String(stamp).slice(-9)}${String(Math.floor(Math.random() * 900) + 100)}`);

  return {
    username: `promo_${code.toLowerCase()}_${suffix}`,
    telegramId: syntheticTelegramId,
    expireAt: new Date().toISOString(),
    status: 'DISABLED',
    trafficLimitBytes: 0,
    trafficLimitStrategy: 'NO_RESET',
  };
}

async function handleApply(body) {
  const code = normalizePromoCode(body.code);
  const telegramId = body.telegramId;

  if (!code) return json({ error: 'missing code' }, 400);
  if (!telegramId) return json({ error: 'missing telegramId' }, 400);

  const promo = await getPromoByCode(code);
  if (!promo) {
    return json({ error: 'promo not found' }, 404);
  }

  if (promo.active === false) {
    return json({ error: 'promo inactive' }, 409);
  }

  const user = await findUser(telegramId);
  if (!user) {
    return json({ error: 'user not found' }, 404);
  }

  const alreadyUsed = Array.isArray(promo.redemptions) &&
    promo.redemptions.some((entry) => String(entry.telegramId) === String(telegramId));
  const activationLimit = Number(promo.activationLimit ?? 1);
  const redemptionsCount = Array.isArray(promo.redemptions) ? promo.redemptions.length : 0;
  const remainingActivations = activationLimit - redemptionsCount;

  if (alreadyUsed) {
    return json({ error: 'promo already used' }, 409);
  }

  if (remainingActivations <= 0) {
    return json({ error: 'promo exhausted' }, 409);
  }

  const expireAt = await extendSubscription(user, promo.days);
  const now = new Date().toISOString();
  const nextPromo = {
    ...promo,
    updatedAt: now,
    redemptions: [
      ...(Array.isArray(promo.redemptions) ? promo.redemptions : []),
      { telegramId: String(telegramId), usedAt: now },
    ],
  };

  await panelPatch('/api/users', {
    uuid: promo.uuid,
    description: encodePromoData(nextPromo),
  });

  return json({
    ok: true,
    code,
    days: promo.days,
    expireAt,
  });
}

async function handleCreate(body) {
  const admin = await requireAdmin(body.telegramId);
  if (admin.error) return admin.error;

  const code = normalizePromoCode(body.code);
  const days = parseDays(body.days);
  const activationLimit = parseActivationLimit(body.activationLimit);

  if (!code || code.length < 3 || code.length > 32) {
    return json({ error: 'invalid promo code' }, 400);
  }

  if (!days) {
    return json({ error: 'invalid days value' }, 400);
  }

  if (!activationLimit) {
    return json({ error: 'invalid activation limit' }, 400);
  }

  const exists = await getPromoByCode(code);
  if (exists) {
    return json({ error: 'promo already exists' }, 409);
  }

  const promo = buildPromoPayload({ code, days, activationLimit, adminUser: admin.user });
  const storageUser = buildPromoStorageUser(code);

  const created = await panelPost('/api/users', {
    ...storageUser,
    description: encodePromoData(promo),
  });

  const createdUser = created?.response ?? created ?? {};

  return json({
    ok: true,
    promo: toPublicPromo({
      uuid: createdUser.uuid,
      ...promo,
    }),
  });
}

async function handleAdminList(url) {
  const telegramId = url.searchParams.get('telegramId');
  if (!telegramId) return json({ error: 'missing telegramId' }, 400);

  const user = await findUser(telegramId);
  if (!user) return json({ error: 'user not found' }, 404);

  const isAdmin = isAdminDescription(user.description || '');
  if (!isAdmin) {
    return json({ isAdmin: false, promos: [] });
  }

  const promos = await listPromos();
  return json({
    isAdmin: true,
    promos: promos.map(toPublicPromo),
  });
}

async function handlePatch(body) {
  const admin = await requireAdmin(body.telegramId);
  if (admin.error) return admin.error;

  const promo = await getPromoByUuid(body.promoUuid);
  if (!promo) {
    return json({ error: 'promo not found' }, 404);
  }

  if (body.action === 'toggle') {
    const nextPromo = {
      ...promo,
      active: Boolean(body.active),
      updatedAt: new Date().toISOString(),
    };
    await panelPatch('/api/users', {
      uuid: promo.uuid,
      description: encodePromoData(nextPromo),
    });

    return json({
      ok: true,
      promo: toPublicPromo(nextPromo),
    });
  }

  if (body.action === 'delete') {
    try {
      await panelDelete(`/api/users/${promo.uuid}`);
    } catch (error) {
      await panelDelete('/api/users', { uuid: promo.uuid });
    }

    return json({ ok: true, deleted: true, promoUuid: promo.uuid });
  }

  return json({ error: 'unknown action' }, 400);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (req.method === 'GET') {
      return await handleAdminList(new URL(req.url));
    }

    const body = await req.json().catch(() => ({}));

    if (req.method === 'POST') {
      if (body.action === 'create') return await handleCreate(body);
      return await handleApply(body);
    }

    if (req.method === 'PATCH') {
      return await handlePatch(body);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    console.error('[promo] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
