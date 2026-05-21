export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export default function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  return new Response(JSON.stringify({
    defaultSquadUuid: process.env.DEFAULT_SQUAD_UUID ?? '',
    botUsername: process.env.BOT_USERNAME ?? '',
    supportUsername: process.env.SUPPORT_USERNAME ?? '',
    channelUrl: process.env.CHANNEL_URL ?? '',
    trialDays: positiveNumber(process.env.TRIAL_DAYS, 3),
    walletId: process.env.WALLET_ID ?? '',
    plans: {
      '1m': { amount: positiveNumber(process.env.PLAN_1M_AMOUNT, 150) },
      '3m': { amount: positiveNumber(process.env.PLAN_3M_AMOUNT, 380) },
      '12m': { amount: positiveNumber(process.env.PLAN_12M_AMOUNT, 1080) },
    },
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
