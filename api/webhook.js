export const config = { runtime: 'edge' };

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PANEL_URL    = process.env.PANEL_URL;
const API_TOKEN    = process.env.API_TOKEN;
const NGINX_COOKIE = process.env.NGINX_COOKIE;

const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET;
export const WALLET_ID = process.env.WALLET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BRAND_NAME = process.env.BRAND_NAME || 'averra';
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE || 'Europe/Moscow';

// Планы: label → кол-во дней подписки
const PLANS = {
  '1m':  30,
  '3m':  90,
  '12m': 365,
};

// Реферальный бонус: 15% дней от оплаченного плана
const REF_BONUS_PERCENT = 0.15;
const TX_LOG_MARKER = 'txlog_v1:';

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Новый алгоритм подписи ЮMoney (с 18 мая 2026):
 * sign = HMAC-SHA256(secretKey, sortedUrlEncodedParams)
 *
 * Шаги:
 * 1. Берём все параметры кроме sign
 * 2. Сортируем по алфавиту
 * 3. URL-кодируем значения (RFC 3986)
 * 4. Объединяем в строку key=value&key=value...
 * 5. HMAC-SHA256 с секретным ключом → HEX
 */
async function verifySign(params) {
  const receivedSign = params.get('sign');

  if (!receivedSign) {
    console.warn('[sign] no sign param. params:', JSON.stringify(Object.fromEntries(params)));
    return false;
  }

  if (!YOOMONEY_SECRET) {
    console.error('[sign] YOOMONEY_SECRET env var is not set!');
    return false;
  }

  // Берём все параметры кроме sign, сортируем по алфавиту
  const entries = [...params.entries()]
    .filter(([k]) => k !== 'sign')
    .sort(([a], [b]) => a.localeCompare(b));

  // URL-кодируем значения (RFC 3986)
  function rfc3986Encode(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  const strToSign = entries.map(([k, v]) => k + '=' + rfc3986Encode(v)).join('&');

  // HMAC-SHA256
  const keyData   = new TextEncoder().encode(YOOMONEY_SECRET);
  const msgData   = new TextEncoder().encode(strToSign);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf    = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const computed  = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed !== receivedSign) {
    console.warn('[sign] MISMATCH — received:', receivedSign);
    console.warn('[sign] computed :', computed);
    console.warn('[sign] secret len:', YOOMONEY_SECRET.length);
    console.warn('[sign] strToSign:', strToSign.slice(0, 300));
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

function isAdminDescription(description = '') {
  return String(description).toLowerCase().includes('admin');
}

function getTelegramId(user) {
  const raw = user?.telegramId ?? user?.tgId ?? user?.telegram_id;
  if (!raw) return '';
  return String(raw).trim();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function normalizeUrl(url = '') {
  return String(url).trim().replace(/\/+$/, '');
}

function appendStartPayload(urlString, startPayload = '') {
  const url = new URL(urlString);
  if (startPayload) url.searchParams.set('startapp', startPayload);
  return url.toString();
}

function isTelegramMiniAppUrl(url = '') {
  return /^https:\/\/t\.me\/[^/]+\/app(?:[/?#]|$)/i.test(String(url).trim());
}

function buildWebAppUrl(req, startPayload = '') {
  const explicitUrl = normalizeUrl(process.env.WEBAPP_URL);
  const baseUrl = explicitUrl || new URL(req.url).origin;
  return appendStartPayload(baseUrl + '/', startPayload);
}

function buildOpenAppButton(req, startPayload = '') {
  const explicitUrl = normalizeUrl(process.env.WEBAPP_URL);
  const targetUrl = explicitUrl ? appendStartPayload(explicitUrl, startPayload) : buildWebAppUrl(req, startPayload);

  if (isTelegramMiniAppUrl(targetUrl)) {
    return {
      text: '📲 Открыть приложение',
      url: targetUrl,
    };
  }

  return {
    text: '📲 Открыть приложение',
    web_app: { url: targetUrl },
  };
}

function formatExpireDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'скоро';
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
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

async function telegramRequest(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN env var is not set');
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data;
}

async function listAdminRecipients() {
  const data = await panelGet('/api/users?size=500');
  const users = data?.response?.users ?? data?.users ?? data?.response ?? [];
  const seen = new Set();
  const admins = [];

  for (const user of Array.isArray(users) ? users : []) {
    if (!isAdminDescription(user.description || '')) continue;

    const telegramId = getTelegramId(user);
    if (!telegramId || seen.has(telegramId)) continue;

    seen.add(telegramId);
    admins.push({
      telegramId,
      username: user.username || '',
    });
  }

  return admins;
}

function formatPlanLabel(plan) {
  if (plan === '12m') return '12 месяцев';
  if (plan === '3m') return '3 месяца';
  if (plan === '1m') return '1 месяц';
  return plan || 'неизвестно';
}

async function notifyAdminsAboutPayment(user, payment) {
  const admins = await listAdminRecipients();
  if (!admins.length) {
    console.warn('[webhook] no admin recipients for payment notification');
    return;
  }

  const userTelegramId = getTelegramId(user);
  const userName = user.username ? '@' + user.username : 'без username';
  const text =
`<b>✅ Успешное пополнение</b>

Пользователь: <b>${escapeHtml(userName)}</b>
Telegram ID: <code>${escapeHtml(userTelegramId)}</code>
Тариф: <b>${escapeHtml(formatPlanLabel(payment.plan))}</b>
Начислено: <b>${payment.days} дн.</b>
Сумма: <b>${payment.amount}</b>
Операция: <code>${escapeHtml(payment.operationId || '—')}</code>`;

  for (const admin of admins) {
    try {
      await telegramRequest('sendMessage', {
        chat_id: Number(admin.telegramId),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      console.error('[webhook] admin notify error:', admin.telegramId, error);
    }
  }
}

async function notifyUserAboutPayment(req, user, payment) {
  const telegramId = getTelegramId(user);
  if (!telegramId) {
    console.warn('[webhook] user telegram id missing for payment notification');
    return;
  }

  const text =
`<b>✅ Пополнение прошло успешно</b>

Спасибо за оплату ${escapeHtml(BRAND_NAME)}.
Тариф: <b>${escapeHtml(formatPlanLabel(payment.plan))}</b>
Начислено: <b>${payment.days} дн.</b>
Сумма: <b>${payment.amount}</b>
${payment.expireAt ? `Подписка активна до: <b>${escapeHtml(formatExpireDate(payment.expireAt))}</b>` : ''}`;

  await telegramRequest('sendMessage', {
    chat_id: Number(telegramId),
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [buildOpenAppButton(req)],
      ],
    },
    disable_web_page_preview: true,
  });
}

async function notifyInviterAboutReferralPayment(req, inviter, bonus) {
  const telegramId = getTelegramId(inviter);
  if (!telegramId) {
    console.warn('[webhook] inviter telegram id missing for referral notification');
    return;
  }

  const text =
`<b>🎉 Пополнение по вашей реферальной ссылке</b>

Один из приглашённых пользователей оплатил подписку.
Вам начислено: <b>${bonus.bonusDays} дн.</b>
${bonus.expireAt ? `Подписка активна до: <b>${escapeHtml(formatExpireDate(bonus.expireAt))}</b>` : ''}`;

  await telegramRequest('sendMessage', {
    chat_id: Number(telegramId),
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [buildOpenAppButton(req)],
      ],
    },
    disable_web_page_preview: true,
  });
}

function readTransactionLog(description = '') {
  const match = String(description).match(/txlog_v1:([^\s]+)/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(decodeURIComponent(match[1]));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[tx] parse error:', error.message);
    return [];
  }
}

function writeTransactionLog(description = '', transactions = []) {
  const cleanDescription = String(description).replace(/\s*txlog_v1:[^\s]+/g, '').trim();
  const payload = TX_LOG_MARKER + encodeURIComponent(JSON.stringify(transactions.slice(0, 20)));
  return cleanDescription ? `${cleanDescription} ${payload}` : payload;
}

async function saveSuccessfulTransaction(tgId, transaction) {
  const freshUser = await findUser(tgId);
  if (!freshUser?.uuid) {
    console.warn('[tx] user not found while saving transaction:', tgId);
    return;
  }

  const currentTransactions = readTransactionLog(freshUser.description || '');
  const duplicate = transaction.operationId &&
    currentTransactions.some((item) => String(item.operationId) === String(transaction.operationId));

  if (duplicate) {
    console.log('[tx] duplicate operation, skip:', transaction.operationId);
    return;
  }

  const nextTransactions = [transaction, ...currentTransactions].slice(0, 20);
  const nextDescription = writeTransactionLog(freshUser.description || '', nextTransactions);
  await panelPatch('/api/users', { uuid: freshUser.uuid, description: nextDescription });
  console.log('[tx] transaction saved:', transaction.operationId || transaction.paidAt);
}

/**
 * Реферальный бонус:
 * 1. Читаем description приглашённого — там "ref:<inviterTgId>"
 * 2. Находим реферера
 * 3. Продлеваем подписку реферера на floor(days * 15%)
 * 4. В description реферала обновляем "ref_bonus:<totalDays>" для статистики
 */
async function processReferralBonus(referredUser, paidDays) {
  const freshUser = await findUser(referredUser.telegramId ?? referredUser.tgId ?? referredUser.telegram_id);
  const desc = freshUser?.description || referredUser.description || '';

  const refMatch = desc.match(/ref:(\d+)/);
  if (!refMatch) {
    console.log('[ref] no inviter in description, skip');
    return null;
  }

  const inviterTgId = refMatch[1];
  const bonusDays   = Math.max(1, Math.floor(paidDays * REF_BONUS_PERCENT));
  console.log(`[ref] inviter=${inviterTgId} bonus=${bonusDays}d (${paidDays}*${REF_BONUS_PERCENT})`);

  const inviter = await findUser(inviterTgId);
  if (!inviter) {
    console.warn('[ref] inviter not found:', inviterTgId);
    return null;
  }

  const inviterExpireAt = await extendSubscription(inviter, bonusDays);
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

  return {
    inviter,
    bonusDays,
    expireAt: inviterExpireAt,
  };
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
  const operationId = params.get('operation_id') ?? '';
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
  let expireAt;
  try {
    expireAt = await extendSubscription(user, days);
    console.log(`[webhook] extended ${tgId} by ${days}d (plan=${plan}, amount=${amount})`);
  } catch (err) {
    console.error('[webhook] extendSubscription error:', err);
    return new Response('extend error', { status: 500, headers: CORS });
  }

  // 6. Реферальный бонус (не блокируем — ошибка бонуса не должна ронять webhook)
  let referralBonus = null;
  try { referralBonus = await processReferralBonus(user, days); }
  catch (err) { console.error('[webhook] referral bonus error:', err); }

  // 7. Сохраняем транзакцию пользователя в description
  try {
    await saveSuccessfulTransaction(tgId, {
      operationId,
      amount,
      days,
      plan,
      paidAt: new Date().toISOString(),
      label,
    });
  } catch (err) {
    console.error('[webhook] save transaction error:', err);
  }

  try {
    await notifyAdminsAboutPayment(user, {
      operationId,
      amount,
      days,
      plan,
    });
  } catch (err) {
    console.error('[webhook] admin notify fatal error:', err);
  }

  try {
    await notifyUserAboutPayment(req, user, {
      amount,
      days,
      plan,
      expireAt,
    });
  } catch (err) {
    console.error('[webhook] user notify error:', err);
  }

  try {
    if (referralBonus?.inviter && referralBonus?.bonusDays) {
      await notifyInviterAboutReferralPayment(req, referralBonus.inviter, referralBonus);
    }
  } catch (err) {
    console.error('[webhook] inviter notify error:', err);
  }

  return new Response('ok', { status: 200, headers: CORS });
}
