export const config = { runtime: 'edge' };

// ==========================================
// НАСТРОЙКИ — замените на свои значения
// ==========================================
const YOOMONEY_SECRET = 'ccRzWFtoDUTkuxPz8J3rUPJ8'; // Секрет из настроек HTTP-уведомлений
const RECEIVER_WALLET = '4100118408605024';           // Номер вашего YooMoney кошелька
// ==========================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Верификация sha1_hash по алгоритму YooMoney:
 * SHA1( notification_type&operation_id&amount&currency&datetime&sender&codepro&secret&label )
 */
async function verifySignature(params, secret) {
  const str = [
    params.get('notification_type') || '',
    params.get('operation_id')      || '',
    params.get('amount')            || '',
    params.get('currency')          || '',
    params.get('datetime')          || '',
    params.get('sender')            || '',
    params.get('codepro')           || '',
    secret,
    params.get('label')             || '',
  ].join('&');

  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await req.text();
    const params = new URLSearchParams(body);

    // Параметры уведомления от YooMoney
    const notification_type = params.get('notification_type');
    const operation_id      = params.get('operation_id');
    const amount            = params.get('amount');
    const currency          = params.get('currency');
    const datetime          = params.get('datetime');
    const sender            = params.get('sender');
    const codepro           = params.get('codepro');
    const label             = params.get('label');
    const sha1_hash         = params.get('sha1_hash');
    const unaccepted        = params.get('unaccepted');
    const withdraw_amount   = params.get('withdraw_amount');

    console.log('[YooMoney Webhook]', {
      notification_type,
      operation_id,
      amount,
      currency,
      datetime,
      sender,
      label,
      unaccepted,
    });

    // ── 1. Проверяем подпись ──────────────────────────────────────────────
    const expectedHash = await verifySignature(params, YOOMONEY_SECRET);
    if (sha1_hash !== expectedHash) {
      console.error('[YooMoney] Invalid sha1_hash', { received: sha1_hash, expected: expectedHash });
      // Отвечаем 200, чтобы YooMoney не повторял — но логируем ошибку
      return new Response('ok', { status: 200 });
    }

    // ── 2. Проверяем что платёж принят (не ожидает подтверждения) ─────────
    if (unaccepted === 'true') {
      console.warn('[YooMoney] Payment unaccepted (protected transfer), ignoring');
      return new Response('ok', { status: 200 });
    }

    // ── 3. Ваша бизнес-логика ─────────────────────────────────────────────
    // label содержит уникальный ID заказа/пользователя, который вы передали
    // при генерации ссылки на оплату.
    //
    // Примеры того, что можно делать здесь:
    //   - Обновить статус заказа в БД
    //   - Активировать подписку пользователя
    //   - Отправить email с подтверждением
    //   - Выдать доступ к панели (panel.hexsad.ru)
    //
    // Пример: разбираем label вида "userid_123_plan_vip"
    if (label) {
      const parts = label.split('_');
      // const userId = parts[1];
      // const plan   = parts[3];
      console.log('[YooMoney] Payment confirmed for label:', label, '| amount:', amount, currency);

      // TODO: активировать услугу для пользователя
      // await activateUser(userId, plan, amount);
    }

    // ── 4. Обязательно отвечаем HTTP 200 ─────────────────────────────────
    // YooMoney требует 200, иначе будет повторять уведомление 3 раза.
    return new Response('ok', { status: 200, headers: CORS });

  } catch (err) {
    console.error('[YooMoney Webhook Error]', err);
    // Даже при ошибке возвращаем 200, чтобы избежать бесконечных повторов
    return new Response('ok', { status: 200 });
  }
}
