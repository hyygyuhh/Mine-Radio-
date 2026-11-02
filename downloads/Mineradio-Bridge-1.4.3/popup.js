(function () {
  'use strict';

  var WEB_URL = 'https://mineradio.art/';
  var LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
  var MINERADIO_HOST_RE = /(^|\.)mineradio\.(art|cn)$/i;
  var STATUS_CACHE_KEY = 'mineradio_bridge_popup_status_v2';
  /* Skip network probe if cache is fresher than this */
  var FRESH_MS = 2 * 60 * 1000;

  var refreshBtn = document.getElementById('refresh');
  var refreshLabel = document.getElementById('refresh-label');
  var summaryPill = document.getElementById('summary-pill');
  var summaryText = document.getElementById('summary-text');
  var pageHint = document.getElementById('page-hint');
  var pageHintText = document.getElementById('page-hint-text');
  var openWeb = document.getElementById('open-web');
  var openSite = document.getElementById('open-site');
  var verEl = document.getElementById('ver');
  var SITE_URL = 'https://mineradio.cn/';
  var syncLabel = document.getElementById('sync-label');
  var busy = false;
  var lastSyncedAt = 0;

  function setBusy(on, label) {
    busy = !!on;
    if (refreshBtn) refreshBtn.classList.toggle('is-busy', busy);
    if (refreshLabel) refreshLabel.textContent = busy ? (label || '刷新中') : '刷新状态';
  }

  function setSyncing(on) {
    if (summaryPill) summaryPill.classList.toggle('is-syncing', !!on);
  }

  function formatSyncedAt(ts) {
    if (!ts) return '尚未同步';
    var diff = Date.now() - ts;
    if (diff < 20 * 1000) return '刚刚同步';
    if (diff < 60 * 1000) return Math.max(1, Math.round(diff / 1000)) + ' 秒前同步';
    if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前同步';
    if (diff < 24 * 60 * 60 * 1000) return Math.max(1, Math.round(diff / 3600000)) + ' 小时前同步';
    try {
      return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '已缓存';
    }
  }

  function setSyncLabel(text) {
    if (syncLabel) syncLabel.textContent = text || '';
  }

  function openUrl(url) {
    if (!url) return;
    try {
      chrome.tabs.create({ url: url });
    } catch (_) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function setSummary(loggedCount, total, failed) {
    if (!summaryPill || !summaryText) return;
    if (failed) {
      summaryPill.dataset.tone = 'bad';
      summaryText.textContent = '读取失败';
      return;
    }
    if (loggedCount <= 0) {
      summaryPill.dataset.tone = 'bad';
      summaryText.textContent = '0 / ' + total;
      return;
    }
    if (loggedCount < total) {
      summaryPill.dataset.tone = 'warn';
      summaryText.textContent = loggedCount + ' / ' + total;
      return;
    }
    summaryPill.dataset.tone = 'ok';
    summaryText.textContent = loggedCount + ' / ' + total;
  }

  function setProvider(prefix, data, opts) {
    opts = opts || {};
    var card = document.querySelector('.provider[data-provider="' + prefix + '"]');
    var statusEl = document.getElementById(prefix + '-status');
    var avatarEl = document.getElementById(prefix + '-avatar');
    var badgeEl = document.getElementById(prefix + '-badge');
    if (!card || !statusEl) return;

    card.classList.remove('is-loading', 'is-ok', 'is-bad');

    if (opts.error) {
      card.classList.add('is-bad');
      statusEl.className = 'meta is-bad';
      statusEl.textContent = opts.error;
      if (avatarEl) avatarEl.hidden = true;
      if (badgeEl) badgeEl.hidden = true;
      return;
    }

    if (!data || !data.loggedIn) {
      card.classList.add('is-bad');
      statusEl.className = 'meta is-bad';
      statusEl.textContent = '未登录 · 点击前往官网';
      if (avatarEl) avatarEl.hidden = true;
      if (badgeEl) badgeEl.hidden = true;
      return;
    }

    card.classList.add('is-ok');
    var bits = ['已登录'];
    if (data.nickname) bits.push(data.nickname);
    if (opts.warn) {
      statusEl.className = 'meta is-warn';
      bits.push(opts.warn);
    } else {
      statusEl.className = 'meta is-ok';
    }
    statusEl.textContent = bits.join(' · ');

    if (avatarEl) {
      if (data.avatar) {
        avatarEl.src = data.avatar;
        avatarEl.hidden = false;
      } else {
        avatarEl.hidden = true;
      }
    }

    if (badgeEl) {
      var vipText = '';
      if (data.isVip || data.isSvip) {
        vipText = (data.vipLabel && data.vipLabel !== '无VIP')
          ? data.vipLabel
          : (data.isSvip ? 'SVIP' : 'VIP');
      }
      if (vipText) {
        badgeEl.hidden = false;
        badgeEl.textContent = vipText;
      } else {
        badgeEl.hidden = true;
      }
    }
  }

  function applyStatusData(data, meta) {
    meta = meta || {};
    data = data || {};
    if (data.version && verEl) verEl.textContent = 'v' + data.version;

    setProvider('ne', data.netease || {});
    var qqWarn = data.qq && data.qq.loggedIn && !data.qq.playbackKeyReady ? '播放票据未就绪' : '';
    setProvider('qq', data.qq || {}, qqWarn ? { warn: qqWarn } : {});
    setProvider('kg', data.kg || {});

    var logged = 0;
    if (data.netease && data.netease.loggedIn) logged += 1;
    if (data.qq && data.qq.loggedIn) logged += 1;
    if (data.kg && data.kg.loggedIn) logged += 1;
    setSummary(logged, 3, false);

    if (meta.at) {
      lastSyncedAt = meta.at;
      setSyncLabel((meta.fromCache ? '缓存 · ' : '') + formatSyncedAt(meta.at));
    }
  }

  function readCache() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STATUS_CACHE_KEY], function (bag) {
          resolve((bag && bag[STATUS_CACHE_KEY]) || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function writeCache(data) {
    var payload = { at: Date.now(), data: data || {} };
    lastSyncedAt = payload.at;
    try {
      chrome.storage.local.set({ [STATUS_CACHE_KEY]: payload });
    } catch (_) {}
    return payload;
  }

  function isMineradioUrl(url) {
    try {
      var u = new URL(String(url || ''));
      if (LOCAL_HOST_RE.test(u.hostname)) return true;
      if (MINERADIO_HOST_RE.test(u.hostname)) return true;
      if (/github\.io$/i.test(u.hostname) && /mineradio/i.test(u.pathname + u.hostname)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  async function updatePageHint() {
    if (!pageHint || !pageHintText) return;
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var active = tabs && tabs[0];
      var url = active && active.url;
      if (!url || /^chrome:|^edge:|^about:/i.test(url)) {
        pageHint.hidden = false;
        pageHintText.textContent = '请打开 mineradio.art，扩展才会注入到网页版。';
        return;
      }
      if (isMineradioUrl(url)) {
        pageHint.hidden = true;
        pageHintText.textContent = '';
        if (openWeb && /^https?:/i.test(url)) openWeb.href = url.split('#')[0];
        return;
      }
      pageHint.hidden = false;
      pageHintText.textContent = '当前标签不是 Mineradio 网页版。登录平台后，请回到 mineradio.art 使用。';
    } catch (_) {
      pageHint.hidden = true;
    }
  }

  async function refreshStatus(opts) {
    opts = opts || {};
    var silent = !!opts.silent;
    var forceRescan = opts.forceRescan !== false && !silent;
    if (busy && !silent) return;
    if (!silent) {
      setBusy(true, '刷新中');
      ['ne', 'qq', 'kg'].forEach(function (prefix) {
        var card = document.querySelector('.provider[data-provider="' + prefix + '"]');
        if (card) card.classList.add('is-loading');
      });
      setSyncLabel('正在重新检测…');
    } else {
      setSyncing(true);
      if (lastSyncedAt) setSyncLabel('后台更新中 · ' + formatSyncedAt(lastSyncedAt));
      else setSyncLabel('后台同步中…');
    }

    try {
      await updatePageHint();

      if (forceRescan) {
        try {
          var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          var active = tabs && tabs[0];
          await chrome.runtime.sendMessage({
            type: 'MINERADIO_RESCAN_TABS',
            tabId: active && active.id,
            url: active && active.url,
          });
        } catch (_) {}
      }

      var resp = await chrome.runtime.sendMessage({ type: 'MINERADIO_BRIDGE_STATUS' });
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message || 'Bridge messaging failed');
      if (!resp || !resp.ok) {
        var failMsg = (resp && resp.error) ? String(resp.error).slice(0, 42) : '请重新加载扩展后再试';
        if (!silent || !lastSyncedAt) {
          setProvider('ne', null, { error: failMsg });
          setProvider('qq', null, { error: failMsg });
          setProvider('kg', null, { error: failMsg });
          setSummary(0, 3, true);
          setSyncLabel('同步失败');
        } else {
          setSyncLabel('更新失败 · 仍显示缓存');
        }
        return;
      }

      var data = resp.data || {};
      var saved = writeCache(data);
      applyStatusData(data, { at: saved.at, fromCache: false });
      if (!silent && refreshLabel) {
        refreshLabel.textContent = '已同步';
        setTimeout(function () {
          if (!busy && refreshLabel) refreshLabel.textContent = '刷新状态';
        }, 900);
      }
    } catch (err) {
      if (!silent || !lastSyncedAt) {
        setProvider('ne', null, { error: '扩展状态读取失败' });
        setProvider('qq', null, { error: '扩展状态读取失败' });
        setProvider('kg', null, { error: '扩展状态读取失败' });
        setSummary(0, 3, true);
        setSyncLabel('同步失败');
      } else {
        setSyncLabel('更新失败 · 仍显示缓存');
      }
      console.warn('[Mineradio Bridge popup]', err);
    } finally {
      if (!silent) {
        setBusy(false);
        ['ne', 'qq', 'kg'].forEach(function (prefix) {
          var card = document.querySelector('.provider[data-provider="' + prefix + '"]');
          if (card) card.classList.remove('is-loading');
        });
      }
      setSyncing(false);
    }
  }

  document.querySelectorAll('.provider').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openUrl(btn.getAttribute('data-url'));
    });
  });

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshStatus({ silent: false, forceRescan: true });
    });
  }

  if (openWeb) {
    openWeb.addEventListener('click', function (e) {
      e.preventDefault();
      openUrl(openWeb.href || WEB_URL);
    });
  }

  if (openSite) {
    openSite.addEventListener('click', function (e) {
      e.preventDefault();
      openUrl(openSite.href || SITE_URL);
    });
  }

  try {
    var manifestVer = chrome.runtime.getManifest().version;
    if (manifestVer && verEl) verEl.textContent = 'v' + manifestVer;
  } catch (_) {}

  (async function boot() {
    updatePageHint();
    var cached = await readCache();
    var age = cached && cached.at ? (Date.now() - cached.at) : Infinity;
    if (cached && cached.data) {
      applyStatusData(cached.data, { at: cached.at, fromCache: true });
    } else {
      setSummary(0, 3, false);
      if (summaryText) summaryText.textContent = '—';
      setSyncLabel('首次检测中…');
    }

    /* Fresh cache: don't re-probe login on every open */
    if (age < FRESH_MS) {
      setSyncLabel(formatSyncedAt(cached.at));
      return;
    }

    /* Stale / missing: quiet refresh, keep showing cache meanwhile */
    await refreshStatus({
      silent: !!cached,
      forceRescan: false,
    });
  })();
})();
