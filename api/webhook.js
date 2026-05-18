export const config = { runtime: 'edge' };

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PANEL_URL    = process.env.PANEL_URL;
const API_TOKEN    = process.env.API_TOKEN;
const NGINX_COOKIE = process.env.NGINX_COOKIE;

const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET;
export const WALLET_ID = process.env.WALLET_ID;

// Планы: label → кол-во дней подписки
const PLANS = {
  '1m':  30,
  '3m':  90,
  '12m': 365,
};

// Реферальный бонус: 15% дней от оплаченного плана
const REF_BONUS_PERCENT = 0.15;

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────

async function verifySign(params) {
  // ЮMoney шлёт разные поля в зависимости от типа платежа:
  // p2p-incoming  -> sha1_hash
  // card-incoming -> sign (SHA-1 тот же алгоритм, другое имя поля)
  const receivedHash = params.get('sha1_hash') || params.get('sign');

  if (!receivedHash) {
    console.warn('[sign] no sha1_hash/sign in params:', JSON.stringify(Object.fromEntries(params)));
    return false;
  }

  if (!YOOMONEY_SECRET) {
    console.error('[sign] YOOMONEY_SECRET env var is not set!');
    return false;
  }

  // Официальный порядок полей по документации ЮMoney
  // Для card-incoming operation_id приходит пустым — используем operation_label
  const notifType = params.get('notification_type') ?? '';
  const operationId = notifType === 'card-incoming'
    ? (params.get('operation_label') ?? params.get('operation_id') ?? '')
    : (params.get('operation_id') ?? '');

  const FIELDS = [
    'notification_type', 'operation_id', 'amount', 'currency',
    'datetime', 'sender', 'codepro', 'notification_secret', 'label',
  ];
  const str = FIELDS.map(f => {
    if (f === 'notification_secret') return YOOMONEY_SECRET;
    if (f === 'operation_id') return operationId;
    return params.get(f) ?? '';
  }).join('&');

  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (hex !== receivedHash) {
    console.warn('[sign] MISMATCH — received:', receivedHash, '| computed:', hex);
    console.warn('[sign] secret len:', YOOMONEY_SECRET.length, '| str:', str.replace(YOOMONEY_SECRET, '***'));
    return false;
  }

  console.log('[sign] OK, type:', params.get('notification_type'));
  return true;
}

// label: averra_<tgId>_<plan>
function parseLabel(label = '') {
  const parts = label.split('_');
  if (parts.length < 3 || parts[0] !== 'averra') return null;
  return { tgId: parts[1], plan: parts[2] };
}

