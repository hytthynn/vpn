export const config = { runtime: 'edge' };

import { findUser, isAdminDescription, panelPatch } from './_panel.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
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

function normalizeTelegramId(value) {
  const clean = String(value || '').trim();
  return /^\d{4,20}$/.test(clean) ? clean : '';
}

function parseDiscountPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > 90) return null;
  return n;
}

function setDiscountPercent(description = '', percent = 0) {
  const trimmed = String(description || '').trim();
  const without = trimmed
    .replace(/(?:^|\s)discount_percent:\d{1,2}(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!percent) return without;
  return [without, `discount_percent:${percent}`].filter(Boolean).join(' ').trim();
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const admin = await requireAdmin(body.telegramId);
    if (admin.error) return admin.error;

    const targetTelegramId = normalizeTelegramId(body.targetTelegramId);
    if (!targetTelegramId) {
      return json({ error: 'invalid target telegram id' }, 400);
    }

    const discountPercent = parseDiscountPercent(body.discountPercent);
    if (discountPercent === null) {
      return json({ error: 'invalid discount percent' }, 400);
    }

    const targetUser = await findUser(targetTelegramId);
    if (!targetUser) {
      return json({ error: 'user not found' }, 404);
    }

    const nextDescription = setDiscountPercent(targetUser.description || '', discountPercent);
    await panelPatch('/api/users', {
      uuid: targetUser.uuid,
      description: nextDescription,
    });

    return json({
      ok: true,
      targetTelegramId,
      discountPercent,
    });
  } catch (error) {
    console.error('[discount] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}

