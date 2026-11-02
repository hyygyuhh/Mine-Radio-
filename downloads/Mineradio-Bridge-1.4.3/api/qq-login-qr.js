/**
 * QQ Music QR login — port of sansenjian/qq-music-api
 * Docs: https://sansenjian.github.io/qq-music-api/api/user.html
 *
 * Flow:
 *  1. GET  ptqrshow  → qrsig + qr image + ptqrtoken(=hash33(qrsig))
 *  2. GET  ptqrlogin → wait / scanned / success(+checkSigUrl)
 *  3. GET  checkSigUrl (manual) → p_skey
 *  4. POST graph.qq.com/oauth2.0/authorize → Location?code=
 *  5. POST u.y.qq.com musicu QQLogin → qm_keyst session cookies
 *
 * Extension fetch cannot send Cookie headers; we inject them via
 * declarativeNetRequest for the duration of each privileged request.
 */

import { UA } from './weapi.js';
import { clearCookieCache, setBrowserCookies } from './cookies.js';

const QQ_PT_APPID = '716027609';
const QQ_PT_DAID = '383';
const QQ_PT_AID = '100497308';
const QQ_PT_U1 = 'https://graph.qq.com/oauth2.0/login_jump';
const QQ_AUTHORIZE_REDIRECT =
  'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/';

const DNR_COOKIE_RULE_ID = 917027609;
let dnrCookieSerial = 0;

export function hash33(qrsig) {
  let e = 0;
  const t = String(qrsig || '');
  for (let n = 0, o = t.length; n < o; n += 1) e += (e << 5) + t.charCodeAt(n);
  return 2147483647 & e;
}

function getGtk(pSkey) {
  const str = String(pSkey || '');
  let hash = 5381;
  for (let i = 0, len = str.length; i < len; i += 1) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 2147483647;
}

function getGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }).toUpperCase();
}

function parseSetCookieRaw(setCookieHeader) {
  if (!setCookieHeader) return [];
  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader
      .map((part) => String(part || '').split(';')[0].trim())
      .filter((pair) => pair.includes('=') && pair.split('=')[1]);
  }
  const cookies = [];
  const parts = String(setCookieHeader).split(/,(?=\s*[a-zA-Z_][\w-]*=)/);
  for (const part of parts) {
    const cookiePair = part.split(';')[0].trim();
    if (cookiePair && cookiePair.includes('=') && cookiePair.split('=')[1]) cookies.push(cookiePair);
  }
  return cookies;
}

function collectSetCookies(resp) {
  const list = [];
  try {
    if (resp && resp.headers && typeof resp.headers.getSetCookie === 'function') {
      list.push(...parseSetCookieRaw(resp.headers.getSetCookie()));
      return list;
    }
  } catch (_) {}
  try {
    list.push(...parseSetCookieRaw(resp && resp.headers && resp.headers.get('Set-Cookie')));
  } catch (_) {}
  return list;
}

function cookiePairsToHeader(pairs) {
  return (pairs || []).filter(Boolean).join('; ');
}

function cookiePairsToObject(pairs) {
  const obj = {};
  (pairs || []).forEach((pair) => {
    const eq = String(pair).indexOf('=');
    if (eq <= 0) return;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && value) obj[key] = value;
  });
  return obj;
}

function mergeCookiePairs(map, pairs) {
  for (const pair of pairs || []) {
    const eq = String(pair).indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name) map.set(name, pair.trim());
  }
  return map;
}

function buildLoginSession(cookie) {
  const cookieList = String(cookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const cookieObject = cookiePairsToObject(cookieList);
  const loginUin = cookieObject.uin || cookieObject.p_uin || '';
  return {
    loginUin,
    uin: loginUin,
    cookie: cookieList.join('; '),
    cookieList,
    cookieObject,
  };
}

async function withInjectedCookie(cookieHeader, urlFilters, run) {
  const cookie = String(cookieHeader || '').trim();
  const filters = (urlFilters || []).filter(Boolean);
  if (!cookie || !filters.length || !chrome.declarativeNetRequest?.updateSessionRules) {
    return run();
  }
  dnrCookieSerial = (dnrCookieSerial + 1) % 1000;
  const baseId = DNR_COOKIE_RULE_ID + dnrCookieSerial * 10;
  const ruleIds = filters.map((_, i) => baseId + i);
  const addRules = filters.map((urlFilter, i) => ({
    id: ruleIds[i],
    priority: 100,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: cookie }],
    },
    condition: {
      urlFilter,
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
      addRules,
    });
  } catch (err) {
    console.warn('[Mineradio Bridge] QQ cookie DNR inject failed', err);
    return run();
  }
  try {
    return await run();
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: [] });
    } catch (_) {}
  }
}

