export const config = { runtime: 'edge' };

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PANEL_URL    = 'https://panel.hexsad.ru';
const API_TOKEN    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMzllMGZlNDgtY2NlZS00Nzc1LWIwMzktYjhkZjM1ZjA4YTQ5IiwidXNlcm5hbWUiOm51bGwsInJvbGUiOiJBUEkiLCJpYXQiOjE3NzkwNTg0MDgsImV4cCI6MTA0MTg5NzIwMDh9._YPVQXC4Rq8dOqkBx7u1Q-enmFolGCjbhcGpuJPTgcA';
const NGINX_COOKIE = 'iaKQrsnp=gCqXPowZ';

// ⚠️  Скопируйте секрет из настроек HTTP-уведомлений вашего кошелька ЮMoney
// https://yoomoney.ru/transfer/myservices/http-notification → «Показать секрет»
const YOOMONEY_SECRET = 'ccRzWFtoDUTkuxPz8J3rUPJ8';

// Номер кошелька ЮMoney — для формирования ссылки оплаты
export const WALLET_ID = '4100118505804569'; // ← вставьте номер кошелька (напр. '4100116XXXXXXXXX')

// Планы: label → кол-во дней подписки
const PLANS = {
  '1m':  30,
  '3m':  90,
  '12m': 365,
};

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Проверяем подпись ЮMoney (SHA-1).
 * Официальный алгоритм: строка из фиксированных полей, разделённых '&',
 * где вместо notification_secret подставляется секрет кошелька.
 * Поля: notification_type&operation_id&amount&currency&datetime&sender&codepro&notification_secret&label
 * Документация: https://yoomoney.ru/docs/payment-buttons/using-api/notifications
 */
async function verifySign(params) {
  const receivedHash = params.get('sha1_hash');
  if (!receivedHash) return false;

  // Фиксированный порядок полей согласно документации ЮMoney
  const FIELDS = [
    'notification_type',
    'operation_id',
    'amount',
    'currency',
    'datetime',
    'sender',
    'codepro',
    'notification_secret', // заменяется на секрет
    'label',
  ];

  const str = FIELDS.map(f =>
    f === 'notification_secret' ? YOOMONEY_SECRET : (params.get(f) ?? '')
  ).join('&');

  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  return hex === receivedHash;
}

/**
 * label формата:  averra_<tgId>_<plan>
 * Пример:         averra_123456789_3m
 */
function parseLabel(label = '') {
  const parts = label.split('_');
  if (parts.length < 3 || parts[0] !== 'averra') return null;
  const tgId = parts[1];
  const plan = parts[2]; // '1m' | '3m' | '12m'
  return { tgId, plan };
}

