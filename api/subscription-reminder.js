export const config = { runtime: 'edge' };

import { listUsers, panelPatch } from './_panel.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPPORT_USERNAME = (process.env.SUPPORT_USERNAME || '').replace('@', '');
const BRAND_NAME = process.env.BRAND_NAME || 'averra';
const CRON_SECRET = process.env.CRON_SECRET || '';
const REMINDER_MARKER = 'exp_notice_v1:';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function isAuthorized(req) {
  if (!CRON_SECRET) return true;
  return req.headers.get('authorization') === `Bearer ${CRON_SECRET}`;
}

function readReminderMarker(description = '') {
  const match = String(description).match(/exp_notice_v1:([^\s]+)/);
  if (!match) return '';

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function writeReminderMarker(description = '', expireAt = '') {
  const cleanDescription = String(description).replace(/\s*exp_notice_v1:[^\s]+/g, '').trim();
  const payload = REMINDER_MARKER + encodeURIComponent(expireAt);
  return cleanDescription ? `${cleanDescription} ${payload}` : payload;
}

function formatExpireDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'скоро';
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function isTelegramMiniAppUrl(url = '') {
  return /^https:\/\/t\.me\/[^/]+\/app(?:[/?#]|$)/i.test(String(url).trim());
}

function buildOpenAppButton(req) {
  const explicitUrl = normalizeUrl(process.env.WEBAPP_URL);
  const targetUrl = explicitUrl || (new URL(req.url).origin + '/');

  if (isTelegramMiniAppUrl(targetUrl)) {
    return {
      text: 'Открыть приложение',
      url: targetUrl,
    };
  }

  return {
    text: 'Открыть приложение',
    web_app: { url: targetUrl },
  };
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

async function sendReminder(req, user) {
  const supportLine = SUPPORT_USERNAME
    ? `Если нужна помощь, напишите в поддержку: @${SUPPORT_USERNAME}`
    : 'Если нужна помощь, напишите в поддержку.';

  const text =
`<b>${escapeHtml(BRAND_NAME)}</b>

⏳ <b>Подписка скоро закончится</b>

Доступ активен до: <b>${escapeHtml(formatExpireDate(user.expireAt))}</b>

Продлите подписку заранее, чтобы пользоваться VPN без перерыва.

${escapeHtml(supportLine)}`;

  await telegramRequest('sendMessage', {
    chat_id: Number(user.telegramId ?? user.tgId ?? user.telegram_id),
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

function shouldNotify(user, now) {
  if (!user?.uuid) return false;
  if (String(user.status || '') !== 'ACTIVE') return false;

  const telegramId = user.telegramId ?? user.tgId ?? user.telegram_id;
  if (!telegramId) return false;

  const expireAt = user.expireAt ?? user.expiredAt;
  if (!expireAt) return false;

  const expireAtMs = new Date(expireAt).getTime();
  if (!Number.isFinite(expireAtMs)) return false;

  const diffMs = expireAtMs - now;
  if (diffMs <= 0 || diffMs > ONE_DAY_MS) return false;

  const remindedFor = readReminderMarker(user.description || '');
  return remindedFor !== expireAt;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }

  if (!isAuthorized(req)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const now = Date.now();
    const users = await listUsers();
    const candidates = users.filter((user) => shouldNotify(user, now));
    const results = [];

    for (const user of candidates) {
      try {
        await sendReminder(req, user);
        await panelPatch('/api/users', {
          uuid: user.uuid,
          description: writeReminderMarker(user.description || '', user.expireAt ?? user.expiredAt ?? ''),
        });
        results.push({
          uuid: user.uuid,
          telegramId: String(user.telegramId ?? user.tgId ?? user.telegram_id),
          sent: true,
        });
      } catch (error) {
        console.error('[subscription-reminder] user error:', user.uuid, error);
        results.push({
          uuid: user.uuid,
          telegramId: String(user.telegramId ?? user.tgId ?? user.telegram_id),
          sent: false,
          error: error.message,
        });
      }
    }

    return json({
      ok: true,
      checked: users.length,
      candidates: candidates.length,
      sent: results.filter((item) => item.sent).length,
      results,
    });
  } catch (error) {
    console.error('[subscription-reminder] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
