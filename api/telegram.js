export const config = { runtime: 'edge' };

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace('@', '');
const SUPPORT_USERNAME = (process.env.SUPPORT_USERNAME || '').replace('@', '');
const CHANNEL_URL = process.env.CHANNEL_URL || '';
const BRAND_NAME = process.env.BRAND_NAME || 'averra';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function cleanStartPayload(text = '') {
  const match = String(text).match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  return match?.[1]?.trim() || '';
}

function normalizeUrl(url = '') {
  return String(url).trim().replace(/\/+$/, '');
}

function buildWebAppUrl(req, startPayload) {
  const explicitUrl = normalizeUrl(process.env.WEBAPP_URL);
  const baseUrl = explicitUrl || new URL(req.url).origin;
  const url = new URL(baseUrl + '/');
  if (startPayload) url.searchParams.set('startapp', startPayload);
  return url.toString();
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

async function sendStartMessage(req, message) {
  const startPayload = cleanStartPayload(message.text);
  const supportLine = SUPPORT_USERNAME
    ? `Возникли вопросы или сложности? Напишите в службу поддержки: @${SUPPORT_USERNAME}`
    : 'Возникли вопросы или сложности? Напишите в службу поддержки, мы обязательно вам поможем.';

  const text =
`${BRAND_NAME} — ваш персональный VPN

🙌 Первые ${TRIAL_DAYS} дня бесплатно для всех пользователей:

1️⃣ Откройте приложение

2️⃣ Нажмите «Установка и настройка» и следуйте инструкции, чтобы подключить VPN на свое устройство

3️⃣ Готово! Пользуйтесь ${BRAND_NAME} бесплатно ${TRIAL_DAYS} дня

${supportLine}`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🪟 Открыть приложение',
          web_app: { url: buildWebAppUrl(req, startPayload) },
        },
      ],
      ...(CHANNEL_URL ? [[{ text: `🌐 Новостной канал ${BRAND_NAME}`, url: CHANNEL_URL }]] : []),
    ],
  };

  await telegramRequest('sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method === 'GET') {
    return json({
      ok: true,
      webhook: '/api/telegram',
      botUsername: BOT_USERNAME,
      hasToken: Boolean(TELEGRAM_BOT_TOKEN),
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  try {
    const update = await req.json().catch(() => ({}));
    const message = update.message || update.edited_message;
    const text = String(message?.text || '');

    if (/^\/start(?:@\w+)?(?:\s+.*)?$/i.test(text) && message?.chat?.id) {
      await sendStartMessage(req, message);
    }

    return json({ ok: true });
  } catch (error) {
    console.error('[telegram] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
