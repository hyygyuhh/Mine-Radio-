// Mineradio Bridge anonymous heartbeat + private stats page.
// Privacy: only install UUID + extension version. No cookies, accounts, or listen history.
// /bridge/stats (HTML and JSON) requires the STATS_PASSWORD secret. Heartbeats stay open.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const SEEN_TTL_SEC = 8 * 24 * 3600;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = 'stats:cache:v2';
const SERIES_DAYS = 14;
const WEEK_DAYS = 7;
const SESSION_TTL_SEC = 30 * 24 * 3600;
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_MAX_FAILS = 8;
const COOKIE_NAME = 'mr_stats';

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

function authPaths(url) {
  const onBridge = url.pathname.startsWith('/bridge');
  return {
    login: onBridge ? '/bridge/login' : '/login',
    logout: onBridge ? '/bridge/logout' : '/logout',
    stats: onBridge ? '/bridge/stats' : '/stats',
  };
}

function cookiePath(url) {
  return url.pathname.startsWith('/bridge') ? '/bridge' : '/';
}

function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionCookie(url, token, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const value = encodeURIComponent(token || '');
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=${cookiePath(url)}; Max-Age=${maxAge}${secure}`;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(buf));
}

async function signSession(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

async function passwordMatches(secret, given) {
  const a = await sha256Hex(`mineradio-stats:${secret}`);
  const b = await sha256Hex(`mineradio-stats:${given}`);
  return timingSafeEqual(a, b);
}

async function isAuthed(req, env) {
  const secret = String(env.STATS_PASSWORD || '');
  if (!secret) return false;
  const raw = readCookie(req, COOKIE_NAME);
  const match = /^(\d{10,12})\.([0-9a-f]{64})$/.exec(raw);
  if (!match) return false;
  const exp = Number(match[1]);
  if (!exp || exp * 1000 < Date.now()) return false;
  const sig = await signSession(secret, match[1]);
  return timingSafeEqual(sig, match[2]);
}

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
}

async function loginFailKey(ip) {
  const hex = await sha256Hex(`login-fail:${ip}`);
  return `login:fail:${hex.slice(0, 16)}`;
}

async function tooManyAttempts(env, ip) {
  const n = Number(await env.BRIDGE_STATS.get(await loginFailKey(ip))) || 0;
  return n >= LOGIN_MAX_FAILS;
}

async function recordFailure(env, ip) {
  const key = await loginFailKey(ip);
  const n = Number(await env.BRIDGE_STATS.get(key)) || 0;
  await env.BRIDGE_STATS.put(key, String(n + 1), { expirationTtl: LOGIN_WINDOW_SEC });
}

async function clearFailures(env, ip) {
  await env.BRIDGE_STATS.delete(await loginFailKey(ip));
}

function redirect(location, setCookie) {
  const headers = {
    Location: location,
    'cache-control': 'no-store',
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(null, { status: 303, headers });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function loginErrorText(code, configured) {
  if (!configured || code === 'unconfigured') return '访问密码还没有配置，暂时不能查看。';
  if (code === 'locked') return '尝试次数过多，请 15 分钟后再试。';
  if (code === 'bad') return '密码不正确。';
  return '';
}

function renderLoginHtml(url, env) {
  const paths = authPaths(url);
  const configured = !!String(env.STATS_PASSWORD || '');
  const code = url.searchParams.get('e') || '';
  const message = loginErrorText(code, configured);
  const alert = message ? `<p class="alert" role="alert">${esc(message)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#eef6f3">
<title>登录 — Bridge 活跃数据</title>
<link rel="icon" href="/icons/icon32.png" type="image/png">
<style>
  :root { --ink:#14241f; --muted:#5c6f68; --line:rgba(20,36,31,.1); --accent:#0b8a78; --bad:#b4535a; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; color: var(--ink);
    font: 400 15px/1.7 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    background:
      radial-gradient(920px 460px at 8% -8%, rgba(11,138,120,.16), transparent 58%),
      radial-gradient(760px 420px at 100% 0%, rgba(64,140,210,.12), transparent 52%),
      linear-gradient(180deg, #eef6f3 0%, #f7fbf9 48%, #f3f8f6 100%);
  }
  .wrap { max-width: 440px; margin: 0 auto; padding: 48px 20px 72px; }
  a { color: var(--accent); text-decoration: none; font-weight: 650; }
  .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); font-weight: 700; margin-bottom: 28px; }
  .brand img { width: 28px; height: 28px; border-radius: 8px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
  .lead { color: var(--muted); margin: 0 0 18px; font-size: 14.5px; }
  form {
    background: #fff; border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 10px 30px rgba(20,50,40,.06); padding: 18px;
    display: grid; gap: 12px;
  }
  label { font-size: 13px; font-weight: 650; }
  input {
    width: 100%; height: 42px; border-radius: 12px; border: 1px solid var(--line);
    padding: 0 12px; font: inherit; color: var(--ink); background: #fff;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    height: 42px; border: 0; border-radius: 999px; background: var(--accent); color: #fff;
    font: inherit; font-weight: 700; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .alert { margin: 0 0 14px; color: var(--bad); font-size: 14px; }
</style>
</head>
<body>
  <main class="wrap">
    <a class="brand" href="/"><img src="/icons/icon48.png" width="28" height="28" alt=""><span>Mineradio</span></a>
    <h1>登录</h1>
    <p class="lead">Bridge 活跃数据只对已登录的人开放。</p>
    ${alert}
    <form method="post" action="${esc(paths.login)}">
      <label for="password">访问密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" ${configured ? '' : 'disabled'}>
      <button type="submit" ${configured ? '' : 'disabled'}>进入</button>
    </form>
  </main>
</body>
</html>`;
}

async function handleLogin(req, env) {
  const url = new URL(req.url);
  const paths = authPaths(url);
  const secret = String(env.STATS_PASSWORD || '');
  if (!secret) return redirect(`${paths.stats}?e=unconfigured`);

  const ip = clientIp(req);
  if (await tooManyAttempts(env, ip)) return redirect(`${paths.stats}?e=locked`);

  let password = '';
  try {
    const type = req.headers.get('Content-Type') || '';
    if (type.includes('application/json')) {
      const body = await req.json();
      password = String(body?.password || '');
    } else {
      const form = await req.formData();
      password = String(form.get('password') || '');
    }
  } catch {
    password = '';
  }
  if (password.length > 200) password = password.slice(0, 200);

  if (!password || !(await passwordMatches(secret, password))) {
    await recordFailure(env, ip);
    return redirect(`${paths.stats}?e=bad`);
  }

  await clearFailures(env, ip);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await signSession(secret, String(exp));
  return redirect(paths.stats, sessionCookie(url, `${exp}.${sig}`, SESSION_TTL_SEC));
}

function handleLogout(req) {
  const url = new URL(req.url);
  const paths = authPaths(url);
  return redirect(paths.stats, sessionCookie(url, '', 0));
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
  for (let i = SERIES_DAYS - 1; i >= 0; i -= 1) days.push(dayOffset(today, -i));
  const weekStart = dayOffset(today, -(WEEK_DAYS - 1));

  const wauIds = new Set();
  const active14Ids = new Set();
  const versions = Object.create(null);
  const series = [];
  let dau = 0;

  for (const day of days) {
    const keys = await listAll(env, `seen:${day}:`);
    series.push({ day, active: keys.length });
    if (day === today) dau = keys.length;
    const prefix = `seen:${day}:`;
    for (const item of keys) {
      const id = item.name.slice(prefix.length);
      if (!id) continue;
      active14Ids.add(id);
      if (day >= weekStart) wauIds.add(id);
    }
    if (day === today) {
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
  const peak = series.reduce((best, row) => (row.active > best.active ? row : best), series[0] || { day: today, active: 0 });

  return {
    dau,
    wau: wauIds.size,
    active14: active14Ids.size,
    versions: versionsObj,
    series,
    peak: { day: peak.day, active: peak.active },
    day: today,
    updatedAt: new Date().toISOString(),
  };
}

async function loadStats(env) {
  const cached = await env.BRIDGE_STATS.get(CACHE_KEY, { type: 'json' });
  if (cached && cached.payload && cached.payload.series && cached.at && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.payload;
  }
  const payload = await computeStats(env);
  await env.BRIDGE_STATS.put(CACHE_KEY, JSON.stringify({ at: Date.now(), payload }), {
    expirationTtl: 24 * 3600,
  });
  return payload;
}

function wantsHtml(req) {
  const url = new URL(req.url);
  if (url.pathname.endsWith('.json')) return false;
  const format = String(url.searchParams.get('format') || '').toLowerCase();
  if (format === 'json') return false;
  if (format === 'html') return true;
  const dest = String(req.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
  if (dest === 'document' || dest === 'iframe') return true;
  const accept = req.headers.get('Accept') || '';
  if (!/text\/html/i.test(accept)) return false;
  const lower = accept.toLowerCase();
  const htmlAt = lower.indexOf('text/html');
  const jsonAt = lower.indexOf('application/json');
  return jsonAt === -1 || htmlAt < jsonAt;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCount(n) {
  const num = Number(n) || 0;
  try {
    return num.toLocaleString('zh-CN');
  } catch {
    return String(num);
  }
}

function formatShare(part, whole) {
  const total = Number(whole) || 0;
  if (total <= 0) return '0%';
  const n = Math.round((Number(part) / total) * 1000) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

function splitDay(day) {
  const parts = String(day || '').split('-');
  if (parts.length !== 3) return null;
  const month = Number(parts[1]);
  const date = Number(parts[2]);
  if (!month || !date) return null;
  return { month, date };
}

function shortDay(day) {
  const parts = splitDay(day);
  if (!parts) return esc(day);
  return `${parts.month}/${parts.date}`;
}

function monthDay(day) {
  const parts = splitDay(day);
  if (!parts) return esc(day || '—');
  return `${parts.month}月${parts.date}日`;
}

function formatBeijing(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return esc(iso || '—');
  try {
    return esc(new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(t));
  } catch {
    return esc(iso);
  }
}

function renderDelta(dau, series) {
  if (!Array.isArray(series) || series.length < 2) return '';
  const yesterday = Number(series[series.length - 2].active) || 0;
  const diff = (Number(dau) || 0) - yesterday;
  if (diff === 0) return '<p class="delta flat">与昨日持平</p>';
  const up = diff > 0;
  const sign = up ? '+' : '−';
  return `<p class="delta ${up ? 'up' : 'down'}">${sign}${formatCount(Math.abs(diff))} 较昨日</p>`;
}

function renderChart(series, today) {
  const rows = Array.isArray(series) ? series : [];
  const max = rows.reduce((m, row) => Math.max(m, Number(row.active) || 0), 0);
  if (!rows.length) {
    return '<p class="empty">还没有每日数据。</p>';
  }
  const cols = rows.map((row) => {
    const active = Number(row.active) || 0;
    const height = max > 0 ? Math.max(active > 0 ? 6 : 0, Math.round((active / max) * 100)) : 0;
    const isToday = row.day === today;
    return `<div class="col${isToday ? ' is-today' : ''}">
      <span class="col-val">${formatCount(active)}</span>
      <div class="col-track"><div class="col-bar" style="height:${height}%"></div></div>
      <span class="col-day">${shortDay(row.day)}</span>
    </div>`;
  }).join('');
  return `<div class="chart-scroll"><div class="chart">${cols}</div></div>`;
}

function renderVersions(versions, dau) {
  const entries = Object.entries(versions || {});
  if (!entries.length) return '<p class="empty">今天还没有版本上报。</p>';
  const total = entries.reduce((sum, [, count]) => sum + (Number(count) || 0), 0) || Number(dau) || 0;
  const max = entries.reduce((m, [, count]) => Math.max(m, Number(count) || 0), 0) || 1;
  return entries.map(([version, count]) => {
    const n = Number(count) || 0;
    const width = Math.max(n > 0 ? 4 : 0, Math.round((n / max) * 100));
    return `<div class="ver">
      <div class="ver-top"><span class="ver-name">${esc(version)}</span><span class="ver-meta">${formatCount(n)} · ${formatShare(n, total)}</span></div>
      <div class="ver-track"><div class="ver-bar" style="width:${width}%"></div></div>
    </div>`;
  }).join('');
}

function renderStatsHtml(payload, logoutPath) {
  const dau = Number(payload.dau) || 0;
  const wau = Number(payload.wau) || 0;
  const active14 = Number(payload.active14) || 0;
  const series = Array.isArray(payload.series) ? payload.series : [];
  const peak = payload.peak || {};
  const share = formatShare(dau, wau);
  const jsonHref = '?format=json';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#eef6f3">
<title>Bridge 活跃数据 — Mineradio</title>
<link rel="icon" href="/icons/icon32.png" type="image/png">
<style>
  :root {
    --bg: #eef6f3;
    --bg-2: #f7fbf9;
    --ink: #14241f;
    --muted: #5c6f68;
    --line: rgba(20, 36, 31, 0.1);
    --card: #ffffff;
    --accent: #0b8a78;
    --accent-rgb: 11, 138, 120;
    --shadow: 0 10px 30px rgba(20, 50, 40, 0.06);
    --radius: 16px;
    --down: #b4535a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    font: 400 15px/1.7 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    background:
      radial-gradient(920px 460px at 8% -8%, rgba(11, 138, 120, 0.16), transparent 58%),
      radial-gradient(760px 420px at 100% 0%, rgba(64, 140, 210, 0.12), transparent 52%),
      linear-gradient(180deg, var(--bg) 0%, var(--bg-2) 48%, #f3f8f6 100%);
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 36px 20px 72px; }
  a { color: var(--accent); text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; text-underline-offset: 2px; }
  .brand {
    display: inline-flex; align-items: center; gap: 10px;
    color: var(--ink); font-weight: 700; margin-bottom: 22px;
  }
  .brand img { width: 28px; height: 28px; border-radius: 8px; }
  h1 { font-size: clamp(28px, 4vw, 36px); line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
  .lead { color: var(--muted); margin: 0 0 22px; max-width: 40em; font-size: 14.5px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 16px 18px 14px;
  }
  .card .k { color: var(--muted); font-size: 13px; margin: 0; }
  .card .v {
    font-variant-numeric: tabular-nums;
    font-size: 34px; line-height: 1.15; font-weight: 700; margin: 4px 0 0; letter-spacing: -0.03em;
  }
  .delta { margin: 6px 0 0; font-size: 13px; font-weight: 650; }
  .delta.up { color: var(--accent); }
  .delta.down { color: var(--down); }
  .delta.flat { color: var(--muted); font-weight: 500; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 22px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .panel { margin-top: 8px; }
  .chart-scroll { overflow-x: auto; padding-bottom: 4px; }
  .chart {
    min-width: 640px; height: 220px;
    display: grid; grid-template-columns: repeat(14, 1fr); gap: 8px; align-items: stretch;
  }
  .col { display: flex; flex-direction: column; align-items: center; min-width: 0; height: 100%; }
  .col-val { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; height: 16px; }
  .col-track { flex: 1; width: 100%; max-width: 28px; display: flex; align-items: flex-end; }
  .col-bar {
    width: 100%; border-radius: 8px 8px 4px 4px;
    background: rgba(var(--accent-rgb), 0.38);
    min-height: 0;
  }
  .col.is-today .col-bar { background: var(--accent); }
  .col.is-today .col-val, .col.is-today .col-day { color: var(--accent); font-weight: 650; }
  .col-day { margin-top: 6px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .vers { display: grid; gap: 12px; }
  .ver-top { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  .ver-name { font-weight: 650; }
  .ver-meta { color: var(--muted); font-variant-numeric: tabular-nums; }
  .ver-track { margin-top: 6px; height: 8px; border-radius: 999px; background: rgba(var(--accent-rgb), 0.1); overflow: hidden; }
  .ver-bar { height: 100%; border-radius: inherit; background: var(--accent); }
  .empty { color: var(--muted); margin: 0; }
  .foot { margin-top: 22px; color: var(--muted); font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 18px; }
  .actions form { margin: 0; }
  .btn {
    display: inline-flex; align-items: center; height: 36px; padding: 0 14px;
    border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--ink);
    font: inherit; font-size: 13.5px; font-weight: 650; cursor: pointer;
  }
  a.btn { text-decoration: none; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (max-width: 720px) {
    .cards { grid-template-columns: 1fr; }
    .card .v { font-size: 30px; }
  }
</style>
</head>
<body>
  <main class="wrap">
    <a class="brand" href="/">
      <img src="/icons/icon48.png" width="28" height="28" alt="">
      <span>Mineradio</span>
    </a>
    <h1>Bridge 活跃数据</h1>
    <p class="lead">匿名心跳只记随机安装 ID 和扩展版本，不含账号、Cookie 或听歌记录。同一个安装在一个 UTC 日内只算一次。</p>
    <section class="cards" aria-label="汇总">
      <article class="card">
        <p class="k">今日活跃</p>
        <p class="v">${formatCount(dau)}</p>
        ${renderDelta(dau, series)}
      </article>
      <article class="card">
        <p class="k">近 7 日活跃</p>
        <p class="v">${formatCount(wau)}</p>
        <p class="delta flat">今日约占 ${share}</p>
      </article>
      <article class="card">
        <p class="k">近 14 日活跃</p>
        <p class="v">${formatCount(active14)}</p>
        <p class="delta flat">去重安装数</p>
      </article>
    </section>
    <p class="note">统计日 ${esc(payload.day || '')}（UTC）。峰值 ${monthDay(peak.day)} · ${formatCount(peak.active)} 人。汇总大约每 10 分钟更新。</p>
    <section class="card panel">
      <h2>近 14 日</h2>
      ${renderChart(series, payload.day)}
    </section>
    <section class="card panel">
      <h2>今日版本</h2>
      <div class="vers">${renderVersions(payload.versions, dau)}</div>
    </section>
    <p class="foot">更新于 ${formatBeijing(payload.updatedAt)}（北京时间）</p>
    <div class="actions">
      <button class="btn primary" type="button" onclick="location.reload()">刷新</button>
      <a class="btn" href="${jsonHref}">JSON</a>
      <form method="post" action="${esc(logoutPath)}"><button class="btn" type="submit">退出登录</button></form>
      <a class="btn" href="/">打开网页版</a>
    </div>
  </main>
</body>
</html>`;
}

async function handleStats(req, env) {
  const url = new URL(req.url);
  if (!(await isAuthed(req, env))) {
    if (wantsHtml(req)) return htmlResponse(renderLoginHtml(url, env));
    return json({ ok: false, error: 'unauthorized' }, 401, req);
  }
  const payload = await loadStats(env);
  if (wantsHtml(req)) return htmlResponse(renderStatsHtml(payload, authPaths(url).logout));
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
    if ((path === '/bridge/login' || path === '/login') && req.method === 'POST') {
      return handleLogin(req, env);
    }
    if ((path === '/bridge/logout' || path === '/logout') && req.method === 'POST') {
      return handleLogout(req);
    }
    if ((path === '/bridge/stats' || path === '/stats' || path === '/bridge/stats.json' || path === '/stats.json') && req.method === 'GET') {
      return handleStats(req, env);
    }
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'mineradio-bridge-stats' }, 200, req);
    }
    return json({ ok: false, error: 'not found' }, 404, req);
  },
};
