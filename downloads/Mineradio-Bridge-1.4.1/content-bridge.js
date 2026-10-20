(function () {
  var BRIDGE_SOURCE = 'mineradio-extension-bridge';
  var PAGE_SOURCE = 'mineradio-web-page';
  var BRIDGE_VERSION = '1.4.1';
  var PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  if (window.__mineradioBridgeInjected) {
    window.postMessage({ source: BRIDGE_SOURCE, type: 'MINERADIO_BRIDGE_READY', version: BRIDGE_VERSION, extId: chrome.runtime.id }, '*');
    window.postMessage({ source: BRIDGE_SOURCE, type: 'MINERADIO_BRIDGE_PONG', ready: true, version: BRIDGE_VERSION, extId: chrome.runtime.id }, '*');
    try { chrome.runtime.sendMessage({ type: 'MINERADIO_ENSURE_MEDIA_RULES' }); } catch (_) {}
    return;
  }
  window.__mineradioBridgeInjected = true;
  window.__mineradioBridgeExtId = chrome.runtime && chrome.runtime.id;

  function proxyRefererFor(url) {
    if (/qqmusic|gtimg|qpic|qlogo|y\.qq|imgcache\.qq/i.test(url)) return 'https://y.qq.com/';
    if (/kugou/i.test(url)) return 'https://www.kugou.com/';
    return 'https://music.163.com/';
  }

  function needsPrivilegedProxy(url) {
    // QQ / gtimg usually omit CORS; content-script fetch from mineradio.art fails.
    return /(?:gtimg\.cn|qpic\.cn|qlogo\.cn|y\.qq\.com|qqmusic\.qq\.com|imgcache\.qq\.com)/i.test(String(url || ''));
  }

  function postToPage(payload, transfer) {
    window.postMessage(Object.assign({ source: BRIDGE_SOURCE }, payload), '*', transfer || []);
  }

  function arrayBufferToDataUrl(buffer, contentType) {
    if (!buffer || !buffer.byteLength) return '';
    var bytes = new Uint8Array(buffer);
    var parts = [];
    var step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
    }
    var mime = String(contentType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    if (!/^image\//i.test(mime)) mime = 'image/jpeg';
    return 'data:' + mime + ';base64,' + btoa(parts.join(''));
  }

  function postBinaryResult(id, result, path) {
    // Covers: always send data URL (avoids ArrayBuffer transfer/detach bugs across MV3 messaging).
    if (path === '/api/cover' && result) {
      var readyDataUrl = result.dataUrl && /^data:image\//i.test(result.dataUrl) ? result.dataUrl : '';
      if (!readyDataUrl && result.buffer instanceof ArrayBuffer) {
        try { readyDataUrl = arrayBufferToDataUrl(result.buffer, result.contentType); } catch (_) {}
      }
      if (readyDataUrl) {
        postToPage({
          type: 'MINERADIO_API_RESPONSE',
          id: id,
          ok: true,
          data: {
            __binary: true,
            status: result.status || 200,
            contentType: result.contentType || 'image/jpeg',
            dataUrl: readyDataUrl,
          },
        });
        return;
      }
    }

    var transfer = result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    postToPage({
      type: 'MINERADIO_API_RESPONSE',
      id: id,
      ok: true,
      data: result,
    }, transfer);
  }

  function postBinaryError(id, err) {
    postToPage({
      type: 'MINERADIO_API_RESPONSE',
      id: id,
      ok: false,
      error: (err && err.message) || String(err || 'proxy failed'),
    });
  }

  async function fetchBinaryInContentScript(payload) {
    var query = payload.query || {};
    var targetUrl = query.url;
    if (!targetUrl) throw new Error('Missing url');
    var extraHeaders = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
    var resp = await fetch(targetUrl, {
      method: payload.method || 'GET',
      headers: Object.assign({
        'User-Agent': PROXY_UA,
        Referer: proxyRefererFor(targetUrl),
      }, extraHeaders),
    });
    if (!resp.ok) throw new Error('proxy fetch failed: ' + resp.status);
    var buffer = await resp.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('proxy fetch empty body');
    return {
      __binary: true,
      status: resp.status,
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
      buffer: buffer,
    };
  }

  function coerceBinaryResult(result) {
    if (!result || !result.__binary) return null;
    if (result.error) throw new Error(result.error);
    if (result.dataUrl && /^data:image\//i.test(result.dataUrl)) {
      return {
        __binary: true,
        status: result.status || 200,
        contentType: result.contentType || 'image/jpeg',
        buffer: dataUrlToArrayBuffer(result.dataUrl),
        dataUrl: result.dataUrl,
      };
    }
    var buffer = result.buffer;
    if (buffer && !(buffer instanceof ArrayBuffer) && ArrayBuffer.isView(buffer)) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    // Some Chrome builds clone ArrayBuffer as a plain object / array-like.
    if (buffer && !(buffer instanceof ArrayBuffer) && buffer.length != null) {
      try { buffer = new Uint8Array(buffer).buffer; } catch (_) { buffer = null; }
    }
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
      throw new Error('Background proxy empty body');
    }
    return {
      __binary: true,
      status: result.status || 200,
      contentType: result.contentType || 'application/octet-stream',
      buffer: buffer,
    };
  }

  function dataUrlToArrayBuffer(dataUrl) {
    var m = String(dataUrl || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/i);
    if (!m) return new ArrayBuffer(0);
    var bin = atob(m[2]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function fetchBinaryViaBackground(payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(
          { type: 'MINERADIO_API', payload: payload },
          function (response) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Extension unavailable'));
              return;
            }
            if (!response || !response.ok) {
              reject(new Error((response && response.error) || 'Background proxy failed'));
              return;
            }
            try {
              resolve(coerceBinaryResult(response.data));
            } catch (err) {
              reject(err);
            }
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  async function fetchBinaryWithFallback(payload) {
    var targetUrl = (payload && payload.query && payload.query.url) || '';
    // Prefer privileged SW fetch for QQ CDNs (no CORS). Also always try SW first for covers.
    var preferBg = needsPrivilegedProxy(targetUrl) || (payload && payload.path === '/api/cover');
    if (preferBg) {
      try {
        return await fetchBinaryViaBackground(payload);
      } catch (bgErr) {
        try {
          return await fetchBinaryInContentScript(payload);
        } catch (_) {
          throw bgErr;
        }
      }
    }
    try {
      return await fetchBinaryInContentScript(payload);
    } catch (err) {
      return fetchBinaryViaBackground(payload);
    }
  }

  function forwardApiToBackground(id, payload) {
    chrome.runtime.sendMessage(
      { type: 'MINERADIO_API', payload: payload },
      function (response) {
        if (chrome.runtime.lastError) {
          postToPage({
            type: 'MINERADIO_API_RESPONSE',
            id: id,
            ok: false,
            error: chrome.runtime.lastError.message || 'Extension unavailable',
          });
          return;
        }
        var result = response && response.data;
        var transfer = [];
        if (result && result.__binary && result.buffer instanceof ArrayBuffer) {
          transfer.push(result.buffer);
        }
        postToPage({
          type: 'MINERADIO_API_RESPONSE',
          id: id,
          ok: !!(response && response.ok),
          data: result,
          error: response && response.error,
        }, transfer);
      },
    );
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;

    if (data.type === 'MINERADIO_BRIDGE_PING' || data.type === 'MINERADIO_BRIDGE_PROBE') {
      if (data.type === 'MINERADIO_BRIDGE_PROBE') {
        try {
          chrome.runtime.sendMessage({
            type: 'MINERADIO_FORCE_INJECT',
            pageUrl: data.pageUrl || String(window.location && window.location.href || ''),
            force: !!data.force,
          });
        } catch (_) {}
      }
      postToPage({ type: 'MINERADIO_BRIDGE_PONG', ready: true, version: BRIDGE_VERSION, extId: chrome.runtime.id });
      return;
    }

    if (data.type === 'MINERADIO_API') {
      var id = data.id;
      var payload = data.payload || {};
      var path = payload.path || '';

      if (path === '/api/audio' || path === '/api/cover') {
        fetchBinaryWithFallback(payload).then(function (result) {
          postBinaryResult(id, result, path);
        }).catch(function (err) {
          postBinaryError(id, err);
        });
        return;
      }

      forwardApiToBackground(id, payload);
    }
  });

  postToPage({ type: 'MINERADIO_BRIDGE_READY', version: BRIDGE_VERSION, extId: chrome.runtime.id });
  try {
    chrome.runtime.sendMessage({ type: 'MINERADIO_ENSURE_MEDIA_RULES' });
  } catch (_) {}
})();
