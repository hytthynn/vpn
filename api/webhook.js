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
 * Проверяем подпись ЮMoney (HMAC-SHA256, актуально с 18.05.2026).
 * Параметры уведомления сортируются по алфавиту, URL-кодируются и
 * объединяются в строку key=value&key=value...
 */
async function verifySign(params) {
  const sign = params.get('sign');
  if (!sign) return false;

  // Собираем строку без параметра sign
  const entries = [];
  for (const [k, v] of params.entries()) {
    if (k !== 'sign') entries.push([k, v]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));

  const str = entries
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(YOOMONEY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buf  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(str));
  const hex  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  return hex === sign;
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
  if (!r.ok) throw new Error(`Panel GET ${path} → ${r.status}`);
  return r.json();
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
  if (!r.ok) throw new Error(`Panel POST ${path} → ${r.status}`);
  return r.json();
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
  if (!r.ok) throw new Error(`Panel PATCH ${path} → ${r.status}`);
  return r.json();
}

/** Найти пользователя по Telegram ID */
async function findUser(tgId) {
  try {
    const d = await panelGet(`/api/users/by-telegram-id/${tgId}`);
    const u = d?.response ?? d;
    if (u?.uuid) return u;
  } catch (_) {}

  try {
    const d = await panelPost('/api/users/resolve', { telegramId: Number(tgId) });
    const u = d?.response ?? d;
    if (u?.uuid) return u;
  } catch (_) {}

  return null;
}

/** Продлить / активировать подписку пользователя */
async function extendSubscription(user, days) {
  const uuid = user.uuid;

  // Определяем новую дату истечения
  const now       = new Date();
  const currentExpiry = user.expireAt ? new Date(user.expireAt) : null;
  const base      = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(base.getTime() + days * 86400 * 1000).toISOString();

  // Remnawave: PATCH /api/users/:uuid  { expireAt, status }
  await panelPatch(`/api/users/${uuid}`, {
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
