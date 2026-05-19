export const config = { runtime: 'edge' };

import {
  findUser,
  isAdminDescription,
  listUsers,
  panelPatch,
  panelPost,
} from './_panel.js';

const STORAGE_PREFIX = 'maintenance_v1:';
const DEFAULT_MESSAGE = 'Сервис временно недоступен. Пожалуйста, попробуйте позже.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function parseMaintenanceState(description = '') {
  if (!String(description).startsWith(STORAGE_PREFIX)) return null;

  try {
    const parsed = JSON.parse(String(description).slice(STORAGE_PREFIX.length));
    return {
      enabled: Boolean(parsed?.enabled),
      message: String(parsed?.message || DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE,
      updatedAt: String(parsed?.updatedAt || ''),
      updatedBy: String(parsed?.updatedBy || ''),
    };
  } catch (error) {
    console.warn('[maintenance] failed to parse state:', error.message);
    return null;
  }
}

function encodeMaintenanceState(state) {
  return STORAGE_PREFIX + JSON.stringify({
    enabled: Boolean(state?.enabled),
    message: String(state?.message || DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE,
    updatedAt: String(state?.updatedAt || ''),
    updatedBy: String(state?.updatedBy || ''),
  });
}

async function findStorageUser() {
  const users = await listUsers();
  return users.find((user) => parseMaintenanceState(user.description || ''));
}

async function readState() {
  const storageUser = await findStorageUser();
  const state = parseMaintenanceState(storageUser?.description || '') || {
    enabled: false,
    message: DEFAULT_MESSAGE,
    updatedAt: '',
    updatedBy: '',
  };

  return { storageUser, state };
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

function buildStorageUser(description) {
  const stamp = Date.now();
  const suffix = Math.random().toString(36).slice(2, 7);
  const syntheticTelegramId = Number(`7${String(stamp).slice(-9)}${String(Math.floor(Math.random() * 900) + 100)}`);

  return {
    username: `system_maintenance_${suffix}`,
    telegramId: syntheticTelegramId,
    expireAt: new Date().toISOString(),
    status: 'DISABLED',
    trafficLimitBytes: 0,
    trafficLimitStrategy: 'NO_RESET',
    description,
  };
}

async function saveState(state) {
  const description = encodeMaintenanceState(state);
  const { storageUser } = await readState();

  if (storageUser?.uuid) {
    await panelPatch('/api/users', {
      uuid: storageUser.uuid,
      description,
      status: 'DISABLED',
    });
    return { ...storageUser, description };
  }

  return panelPost('/api/users', buildStorageUser(description));
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (req.method === 'GET') {
      const { state } = await readState();
      return json({
        ok: true,
        enabled: state.enabled,
        message: state.message,
        updatedAt: state.updatedAt,
      });
    }

    if (req.method !== 'PATCH') {
      return json({ error: 'method not allowed' }, 405);
    }

    const body = await req.json().catch(() => ({}));
    const admin = await requireAdmin(body.telegramId);
    if (admin.error) return admin.error;

    const nextState = {
      enabled: Boolean(body.enabled),
      message: DEFAULT_MESSAGE,
      updatedAt: new Date().toISOString(),
      updatedBy: String(admin.user.telegramId ?? admin.user.tgId ?? admin.user.telegram_id ?? ''),
    };

    await saveState(nextState);

    return json({
      ok: true,
      enabled: nextState.enabled,
      message: nextState.message,
      updatedAt: nextState.updatedAt,
    });
  } catch (error) {
    console.error('[maintenance] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
