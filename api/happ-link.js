export const config = { runtime: 'edge' };

const CRYPTO_API_URL = 'https://crypto.happ.su/api-v2.php';

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

function normalizeSourceUrl(input = '') {
  const value = String(input || '').trim();
  if (!value) return '';
  if (/^happ:\/\/crypt\d+\//i.test(value)) return value;

  const parsed = new URL(value);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }

  return parsed.toString();
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
    const sourceUrl = normalizeSourceUrl(body.url);
    if (!sourceUrl) return json({ error: 'missing url' }, 400);

    if (/^happ:\/\/crypt\d+\//i.test(sourceUrl)) {
      return json({ encryptedLink: sourceUrl });
    }

    const response = await fetch(CRYPTO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });

    const data = await response.json().catch(() => ({}));
    const encryptedLink = String(data?.encrypted_link || '').trim();
    if (!response.ok || !encryptedLink) {
      throw new Error(`Crypto API error: ${response.status}`);
    }

    return json({ encryptedLink });
  } catch (error) {
    console.error('[happ-link] error:', error);
    return json({ error: 'internal error', details: error.message }, 500);
  }
}