async function panelGet(path) {
  const r = await fetch(PANEL_URL + path, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Cookie':        NGINX_COOKIE,
    },
  });
  const text = await r.text();
  console.log(`[panel GET ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel GET ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function panelPost(path, body) {
  const r = await fetch(PANEL_URL + path, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Cookie':        NGINX_COOKIE,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`[panel POST ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel POST ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function panelPatch(path, body) {
  const r = await fetch(PANEL_URL + path, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Cookie':        NGINX_COOKIE,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`[panel PATCH ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel PATCH ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Достать объект пользователя из любого формата ответа панели */
function extractUser(d) {
  if (!d) return null;
  // { response: { uuid, ... } }
  if (d.response?.uuid) return d.response;
  // { response: [ { uuid, ... } ] }
  if (Array.isArray(d.response) && d.response[0]?.uuid) return d.response[0];
  // { uuid, ... }
  if (d.uuid) return d;
  // { users: [ { uuid, ... } ] }
  if (Array.isArray(d.users) && d.users[0]?.uuid) return d.users[0];
  return null;
}

/** Найти пользователя по Telegram ID */
async function findUser(tgId) {
  // 1. GET /api/users/by-telegram-id/:id
  try {
    const d = await panelGet(`/api/users/by-telegram-id/${tgId}`);
    const u = extractUser(d);
    if (u) { console.log('[findUser] found via by-telegram-id:', u.uuid); return u; }
    console.warn('[findUser] by-telegram-id returned no uuid, raw:', JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.warn('[findUser] by-telegram-id error:', e.message);
  }

  // 2. POST /api/users/resolve  { telegramId }
  try {
    const d = await panelPost('/api/users/resolve', { telegramId: Number(tgId) });
    const u = extractUser(d);
    if (u) { console.log('[findUser] found via resolve:', u.uuid); return u; }
    console.warn('[findUser] resolve returned no uuid, raw:', JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.warn('[findUser] resolve error:', e.message);
  }

  // 3. GET /api/users?size=500 и поиск по telegramId
  try {
    const d = await panelGet('/api/users?size=500');
    const list = d?.response?.users ?? d?.users ?? d?.response ?? [];
    if (Array.isArray(list)) {
      const found = list.find(u =>
        String(u.telegramId) === String(tgId) ||
        String(u.tgId)       === String(tgId) ||
        String(u.telegram_id)=== String(tgId)
      );
      if (found?.uuid) { console.log('[findUser] found via list scan:', found.uuid); return found; }
      console.warn('[findUser] list scan: no match among', list.length, 'users');
    }
  } catch (e) {
    console.warn('[findUser] list scan error:', e.message);
  }

  return null;
}

/** Продлить / активировать подписку пользователя */
async function extendSubscription(user, days) {
  const uuid = user.uuid;

  // Определяем новую дату истечения
  const now           = new Date();
  const currentExpiry = user.expireAt ? new Date(user.expireAt) : null;
  const base          = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry     = new Date(base.getTime() + days * 86400 * 1000).toISOString();

  // Remnawave API v2: PATCH /api/users — uuid передаётся в теле, не в URL
  await panelPatch('/api/users', {
    uuid:     uuid,
    expireAt: newExpiry,
    status:   'ACTIVE',
  });
}

// ─── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  let params;
  try {
    const text = await req.text();
    params = new URLSearchParams(text);
  } catch {
    return new Response('Bad Request', { status: 400, headers: CORS });
  }

  // 1. Проверяем подпись
  const valid = await verifySign(params);
  if (!valid) {
    console.warn('[webhook] invalid sign:', Object.fromEntries(params));
    // Возвращаем 200 чтобы ЮMoney не повторяла запрос, но ничего не делаем
    return new Response('invalid sign', { status: 200, headers: CORS });
  }

  // 2. Читаем параметры уведомления
  const notificationType = params.get('notification_type'); // p2p-incoming | card-incoming
  const label            = params.get('label') ?? '';
  const amount           = parseFloat(params.get('amount') ?? '0');
  const codepro          = params.get('codepro') === 'true';

  console.log('[webhook]', { notificationType, label, amount });

  // Игнорируем переводы с кодом протекции (они не зачислены)
  if (codepro) {
    return new Response('codepro ignored', { status: 200, headers: CORS });
  }

  // 3. Разбираем label
  const parsed = parseLabel(label);
  if (!parsed) {
    console.warn('[webhook] unknown label:', label);
    return new Response('unknown label', { status: 200, headers: CORS });
  }

  const { tgId, plan } = parsed;
  const days = PLANS[plan];
  if (!days) {
    console.warn('[webhook] unknown plan:', plan);
    return new Response('unknown plan', { status: 200, headers: CORS });
  }

  // 4. Находим пользователя в панели
  let user;
  try {
    user = await findUser(tgId);
  } catch (err) {
    console.error('[webhook] findUser error:', err);
    // Возвращаем 500 — ЮMoney повторит попытку через 10 минут и через час
    return new Response('panel error', { status: 500, headers: CORS });
  }

  if (!user) {
    console.warn('[webhook] user not found, tgId:', tgId);
    // Пользователь не найден — отвечаем 200 (иначе ЮMoney будет долбиться)
    return new Response('user not found', { status: 200, headers: CORS });
  }

  // 5. Продлеваем подписку
  try {
    await extendSubscription(user, days);
    console.log(`[webhook] ✓ extended ${tgId} by ${days} days (plan=${plan}, amount=${amount})`);
  } catch (err) {
    console.error('[webhook] extendSubscription error:', err);
    return new Response('extend error', { status: 500, headers: CORS });
  }

  // 6. Отвечаем 200 — ЮMoney считает уведомление доставленным
  return new Response('ok', { status: 200, headers: CORS });
}
