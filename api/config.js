export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  return new Response(JSON.stringify({
    defaultSquadUuid: process.env.DEFAULT_SQUAD_UUID ?? '',
    botUsername:      process.env.BOT_USERNAME ?? '',
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
