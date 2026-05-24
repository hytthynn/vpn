export const config = { runtime: 'edge' };

import { findUser, panelPatch } from './_panel.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_URL = process.env.CHANNEL_URL || '';
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || '').replace(/^@/, '');
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID || '';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);

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

function normalizeDescription(description = '') {
  return String(description).replace(/\s+/g, ' ').trim();
}

function hasAvailableTrial(description = '') {
  return /(?:^|\s)trial_status:available(?:\s|$)/.test(String(description));
}

function hasClaimedTrial(description = '') {
  return /(?:^|\s)trial_status:claimed(?:\s|$)/.test(String(description));
}

function markTrialClaimed(description = '') {
  const claimedAt = new Date().toISOString();
  const clean = normalizeDescription(
    String(description)
      .replace(/\btrial_status:(?:available|claimed|skipped)\b/g, '')
      .replace(/\btrial_claimed_at:[^\s]+\b/g, '')
  );

  return normalizeDescription(`${clean} trial_status:claimed trial_claimed_at:${claimedAt}`);
}

function extractChannelUsername(url = '') {
  const match = String(url).trim().match(/^https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]{5,})\/?$/i);
  return match?.[1] || '';
}

function resolveChannelChatId() {
  if (CHANNEL_CHAT_ID) return CHANNEL_CHAT_ID;
  if (CHANNEL_USERNAME) return `@${CHANNEL_USERNAME}`;

  const urlUsername = extractChannelUsername(CHANNEL_URL);
  if (urlUsername) return `@${urlUsername}`;

  return '';
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

async function isSubscribedToChannel(telegramId) {
  const chatId = resolveChannelChatId();
  if (!chatId) {
    throw new Error('Trial channel is not configured');
  }

  const data = await telegramRequest('getChatMember', {
    chat_id: chatId,
    user_id: Number(telegramId),
  });

  const status = String(data?.result?.status || '').toLowerCase();
  return ['member', 'administrator', 'creator'].includes(status);
}

function buildTrialExpireAt(user, days) {
  const now = new Date();
  const current = user.expireAt ? new Date(user.expireAt) : null;
  const base = current && current > now ? current : now;
  return new Date(base.getTime() + days * 86400000).toISOString();
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
    const telegramId = String(body.telegramId || '').trim();
    if (!telegramId) return json({ error: 'missing telegramId' }, 400);

    const user = await findUser(telegramId);
    if (!user?.uuid) return json({ error: 'user not found' }, 404);

    const description = user.description || '';
    if (hasClaimedTrial(description)) {
      return json({ error: 'trial already claimed' }, 409);
    }
    if (!hasAvailableTrial(description)) {
      return json({ error: 'trial not available' }, 409);
    }

    let subscribed = false;
    try {
      subscribed = await isSubscribedToChannel(telegramId);
    } catch (error) {
      console.error('[trial] subscription check failed:', error);
      return json({ error: 'trial verification unavailable', details: error.message }, 500);
    }

    if (!subscribed) {
      return json({ error: 'channel subscription required' }, 409);
    }

    const expireAt = buildTrialExpireAt(user, TRIAL_DAYS);
    const nextDescription = markTrialClaimed(description);
    await panelPatch('/api/users', {
      uuid: user.uuid,
      expireAt,
      status: 'ACTIVE',
      description: nextDescription,
    });

    return json({
      ok: true,
      days: TRIAL_DAYS,
      expireAt,
    });
  } catch (error) {
    console.error('[trial] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
