// Mineradio Bridge anonymous heartbeat + public stats.
// Privacy: only install UUID + extension version. No cookies, accounts, or listen history.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const SEEN_TTL_SEC = 8 * 24 * 3600;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = 'stats:cache:v1';

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  const allow = origin.startsWith('chrome-extension://') || origin === 'null' || origin === '*'
    ? (origin === 'null' ? '*' : origin)
    : '*';
  return {
    'Access-Control-Allow-Origin': allow === '*' ? '*' : allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(req),
    },
  });
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function dayOffset(day, delta) {
  const t = Date.parse(day + 'T00:00:00.000Z');
  return new Date(t + delta * 86400000).toISOString().slice(0, 10);
}

async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await env.BRIDGE_STATS.list({ prefix, cursor, limit: 1000 });
    for (const item of page.keys) keys.push(item);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return keys;
}

async function readSeenVersion(env, key) {
  return env.BRIDGE_STATS.get(key);
}

async function handleHeartbeat(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400, req);
  }
  const id = String(body?.id || '').trim();
  const version = String(body?.v || body?.version || '').trim();
  if (!UUID_RE.test(id)) return json({ ok: false, error: 'bad id' }, 400, req);
  if (!VERSION_RE.test(version)) return json({ ok: false, error: 'bad version' }, 400, req);

  const day = utcDay();
  const key = `seen:${day}:${id}`;
  const prev = await env.BRIDGE_STATS.get(key);
  // Same install + same day: overwrite version if needed, but don't treat as new user.
  await env.BRIDGE_STATS.put(key, version, { expirationTtl: SEEN_TTL_SEC });
  if (prev !== version) {
    await env.BRIDGE_STATS.delete(CACHE_KEY);
  }
  return json({ ok: true, day, firstToday: prev == null }, 200, req);
}

async function computeStats(env) {
  const today = utcDay();
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push(dayOffset(today, -i));

  const wauIds = new Set();
  const versions = Object.create(null);
  let dau = 0;

  for (const day of days) {
    const keys = await listAll(env, `seen:${day}:`);
    if (day === today) dau = keys.length;
    for (const item of keys) {
      const id = item.name.slice(`seen:${day}:`.length);
      if (id) wauIds.add(id);
    }
    if (day === today) {
      // Batch get versions for today's distribution.
      for (let i = 0; i < keys.length; i += 50) {
        const chunk = keys.slice(i, i + 50);
        const values = await Promise.all(chunk.map((k) => readSeenVersion(env, k.name)));
        values.forEach((ver) => {
          const v = ver && VERSION_RE.test(ver) ? ver : 'unknown';
          versions[v] = (versions[v] || 0) + 1;
        });
      }
    }
  }

  const sorted = Object.entries(versions)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const versionsObj = Object.fromEntries(sorted);

  return {
    dau,
    wau: wauIds.size,
    versions: versionsObj,
    day: today,
    updatedAt: new Date().toISOString(),
  };
}

async function handleStats(req, env) {
  const cached = await env.BRIDGE_STATS.get(CACHE_KEY, { type: 'json' });
  if (cached && cached.payload && cached.at && Date.now() - cached.at < CACHE_TTL_MS) {
    return json(cached.payload, 200, req);
  }
  const payload = await computeStats(env);
  await env.BRIDGE_STATS.put(CACHE_KEY, JSON.stringify({ at: Date.now(), payload }), {
    expirationTtl: 24 * 3600,
  });
  return json(payload, 200, req);
}

export default {
  async fetch(req, env) {
    if (!env.BRIDGE_STATS) {
      return json({ ok: false, error: 'KV binding BRIDGE_STATS missing' }, 500, req);
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if ((path === '/bridge/heartbeat' || path === '/heartbeat') && req.method === 'POST') {
      return handleHeartbeat(req, env);
    }
    if ((path === '/bridge/stats' || path === '/stats') && req.method === 'GET') {
      return handleStats(req, env);
    }
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'mineradio-bridge-stats' }, 200, req);
    }
    return json({ ok: false, error: 'not found' }, 404, req);
  },
};
