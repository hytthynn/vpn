export const config = { runtime: 'edge' };

import { findUser, isAdminDescription, listUsers } from './_panel.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

async function telegramJsonRequest(method, payload) {
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

async function telegramFormRequest(method, formData) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN env var is not set');
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data;
}

async function decodeImageDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) {
    throw new Error('invalid image data');
  }

  const mimeType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('image too large');
  }

  return new Blob([bytes], { type: mimeType });
}

async function sendBroadcastMessage(chatId, text) {
  return telegramJsonRequest('sendMessage', {
    chat_id: Number(chatId),
    text,
    disable_web_page_preview: true,
  });
}

async function sendBroadcastPhoto(chatId, text, imageBlob, imageName) {
  const extension = imageBlob.type.split('/')[1] || 'jpg';
  const filename = String(imageName || `broadcast.${extension}`).replace(/[^\w.-]/g, '_');
  const formData = new FormData();

  formData.set('chat_id', String(chatId));
  formData.set('photo', imageBlob, filename);
  if (text) formData.set('caption', text);

  return telegramFormRequest('sendPhoto', formData);
}

async function sendToRecipient(recipient, payload) {
  if (payload.imageBlob) {
    return sendBroadcastPhoto(
      recipient.telegramId,
      payload.text,
      payload.imageBlob,
      payload.imageName
    );
  }

  return sendBroadcastMessage(recipient.telegramId, payload.text);
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

    const text = String(body.text || '').trim();
    const imageDataUrl = String(body.imageDataUrl || '').trim();
    const imageName = String(body.imageName || '').trim();

    if (!text && !imageDataUrl) {
      return json({ error: 'message or image required' }, 400);
    }

    if (imageDataUrl && text.length > 1024) {
      return json({ error: 'message too long' }, 400);
    }

    const users = await listUsers();
    const recipients = collectRecipients(users);
    let imageBlob = null;

    if (imageDataUrl) {
      try {
        imageBlob = await decodeImageDataUrl(imageDataUrl);
      } catch (error) {
        const code = error.message === 'image too large' ? 'image too large' : 'invalid image data';
        return json({ error: code }, 400);
      }
    }

    const payload = { text, imageBlob, imageName };
    const results = [];

    for (const recipient of recipients) {
      try {
        await sendToRecipient(recipient, payload);
        results.push({
          telegramId: recipient.telegramId,
          sent: true,
        });
      } catch (error) {
        console.error('[broadcast] recipient error:', recipient.telegramId, error);
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
      results,
    });
  } catch (error) {
    console.error('[broadcast] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
