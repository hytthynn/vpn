export const config = { runtime: 'edge' };

import { findUser, isAdminDescription, listUsers } from './_panel.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NEWS_SOURCE_CHAT_ID = String(process.env.NEWS_SOURCE_CHAT_ID || '').trim();

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

function getTelegramId(user) {
  const raw = user?.telegramId ?? user?.tgId ?? user?.telegram_id;
  if (!raw) return '';
  return String(raw).trim();
}

function isSystemStorageUser(user) {
  const description = String(user?.description || '');
  const username = String(user?.username || '');
  return description.startsWith('promo_v1:') ||
    description.startsWith('maintenance_v1:') ||
    username.startsWith('promo_') ||
    username.startsWith('system_maintenance_');
}

function collectRecipients(users) {
  const seen = new Set();
  const recipients = [];

  for (const user of users) {
    if (isSystemStorageUser(user)) continue;

    const telegramId = getTelegramId(user);
    if (!telegramId || seen.has(telegramId)) continue;

    seen.add(telegramId);
    recipients.push({
      telegramId,
      uuid: user.uuid || '',
      username: user.username || '',
    });
  }

  return recipients;
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

function parsePostReference(input) {
  const value = String(input || '').trim();
  if (!value) {
    throw new Error('missing post reference');
  }

  if (/^\d+$/.test(value)) {
    if (!NEWS_SOURCE_CHAT_ID) {
      throw new Error('source chat required');
    }

    return {
      fromChatId: NEWS_SOURCE_CHAT_ID,
      messageId: Number(value),
      label: value,
    };
  }

  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length >= 2 && parts[0] === 'c' && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2] || '')) {
    return {
      fromChatId: `-100${parts[1]}`,
      messageId: Number(parts[2]),
      label: value,
    };
  }

  if (parts.length >= 2 && parts[0] === 's' && /^\d+$/.test(parts[2] || '')) {
    return {
      fromChatId: `@${parts[1]}`,
      messageId: Number(parts[2]),
      label: value,
    };
  }

  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    return {
      fromChatId: `@${parts[0]}`,
      messageId: Number(parts[1]),
      label: value,
    };
  }

  throw new Error('invalid post reference');
}

async function forwardPostToUser(recipient, source) {
  return telegramRequest('forwardMessage', {
    chat_id: Number(recipient.telegramId),
    from_chat_id: source.fromChatId,
    message_id: source.messageId,
  });
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

    let source;
    try {
      source = parsePostReference(body.postReference);
    } catch (error) {
      const message = error.message;
      if (message === 'missing post reference') return json({ error: 'missing post reference' }, 400);
      if (message === 'source chat required') return json({ error: 'source chat required' }, 400);
      return json({ error: 'invalid post reference' }, 400);
    }

    const users = await listUsers();
    const recipients = collectRecipients(users);
    const results = [];

    for (const recipient of recipients) {
      try {
        await forwardPostToUser(recipient, source);
        results.push({
          telegramId: recipient.telegramId,
          sent: true,
        });
      } catch (error) {
        console.error('[repost-post] recipient error:', recipient.telegramId, error);
        results.push({
          telegramId: recipient.telegramId,
          sent: false,
          error: error.message,
        });
      }
    }

    return json({
      ok: true,
      total: recipients.length,
      sent: results.filter((item) => item.sent).length,
      failed: results.filter((item) => !item.sent).length,
      postReference: source.label,
      results,
    });
  } catch (error) {
    console.error('[repost-post] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