async function fetchWithTimeout(input, init = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function writeSessionCookies(session) {
  const raw = (session && session.cookie) || '';
  if (!raw) return;
  await setBrowserCookies('https://y.qq.com/', raw);
  await setBrowserCookies('https://qq.com/', raw);
  await setBrowserCookies('https://graph.qq.com/', raw);
  clearCookieCache();
}

/** GET /user/getQQLoginQr equivalent */
export async function qqGetLoginQr() {
  const u = new URL('https://ssl.ptlogin2.qq.com/ptqrshow');
  u.searchParams.set('appid', QQ_PT_APPID);
  u.searchParams.set('e', '2');
  u.searchParams.set('l', 'M');
  u.searchParams.set('s', '3');
  u.searchParams.set('d', '72');
  u.searchParams.set('v', '4');
  u.searchParams.set('t', String(Math.random()));
  u.searchParams.set('daid', QQ_PT_DAID);
  u.searchParams.set('pt_3rd_aid', QQ_PT_AID);
  u.searchParams.set('u1', QQ_PT_U1);

  const response = await fetchWithTimeout(u.toString(), {
    method: 'GET',
    credentials: 'include',
    headers: {
      'User-Agent': UA,
      Referer: 'https://xui.ptlogin2.qq.com/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error('Failed to fetch QQ login QR');

  const pairs = collectSetCookies(response);
  let qrsig = '';
  for (const pair of pairs) {
    if (pair.startsWith('qrsig=')) {
      qrsig = pair.slice('qrsig='.length);
      break;
    }
  }
  if (!qrsig) {
    // Fallback: cookie jar (credentials:include may have stored it)
    try {
      const item = await chrome.cookies.get({ url: 'https://ssl.ptlogin2.qq.com/', name: 'qrsig' });
      if (item && item.value) qrsig = item.value;
    } catch (_) {}
  }
  if (!qrsig) throw new Error('Failed to get qrsig from response');

  // Keep qrsig in Chrome jar for credentials:include fallback
  try {
    await chrome.cookies.set({
      url: 'https://ssl.ptlogin2.qq.com/',
      name: 'qrsig',
      value: qrsig,
      path: '/',
      secure: true,
    });
  } catch (_) {}

  const buf = await response.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const img = `data:image/png;base64,${btoa(binary)}`;
  const ptqrtoken = String(hash33(qrsig));

  return {
    // sansenjian shape
    img,
    qrsig,
    ptqrtoken,
    // Bridge-compatible aliases
    provider: 'qq',
    qrimg: img,
  };
}

/** POST /user/checkQQLoginQr equivalent */
export async function qqCheckLoginQr(params = {}) {
  const qrsig = String(params.qrsig || '').trim();
  let ptqrtoken = String(params.ptqrtoken || '').trim();
  if (!qrsig) {
    return { isOk: false, code: 65, refresh: true, message: '参数错误：缺少 qrsig', provider: 'qq' };
  }
  if (!ptqrtoken) ptqrtoken = String(hash33(qrsig));

  const cookieMap = new Map();
  cookieMap.set('qrsig', `qrsig=${qrsig}`);

  const pollUrl = new URL('https://ssl.ptlogin2.qq.com/ptqrlogin');
  pollUrl.searchParams.set('u1', QQ_PT_U1);
  pollUrl.searchParams.set('ptqrtoken', ptqrtoken);
  pollUrl.searchParams.set('ptredirect', '0');
  pollUrl.searchParams.set('h', '1');
  pollUrl.searchParams.set('t', '1');
  pollUrl.searchParams.set('g', '1');
  pollUrl.searchParams.set('from_ui', '1');
  pollUrl.searchParams.set('ptlang', '2052');
  pollUrl.searchParams.set('action', `0-0-${Date.now()}`);
  pollUrl.searchParams.set('js_ver', '23111510');
  pollUrl.searchParams.set('js_type', '1');
  pollUrl.searchParams.set('login_sig', '');
  pollUrl.searchParams.set('pt_uistyle', '40');
  pollUrl.searchParams.set('aid', QQ_PT_APPID);
  pollUrl.searchParams.set('daid', QQ_PT_DAID);
  pollUrl.searchParams.set('pt_3rd_aid', QQ_PT_AID);

  let response;
  try {
    response = await withInjectedCookie(cookiePairsToHeader(Array.from(cookieMap.values())), ['||ssl.ptlogin2.qq.com'], () =>
      fetchWithTimeout(pollUrl.toString(), {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': UA,
          Referer: 'https://xui.ptlogin2.qq.com/',
          Accept: '*/*',
        },
      }),
    );
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { isOk: false, code: 0, message: '登录检查超时', error: '登录检查超时', provider: 'qq' };
    }
    return {
      isOk: false,
      code: 0,
      message: (err && err.message) || '登录检查失败',
      error: (err && err.message) || '登录检查失败',
      provider: 'qq',
    };
  }

  const data = (await response.text()) || '';
  mergeCookiePairs(cookieMap, collectSetCookies(response));

  const refresh = /已失效|已过期/.test(data) && !/未失效/.test(data);
  const scanned = /二维码认证中|扫描成功|已扫描/.test(data);
  const waiting = /二维码未失效|等待扫码|未失效/.test(data);
  const success = /登录成功|登陆成功/.test(data);

  if (!success) {
    if (refresh) {
      return { isOk: false, code: 65, refresh: true, message: '二维码已失效', provider: 'qq', status: 'expired' };
    }
    if (scanned) {
      return { isOk: false, code: 67, refresh: false, message: '已扫码，请在手机确认', provider: 'qq', status: 'scanned' };
    }
    return {
      isOk: false,
      code: waiting ? 66 : 66,
      refresh: false,
      message: waiting ? '请用手机 QQ 扫码' : '未扫描二维码',
      provider: 'qq',
      status: 'wait',
      raw: data.slice(0, 160),
    };
  }

  // Extract check_sig URL (same regex as qq-music-api)
  const urlMatch = data.match(/(?:'((?:https?|ftp):\/\/[^\s/$.?#].[^\s]*)')/g);
  if (!urlMatch || !urlMatch[0]) {
    return {
      isOk: false,
      code: 0,
      message: '登录检查失败：未拿到 checkSigUrl',
      error: '提取不到 checkSigUrl',
      provider: 'qq',
    };
  }
  const checkSigUrl = urlMatch[0].replace(/'/g, '');

  let checkSigRes;
  try {
    checkSigRes = await withInjectedCookie(
      cookiePairsToHeader(Array.from(cookieMap.values())),
      ['||ptlogin2.qq.com', '||qq.com'],
      () =>
        fetchWithTimeout(
          checkSigUrl,
          {
            method: 'GET',
            redirect: 'manual',
            credentials: 'include',
            headers: {
              'User-Agent': UA,
              Referer: 'https://xui.ptlogin2.qq.com/',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          },
          12000,
        ),
    );
  } catch (err) {
    return {
      isOk: false,
      code: 0,
      message: (err && err.message) || '登录检查失败',
      error: 'check_sig 请求失败',
      provider: 'qq',
    };
  }

  const checkSigCookies = collectSetCookies(checkSigRes);
  mergeCookiePairs(cookieMap, checkSigCookies);
  const checkSigCookieHeader = cookiePairsToHeader(checkSigCookies);
  const pSkeyMatch = checkSigCookieHeader.match(/p_skey=([^;]+)/)
    || cookiePairsToHeader(Array.from(cookieMap.values())).match(/p_skey=([^;]+)/);
  if (!pSkeyMatch || !pSkeyMatch[1]) {
    return {
      isOk: false,
      code: 0,
      message: '登录检查失败：缺少 p_skey',
      error: '提取不到 p_skey',
      provider: 'qq',
    };
  }
  const pSkey = pSkeyMatch[1];
  const gtk = getGtk(pSkey);

  const form = new FormData();
  form.append('response_type', 'code');
  form.append('client_id', QQ_PT_AID);
  form.append('redirect_uri', QQ_AUTHORIZE_REDIRECT);
  form.append('scope', 'get_user_info,get_app_friends');
  form.append('state', 'state');
  form.append('switch', '');
  form.append('from_ptlogin', '1');
  form.append('src', '1');
  form.append('update_auth', '1');
  form.append('openapi', '1010_1030');
  form.append('g_tk', String(gtk));
  form.append('auth_time', String(Date.now()));
  form.append('ui', getGuid());

  let authorizeRes;
  try {
    authorizeRes = await withInjectedCookie(
      cookiePairsToHeader(Array.from(cookieMap.values())),
      ['||graph.qq.com'],
      () =>
        fetchWithTimeout(
          'https://graph.qq.com/oauth2.0/authorize',
          {
            method: 'POST',
            redirect: 'manual',
            credentials: 'include',
            headers: {
              'User-Agent': UA,
              Referer: 'https://graph.qq.com/',
              Origin: 'https://graph.qq.com',
            },
            body: form,
          },
          12000,
        ),
    );
  } catch (err) {
    return {
      isOk: false,
      code: 0,
      message: (err && err.message) || '授权请求失败',
      error: '授权响应异常',
      provider: 'qq',
    };
  }
  mergeCookiePairs(cookieMap, collectSetCookies(authorizeRes));
  const location = authorizeRes.headers.get('Location') || authorizeRes.headers.get('location') || '';
  if (authorizeRes.status < 300 || authorizeRes.status >= 400 || !location) {
    return {
      isOk: false,
      code: 0,
      message: '授权响应异常，未返回跳转地址',
      error: '授权响应异常，未返回跳转地址',
      provider: 'qq',
      authorizeStatus: authorizeRes.status,
    };
  }
  const codeMatch = String(location).match(/[?&]code=([^&]+)/);
  if (!codeMatch || !codeMatch[1]) {
    return {
      isOk: false,
      code: 0,
      message: '授权跳转缺少 code',
      error: '授权跳转缺少 code',
      provider: 'qq',
      location: String(location).slice(0, 200),
    };
  }
  const code = decodeURIComponent(codeMatch[1]);

  const fcgBody = JSON.stringify({
    comm: { g_tk: gtk, platform: 'yqq', ct: 24, cv: 0 },
    req: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: { code },
    },
  });

  let loginRes;
  try {
    loginRes = await withInjectedCookie(
      cookiePairsToHeader(Array.from(cookieMap.values())),
      ['||u.y.qq.com', '||y.qq.com'],
      () =>
        fetchWithTimeout(
          'https://u.y.qq.com/cgi-bin/musicu.fcg',
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'User-Agent': UA,
              Referer: 'https://y.qq.com/',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: 'https://y.qq.com',
            },
            body: fcgBody,
          },
          12000,
        ),
    );
  } catch (err) {
    return {
      isOk: false,
      code: 0,
      message: (err && err.message) || 'QQLogin 失败',
      error: 'QQLogin 失败',
      provider: 'qq',
    };
  }
  mergeCookiePairs(cookieMap, collectSetCookies(loginRes));

  // Promote musicid/musickey from JSON body when Set-Cookie is sparse
  try {
    const json = await loginRes.clone().json();
    const dataNode = json && json.req && json.req.data;
    if (dataNode && typeof dataNode === 'object') {
      if (dataNode.musickey) cookieMap.set('qm_keyst', `qm_keyst=${dataNode.musickey}`);
      if (dataNode.qqmusic_key) cookieMap.set('qqmusic_key', `qqmusic_key=${dataNode.qqmusic_key}`);
      const id = String(dataNode.musicid || dataNode.uin || '').replace(/\D/g, '');
      if (id) cookieMap.set('uin', `uin=o${id}`);
    }
  } catch (_) {}

  const session = buildLoginSession(cookiePairsToHeader(Array.from(cookieMap.values())));
  if (!session.cookieObject.qm_keyst && !session.cookieObject.qqmusic_key) {
    return {
      isOk: false,
      code: 0,
      message: '登录成功但未拿到 qm_keyst',
      error: '登录成功但未拿到 qm_keyst',
      provider: 'qq',
      session,
    };
  }

  await writeSessionCookies(session);

  return {
    // sansenjian shape
    isOk: true,
    message: '登录成功',
    session,
    // Bridge-compatible shape (UI / status)
    provider: 'qq',
    code: 0,
    status: 'ok',
    loggedIn: true,
    hasCookie: true,
    userId: String(session.uin || '').replace(/\D/g, ''),
    uin: String(session.uin || '').replace(/\D/g, ''),
    nickname: session.cookieObject.nick || session.cookieObject.nickname || `QQ ${String(session.uin || '').replace(/\D/g, '')}`,
  };
}
