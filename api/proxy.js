export const config = { runtime: 'edge' };

const PANEL_URL    = 'https://panel.hexsad.ru';
const API_TOKEN    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMzllMGZlNDgtY2NlZS00Nzc1LWIwMzktYjhkZjM1ZjA4YTQ5IiwidXNlcm5hbWUiOm51bGwsInJvbGUiOiJBUEkiLCJpYXQiOjE3NzkwNTg0MDgsImV4cCI6MTA0MTg5NzIwMDh9._YPVQXC4Rq8dOqkBx7u1Q-enmFolGCjbhcGpuJPTgcA';
const NGINX_COOKIE = 'iaKQrsnp=gCqXPowZ';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url   = new URL(req.url);
  // /api/proxy?path=/api/users/resolve
  const path  = url.searchParams.get('path');

  if (!path) {
    return new Response(JSON.stringify({ error: 'missing path param' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  const body = req.method === 'POST' ? await req.text() : undefined;

  try {
    const upstream = await fetch(PANEL_URL + path, {
      method:  req.method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Cookie':        NGINX_COOKIE,
        'Content-Type':  'application/json',
      },
      body,
    });

    const data = await upstream.text();

    return new Response(data, {
      status:  upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
}