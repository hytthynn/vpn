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

function appendStartPayload(urlString, startPayload) {
  const url = new URL(urlString);
  if (startPayload) url.searchParams.set('startapp', startPayload);
  return url.toString();
}

function isTelegramMiniAppUrl(url = '') {
  return /^https:\/\/t\.me\/[^/]+\/app(?:[/?#]|$)/i.test(String(url).trim());
}

function buildWebAppUrl(req, startPayload) {
  const explicitUrl = normalizeUrl(process.env.WEBAPP_URL);
  const baseUrl = explicitUrl || new URL(req.url).origin;
  return appendStartPayload(baseUrl + '/', startPayload);
}

function buildPublicAssetUrl(req, assetPath) {
  return new URL(assetPath, req.url).toString();
}

function buildOpenAppButton(req, startPayload) {
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

function buildSupportButton() {
  if (!SUPPORT_USERNAME) return null;
  return {
    text: '💬 Связаться с поддержкой',
    url: `https://t.me/${SUPPORT_USERNAME}`,
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

async function sendStartMessage(req, message) {
  const startPayload = cleanStartPayload(message.text);
  const supportLine = SUPPORT_USERNAME
    ? `Возникли вопросы или сложности? Напишите в службу поддержки: @${SUPPORT_USERNAME}`
    : 'Возникли вопросы или сложности? Напишите в службу поддержки, мы обязательно вам поможем.';

  const text =
`${BRAND_NAME} — ваш персональный VPN

🙌 Новым пользователям доступен пробный период ${TRIAL_DAYS} дня:

1️⃣ Откройте приложение

2️⃣ Подпишитесь на новостной канал ${BRAND_NAME}

3️⃣ Нажмите кнопку получения пробного периода внутри приложения

4️⃣ После проверки подписки вам автоматически начислится ${TRIAL_DAYS} дня доступа

${supportLine}`;

  const keyboard = {
    inline_keyboard: [
      [buildOpenAppButton(req, startPayload)],
      ...(CHANNEL_URL ? [[{ text: `🌐 Новостной канал ${BRAND_NAME}`, url: CHANNEL_URL }]] : []),
    ],
  };

  await telegramRequest('sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });

  await sendInstructionVideoMessage(req, message, startPayload);
}

async function sendInstructionVideoMessage(req, message, startPayload) {
  const supportButton = buildSupportButton();
  const keyboard = {
    inline_keyboard: [
      [buildOpenAppButton(req, startPayload)],
      ...(supportButton ? [[supportButton]] : []),
    ],
  };

  await telegramRequest('sendVideo', {
    chat_id: message.chat.id,
    video: buildPublicAssetUrl(req, '/instruction.mp4'),
    caption: 'В этом минутном видео мы подробно показали процесс установки и настройки VPN',
    reply_markup: keyboard,
    supports_streaming: true,
  });
}

async function sendUnknownMessage(message) {
  const text = `Извините, я не совсем понял ваш запрос 😔

Напишите в поддержку, мы обязательно поможем`;

  const supportButton = buildSupportButton();
  const replyMarkup = supportButton
    ? { inline_keyboard: [[supportButton]] }
    : undefined;

  await telegramRequest('sendMessage', {
    chat_id: message.chat.id,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

    if (!message?.chat?.id || message?.from?.is_bot) {
      return json({ ok: true });
    }

    if (/^\/start(?:@\w+)?(?:\s+.*)?$/i.test(text)) {
      await sendStartMessage(req, message);
      return json({ ok: true });
    }

    await sendUnknownMessage(message);

    return json({ ok: true });
  } catch (error) {
    console.error('[telegram] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
