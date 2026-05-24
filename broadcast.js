const PANEL_URL = process.env.PANEL_URL;
const API_TOKEN = process.env.API_TOKEN;
const NGINX_COOKIE = process.env.NGINX_COOKIE;

const PROMO_PREFIX = 'promo_v1:';

function panelHeaders(json = false) {
  return {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Cookie': NGINX_COOKIE,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function panelRequest(method, path, body) {
  const response = await fetch(PANEL_URL + path, {
    method,
    headers: panelHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  console.log(`[panel ${method} ${path}] status=${response.status} body=${text.slice(0, 300)}`);

  if (!response.ok) {
    throw new Error(`Panel ${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  }

  return text ? JSON.parse(text) : null;
}

export function panelGet(path) {
  return panelRequest('GET', path);
}

export function panelPost(path, body) {
  return panelRequest('POST', path, body);
}

export function panelPatch(path, body) {
  return panelRequest('PATCH', path, body);
}

export function panelDelete(path, body) {
  return panelRequest('DELETE', path, body);
}

export function extractUser(data) {
  if (!data) return null;
  if (data.response?.uuid) return data.response;
  if (Array.isArray(data.response) && data.response[0]?.uuid) return data.response[0];
  if (data.uuid) return data;
  if (Array.isArray(data.users) && data.users[0]?.uuid) return data.users[0];
  return null;
}

export async function listUsers(size = 500) {
  const data = await panelGet(`/api/users?size=${size}`);
  return data?.response?.users ?? data?.users ?? data?.response ?? [];
}

export async function findUser(tgId) {
  try {
    const data = await panelGet(`/api/users/by-telegram-id/${tgId}`);
    const user = extractUser(data);
    if (user) {
      console.log('[findUser] by-telegram-id:', user.uuid);
      return user;
    }
  } catch (error) {
    console.warn('[findUser] by-telegram-id error:', error.message);
  }

  try {
    const data = await panelPost('/api/users/resolve', { telegramId: Number(tgId) });
    const user = extractUser(data);
    if (user) {
      console.log('[findUser] resolve:', user.uuid);
      return user;
    }
  } catch (error) {
    console.warn('[findUser] resolve error:', error.message);
  }

  try {
    const users = await listUsers();
    const found = users.find((user) =>
      String(user.telegramId) === String(tgId) ||
      String(user.tgId) === String(tgId) ||
      String(user.telegram_id) === String(tgId)
    );

    if (found?.uuid) {
      console.log('[findUser] list scan:', found.uuid);
      return found;
    }
  } catch (error) {
    console.warn('[findUser] list scan error:', error.message);
  }

  return null;
}

export async function extendSubscription(user, days) {
  const now = new Date();
  const current = user.expireAt ? new Date(user.expireAt) : null;
  const base = current && current > now ? current : now;
  const expireAt = new Date(base.getTime() + days * 86400000).toISOString();

  await panelPatch('/api/users', {
    uuid: user.uuid,
    expireAt,
    status: 'ACTIVE',
  });

  return expireAt;
}

export function isAdminDescription(description = '') {
  return String(description).toLowerCase().includes('admin');
}

export function encodePromoData(data) {
  return PROMO_PREFIX + JSON.stringify(data);
}

export function decodePromoData(description = '') {
  if (!description.startsWith(PROMO_PREFIX)) return null;

  try {
    const parsed = JSON.parse(description.slice(PROMO_PREFIX.length));
    return parsed && parsed.kind === 'promo' ? parsed : null;
  } catch (error) {
    console.warn('[promo] failed to parse promo data:', error.message);
    return null;
  }
}

export async function listPromos() {
  const users = await listUsers();

  return users
    .map((user) => {
      const promo = decodePromoData(user.description || '');
      if (!promo) return null;

      return {
        uuid: user.uuid,
        username: user.username,
        status: user.status,
        ...promo,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
