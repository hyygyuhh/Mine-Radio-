(function (global) {
  'use strict';

  var BRIDGE_SOURCE = 'mineradio-extension-bridge';
  var PAGE_SOURCE = 'mineradio-web-page';
  var REQUEST_TIMEOUT_MS = 45000;
  var bridgeReady = false;
  var bridgeVersion = '';
  var pendingRequests = new Map();
  var requestSeq = 0;
  var blobUrlCache = new Map();
  var beatmapCache = {};
  var fetchPatched = false;
  var apiJsonPatched = false;

  function isDesktopApp() {
    return !!(global.desktopWindow && global.desktopWindow.isDesktop);
  }

  function isPrivateLanHost(host) {
    host = String(host || '').toLowerCase();
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    var m = /^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/.exec(host);
    return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
  }

  function isLocalDevServer() {
    var host = String(global.location && global.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || isPrivateLanHost(host);
  }

  function bridgeHintHost() {
    var host = String(global.location && global.location.hostname || '');
    if (isPrivateLanHost(host)) return host + '（局域网）';
    if (host === '::1' || host === '[::1]') return '[::1]';
    return host || '当前页面';
  }

  function isWebModeEnabled() {
    if (isDesktopApp()) return false;
    try {
      var forced = global.localStorage.getItem('mineradio-web-mode-v1');
      if (forced === '0') return false;
      if (forced === '1') return true;
    } catch (_) {}
    return true;
  }

  function parseApiPath(url) {
    var raw = String(url || '');
    var path = raw;
    var query = {};
    try {
      var parsed = new URL(raw, global.location.origin);
      path = parsed.pathname;
      parsed.searchParams.forEach(function (value, key) {
        query[key] = value;
      });
    } catch (_) {
      var qIdx = raw.indexOf('?');
      if (qIdx >= 0) {
        path = raw.slice(0, qIdx);
        raw.slice(qIdx + 1).split('&').forEach(function (part) {
          var eq = part.indexOf('=');
          if (eq <= 0) return;
          query[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
        });
      }
    }
    return { path: path, query: query };
  }

  function postBridgeMessage(type, payload) {
    global.postMessage(Object.assign({ source: PAGE_SOURCE, type: type }, payload || {}), '*');
  }

  function waitForBridge(timeoutMs) {
    if (bridgeReady) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(false);
      }, timeoutMs || 3000);
      function onMessage(event) {
        if (event.source !== global || !event.data || event.data.source !== BRIDGE_SOURCE) return;
        if (event.data.type === 'MINERADIO_BRIDGE_READY' || event.data.type === 'MINERADIO_BRIDGE_PONG') {
          bridgeReady = true;
          bridgeVersion = event.data.version || '';
          if (!done) {
            done = true;
            clearTimeout(timer);
            global.removeEventListener('message', onMessage);
            resolve(true);
          }
        }
      }
      global.addEventListener('message', onMessage);
      postBridgeMessage('MINERADIO_BRIDGE_PING');
    });
  }

  function extensionApiRequest(path, query, opts) {
    opts = opts || {};
    var id = 'req_' + (++requestSeq);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pendingRequests.delete(id);
        reject(new Error('扩展 API 超时: ' + path));
      }, opts.timeoutMs || REQUEST_TIMEOUT_MS);
      pendingRequests.set(id, {
        resolve: function (payload) {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: function (err) {
          clearTimeout(timer);
          reject(err);
        },
      });
      postBridgeMessage('MINERADIO_API', {
        id: id,
        payload: {
          path: path,
          method: opts.method || 'GET',
          query: query || {},
          body: opts.body || null,
          headers: opts.headers || null,
        },
      });
    });
  }

  function bufferToBlobUrl(buffer, contentType) {
    var bytes;
    if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
    else if (buffer instanceof Uint8Array) bytes = buffer;
    else if (Array.isArray(buffer)) bytes = new Uint8Array(buffer);
    else bytes = new Uint8Array(buffer || []);
    var blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }

  function handleBinaryApiResponse(path, query, data) {
    if (!data || !data.__binary) return null;
    if (data.error) throw new Error(data.error);
    if (data.status && data.status >= 400) throw new Error('HTTP ' + data.status);
    var buf = data.buffer;
    var size = 0;
    if (buf instanceof ArrayBuffer) size = buf.byteLength;
    else if (buf instanceof Uint8Array) size = buf.byteLength;
    else if (Array.isArray(buf)) size = buf.length;
    if (!size) throw new Error('Empty binary response');
    var cacheKey = path + '?' + JSON.stringify(query || {});
    if (blobUrlCache.has(cacheKey)) return blobUrlCache.get(cacheKey);
    var blobUrl = bufferToBlobUrl(buf, data.contentType);
    blobUrlCache.set(cacheKey, blobUrl);
    return blobUrl;
  }

  function binaryPayloadToArrayBuffer(data) {
    if (!data || !data.__binary) return null;
    if (data.error || (data.status && data.status >= 400)) return null;
    var buf = data.buffer;
    if (buf instanceof ArrayBuffer) return buf;
    if (buf instanceof Uint8Array) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (Array.isArray(buf) && buf.length) return new Uint8Array(buf).buffer;
    return null;
  }

  async function fetchBeatAnalysisAudioBuffer(url) {
    if (!url || !/^https?:/i.test(String(url))) return null;
    var ready = await waitForBridge(12000);
    if (!ready) return null;
    var data = await extensionApiRequest('/api/audio', { url: String(url) }, {
      timeoutMs: 180000,
      headers: { range: 'bytes=0-4194303' },
    });
    return binaryPayloadToArrayBuffer(data);
  }
  global.__mineradioFetchBeatAnalysisBuffer = fetchBeatAnalysisAudioBuffer;

  function localBeatmapGet(key) {
    return beatmapCache[key] || { ok: false, hit: false };
  }

  function localBeatmapSet(key, map) {
    beatmapCache[key] = { ok: true, hit: true, map: map };
    try {
      global.localStorage.setItem('mineradio-web-beatmap:' + key, JSON.stringify(map));
    } catch (_) {}
    return { ok: true };
  }

  function tryLoadBeatmapFromStorage(key) {
    if (beatmapCache[key]) return beatmapCache[key];
    try {
      var raw = global.localStorage.getItem('mineradio-web-beatmap:' + key);
      if (raw) {
        var map = JSON.parse(raw);
        beatmapCache[key] = { ok: true, hit: true, map: map };
        return beatmapCache[key];
      }
    } catch (_) {}
    return { ok: false, hit: false };
  }

  async function webApiJson(url, opts) {
    opts = opts || {};
    var parsed = parseApiPath(url);
    var path = parsed.path;
    var query = parsed.query;

    if (path === '/api/beatmap/cache/status') {
      return { ok: true, provider: 'web-local', enabled: true };
    }
    if (path === '/api/beatmap/cache' && (opts.method || 'GET').toUpperCase() === 'GET') {
      return tryLoadBeatmapFromStorage(query.key || '');
    }
    if (path === '/api/beatmap/cache' && (opts.method || 'GET').toUpperCase() === 'POST') {
      var body = opts.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      return localBeatmapSet((body && body.key) || query.key || '', body && body.map);
    }

    var ready = await waitForBridge(opts.bridgeTimeoutMs || 10000);
    if (!ready) {
      throw new Error('未检测到 Mineradio Bridge 扩展（' + bridgeHintHost() + '）。请在 chrome://extensions 重新加载扩展后刷新本页。');
    }

    var data = await extensionApiRequest(path, query, opts);

    if (path === '/api/cover' || path === '/api/audio') {
      var blobUrl = handleBinaryApiResponse(path, query, data);
      if (path === '/api/audio' && !blobUrl && query.url) {
        return { url: query.url, direct: true };
      }
      if (blobUrl) {
        if (path === '/api/cover') return blobUrl;
        return { url: blobUrl, proxied: true };
      }
    }

    return data;
  }

  var coverResolveCache = new Map();
  async function resolveWebCoverUrl(url, cacheBust) {
    if (!url || /^blob:/i.test(url) || /^data:/i.test(url)) return url;
    var cacheKey = url + (cacheBust ? ':bust' : '');
    if (coverResolveCache.has(cacheKey)) return coverResolveCache.get(cacheKey);
    var task = webApiJson('/api/cover?url=' + encodeURIComponent(url) + (cacheBust ? '&v=' + Date.now() : ''), { bridgeTimeoutMs: 15000 })
      .then(function (blobUrl) { return (typeof blobUrl === 'string' && blobUrl) ? blobUrl : url; })
      .catch(function () { return url; });
    coverResolveCache.set(cacheKey, task);
    return task;
  }
  global.__mineradioResolveCoverUrl = resolveWebCoverUrl;

  async function webFetch(url, opts) {
    opts = opts || {};
    var parsed = parseApiPath(url);
    if (!parsed.path.startsWith('/api/')) {
      return global.__mineradioNativeFetch(url, opts);
    }
    var data = await webApiJson(url, opts);
    if (parsed.path === '/api/cover' && typeof data === 'string') {
      return {
        ok: true,
        json: function () { return Promise.resolve({ url: data }); },
        blob: function () { return global.__mineradioNativeFetch(data).then(function (r) { return r.blob(); }); },
      };
    }
    if (parsed.path === '/api/podcast/dj-beatmap') {
      return {
        ok: !!(data && data.ok),
        json: function () { return Promise.resolve(data); },
      };
    }
    return {
      ok: true,
      json: function () { return Promise.resolve(data); },
    };
  }

  global.addEventListener('message', function (event) {
    if (event.source !== global || !event.data || event.data.source !== BRIDGE_SOURCE) return;
    if (event.data.type === 'MINERADIO_BRIDGE_READY' || event.data.type === 'MINERADIO_BRIDGE_PONG') {
      bridgeReady = true;
      bridgeVersion = event.data.version || bridgeVersion;
      return;
    }
    if (event.data.type !== 'MINERADIO_API_RESPONSE') return;
    var pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    pendingRequests.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data.data);
    else pending.reject(new Error(event.data.error || '扩展 API 失败'));
  });

  function patchFetchTransport() {
    if (fetchPatched || !isWebModeEnabled()) return false;
    global.__mineradioWebMode = true;
    global.__mineradioWebApiJson = webApiJson;
    global.__mineradioNativeFetch = global.fetch.bind(global);
    global.fetch = function (url, opts) {
      var parsed = parseApiPath(String(url || ''));
      if (parsed.path.startsWith('/api/')) return webFetch(url, opts);
      return global.__mineradioNativeFetch(url, opts);
    };
    fetchPatched = true;
    return true;
  }

  function patchApiJsonTransport() {
    if (apiJsonPatched || !isWebModeEnabled()) return false;
    if (typeof global.apiJson !== 'function') return false;
    var nativeApiJson = global.apiJson;
    global.__mineradioWebApiJson = webApiJson;
    global.apiJson = async function (url, opts) {
      var parsed = parseApiPath(url);
      if (parsed.path.startsWith('/api/')) return webApiJson(url, opts);
      return nativeApiJson(url, opts);
    };
    apiJsonPatched = true;
    return true;
  }

  function installWebShell() {
    if (!isWebModeEnabled()) return false;
    global.__mineradioWebMode = true;
    global.__mineradioWebBridge = {
      isReady: function () { return bridgeReady; },
      getVersion: function () { return bridgeVersion; },
      ping: waitForBridge,
    };
    document.documentElement.classList.add('web-shell-root');
    if (document.body) document.body.classList.add('web-shell');
    if (typeof global.installWebPlaybackOptimizations === 'function') global.installWebPlaybackOptimizations();
    waitForBridge(5000).then(function (ready) {
      if (!ready) console.warn('[Mineradio Web] Bridge extension not detected.');
      else console.info('[Mineradio Web] Bridge ready', bridgeVersion);
      if (typeof global.installWebPlaybackOptimizations === 'function') global.installWebPlaybackOptimizations();
    });
    return true;
  }

  global.__mineradioInstallWebTransport = function () {
    patchFetchTransport();
    patchApiJsonTransport();
    installWebShell();
  };

  function startBridgePingLoop() {
    var attempts = 0;
    var timer = setInterval(function () {
      if (bridgeReady || attempts++ >= 30) {
        clearInterval(timer);
        return;
      }
      postBridgeMessage('MINERADIO_BRIDGE_PING');
    }, 400);
  }

  // 关键：在 head 里立刻劫持 fetch，避免主脚本 startup 登录请求打到静态服务器 404
  patchFetchTransport();
  postBridgeMessage('MINERADIO_BRIDGE_PING');
  startBridgePingLoop();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      global.__mineradioInstallWebTransport();
    });
  } else {
    global.__mineradioInstallWebTransport();
  }

  var apiJsonPoll = setInterval(function () {
    if (patchApiJsonTransport()) clearInterval(apiJsonPoll);
  }, 16);
  setTimeout(function () { clearInterval(apiJsonPoll); }, 8000);
})(window);
