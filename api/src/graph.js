// Minimal Microsoft Graph-klient med client credentials pr. tenant.
// Én multi-tenant app-registrering, admin-consented i hver tenant der skal bruges.

const tokenCache = new Map(); // tenantId -> { token, expiresAt }

async function getToken(tenantId) {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const clientId = process.env.BOOKING_CLIENT_ID;
  const clientSecret = process.env.BOOKING_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('BOOKING_CLIENT_ID/BOOKING_CLIENT_SECRET mangler');

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token-fejl for ${tenantId}: ${data.error_description || data.error}`);
  tokenCache.set(tenantId, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export class GraphError extends Error {
  constructor(status, body, path) {
    super(`Graph ${status} på ${path}: ${body?.error?.message || JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export async function graph(tenantId, method, path, body) {
  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(tenantId);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const wait = Number(res.headers.get('Retry-After') || 2);
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new GraphError(res.status, json, path);
    return json;
  }
}