async function panelGet(path) {
  const r = await fetch(PANEL_URL + path, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Cookie': NGINX_COOKIE },
  });
  const text = await r.text();
  console.log(`[panel GET ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel GET ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function panelPost(path, body) {
  const r = await fetch(PANEL_URL + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Cookie': NGINX_COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`[panel POST ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel POST ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function panelPatch(path, body) {
  const r = await fetch(PANEL_URL + path, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Cookie': NGINX_COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`[panel PATCH ${path}] status=${r.status} body=${text.slice(0, 300)}`);
  if (!r.ok) throw new Error(`Panel PATCH ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function extractUser(d) {
  if (!d) return null;
  if (d.response?.uuid) return d.response;
  if (Array.isArray(d.response) && d.response[0]?.uuid) return d.response[0];
  if (d.uuid) return d;
  if (Array.isArray(d.users) && d.users[0]?.uuid) return d.users[0];
  return null;
}

async function findUser(tgId) {
  try {
    const d = await panelGet(`/api/users/by-telegram-id/${tgId}`);
    const u = extractUser(d);
    if (u) { console.log('[findUser] by-telegram-id:', u.uuid); return u; }
  } catch (e) { console.warn('[findUser] by-telegram-id error:', e.message); }

  try {
    const d = await panelPost('/api/users/resolve', { telegramId: Number(tgId) });
    const u = extractUser(d);
    if (u) { console.log('[findUser] resolve:', u.uuid); return u; }
  } catch (e) { console.warn('[findUser] resolve error:', e.message); }

  try {
    const d = await panelGet('/api/users?size=500');
    const list = d?.response?.users ?? d?.users ?? d?.response ?? [];
    if (Array.isArray(list)) {
      const found = list.find(u =>
        String(u.telegramId) === String(tgId) ||
        String(u.tgId)       === String(tgId) ||
        String(u.telegram_id)=== String(tgId)
      );
      if (found?.uuid) { console.log('[findUser] list scan:', found.uuid); return found; }
    }
  } catch (e) { console.warn('[findUser] list scan error:', e.message); }

  return null;
}

async function extendSubscription(user, days) {
  const now     = new Date();
  const current = user.expireAt ? new Date(user.expireAt) : null;
  const base    = current && current > now ? current : now;
  const newExp  = new Date(base.getTime() + days * 86400000).toISOString();
  await panelPatch('/api/users', { uuid: user.uuid, expireAt: newExp, status: 'ACTIVE' });
  return newExp;
}

/**
 * Реферальный бонус:
 * 1. Читаем description приглашённого — там "ref:<inviterTgId>"
 * 2. Находим реферера
 * 3. Продлеваем подписку реферера на floor(days * 15%)
 * 4. В description реферала обновляем "ref_bonus:<totalDays>" для статистики
 */
async function processReferralBonus(referredUser, paidDays) {
  const desc = referredUser.description || '';

  const refMatch = desc.match(/ref:(\d+)/);
  if (!refMatch) {
    console.log('[ref] no inviter in description, skip');
    return;
  }

  const inviterTgId = refMatch[1];
  const bonusDays   = Math.max(1, Math.floor(paidDays * REF_BONUS_PERCENT));
  console.log(`[ref] inviter=${inviterTgId} bonus=${bonusDays}d (${paidDays}*${REF_BONUS_PERCENT})`);

  const inviter = await findUser(inviterTgId);
  if (!inviter) {
    console.warn('[ref] inviter not found:', inviterTgId);
    return;
  }

  await extendSubscription(inviter, bonusDays);
  console.log(`[ref] bonus ${bonusDays}d -> inviter ${inviterTgId} (${inviter.uuid})`);

  // Обновляем счётчик начисленных бонусов в description реферала
  const prevMatch  = desc.match(/ref_bonus:(\d+)/);
  const prevBonus  = prevMatch ? parseInt(prevMatch[1], 10) : 0;
  const totalBonus = prevBonus + bonusDays;
  const newDesc    = desc.replace(/ref_bonus:\d+/, '').trim() + ' ref_bonus:' + totalBonus;

  try {
    await panelPatch('/api/users', { uuid: referredUser.uuid, description: newDesc.trim() });
    console.log(`[ref] description updated: "${newDesc.trim()}"`);
  } catch (e) {
    console.warn('[ref] description update failed (bonus already credited):', e.message);
  }
}

// ─── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

  let params;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return new Response('Bad Request', { status: 400, headers: CORS });
  }

  // 1. Проверяем подпись
  if (!(await verifySign(params))) {
    console.warn('[webhook] invalid sign');
    return new Response('invalid sign', { status: 200, headers: CORS });
  }

  // 2. Параметры
  const label   = params.get('label') ?? '';
  const amount  = parseFloat(params.get('amount') ?? '0');
  const codepro = params.get('codepro') === 'true';
  console.log('[webhook]', { label, amount });

  if (codepro) return new Response('codepro ignored', { status: 200, headers: CORS });

  // 3. Разбираем label
  const parsed = parseLabel(label);
  if (!parsed) { console.warn('[webhook] unknown label:', label); return new Response('unknown label', { status: 200, headers: CORS }); }

  const { tgId, plan } = parsed;
  const days = PLANS[plan];
  if (!days) { console.warn('[webhook] unknown plan:', plan); return new Response('unknown plan', { status: 200, headers: CORS }); }

  // 4. Находим пользователя
  let user;
  try { user = await findUser(tgId); }
  catch (err) { console.error('[webhook] findUser error:', err); return new Response('panel error', { status: 500, headers: CORS }); }

  if (!user) { console.warn('[webhook] user not found:', tgId); return new Response('user not found', { status: 200, headers: CORS }); }

  // 5. Продлеваем подписку
  try {
    await extendSubscription(user, days);
    console.log(`[webhook] extended ${tgId} by ${days}d (plan=${plan}, amount=${amount})`);
  } catch (err) {
    console.error('[webhook] extendSubscription error:', err);
    return new Response('extend error', { status: 500, headers: CORS });
  }

  // 6. Реферальный бонус (не блокируем — ошибка бонуса не должна ронять webhook)
  try { await processReferralBonus(user, days); }
  catch (err) { console.error('[webhook] referral bonus error:', err); }

  return new Response('ok', { status: 200, headers: CORS });
}
