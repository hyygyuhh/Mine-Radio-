'use strict';

window.markDonateQrLoaded = window.markDonateQrLoaded || function(){};
window.markDonateQrFailed = window.markDonateQrFailed || function(){};

// ============================================================
//  Global State
// ============================================================
var audio = null, audioCtx = null, source = null, analyser = null, beatAnalyser = null, gainNode = null, audioReady = false;
var uiSfxCtx = null, lastShelfSelectSfxAt = 0;
var FFT_SIZE = 2048;
var frequencyData = new Uint8Array(FFT_SIZE / 2);
var timeDomainData = new Uint8Array(FFT_SIZE);
var BEAT_FFT_SIZE = 2048;
var beatFrequencyData = new Uint8Array(BEAT_FFT_SIZE / 2);
var beatTimeDomainData = new Uint8Array(BEAT_FFT_SIZE);
var bass = 0, mid = 0, treble = 0, audioEnergy = 0, beatPulse = 0, prevEnergy = 0;
var lyricSunEnergy = 0, lyricSunTarget = 0, lyricSunHold = 0, lyricSunAvg = 0, lyricSunPeak = 0.55;
var smoothBass = 0, smoothMid = 0, smoothTreb = 0, smoothEnergy = 0;
var bassPeak = 0.12, midPeak = 0.10, treblePeak = 0.08, energyPeak = 0.10;
var beatOnsetFlag = false;        // beat 上升沿瞬时标志,每帧消费一次
var lastStrongDrop = 0;           // 用于 burst 预设的强 drop 时刻

var lyricsLines = [], lyricsVisible = false, lyricsHasNativeKaraoke = false, lyricsTimingSource = 'none';
var playlist = [], playQueue = [], currentIdx = -1, playing = false, playToggleBusy = false;
var searchMode = 'song', podcastResults = [], podcastPrograms = [], podcastCurrentRadio = null;
var loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
var qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ 音乐', userId: '', avatar: '', vipType: 0 };
var kgLoginStatus = { provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false };
var qqLoginAutoRefreshTimer = null;
var qqLoginWasLoggedIn = false;
var loginProvider = 'netease';
var kgQrKey = null;
var qqQrSig = null;
var qqQrToken = null;
var loginQrBusy = false;
var loginQrError = '';
var loginQrHint = '';
var loginQrHintClass = '';
var activeAccountProvider = 'netease';
var dualAccountMode = false;
var AUTH_SESSION_STORE_KEY = 'mineradio-auth-session-v1';
function readAuthSessionState() {
  try {
    var raw = JSON.parse(localStorage.getItem(AUTH_SESSION_STORE_KEY) || '{}') || {};
    return {
      revoked: {
        netease: Number(raw.revoked && raw.revoked.netease) || 0,
        qq: Number(raw.revoked && raw.revoked.qq) || 0,
        kg: Number(raw.revoked && raw.revoked.kg) || 0
      },
      activeProvider: /^(netease|qq|kg)$/.test(String(raw.activeProvider || '')) ? raw.activeProvider : 'netease',
      dualMode: raw.dualMode === true
    };
  } catch (e) {
    return { revoked: { netease: 0, qq: 0, kg: 0 }, activeProvider: 'netease', dualMode: false };
  }
}
function writeAuthSessionState(patch) {
  var cur = readAuthSessionState();
  var next = Object.assign({}, cur, patch || {});
  if (patch && patch.revoked) next.revoked = Object.assign({}, cur.revoked, patch.revoked);
  try { localStorage.setItem(AUTH_SESSION_STORE_KEY, JSON.stringify(next)); } catch (e) {}
  return next;
}
function normalizeAuthProvider(provider) {
  return provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
}
function authLogoutFlagKey(provider) {
  return 'mineradio-logout-' + normalizeAuthProvider(provider) + '-v1';
}
function authLoggedOutStatus(provider) {
  provider = normalizeAuthProvider(provider);
  if (provider === 'qq') {
    return { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ 音乐', userId: '', avatar: '', vipType: 0, stale: false, playbackKeyReady: false };
  }
  if (provider === 'kg') {
    return { provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false, vipLabel: '无VIP' };
  }
  return { loggedIn: false };
}
var authCookieImportIntent = { netease: false, qq: false, kg: false };
function markAuthProviderRevoked(provider) {
  provider = normalizeAuthProvider(provider);
  try { localStorage.setItem(authLogoutFlagKey(provider), String(Date.now())); } catch (e) {}
  var patch = { revoked: {} };
  patch.revoked[provider] = Date.now();
  writeAuthSessionState(patch);
  authCookieImportIntent[provider] = false;
}
function clearAuthProviderRevoked(provider) {
  provider = normalizeAuthProvider(provider);
  try { localStorage.removeItem(authLogoutFlagKey(provider)); } catch (e) {}
  var patch = { revoked: {} };
  patch.revoked[provider] = 0;
  writeAuthSessionState(patch);
  authCookieImportIntent[provider] = false;
}
function markAuthCookieImportIntent(provider) {
  provider = normalizeAuthProvider(provider);
  authCookieImportIntent[provider] = true;
}
function hasAuthCookieImportIntent(provider) {
  provider = normalizeAuthProvider(provider);
  return !!authCookieImportIntent[provider];
}
function canAcceptProviderSession(provider) {
  provider = normalizeAuthProvider(provider);
  // After logout, keep session dead until a real login success or an explicit
  // 「官网登录」intent (then 「刷新状态」may re-import browser cookies).
  if (!isAuthProviderRevoked(provider)) return true;
  return hasAuthCookieImportIntent(provider);
}
function beginExplicitProviderLogin(provider) {
  // Do NOT clear revoke here — opening the login modal / switching tabs used to
  // wipe the logout flag and let surviving Bridge/browser cookies re-login.
  provider = normalizeAuthProvider(provider || loginProvider);
  return provider;
}
function friendlyAuthBridgeError(err) {
  var msg = String((err && err.message) || err || '');
  if (/Receiving end does not exist|Could not establish connection|Extension context invalidated|message port closed/i.test(msg)) {
    return '未连接到 Mineradio Bridge 扩展。请确认扩展已启用，点扩展图标「刷新状态」后回到本页重新检测。';
  }
  return msg;
}
function isAuthProviderRevoked(provider) {
  provider = normalizeAuthProvider(provider);
  try {
    if (localStorage.getItem(authLogoutFlagKey(provider))) return true;
  } catch (e) {}
  var state = readAuthSessionState();
  return !!(state.revoked && state.revoked[provider]);
}
function syncAuthRevocationFlags() {
  var state = readAuthSessionState();
  ['netease', 'qq', 'kg'].forEach(function(provider) {
    var flagTs = 0;
    try { flagTs = Number(localStorage.getItem(authLogoutFlagKey(provider))) || 0; } catch (e) {}
    var storeTs = Number(state.revoked && state.revoked[provider]) || 0;
    if (flagTs && !storeTs) {
      var patch = { revoked: {} };
      patch.revoked[provider] = flagTs;
      writeAuthSessionState(patch);
      state = readAuthSessionState();
    } else if (!flagTs && storeTs) {
      try { localStorage.setItem(authLogoutFlagKey(provider), String(storeTs)); } catch (e) {}
    }
  });
}
function bootstrapRevokedAuthState() {
  syncAuthRevocationFlags();
  var touched = false;
  if (isAuthProviderRevoked('netease')) {
    loginStatus = authLoggedOutStatus('netease');
    touched = true;
  }
  if (isAuthProviderRevoked('qq')) {
    qqLoginStatus = authLoggedOutStatus('qq');
    qqLoginWasLoggedIn = false;
    touched = true;
  }
  if (isAuthProviderRevoked('kg')) {
    kgLoginStatus = authLoggedOutStatus('kg');
    touched = true;
  }
  if (!touched) return;
  activeAccountProvider = firstLoggedProvider();
  if (!hasAnyPlatformLogin()) resetHomeDiscoverForLogout();
  ['netease', 'qq', 'kg'].forEach(function(provider) {
    if (isAuthProviderRevoked(provider)) enforceAuthRevocationOnServer(provider).catch(function() {});
  });
}
function persistAccountPreferences() {
  writeAuthSessionState({
    activeProvider: normalizeAuthProvider(activeAccountProvider),
    dualMode: !!dualAccountMode
  });
}
function loadAccountPreferences() {
  var state = readAuthSessionState();
  activeAccountProvider = normalizeAuthProvider(state.activeProvider);
  dualAccountMode = !!state.dualMode;
}
function authLogoutApiPath(provider) {
  provider = normalizeAuthProvider(provider);
  if (provider === 'kg') return '/api/kg/logout';
  if (provider === 'qq') return '/api/qq/logout';
  return '/api/logout';
}
async function enforceAuthRevocationOnServer(provider) {
  if (!isAuthProviderRevoked(provider)) return;
  try { await apiJson(authLogoutApiPath(provider)); } catch (e) {}
}
function applyAuthRevocationToLoginInfo(provider, info) {
  if (!isAuthProviderRevoked(provider)) return info;
  return authLoggedOutStatus(provider);
}
function applyProviderLoginStatus(provider, info) {
  provider = normalizeAuthProvider(provider);
  if (isAuthProviderRevoked(provider)) return authLoggedOutStatus(provider);
  if (provider === 'qq') return normalizeQQLoginStatus(info);
  if (provider === 'kg') {
    return Object.assign({ provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false, vipLabel: '无VIP' }, info || {});
  }
  return info || { loggedIn: false };
}
function resetHomeDiscoverForLogout() {
  if (!homeDiscoverState) return;
  homeDiscoverState.loading = false;
  homeDiscoverState.loaded = false;
  homeDiscoverState.loggedIn = false;
  homeDiscoverState.mode = 'starter';
  homeDiscoverState.songs = [];
  homeDiscoverState.playlists = [];
  homeDiscoverState.podcasts = [];
  homeDiscoverState.error = '';
}
function clearProviderClientState(provider) {
  provider = normalizeAuthProvider(provider);
  if (provider === 'kg') {
    kgLoginStatus = { provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false };
    userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'kg'; });
    return;
  }
  if (provider === 'qq') {
    qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ 音乐', userId: '', avatar: '', vipType: 0 };
    qqPlaylists = [];
    userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'qq'; });
    qqLoginWasLoggedIn = false;
    return;
  }
  loginStatus = { loggedIn: false };
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  closeCollectModal();
  updateLikeButtons();
  userPlaylists = qqPlaylists.slice();
}
async function finalizeProviderLogout(provider, opts) {
  opts = opts || {};
  provider = normalizeAuthProvider(provider);
  markAuthProviderRevoked(provider);
  stopQrPoll();
  try { await apiJson(authLogoutApiPath(provider)); } catch (e) {}
  if (provider === 'qq') {
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQQMusicLogin === 'function') {
        await window.desktopWindow.clearQQMusicLogin();
      }
    } catch (e) {}
  } else if (provider === 'netease') {
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearNeteaseMusicLogin === 'function') {
        await window.desktopWindow.clearNeteaseMusicLogin();
      }
    } catch (e) {}
  }
  clearProviderClientState(provider);
  if (loggedPlatformCount() < 2) dualAccountMode = false;
  activeAccountProvider = firstLoggedProvider();
  persistAccountPreferences();
  if (!hasAnyPlatformLogin()) resetHomeDiscoverForLogout();
  safeRenderQueuePanel('logout', { scrollCurrent: miniQueueOpen });
  renderUserBtn();
  safeShelfRebuild('logout');
  if (hasAnyPlatformLogin()) updateUserModalUi();
  else closeUserModal();
  if (!opts.silent && opts.toast) showToast(opts.toast);
}
loadAccountPreferences();
var qqCookieBusy = false;
var neteaseWebLoginBusy = false;
var qqWebLoginBusy = false;
var qqManualCookieOpen = false;
var kgManualCookieOpen = false;
var loginStatusChecked = false, loginStatusCheckFailed = false;
var qrPollTimer = null, qrKey = null;
var volumeTween = null, trackSwitchToken = 0;
var audioFadeTimer = null, audioElementFadeFrame = 0, audioFadeSerial = 0;
var AUDIO_FADE_IN_MS = 460;
var AUDIO_FADE_OUT_MS = 420;
var AUDIO_SILENCE_GAIN = 0.0001;
var playbackPausedAt = 0;
var playbackStreamLoadedAt = 0;
var currentPlaybackDirectUrl = '';
var PLAYBACK_STREAM_STALE_MS = 8 * 60 * 1000;
var userPlaylists = [], qqPlaylists = [], myPodcastCollections = [], myPodcastItems = {}, playlistCoverCache = {};
var CUSTOM_COVER_STORE_KEY = 'mineradio-custom-covers';
var CUSTOM_LYRIC_STORE_KEY = 'mineradio-custom-lyrics-v1';
var CUSTOM_LYRIC_PREF_STORE_KEY = 'mineradio-custom-lyric-prefs-v1';
var LYRIC_LAYOUT_STORE_KEY = 'mineradio-lyric-layout-v1';
var VISUAL_PRESET_SCHEMA = 'skull-preset-v2';
var PLAYBACK_QUALITY_STORE_KEY = 'mineradio-playback-quality-v1';
var UPLOAD_TIP_STORE_KEY = 'mineradio-upload-tip-seen';
var DIY_MODE_STORE_KEY = 'mineradio-diy-player-mode-v1';
var DIY_MODE_BTN_IDS = ['diy-mode-btn', 'fullscreen-diy-btn', 'web-diy-btn'];
var PLAYLIST_PANEL_PIN_STORE_KEY = 'mineradio-playlist-panel-pinned-v1';
var FX_PANEL_PIN_STORE_KEY = 'mineradio-fx-panel-pinned-v1';
var USER_CAPSULE_AUTO_HIDE_STORE_KEY = 'mineradio-user-capsule-auto-hide-v1';
var FX_FAB_AUTO_HIDE_STORE_KEY = 'mineradio-fx-fab-auto-hide-v1';
var CONTROLS_AUTO_HIDE_STORE_KEY = 'mineradio-controls-auto-hide-v1';
var FREE_CAMERA_STORE_KEY = 'mineradio-free-camera-v1';
var HOTKEY_SETTINGS_STORE_KEY = 'mineradio-hotkey-settings-v1';
var VISUAL_GUIDE_SEEN_STORE_KEY = 'mineradio-visual-guide-seen-v2';
var LOCAL_BEATMAP_STORE_KEY = 'mineradio-local-beatmaps-v1';
var LOCAL_BEAT_PREF_STORE_KEY = 'mineradio-local-beatmap-prefs-v1';
var LOCAL_BEAT_COMBOS = ['', 'downbeat', 'push', 'drop', 'rebound', 'accent'];
var HOTKEY_ACTIONS = [
  { key:'togglePlay', label:'播放 / 暂停', category:'播放', local:'Space', global:'Ctrl+Alt+Space' },
  { key:'prevTrack', label:'上一首', category:'播放', local:'ArrowLeft', global:'Ctrl+Alt+ArrowLeft' },
  { key:'nextTrack', label:'下一首', category:'播放', local:'ArrowRight', global:'Ctrl+Alt+ArrowRight' },
  { key:'volumeUp', label:'音量增加', category:'音量', local:'ArrowUp', global:'Ctrl+Alt+ArrowUp' },
  { key:'volumeDown', label:'音量降低', category:'音量', local:'ArrowDown', global:'Ctrl+Alt+ArrowDown' },
  { key:'toggleFullscreen', label:'全屏', category:'窗口', local:'KeyF', global:'Ctrl+Alt+KeyF' },
  { key:'toggleDesktopLyrics', label:'桌面歌词', category:'歌词', local:'Alt+KeyL', global:'Ctrl+Alt+KeyL' }
];
var HOTKEY_FIXED_SHORTCUTS = [
  { category:'DIY', label:'打开 / 关闭视觉控制台', keys:'P' },
  { category:'DIY', label:'控制台分页切换', keys:'1 – 5' },
  { category:'界面', label:'歌词面板', keys:'L' },
  { category:'界面', label:'沉浸模式', keys:'I' },
  { category:'界面', label:'关闭面板 / 弹窗', keys:'Esc' }
];
var hotkeyCaptureState = null;
var hotkeyGlobalStatus = {};
var diyPlayerMode = readDiyModePreference();
var customCoverMap = readCustomCoverMap();
var customLyricMap = readCustomLyricMap();
var customLyricPrefs = readCustomLyricPrefs();
var localBeatMapCache = readLocalBeatMapCache();
var localBeatMapPrefs = readLocalBeatPrefs();
var playbackQuality = readPlaybackQualityPreference();
var qqPlaybackQualityCeiling = '';
var playbackSourceCache = {};
var playbackSourceInflight = Object.create(null);
var playbackSourcePrefetchToken = 0;
var playbackAudioPrefetch = { key: '', idx: -1, media: null, directUrl: '', resolvedUrl: '', token: 0 };
var playbackAudioPrefetchToken = 0;
var lastPlaybackPrefetchAt = 0;
var searchHoverPrefetchTimer = null;
var searchResultsHoverBound = false;
var playbackQualityUiProvider = '';
var PLAYBACK_SOURCE_CACHE_TTL_MS = 240000;
var coverCropState = null, coverCropBound = false;
var currentLocalSong = null;
var lyricSourceMode = 'original';
var originalLyricsState = { lines: [], hasNativeKaraoke: false, timingSource: 'none' };
var localBeatAnalysis = { song:null, audioUrl:'', mode:'mr', active:false, token:0 };
var likedSongMap = {}, likeBusyMap = {}, likeStatusToken = 0;
var collectTargetSong = null, collectBusy = false;
var uploadTipTimer = null, uploadTipAttempts = 0;
var visualGuideActive = false, visualGuideStep = 0, visualGuideResizeBound = false;
var visualGuideState = { bottomWasVisible: false, searchWasPeek: false, manual: false };
var emptyHomeActive = false;
var homeForcedOpen = false;
var homeSuppressed = false;
var homeDiscoverState = { loading: false, loaded: false, loggedIn: false, mode: 'starter', songs: [], playlists: [], podcasts: [], error: '', updatedAt: 0 };
var HOME_TILE_MAX = 8;
var homePrefetchBound = false;
var homeHoverPrefetchTimer = 0;
var homeDiscoverToken = 0;
var homeFeaturedReviewsState = { loading: false, loaded: false, reviews: [], index: 0, error: '', updatedAt: 0 };
var homeFeaturedReviewsToken = 0;
var homeFeaturedReviewsTimer = null;
var HOME_FEATURED_REVIEWS_CACHE_KEY = 'mineradio-featured-reviews-v1';
var HOME_FEATURED_REVIEWS_TTL_MS = 5 * 60 * 1000;
function readHomeFeaturedReviewsCache() {
  try {
    var raw = JSON.parse(localStorage.getItem(HOME_FEATURED_REVIEWS_CACHE_KEY) || 'null');
    if (raw && raw.at && Date.now() - raw.at < HOME_FEATURED_REVIEWS_TTL_MS && Array.isArray(raw.reviews) && raw.reviews.length) return raw;
  } catch (e) {}
  return null;
}
function writeHomeFeaturedReviewsCache(payload) {
  try {
    localStorage.setItem(HOME_FEATURED_REVIEWS_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      reviews: (payload && payload.reviews) || [],
      updatedAt: Number(payload && payload.updatedAt) || Date.now()
    }));
  } catch (e) {}
}
function applyHomeFeaturedReviewsPayload(data) {
  homeFeaturedReviewsState.reviews = (data && data.reviews || []).filter(function(item){ return item && item.content && item.song; });
  homeFeaturedReviewsState.index = 0;
  homeFeaturedReviewsState.updatedAt = Number(data && data.updatedAt) || Date.now();
  homeFeaturedReviewsState.loaded = true;
  homeFeaturedReviewsState.error = (data && data.error) || (homeFeaturedReviewsState.reviews.length ? '' : 'EMPTY');
}
var homeVisualPresetActive = false;
var homeVisualPrevPreset = 0;
var HOME_LISTEN_STATS_KEY = 'mineradio-listen-stats-v1';
var HOME_WEATHER_CITY_KEY = 'mineradio-weather-city';
var homeWeatherRadioState = { loading: false, loaded: false, city: localStorage.getItem(HOME_WEATHER_CITY_KEY) || '上海', weather: null, radio: null, error: '', updatedAt: 0 };
var homeWeatherToken = 0;
var homeWeatherLoadTimer = null;
var homeWeatherLoadPromise = null;
var weatherRadioStartBusy = false;
var activeRadioContext = null;
var listenStatsState = loadListenStatsState();
var listenSession = null;
var appPerfMarks = [];
function markAppPerf(name) {
  try {
    var value = performance.now();
    appPerfMarks.push({ name: name, value: Math.round(value) });
    if (performance && performance.mark) performance.mark('mineradio:' + name);
    if (appPerfMarks.length <= 16) console.debug('[MineradioPerf]', name, Math.round(value) + 'ms');
  } catch (e) {}
}
markAppPerf('script-start');
function installStartupLongTaskObserver() {
  try {
    if (!('PerformanceObserver' in window)) return;
    var observer = new PerformanceObserver(function(list){
      list.getEntries().forEach(function(entry){
        if (entry.startTime > 15000) return;
        console.debug('[MineradioPerf] longtask', Math.round(entry.startTime) + 'ms', Math.round(entry.duration) + 'ms');
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    setTimeout(function(){ try { observer.disconnect(); } catch (e) {} }, 16000);
  } catch (e) {}
}
installStartupLongTaskObserver();
var queueViewTab = 'queue', playMode = 'loop', miniQueueOpen = false;
var miniQueueRenderSeq = 0, queueRenderSeq = 0, playlistRenderSeq = 0;
var queuePanelDirty = false;
var PLAYLIST_PANEL_BATCH_SIZE = 6;
var playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
var playlistGroupRenderLimit = { netease: PLAYLIST_PANEL_BATCH_SIZE, qq: PLAYLIST_PANEL_BATCH_SIZE, kg: PLAYLIST_PANEL_BATCH_SIZE };
var userPlaylistsCacheAt = 0;
var USER_PLAYLISTS_TTL_MS = 180000;
var USER_PLAYLIST_PROVIDER_STORE_KEY = 'mineradio-pl-provider-v1';
var userPlaylistProviderTab = 'netease';
var userPlaylistsGrouped = { netease: [], qq: [], kg: [] };
function normalizeUserPlaylistProvider(provider) {
  return provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
}
function userPlaylistProviderLabel(provider) {
  provider = normalizeUserPlaylistProvider(provider);
  return provider === 'qq' ? 'QQ 音乐' : (provider === 'kg' ? '酷狗音乐' : '网易云');
}
function loadUserPlaylistProviderTab() {
  try {
    var saved = localStorage.getItem(USER_PLAYLIST_PROVIDER_STORE_KEY);
    if (saved === 'qq' || saved === 'kg' || saved === 'netease') userPlaylistProviderTab = saved;
  } catch (_) {}
}
function saveUserPlaylistProviderTab() {
  try { localStorage.setItem(USER_PLAYLIST_PROVIDER_STORE_KEY, userPlaylistProviderTab); } catch (_) {}
}
loadUserPlaylistProviderTab();
function ensureUserPlaylistProviderTab(force) {
  var provider = normalizeUserPlaylistProvider(userPlaylistProviderTab);
  if (!force && hasPlatformLogin(provider)) return provider;
  if (hasPlatformLogin('netease')) return userPlaylistProviderTab = 'netease';
  if (hasPlatformLogin('qq')) return userPlaylistProviderTab = 'qq';
  if (hasPlatformLogin('kg')) return userPlaylistProviderTab = 'kg';
  return userPlaylistProviderTab = provider;
}
function updateUserPlaylistProviderChip() {
  var chip = document.getElementById('pl-provider-chip');
  if (!chip) return;
  var provider = normalizeUserPlaylistProvider(userPlaylistProviderTab);
  reindexUserPlaylistsGrouped();
  var count = (userPlaylistsGrouped[provider] || []).length;
  if (!hasPlatformLogin(provider)) {
    chip.textContent = userPlaylistProviderLabel(provider) + ' · 未登录';
    return;
  }
  chip.textContent = count ? (count + ' 个歌单 · ' + userPlaylistProviderLabel(provider)) : ('暂无歌单 · ' + userPlaylistProviderLabel(provider));
}
function updateUserPlaylistProviderTabs() {
  ensureUserPlaylistProviderTab();
  var wrap = document.getElementById('pl-provider-tabs');
  if (!wrap) return;
  ['netease', 'qq', 'kg'].forEach(function(provider) {
    var btn = wrap.querySelector('[data-pl-provider="' + provider + '"]');
    if (!btn) return;
    btn.classList.toggle('active', userPlaylistProviderTab === provider);
    btn.classList.toggle('logged-out', !hasPlatformLogin(provider));
  });
  updateUserPlaylistProviderChip();
}
function switchUserPlaylistProvider(provider) {
  provider = normalizeUserPlaylistProvider(provider);
  if (!hasPlatformLogin(provider)) {
    showToast('请先登录' + userPlaylistProviderLabel(provider));
    openProviderLogin(provider);
    return;
  }
  if (provider === userPlaylistProviderTab) return;
  userPlaylistProviderTab = provider;
  saveUserPlaylistProviderTab();
  playlistPanelDetailState = { key: '', loading: false, playlist: null, tracks: [], token: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER };
  resetPlaylistPanelRenderLimit();
  updateUserPlaylistProviderTabs();
  renderUserPlaylistsList({ animate: true, reset: true });
  var panel = document.getElementById('playlist-panel');
  if (panel) panel.scrollTop = 0;
}
function reindexUserPlaylistsGrouped() {
  var grouped = { netease: [], qq: [], kg: [] };
  (userPlaylists || []).forEach(function(pl) {
    if (!pl) return;
    if (pl.provider === 'qq') grouped.qq.push(pl);
    else if (pl.provider === 'kg') grouped.kg.push(pl);
    else grouped.netease.push(pl);
  });
  userPlaylistsGrouped = grouped;
}
var playlistPanelLazyBound = false;
var QUEUE_PANEL_BATCH_SIZE = 14;
var queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
var MINI_QUEUE_BATCH_SIZE = 12;
var miniQueueRenderLimit = MINI_QUEUE_BATCH_SIZE;
var queuePrefetchBound = false;
var queueHoverPrefetchTimer = null;
var queuePanelLazyBound = false;
var PODCAST_EPISODE_INITIAL = 32;
var PODCAST_EPISODE_BATCH = 24;
var podcastEpisodeRenderLimit = 0;
var PLAYLIST_DETAIL_INITIAL_RENDER = 64;
var PLAYLIST_DETAIL_BATCH_SIZE = 48;
var smoothWheelScrollBound = false;
var coverProcessToken = 0, aiDepthPipeline = null, aiDepthReady = false, aiDepthBusy = false, aiDepthFailUntil = 0;
var coverDepthCache = Object.create(null), coverDepthCacheKeys = [];
var aiDepthLastRunAt = 0, aiDepthMinGapMs = 18000;
var updatePreviewState = {
  visible: false,
  open: false,
  status: 'idle',
  progress: 0,
  timer: null,
  pollTimer: null,
  downloadJobId: '',
  patchJobId: '',
  mode: 'installer',
  installerPath: '',
  installerOpened: false,
  cached: false,
  currentVersion: '0.9.11',
  version: '1.1.0',
  configured: false,
  preview: true,
  updateAvailable: false,
  releaseUrl: '',
  downloadUrl: '',
  patchAvailable: false,
  patchUrl: '',
  received: 0,
  total: 0,
  speedBps: 0,
  etaSeconds: 0,
  sourceLabel: '',
  attempt: 0,
  attempts: 0,
  errorReason: '',
  errorDetail: '',
  failedAttempts: [],
  message: '',
  restartRequired: false,
  patchFallbackTried: false,
  hero: '当前版本，更新检测已就绪。',
  notes: [
    '安装包文字对比修复',
    '安装目录可自由选择',
    '单实例与快捷方式修复'
  ]
};
function readSavedVolume() {
  try {
    var v = parseFloat(localStorage.getItem('apex-player-volume'));
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1.0;
  } catch (e) {
    return 1.0;
  }
}
function readDiyModePreference() {
  try { return localStorage.getItem(DIY_MODE_STORE_KEY) === '1'; } catch (e) { return false; }
}
function saveDiyModePreference(on) {
  try { localStorage.setItem(DIY_MODE_STORE_KEY, on ? '1' : '0'); } catch (e) {}
}
function readBooleanPreference(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw == null) return !!fallback;
    return raw === '1';
  } catch (e) {
    return !!fallback;
  }
}
function saveBooleanPreference(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {}
}
function applyUserCapsuleAutoHideState() {
  document.body.classList.toggle('user-capsule-auto-hide', !!userCapsuleAutoHide);
  var btn = document.getElementById('user-capsule-hide-btn');
  if (btn) {
    btn.classList.toggle('on', !!userCapsuleAutoHide);
    btn.textContent = userCapsuleAutoHide ? '›' : '‹';
    btn.title = userCapsuleAutoHide ? '取消自动隐藏账号胶囊' : '自动隐藏账号胶囊';
  }
}
function toggleUserCapsuleAutoHide(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  userCapsuleAutoHide = !userCapsuleAutoHide;
  saveBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, userCapsuleAutoHide);
  applyUserCapsuleAutoHideState();
  showToast(userCapsuleAutoHide ? '账号胶囊已自动隐藏' : '账号胶囊已固定显示');
}
function updateUserCapsuleAutoHideFromPointer(x, y) {
  if (!userCapsuleAutoHide || immersiveMode) {
    document.body.classList.remove('user-capsule-peek');
    return;
  }
  var nearTopRight = x > innerWidth - 112 && y < 126;
  document.body.classList.toggle('user-capsule-peek', nearTopRight);
}
function applyFxFabAutoHideState(opts) {
  opts = opts || {};
  document.body.classList.toggle('fx-fab-auto-hide', !!fxFabAutoHide);
  if (!fxFabAutoHide) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = true;
  } else if (opts.forceHidden) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = false;
  }
  var btn = document.getElementById('fx-fab-hide-btn');
  if (btn) {
    btn.classList.toggle('on', !!fxFabAutoHide);
    btn.textContent = fxFabAutoHide ? '›' : '‹';
    btn.title = fxFabAutoHide ? '取消自动隐藏视觉控制台' : '自动隐藏视觉控制台';
  }
}
function toggleFxFabAutoHide(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  fxFabAutoHide = !fxFabAutoHide;
  saveBooleanPreference(FX_FAB_AUTO_HIDE_STORE_KEY, fxFabAutoHide);
  applyFxFabAutoHideState({ forceHidden: fxFabAutoHide });
  showToast(fxFabAutoHide ? '视觉控制台按钮已自动隐藏' : '视觉控制台按钮已固定显示');
}
function updateFxFabAutoHideFromPointer(x, y) {
  if (!fxFabAutoHide || !diyPlayerMode || immersiveMode) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = true;
    return;
  }
  var panel = document.getElementById('fx-panel');
  var panelOpen = !!(panel && (panel.classList.contains('peek') || panel.classList.contains('show')));
  var nearBottomRight = x > innerWidth - 126 && y > innerHeight - 158;
  if (!nearBottomRight) fxFabAutoHideRevealArmed = true;
  document.body.classList.toggle('fx-fab-peek', panelOpen || (nearBottomRight && fxFabAutoHideRevealArmed));
}
function layoutFullscreenDiyZone() {
  var width = innerWidth < 820 ? 104 : 128;
  var height = innerWidth < 720 ? 48 : 52;
  var left = innerWidth - 510;
  var top = 24;
  var anchor = document.querySelector('#top-right .top-account-pill') || document.getElementById('user-btn') || document.getElementById('top-right');
  if (anchor) {
    var rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      var gap = innerWidth < 820 ? 8 : 12;
      left = rect.left + rect.width / 2 - width / 2;
      top = rect.bottom + gap;
    }
  }
  left = Math.max(12, Math.min(innerWidth - width - 12, left));
  top = Math.max(8, Math.min(innerHeight - height - 8, top));
  document.documentElement.style.setProperty('--fullscreen-diy-left', left.toFixed(1) + 'px');
  document.documentElement.style.setProperty('--fullscreen-diy-top', top.toFixed(1) + 'px');
  document.documentElement.style.setProperty('--fullscreen-diy-width', width + 'px');
  return { left: left, top: top, width: width, height: height };
}
function shouldSuppressFullscreenDiyPeek() {
  var fxPanel = document.getElementById('fx-panel');
  var hotkeyModal = document.getElementById('hotkey-modal');
  var fxPanelOpen = !!(fxPanel && (fxPanel.classList.contains('peek') || fxPanel.classList.contains('show')));
  var hotkeyOpen = !!(hotkeyModal && hotkeyModal.classList.contains('show'));
  return !!(visualGuideActive || fxPanelOpen || hotkeyOpen);
}
function updateFullscreenDiyPeekFromPointer(x, y) {
  var isFullscreen = !!(desktopRuntimeState.fullscreen || desktopFullscreenActive || document.fullscreenElement || document.body.classList.contains('desktop-fullscreen'));
  if (!isFullscreen || immersiveMode || shouldSuppressFullscreenDiyPeek()) {
    document.body.classList.remove('fullscreen-diy-peek');
    return;
  }
  var rect = layoutFullscreenDiyZone();
  var anchor = document.querySelector('#top-right .top-account-pill') || document.getElementById('user-btn') || document.getElementById('top-right');
  var anchorRect = anchor ? anchor.getBoundingClientRect() : rect;
  var hitLeft = Math.min(rect.left, anchorRect.left) - 26;
  var hitRight = Math.max(rect.left + rect.width, anchorRect.right) + 26;
  var hitTop = Math.min(rect.top, anchorRect.top) - 18;
  var hitBottom = Math.max(rect.top + rect.height, anchorRect.bottom) + 16;
  var active = x >= hitLeft && x <= hitRight && y >= hitTop && y <= hitBottom;
  document.body.classList.toggle('fullscreen-diy-peek', active);
}
function isDiyMode() {
  return !!diyPlayerMode;
}
function primaryDiyModeButtonSelector() {
  if (document.body.classList.contains('desktop-shell')) {
    if (desktopRuntimeState.fullscreen || desktopFullscreenActive || document.fullscreenElement || document.body.classList.contains('desktop-fullscreen')) {
      return '#fullscreen-diy-btn';
    }
    return '#diy-mode-btn';
  }
  return '#web-diy-btn';
}
function syncDiyModeButton() {
  DIY_MODE_BTN_IDS.forEach(function(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('on', diyPlayerMode);
    btn.setAttribute('aria-pressed', diyPlayerMode ? 'true' : 'false');
    btn.title = diyPlayerMode ? '关闭 DIY 玩家模式' : '开启 DIY 玩家模式';
    btn.setAttribute('aria-label', btn.title);
  });
}
function applyDiyMode(on, opts) {
  opts = opts || {};
  diyPlayerMode = !!on;
  document.documentElement.classList.toggle('diy-mode-preload', diyPlayerMode);
  document.documentElement.classList.toggle('simple-mode-preload', !diyPlayerMode);
  document.body.classList.toggle('diy-mode', diyPlayerMode);
  document.body.classList.toggle('simple-mode', !diyPlayerMode);
  if (diyPlayerMode && typeof window.__mineradioEnsureDiyCss === 'function') {
    try { window.__mineradioEnsureDiyCss(); } catch (_) {}
  }
  syncDiyModeButton();
  if (opts.save) saveDiyModePreference(diyPlayerMode);
  if (!diyPlayerMode) {
    toggleFxPanel(false);
    togglePlaylistPanel(false);
    closeUploadTip(false);
    var quality = document.getElementById('quality-control');
    var volume = document.getElementById('volume-control');
    if (quality) quality.classList.remove('open');
    if (volume) volume.classList.remove('open');
  } else {
    applyFxPanelPinState();
    // 仅用户手动打开 DIY 时弹出控制台；刷新恢复偏好不要自动打开
    if (opts.fromUser) {
      try {
        if (document.body.classList.contains('phone-shell') && typeof toggleFxPanel === 'function') {
          toggleFxPanel(true);
        }
      } catch (_) {}
    }
  }
  if (opts.toast) {
    var phone = false;
    try { phone = document.body.classList.contains('phone-shell'); } catch (_) {}
    showToast(diyPlayerMode
      ? (phone ? 'DIY 已开启 · 右下角 DIY 可再次打开' : 'DIY 玩家模式已开启')
      : '已切回简约模式');
  }
  if (opts.animate && window.gsap) {
    var skipScale = false;
    try { skipScale = document.body.classList.contains('phone-shell'); } catch (_) {}
    if (!skipScale) {
      DIY_MODE_BTN_IDS.forEach(function(id) {
        var btn = document.getElementById(id);
        if (btn) window.gsap.fromTo(btn, { scale: 0.94 }, { scale: 1, duration: 0.34, ease: 'back.out(1.8)', overwrite: true });
      });
    }
  }
}
function toggleDiyMode() {
  applyDiyMode(!diyPlayerMode, { save: true, toast: true, animate: true, fromUser: true });
}
var targetVolume = readSavedVolume();
var lastNonZeroVolume = targetVolume > 0.01 ? targetVolume : 0.8;
var volumeCloseTimer = null;

// v7.2: 离线节拍预解析
//   每次切歌, fetch 完整音频 → OfflineAudioContext 分析 → 标出真鼓点
//   缓存按 song.id 存, 避免重复
var beatMapCache = {};       // { songId: { kicks: [t1, t2, ...], duration: ... } }
var currentBeatMap = null;   // 当前播放的歌的 beatMap
var beatMapNextIdx = 0;      // 下一个待触发的 kick index
var beatMapBusy = false;     // 正在分析中
var beatMapToken = 0;        // 取消旧分析
var beatAnalysisTimer = null;
var beatAnalysisStartedAt = 0;
var beatPrefetchTimer = null;
var beatPrefetchBusy = false;
var beatPrefetchToken = 0;
var beatPrefetchLastKey = '';
var BEAT_PREFETCH_LIMIT = 2;
var beatDiskCacheStatus = { checked:false, enabled:false, mode:'unknown', reason:'' };
var beatDiskCacheNoticeLogged = false;
var djBeatMapCache = {};
var currentDjBeatMap = null;
var djBeatMapNextIdx = 0;
var djBeatPulseNextIdx = 0;
var djBeatMapBusy = false;
var djBeatMapToken = 0;
var djBeatAnalysisTimer = null;
var beatAnalysisConfig = {
  delayMs: 1600,
  minPlaybackSec: 1.2,
  idleTimeout: 1400,
  skipMusicTempoWhilePlaying: false
};
var provisionalBeatChipTimer = null;
var beatAnalysisWatchdogTimer = null;
var provisionalBeatMapKey = '';
var BEAT_ANALYSIS_WEB_MAX_BYTES = 2621440;
var BEAT_ANALYSIS_WEB_TIMEOUT_MS = 90000;
var BEAT_ANALYSIS_WEB_MAX_SEC = 72;
var BEAT_ANALYSIS_WATCHDOG_MS = 120000;
var PROVISIONAL_BEAT_CHIP_MAX_MS = 12000;
var webPlaybackPerfTuned = false;
function applyWebPlaybackPerfTuning() {
  if (!mineradioUsesWebMediaBridge() || webPlaybackPerfTuned) return;
  webPlaybackPerfTuned = true;
  beatAnalysisConfig.delayMs = 9000;
  beatAnalysisConfig.minPlaybackSec = 12;
  beatAnalysisConfig.idleTimeout = 3200;
  beatAnalysisConfig.skipMusicTempoWhilePlaying = true;
  BEAT_PREFETCH_LIMIT = 0;
}
var beatCam = {
  nextIdx: 0,
  events: [],
  punch: 0,
  lookahead: 0.075,
  lastTriggerAt: -10,
  lastRealtimeAt: -10,
  minInterval: 0.500,
  fallbackMinInterval: 0.320,
  realtimeMinInterval: 0.460,
  realtimeMergeWindow: 0.135,
  attack: 0.028,
  hold: 0.030,
  release: 0.185,
  thetaKick: 0,
  phiKick: 0,
  radiusKick: 0,
  rollKick: 0,
  prevAudioTime: -1,
  stats: { map: 0, live: 0, merged: 0, liveBlocked: 0 }
};
var liveCamAvg = 0, liveCamPeak = 0.28, liveCamLastRaw = 0;
var cinemaDynamics = { avg: 0, lowAvg: 0, peak: 0.30, scale: 0.82 };
var cinemaTrackProfile = {
  scale: 1.0,
  target: 1.0,
  nameHint: 1.0,
  frames: 0,
  energyAvg: 0,
  lowAvg: 0,
  vocalAvg: 0,
  melodyAvg: 0,
  punchPeak: 0.10,
  density: 0
};
var rtBeat = {
  subFast: 0, subSlow: 0, lowFast: 0, lowSlow: 0,
  bodyFast: 0, bodySlow: 0, vocalFast: 0, vocalSlow: 0, snapFast: 0, snapSlow: 0,
  prevSub: 0, prevLow: 0, prevBody: 0, prevVocal: 0, prevSnap: 0, prevRms: 0,
  onsetAvg: 0.012, onsetPeak: 0.060,
  subPeak: 0.14, lowPeak: 0.18, bodyPeak: 0.16, vocalPeak: 0.16, snapPeak: 0.14,
  lastHitAt: -10,
  tempoGap: 0,
  tempoConfidence: 0,
  beatCount: 0,
  primedFrames: 0,
  warmupUntil: 0,
  pulse: 0,
  score: 0,
  stats: { hits: 0, blocked: 0, assisted: 0, strong: 0, rejected: 0 }
};
var djMode = {
  active: false,
  songKey: '',
  startedAt: 0,
  lastNoticeAt: -100000,
  tempoGap: 0,
  tempoConfidence: 0,
  sectionEnergy: 0,
  sectionLow: 0,
  sectionChange: 0,
  visualPulse: 0,
  lastBeatAt: -10
};

function isPodcastSong(song) {
  return !!(song && song.type === 'podcast');
}

function djSongKey(song) {
  if (!song) return '';
  if (song.localKey) return 'local:' + song.localKey;
  return 'podcast:' + (song.programId || song.id || song.name || '');
}

function resetDjModeMeter() {
  djMode.tempoGap = 0;
  djMode.tempoConfidence = 0;
  djMode.sectionEnergy = 0;
  djMode.sectionLow = 0;
  djMode.sectionChange = 0;
  djMode.visualPulse = 0;
  djMode.lastBeatAt = -10;
}

function resetDjBeatMapState() {
  currentDjBeatMap = null;
  djBeatMapNextIdx = 0;
  djBeatPulseNextIdx = 0;
}

function cancelDjBeatAnalysisTimer() {
  if (djBeatAnalysisTimer) {
    clearTimeout(djBeatAnalysisTimer);
    djBeatAnalysisTimer = null;
  }
}

function setDjModeActive(active, song) {
  active = !!active;
  var key = active ? djSongKey(song) : '';
  var changed = djMode.active !== active || djMode.songKey !== key;
  djMode.active = active;
  djMode.songKey = key;
  if (changed) {
    djMode.startedAt = performance.now();
    resetDjModeMeter();
  }
  if (active) {
    currentBeatMap = null;
    beatMapNextIdx = 0;
    cancelBeatAnalysisTimer();
    hideBeatChip();
  } else {
    djBeatMapToken++;
    cancelDjBeatAnalysisTimer();
    resetDjBeatMapState();
  }
}

function maybeAnnounceDjMode() {
  if (!djMode.active) return;
  var now = performance.now();
  if (now - djMode.lastNoticeAt > 8000) {
    djMode.lastNoticeAt = now;
    showToast('DJ Mode · 离线锁拍');
  }
}

// fx 状态: 预设 + 主滑块 + 开关 + 三态
var fxDefaults = {
  preset: 0,            // 0=emily cover, 1=tunnel, 2=orbit, 3=void, 4=vinyl, 5=wallpaper, 6=skull
  intensity: 0.85,
  cinemaShake: 0.5,
  depth: 1.0,
  coverResolution: 1.55,
  point: 1.0, speed: 1.0, twist: 0.0, color: 1.10, scatter: 0.0, bgFade: 0.20,
  bloomStrength: 0.62,
  lyricGlowStrength: 0.28,
  lyricScale: 1.0,
  lyricOffsetX: 0,
  lyricOffsetY: 0,
  lyricOffsetZ: 0,
  lyricTiltX: 0,
  lyricTiltY: 0,
  lyricColorMode: 'auto',
  lyricColor: '#a9b8c8',
  lyricHighlightMode: 'auto',
  lyricHighlightColor: '#fac900',
  lyricGlowLinked: true,
  lyricGlowColor: '#008aff',
  lyricFont: 'hei',
  lyricLetterSpacing: 0,
  lyricLineHeight: 1.0,
  lyricWeight: 900,
  visualTintMode: 'auto',
  visualTintColor: '#9db8cf',
  appTheme: 'default',
  uiAccentColor: '#ffffff',
  homeAccentMode: 'auto',
  homeAccentColor: '#ffffff',
  homeIconColor: '#ffffff',
  visualIconColor: '#ffffff',
  backgroundColorMode: 'cover',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  controlGlassChromaticOffset: 90,
  backgroundColorCustom: false,
  backgroundImage: '',
  backgroundMedia: null,
  desktopLyrics: false,
  desktopLyricsSize: 1.0,
  desktopLyricsOpacity: 0.92,
  desktopLyricsY: 0.76,
  desktopLyricsClickThrough: false,
  desktopLyricsCinema: true,
  desktopLyricsHighlight: false,
  desktopLyricsFps: 60,
  wallpaperMode: false,
  wallpaperOpacity: 1,
  floatLayer: false, cinema: true, edge: false, aiDepth: false, bloom: false, lyricGlow: true,
  lyricGlowBeat: true,
  lyricGlowParticles: false,
  lyricCameraLock: false,
  particleLyrics: true,    // v7.2: 粒子歌词
  backCover: false,        // 旧的封面背面粒子层关闭；浮空粒子层会跟随封面翻转
  shelf: 'side',
  shelfCameraMode: 'static',
  shelfPresence: 'always',
  shelfShowPodcasts: false,
  shelfMergeCollections: false,
  shelfSize: 1,
  shelfOffsetX: 0,
  shelfOffsetY: 0,
  shelfOffsetZ: 0,
  shelfAngleY: -15,
  shelfAngleYManual: false,
  shelfOpacity: 1,
  shelfBgOpacity: 0.90,
  shelfAccentColor: '#ffffff',
  performanceBackground: 'auto',
  performanceQuality: 'high',
  liveBackgroundKeep: false,
  cam: 'off',
  lyricBackgroundAdapt: 0.72,
  lyricDisplayMode: 'cinema',
  lyricTranslationMode: 'multi',
  lyricMotionStyle: 'float',
  lyricCustomLineCount: 10,
  lyricGlitchCameraBind: true,
  lyricGlitchIntensity: 1,
  lyricGlitchSlice: 1,
  lyricGlitchChroma: 1,
  lyricGlitchRate: 1,
  lyricGlitchJitter: 1,
  lyricContextOpacity: 0.72,
  lyricContextSpread: 1,
  lyricTranslationGap: 1,
  lyricEdgeFade: 0.55,
  lyricMotionSoftness: 0.72,
  lyricTranslationScale: 0.65,
  lyricTranslationOpacity: 0.86,
  sonicAudioMonitorEnabled: true,
  sonicAudioAutoTrack: true,
  sonicAudioSensitivity: 62,
  sonicAudioBandStart: 1,
  sonicAudioBandEnd: 4,
  sonicAudioThreshold: 42,
  sonicAudioPulse: 68,
  sonicGroundAmplitude: 50,
  sonicGroundMotionSpeed: 50,
  sonicGroundDensity: 46,
  sonicGroundRange: 82,
  sonicGroundLower: 68,
  sonicGroundDepth: 62,
  sonicGroundAutoRotate: 50,
  sonicGroundColorMode: 'cover',
  sonicGroundBaseColor: '#05070c',
  sonicGroundCoolColor: '#0066ff',
  sonicGroundWarmColor: '#ff3c19',
  sonicGroundAccentColor: '#33e6ff',
  sonicGroundGlow: 68,
  sonicGroundSubBass: 90,
  sonicGroundBass: 92,
  sonicGroundLowMid: 50,
  sonicGroundMid: 50,
  sonicGroundHighMid: 50,
  sonicGroundPresence: 50,
  sonicGroundBrilliance: 50,
  sonicGroundAir: 48,
  sonicGroundFloatingEnabled: true,
  sonicGroundFloatingIntensity: 55,
  sonicGroundFloatingMinSize: 9,
  sonicGroundFloatingMaxSize: 26,
  sonicGroundFloatingSpeed: 77,
  sonicGroundFloatingCount: 80,
};
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME = '默认测试';
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_EXPORTED_AT = 1782276031784;
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_SAVED_AT = 1782273019045;
var PACKAGED_DEFAULT_FX_SNAPSHOT = Object.freeze({
  visualPresetSchema: VISUAL_PRESET_SCHEMA,
  preset: 0,
  intensity: 0.85,
  cinemaShake: 0.5,
  depth: 1,
  coverResolution: 1.55,
  point: 1,
  speed: 1,
  twist: 0,
  color: 1.1,
  scatter: 0,
  bgFade: 0.2,
  bloomStrength: 0.62,
  lyricGlowStrength: 0.28,
  lyricScale: 1,
  lyricOffsetX: 0,
  lyricOffsetY: 0,
  lyricOffsetZ: 0,
  lyricTiltX: 0,
  lyricTiltY: 0,
  lyricCameraLock: false,
  lyricColorMode: 'auto',
  lyricColor: '#a9b8c8',
  lyricHighlightMode: 'auto',
  lyricHighlightColor: '#fac900',
  lyricGlowLinked: true,
  lyricGlowColor: '#008aff',
  lyricFont: 'hei',
  lyricLetterSpacing: 0,
  lyricLineHeight: 1,
  lyricWeight: 900,
  visualTintMode: 'auto',
  visualTintColor: '#9db8cf',
  appTheme: 'default',
  uiAccentColor: '#ffffff',
  homeAccentMode: 'auto',
  homeAccentColor: '#ffffff',
  homeIconColor: '#ffffff',
  visualIconColor: '#ffffff',
  backgroundColorMode: 'cover',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  controlGlassChromaticOffset: 90,
  backgroundColorCustom: false,
  floatLayer: false,
  cinema: true,
  edge: false,
  aiDepth: false,
  bloom: false,
  lyricGlow: true,
  lyricGlowBeat: true,
  lyricGlowParticles: false,
  desktopLyrics: false,
  desktopLyricsSize: 1,
  desktopLyricsOpacity: 0.92,
  desktopLyricsY: 0.76,
  desktopLyricsClickThrough: false,
  desktopLyricsCinema: true,
  desktopLyricsHighlight: false,
  desktopLyricsFps: 60,
  performanceBackground: 'auto',
  performanceQuality: 'high',
  liveBackgroundKeep: false,
  particleLyrics: true,
  backCover: false,
  shelf: 'side',
  shelfCameraMode: 'static',
  shelfPresence: 'always',
  shelfShowPodcasts: false,
  shelfMergeCollections: false,
  shelfSize: 1,
  shelfOffsetX: 0,
  shelfOffsetY: 0,
  shelfOffsetZ: 0,
  shelfAngleY: -15,
  shelfAngleYManual: false,
  shelfOpacity: 1,
  shelfBgOpacity: 0.9,
  shelfAccentColor: '#ffffff',
  cam: 'off'
});
function clonePackagedDefaultFxSnapshot() {
  return Object.assign({}, PACKAGED_DEFAULT_FX_SNAPSHOT);
}
function packagedDefaultLyricLayoutRaw() {
  return Object.assign({ desktopLyricsSchema: 'desktop-lyrics-v3' }, clonePackagedDefaultFxSnapshot());
}
var DEVELOPMENT_LOCKED_FX = {
  wallpaperMode: true
};
function isDevelopmentLockedFx(key) {
  return !!DEVELOPMENT_LOCKED_FX[key];
}
function normalizeDevelopmentLockedFxState() {
  if (!fx) return;
  fx.wallpaperMode = false;
}
function migrateVisualPresetIndex(p) {
  p = Number(p) || 0;
  var max = typeof presetMeta !== 'undefined' && presetMeta && presetMeta.length ? presetMeta.length - 1 : 7;
  return clampRange(p, 0, max);
}
function readSavedPlaybackVisualPreset() {
  try {
    var raw = JSON.parse(localStorage.getItem(LYRIC_LAYOUT_STORE_KEY) || '{}') || {};
    if (!Object.prototype.hasOwnProperty.call(raw, 'preset')) return fxDefaults.preset;
    var savedPreset = migrateVisualPresetIndex(raw.preset);
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) savedPreset = 5;
    return savedPreset;
  } catch (e) {
    return fxDefaults.preset;
  }
}
var playbackVisualPreset = readSavedPlaybackVisualPreset();
var startupVisualPreviewActive = false;
var fx = Object.assign({}, fxDefaults, readSavedLyricLayout());
normalizeDevelopmentLockedFxState();
if (window.MineradioThemes && typeof window.MineradioThemes.applyStructure === 'function') {
  window.MineradioThemes.applyStructure(fx.appTheme || window.MineradioThemes.readStored());
}
if ((fx && fx.preset === 7) || playbackVisualPreset === 7) {
  // ensureSonicTopography 在后续脚本里，这里不能直接调用，否则会中断本文件后面的首页逻辑
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof ensureSonicTopography === 'function') ensureSonicTopography();
  });
}
var presetTransition = { active:false, start:-10, duration:0.92, from:0, to:0 };
var controlsAutoHide = readBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, false);
var controlsHovering = false;
var controlsHideTimer = null;
var controlsHandleDimTimer = null;
var controlsLastMoveAt = 0;
var controlsShelfSuppressUntil = 0;
var cursorHideTimer = null;
var CURSOR_HIDE_DELAY = 2500;
var fxPanelPinned = readBooleanPreference(FX_PANEL_PIN_STORE_KEY, false);
var playlistPanelPinned = readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false);
var userCapsuleAutoHide = readBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, false);
var fxFabAutoHide = readBooleanPreference(FX_FAB_AUTO_HIDE_STORE_KEY, false);
var fxFabAutoHideRevealArmed = true;
function getHotkeyDefaults() {
  var defaults = { local: {}, global: {} };
  HOTKEY_ACTIONS.forEach(function(action){
    defaults.local[action.key] = action.local || '';
    defaults.global[action.key] = action.global || '';
  });
  return defaults;
}
function readHotkeySettings() {
  var defaults = getHotkeyDefaults();
  try {
    var raw = JSON.parse(localStorage.getItem(HOTKEY_SETTINGS_STORE_KEY) || '{}') || {};
    return {
      local: Object.assign({}, defaults.local, raw.local || {}),
      global: Object.assign({}, defaults.global, raw.global || {})
    };
  } catch (e) {
    return defaults;
  }
}

var hotkeySettings = readHotkeySettings();
var immersiveMode = false;
var immersiveState = {
  shelfMode: null,
  shelfPinnedOpen: false,
  lyrics: true,
  controlsAutoHide: true,
  bottomVisible: false
};

// 鼠标 / 摄像头视差
var pointerParallax = { x:0, y:0 };
var pointerTarget = { x:0, y:0 };
var headParallax = { x:0, y:0, active:false };
var headNeutral = null;

function pulseObjectValue(target, key, amount, duration) {
  if (!target) return;
  target[key] = Math.max(target[key] || 0, amount || 1);
  if (window.gsap) {
    window.gsap.killTweensOf(target, key);
    var vars = { duration: duration || 0.42, ease: 'power3.out' };
    vars[key] = 0;
    window.gsap.to(target, vars);
  } else {
    setTimeout(function(){ if (target) target[key] = 0; }, (duration || 0.42) * 1000);
  }
}

var desktopRuntimeState = {
  desktop: !!window.desktopWindow,
  minimized: false,
  visible: true,
  focused: true,
  fullscreen: false
};
var renderPowerState = { mode: '', width: 0, height: 0, pixelRatio: 0 };
var backgroundCacheTrimTimer = 0;
var runtimePerfState = {
  lastCacheTrimAt: 0,
  cacheTrimCount: 0,
  lastCacheTrimReason: '',
  lastHeapSampleAt: 0,
  heapMB: 0,
  cacheCounts: {}
};
function isDeepBackgroundMode() {
  if (isLiveBackgroundKeepMode()) return false;
  return !!(document.hidden || desktopRuntimeState.minimized || desktopRuntimeState.visible === false);
}
function homeVisualRenderTier() {
  if (!emptyHomeActive) return 0;
  if (!playing || currentIdx < 0) return 2;
  return 1;
}
function isHomeVisualIdleMode() {
  return homeVisualRenderTier() === 2;
}
function updateRenderPowerClasses() {
  document.body.classList.toggle('render-deep-sleep', isDeepBackgroundMode());
  document.body.classList.toggle('render-background-eco', isVisibleBackgroundMode());
  document.body.classList.toggle('render-home-idle', homeVisualRenderTier() > 0);
}
function currentPerformanceBackgroundMode() {
  return normalizePerformanceBackgroundMode(fx && fx.performanceBackground, fx && fx.liveBackgroundKeep === true);
}
function isLiveBackgroundKeepMode() {
  return currentPerformanceBackgroundMode() === 'keep';
}
function isBackgroundReleaseMode() {
  return currentPerformanceBackgroundMode() === 'release';
}
function isHiddenForBackgroundOptimization() {
  return !!(document.hidden && !isLiveBackgroundKeepMode());
}
function isVisibleBackgroundMode() {
  return false;
}
function safeObjectKeys(obj) {
  try { return obj ? Object.keys(obj) : []; } catch (e) { return []; }
}
function markProtectedKey(map, key) {
  if (key) map[String(key)] = true;
}
function collectProtectedCoverUrls() {
  var keep = Object.create(null);
  function mark(url) { if (url) keep[String(url)] = true; }
  try {
    var song = (typeof currentCoverSong === 'function') ? currentCoverSong() : (playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null);
    if (song) {
      mark(song.cover);
      if (typeof songCoverSrc === 'function') {
        mark(songCoverSrc(song, 60));
        mark(songCoverSrc(song, 360));
        mark(songCoverSrc(song, 400));
      }
    }
    if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) mark(currentCoverSource.src);
    if (typeof playlistPanelDetailState !== 'undefined' && playlistPanelDetailState && playlistPanelDetailState.playlist) {
      var cover = playlistPanelDetailState.playlist.cover;
      mark(cover);
      if (typeof coverUrlWithSize === 'function') {
        mark(coverUrlWithSize(cover, 88));
        mark(coverUrlWithSize(cover, 96));
      }
    }
    if (shelfManager && shelfManager.getCards) {
      shelfManager.getCards().forEach(function(card){
        if (card && card.item) mark(card.item.cover);
      });
    }
  } catch (e) {}
  return keep;
}
function collectProtectedBeatMapKeys() {
  var keep = Object.create(null);
  try {
    if (typeof beatMapSongKey === 'function' && playQueue && playQueue.length) {
      var start = Math.max(0, currentIdx - 5);
      var end = Math.min(playQueue.length - 1, currentIdx + 5);
      for (var i = start; i <= end; i++) markProtectedKey(keep, beatMapSongKey(playQueue[i]));
    }
    if (typeof beatPrefetchLastKey !== 'undefined') markProtectedKey(keep, beatPrefetchLastKey);
    if (typeof djMode !== 'undefined' && djMode && djMode.songKey) markProtectedKey(keep, djMode.songKey);
    if (typeof localBeatAnalysis !== 'undefined' && localBeatAnalysis && localBeatAnalysis.song && typeof beatMapSongKey === 'function') {
      markProtectedKey(keep, beatMapSongKey(localBeatAnalysis.song));
    }
  } catch (e) {}
  return keep;
}
function collectProtectedCoverDepthIds() {
  var keep = Object.create(null);
  try {
    if (typeof coverDepthCacheId !== 'function') return keep;
    var candidates = [];
    if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) candidates.push(currentCoverSource.src);
    var song = (typeof currentCoverSong === 'function') ? currentCoverSong() : null;
    if (song && typeof songCoverSrc === 'function') {
      candidates.push(songCoverSrc(song, 360));
      candidates.push(songCoverSrc(song, 400));
    }
    var texImg = (typeof coverTex !== 'undefined' && coverTex && coverTex.image) ? coverTex.image : null;
    var w = texImg && texImg.width ? texImg.width : 0;
    var h = texImg && texImg.height ? texImg.height : 0;
    candidates.forEach(function(src){
      if (src) markProtectedKey(keep, coverDepthCacheId(src + '|tex=' + w + 'x' + h));
    });
  } catch (e) {}
  return keep;
}
function trimObjectCache(cache, keep, protectedKeys, skipRecord) {
  var keys = safeObjectKeys(cache);
  if (!cache || keys.length <= keep) return 0;
  var drop = keys.length - keep;
  var dropped = 0;
  for (var i = 0; i < keys.length && drop > 0; i++) {
    var key = keys[i];
    if (protectedKeys && protectedKeys[key]) continue;
    var rec = cache[key];
    if (skipRecord && skipRecord(rec, key)) continue;
    delete cache[key];
    drop--;
    dropped++;
  }
  return dropped;
}
function trimCoverDepthCache(keep, protectedKeys) {
  if (!coverDepthCache || !coverDepthCacheKeys) return 0;
  var keys = coverDepthCacheKeys.filter(function(key){ return !!coverDepthCache[key]; });
  if (keys.length <= keep) {
    coverDepthCacheKeys = keys;
    return 0;
  }
  var keepSet = Object.create(null);
  var count = 0;
  for (var i = keys.length - 1; i >= 0 && count < keep; i--) {
    keepSet[keys[i]] = true;
    count++;
  }
  Object.keys(protectedKeys || {}).forEach(function(key){ keepSet[key] = true; });
  var dropped = 0;
  keys.forEach(function(key){
    if (keepSet[key]) return;
    delete coverDepthCache[key];
    dropped++;
  });
  coverDepthCacheKeys = keys.filter(function(key){ return !!coverDepthCache[key]; });
  return dropped;
}
function collectRuntimePerfSnapshot(now) {
  now = now || performance.now();
  runtimePerfState.cacheCounts = {
    playlistCovers: safeObjectKeys(playlistCoverCache).length,
    coverDepth: coverDepthCacheKeys ? coverDepthCacheKeys.length : 0,
    beatMaps: safeObjectKeys(beatMapCache).length,
    djBeatMaps: safeObjectKeys(djBeatMapCache).length
  };
  if (performance && performance.memory && now - runtimePerfState.lastHeapSampleAt > 12000) {
    runtimePerfState.lastHeapSampleAt = now;
    runtimePerfState.heapMB = Math.round((performance.memory.usedJSHeapSize || 0) / 1048576);
  }
  return {
    render: (typeof renderPerfState !== 'undefined') ? {
      mode: renderPerfState.mode,
      fps: renderPerfState.fps,
      skipped: renderPerfState.skipped,
      longFrames: renderPerfState.longFrames
    } : null,
    runtime: runtimePerfState,
    renderer: (typeof renderer !== 'undefined' && renderer && renderer.info) ? {
      geometries: renderer.info.memory && renderer.info.memory.geometries,
      textures: renderer.info.memory && renderer.info.memory.textures,
      calls: renderer.info.render && renderer.info.render.calls,
      triangles: renderer.info.render && renderer.info.render.triangles
    } : null,
    viewport: (typeof renderer !== 'undefined' && renderer && renderer.domElement) ? {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      renderPixelRatio: renderer.getPixelRatio ? Number(renderer.getPixelRatio().toFixed(3)) : 0,
      canvasWidth: renderer.domElement.width || 0,
      canvasHeight: renderer.domElement.height || 0,
      renderPixels: (renderer.domElement.width || 0) * (renderer.domElement.height || 0),
      targetFps: (typeof getAdaptiveRenderFps === 'function') ? getAdaptiveRenderFps() : 0,
      interactionBoost: (typeof isRenderInteractionActive === 'function') ? isRenderInteractionActive() : false,
      interactionReason: (typeof renderInteractionReason !== 'undefined') ? renderInteractionReason : ''
    } : null,
    deepSleep: isDeepBackgroundMode()
  };
}
window.__mineradioPerfSnapshot = collectRuntimePerfSnapshot;
function trimRuntimeCaches(reason, aggressive) {
  var protectedCovers = collectProtectedCoverUrls();
  var protectedBeats = collectProtectedBeatMapKeys();
  var dropped = 0;
  dropped += trimObjectCache(playlistCoverCache, aggressive ? 72 : 180, protectedCovers, function(rec){
    return rec && rec.loading;
  });
  dropped += trimCoverDepthCache(aggressive ? 4 : 10, collectProtectedCoverDepthIds());
  dropped += trimObjectCache(beatMapCache, aggressive ? 12 : 36, protectedBeats);
  dropped += trimObjectCache(djBeatMapCache, aggressive ? 4 : 12, protectedBeats);
  if (aggressive && typeof renderer !== 'undefined' && renderer && renderer.renderLists && renderer.renderLists.dispose) {
    try { renderer.renderLists.dispose(); } catch (e) {}
  }
  runtimePerfState.lastCacheTrimAt = performance.now();
  runtimePerfState.cacheTrimCount += 1;
  runtimePerfState.lastCacheTrimReason = reason || (aggressive ? 'deep' : 'active');
  collectRuntimePerfSnapshot(runtimePerfState.lastCacheTrimAt);
  return dropped;
}
function trimVisualCachesForBackground() {
  if (!isDeepBackgroundMode()) return;
  trimRuntimeCaches('deep-background', true);
}
function scheduleBackgroundCacheTrim() {
  if (!isDeepBackgroundMode()) return;
  if (backgroundCacheTrimTimer) clearTimeout(backgroundCacheTrimTimer);
  backgroundCacheTrimTimer = setTimeout(function(){
    backgroundCacheTrimTimer = 0;
    trimVisualCachesForBackground();
  }, 900);
}
function maybeTrimRuntimeCaches(now) {
  now = now || performance.now();
  var deep = isDeepBackgroundMode();
  var gap = deep ? (isBackgroundReleaseMode() ? 3600 : 7000) : 45000;
  if (!deep && now < 30000) return;
  if (now - runtimePerfState.lastCacheTrimAt < gap) return;
  trimRuntimeCaches(deep ? (isBackgroundReleaseMode() ? 'release-frame' : 'deep-frame') : 'active-frame', deep);
}
function applyRendererPowerMode() {
  if (typeof renderer === 'undefined' || !renderer) return;
  var deep = isDeepBackgroundMode();
  var width = deep ? 4 : Math.max(1, innerWidth);
  var height = deep ? 4 : Math.max(1, innerHeight);
  var pixelRatio = getRenderPixelRatio();
  var mode = deep ? 'sleep' : 'active';
  if (renderPowerState.mode === mode && renderPowerState.width === width && renderPowerState.height === height && Math.abs(renderPowerState.pixelRatio - pixelRatio) < 0.001) return;
  renderPowerState = { mode: mode, width: width, height: height, pixelRatio: pixelRatio };
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  if (typeof uniforms !== 'undefined' && uniforms && uniforms.uPixel) uniforms.uPixel.value = renderer.getPixelRatio();
  if (deep) {
    if (renderer.renderLists && renderer.renderLists.dispose) renderer.renderLists.dispose();
    scheduleBackgroundCacheTrim();
  }
}
function updateDesktopRuntimeState(state) {
  state = state || {};
  var wasFullscreen = desktopRuntimeState.fullscreen;
  var wasDeep = isDeepBackgroundMode();
  desktopRuntimeState.desktop = !!window.desktopWindow;
  desktopRuntimeState.minimized = !!state.isMinimized;
  desktopRuntimeState.visible = state.isVisible !== false;
  desktopRuntimeState.focused = state.isFocused !== false;
  desktopRuntimeState.fullscreen = !!(state.isFullScreen || state.isNativeFullScreen || state.isHtmlFullScreen || state.isWindowFullScreen);
  updateRenderPowerClasses();
  applyRendererPowerMode();
  if (fx && (fx.desktopLyrics || fx.wallpaperMode)) setTimeout(syncDesktopOverlayState, 0);
  if (wasDeep && !isDeepBackgroundMode()) recoverVisualsAfterBackground('desktop-runtime-state');
  if (desktopRuntimeState.fullscreen !== wasFullscreen) scheduleMainRendererViewportRefresh('desktop-runtime-state');
}
function installRenderPowerHooks() {
  updateRenderPowerClasses();
  document.addEventListener('visibilitychange', function(){
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (!isDeepBackgroundMode()) recoverVisualsAfterBackground('visibilitychange');
  });
  window.addEventListener('focus', function(){
    desktopRuntimeState.focused = true;
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (!isDeepBackgroundMode()) recoverVisualsAfterBackground('focus');
  });
  window.addEventListener('blur', function(){
    desktopRuntimeState.focused = false;
    updateRenderPowerClasses();
    applyRendererPowerMode();
  });
  if (window.desktopWindow && typeof window.desktopWindow.onStateChange === 'function') {
    window.desktopWindow.onStateChange(updateDesktopRuntimeState);
    if (typeof window.desktopWindow.getState === 'function') {
      window.desktopWindow.getState().then(updateDesktopRuntimeState).catch(function(){});
    }
  }
}

// ============================================================
//  Three.js 场景
// ============================================================
var scene = new THREE.Scene();
scene.background = null;
var camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
var RENDER_DPR_CAP = 1.35;
var RENDER_PIXEL_BUDGET = 5200000;
var RENDER_MIN_DPR = 0.72;
// 0 = display vsync. Keep visible playback high-refresh capable instead of capping 120Hz+ screens to 60/72.
var RENDER_VISIBLE_VSYNC = true;
var RENDER_ACTIVE_FPS = 0;
var RENDER_LARGE_FPS = 0;
var RENDER_HUGE_FPS = 0;
var RENDER_INTERACTION_FPS = 0;
var RENDER_INTERACTION_LARGE_FPS = 0;
var RENDER_INTERACTION_HUGE_FPS = 0;
var RENDER_INTERACTION_HOLD_MS = 900;
var renderInteractionBoostUntil = 0;
var renderInteractionReason = '';
function renderQualityProfile() {
  var quality = normalizePerformanceQuality(fx && fx.performanceQuality);
  if (quality === 'eco') return { cap: 0.95, min: 0.56, budget: 2400000 };
  if (quality === 'balanced') return { cap: 1.12, min: 0.66, budget: 3800000 };
  if (quality === 'ultra') return { cap: 1.75, min: 0.85, budget: 7800000 };
  return { cap: RENDER_DPR_CAP, min: RENDER_MIN_DPR, budget: RENDER_PIXEL_BUDGET };
}
function getRenderPixelRatio() {
  var device = window.devicePixelRatio || 1;
  if (isDeepBackgroundMode()) return Math.min(device, 0.30);
  var homeTier = homeVisualRenderTier();
  var cssPixels = Math.max(1, innerWidth * innerHeight);
  var quality = renderQualityProfile();
  var budgetCap = Math.sqrt(quality.budget / cssPixels);
  var cap = Math.min(quality.cap, budgetCap);
  if (homeTier === 2) cap = Math.min(cap, 0.82);
  else if (homeTier === 1) cap = Math.min(cap, 1.0);
  return Math.max(quality.min, Math.min(device, cap));
}
function getRenderPixelLoad() {
  var ratio = getRenderPixelRatio();
  return Math.max(1, innerWidth * innerHeight) * ratio * ratio;
}
function markRenderInteraction(reason, holdMs) {
  if (isDeepBackgroundMode()) return;
  var now = performance.now();
  renderInteractionBoostUntil = Math.max(renderInteractionBoostUntil, now + (holdMs || RENDER_INTERACTION_HOLD_MS));
  renderInteractionReason = reason || renderInteractionReason || 'interaction';
  if (typeof renderPerfState !== 'undefined' && renderPerfState) renderPerfState.lastRenderAt = 0;
}
function isRenderInteractionActive(now) {
  return (now || performance.now()) < renderInteractionBoostUntil;
}
function getRenderLoadTier() {
  var cssPixels = Math.max(1, innerWidth * innerHeight);
  var renderPixels = (typeof getRenderPixelLoad === 'function') ? getRenderPixelLoad() : cssPixels;
  if (cssPixels >= 7200000 || renderPixels >= 5000000) return 2;
  if (cssPixels >= 3200000 || renderPixels >= 3600000) return 1;
  return 0;
}
var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(getRenderPixelRatio());
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.style.background = 'transparent';
renderer.domElement.style.display = 'block';
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.domElement.tabIndex = 0;
document.getElementById('canvas-container').appendChild(renderer.domElement);

// ============================================================
//  相机系统 v7.1 — 分离 user offset / cinema offset
//   - userOrbit: 用户拖拽的目标 (永久保留, 不会被电影模式覆盖)
//   - cinemaOffset: 电影模式的微偏移 (始终叠加, 即使用户在拖)
//   - 最终 theta = userOrbit.theta + cinemaOffset.theta
//   - 回正按钮 / 双击屏幕: 让 userOrbit 缓慢归零
// ============================================================
var orbit = {
  userTheta: 0.0, userPhi: 0.08, userRadius: 6.6,
  cineTheta: 0.0, cinePhi: 0.0, cineRadius: 0.0,
  theta: 0.0, phi: 0.08, radius: 6.6,
  minPhi: -Math.PI*0.45, maxPhi: Math.PI*0.45,
  minRadius: 2.4, maxRadius: 14.0,
  baselineTheta: 0.0, baselinePhi: 0.08, baselineRadius: 6.6,
  rotating: false, last:{x:0,y:0},
  recentering: false,
  centerLocked: false,
  // v8: 镜头跟拍 (hover shelf / queue 时)
  lookAt: new THREE.Vector3(0,0,0),
  focus: {
    active: false,
    type: null,        // 'shelf-side' | 'shelf-stage' | 'queue'
    theta: 0.0, phi: 0.08, radius: 6.6,
    lookAt: new THREE.Vector3(0,0,0),
  },
  glowFollowX: 0,
  glowFollowY: 0,
  glowFollowRoll: 0,
  beatGlow: 0,
};
var ZERO_VEC = new THREE.Vector3(0,0,0);
var BASE_FOV = 45;
var camPunch = 0;
var cinemaT = 0;
function defaultFreeCameraState() {
  return {
    active: false,
    locked: false,
    position: new THREE.Vector3(0, 0, 6.6),
    yaw: 0,
    pitch: 0,
    roll: 0,
    fov: BASE_FOV,
    velocity: new THREE.Vector3(),
    keys: {},
    resetTween: null
  };
}
function readFreeCameraState() {
  var state = defaultFreeCameraState();
  try {
    var raw = JSON.parse(localStorage.getItem(FREE_CAMERA_STORE_KEY) || '{}') || {};
    if (raw.position) {
      state.position.set(
        clampRange(Number(raw.position.x) || 0, -80, 80),
        clampRange(Number(raw.position.y) || 0, -80, 80),
        clampRange(Number(raw.position.z) || 6.6, -80, 80)
      );
    }
    state.yaw = clampRange(Number(raw.yaw) || 0, -Math.PI * 8, Math.PI * 8);
    state.pitch = clampRange(Number(raw.pitch) || 0, -Math.PI * 0.49, Math.PI * 0.49);
    state.roll = clampRange(Number(raw.roll) || 0, -Math.PI, Math.PI);
    state.fov = clampRange(Number(raw.fov) || BASE_FOV, 26, 72);
    state.locked = !!(raw.locked || raw.active);
    state.active = false;
  } catch (e) {}
  return state;
}
var freeCamera = readFreeCameraState();
var FREE_CAMERA_MOVE = new THREE.Vector3();
var FREE_CAMERA_TARGET_VEL = new THREE.Vector3();
var FREE_CAMERA_SHAKE_DIR = new THREE.Vector3();
var FREE_CAMERA_EULER = new THREE.Euler(0, 0, 0, 'YXZ');
var FREE_CAMERA_RESET_MAT = new THREE.Matrix4();
var FREE_CAMERA_RESET_QUAT = new THREE.Quaternion();
var FREE_CAMERA_UP = new THREE.Vector3(0, 1, 0);
var freeCameraPointer = { seen: false, x: 0, y: 0 };
var freeCameraDeferredSaveTimer = 0;
function saveFreeCameraState() {
  if (!freeCamera) return;
  try {
    localStorage.setItem(FREE_CAMERA_STORE_KEY, JSON.stringify({
      locked: !!freeCamera.locked,
      active: !!freeCamera.active,
      position: { x: freeCamera.position.x, y: freeCamera.position.y, z: freeCamera.position.z },
      yaw: freeCamera.yaw,
      pitch: freeCamera.pitch,
      roll: freeCamera.roll,
      fov: freeCamera.fov
    }));
  } catch (e) {}
}
function scheduleFreeCameraStateSave(delay) {
  if (freeCameraDeferredSaveTimer) return;
  freeCameraDeferredSaveTimer = setTimeout(function(){
    freeCameraDeferredSaveTimer = 0;
    saveFreeCameraState();
  }, delay || 720);
}
function easeOutCubic01(t) {
  t = clamp01(t);
  return 1 - Math.pow(1 - t, 3);
}
function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
function getDefaultFreeCameraResetPose() {
  var pose = {
    position: new THREE.Vector3(0, 0, 6.6),
    yaw: 0,
    pitch: 0,
    roll: 0,
    fov: BASE_FOV
  };
  if (typeof SKULL_PRESET_INDEX !== 'undefined' && fx && fx.preset === SKULL_PRESET_INDEX && typeof setSkullCameraTargetVectors === 'function') {
    var look = new THREE.Vector3();
    var shelfComposition = typeof isSkullShelfCompositionActive === 'function' && isSkullShelfCompositionActive();
    setSkullCameraTargetVectors(pose.position, look, innerHeight > innerWidth * 1.08, shelfComposition, 0);
    FREE_CAMERA_RESET_MAT.lookAt(pose.position, look, FREE_CAMERA_UP);
    FREE_CAMERA_RESET_QUAT.setFromRotationMatrix(FREE_CAMERA_RESET_MAT);
    FREE_CAMERA_EULER.setFromQuaternion(FREE_CAMERA_RESET_QUAT, 'YXZ');
    pose.pitch = FREE_CAMERA_EULER.x;
    pose.yaw = FREE_CAMERA_EULER.y;
    pose.roll = FREE_CAMERA_EULER.z;
  }
  return pose;
}
function captureFreeCameraFromCurrent() {
  if (!freeCamera) freeCamera = defaultFreeCameraState();
  camera.updateMatrixWorld(true);
  freeCamera.position.copy(camera.position);
  FREE_CAMERA_EULER.setFromQuaternion(camera.quaternion, 'YXZ');
  freeCamera.pitch = FREE_CAMERA_EULER.x;
  freeCamera.yaw = FREE_CAMERA_EULER.y;
  freeCamera.roll = FREE_CAMERA_EULER.z;
  freeCamera.fov = clampRange(camera.fov || BASE_FOV, 26, 72);
}
function applyFreeCameraToCamera() {
  if (!freeCamera || !(freeCamera.active || freeCamera.locked)) return false;
  var cameraShake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  camera.position.copy(freeCamera.position);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(
    freeCamera.pitch + beatCam.phiKick * cameraShake * 0.45,
    freeCamera.yaw + beatCam.thetaKick * cameraShake * 0.45,
    freeCamera.roll + beatCam.rollKick * cameraShake
  );
  if (cameraShake > 0 && Math.abs(beatCam.radiusKick) > 0.0001) {
    FREE_CAMERA_SHAKE_DIR.set(0, 0, -1).applyEuler(camera.rotation);
    camera.position.addScaledVector(FREE_CAMERA_SHAKE_DIR, beatCam.radiusKick * cameraShake * 0.52);
  }
  var cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
  var targetFov = clampRange(freeCamera.fov || BASE_FOV, 26, 72) - cameraPunch * 1.75;
  camera.fov += (targetFov - camera.fov) * (targetFov < camera.fov ? 0.24 : 0.12);
  camera.updateProjectionMatrix();
  camPunch *= 0.86;
  return true;
}
var FREE_CAMERA_HINT_HTML = '<b>自由镜头</b> R 固定/退出 · WASD 移动 · 鼠标转向 · Shift 加速 · Space/Ctrl 升降 · Q/E 轻微旋转 · 滚轮景深 · K 回正';
function ensureFreeCameraHintContent() {
  var el = document.getElementById('free-camera-hint');
  if (!el || el.dataset.ready === '1') return;
  el.innerHTML = FREE_CAMERA_HINT_HTML;
  el.dataset.ready = '1';
}
function updateFreeCameraHint() {
  var el = document.getElementById('free-camera-hint');
  if (el) {
    if (freeCamera && freeCamera.active) ensureFreeCameraHintContent();
    el.classList.toggle('show', !!(freeCamera && freeCamera.active));
  }
}
function resetFreeCameraToDefault() {
  if (!freeCamera) return;
  if (freeCameraDeferredSaveTimer) {
    clearTimeout(freeCameraDeferredSaveTimer);
    freeCameraDeferredSaveTimer = 0;
  }
  var fromPos = freeCamera.position ? freeCamera.position.clone() : new THREE.Vector3(0, 0, 6.6);
  var resetPose = getDefaultFreeCameraResetPose();
  freeCamera.resetTween = {
    start: performance.now(),
    duration: 620,
    from: {
      position: fromPos,
      yaw: Number(freeCamera.yaw) || 0,
      pitch: Number(freeCamera.pitch) || 0,
      roll: Number(freeCamera.roll) || 0,
      fov: Number(freeCamera.fov) || BASE_FOV
    },
    to: {
      position: resetPose.position,
      yaw: resetPose.yaw,
      pitch: resetPose.pitch,
      roll: resetPose.roll,
      fov: resetPose.fov
    }
  };
  freeCamera.active = false;
  freeCamera.locked = true;
  freeCamera.keys = {};
  if (freeCamera.velocity) freeCamera.velocity.set(0, 0, 0);
  try { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); } catch (e) {}
  updateFreeCameraHint();
  showToast('自由镜头正在平滑回正');
}
function toggleFreeCamera() {
  if (!freeCamera) freeCamera = defaultFreeCameraState();
  if (freeCamera.active) {
    freeCamera.active = false;
    freeCamera.locked = true;
    freeCamera.keys = {};
    if (freeCamera.velocity) freeCamera.velocity.set(0, 0, 0);
    try { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); } catch (e) {}
    saveFreeCameraState();
    updateFreeCameraHint();
    showToast('自由镜头已固定');
    return;
  }
  captureFreeCameraFromCurrent();
  freeCamera.active = true;
  freeCamera.locked = true;
  freeCamera.resetTween = null;
  freeCamera.keys = {};
  freeCameraPointer.seen = false;
  if (!freeCamera.velocity) freeCamera.velocity = new THREE.Vector3();
  try { renderer.domElement.focus && renderer.domElement.focus({ preventScroll: true }); } catch (e) {
    try { renderer.domElement.focus && renderer.domElement.focus(); } catch (ignore) {}
  }
  saveFreeCameraState();
  updateFreeCameraHint();
  try {
    var lockResult = renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
    if (lockResult && lockResult.catch) lockResult.catch(function(){ freeCameraPointer.seen = false; });
  } catch (e) {
    freeCameraPointer.seen = false;
  }
  showToast('自由镜头: WASD 移动 · 鼠标转向 · K 回正');
}
function updateFreeCamera(dt) {
  if (!freeCamera) return;
  if (freeCamera.resetTween) {
    var tw = freeCamera.resetTween;
    var t = easeOutCubic01((performance.now() - tw.start) / Math.max(1, tw.duration || 620));
    freeCamera.position.copy(tw.from.position).lerp(tw.to.position, t);
    freeCamera.yaw = tw.from.yaw + shortestAngleDelta(tw.from.yaw, tw.to.yaw) * t;
    freeCamera.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * t;
    freeCamera.roll = tw.from.roll + shortestAngleDelta(tw.from.roll, tw.to.roll) * t;
    freeCamera.fov = tw.from.fov + (tw.to.fov - tw.from.fov) * t;
    if (t >= 0.999) {
      freeCamera.position.copy(tw.to.position);
      freeCamera.yaw = tw.to.yaw;
      freeCamera.pitch = tw.to.pitch;
      freeCamera.roll = tw.to.roll;
      freeCamera.fov = tw.to.fov;
      freeCamera.resetTween = null;
      freeCamera.active = false;
      freeCamera.locked = false;
      saveFreeCameraState();
      updateFreeCameraHint();
      recenterCamera();
      showToast('自由镜头已回正');
    }
    return;
  }
  if (!freeCamera.active) return;
  var keys = freeCamera.keys || {};
  FREE_CAMERA_MOVE.set(0, 0, 0);
  if (keys.KeyW) FREE_CAMERA_MOVE.z -= 1;
  if (keys.KeyS) FREE_CAMERA_MOVE.z += 1;
  if (keys.KeyA) FREE_CAMERA_MOVE.x -= 1;
  if (keys.KeyD) FREE_CAMERA_MOVE.x += 1;
  if (keys.Space) FREE_CAMERA_MOVE.y += 1;
  if (keys.ControlLeft || keys.ControlRight) FREE_CAMERA_MOVE.y -= 1;
  if (!freeCamera.velocity) freeCamera.velocity = new THREE.Vector3();
  var targetVel = FREE_CAMERA_TARGET_VEL.set(0, 0, 0);
  if (FREE_CAMERA_MOVE.lengthSq() > 0) {
    FREE_CAMERA_MOVE.normalize();
    FREE_CAMERA_EULER.set(freeCamera.pitch, freeCamera.yaw, 0, 'YXZ');
    FREE_CAMERA_MOVE.applyEuler(FREE_CAMERA_EULER);
    var speed = (keys.ShiftLeft || keys.ShiftRight ? 6.2 : 2.35);
    targetVel.copy(FREE_CAMERA_MOVE).multiplyScalar(speed);
  }
  var ease = targetVel.lengthSq() > 0 ? 8.2 : 13.5;
  freeCamera.velocity.lerp(targetVel, clampRange(ease * Math.max(0.001, dt || 1 / 60), 0, 1));
  if (freeCamera.velocity.lengthSq() < 0.0004) freeCamera.velocity.set(0, 0, 0);
  freeCamera.position.addScaledVector(freeCamera.velocity, Math.max(0.001, dt || 1 / 60));
  var rollDir = (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0);
  if (rollDir) freeCamera.roll = clampRange(freeCamera.roll + rollDir * dt * 0.9, -Math.PI, Math.PI);
  scheduleFreeCameraStateSave(720);
}
function flushPersistentVisualState() {
  try { saveLyricLayout({ immediate: true }); } catch (e) {}
  try { saveFreeCameraState(); } catch (e) {}
  try { persistAccountPreferences(); } catch (e) {}
  try {
    if (window.MineradioThemes && typeof window.MineradioThemes.applyStructure === 'function' && fx && fx.appTheme) {
      window.MineradioThemes.applyStructure(fx.appTheme);
    }
  } catch (e) {}
}
window.addEventListener('beforeunload', flushPersistentVisualState);
window.addEventListener('pagehide', flushPersistentVisualState);
document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'hidden') flushPersistentVisualState();
});

function resetBeatCameraSync(t) {
  beatCam.nextIdx = 0;
  beatCam.events.length = 0;
  beatCam.punch = 0;
  beatCam.lastTriggerAt = -10;
  beatCam.lastRealtimeAt = -10;
  beatCam.thetaKick = 0;
  beatCam.phiKick = 0;
  beatCam.radiusKick = 0;
  beatCam.rollKick = 0;
  beatCam.prevAudioTime = isFinite(t) ? t : -1;
  camPunch = 0;
  beatCam.stats.map = 0;
  beatCam.stats.live = 0;
  beatCam.stats.merged = 0;
  beatCam.stats.liveBlocked = 0;
  liveCamAvg = 0;
  liveCamPeak = 0.28;
  liveCamLastRaw = 0;
  resetRealtimeBeatEngine();
}

function syncBeatCameraToTime(t) {
  resetBeatCameraSync(t);
  if (!currentBeatMap) return;
  alignBeatCameraCursorToTime(t);
}

function alignBeatCameraCursorToTime(t) {
  if (!currentBeatMap) return;
  var beats = currentBeatMap.cameraBeats || currentBeatMap.beats || currentBeatMap.kicks || [];
  beatCam.nextIdx = 0;
  while (beatCam.nextIdx < beats.length) {
    var bt = typeof beats[beatCam.nextIdx] === 'number' ? beats[beatCam.nextIdx] : beats[beatCam.nextIdx].time;
    if (bt >= t + beatCam.lookahead) break;
    beatCam.nextIdx++;
  }
}

function easeBeatCamera(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

function updateCinemaDynamics(rawEnergy, rawLow) {
  var e = clamp01(rawEnergy || 0);
  var l = clamp01(rawLow || 0);
  var isDj = djMode.active;
  var composite = clamp01(e * (isDj ? 0.52 : 0.62) + l * (isDj ? 0.48 : 0.38));
  if (isDj) {
    var prevEnergy = djMode.sectionEnergy || 0;
    var prevLow = djMode.sectionLow || 0;
    djMode.sectionEnergy += (e - djMode.sectionEnergy) * (e > djMode.sectionEnergy ? 0.030 : 0.010);
    djMode.sectionLow += (l - djMode.sectionLow) * (l > djMode.sectionLow ? 0.036 : 0.012);
    var change = Math.abs(e - prevEnergy) * 0.46 + Math.abs(l - prevLow) * 0.62;
    djMode.sectionChange += (change - djMode.sectionChange) * (change > djMode.sectionChange ? 0.055 : 0.018);
    djMode.visualPulse *= Math.pow(0.30, 1 / 60);
  }
  cinemaDynamics.avg += (composite - cinemaDynamics.avg) * (composite > cinemaDynamics.avg ? (isDj ? 0.018 : 0.010) : (isDj ? 0.006 : 0.004));
  cinemaDynamics.lowAvg += (l - cinemaDynamics.lowAvg) * (l > cinemaDynamics.lowAvg ? (isDj ? 0.022 : 0.012) : (isDj ? 0.007 : 0.005));
  cinemaDynamics.peak = Math.max(isDj ? 0.36 : 0.30, cinemaDynamics.peak * (isDj ? 0.9980 : 0.9988), composite);
  var floor = Math.max(0.10, cinemaDynamics.avg * 0.82);
  var span = Math.max(0.18, cinemaDynamics.peak - floor);
  var lift = clamp01((composite - floor) / span);
  lift = lift * lift * (3 - 2 * lift);
  var target = isDj
    ? 0.50 + lift * 0.66 + clamp01((l - cinemaDynamics.lowAvg) / 0.30) * 0.18 + clamp01(djMode.sectionChange * 2.4) * 0.08
    : 0.42 + lift * 0.56 + clamp01((l - cinemaDynamics.lowAvg) / 0.36) * 0.12;
  if (cinemaDynamics.avg < 0.18 && l < 0.32) target *= isDj ? 0.88 : 0.78;
  if (e > 0.48 && l > 0.46) target = Math.max(target, isDj ? 1.02 : 0.92);
  target = clampRange(target, isDj ? 0.42 : 0.34, isDj ? 1.24 : 1.08);
  cinemaDynamics.scale += (target - cinemaDynamics.scale) * (target > cinemaDynamics.scale ? (isDj ? 0.070 : 0.045) : (isDj ? 0.030 : 0.022));
}

function cameraDynamicsScale(extra) {
  var isDj = djMode.active;
  var djBoost = isDj ? (1.06 + clamp01(djMode.sectionLow) * 0.16 + clamp01(rtBeat.tempoConfidence) * 0.08) : 1;
  return clampRange((cinemaDynamics.scale || 0.82) * (cinemaTrackProfile.scale || 1) * (extra == null ? 1 : extra) * djBoost, isDj ? 0.24 : 0.18, isDj ? 1.42 : 1.18);
}

function cinemaTrackNameHint(song) {
  var label = ((song && song.name) || '') + ' ' + ((song && song.artist) || '');
  label = label.toLowerCase().replace(/\s+/g, '');
  if (/after17/.test(label)) return 0.46;
  if (/joey/.test(label)) return 1.08;
  return 1.0;
}

function cinemaAnalysisProfileForSong(song) {
  var title = String((song && (song.name || song.title)) || '').toLowerCase().replace(/\s+/g, '');
  var artist = String((song && song.artist) || '').toLowerCase().replace(/\s+/g, '');
  var label = title + ' ' + artist;
  if (/日落大道|sunsetboulevard/.test(label)) {
    return {
      id: 'sunset-boulevard-soft-groove',
      softGroove: true,
      phaseScan: true,
      localRefine: true,
      sparseCamera: true,
      introPattern: true
    };
  }
  return { id: 'default', softGroove: false, phaseScan: false, localRefine: false, sparseCamera: false, introPattern: false };
}

function resetCinemaTrackProfile(song) {
  var isDj = isPodcastSong(song);
  cinemaTrackProfile.scale = isDj ? 1.08 : 1.0;
  cinemaTrackProfile.target = isDj ? 1.10 : 1.0;
  cinemaTrackProfile.nameHint = isDj ? 1.12 : cinemaTrackNameHint(song);
  cinemaTrackProfile.frames = 0;
  cinemaTrackProfile.energyAvg = 0;
  cinemaTrackProfile.lowAvg = 0;
  cinemaTrackProfile.vocalAvg = 0;
  cinemaTrackProfile.melodyAvg = 0;
  cinemaTrackProfile.punchPeak = 0.10;
  cinemaTrackProfile.density = 0;
}

function updateCinemaTrackProfile(sample) {
  if (!sample) return;
  var p = cinemaTrackProfile;
  p.frames++;
  function follow(cur, next, k) { return cur + (next - cur) * k; }
  var early = p.frames < 360;
  var k = early ? 0.020 : 0.006;
  p.energyAvg = follow(p.energyAvg, clamp01(sample.energy), k);
  p.lowAvg = follow(p.lowAvg, clamp01(sample.low), k);
  p.vocalAvg = follow(p.vocalAvg, clamp01(sample.vocal), k * 0.8);
  p.melodyAvg = follow(p.melodyAvg, clamp01(sample.melody), k * 0.8);
  var punchRaw = clamp01((sample.lowOnset || 0) * 2.4 + (sample.energyOnset || 0) * 1.5 + sample.low * 0.16);
  p.punchPeak = Math.max(0.10, p.punchPeak * 0.9975, punchRaw);
  var lowDrive = clamp01((p.lowAvg - 0.20) / 0.42);
  var loudDrive = clamp01((p.energyAvg - 0.18) / 0.40);
  var punchDrive = clamp01((p.punchPeak - 0.13) / 0.36);
  var vocalSoft = clamp01((p.vocalAvg * 0.72 + p.melodyAvg * 0.42 - p.lowAvg * 0.34 - 0.08) / 0.42);
  var quietSoft = clamp01((0.24 - p.energyAvg) / 0.18);
  var target = djMode.active
    ? 0.72 + lowDrive * 0.34 + loudDrive * 0.18 + punchDrive * 0.42 - vocalSoft * 0.12 - quietSoft * 0.06
    : 0.54 + lowDrive * 0.28 + loudDrive * 0.22 + punchDrive * 0.34 - vocalSoft * 0.34 - quietSoft * 0.18;
  if (p.density) target += clamp01((p.density - 0.55) / 1.6) * 0.14;
  target *= p.nameHint || 1;
  target = clampRange(target, djMode.active ? 0.68 : 0.28, djMode.active ? 1.26 : 1.12);
  p.target = target;
  p.scale += (target - p.scale) * (target > p.scale ? (djMode.active ? 0.045 : 0.030) : (djMode.active ? 0.030 : 0.045));
}

function applyCinemaProfileFromBeatMap(map) {
  if (!map || !map.duration) return;
  var events = (map.cameraBeats || map.beats || []).filter(function(b){ return b && typeof b !== 'number' && b.camera !== false; });
  if (!events.length) return;
  var sumImpact = 0, sumLow = 0, primary = 0;
  events.forEach(function(b){
    sumImpact += Math.max(b.impact || 0, b.strength || 0);
    sumLow += b.low || 0;
    if (b.primary !== false) primary++;
  });
  var avgImpact = sumImpact / events.length;
  var avgLow = sumLow / events.length;
  var density = events.length / Math.max(20, map.duration);
  cinemaTrackProfile.density = density;
  var target = 0.44 + clamp01((avgImpact - 0.20) / 0.55) * 0.38 + clamp01((avgLow - 0.24) / 0.48) * 0.18 + clamp01((density - 0.45) / 1.65) * 0.20 + clamp01(primary / Math.max(1, events.length)) * 0.08;
  target *= cinemaTrackProfile.nameHint || 1;
  target = clampRange(target, 0.28, 1.12);
  cinemaTrackProfile.target = target;
  cinemaTrackProfile.scale += (target - cinemaTrackProfile.scale) * (target < cinemaTrackProfile.scale ? 0.55 : 0.22);
}

function resetRealtimeBeatEngine() {
  rtBeat.subFast = rtBeat.subSlow = rtBeat.lowFast = rtBeat.lowSlow = 0;
  rtBeat.bodyFast = rtBeat.bodySlow = rtBeat.vocalFast = rtBeat.vocalSlow = rtBeat.snapFast = rtBeat.snapSlow = 0;
  rtBeat.prevSub = rtBeat.prevLow = rtBeat.prevBody = rtBeat.prevVocal = rtBeat.prevSnap = rtBeat.prevRms = 0;
  rtBeat.onsetAvg = 0.012;
  rtBeat.onsetPeak = 0.060;
  rtBeat.subPeak = 0.14;
  rtBeat.lowPeak = 0.18;
  rtBeat.bodyPeak = 0.16;
  rtBeat.vocalPeak = 0.16;
  rtBeat.snapPeak = 0.14;
  rtBeat.lastHitAt = -10;
  rtBeat.tempoGap = 0;
  rtBeat.tempoConfidence = 0;
  rtBeat.beatCount = 0;
  rtBeat.primedFrames = 0;
  rtBeat.warmupUntil = (audio && isFinite(audio.currentTime) ? audio.currentTime : 0) + (djMode.active ? 0.34 : 1.15);
  rtBeat.pulse = 0;
  rtBeat.score = 0;
  rtBeat.stats.hits = 0;
  rtBeat.stats.blocked = 0;
  rtBeat.stats.assisted = 0;
  rtBeat.stats.strong = 0;
  rtBeat.stats.rejected = 0;
}

function resetAudioVisualState() {
  bass = 0;
  mid = 0;
  treble = 0;
  audioEnergy = 0;
  beatPulse = 0;
  prevEnergy = 0;
  smoothBass = 0;
  smoothMid = 0;
  smoothTreb = 0;
  smoothEnergy = 0;
  bassPeak = 0.12;
  midPeak = 0.10;
  treblePeak = 0.08;
  energyPeak = 0.10;
  scheduledBeatPulse = 0;
  scheduledBeatFlag = false;
  beatOnsetFlag = false;
  cinemaDynamics.avg = 0;
  cinemaDynamics.lowAvg = 0;
  cinemaDynamics.peak = 0.30;
  cinemaDynamics.scale = 0.82;
  if (djMode.active) resetDjModeMeter();
}

function beatEventTime(ev) {
  return typeof ev === 'number' ? ev : (ev && isFinite(ev.time) ? ev.time : Infinity);
}

function yieldToPaint() {
  return new Promise(function(resolve) {
    if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
    } else {
      requestAnimationFrame(function(){ setTimeout(resolve, 0); });
    }
  });
}

function yieldToIdle(timeout) {
  return new Promise(function(resolve) {
    if (isHiddenForBackgroundOptimization()) {
      setTimeout(resolve, Math.min(timeout || 80, 80));
      return;
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function(){ resolve(); }, { timeout: timeout || 1200 });
    } else {
      setTimeout(resolve, timeout ? Math.min(timeout, 600) : 160);
    }
  });
}

function scheduleAnalysisTask(fn, timeout) {
  if (typeof fn !== 'function') return;
  if (isHiddenForBackgroundOptimization()) {
    setTimeout(fn, 0);
    return;
  }
  if (window.requestIdleCallback) {
    requestIdleCallback(fn, { timeout: timeout || 900 });
  } else {
    setTimeout(fn, Math.min(timeout || 420, 420));
  }
}

function scheduleVisualApply(fn, delay, timeout) {
  if (typeof fn !== 'function') return;
  setTimeout(function(){
    if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
      fn();
      return;
    }
    var run = function(){ requestAnimationFrame(fn); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: timeout || 360 });
    else run();
  }, delay || 0);
}

function scheduleUiWarmTask(fn, timeout) {
  if (typeof fn !== 'function') return;
  var run = function(){ requestAnimationFrame(fn); };
  if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0);
  } else if (window.requestIdleCallback) {
    requestIdleCallback(run, { timeout: timeout || 220 });
  } else {
    requestAnimationFrame(fn);
  }
}
function scheduleWebStartupTask(fn, timeout) {
  if (typeof fn !== 'function') return;
  var run = function(){
    try { fn(); } catch (e) { console.warn('[WebStartup]', e); }
  };
  if (!mineradioUsesWebMediaBridge()) {
    setTimeout(function(){ if (mineradioUsesWebMediaBridge()) run(); }, Math.max(120, timeout || 2800));
    return;
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: timeout || 2800 });
  else setTimeout(run, Math.min(1400, timeout || 1400));
}

var VOID_PRESET_INDEX = 3;
function presetSkipsBeatAnalysisUi(preset) {
  return Number(preset == null ? (fx && fx.preset) : preset) === VOID_PRESET_INDEX;
}
function dismissPlaybackBeatAnalysis(invalidate) {
  cancelBeatAnalysisTimer();
  cancelBeatAnalysisWatchdog();
  clearProvisionalBeatChipTimer();
  beatAnalysisStartedAt = 0;
  if (invalidate) {
    beatMapToken++;
    beatMapBusy = false;
  }
  hideBeatChip();
}
function resumePlaybackBeatAnalysisIfNeeded() {
  if (presetSkipsBeatAnalysisUi() || djMode.active || !playing || currentIdx < 0 || currentIdx >= playQueue.length) return;
  var song = playQueue[currentIdx];
  if (!song) return;
  var key = beatMapSongKey(song) || String(song.id || '');
  if (!key || !currentPlaybackDirectUrl) return;
  if (hasResolvedBeatMapCache(key)) return;
  scheduleBeatAnalysis(key, resolveBeatAnalysisAudioUrl(currentPlaybackDirectUrl), beatMapToken, song, currentPlaybackDirectUrl);
}
function cancelBeatAnalysisTimer() {
  if (beatAnalysisTimer) {
    clearTimeout(beatAnalysisTimer);
    beatAnalysisTimer = null;
  }
}
function clearProvisionalBeatChipTimer() {
  if (provisionalBeatChipTimer) {
    clearTimeout(provisionalBeatChipTimer);
    provisionalBeatChipTimer = null;
  }
}
function cancelBeatAnalysisWatchdog() {
  if (beatAnalysisWatchdogTimer) {
    clearTimeout(beatAnalysisWatchdogTimer);
    beatAnalysisWatchdogTimer = null;
  }
}
function armBeatAnalysisWatchdog(token) {
  cancelBeatAnalysisWatchdog();
  beatAnalysisWatchdogTimer = setTimeout(function(){
    beatAnalysisWatchdogTimer = null;
    if (token !== beatMapToken) return;
    if (!beatMapBusy) return;
    console.warn('[BeatAnalysis] watchdog timeout, keeping provisional grid');
    beatMapBusy = false;
    hideBeatChip();
    clearProvisionalBeatChipTimer();
  }, BEAT_ANALYSIS_WATCHDOG_MS);
}
function scheduleProvisionalBeatChip(songId) {
  clearProvisionalBeatChipTimer();
  provisionalBeatMapKey = String(songId || '');
  showBeatChip('临时节奏网格 · 精分析中…');
  provisionalBeatChipTimer = setTimeout(function(){
    provisionalBeatChipTimer = null;
    if (beatMapBusy || beatAnalysisTimer) return;
    if (currentBeatMap && currentBeatMap.provisional) hideBeatChip();
  }, PROVISIONAL_BEAT_CHIP_MAX_MS);
}
function beatAnalysisFetchOptions() {
  if (!mineradioUsesWebMediaBridge()) return {};
  return {
    headers: { Range: 'bytes=0-' + (BEAT_ANALYSIS_WEB_MAX_BYTES - 1) },
    bridgeTimeoutMs: BEAT_ANALYSIS_WEB_TIMEOUT_MS,
    timeoutMs: BEAT_ANALYSIS_WEB_TIMEOUT_MS
  };
}

function cancelBeatPrefetchTimer() {
  if (beatPrefetchTimer) {
    clearTimeout(beatPrefetchTimer);
    beatPrefetchTimer = null;
  }
}

function beatAnalysisYieldMs(options, currentMs, prefetchMs) {
  options = options || {};
  if (mineradioUsesWebMediaBridge()) {
    if (options.prefetch) return prefetchMs == null ? 920 : prefetchMs;
    if (options.background) return currentMs == null ? 420 : currentMs;
    return Math.min(currentMs == null ? 260 : currentMs, 320);
  }
  if (options.prefetch) return prefetchMs == null ? 620 : prefetchMs;
  if (options.background) return currentMs == null ? 120 : currentMs;
  return Math.min(currentMs == null ? 120 : currentMs, 160);
}
function truncateAudioBufferForWebAnalysis(buffer, maxSeconds) {
  if (!buffer || !mineradioUsesWebMediaBridge()) return buffer;
  maxSeconds = maxSeconds || BEAT_ANALYSIS_WEB_MAX_SEC;
  if (!isFinite(buffer.duration) || buffer.duration <= maxSeconds) return buffer;
  var frames = Math.min(buffer.length, Math.floor(buffer.sampleRate * maxSeconds));
  if (frames >= buffer.length) return buffer;
  try {
    var Factory = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var trimmed = null;
    if (Factory) {
      var factoryCtx = new Factory(1, 1, buffer.sampleRate);
      trimmed = factoryCtx.createBuffer(buffer.numberOfChannels, frames, buffer.sampleRate);
    } else if (typeof AudioBuffer !== 'undefined') {
      trimmed = new AudioBuffer({ length: frames, sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels });
    }
    if (!trimmed) return buffer;
    for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
      trimmed.getChannelData(ch).set(buffer.getChannelData(ch).subarray(0, frames));
    }
    return trimmed;
  } catch (e) {
    return buffer;
  }
}
window.applyWebPlaybackPerfTuning = applyWebPlaybackPerfTuning;

function beatBandRms(data, sampleRate, fftSize, hz0, hz1) {
  var binHz = sampleRate / fftSize;
  var a = Math.max(1, Math.floor(hz0 / binHz));
  var b = Math.min(data.length - 1, Math.ceil(hz1 / binHz));
  var sum = 0, count = 0;
  for (var i = a; i <= b; i++) {
    var v = data[i] / 255;
    sum += v * v;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function processRealtimeBeatEngine(dt) {
  if (!beatAnalyser || !audioCtx || !audio || audio.paused) return null;
  dt = Math.max(0.001, Math.min(0.080, dt || 0.016));
  var dj = djMode.active;
  beatAnalyser.getByteFrequencyData(beatFrequencyData);
  beatAnalyser.getByteTimeDomainData(beatTimeDomainData);
  var sr = audioCtx.sampleRate || 44100;
  var sub = beatBandRms(beatFrequencyData, sr, beatAnalyser.fftSize, 38, 74);
  var kick = beatBandRms(beatFrequencyData, sr, beatAnalyser.fftSize, 52, 165);
  var body = beatBandRms(beatFrequencyData, sr, beatAnalyser.fftSize, 165, 420);
  var vocal = beatBandRms(beatFrequencyData, sr, beatAnalyser.fftSize, 420, 2600);
  var snap = beatBandRms(beatFrequencyData, sr, beatAnalyser.fftSize, 1800, 9200);
  var low = Math.min(1, kick * 0.86 + sub * 0.42);
  var rms = 0;
  for (var i = 0; i < beatTimeDomainData.length; i++) {
    var tv = (beatTimeDomainData[i] - 128) / 128;
    rms += tv * tv;
  }
  rms = Math.sqrt(rms / beatTimeDomainData.length);

  function follow(cur, next, upTau, downTau) {
    var tau = next > cur ? upTau : downTau;
    return cur + (next - cur) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
  }
  var fastMul = dj ? 0.86 : 1;
  var downMul = dj ? 0.94 : 1;
  var slowMul = dj ? 1.06 : 1;
  rtBeat.subFast = follow(rtBeat.subFast, sub, 0.018 * fastMul, 0.064 * downMul);
  rtBeat.subSlow = follow(rtBeat.subSlow, sub, 0.320 * slowMul, 0.520 * slowMul);
  rtBeat.lowFast = follow(rtBeat.lowFast, low, 0.016 * fastMul, 0.070 * downMul);
  rtBeat.lowSlow = follow(rtBeat.lowSlow, low, 0.300 * slowMul, 0.540 * slowMul);
  rtBeat.bodyFast = follow(rtBeat.bodyFast, body, 0.020 * fastMul, 0.082 * downMul);
  rtBeat.bodySlow = follow(rtBeat.bodySlow, body, 0.360 * slowMul, 0.600 * slowMul);
  rtBeat.vocalFast = follow(rtBeat.vocalFast, vocal, 0.026 * fastMul, 0.090 * downMul);
  rtBeat.vocalSlow = follow(rtBeat.vocalSlow, vocal, 0.340 * slowMul, 0.580 * slowMul);
  rtBeat.snapFast = follow(rtBeat.snapFast, snap, 0.012 * fastMul, 0.060 * downMul);
  rtBeat.snapSlow = follow(rtBeat.snapSlow, snap, 0.300 * slowMul, 0.520 * slowMul);

  var peakDecay = dj ? 0.988 : 0.990;
  rtBeat.subPeak = Math.max(rtBeat.subPeak * Math.pow(peakDecay, dt * 60), sub, 0.045);
  rtBeat.lowPeak = Math.max(rtBeat.lowPeak * Math.pow(dj ? 0.987 : 0.989, dt * 60), low, 0.060);
  rtBeat.bodyPeak = Math.max(rtBeat.bodyPeak * Math.pow(peakDecay, dt * 60), body, 0.040);
  rtBeat.vocalPeak = Math.max(rtBeat.vocalPeak * Math.pow(peakDecay, dt * 60), vocal, 0.040);
  rtBeat.snapPeak = Math.max(rtBeat.snapPeak * Math.pow(peakDecay, dt * 60), snap, 0.035);

  var subFlux = Math.max(0, sub - rtBeat.prevSub);
  var lowFlux = Math.max(0, low - rtBeat.prevLow);
  var bodyFlux = Math.max(0, body - rtBeat.prevBody);
  var vocalFlux = Math.max(0, vocal - rtBeat.prevVocal);
  var snapFlux = Math.max(0, snap - rtBeat.prevSnap);
  var rmsFlux = Math.max(0, rms - rtBeat.prevRms);
  var subRise = Math.max(0, rtBeat.subFast - rtBeat.subSlow);
  var lowRise = Math.max(0, rtBeat.lowFast - rtBeat.lowSlow);
  var bodyRise = Math.max(0, rtBeat.bodyFast - rtBeat.bodySlow);
  var vocalRise = Math.max(0, rtBeat.vocalFast - rtBeat.vocalSlow);
  var snapRise = Math.max(0, rtBeat.snapFast - rtBeat.snapSlow);
  var drumOnset = subRise * 0.88 + subFlux * 0.66 + lowRise * 1.62 + lowFlux * 1.34;
  var musicalOnset = bodyRise * 0.34 + bodyFlux * 0.24 + vocalRise * 0.52 + vocalFlux * 0.36 + snapRise * 0.08 + snapFlux * 0.06 + rmsFlux * 0.20;
  var onset = dj ? drumOnset * 1.05 + musicalOnset * 0.07 : drumOnset + musicalOnset * 0.16;

  var avgTau = onset > rtBeat.onsetAvg ? (dj ? 0.88 : 1.10) : (dj ? 0.30 : 0.34);
  rtBeat.onsetAvg = follow(rtBeat.onsetAvg, onset, avgTau, avgTau);
  rtBeat.onsetPeak = Math.max(rtBeat.onsetPeak * Math.pow(dj ? 0.986 : 0.988, dt * 60), onset, 0.032);
  var floor = rtBeat.onsetAvg * (dj ? 0.88 : 0.84);
  var score = clamp01((onset - floor) / Math.max(dj ? 0.013 : 0.014, rtBeat.onsetPeak - floor));
  var subNorm = clamp01(sub / Math.max(0.045, rtBeat.subPeak * (dj ? 0.72 : 0.70)));
  var lowNorm = clamp01(low / Math.max(0.060, rtBeat.lowPeak * (dj ? 0.74 : 0.72)));
  var bodyNorm = clamp01(body / Math.max(0.045, rtBeat.bodyPeak * (dj ? 0.74 : 0.72)));
  var vocalNorm = clamp01(vocal / Math.max(0.045, rtBeat.vocalPeak * 0.72));
  var snapNorm = clamp01(snap / Math.max(0.040, rtBeat.snapPeak * (dj ? 0.78 : 0.72)));
  var nowT = audio.currentTime || 0;
  rtBeat.primedFrames++;
  var warmingUp = nowT < rtBeat.warmupUntil || rtBeat.primedFrames < (dj ? 8 : 18);
  var gapFromLast = nowT - rtBeat.lastHitAt;
  var expectedGap = rtBeat.tempoGap > 0 ? rtBeat.tempoGap : 0;
  var phaseErr = expectedGap > 0 ? Math.abs(gapFromLast - expectedGap) : 99;
  var phaseWindow = expectedGap > 0 ? Math.max(dj ? 0.055 : 0.055, Math.min(dj ? 0.105 : 0.105, expectedGap * (dj ? 0.16 : 0.16))) : 0;
  var tempoDue = expectedGap > 0 && gapFromLast > expectedGap - phaseWindow && gapFromLast < expectedGap + phaseWindow;
  var lowPresence = Math.max(lowNorm, subNorm * 0.74);
  var lowAttack = lowRise + lowFlux * 0.72 + subRise * 0.58 + subFlux * 0.40;
  var lowDominance = low / Math.max(0.001, vocal * 0.84 + body * 0.36 + snap * 0.10);
  var lowFluxDominance = (lowFlux + subFlux * 0.58) / Math.max(0.001, vocalFlux * 0.72 + bodyFlux * 0.42 + snapFlux * 0.16);
  var voiceMask = dj
    ? (vocalNorm > 0.62 && lowDominance < 0.92 && lowFluxDominance < 1.06 && subNorm < 0.54)
    : (vocalNorm > 0.58 && lowDominance < 0.86 && lowFluxDominance < 1.10);
  var drumGate = lowPresence > (dj ? 0.42 : 0.38) && lowAttack > Math.max(dj ? 0.015 : 0.014, rtBeat.onsetAvg * (dj ? 0.38 : 0.34)) && !voiceMask;
  drumGate = drumGate && (lowDominance > (dj ? 0.86 : 0.72) || lowFluxDominance > (dj ? 1.14 : 1.02) || subNorm > (dj ? 0.62 : 0.56));
  var strongTransient = drumGate && score > (dj ? 0.55 : 0.54) && drumOnset > rtBeat.onsetAvg * (dj ? 0.92 : 0.84);
  var kickTransient = drumGate && score > (dj ? 0.43 : 0.40) && lowAttack > Math.max(dj ? 0.020 : 0.018, rtBeat.onsetAvg * (dj ? 0.54 : 0.46));
  var tempoAssist = tempoDue && rtBeat.tempoConfidence > (dj ? 0.40 : 0.42) && drumGate && lowPresence > (dj ? 0.48 : 0) && score > (dj ? 0.30 : 0.22) && lowAttack > Math.max(0.016, rtBeat.onsetAvg * (dj ? 0.44 : 0.34));
  var candidateHit = strongTransient || kickTransient || tempoAssist;
  if (warmingUp) candidateHit = false;
  var hasTempoLock = expectedGap >= (dj ? 0.32 : 0.42) && expectedGap <= (dj ? 0.92 : 0.88) && rtBeat.tempoConfidence > (dj ? 0.36 : 0.38);
  var lockedWindow = hasTempoLock ? Math.max(dj ? 0.062 : 0.070, Math.min(dj ? 0.118 : 0.110, expectedGap * (dj ? 0.17 : 0.16))) : 0;
  var gapRaw = nowT - rtBeat.lastHitAt;
  var rhythmAccept = false;
  if (candidateHit) {
    if (rtBeat.lastHitAt < 0) {
      rhythmAccept = strongTransient && score > (dj ? 0.58 : 0.62) && lowPresence > (dj ? 0.50 : 0.48);
    } else if (hasTempoLock) {
      var oneBeatErr = Math.abs(gapRaw - expectedGap);
      var twoBeatErr = Math.abs(gapRaw - expectedGap * 2);
      rhythmAccept = oneBeatErr <= lockedWindow && (kickTransient || strongTransient);
      rhythmAccept = rhythmAccept || (twoBeatErr <= lockedWindow * 1.35 && strongTransient && score > (dj ? 0.54 : 0.58));
      rhythmAccept = rhythmAccept || (gapRaw > expectedGap * 1.55 && strongTransient && lowPresence > (dj ? 0.50 : 0.44));
      if (dj) {
        rhythmAccept = rhythmAccept || (gapRaw > expectedGap * 1.24 && strongTransient && score > 0.56 && lowDominance > 0.92);
      }
    } else {
      rhythmAccept = gapRaw >= (dj ? 0.340 : beatCam.realtimeMinInterval) && strongTransient && score > (dj ? 0.56 : 0.58) && lowPresence > (dj ? 0.50 : 0.44);
    }
  }
  var hit = candidateHit && rhythmAccept;
  if (!hit && (candidateHit || score > 0.42 || vocalNorm > 0.62 || bodyNorm > 0.54)) rtBeat.stats.rejected++;
  var minGap = hasTempoLock ? Math.max(dj ? 0.315 : 0.400, Math.min(dj ? 0.500 : 0.540, expectedGap * (dj ? 0.64 : 0.72))) : (dj ? 0.340 : beatCam.realtimeMinInterval);
  if (hit && gapRaw < minGap) {
    rtBeat.stats.blocked++;
    hit = false;
  }

  rtBeat.prevSub = sub;
  rtBeat.prevLow = low;
  rtBeat.prevBody = body;
  rtBeat.prevVocal = vocal;
  rtBeat.prevSnap = snap;
  rtBeat.prevRms = rms;
  rtBeat.score = score;
  rtBeat.pulse *= Math.pow(dj ? 0.24 : 0.18, dt);
  rtBeat.tempoConfidence *= Math.pow(dj ? 0.992 : 0.996, dt * 60);

  if (!hit) {
    if (dj) {
      djMode.tempoGap = rtBeat.tempoGap;
      djMode.tempoConfidence = rtBeat.tempoConfidence;
    }
    return { hit: false, score: score, low: lowNorm, body: bodyNorm, vocal: vocalNorm, snap: snapNorm, tempoConfidence: rtBeat.tempoConfidence };
  }

  var gapShift = 0;
  if (rtBeat.lastHitAt > 0) {
    var gap = nowT - rtBeat.lastHitAt;
    while (gap > (dj ? 0.96 : 0.88)) gap *= 0.5;
    while (gap < (dj ? 0.32 : 0.42)) gap *= 2.0;
    if (gap >= (dj ? 0.32 : 0.42) && gap <= (dj ? 0.96 : 0.88)) {
      gapShift = rtBeat.tempoGap ? Math.abs(gap - rtBeat.tempoGap) / Math.max(0.001, rtBeat.tempoGap) : 0;
      var tempoEase = hasTempoLock ? (dj ? 0.12 : 0.10) : (dj ? 0.24 : 0.22);
      if (dj && gapShift > 0.16 && strongTransient && lowDominance > 0.95) tempoEase = Math.min(0.36, tempoEase + gapShift * 0.45);
      rtBeat.tempoGap = rtBeat.tempoGap ? rtBeat.tempoGap * (1 - tempoEase) + gap * tempoEase : gap;
      rtBeat.tempoConfidence = Math.min(1, rtBeat.tempoConfidence + (tempoAssist ? (dj ? 0.04 : 0.04) : (dj ? 0.16 : 0.18)));
    }
  }
  rtBeat.lastHitAt = nowT;
  rtBeat.beatCount++;
  rtBeat.stats.hits++;
  if (tempoAssist) rtBeat.stats.assisted++;
  if (strongTransient || kickTransient) rtBeat.stats.strong++;
  var strength = dj
    ? clamp01(0.18 + score * 0.38 + lowPresence * 0.34 + Math.min(1.35, lowDominance) * 0.08 + rmsFlux * 0.72)
    : clamp01(0.24 + score * 0.36 + lowPresence * 0.34 + Math.min(1.25, lowDominance) * 0.07 + rmsFlux * 0.95);
  if (tempoAssist) strength = Math.max(strength, (dj ? 0.46 : 0.48) + rtBeat.tempoConfidence * (dj ? 0.10 : 0.10) + lowPresence * (dj ? 0.14 : 0.14));
  var comboSlot = (rtBeat.beatCount - 1) % 4;
  var combo = comboSlot === 0 ? 'downbeat' : (comboSlot === 1 ? 'push' : (comboSlot === 2 ? 'drop' : 'rebound'));
  if (strength > 0.84 && comboSlot !== 0) combo = 'accent';
  if (dj && strength > 0.78 && snapNorm > 0.56 && comboSlot !== 0) combo = 'accent';
  if (dj && gapShift > 0.14 && strongTransient && lowPresence > 0.52) combo = 'downbeat';
  rtBeat.pulse = Math.max(rtBeat.pulse, strength);
  if (dj) {
    djMode.tempoGap = rtBeat.tempoGap;
    djMode.tempoConfidence = rtBeat.tempoConfidence;
    djMode.sectionChange = Math.max(djMode.sectionChange, Math.min(1, gapShift * 1.4));
    djMode.visualPulse = Math.max(djMode.visualPulse, strength);
    djMode.lastBeatAt = nowT;
  }
  return {
    hit: true,
    time: dj ? Math.max(0, nowT - 0.026) : nowT,
    strength: strength,
    confidence: dj ? clamp01(score * 0.58 + lowPresence * 0.30 + rtBeat.tempoConfidence * 0.12) : clamp01(score * 0.62 + lowPresence * 0.26 + rtBeat.tempoConfidence * 0.12),
    low: Math.max(0.05, lowPresence),
    body: Math.max(0.02, bodyNorm * (dj ? 0.50 : 0.62)),
    snap: Math.max(0.02, snapNorm * (dj ? 0.86 : 1)),
    mass: dj ? clamp01(lowPresence * 0.84 + bodyNorm * 0.10) : clamp01(lowPresence * 0.76 + bodyNorm * 0.20),
    sharpness: dj ? clamp01(snapNorm * 0.58 + bodyNorm * 0.10) : clamp01(snapNorm * 0.70 + bodyNorm * 0.12),
    tempoAssist: tempoAssist,
    tempoGap: rtBeat.tempoGap,
    combo: combo,
    score: score,
    lowDominance: lowDominance,
    dj: dj
  };
}

function mergeRealtimeBeatCamera(time, amp, tone) {
  var best = null;
  var bestDist = beatCam.realtimeMergeWindow;
  for (var i = 0; i < beatCam.events.length; i++) {
    var dist = Math.abs((beatCam.events[i].hit || 0) - time);
    if (dist < bestDist) {
      best = beatCam.events[i];
      bestDist = dist;
    }
  }
  if (!best) return false;
  var nowT = audio ? audio.currentTime : uniforms.uTime.value;
  best.hit = time;
  best.start = nowT - (best.attack || beatCam.attack) * 0.42;
  var mergeMaxAmp = ((tone && tone.dj) || djMode.active) ? 0.62 : 0.62;
  best.amp = Math.min(mergeMaxAmp, Math.max(best.amp || 0, amp));
  if (tone) {
    best.zoomAmp = Math.max(best.zoomAmp || 0, tone.zoomAmp);
    best.thetaAmp = Math.max(best.thetaAmp || 0, tone.thetaAmp);
    best.phiAmp = Math.max(best.phiAmp || 0, tone.phiAmp);
    best.rollAmp = Math.max(best.rollAmp || 0, tone.rollAmp || 0);
    best.low = Math.max(best.low || 0, tone.low);
    best.body = Math.max(best.body || 0, tone.body);
    best.snap = Math.max(best.snap || 0, tone.snap);
    best.mode = tone.mode || best.mode;
    best.dj = !!tone.dj || !!best.dj;
  }
  best.source = 'hybrid';
  beatCam.stats.merged++;
  return true;
}

function scheduleBeatCamera(beat, source) {
  if (!fx.cinema) return;
  var time = typeof beat === 'number' ? beat : beat.time;
  if (!isFinite(time)) return;
  var strength = typeof beat === 'number' ? 0.72 : Math.max(0, Math.min(1, beat.strength || 0.72));
  var confidence = typeof beat === 'number' ? 0.72 : Math.max(0, Math.min(1, beat.confidence || 0.72));
  var isPrimary = typeof beat === 'number' ? true : beat.primary !== false;
  var visualImpact = typeof beat === 'number' ? strength : Math.max(0, Math.min(1, beat.impact == null ? strength : beat.impact));
  var isDjMapSource = source === 'djmap';
  var isMapSource = source === 'map' || !source;
  var isLiveSource = source === 'live' || source === 'fallback';
  var livePreview = !!(isLiveSource && beat && beat.preview);
  var dj = djMode.active && (isLiveSource || isDjMapSource || (beat && beat.dj));
  if (isMapSource && !isPrimary) return;
  if (isMapSource && visualImpact < 0.18 && strength < 0.56) return;
  if (isMapSource && confidence < 0.30 && strength < 0.68) return;
  var trackScale = cinemaTrackProfile.scale || 1;
  if (trackScale < 0.58 && isMapSource && strength < 0.72 && visualImpact < 0.46) return;
  if (trackScale < 0.50 && isLiveSource && strength < (dj ? 0.58 : 0.84) && visualImpact < (dj ? 0.42 : 0.56)) return;
  var lowTone = typeof beat === 'number' ? 0.62 : Math.max(0, beat.low == null ? 0.62 : beat.low);
  var bodyTone = typeof beat === 'number' ? 0.22 : Math.max(0, beat.body == null ? 0.22 : beat.body);
  var snapTone = typeof beat === 'number' ? 0.16 : Math.max(0, beat.snap == null ? 0.16 : beat.snap);
  var rawLowTone = lowTone;
  var rawBodyTone = bodyTone;
  var rawSnapTone = snapTone;
  var toneSum = Math.max(0.001, lowTone + bodyTone + snapTone);
  lowTone /= toneSum;
  bodyTone /= toneSum;
  snapTone /= toneSum;
  var sharpness = typeof beat === 'number' ? snapTone : Math.max(0, Math.min(1, beat.sharpness == null ? snapTone : beat.sharpness));
  var mass = typeof beat === 'number' ? lowTone : Math.max(0, Math.min(1, beat.mass == null ? (lowTone * 0.72 + bodyTone * 0.36 + strength * 0.20) : beat.mass));
  var nowT = audio ? audio.currentTime : uniforms.uTime.value;
  var mode = 'deep';
  if (dj) {
    if (rawSnapTone > 0.58 && rawSnapTone > rawLowTone * 0.86 && rawSnapTone > rawBodyTone * 1.08) mode = 'snap';
    else if (rawBodyTone > 0.36 && rawBodyTone > rawLowTone * 0.56) mode = 'body';
  } else {
    if (snapTone > 0.42 && snapTone > lowTone * 1.18 && snapTone > bodyTone * 1.08) mode = 'snap';
    else if (bodyTone > 0.46 && bodyTone > lowTone * 1.12) mode = 'body';
  }
  var amp;
  if (dj) {
    var lowDrive = clamp01((rawLowTone - 0.42) / 0.54);
    var bodyDrive = clamp01((rawBodyTone - 0.24) / 0.58);
    var snapDrive = clamp01((rawSnapTone - 0.30) / 0.60);
    if (mode === 'deep') amp = 0.16 + strength * 0.20 + lowDrive * 0.25 + confidence * 0.05;
    else if (mode === 'body') amp = 0.12 + strength * 0.15 + bodyDrive * 0.18 + lowDrive * 0.06;
    else amp = 0.08 + strength * 0.11 + snapDrive * 0.13;
  } else {
    amp = Math.max(0.18, Math.min(0.72, 0.15 + strength * 0.34 + confidence * 0.06 + mass * 0.13 + snapTone * 0.04));
  }
  if (isMapSource) amp *= 0.68 + visualImpact * 0.46;
  if (!isPrimary) amp *= 0.62;
  if (source === 'fallback') amp *= 0.74;
  if (source === 'live') amp *= dj ? 0.62 : (livePreview ? 0.78 : 0.92);
  if (mode === 'deep' && !dj) amp = Math.min(0.62, amp * 1.12);
  var dynScale = cameraDynamicsScale(0.92 + visualImpact * 0.12 + mass * 0.08);
  amp *= dj ? clampRange(dynScale, 0.72, 1.16) : dynScale;
  var attack = dj
    ? (mode === 'snap' ? 0.010 : (mode === 'body' ? 0.015 : 0.017))
    : Math.max(0.014, Math.min(0.038, beatCam.attack * (1.18 - sharpness * 0.55)));
  var hold = dj
    ? (mode === 'deep' ? 0.038 + lowTone * 0.014 : (mode === 'body' ? 0.026 : 0.014))
    : Math.max(0.014, Math.min(0.052, beatCam.hold * (0.62 + lowTone * 0.55 + bodyTone * 0.25)));
  var release = dj
    ? (mode === 'deep' ? 0.178 + mass * 0.040 : (mode === 'body' ? 0.140 : 0.104))
    : Math.max(0.110, Math.min(0.255, beatCam.release * (0.76 + mass * 0.56 + bodyTone * 0.18 - sharpness * 0.18)));
  var idx = typeof beat === 'number' ? Math.floor(time * 2.7) : (beat.index || Math.floor(time * 2.7));
  var combo = typeof beat === 'number' ? null : beat.combo;
  if (!combo) {
    var comboSlot = Math.abs(idx) % 4;
    combo = comboSlot === 0 ? 'downbeat' : (comboSlot === 1 ? 'push' : (comboSlot === 2 ? 'drop' : 'rebound'));
  }
  var zoomAmp = 0.070 + mass * 0.190 + (mode === 'deep' ? 0.095 : 0.018) + strength * 0.045;
  var thetaAmp = 0.00035;
  var phiAmp = 0.002 + (mode === 'body' ? 0.012 : (mode === 'snap' ? 0.005 : 0.002));
  var rollAmp = mode === 'snap' ? (0.003 + snapTone * 0.004) : 0.0008;
  zoomAmp *= 0.76 + dynScale * 0.28;
  phiAmp *= 0.82 + dynScale * 0.20;
  rollAmp *= 0.78 + dynScale * 0.24;
  if (dj) {
    var lowDrive2 = clamp01((rawLowTone - 0.42) / 0.54);
    var bodyDrive2 = clamp01((rawBodyTone - 0.24) / 0.58);
    var snapDrive2 = clamp01((rawSnapTone - 0.30) / 0.60);
    if (mode === 'deep') {
      zoomAmp = 0.115 + lowDrive2 * 0.170 + strength * 0.036;
      phiAmp = 0.0016 + bodyDrive2 * 0.0022;
      thetaAmp = 0.0006 + bodyDrive2 * 0.0012;
      rollAmp = 0.0006 + snapDrive2 * 0.0016;
    } else if (mode === 'body') {
      zoomAmp = 0.052 + lowDrive2 * 0.052;
      phiAmp = 0.0075 + bodyDrive2 * 0.018;
      thetaAmp = 0.0018 + bodyDrive2 * 0.0046;
      rollAmp = 0.0014 + snapDrive2 * 0.0022;
    } else {
      zoomAmp = 0.026 + lowDrive2 * 0.024;
      phiAmp = 0.0024 + bodyDrive2 * 0.0040;
      thetaAmp = 0.0009 + snapDrive2 * 0.0018;
      rollAmp = 0.0048 + snapDrive2 * 0.0095;
    }
    if (combo === 'downbeat') {
      amp *= 1.12;
      zoomAmp *= mode === 'deep' ? 1.28 : 1.06;
      phiAmp *= 0.76;
    } else if (combo === 'push') {
      amp *= mode === 'deep' ? 0.76 : 0.68;
      zoomAmp *= 0.62;
      thetaAmp *= 1.15;
    } else if (combo === 'drop') {
      amp *= 0.82;
      zoomAmp *= 0.50;
      phiAmp *= 1.38;
    } else if (combo === 'rebound') {
      amp *= 0.62;
      zoomAmp *= 0.40;
      phiAmp *= 0.70;
    } else if (combo === 'accent') {
      amp *= mode === 'snap' ? 0.78 : 0.94;
      zoomAmp *= mode === 'snap' ? 0.42 : 0.78;
      rollAmp *= 1.58;
    }
    if (isDjMapSource) {
      var offlineContrast = Math.pow(clamp01((visualImpact - 0.16) / 0.72), 1.06);
      var offlineDrive = 0.72 + offlineContrast * 0.94 + Math.pow(strength, 1.22) * 0.14;
      var sectionLowGate = clamp01(((djMode.sectionLow || 0) - 0.030) / 0.32);
      var sectionEnergyGate = clamp01(((djMode.sectionEnergy || 0) - 0.045) / 0.40);
      var liveSectionGate = Math.max(sectionLowGate * 0.58 + sectionEnergyGate * 0.34, visualImpact * 0.82);
      var weakSectionScale = 0.54 + Math.pow(clamp01(liveSectionGate), 0.78) * 0.46;
      var comboDrive = combo === 'downbeat'
        ? 0.96 + offlineContrast * 0.38
        : (combo === 'drop'
          ? 0.80 + offlineContrast * 0.26
          : (combo === 'accent'
            ? 0.74 + offlineContrast * 0.30
            : (combo === 'push' ? 0.68 + offlineContrast * 0.16 : 0.52 + offlineContrast * 0.12)));
      if (mode === 'deep') {
        amp *= offlineDrive * comboDrive * 1.38;
        zoomAmp *= 1.14 + offlineContrast * 0.68 + lowDrive2 * 0.20;
        phiAmp *= 0.72 + offlineContrast * 0.22;
        thetaAmp *= 0.72 + offlineContrast * 0.20;
        release *= 0.98 + offlineContrast * 0.20;
      } else if (mode === 'body') {
        amp *= offlineDrive * comboDrive * 1.24;
        zoomAmp *= 0.90 + offlineContrast * 0.32;
        phiAmp *= 1.00 + offlineContrast * 0.42 + bodyDrive2 * 0.18;
        thetaAmp *= 0.98 + offlineContrast * 0.36 + bodyDrive2 * 0.14;
        release *= 0.96 + offlineContrast * 0.12;
      } else {
        amp *= offlineDrive * comboDrive * 0.94;
        zoomAmp *= 0.52 + offlineContrast * 0.24;
        phiAmp *= 0.84 + offlineContrast * 0.28;
        thetaAmp *= 0.86 + offlineContrast * 0.30;
        rollAmp *= 1.02 + offlineContrast * 0.76 + snapDrive2 * 0.22;
        attack *= 0.92;
        release *= 0.78 + offlineContrast * 0.14;
      }
      if (combo === 'downbeat') {
        zoomAmp *= mode === 'deep' ? (1.04 + offlineContrast * 0.18) : (0.96 + offlineContrast * 0.12);
      } else if (combo === 'drop') {
        phiAmp *= 0.96 + offlineContrast * 0.28;
      } else if (combo === 'accent') {
        rollAmp *= 1.02 + offlineContrast * 0.34;
        zoomAmp *= 0.72 + offlineContrast * 0.20;
      }
      var peakTame = Math.pow(clamp01((visualImpact - 0.76) / 0.24), 1.35);
      if (peakTame > 0) {
        var downbeatTame = combo === 'downbeat' ? 1.0 : 0.58;
        amp *= 1 - peakTame * (0.070 + downbeatTame * 0.050);
        zoomAmp *= 1 - peakTame * (0.060 + downbeatTame * 0.050);
        phiAmp *= 1 - peakTame * 0.035;
        release *= 1 - peakTame * 0.045;
      }
      if (visualImpact < 0.12 && liveSectionGate < 0.18) {
        var softScale = Math.min(1, weakSectionScale * (0.72 + visualImpact * 1.10));
        amp *= softScale;
        zoomAmp *= 0.58 + softScale * 0.34;
        phiAmp *= 0.62 + softScale * 0.30;
        thetaAmp *= 0.62 + softScale * 0.28;
        rollAmp *= 0.66 + softScale * 0.24;
        release *= 0.86 + softScale * 0.16;
      }
    }
  } else if (combo === 'downbeat') {
    amp *= 1.10;
    zoomAmp *= 1.18;
    phiAmp *= 0.72;
  } else if (combo === 'push') {
    amp *= 0.84;
    zoomAmp *= 0.88;
    phiAmp *= 0.62;
  } else if (combo === 'drop') {
    amp *= 0.96;
    zoomAmp *= 0.72;
    phiAmp *= 1.22;
  } else if (combo === 'rebound') {
    amp *= 0.74;
    zoomAmp *= 0.62;
    phiAmp *= 0.78;
  } else if (combo === 'accent') {
    amp *= 1.14;
    zoomAmp *= 1.08;
    rollAmp *= 1.35;
  }
  if (livePreview && !dj) {
    var previewTone = clamp01(visualImpact * 0.54 + rawLowTone * 0.22 + confidence * 0.18 + strength * 0.06);
    amp *= 0.72 + previewTone * 0.16;
    zoomAmp *= 0.62 + previewTone * 0.18;
    phiAmp *= 0.70 + previewTone * 0.12;
    thetaAmp *= 0.70 + previewTone * 0.12;
    rollAmp *= 0.54 + previewTone * 0.16;
    release *= 1.08 + previewTone * 0.08;
  }
  if (dj && isDjMapSource && amp > 0.74) amp = 0.74 + (amp - 0.74) * 0.56;
  if (dj && isDjMapSource && zoomAmp > 0.30) zoomAmp = 0.30 + (zoomAmp - 0.30) * 0.52;
  amp = Math.max(dj ? (isDjMapSource ? 0.018 : 0.040) : 0.08, Math.min(dj ? (isDjMapSource ? 0.92 : 0.34) : 0.68, amp));
  if (isLiveSource) {
    var liveMinInterval = dj ? Math.max(0.315, Math.min(0.500, rtBeat.tempoGap ? rtBeat.tempoGap * 0.62 : 0.360)) : beatCam.realtimeMinInterval;
    if (time - beatCam.lastRealtimeAt < liveMinInterval && strength < (dj ? 0.74 : 0.78)) {
      beatCam.stats.liveBlocked++;
      return;
    }
    beatCam.lastRealtimeAt = time;
    if (mergeRealtimeBeatCamera(time, amp, {
      zoomAmp: zoomAmp, thetaAmp: thetaAmp, phiAmp: phiAmp, rollAmp: rollAmp, mode: mode,
      low: lowTone, body: bodyTone, snap: snapTone, dj: dj
    })) {
      beatCam.lastTriggerAt = Math.max(beatCam.lastTriggerAt, time);
      return;
    }
    for (var ei = beatCam.events.length - 1; ei >= 0; ei--) {
      var pending = beatCam.events[ei];
      if (pending.source === 'map' && pending.hit > time && pending.hit - time < beatCam.realtimeMergeWindow) {
        beatCam.events.splice(ei, 1);
      }
    }
  }
  if (isDjMapSource) {
    var djGap = time - beatCam.lastTriggerAt;
    var djMinGap = Math.max(0.255, Math.min(0.470, (beat && beat.step ? beat.step * 0.52 : 0.320)));
    if (djGap < djMinGap && strength < 0.86) return;
    beatCam.lastTriggerAt = time;
    beatCam.stats.map++;
  } else if (!isLiveSource) {
    var gap = time - beatCam.lastTriggerAt;
    var minGap = beatCam.minInterval;
    if (isMapSource && isPrimary) minGap *= 0.82;
    if (gap < minGap && strength < 0.88) return;
    beatCam.lastTriggerAt = time;
    beatCam.stats.map++;
  } else {
    beatCam.lastTriggerAt = Math.max(beatCam.lastTriggerAt, time);
    beatCam.stats.live++;
  }
  beatCam.events.push({
    start: isLiveSource ? nowT - attack * 0.42 : nowT + (time - nowT) - attack,
    hit: time,
    amp: amp,
    attack: attack,
    hold: hold,
    release: release,
    zoomAmp: zoomAmp,
    thetaAmp: thetaAmp,
    phiAmp: phiAmp,
    rollAmp: rollAmp,
    mode: mode,
    combo: combo,
    phase: idx * 2.399963 + (snapTone - lowTone) * 1.4,
    low: lowTone,
    body: bodyTone,
    snap: snapTone,
    mass: mass,
    source: source || 'map',
    dj: dj
  });
  var maxEvents = djMode.active ? 12 : 8;
  if (beatCam.events.length > maxEvents) beatCam.events.splice(0, beatCam.events.length - maxEvents);
}

function updateBeatCamera(dt) {
  var t = audio ? audio.currentTime : uniforms.uTime.value;
  if (!audio || audio.paused) {
    beatCam.punch *= Math.pow(0.08, dt);
    beatCam.thetaKick *= Math.pow(0.05, dt);
    beatCam.phiKick *= Math.pow(0.05, dt);
    beatCam.radiusKick *= Math.pow(0.05, dt);
    beatCam.rollKick *= Math.pow(0.05, dt);
    beatCam.events.length = 0;
    beatCam.prevAudioTime = t;
    return;
  }
  if (beatCam.prevAudioTime >= 0 && Math.abs(t - beatCam.prevAudioTime) > 0.55) {
    if (djMode.active) syncPodcastDjMapCursor(t, false);
    else syncBeatCameraToTime(t);
  }
  beatCam.prevAudioTime = t;

  var punch = 0;
  var thetaKick = 0;
  var phiKick = 0;
  var radiusKick = 0;
  var rollKick = 0;
  var leadEvent = null;
  var leadPunch = 0;
  var leadVal = 0;
  for (var i = beatCam.events.length - 1; i >= 0; i--) {
    var ev = beatCam.events[i];
    var attack = ev.attack || beatCam.attack;
    var hold = ev.hold || beatCam.hold;
    var release = ev.release || beatCam.release;
    var local = t - ev.start;
    var val = 0;
    if (local < 0) {
      val = 0;
    } else if (local < attack) {
      val = easeBeatCamera(local / attack);
    } else if (local < attack + hold) {
      val = 1;
    } else if (local < attack + hold + release) {
      var r = (local - attack - hold) / release;
      val = 1 - easeBeatCamera(r);
    } else {
      beatCam.events.splice(i, 1);
      continue;
    }
    var evPunch = val * ev.amp;
    punch = Math.max(punch, evPunch);
    if (evPunch > leadPunch) {
      leadEvent = ev;
      leadPunch = evPunch;
      leadVal = val;
    }
  }
  if (leadEvent) {
    var sign = Math.sin(leadEvent.phase) >= 0 ? 1 : -1;
    var snapFlick = 1.0 - Math.min(1, Math.max(0, leadVal - 0.25) / 0.75);
    var combo = leadEvent.combo || 'downbeat';
    if (combo === 'downbeat') {
      radiusKick = leadPunch * leadEvent.zoomAmp;
      phiKick = -leadPunch * 0.0032;
    } else if (combo === 'push') {
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.72;
      phiKick = -leadPunch * 0.0014;
    } else if (combo === 'drop') {
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.46;
      phiKick = leadPunch * leadEvent.phiAmp * 0.92;
    } else if (combo === 'rebound') {
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.30;
      phiKick = -leadPunch * leadEvent.phiAmp * 0.22;
    } else if (combo === 'accent') {
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.90;
      phiKick = -leadPunch * 0.0022;
      rollKick = sign * leadPunch * (leadEvent.rollAmp || 0) * (0.45 + snapFlick * 0.30);
    } else if (leadEvent.mode === 'deep') {
      radiusKick = leadPunch * leadEvent.zoomAmp;
      phiKick = -leadPunch * 0.003;
    }
    if (leadEvent.dj) {
      var djSide = sign * leadPunch * (leadEvent.thetaAmp || 0.0012) * (0.70 + (leadEvent.body || 0) * 0.65 + (leadEvent.snap || 0) * 0.35);
      thetaKick += djSide;
      if (leadEvent.mode === 'snap' || combo === 'accent') {
        rollKick += sign * leadPunch * (leadEvent.rollAmp || 0.003) * (0.52 + snapFlick * 0.34);
      }
      if (combo === 'downbeat') radiusKick *= 1.06;
      else if (combo === 'drop') phiKick *= 1.18;
      punch = Math.min(0.90, punch * (1.04 + (leadEvent.mass || 0) * 0.10));
    }
  }
  var djEase = djMode.active;
  beatCam.punch += (punch - beatCam.punch) * (punch > beatCam.punch ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
  beatCam.thetaKick += (thetaKick - beatCam.thetaKick) * (Math.abs(thetaKick) > Math.abs(beatCam.thetaKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
  beatCam.phiKick += (phiKick - beatCam.phiKick) * (Math.abs(phiKick) > Math.abs(beatCam.phiKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
  beatCam.radiusKick += (radiusKick - beatCam.radiusKick) * (radiusKick > beatCam.radiusKick ? (djEase ? 0.82 : 0.72) : (djEase ? 0.40 : 0.34));
  beatCam.rollKick += (rollKick - beatCam.rollKick) * (Math.abs(rollKick) > Math.abs(beatCam.rollKick) ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
}

function unlockCenteredView() {
  orbit.centerLocked = false;
}

function clearCenteredViewOffsets() {
  pointerTarget.x = 0;
  pointerTarget.y = 0;
  pointerParallax.x = 0;
  pointerParallax.y = 0;
  mouseWorld.set(-999, -999, 0);
  mouseActive = false;
  headParallax.x = 0;
  headParallax.y = 0;
  headParallax.active = false;
  headNeutral = null;
  if (typeof gestureRotation !== 'undefined') {
    gestureRotation.x = 0;
    gestureRotation.y = 0;
  }
  if (typeof particleSpin !== 'undefined') {
    particleSpin.vx = 0;
    particleSpin.vy = 0;
  }
  if (typeof pinchState !== 'undefined') pinchState.active = false;
  if (typeof particlePointerSpin !== 'undefined') particlePointerSpin.active = false;
  if (typeof resetParticleRotationTarget === 'function') resetParticleRotationTarget(false);
  if (typeof uniforms !== 'undefined' && uniforms.uHandActive) {
    uniforms.uHandActive.value = 0;
    uniforms.uHandXY.value.set(-999, -999);
    if (uniforms.uGestureGrip) uniforms.uGestureGrip.value = 0;
  }
}

function updateCamera() {
  if (applyFreeCameraToCamera()) return;
  if (orbit.recentering) {
    orbit.userTheta  += (orbit.baselineTheta - orbit.userTheta)  * 0.04;
    orbit.userPhi    += (orbit.baselinePhi   - orbit.userPhi)    * 0.04;
    orbit.userRadius += (orbit.baselineRadius- orbit.userRadius) * 0.04;
    if (Math.abs(orbit.userTheta - orbit.baselineTheta) < 0.005 &&
        Math.abs(orbit.userPhi - orbit.baselinePhi) < 0.005 &&
        Math.abs(orbit.userRadius - orbit.baselineRadius) < 0.05) {
      orbit.userTheta = orbit.baselineTheta;
      orbit.userPhi   = orbit.baselinePhi;
      orbit.userRadius= orbit.baselineRadius;
      orbit.recentering = false;
    }
  }

  // v8: focus 优先, 否则用 user + cine 复合姿态
  var fa = orbit.focus.active;
  var targetTheta, targetPhi, targetRadius, tLookAt;
  if (fa) {
    targetTheta = orbit.focus.theta;
    targetPhi   = orbit.focus.phi;
    targetRadius = orbit.focus.radius;
    tLookAt = orbit.focus.lookAt;
  } else if (orbit.centerLocked) {
    targetTheta = orbit.baselineTheta + orbit.cineTheta;
    targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.baselinePhi + orbit.cinePhi));
    targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.baselineRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  } else {
    targetTheta = orbit.userTheta + orbit.cineTheta;
    targetPhi   = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.userPhi + orbit.cinePhi));
    targetRadius= Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  }
  // 丝滑变速: 线性 lerp 自然给出 "快→慢" 缓出曲线
  var focusEase = fa ? 0.16 : 0.10;
  var radiusEase = fa ? 0.12 : 0.07;
  if (beatCam.punch > 0.01) {
    focusEase = Math.max(focusEase, 0.12 + beatCam.punch * 0.12);
    radiusEase = Math.max(radiusEase, 0.09 + beatCam.punch * 0.12);
  }
  orbit.theta  += (targetTheta  - orbit.theta)  * focusEase;
  orbit.phi    += (targetPhi    - orbit.phi)    * focusEase;
  orbit.radius += (targetRadius - orbit.radius) * radiusEase;
  orbit.lookAt.x += (tLookAt.x - orbit.lookAt.x) * focusEase;
  orbit.lookAt.y += (tLookAt.y - orbit.lookAt.y) * focusEase;
  orbit.lookAt.z += (tLookAt.z - orbit.lookAt.z) * focusEase;

  var cy = Math.cos(orbit.phi), sy = Math.sin(orbit.phi);
  var ct = Math.cos(orbit.theta), st = Math.sin(orbit.theta);
  camera.position.set(
    orbit.lookAt.x + orbit.radius * cy * st,
    orbit.lookAt.y + orbit.radius * sy,
    orbit.lookAt.z + orbit.radius * cy * ct
  );
  camera.lookAt(orbit.lookAt);
  var cameraShake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  camera.rotation.z += beatCam.rollKick * cameraShake;

  var cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
  var targetFOV = BASE_FOV - cameraPunch * (djMode.active ? 2.62 : 2.35);
  var fovEase = targetFOV < camera.fov ? 0.24 : 0.12;
  camera.fov += (targetFOV - camera.fov) * fovEase;
  camera.updateProjectionMatrix();
  camPunch *= 0.86;
}

// 焦点跟拍 (hover 0.5s 后镜头移到目标)
var focusHover = { wantType: null, pendingTimer: null, exitTimer: null };
function shouldUseWallpaperSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === 5);
}
function shouldUseSkullSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === SKULL_PRESET_INDEX);
}
function shouldUseWallpaperLyricCameraLock() {
  return !!(fx && Number(fx.preset) === 5 && fx.lyricCameraLock);
}
function requestStageLyricCameraSnap(frames) {
  if (typeof stageLyrics === 'undefined' || !stageLyrics) return;
  stageLyrics.snapCameraLockFrames = Math.max(stageLyrics.snapCameraLockFrames || 0, frames || 8);
}
function shouldDimWallpaperForShelf() {
  if (!shouldUseWallpaperSafeShelfCamera()) return false;
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return true;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
function shouldOffsetLyricsForShelfDetail() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
function shouldAvoidStageLyricsForShelf() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfAlwaysVisible()) return true;
  if (shelfPinnedOpen) return true;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return true;
  return !!(shelfVisibility > 0.24 || (shelfHoverCue && shelfHoverCue.value > 0.28));
}
function activateFocusZone(type) {
  unlockCenteredView();
  orbit.focus.active = true;
  orbit.focus.type = type;
  var shelfProfile = shelfLayoutProfile();
  if (type === 'shelf-side') {
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta  = shelfProfile.portrait ? 0.18 : 0.24;
      orbit.focus.phi    = shelfProfile.portrait ? 0.00 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.74 : 5.32;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.04 : 2.24, -0.08, 0.78);
      camPunch = Math.max(camPunch, 0.28);
      requestStageLyricCameraSnap(10);
    } else {
      // 侧栏 (右): 近一点、侧一点，让歌单架打开时有明确的镜头推近。
      orbit.focus.theta  = shelfProfile.portrait ? 0.24 : 0.42;
      orbit.focus.phi    = shelfProfile.portrait ? -0.06 : -0.12;
      orbit.focus.radius = shelfProfile.portrait ? 5.28 : 4.20;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.08 : 2.32, shelfProfile.portrait ? -0.18 : -0.10, 0.72);
      camPunch = Math.max(camPunch, 0.82);
    }
  } else if (type === 'shelf-detail') {
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta  = shelfProfile.portrait ? 0.16 : 0.26;
      orbit.focus.phi    = shelfProfile.portrait ? -0.02 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.88 : 5.18;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.72 : 2.28, shelfProfile.portrait ? -0.36 : -0.32, 0.84);
      camPunch = Math.max(camPunch, 0.30);
      requestStageLyricCameraSnap(10);
    } else {
      orbit.focus.theta  = shelfProfile.portrait ? 0.16 : 0.34;
      orbit.focus.phi    = shelfProfile.portrait ? -0.03 : -0.06;
      orbit.focus.radius = shelfProfile.portrait ? 5.90 : 4.86;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.62 : 1.74, shelfProfile.portrait ? -0.08 : 0.02, 0.82);
      camPunch = Math.max(camPunch, 0.38);
    }
  } else if (type === 'shelf-stage') {
    // 舞台: 居中仰拍
    orbit.focus.theta  = 0.0;
    orbit.focus.phi    = shelfProfile.portrait ? -0.24 : -0.32;
    orbit.focus.radius = shelfProfile.portrait ? 4.8 : 3.8;
    orbit.focus.lookAt.set(0, shelfProfile.portrait ? -1.86 : -1.7, 0.8);
  } else if (type === 'queue') {
    // 队列在左侧 HTML 面板, 相机微微左移 + 抬升
    orbit.focus.theta  = 0.40;
    orbit.focus.phi    = 0.05;
    orbit.focus.radius = 5.8;
    orbit.focus.lookAt.set(-1.2, 0, 0);
  }
}
function setFocusZone(type, immediate) {
  if (type && !shouldUseShelfDynamicCamera(type)) {
    if (/^shelf-/.test(String(orbit.focus.type || ''))) orbit.focus.active = false;
    type = null;
  }
  if (focusHover.wantType === type) return;
  focusHover.wantType = type;
  if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
  if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  if (!type) {
    // 立刻退出 focus, 让相机回主姿态 (但插值是平滑的)
    var exitDelay = orbit.focus.type === 'queue' ? PEEK_HIDE_DELAY : 120;
    focusHover.exitTimer = setTimeout(function(){
      focusHover.exitTimer = null;
      if (!focusHover.wantType) orbit.focus.active = false;
    }, exitDelay);
    return;
  }
  if (immediate) {
    activateFocusZone(type);
    return;
  }
  // 延迟 500ms 激活
  focusHover.pendingTimer = setTimeout(function(){
    focusHover.pendingTimer = null;
    if (focusHover.wantType !== type) return;
    activateFocusZone(type);
  }, 260);
}

// 电影镜头 v8: 振幅大幅减小, 节拍 punch 加冷却 + 强度门槛
//   - cineTheta/Phi 是非常缓慢的低频漂移, 不再让人 motion sick
//   - punch zoom 只在 真·强主拍 触发, 至少间隔 0.45s, 振幅 ×0.5
var lastCamPunchAt = -10;
var CAM_PUNCH_MIN_INTERVAL = 0.45;     // 秒
var CAM_PUNCH_BEAT_THRESHOLD = 0.55;   // 必须够强才触发
function updateCinema(dt) {
  cinemaT += dt;
  updateBeatCamera(dt);
  if (!fx.cinema) {
    orbit.cineTheta  *= 0.95;
    orbit.cinePhi    *= 0.95;
    orbit.cineRadius *= 0.95;
    return;
  }
  var damp = orbit.rotating ? 0.25 : 1.0;
  // v8: 振幅减半, 周期更长 (更优雅)
  var dj = djMode.active;
  var shake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  var beatDamp = (orbit.focus.active ? (dj ? 0.66 : 0.55) : (dj ? 1.12 : 1.0)) * shake;
  var idleDamp = damp * (dj ? 0.72 : 1.0) * shake;
  orbit.cineTheta  = Math.sin(cinemaT * 0.08) * 0.012 * idleDamp + beatCam.thetaKick * beatDamp;
  orbit.cinePhi    = Math.sin(cinemaT * 0.06 + 1.0) * 0.010 * idleDamp + beatCam.phiKick * beatDamp;
  orbit.cineRadius = Math.sin(cinemaT * 0.04 + 2.0) * 0.080 * idleDamp - beatCam.radiusKick * beatDamp * (dj ? 1.22 : 1.18);
}
updateCamera();

function recenterCamera() {
  orbit.centerLocked = true;
  orbit.recentering = true;
  clearCenteredViewOffsets();
  if (typeof skullWheelZoomTarget !== 'undefined') {
    skullWheelZoomTarget = 0;
    if (!(fx && fx.preset === SKULL_PRESET_INDEX)) skullWheelZoom = 0;
  }
  // 同时解除任何镜头跟拍
  if (focusHover) {
    focusHover.wantType = null;
    if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
    if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  }
  orbit.focus.active = false;
  if (fx && fx.preset === SKULL_PRESET_INDEX) {
    resetSkullPresetView(false, { smooth:true, keepLyricLock:true });
  } else {
    resetSkullPresetView(true);
  }
  if (!(fx && fx.preset === SKULL_PRESET_INDEX) && ((fx && fx.lyricCameraLock) || shouldUseWallpaperLyricCameraLock())) requestStageLyricCameraSnap(14);
  showToast('视角回正');
}

function hasActivePlaybackControls() {
  return !!(playing || (audio && !audio.paused) || (Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx]));
}

function setControlsHidden(hidden) {
  var bar = document.getElementById('bottom-bar');
  if (!bar) return;
  if (hidden && (controlsHovering || miniQueueOpen)) hidden = false;
  bar.classList.toggle('soft-hidden', !!hidden && controlsAutoHide && bar.classList.contains('visible'));
  bar.style.pointerEvents = '';
  updateControlsChromeState();
}

function isBottomControlsSuppressedForShelf() {
  var shelfContentOpen = false;
  try {
    shelfContentOpen = !!(typeof shelfManager !== 'undefined' && shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
  } catch (e) {}
  return !!(shelfPinnedOpen || shelfContentOpen || (controlsShelfSuppressUntil && performance.now() < controlsShelfSuppressUntil));
}

function suppressBottomControlsForShelf(duration) {
  controlsShelfSuppressUntil = performance.now() + (duration == null ? 900 : duration);
  controlsHovering = false;
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  document.body.classList.remove('controls-handle-awake');
  if (miniQueueOpen) closeMiniQueue();
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.remove('visible', 'soft-hidden');
    bar.style.pointerEvents = '';
  }
  updateControlsChromeState();
}

function scheduleControlsHide(delay) {
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  if (!controlsAutoHide) return;
  controlsHideTimer = setTimeout(function(){
    controlsHideTimer = null;
    if (!controlsHovering) setControlsHidden(true);
  }, delay == null ? 480 : delay);
}

function revealBottomControls(delay) {
  if (document.body.classList.contains('home-controls-locked')) return;
  var bar = document.getElementById('bottom-bar');
  if (isBottomControlsSuppressedForShelf()) return;
  if (bar) bar.classList.add('visible');
  wakeBottomHandle();
  setControlsHidden(false);
  if (controlsAutoHide) scheduleControlsHide(delay == null ? 520 : delay);
}

function updateControlsChromeState() {
  var bar = document.getElementById('bottom-bar');
  var handle = document.getElementById('bottom-handle');
  var active = !!(bar && bar.classList.contains('visible') && !bar.classList.contains('soft-hidden'));
  document.body.classList.toggle('controls-visible', active);
  if (handle) handle.classList.toggle('active', active);
}

function wakeBottomHandle(duration) {
  document.body.classList.add('controls-handle-awake');
  if (controlsHandleDimTimer) clearTimeout(controlsHandleDimTimer);
  controlsHandleDimTimer = setTimeout(function(){
    controlsHandleDimTimer = null;
    document.body.classList.remove('controls-handle-awake');
  }, duration == null ? 2000 : duration);
}

function forcePlaybackControlsInteractive() {
  if (!hasActivePlaybackControls()) return;
  try {
    document.body.classList.remove('home-controls-locked');
    var bar = document.getElementById('bottom-bar');
    if (bar) {
      bar.style.pointerEvents = '';
      if (!controlsAutoHide) {
        bar.classList.add('visible');
        bar.classList.remove('soft-hidden');
      }
    }
    ['play-btn', 'prev-btn', 'next-btn', 'mini-queue-btn', 'heart-btn', 'play-mode-btn', 'collect-btn'].forEach(function(id){
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove('busy');
    });
    updateControlsChromeState();
    if (bar && bar.classList.contains('visible') && controlsAutoHide && !controlsHovering) scheduleControlsHide(220);
  } catch (e) {
    console.warn('[PlaybackControlsRestore]', e);
  }
}

function toggleBottomControlsFromHandle() {
  var bar = document.getElementById('bottom-bar');
  if (!bar || document.body.classList.contains('home-controls-locked')) return;
  if (isBottomControlsSuppressedForShelf()) return;
  revealBottomControls(900);
}

function updateControlsAutoHideFromPointer(x, y) {
  if (document.body.classList.contains('home-controls-locked')) return;
  if (isBottomControlsSuppressedForShelf()) return;
  var bar = document.getElementById('bottom-bar');
  if (!bar) return;
  var handle = document.getElementById('bottom-handle');
  var hr = handle ? handle.getBoundingClientRect() : null;
  var phoneShell = document.body.classList.contains('phone-shell');
  var phoneLandscape = document.body.classList.contains('phone-landscape');
  var handlePadX = phoneShell ? (phoneLandscape ? 48 : 36) : 18;
  var handlePadY = phoneShell ? (phoneLandscape ? 18 : 22) : 12;
  var overHandle = hr && x >= hr.left - handlePadX && x <= hr.right + handlePadX && y >= hr.top - handlePadY && y <= hr.bottom + handlePadY;
  var bottomBand = phoneShell ? (phoneLandscape ? 72 : 110) : 64;
  var nearBottom = y > (innerHeight - bottomBand);
  if (!bar.classList.contains('visible')) {
    if (overHandle || nearBottom) {
      if (overHandle) wakeBottomHandle();
      revealBottomControls(overHandle ? 900 : 700);
    }
    return;
  }
  if (!controlsAutoHide) { setControlsHidden(false); return; }
  if (diyPlayerMode) {
    var fxPanel = document.getElementById('fx-panel');
    var fxFab = document.getElementById('fx-fab');
    var fr = fxPanel ? fxPanel.getBoundingClientRect() : null;
    var br = fxFab ? fxFab.getBoundingClientRect() : null;
    var overFxPanel = fxPanel && (fxPanel.classList.contains('peek') || fxPanel.classList.contains('show')) && fr && x >= fr.left - 18 && x <= fr.right + 18 && y >= fr.top - 18 && y <= fr.bottom + 18;
    var overFxFab = br && x >= br.left - 18 && x <= br.right + 18 && y >= br.top - 18 && y <= br.bottom + 18;
    if (overFxPanel || overFxFab) {
      scheduleControlsHide(80);
      return;
    }
  }
  controlsLastMoveAt = performance.now();
  var rect = bar.getBoundingClientRect();
  var overBar = x >= rect.left - 18 && x <= rect.right + 18 && y >= rect.top - 18 && y <= rect.bottom + 14;
  var mini = document.getElementById('mini-queue-popover');
  var miniRect = mini ? mini.getBoundingClientRect() : null;
  var overMini = miniQueueOpen && miniRect && x >= miniRect.left - 16 && x <= miniRect.right + 16 && y >= miniRect.top - 16 && y <= miniRect.bottom + 16;
  if (overHandle) wakeBottomHandle();
  if (overBar || overMini || overHandle || nearBottom) revealBottomControls(overHandle ? 900 : 520);
  else scheduleControlsHide(70);
}

function toggleControlsAutoHide() {
  controlsAutoHide = !controlsAutoHide;
  saveBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, controlsAutoHide);
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', controlsAutoHide);
  setControlsHidden(false);
  if (controlsAutoHide) {
    scheduleControlsHide(520);
    showToast('控制条自动隐藏已开启');
  } else {
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    showToast('控制条保持显示');
  }
}

function applyControlsAutoHidePreference() {
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', !!controlsAutoHide);
  if (!controlsAutoHide && controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  setControlsHidden(false);
}

(function initControlsAutoHide() {
  var bar = document.getElementById('bottom-bar');
  var handle = document.getElementById('bottom-handle');
  if (!bar) return;
  function enterControls(){
    controlsHovering = true;
    wakeBottomHandle();
    setControlsHidden(false);
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
  }
  function leaveControls(){
    controlsHovering = false;
    scheduleControlsHide(70);
    wakeBottomHandle(900);
  }
  bar.addEventListener('mouseenter', enterControls);
  bar.addEventListener('mouseleave', leaveControls);
  if (handle) {
    handle.addEventListener('mouseenter', function(){
      controlsHovering = true;
      revealBottomControls(900);
    });
    handle.addEventListener('mouseleave', leaveControls);
    handle.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); toggleBottomControlsFromHandle(); });
  }
  updateControlsChromeState();
})();

function isCursorAutoHideMode() {
  return !document.hidden;
}

function clearCursorAutoHideTimer() {
  if (cursorHideTimer) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
  }
}

function setCursorHidden(hidden) {
  document.body.classList.toggle('cursor-hidden', !!hidden && isCursorAutoHideMode());
}

function scheduleCursorHide(delay) {
  clearCursorAutoHideTimer();
  if (!isCursorAutoHideMode()) {
    setCursorHidden(false);
    return;
  }
  cursorHideTimer = setTimeout(function(){
    cursorHideTimer = null;
    setCursorHidden(true);
  }, delay == null ? CURSOR_HIDE_DELAY : delay);
}

function revealCursorForActivity() {
  if (!isCursorAutoHideMode()) {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
    return;
  }
  setCursorHidden(false);
  scheduleCursorHide(CURSOR_HIDE_DELAY);
}

function syncCursorAutoHideMode() {
  if (isCursorAutoHideMode()) revealCursorForActivity();
  else {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
  }
}

['mousemove', 'pointermove', 'mousedown', 'wheel', 'touchstart'].forEach(function(type){
  window.addEventListener(type, revealCursorForActivity, { passive:true, capture:true });
});
syncCursorAutoHideMode();

// ============================================================
//  指针 / 拖拽控制
//   v7.1: 用 userOrbit 替代 targetOrbit; 加 drag 距离判断
// ============================================================
var mouseWorld = new THREE.Vector3(-999, -999, 0);
var mouseActive = false;
var mouseDownAt = { x:0, y:0, t:0, hadDrag:false };
var particlePointerSpin = { active:false, lastX:0, lastY:0, lastT:0 };
var particlePointerRay = new THREE.Raycaster();
var particlePointerNdc = new THREE.Vector2();
var particlePointerPlane = new THREE.Plane();
var particlePointerPlanePoint = new THREE.Vector3();
var particlePointerPlaneNormal = new THREE.Vector3();
var particlePointerWorldHit = new THREE.Vector3();
var particlePointerLocalHit = new THREE.Vector3();
var particlePointerQuat = new THREE.Quaternion();
var particlePointerFrame = { dirty:false, ndcX:0, ndcY:0 };
var CLICK_THRESHOLD = 6;  // 像素, 拖动 > 6px 视为 drag
var UI_HIT_SELECTOR = '#search-area,#top-right,#fullscreen-diy-zone,#fx-panel,#fx-fab,#fx-fab-hide-btn,#playlist-panel,#bottom-bar,#thumb-wrap,#empty-home,#visual-guide,#trial-banner,#source-fallback-notice,.modal-mask,#toast,#ai-depth-chip,#beat-chip,#drop-overlay';

function isPointerOverUi(e) {
  if (!e) return false;
  var el = document.elementFromPoint(e.clientX, e.clientY);
  return !!(el && el.closest && el.closest(UI_HIT_SELECTOR));
}

function particleLocalPointFromNdc(ndcX, ndcY, out) {
  particlePointerNdc.set(ndcX, ndcY);
  particlePointerRay.setFromCamera(particlePointerNdc, camera);
  if (particles) {
    particles.updateMatrixWorld(true);
    particles.getWorldPosition(particlePointerPlanePoint);
    particles.getWorldQuaternion(particlePointerQuat);
    particlePointerPlaneNormal.set(0, 0, 1).applyQuaternion(particlePointerQuat).normalize();
    if (Math.abs(particlePointerPlaneNormal.dot(particlePointerRay.ray.direction)) < 0.16) return false;
    particlePointerPlane.setFromNormalAndCoplanarPoint(particlePointerPlaneNormal, particlePointerPlanePoint);
    if (particlePointerRay.ray.intersectPlane(particlePointerPlane, particlePointerWorldHit)) {
      out.copy(particlePointerWorldHit);
      particles.worldToLocal(out);
      return isFinite(out.x) && isFinite(out.y) && Math.abs(out.x) < 8.5 && Math.abs(out.y) < 8.5;
    }
  }
  particlePointerPlaneNormal.set(0, 0, 1);
  particlePointerPlane.set(particlePointerPlaneNormal, 0);
  if (particlePointerRay.ray.intersectPlane(particlePointerPlane, particlePointerWorldHit)) {
    out.copy(particlePointerWorldHit);
    return isFinite(out.x) && isFinite(out.y) && Math.abs(out.x) < 8.5 && Math.abs(out.y) < 8.5;
  }
  return false;
}

function queueParticlePointerFrame(clientX, clientY) {
  var mx = (clientX / innerWidth) * 2 - 1;
  var my = -(clientY / innerHeight) * 2 + 1;
  pointerTarget.x = mx; pointerTarget.y = my;
  particlePointerFrame.ndcX = mx;
  particlePointerFrame.ndcY = my;
  particlePointerFrame.dirty = true;
}

function updateParticlePointerFrame() {
  if (!particlePointerFrame.dirty) return;
  particlePointerFrame.dirty = false;
  if (particleLocalPointFromNdc(particlePointerFrame.ndcX, particlePointerFrame.ndcY, particlePointerLocalHit)) {
    mouseWorld.x = particlePointerLocalHit.x;
    mouseWorld.y = particlePointerLocalHit.y;
    mouseActive = true;
  } else {
    mouseWorld.set(-999, -999, 0);
    mouseActive = false;
  }
}

function beginParticlePointerDrag(e) {
  if (e.button === 2) return;
  if (isPointerOverUi(e)) return;
  markRenderInteraction('canvas-drag', 1200);
  idleGuidePointerDown(e);
  orbit.rotating = true; orbit.last.x = e.clientX; orbit.last.y = e.clientY;
  particlePointerSpin.active = true;
  particlePointerSpin.lastX = e.clientX;
  particlePointerSpin.lastY = e.clientY;
  particlePointerSpin.lastT = performance.now();
  if (typeof particleSpin !== 'undefined') particleSpin.vx = particleSpin.vy = 0;
  mouseDownAt.x = e.clientX; mouseDownAt.y = e.clientY;
  mouseDownAt.t = performance.now(); mouseDownAt.hadDrag = false;
}
renderer.domElement.addEventListener('mousedown', function(e){
  beginParticlePointerDrag(e);
});
window.addEventListener('mousedown', function(e){
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return;
  if (orbit.rotating || e.target === renderer.domElement) return;
  beginParticlePointerDrag(e);
}, true);
window.addEventListener('mousemove', function(e){
  updateControlsAutoHideFromPointer(e.clientX, e.clientY);
  idleGuidePointerMove(e);
  if (freeCamera && freeCamera.active) {
    markRenderInteraction('free-camera', 900);
    var mdx = e.movementX || 0;
    var mdy = e.movementY || 0;
    if ((!mdx && !mdy) && freeCameraPointer.seen) {
      mdx = e.clientX - freeCameraPointer.x;
      mdy = e.clientY - freeCameraPointer.y;
    }
    freeCameraPointer.x = e.clientX;
    freeCameraPointer.y = e.clientY;
    freeCameraPointer.seen = true;
    freeCamera.yaw -= mdx * 0.00125;
    freeCamera.pitch = clampRange(freeCamera.pitch - mdy * 0.00125, -Math.PI * 0.49, Math.PI * 0.49);
    return;
  }
  if (isPointerOverUi(e) && !orbit.rotating) { mouseActive = false; return; }
  if (orbit.rotating) {
    markRenderInteraction('canvas-drag', 900);
    unlockCenteredView();
    var dx = e.clientX - orbit.last.x, dy = e.clientY - orbit.last.y;
    if (particlePointerSpin.active) {
      var nowSpin = performance.now();
      var spinDt = Math.max(1 / 120, Math.min(0.08, (nowSpin - particlePointerSpin.lastT) / 1000 || 1 / 60));
      applyParticleSpinDrag(dx, dy, spinDt);
      particlePointerSpin.lastX = e.clientX;
      particlePointerSpin.lastY = e.clientY;
      particlePointerSpin.lastT = nowSpin;
    }
    orbit.last.x = e.clientX; orbit.last.y = e.clientY;
    // drag 距离判断
    var totalDx = e.clientX - mouseDownAt.x, totalDy = e.clientY - mouseDownAt.y;
    if (Math.sqrt(totalDx*totalDx + totalDy*totalDy) > CLICK_THRESHOLD) mouseDownAt.hadDrag = true;
    if (orbit.recentering) orbit.recentering = false;
  }
  queueParticlePointerFrame(e.clientX, e.clientY);
});
window.addEventListener('mouseup', function(){
  orbit.rotating = false;
  particlePointerSpin.active = false;
  idleGuidePointerUp();
});
renderer.domElement.addEventListener('mouseleave', function(){
  particlePointerFrame.dirty = false;
  mouseWorld.set(-999, -999, 0);
  mouseActive = false;
  idleGuidePointerLeave();
});
renderer.domElement.addEventListener('wheel', function(e){
  if (isPointerOverUi(e)) return;
  e.preventDefault();
  markRenderInteraction('canvas-wheel', 900);
  if (freeCamera && freeCamera.active) {
    freeCamera.fov = clampRange((freeCamera.fov || BASE_FOV) + e.deltaY * 0.018, 26, 72);
    saveFreeCameraState();
    return;
  }
  if (fx && fx.preset === SKULL_PRESET_INDEX && typeof skullWheelZoomTarget !== 'undefined') {
    skullWheelZoomTarget = clampRange(skullWheelZoomTarget + e.deltaY * 0.00155, -0.95, 1.28);
    return;
  }
  idleGuideWheel(e);
  unlockCenteredView();
  orbit.userRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + e.deltaY * 0.005));
  if (orbit.recentering) orbit.recentering = false;
}, { passive:false });

// 双击屏幕回正 — 不命中卡片时
renderer.domElement.addEventListener('dblclick', function(e){
  if (isPointerOverUi(e)) return;
  if (freeCamera && freeCamera.locked) {
    resetFreeCameraToDefault();
    resetSkullPresetView(false, { smooth:true, keepLyricLock:true });
    return;
  }
  if (shelfManager && shelfManager.getMode() !== 'off') {
    var mx = (e.clientX / innerWidth) * 2 - 1;
    var my = -(e.clientY / innerHeight) * 2 + 1;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(mx, my), camera);
    if (shelfManager.raycastCards(rc)) return;
  }
  recenterCamera();
});

// ============================================================
//  粒子点纹理 (干净圆点, 无 glow)
// ============================================================
function makeDotTexture() {
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var ctx = cv.getContext('2d');
  var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  var tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}
var dotTexture = makeDotTexture();

// ============================================================
//  主粒子系统
//   - 5 个 preset, 每个预设走完全不同的 pos 计算
//   - 共享: 封面色采样, 鼠标交互, 粒子大小限制
// ============================================================
var PLANE_SIZE = 4.8;
var RIPPLE_MAX = 12;

var GRID_X = coverParticleGridForResolution(fx.coverResolution), GRID_Y = GRID_X;
var PCOUNT = GRID_X * GRID_Y;
var positions = null, uvs = null, aRand = null;
var coverResolutionReloadTimer = null;
var currentCoverSource = null;
var coverPickerCanvas = null;

function buildCoverParticleGeometry(grid) {
  grid = coverParticleGridForResolution(grid / 118);
  var count = grid * grid;
  var nextGeo = new THREE.BufferGeometry();
  var nextPositions = new Float32Array(count * 3);
  var nextUvs = new Float32Array(count * 2);
  var nextRand = new Float32Array(count);
  var texelStep = 1 / grid;
  for (var i = 0; i < count; i++) {
    var gx = i % grid, gy = Math.floor(i / grid);
    var u = (gx + 0.5) * texelStep, v = (gy + 0.5) * texelStep;
    var px = gx / (grid - 1), py = gy / (grid - 1);
    nextPositions[i*3]   = (px - 0.5) * PLANE_SIZE;
    nextPositions[i*3+1] = (py - 0.5) * PLANE_SIZE;
    nextPositions[i*3+2] = 0;
    nextUvs[i*2]   = u;
    nextUvs[i*2+1] = v;
    nextRand[i]   = Math.random();
  }
  nextGeo.setAttribute('position', new THREE.BufferAttribute(nextPositions, 3));
  nextGeo.setAttribute('aUv',      new THREE.BufferAttribute(nextUvs, 2));
  nextGeo.setAttribute('aRand',    new THREE.BufferAttribute(nextRand, 1));
  nextGeo.userData.grid = grid;
  nextGeo.userData.count = count;
  positions = nextPositions;
  uvs = nextUvs;
  aRand = nextRand;
  return nextGeo;
}

var geo = buildCoverParticleGeometry(GRID_X);

function applyCoverParticleResolution(value, opts) {
  opts = opts || {};
  fx.coverResolution = normalizeCoverResolution(value);
  var grid = coverParticleGridForResolution(fx.coverResolution);
  if (grid === GRID_X && geo && geo.userData && geo.userData.grid === grid) return;
  var oldGeo = geo;
  var nextGeo = buildCoverParticleGeometry(grid);
  geo = nextGeo;
  GRID_X = GRID_Y = grid;
  PCOUNT = grid * grid;
  if (particles) particles.geometry = nextGeo;
  if (bloomParticles) bloomParticles.geometry = nextGeo;
  if (oldGeo && oldGeo !== nextGeo) oldGeo.dispose();
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, 0.18);
  if (opts.reload !== false) scheduleCoverResolutionReload();
}

function scheduleCoverResolutionReload() {
  if (!currentCoverSource || !currentCoverSource.src) return;
  if (coverResolutionReloadTimer) clearTimeout(coverResolutionReloadTimer);
  coverResolutionReloadTimer = setTimeout(function(){
    coverResolutionReloadTimer = null;
    if (!currentCoverSource || !currentCoverSource.src) return;
    if (currentCoverSource.kind === 'url') {
      loadCoverFromUrl(currentCoverSource.src, { trackToken: trackSwitchToken, fromResolutionChange: true });
    } else if (currentCoverSource.kind === 'data') {
      applyCoverDataUrl(currentCoverSource.src, { trackToken: trackSwitchToken, fromResolutionChange: true });
    }
  }, 260);
}

// 涟漪数据纹理 (1×N, RGBA: x, y, age, str)
var rippleData = new Float32Array(RIPPLE_MAX * 4);
var rippleTex  = new THREE.DataTexture(rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType);
rippleTex.magFilter = THREE.NearestFilter; rippleTex.minFilter = THREE.NearestFilter;
var ripples = [];
for (var ri = 0; ri < RIPPLE_MAX; ri++) ripples.push({ x:0, y:0, age:-10, str:0 });

// 封面纹理 + 边缘/深度纹理
var coverTex = new THREE.Texture();
coverTex.minFilter = THREE.LinearFilter; coverTex.magFilter = THREE.LinearFilter;
coverTex.wrapS = THREE.ClampToEdgeWrapping; coverTex.wrapT = THREE.ClampToEdgeWrapping;

var coverEdgeTex = new THREE.Texture();  // R=depth, G=edge, B=fg-mask, A=lum
coverEdgeTex.minFilter = THREE.LinearFilter; coverEdgeTex.magFilter = THREE.LinearFilter;

// 初始 1×1 像素
(function(){
  var c = document.createElement('canvas'); c.width = c.height = 4;
  var x = c.getContext('2d'); x.fillStyle = '#1c1c28'; x.fillRect(0,0,4,4);
  coverTex.image = c; coverTex.needsUpdate = true;
  var d = document.createElement('canvas'); d.width = d.height = 4;
  var dx = d.getContext('2d'); dx.fillStyle = 'rgba(128,0,0,255)'; dx.fillRect(0,0,4,4);
  coverEdgeTex.image = d; coverEdgeTex.needsUpdate = true;
})();

// 前一首封面纹理 (用于切歌渐变)
var prevCoverTex = new THREE.Texture();
prevCoverTex.minFilter = THREE.LinearFilter; prevCoverTex.magFilter = THREE.LinearFilter;
(function(){
  var c = document.createElement('canvas'); c.width = c.height = 4;
  var x = c.getContext('2d'); x.fillStyle = '#1c1c28'; x.fillRect(0,0,4,4);
  prevCoverTex.image = c; prevCoverTex.needsUpdate = true;
})();

var uniforms = {
  uTime:       { value: 0 },
  uBass:       { value: 0 },
  uMid:        { value: 0 },
  uTreble:     { value: 0 },
  uBeat:       { value: 0 },
  uEnergy:     { value: 0 },
  uBurstAmt:   { value: 0 },          // 通用预设切换脉冲 0..1
  uVinylSpin:  { value: 0 },
  uPreset:     { value: 0 },
  uIntensity:  { value: 0.85 },
  uDepth:      { value: 1.0 },
  uPointScale: { value: 1.0 },
  uSpeed:      { value: 1.0 },
  uTwist:      { value: 0 },
  uColorBoost: { value: 1.1 },
  uScatter:    { value: 0 },
  uCoverRes:   { value: 1.0 },
  uBgFade:     { value: 0.20 },
  uBloomStrength:{ value: 0.62 },
  uBloomSize:  { value: 2.65 },
  uTintColor:  { value: new THREE.Color('#9db8cf') },
  uTintStrength:{ value: 0 },
  uCoverTex:   { value: coverTex },
  uPrevCoverTex:{ value: prevCoverTex },
  uColorMixT:  { value: 1.0 },        // 0=显示旧封面 → 1=显示新封面
  uEdgeTex:    { value: coverEdgeTex },
  uRippleTex:  { value: rippleTex },
  uRippleCount:{ value: 0 },
  uDotTex:     { value: dotTexture },
  uHasCover:   { value: 0 },
  uHasDepth:   { value: 0 },
  uEdgeEnabled:{ value: 1 },
  uAiBoost:    { value: 0 },          // AI 深度增益, 当 AI 接管时升至 1
  uMouseXY:    { value: new THREE.Vector2(-999, -999) },
  uMouseActive:{ value: 0 },
  uHandXY:     { value: new THREE.Vector2(-999, -999) },
  uHandActive: { value: 0 },
  uGestureGrip:{ value: 0 },
  uPixel:      { value: renderer.getPixelRatio() },
  uAlpha:      { value: 0 },          // 整体粒子透明度 (启动 fade-in)
  uParticleDim:{ value: 1 },          // 覆盖层打开时只压低粒子背景, 不影响 3D 卡片
  uFloatAlpha: { value: 0 },          // 空场/浮空粒子透明度
  uLoading:    { value: 0 },          // 加载动画混合度 0..1 (1 = 完全聚成圆环)
};
installRenderPowerHooks();
applyRendererPowerMode();

// ----- 顶点 Shader -----
//   v7.1: 律动幅度 ×2.5, Tunnel 自旋, 虚空预设, 切歌颜色渐变
var vs = `
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
uniform float uPreset, uIntensity, uDepth, uPointScale, uSpeed, uTwist;
uniform float uVinylSpin;
uniform float uColorBoost, uScatter, uCoverRes, uBgFade;
uniform float uHasCover, uHasDepth, uEdgeEnabled, uAiBoost;
uniform float uMouseActive, uPixel, uColorMixT, uLoading;
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex, uRippleTex;
uniform int uRippleCount;
uniform vec2 uMouseXY, uHandXY;
uniform float uHandActive, uGestureGrip;
uniform vec3 uTintColor;
uniform float uTintStrength;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

#define PI 3.14159265359

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

vec2 safeCoverUv(vec2 uv) {
  return clamp(uv, vec2(0.0012), vec2(0.9988));
}

vec3 sampleNewCoverColor(vec2 uv) {
  return texture2D(uCoverTex, safeCoverUv(uv)).rgb;
}

vec3 samplePrevCoverColor(vec2 uv) {
  return texture2D(uPrevCoverTex, safeCoverUv(uv)).rgb;
}

vec4 sampleEdgeColor(vec2 uv) {
  return texture2D(uEdgeTex, safeCoverUv(uv));
}

float rippleSumAt(vec2 p, out float maxAmp) {
  float sum = 0.0; maxAmp = 0.0;
  for (int ri = 0; ri < 12; ri++) {
    if (ri >= uRippleCount) break;
    float vCoord = (float(ri) + 0.5) / 12.0;
    vec4 rd = texture2D(uRippleTex, vec2(0.5, vCoord));
    float age = rd.z; float str = rd.w;
    if (str < 0.005 || age < 0.0 || age > 2.0) continue;
    float dx = p.x - rd.x, dy = p.y - rd.y;
    float dist = sqrt(dx*dx + dy*dy);
    float lifeN = age / 2.0;
    float fadeIn  = smoothstep(0.0, 0.06, age);
    float fadeOut = 1.0 - smoothstep(0.7, 1.0, lifeN);
    float env = fadeIn * fadeOut;
    // v7.1: 把幅度放大 — 中心凸起更高更宽
    float bulgeW = 0.55 + age * 0.80;
    float bulge  = exp(-dist*dist / (2.0 * bulgeW * bulgeW)) * (1.0 - smoothstep(0.0, 0.55, lifeN));
    float waveR  = age * 2.10;
    float ringW  = 0.40 + age * 0.22;
    float ring   = exp(-pow((dist - waveR) / ringW, 2.0));
    // v7.1: 提升整体幅度 ×2
    float local  = (bulge * 2.4 + ring * 1.30) * env * str;
    sum += local;
    maxAmp = max(maxAmp, abs(local));
  }
  return sum;
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos;
  vec2 sampleUv = safeCoverUv(aUv);
  // 切歌颜色渐变: 在新旧封面间 mix
  vec3 newCol = sampleNewCoverColor(sampleUv);
  vec3 prevCol = samplePrevCoverColor(sampleUv);
  vec3 coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  vec4 edge = sampleEdgeColor(sampleUv);
  float depthVal = edge.r;
  float edgeVal  = edge.g;
  float fgMask   = edge.b;
  float lumVal   = edge.a;
  float maxRippleAmp = 0.0;
  float rippleZ = 0.0;

  vec3 defaultColor = mix(
    vec3(0.36, 0.28, 0.72),
    mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x),
    aUv.y
  );
  vColor = mix(defaultColor, coverColor, uHasCover);
  vAlpha = 1.0;

  // 律动强度的真实倍数 (放大 intensity 滑块的影响)
  float K = uIntensity * 1.6;   // 滑块 1.0 → K=1.6, 滑块 1.6 → K=2.56

  // ====================================================
  //  Preset 0: SILK — 丝绸 (xy 平面, z 涟漪)
  //  v7.1: 全部位移 ×2.5
  // ====================================================
  if (uPreset < 0.5) {
    pos = position;
    rippleZ = rippleSumAt(pos.xy, maxRippleAmp);

    float midN = snoise(vec3(pos.x*1.4, pos.y*1.4, t*0.55)) * 0.6
               + snoise(vec3(pos.x*2.8+5.0, pos.y*2.8-3.0, t*0.85)) * 0.4;
    float midMask = 0.55 + 0.45 * snoise(vec3(pos.x*0.4, pos.y*0.4, t*0.18));
    float midDisp = midN * uMid * 0.55 * midMask * K;       // 0.20 → 0.55

    float trebleJ = snoise(vec3(pos.x*6.5, pos.y*6.5, t*3.5 + aRand*4.0)) * uTreble * 0.18 * K;  // 0.06→0.18
    float bassBreath = snoise(vec3(pos.x*0.35, pos.y*0.35, t*0.4)) * uBass * 0.42 * K;          // 0.14→0.42

    // AI 深度: 显著强化 (0.85 → 1.4)
    float depthZ = (depthVal - 0.5) * uAiBoost * uDepth * 1.40 * uHasDepth;

    pos.z = rippleZ * 1.30 + midDisp + trebleJ + bassBreath + depthZ;
  }

  // ====================================================
  //  Preset 1: TUNNEL — 隧道 + 自旋
  // ====================================================
  else if (uPreset < 1.5) {
    // v7.1: 整体自旋 — 整管缓慢绕 Z 轴
    float spin = t * 0.12;
    float angle = aUv.x * 2.0 * PI + spin;
    float flow = aUv.y - t * 0.08 * (1.0 + uBass * 0.55);
    flow = fract(flow);
    float zPos = (flow - 0.5) * 9.0;
    float baseR = 2.0 - uBass * 0.28 * K;                  // bass 收缩更明显
    float ripG  = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;   // 0.04→0.10
    float r = baseR + ripG;
    pos.x = cos(angle) * r;
    pos.y = sin(angle) * r;
    pos.z = zPos;

    sampleUv = vec2(aUv.x, flow);
    sampleUv = safeCoverUv(sampleUv);
    newCol = sampleNewCoverColor(sampleUv);
    prevCol = samplePrevCoverColor(sampleUv);
    coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
    vColor = mix(defaultColor, coverColor, uHasCover);

    float depthFade = smoothstep(-4.5, 4.5, zPos);
    vColor *= 0.4 + depthFade * 0.7;
  }

  // ====================================================
  //  Preset 2: ORBIT — 星球 (保留自转)
  //  v7.1: 律动幅度加大
  // ====================================================
  else if (uPreset < 2.5) {
    float theta = aUv.x * 2.0 * PI;
    float phi   = (aUv.y - 0.5) * PI;
    float baseR = 2.2;
    float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;   // 0.40→0.85
    float bassExpand = uBass * 0.35 * K;                                                      // 0.18→0.35
    float r = baseR * (1.0 + bassExpand) + trebFlare;

    pos.x = r * cos(phi) * cos(theta);
    pos.y = r * sin(phi);
    pos.z = r * cos(phi) * sin(theta);

    float yaw = t * 0.18;
    float cy = cos(yaw), sy = sin(yaw);
    pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
  }

  // ====================================================
  //  Preset 3: VOID — 虚空 (无粒子, 适合自定义背景)
  // ====================================================
  else if (uPreset < 3.5) {
    pos = vec3((aUv.x - 0.5) * 0.01, (aUv.y - 0.5) * 0.01, -90.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    maxRippleAmp = 0.0;
  }

  // ====================================================
  //  Preset 4: VINYL RECORD
  //  A real record layout: circular album cover in the center, black vinyl
  //  grooves outside, and a complete white particle rim.
  // ====================================================
  else if (uPreset < 4.5) {
    float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
    float highDrive = smoothstep(0.05, 0.46, uTreble);
    float hiResGuard = smoothstep(1.08, 1.55, uCoverRes);
    float edgeGuard = mix(1.0, 0.38, hiResGuard);
    float depthGuard = mix(1.0, 0.44, hiResGuard);
    float grooveGuard = mix(1.0, 0.48, hiResGuard);
    float beatGuard = mix(1.0, 0.36, hiResGuard);

    vec2 p = (aUv - 0.5) * 5.12;
    float spin = uVinylSpin;
    float cs = cos(spin), sn = sin(spin);
    vec2 rp = mat2(cs, -sn, sn, cs) * p;
    float d = length(p);
    float angle0 = atan(p.y, p.x);
    float recordR = 2.46;
    float coverR = 1.18;
    float recordAlpha = 1.0 - smoothstep(recordR - 0.02, recordR + 0.05, d);
    float coverMask = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
    float border = exp(-pow((d - coverR) / 0.064, 2.0)) * edgeGuard;
    float outerRim = exp(-pow((d - (recordR - 0.050)) / 0.055, 2.0)) * edgeGuard;
    float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);

    pos = vec3(rp * (1.0 + bassDrive * 0.012 * beatGuard + uBeat * 0.026 * beatGuard), 0.0);
    vAlpha = recordAlpha;

    if (coverMask > 0.02) {
      vec2 coverUv = p / (coverR * 2.0) + 0.5;
      newCol = sampleNewCoverColor(coverUv);
      prevCol = samplePrevCoverColor(coverUv);
      coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
      if (hiResGuard > 0.001) {
        vec2 sx = vec2(0.0026, 0.0);
        vec2 sy = vec2(0.0, 0.0026);
        vec3 softNew = (sampleNewCoverColor(coverUv + sx) + sampleNewCoverColor(coverUv - sx) + sampleNewCoverColor(coverUv + sy) + sampleNewCoverColor(coverUv - sy)) * 0.25;
        vec3 softPrev = (samplePrevCoverColor(coverUv + sx) + samplePrevCoverColor(coverUv - sx) + samplePrevCoverColor(coverUv + sy) + samplePrevCoverColor(coverUv - sy)) * 0.25;
        coverColor = mix(coverColor, mix(softPrev, softNew, clamp(uColorMixT, 0.0, 1.0)), hiResGuard * 0.42);
      }
      vColor = mix(defaultColor, coverColor, uHasCover);
      float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR, d));
      vColor *= coverShade;
      vColor = mix(vColor, vec3(1.0), border * 0.54);
      pos.z = 0.040 + border * 0.026 * depthGuard + uBeat * 0.018 * beatGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.30 + bassDrive * 0.075 * beatGuard + uBeat * 0.075 * beatGuard);
    } else {
      float groove = 0.5 + 0.5 * sin((d - coverR) * mix(98.0, 58.0, hiResGuard));
      float fineGroove = 0.5 + 0.5 * sin((d - coverR) * mix(170.0, 92.0, hiResGuard) + aRand * 3.0);
      float tick = smoothstep(0.82, 0.995, hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1));
      vec3 vinyl = vec3(0.052, 0.054, 0.058) + vec3(0.052 * grooveGuard) * groove + vec3(0.026 * grooveGuard) * fineGroove;
      vinyl = mix(vinyl, coverColor * 0.32, 0.18 * (1.0 - vinylN));
      float whiteRing = max(border * 0.92, outerRim * 0.26);
      vColor = mix(vinyl, vec3(0.92, 0.94, 0.94), whiteRing);
      vColor = mix(vColor, vec3(1.0), tick * highDrive * (0.06 + border * 0.12) * grooveGuard);
      pos.z = groove * 0.010 * grooveGuard + border * 0.024 * depthGuard + bassDrive * vinylN * 0.016 * K * beatGuard + tick * highDrive * 0.010 * grooveGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.32 + outerRim * 0.12 + bassDrive * vinylN * 0.11 * beatGuard + tick * highDrive * 0.10 * grooveGuard + uBeat * vinylN * 0.08 * beatGuard);
    }
  }

  // ====================================================
  //  Preset 5: WALLPAPER PULSE
  //  Layered music-particle wallpaper: aurora ribbons, depth sparks,
  //  and cover-colored audio flow.
  // ====================================================
  else {
    float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
    float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;
    float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;
    float lane = aUv.y;
    float transition = clamp(uBurstAmt, 0.0, 1.0);

    if (lane < 0.80) {
      float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
      float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      float band = floor(bandCoord);
      float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
      float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      float seed = hash11(band * 19.17 + aRand * 31.0);
      float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
      float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
      float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
      float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
      float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);
      float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
      float broadWave = sin(ribbonPhase) * 0.92;
      float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
      float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;
      float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
      float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
      float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
      float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
      float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

      pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
      pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
      pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

      float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
      vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
      aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
      vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
      vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
      maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);
    } else {
      float q = (lane - 0.80) / 0.20;
      float seed = hash11(aRand * 917.0 + floor(q * 130.0));
      float depth = mix(-32.0, 18.0, seed);
      float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
      float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
      float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
      float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
      float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
      float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
      float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

      pos = vec3(x, y, z);
      vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
      vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
      maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);
    }

    if (transition > 0.001) {
      float bloom = smoothstep(0.0, 1.0, transition);
      vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
      vec2 burstDir = burstVec / max(length(burstVec), 0.001);
      pos.xy += burstDir * bloom * 0.026;
      pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
      pos.xy *= 1.0 + bloom * 0.014;
      pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
      vAlpha *= 0.86 + bloom * 0.22;
      maxRippleAmp = max(maxRippleAmp, bloom * 0.10);
    }
  }

  // ====================================================
  //  鼠标交互 (仅 SILK)
  // ====================================================
  if (uMouseActive > 0.5 && uPreset < 0.5) {
    float mdx = pos.x - uMouseXY.x;
    float mdy = pos.y - uMouseXY.y;
    float md = sqrt(mdx*mdx + mdy*mdy);
    if (md < 1.0) {
      float push = (1.0 - md) * (1.0 - md);
      pos.z += push * 0.55;
    }
  }

  // ====================================================
  //  v8 手势遮挡 — uHandActive 是 0..1 平滑过渡, 大半径推开
  // ====================================================
  if (uHandActive > 0.01) {
    float hdx = pos.x - uHandXY.x;
    float hdy = pos.y - uHandXY.y;
    float hd = sqrt(hdx*hdx + hdy*hdy);
    float rad = 1.55;
    if (hd < rad) {
      float push = (rad - hd) / rad;
      push = push * push * uHandActive;
      pos.z += push * 1.10;
      vec2 outDir = vec2(hdx, hdy) / max(0.001, hd);
      pos.xy += outDir * push * 0.28;
    }
  }
  if (uGestureGrip > 0.001) {
    float grip = clamp(uGestureGrip, 0.0, 1.0);
    float gripWave = 0.5 + 0.5 * sin(uTime * 2.2 + aRand * 6.2831);
    pos.xy *= mix(1.0, 0.66 + gripWave * 0.035, grip);
    pos.z += grip * (0.18 + uBass * 0.22 + gripWave * 0.10);
  }

  // ====================================================
  //  通用: 离散感 / 扭曲
  // ====================================================
  if (uScatter > 0.001) {
    vec2 jdir = vec2(cos(aRand * 6.2831), sin(aRand * 6.2831));
    pos.xy += jdir * uScatter * (0.05 + uTreble * 0.10);
  }
  if (uTwist > 0.001 && uPreset < 0.5) {
    float ta = uTwist * pos.z * 0.6;
    float cs = cos(ta), sn = sin(ta);
    pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
  }

  // 颜色
  float vinylHiResGuard = smoothstep(1.08, 1.55, uCoverRes) * step(3.5, uPreset) * (1.0 - step(4.5, uPreset));
  float edgeBoost = uEdgeEnabled * edgeVal * mix(1.0, 0.42, vinylHiResGuard);
  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
  float blackParticleGuard = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  vEdgeBoost = edgeBoost * (uPreset > 3.5 ? 0.22 : 1.0) * (1.0 - blackParticleGuard);
  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));
  float edgeColorMix = edgeBoost * (uPreset > 3.5 ? 0.20 : 0.50) * (1.0 - blackParticleGuard);
  vColor = mix(vColor, vColor + vec3(0.20), edgeColorMix);
  float tintLum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tintedColor = uTintColor * max(0.24, tintLum * 1.12);
  vColor = mix(vColor, tintedColor, clamp(uTintStrength, 0.0, 1.0) * (1.0 - blackParticleGuard));

  vBright = 0.82 + maxRippleAmp * 0.55 + uBass * 0.10 + edgeBoost * 0.30 + uEnergy * 0.05 + uBurstAmt * 0.40;
  if (uPreset > 4.5) {
    vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;
  } else if (uPreset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.16 + uBurstAmt * 0.16;
  }
  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  if (uHasDepth > 0.5 && uPreset < 0.5) {
    float bgMul = mix(1.0, 0.55, uBgFade * (1.0 - fgMask));
    vBright *= bgMul;
  }
  vBright += uGestureGrip * 0.22;
  float loadingMistSize = 1.0;

  // 加载形态: 雾状微尘流，避免廉价旋转圆环
  if (uLoading > 0.001) {
    float mistSeed = hash11(aRand * 931.7);
    float mistLayer = floor(mistSeed * 4.0);
    float layerN = (mistLayer + 0.5) / 4.0;
    float mistAngle = aRand * 6.2831 + uTime * (0.16 + mistSeed * 0.18) + snoise(vec3(aRand * 2.1, uTime * 0.24, 2.0)) * 1.85;
    float mistR = mix(1.35, 3.15, sqrt(hash11(aRand * 127.3))) * (1.0 + sin(uTime * 0.42 + aRand * 7.0) * 0.13);
    vec2 mistCurl = vec2(
      snoise(vec3(aRand * 4.1, uTime * 0.32, 3.0)),
      snoise(vec3(aRand * 4.7, uTime * 0.30, 8.0))
    );
    float mistBreath = 0.5 + 0.5 * sin(uTime * (0.82 + mistSeed * 0.55) + aRand * 17.0);
    float mistRibbon = sin(mistAngle * (1.35 + layerN * 0.55) + uTime * 0.34 + mistSeed * 4.0);
    float glowPick = smoothstep(0.88, 0.997, hash11(aRand * 1501.0 + mistLayer * 17.0));
    float dustPick = 0.34 + glowPick * 0.66;
    vec3 mistPos = vec3(
      cos(mistAngle) * mistR * (1.24 + mistCurl.x * 0.16) + mistCurl.x * 0.72,
      sin(mistAngle * 0.82 + mistRibbon * 0.25) * mistR * (0.56 + layerN * 0.10) + mistCurl.y * 0.62,
      (layerN - 0.5) * 4.85 + mistCurl.x * 0.56 + mistBreath * 0.36 + mistRibbon * 0.24
    );
    vec3 mistCol = mix(vec3(0.62, 0.86, 0.84), vec3(0.36, 0.46, 0.78), mistSeed);
    mistCol = mix(mistCol, vec3(0.94, 1.0, 0.97), glowPick * (0.45 + mistBreath * 0.35));
    vColor = mix(vColor, mistCol, uLoading * 0.78);
    vBright = mix(vBright, 0.20 + mistBreath * 0.18 + abs(mistCurl.x) * 0.06 + glowPick * (0.72 + abs(mistRibbon) * 0.24), uLoading);
    vAlpha = mix(vAlpha, 0.08 + mistBreath * 0.11 + dustPick * 0.11 + glowPick * 0.30, uLoading);
    pos = mix(pos, mistPos, uLoading);
    loadingMistSize = 1.26 + mistBreath * 0.24 + abs(mistRibbon) * 0.14 + glowPick * 0.78;
  }

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  float audioBoost = 1.0 + maxRippleAmp * 0.7 + edgeBoost * 0.55 + uBeat * 0.30 + uBurstAmt * 0.5;
  float sz = clamp(depthSize * audioBoost, 1.05, 4.95);
  if (uPreset > 4.5) {
    float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.055;
    sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
  } else if (uPreset > 3.5) {
    float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uBeat * 0.30;
    sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  }
  // 加载态下粒子稍大
  sz = mix(sz, sz * loadingMistSize, uLoading);
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

// ----- 片元 Shader -----
var fs = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);
  col = mix(col, col * 1.2, vRipple * 0.4);
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float nonBlack = 1.0 - keepBlack;
  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;
  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;
  col = mix(col, vec3(0.0), readableRim * lightParticle * 0.38);
  col = mix(col, vec3(1.0), readableRim * darkParticle * 0.20);
  col = clamp(col, vec3(0.0), vec3(1.6));
  gl_FragColor = vec4(col, tex.a * uAlpha * uParticleDim * vAlpha);
}
`;

var material = new THREE.ShaderMaterial({
  uniforms: uniforms, vertexShader: vs, fragmentShader: fs,
  transparent: true, depthWrite: false, blending: THREE.NormalBlending,
});

var bloomVs = vs
  .replace('uniform float uMouseActive, uPixel, uColorMixT, uLoading;', 'uniform float uMouseActive, uPixel, uColorMixT, uLoading, uBloomSize;')
  .replace('gl_PointSize = sz * uPixel * uPointScale;', 'gl_PointSize = sz * uPixel * uPointScale * uBloomSize;');
var bloomFs = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uBloomStrength, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.55 + vBright * 0.62);
  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);
  col = clamp(col, vec3(0.0), vec3(1.8));
  float pulse = 1.0 + vRipple * 0.65;
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float bloomKeep = 1.0 - keepBlack * 0.92;
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * uParticleDim * pulse * 0.55 * vAlpha * bloomKeep);
}
`;
var bloomMaterial = new THREE.ShaderMaterial({
  uniforms: uniforms, vertexShader: bloomVs, fragmentShader: bloomFs,
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
});
var bloomParticles = new THREE.Points(geo, bloomMaterial);
bloomParticles.frustumCulled = false;
bloomParticles.renderOrder = 0;
scene.add(bloomParticles);
var particles = new THREE.Points(geo, material);
particles.frustumCulled = false;
particles.renderOrder = 1;
scene.add(particles);

// ============================================================
//  浮空粒子层 (独立 Points)
//   v7.1: 速度大幅放慢, 改用 sin/cos 长周期漂移 (优雅而非乱飞)
// ============================================================
var FLOAT_COUNT = 1300;
var floatGroup = null;
var floatPositionsArr = null, floatBaseArr = null, floatPhaseArr = null, floatColorArr = null;

function createFloatLayer() {
  fx.floatLayer = false;
  uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
  return;
  if (floatGroup) return;
  var fgeo = new THREE.BufferGeometry();
  floatPositionsArr = new Float32Array(FLOAT_COUNT * 3);
  floatBaseArr      = new Float32Array(FLOAT_COUNT * 3);  // 基准位置
  floatPhaseArr     = new Float32Array(FLOAT_COUNT * 3);  // 每粒子相位 (0..2π)
  floatColorArr     = new Float32Array(FLOAT_COUNT * 3);
  var floatRandArr  = new Float32Array(FLOAT_COUNT);
  var floatAmpArr   = new Float32Array(FLOAT_COUNT);      // 漂移幅度 (0.15-0.45)
  for (var i = 0; i < FLOAT_COUNT; i++) {
    var halo = i < FLOAT_COUNT * 0.76;
    var bx, by, bz;
    if (halo) {
      var a = Math.random() * Math.PI * 2;
      var r = 0.62 + Math.pow(Math.random(), 0.72) * 2.75;
      var lane = (Math.random() - 0.5) * 0.62;
      bx = Math.cos(a) * r;
      by = Math.sin(a) * r * 0.54 + lane;
      bz = (Math.random() - 0.5) * 2.4 - 0.25;
    } else {
      bx = (Math.random() - 0.5) * 8.4;
      by = (Math.random() - 0.5) * 5.8;
      bz = (Math.random() - 0.5) * 5.6;
    }
    floatBaseArr[i*3]   = bx; floatBaseArr[i*3+1] = by; floatBaseArr[i*3+2] = bz;
    floatPositionsArr[i*3]   = bx;
    floatPositionsArr[i*3+1] = by;
    floatPositionsArr[i*3+2] = bz;
    floatPhaseArr[i*3]   = Math.random() * Math.PI * 2;
    floatPhaseArr[i*3+1] = Math.random() * Math.PI * 2;
    floatPhaseArr[i*3+2] = Math.random() * Math.PI * 2;
    floatAmpArr[i] = 0.15 + Math.random() * 0.35;
    var white = 0.88 + Math.random() * 0.12;
    floatColorArr[i*3]   = white;
    floatColorArr[i*3+1] = white;
    floatColorArr[i*3+2] = white;
    floatRandArr[i] = Math.random();
  }
  fgeo.setAttribute('position', new THREE.BufferAttribute(floatPositionsArr, 3));
  fgeo.setAttribute('aColor',   new THREE.BufferAttribute(floatColorArr, 3));
  fgeo.setAttribute('aRand',    new THREE.BufferAttribute(floatRandArr, 1));

  // 把 amp + phase 存到 attribute 让 shader 端做漂移 (避免 JS 每帧改 buffer)
  fgeo.setAttribute('aAmp',     new THREE.BufferAttribute(floatAmpArr, 1));
  fgeo.setAttribute('aPhase',   new THREE.BufferAttribute(floatPhaseArr, 3));

  var fvs = `
    precision highp float;
    uniform float uTime, uBass, uPixel, uFloatAlpha;
    attribute vec3 aColor;
    attribute vec3 aPhase;
    attribute float aRand, aAmp;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec3 pos = position;
      float orbit = uTime * (0.030 + aRand * 0.034);
      float cs = cos(orbit), sn = sin(orbit);
      pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
      float breathe = 1.0 + sin(uTime * 0.34 + aPhase.x) * 0.045;
      pos.xy *= breathe;
      pos.x += sin(uTime * (0.18 + aRand * 0.05) + aPhase.x) * aAmp * 0.34;
      pos.y += cos(uTime * (0.15 + aRand * 0.06) + aPhase.y) * aAmp * 0.30;
      pos.z += sin(uTime * (0.11 + aRand * 0.04) + aPhase.z) * aAmp * 0.68 + uBass * 0.10 * sin(aRand * 12.0);
      vC = aColor;
      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      float dist = -mvPos.z;
      float twinkle = 0.62 + 0.38 * sin(uTime * (0.42 + aRand * 0.34) + aPhase.z);
      vA = clamp(0.22 + (5.0 - dist) * 0.10, 0.055, 0.58) * twinkle;
      float sz = clamp(40.0 / max(0.5, dist), 1.3, 4.1);
      gl_PointSize = sz * uPixel;
      gl_Position = projectionMatrix * mvPos;
    }
  `;
  var ffs = `
    precision highp float;
    uniform sampler2D uDotTex;
    uniform float uFloatAlpha;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec4 tex = texture2D(uDotTex, gl_PointCoord);
      if (tex.a < 0.02) discard;
      gl_FragColor = vec4(vC, tex.a * vA * uFloatAlpha);
    }
  `;
  var fmat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uBass: uniforms.uBass,
      uPixel: uniforms.uPixel,
      uDotTex: uniforms.uDotTex,
      uFloatAlpha: uniforms.uFloatAlpha,
    },
    vertexShader: fvs, fragmentShader: ffs,
    transparent:true, depthWrite:false, blending: THREE.AdditiveBlending,
  });
  floatGroup = new THREE.Points(fgeo, fmat);
  floatGroup.frustumCulled = false;
  scene.add(floatGroup);
}
function destroyFloatLayer() {
  if (!floatGroup) return;
  scene.remove(floatGroup);
  floatGroup.geometry.dispose(); floatGroup.material.dispose();
  floatGroup = null;
}

// ============================================================
//  安魂 — 3D 粒子建模层
// ============================================================
var SKULL_PRESET_INDEX = 6;
var SKULL_MODEL_BASE_ROTATION_X = -0.26;
var SKULL_MODEL_BASE_ROTATION_Y = 0.00;
var SKULL_MODEL_SCALE = 2.34;
var SKULL_MODEL_BASE_POSITION = { x: 0, y: 0.22, z: 0.10 };
var skullAmpPulse = 0;
var skullBeatFlash = 0;
var skullJawOpen = 0;
var skullCameraBlend = 0;
var skullWheelZoom = 0;
var skullWheelZoomTarget = 0;
var skullCameraTargetPos = new THREE.Vector3();
var skullCameraTargetLook = new THREE.Vector3();
var skullCameraBasePos = new THREE.Vector3();
var skullCameraBaseLook = new THREE.Vector3();
var skullCameraShelfPos = new THREE.Vector3();
var skullCameraShelfLook = new THREE.Vector3();
var skullCameraMixedLook = new THREE.Vector3();
var skullShelfCameraMix = 0;
var skullLyricMouthLocal = new THREE.Vector3(0.025, -0.72, 0.62);
var skullLyricMouthTarget = new THREE.Vector3();
var skullLyricMouthForward = new THREE.Vector3();
var skullLyricMouthQuat = new THREE.Quaternion();
var skullLyricReadableQuat = new THREE.Quaternion();
var skullParticleGroup = null;
var skullParticleOpacity = 0;
var skullParticleAsset = { data: null, promise: null, failed: false };
var skullBaseColors = {
  boneA: new THREE.Color('#b8ae98'),
  boneB: new THREE.Color('#fff4d8'),
  shadow: new THREE.Color('#100d0d'),
  light: new THREE.Color('#ffe3a0'),
  neutralBoneA: new THREE.Color('#9fb7c8'),
  neutralBoneB: new THREE.Color('#eef9ff'),
  neutralShadow: new THREE.Color('#070b12'),
  neutralLight: new THREE.Color('#d6f3ff')
};
var skullTintScratch = {
  tint: new THREE.Color(),
  soft: new THREE.Color(),
  bright: new THREE.Color(),
  dark: new THREE.Color(),
  boneA: new THREE.Color(),
  boneB: new THREE.Color(),
  shadow: new THREE.Color(),
  light: new THREE.Color()
};

function effectiveSkullVisualTint() {
  var pal = stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette) || {};
  var custom = fx && fx.visualTintMode === 'custom';
  var color = custom
    ? fx.visualTintColor
    : (pal.secondary || pal.primary || fx.visualTintColor || fxDefaults.visualTintColor || '#9db8cf');
  color = normalizeHexColor(color || '#9db8cf', '#9db8cf');
  var strength = custom ? 0.98 : (pal && (pal.secondary || pal.primary) ? 0.30 : 0.14);
  return { color: color, strength: strength, custom: custom };
}

function syncSkullParticleColors() {
  if (!skullParticleGroup || !skullParticleGroup.material || !skullParticleGroup.material.uniforms) return;
  var u = skullParticleGroup.material.uniforms;
  var tint = effectiveSkullVisualTint();
  var custom = !!tint.custom;
  var strength = clampRange(Number(tint.strength) || 0, 0, custom ? 0.99 : 0.78);
  skullTintScratch.tint.set(tint.color);
  skullTintScratch.soft.copy(skullTintScratch.tint).lerp(new THREE.Color('#e8f5ff'), custom ? 0.05 : 0.28);
  skullTintScratch.bright.copy(skullTintScratch.tint).lerp(new THREE.Color(custom ? '#f6fbff' : '#fff7d6'), custom ? 0.14 : 0.46);
  skullTintScratch.dark.copy(skullTintScratch.tint).lerp(new THREE.Color('#05070c'), custom ? 0.74 : 0.72);
  skullTintScratch.boneA.copy(custom ? skullBaseColors.neutralBoneA : skullBaseColors.boneA).lerp(skullTintScratch.soft, strength * (custom ? 0.99 : 0.64));
  skullTintScratch.boneB.copy(custom ? skullBaseColors.neutralBoneB : skullBaseColors.boneB).lerp(skullTintScratch.bright, strength * (custom ? 0.94 : 0.46));
  skullTintScratch.shadow.copy(custom ? skullBaseColors.neutralShadow : skullBaseColors.shadow).lerp(skullTintScratch.dark, strength * (custom ? 0.72 : 0.42));
  skullTintScratch.light.copy(custom ? skullBaseColors.neutralLight : skullBaseColors.light).lerp(skullTintScratch.bright, strength * (custom ? 0.98 : 0.76));
  if (u.uColorA) u.uColorA.value.copy(skullTintScratch.boneA);
  if (u.uColorB) u.uColorB.value.copy(skullTintScratch.boneB);
  if (u.uShadow) u.uShadow.value.copy(skullTintScratch.shadow);
  if (u.uLight) u.uLight.value.copy(skullTintScratch.light);
}

function buildSkullParticleGeometryFromAsset(points) {
  var count = Math.floor((points && points.length || 0) / 5);
  var geo = new THREE.BufferGeometry();
  var positions = new Float32Array(count * 3);
  var seeds = new Float32Array(count);
  var kinds = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    positions[i * 3] = points[i * 5];
    positions[i * 3 + 1] = points[i * 5 + 1];
    positions[i * 3 + 2] = points[i * 5 + 2];
    kinds[i] = points[i * 5 + 3];
    seeds[i] = points[i * 5 + 4];
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('kind', new THREE.BufferAttribute(kinds, 1));
  return geo;
}

function loadSkullParticleAsset() {
  if (skullParticleAsset.data || skullParticleAsset.promise || skullParticleAsset.failed) return skullParticleAsset.promise || Promise.resolve(skullParticleAsset.data);
  if (typeof fetch !== 'function') {
    skullParticleAsset.failed = true;
    return Promise.resolve(null);
  }
  skullParticleAsset.promise = fetch('assets/skull-decimation-points.bin?v=regular-surface-teeth-soften-20260621', { cache: 'reload' })
    .then(function(res){
      if (!res.ok) throw new Error('skull asset ' + res.status);
      return res.arrayBuffer();
    })
    .then(function(buf){
      if (!buf || buf.byteLength < 20 || buf.byteLength % 20 !== 0) throw new Error('invalid skull asset');
      skullParticleAsset.data = new Float32Array(buf);
      skullParticleAsset.promise = null;
      return skullParticleAsset.data;
    })
    .catch(function(err){
      console.warn('skull particle asset load failed:', err);
      skullParticleAsset.failed = true;
      skullParticleAsset.promise = null;
      return null;
    });
  return skullParticleAsset.promise;
}

function skullPushPoint(pos, seed, kind, x, y, z, k) {
  pos.push(x, y, z);
  seed.push(Math.random() * 1000);
  kind.push(k == null ? 0 : k);
}
function skullPushCurve(pos, seed, kind, count, fn, k, jitter) {
  jitter = jitter == null ? 0.012 : jitter;
  for (var i = 0; i < count; i++) {
    var t = count > 1 ? i / (count - 1) : 0;
    var p = fn(t);
    skullPushPoint(pos, seed, kind, p.x + (Math.random() - 0.5) * jitter, p.y + (Math.random() - 0.5) * jitter, p.z + (Math.random() - 0.5) * jitter, k);
  }
}
function createSkullParticleLayer() {
  if (skullParticleGroup) return skullParticleGroup;
  var asset = skullParticleAsset.data;
  if (!asset) return null;
  var pos = [];
  var seed = [];
  var kind = [];
  if (!asset) {

  function rotate2(x, y, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return { x:x * c - y * s, y:x * s + y * c };
  }
  function eyeCut(x, y, z, side) {
    if (z < 0.16) return false;
    var p = rotate2(x - side * 0.38, y - 0.02, side * 0.10);
    var almond = Math.pow(Math.abs(p.x) / 0.34, 1.70) + Math.pow(Math.abs(p.y) / 0.215, 1.34);
    var slantGate = p.y < 0.22 - Math.abs(p.x) * 0.12 && p.y > -0.24 + Math.abs(p.x) * 0.10;
    return almond < 1.0 && slantGate;
  }
  function noseCut(x, y, z) {
    if (z < 0.20 || y > -0.12 || y < -0.62) return false;
    var t = clampRange((-0.12 - y) / 0.50, 0, 1);
    var half = 0.050 + t * 0.185;
    return Math.abs(x) < half && z > 0.38 + t * 0.18;
  }
  function mouthGap(x, y, z) {
    return z > 0.18 && y < -0.66 && y > -1.03 && Math.abs(x) < 0.30;
  }
  function addEllipsoidSurface(count, cx, cy, cz, rx, ry, rz, yMin, yMax, k, frontBias) {
    var made = 0, guard = 0;
    while (made < count && guard < count * 8) {
      guard++;
      var theta = frontBias
        ? (-Math.PI * 0.07 + Math.random() * Math.PI * 1.14)
        : (Math.random() * Math.PI * 2);
      var phi = Math.acos(1 - Math.random() * 2);
      var sx = Math.sin(phi) * Math.cos(theta);
      var sy = Math.cos(phi);
      var sz = Math.sin(phi) * Math.sin(theta);
      var x = cx + sx * rx * (0.96 + Math.max(0, -sy) * 0.12);
      var y = cy + sy * ry;
      var z = cz + sz * rz;
      if (y < yMin || y > yMax) continue;
      if (eyeCut(x, y, z, -1) || eyeCut(x, y, z, 1) || noseCut(x, y, z) || mouthGap(x, y, z)) continue;
      var cheekCarve = z > 0.18 && y < -0.18 && y > -0.66 && Math.abs(x) > 0.26 && Math.abs(x) < 0.58 && Math.random() < 0.36;
      if (cheekCarve) continue;
      skullPushPoint(pos, seed, kind, x, y, z, k + Math.random() * 0.08);
      made++;
    }
  }

  addEllipsoidSurface(3150, 0, 0.46, 0.00, 0.93, 0.88, 0.58, -0.16, 1.35, 0.055, true);
  addEllipsoidSurface(2100, 0, -0.34, 0.10, 0.70, 0.66, 0.46, -0.95, 0.14, 0.10, true);
  for (var j = 0; j < 1450; j++) {
    var a = Math.random() * Math.PI * 2;
    var v = Math.random();
    var y = -1.16 + v * 0.48;
    var taper = clampRange((y + 1.16) / 0.48, 0, 1);
    var rx = 0.32 + taper * 0.31;
    var rz = 0.22 + taper * 0.18;
    var x = Math.cos(a) * rx;
    var z = 0.22 + Math.sin(a) * rz;
    if (mouthGap(x, y, z)) continue;
    if (y > -0.94 && Math.abs(x) < 0.22 && z > 0.18) continue;
    skullPushPoint(pos, seed, kind, x, y, z, 0.15 + Math.random() * 0.10);
  }

  [-1, 1].forEach(function(side){
    var cx = side * 0.38;
    skullPushCurve(pos, seed, kind, 520, function(t){
      var a = t * Math.PI * 2;
      var px = Math.cos(a) * (0.345 + Math.sin(a * 2.0) * 0.012);
      var py = Math.sin(a) * (0.205 + Math.cos(a * 2.0) * 0.010);
      var r = rotate2(px, py, -side * 0.10);
      return {
        x: cx + r.x,
        y: 0.02 + r.y - Math.max(0, Math.cos(a)) * 0.018,
        z: 0.72 + Math.sin(a * 2.0) * 0.030
      };
    }, 0.96, 0.010);
    skullPushCurve(pos, seed, kind, 330, function(t){
      var x = side * (0.13 + t * 0.58);
      var y = 0.245 - t * 0.085 + Math.sin(t * Math.PI) * 0.055;
      return { x:x, y:y, z:0.66 + Math.sin(t * Math.PI) * 0.055 };
    }, 0.98, 0.010);
    skullPushCurve(pos, seed, kind, 300, function(t){
      return {
        x: side * (0.30 + t * 0.47),
        y: -0.18 - t * 0.25 + Math.sin(t * Math.PI) * 0.070,
        z: 0.69 - t * 0.095
      };
    }, 0.84, 0.012);
    skullPushCurve(pos, seed, kind, 330, function(t){
      return {
        x: side * (0.62 - t * 0.20),
        y: -0.28 - t * 0.55 + Math.sin(t * Math.PI) * 0.065,
        z: 0.50 + Math.sin(t * Math.PI) * 0.070
      };
    }, 0.72, 0.014);
  });

  skullPushCurve(pos, seed, kind, 360, function(t){
    var x = -0.72 + t * 1.44;
    return { x:x, y:0.235 - Math.abs(x) * 0.055 + Math.sin(t * Math.PI) * 0.035, z:0.62 + Math.sin(t * Math.PI) * 0.040 };
  }, 0.86, 0.012);
  [-1, 1].forEach(function(side){
    skullPushCurve(pos, seed, kind, 260, function(t){
      return { x:side * (0.035 + t * 0.205), y:-0.15 - t * 0.43, z:0.79 - t * 0.035 };
    }, 0.98, 0.007);
  });
  skullPushCurve(pos, seed, kind, 240, function(t){
    var x = -0.25 + t * 0.50;
    return { x:x, y:-0.62 + Math.sin(t * Math.PI) * 0.030, z:0.70 };
  }, 0.86, 0.008);
  skullPushCurve(pos, seed, kind, 420, function(t){
    var a = Math.PI + t * Math.PI;
    return { x: Math.cos(a) * 0.50, y: -0.98 + Math.sin(a) * 0.205, z: 0.46 + Math.sin(t * Math.PI) * 0.075 };
  }, 0.82, 0.014);
  skullPushCurve(pos, seed, kind, 360, function(t){
    var x = -0.39 + t * 0.78;
    return { x:x, y:-0.70 + Math.sin(t * Math.PI) * 0.018, z:0.73 };
  }, 0.96, 0.006);
  skullPushCurve(pos, seed, kind, 320, function(t){
    var x = -0.36 + t * 0.72;
    return { x:x, y:-1.005 - Math.sin(t * Math.PI) * 0.018, z:0.70 };
  }, 0.78, 0.008);
  for (var tooth = -4; tooth <= 4; tooth++) {
    var tx = tooth * 0.082;
    var height = tooth === 0 ? 0.30 : (0.25 + (4 - Math.abs(tooth)) * 0.012);
    skullPushCurve(pos, seed, kind, 58, function(t){
      return { x: tx + Math.sin(t * Math.PI) * 0.006, y: -0.715 - t * height, z: 0.735 - t * 0.020 };
    }, 0.94, 0.004);
  }
  skullPushCurve(pos, seed, kind, 520, function(t){
    var a = Math.PI * 0.12 + t * Math.PI * 0.76;
    return { x: Math.cos(a) * 0.98, y: 0.42 + Math.sin(a) * 0.92, z: 0.48 + Math.sin(t * Math.PI) * 0.10 };
  }, 0.70, 0.012);
  skullPushCurve(pos, seed, kind, 360, function(t){
    var a = t * Math.PI * 2;
    return { x: Math.cos(a) * 0.52, y: -1.19 + Math.sin(a) * 0.082, z: 0.24 + Math.sin(a * 2.0) * 0.028 };
  }, 0.72, 0.010);
  }

  var geo = asset ? buildSkullParticleGeometryFromAsset(asset) : new THREE.BufferGeometry();
  if (!asset) {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(seed), 1));
    geo.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(kind), 1));
  }
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uTime: uniforms.uTime,
      uPixel: uniforms.uPixel,
      uBass: uniforms.uBass,
      uMid: uniforms.uMid,
      uTreble: uniforms.uTreble,
      uBeat: uniforms.uBeat,
      uJawOpen: { value: 0 },
      uSkullFlash: { value: 0 },
      uPointScale: uniforms.uPointScale,
      uBloomStrength: uniforms.uBloomStrength,
      uColorBoost: uniforms.uColorBoost,
      uOpacity: { value: 0 },
      uColorA: { value: new THREE.Color('#b8ae98') },
      uColorB: { value: new THREE.Color('#fff4d8') },
      uShadow: { value: new THREE.Color('#100d0d') },
      uLight: { value: new THREE.Color('#ffe3a0') }
    },
    vertexShader: [
      'precision highp float;',
      'attribute float seed,kind;',
      'uniform float uTime,uPixel,uPointScale,uBloomStrength,uColorBoost;',
      'uniform float uBass,uMid,uTreble,uBeat,uJawOpen,uSkullFlash;',
      'varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;',
      'void main(){',
      '  vec3 pos = position;',
      '  float jawGroup = step(1.0, kind);',
      '  float boneKind = fract(kind);',
      '  vKind = boneKind;',
      '  vec3 n = normalize(vec3(position.x * 0.82, position.y * 0.68, position.z * 1.22 + 0.16));',
      '  float toothBand = smoothstep(0.48, 0.70, position.z) * (1.0 - smoothstep(0.27, 0.48, abs(position.x))) * (1.0 - smoothstep(0.18, 0.46, abs(position.y + 0.72)));',
      '  float toothNoise = fract(sin(seed * 21.731 + floor((position.x + 0.52) * 21.0) * 5.137) * 43758.5453);',
      '  pos.y += toothBand * (toothNoise - 0.5) * 0.020;',
      '  pos.z += toothBand * (fract(sin(seed * 17.923 + position.y * 31.0) * 24634.6345) - 0.5) * 0.012;',
      '  float jawSidePull = jawGroup * smoothstep(-0.42, -1.06, position.y) * smoothstep(0.24, 0.62, abs(position.x)) * (1.0 - smoothstep(0.78, 1.04, abs(position.x))) * smoothstep(0.16, 0.70, position.z);',
      '  pos.x *= 1.0 - jawSidePull * 0.10;',
      '  float fallbackJaw = smoothstep(-0.48, -0.90, position.y) * smoothstep(0.08, 0.52, position.z) * (1.0 - smoothstep(0.62, 0.96, abs(position.x)));',
      '  float jawMask = jawGroup;',
      '  float jawSideAnchor = smoothstep(0.36, 0.66, abs(position.x)) * (1.0 - smoothstep(0.78, 0.98, abs(position.x))) * smoothstep(-0.34, -0.74, position.y) * (1.0 - smoothstep(0.62, 0.86, position.z));',
      '  float jawMotion = jawMask * (1.0 - jawSideAnchor * 0.32);',
      '  vec2 jawHinge = vec2(-0.45, 0.18);',
      '  float jawAngle = uJawOpen * 0.52 * jawMotion;',
      '  float jc = cos(jawAngle);',
      '  float js = sin(jawAngle);',
      '  vec2 jr = pos.yz - jawHinge;',
      '  vec2 openedJaw = vec2(jr.x * jc - jr.y * js, jr.x * js + jr.y * jc) + jawHinge;',
      '  pos.yz = mix(pos.yz, openedJaw, jawMotion);',
      '  float jawDrop = jawMotion * smoothstep(-0.32, -0.88, position.y) * (0.58 + smoothstep(0.18, 0.62, abs(position.x)) * 0.04);',
      '  float openDrive = clamp(uJawOpen, 0.0, 1.25);',
      '  pos.y -= jawDrop * (0.038 + openDrive * 0.100);',
      '  pos.z += jawDrop * (0.003 + openDrive * 0.014);',
      '  float ampDrive = smoothstep(0.20, 0.82, uBass * 0.44 + uMid * 0.22 + uBeat * 0.72);',
      '  float ampPhase = 0.50 + 0.50 * sin(uTime * (1.05 + uMid * 0.30) + seed * 6.2831);',
      '  vFlash = clamp(uSkullFlash * (0.68 + ampPhase * 0.32), 0.0, 1.0);',
      '  vAmp = clamp(ampDrive * 0.045 + vFlash * 0.92 + uTreble * 0.012, 0.0, 1.0);',
      '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
      '  float dist = max(0.55, -mv.z);',
      '  vec3 vn = normalize(normalMatrix * n);',
      '  vec3 keyDir = normalize(vec3(-0.48, 0.64, 0.60));',
      '  vec3 lowDir = normalize(vec3(-0.10, -0.78, 0.34));',
      '  vec3 fillDir = normalize(vec3(0.36, -0.04, 0.64));',
      '  vec3 rimDir = normalize(vec3(0.88, 0.18, -0.44));',
      '  float key = pow(max(dot(vn, keyDir), 0.0), 1.18);',
      '  float low = pow(max(dot(vn, lowDir), 0.0), 1.34) * 0.10;',
      '  float fill = max(dot(vn, fillDir), 0.0) * 0.055;',
      '  float gothicShadow = smoothstep(-0.10, 0.36, dot(vn, normalize(vec3(0.44, -0.06, -0.58))));',
      '  float dentalLift = smoothstep(0.48, 0.72, position.z) * (1.0 - smoothstep(0.30, 0.54, abs(position.x))) * (1.0 - smoothstep(0.18, 0.48, abs(position.y + 0.70))) * (0.62 + toothNoise * 0.20);',
      '  vRim = pow(max(dot(vn, rimDir), 0.0), 2.50) * (0.24 + uBloomStrength * 0.08 + vFlash * 0.62);',
      '  float dust = fract(sin(seed * 13.871 + position.x * 19.7 + position.y * 7.1) * 43758.5453);',
      '  vDensity = clamp(0.30 + key * 0.70 + vRim * 0.24 - gothicShadow * 0.24 + dust * 0.025 + vFlash * 0.08, 0.16, 1.20);',
      '  vLight = clamp(0.115 + key * 1.02 + low + fill + dentalLift * 0.20 + boneKind * 0.070 + vAmp * 0.56 - gothicShadow * 0.08, 0.035, 1.72);',
      '  float scaleCtl = clamp(uPointScale, 0.48, 2.35);',
      '  float size = (0.035 + boneKind * 0.026) * (0.84 + vDensity * 0.22 + vLight * 0.13 + uBloomStrength * 0.030 + vFlash * 0.18);',
      '  gl_PointSize = clamp(size * uPixel * scaleCtl * 128.0 / dist, 0.95, 7.60);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColorA,uColorB,uShadow,uLight;',
      'uniform float uOpacity,uBloomStrength,uColorBoost;',
      'varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  if(tex.a < 0.070) discard;',
      '  float contrast = clamp(uColorBoost, 0.50, 2.00);',
      '  float lit = clamp(pow(vLight, mix(1.18, 0.74, (contrast - 0.50) / 1.50)), 0.0, 1.28);',
      '  vec3 bone = mix(uColorA, uColorB, clamp((vKind - 0.34) * 2.0 + lit * 0.18, 0.0, 1.0));',
      '  vec3 col = mix(uShadow, bone, clamp(lit, 0.0, 1.0));',
      '  col = mix(col, uLight, clamp(vRim * (0.14 + uBloomStrength * 0.035 + vFlash * 0.40), 0.0, 0.54));',
      '  col = mix(col, uLight, clamp(vAmp * (0.09 + uBloomStrength * 0.025) + vFlash * 0.56, 0.0, 0.68));',
      '  float alpha = tex.a * uOpacity * clamp(0.20 + lit * 0.44 + vDensity * 0.40 + vRim * 0.10 + vFlash * 0.46, 0.12, 1.56);',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending
  });
  skullParticleGroup = new THREE.Points(geo, mat);
  skullParticleGroup.frustumCulled = false;
  skullParticleGroup.visible = false;
  skullParticleGroup.userData.source = asset ? 'asset' : 'fallback';
  skullParticleGroup.position.set(SKULL_MODEL_BASE_POSITION.x, SKULL_MODEL_BASE_POSITION.y, SKULL_MODEL_BASE_POSITION.z);
  skullParticleGroup.scale.setScalar(SKULL_MODEL_SCALE);
  skullParticleGroup.rotation.x = SKULL_MODEL_BASE_ROTATION_X;
  skullParticleGroup.rotation.y = SKULL_MODEL_BASE_ROTATION_Y;
  skullParticleGroup.renderOrder = 32;
  syncSkullParticleColors();
  scene.add(skullParticleGroup);
  return skullParticleGroup;
}
function isSkullShelfCompositionActive() {
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return false;
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen || shelfVisibility > 0.18) return true;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
function clearSkullPresetResidue() {
  skullParticleOpacity = 0;
  skullAmpPulse = 0;
  skullBeatFlash = 0;
  skullJawOpen = 0;
  skullCameraBlend = 0;
  if (!skullParticleGroup) return;
  skullParticleGroup.visible = false;
  if (skullParticleGroup.material && skullParticleGroup.material.uniforms) {
    if (skullParticleGroup.material.uniforms.uOpacity) skullParticleGroup.material.uniforms.uOpacity.value = 0;
    if (skullParticleGroup.material.uniforms.uJawOpen) skullParticleGroup.material.uniforms.uJawOpen.value = 0;
    if (skullParticleGroup.material.uniforms.uSkullFlash) skullParticleGroup.material.uniforms.uSkullFlash.value = 0;
  }
}
function resetSkullPresetView(immediate, opts) {
  opts = opts || {};
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return;
  skullWheelZoomTarget = 0;
  if (!opts.smooth) skullWheelZoom = 0;
  skullCameraBlend = Math.max(skullCameraBlend, 1);
  if (!opts.keepLyricLock && typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.group && stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
  if (!opts.keepLyricLock && typeof requestStageLyricCameraSnap === 'function') requestStageLyricCameraSnap(10);
  if (!immediate || !skullParticleGroup) return;
  var shelfComposition = isSkullShelfCompositionActive();
  skullShelfCameraMix = shelfComposition ? 1 : 0;
  skullParticleGroup.position.set(shelfComposition ? -1.18 : SKULL_MODEL_BASE_POSITION.x, shelfComposition ? 0.32 : SKULL_MODEL_BASE_POSITION.y, SKULL_MODEL_BASE_POSITION.z);
  skullParticleGroup.scale.setScalar(shelfComposition ? 3.02 : SKULL_MODEL_SCALE);
  skullParticleGroup.rotation.set(SKULL_MODEL_BASE_ROTATION_X, SKULL_MODEL_BASE_ROTATION_Y, 0);
  skullParticleGroup.updateMatrixWorld(true);
  if (camera && typeof setSkullCameraTargetVectors === 'function') {
    var portrait = innerHeight > innerWidth * 1.08;
    setSkullCameraTargetVectors(skullCameraTargetPos, skullCameraTargetLook, portrait, shelfComposition, 0);
    camera.position.copy(skullCameraTargetPos);
    skullCameraMixedLook.copy(skullCameraTargetLook);
    camera.lookAt(skullCameraMixedLook);
    camera.updateProjectionMatrix();
  }
}
function skullBreathOffset(t, shelfComposition) {
  var strength = shelfComposition ? 0.70 : 1.0;
  return {
    x: strength * (Math.sin(t * 0.33 + 1.7) * 0.028 + Math.sin(t * 0.61 + 0.4) * 0.010),
    y: strength * (Math.sin(t * 0.38 + 0.2) * 0.036 + Math.sin(t * 0.83 + 2.1) * 0.012),
    z: strength * (Math.sin(t * 0.24 + 2.6) * 0.026)
  };
}
function setSkullCameraTargetVectors(pos, look, portrait, shelfComposition, zoom) {
  zoom = Number(zoom) || 0;
  if (shelfComposition) {
    pos.set(portrait ? -0.06 : 0.00, portrait ? -2.36 : -2.50, (portrait ? 4.88 : 4.96) + zoom * 0.78);
    look.set(portrait ? -0.04 : 0.00, portrait ? -0.26 : -0.20, 0.03);
    return;
  }
  pos.set(0.00, portrait ? -2.38 : -2.52, (portrait ? 4.92 : 4.98) + zoom);
  look.set(0.00, portrait ? -0.28 : -0.20, 0.02);
}
function applySkullCameraPose(dt) {
  if (freeCamera && (freeCamera.active || freeCamera.locked || freeCamera.resetTween)) return;
  var active = fx && fx.preset === SKULL_PRESET_INDEX;
  skullCameraBlend += ((active ? 1 : 0) - skullCameraBlend) * Math.min(1, dt * (active ? 4.8 : 7.2));
  if (skullCameraBlend < 0.002) return;
  skullWheelZoom += (skullWheelZoomTarget - skullWheelZoom) * Math.min(1, dt * 8.0);
  var portrait = innerHeight > innerWidth * 1.08;
  var shelfComposition = isSkullShelfCompositionActive();
  var shelfMixTarget = shelfComposition ? 1 : 0;
  skullShelfCameraMix += (shelfMixTarget - skullShelfCameraMix) * Math.min(1, dt * (shelfMixTarget > skullShelfCameraMix ? 4.6 : 5.8));
  if (Math.abs(skullShelfCameraMix - shelfMixTarget) < 0.002) skullShelfCameraMix = shelfMixTarget;
  setSkullCameraTargetVectors(skullCameraBasePos, skullCameraBaseLook, portrait, false, skullWheelZoom);
  setSkullCameraTargetVectors(skullCameraShelfPos, skullCameraShelfLook, portrait, true, skullWheelZoom);
  skullCameraTargetPos.copy(skullCameraBasePos).lerp(skullCameraShelfPos, skullShelfCameraMix);
  skullCameraTargetLook.copy(skullCameraBaseLook).lerp(skullCameraShelfLook, skullShelfCameraMix);
  camera.position.lerp(skullCameraTargetPos, skullCameraBlend);
  skullCameraMixedLook.set(orbit.lookAt.x, orbit.lookAt.y, orbit.lookAt.z).lerp(skullCameraTargetLook, skullCameraBlend);
  camera.lookAt(skullCameraMixedLook);
  camera.updateProjectionMatrix();
}
function updateSkullParticleLayer(dt) {
  var active = fx && fx.preset === SKULL_PRESET_INDEX;
  if (active && !skullParticleAsset.data && !skullParticleAsset.failed) {
    loadSkullParticleAsset();
    return;
  }
  if (active && !skullParticleAsset.data) return;
  if (active) createSkullParticleLayer();
  if (!skullParticleGroup) return;
  var target = active ? 1 : 0;
  skullParticleOpacity += (target - skullParticleOpacity) * Math.min(1, dt * (active ? 3.2 : 2.4));
  if (skullParticleOpacity < 0.006 && !active) {
    skullParticleGroup.visible = false;
    return;
  }
  skullParticleGroup.visible = true;
  skullParticleGroup.material.uniforms.uOpacity.value = skullParticleOpacity * clampRange(0.78 + (fx.intensity || 0.85) * 0.18, 0.56, 1.0);
  var beatTransient = clampRange(Math.max(0, beatPulse - 0.16) / 0.84, 0, 1.35);
  var flashTarget = clampRange(Math.pow(beatTransient, 1.34) * 1.08 + Math.max(0, bass - 0.60) * 0.18 * beatTransient, 0, 1);
  skullBeatFlash += (flashTarget - skullBeatFlash) * Math.min(1, dt * (flashTarget > skullBeatFlash ? 24.0 : 6.2));
  if (skullParticleGroup.material.uniforms.uSkullFlash) skullParticleGroup.material.uniforms.uSkullFlash.value = skullBeatFlash;
  var jawTarget = clampRange(0.60 + (0.5 + 0.5 * Math.sin(uniforms.uTime.value * 0.50)) * 0.050 + bass * 0.060 + skullBeatFlash * 0.090, 0.52, 0.88);
  skullJawOpen += (jawTarget - skullJawOpen) * Math.min(1, dt * (jawTarget > skullJawOpen ? 7.8 : 3.4));
  if (skullParticleGroup.material.uniforms.uJawOpen) skullParticleGroup.material.uniforms.uJawOpen.value = skullJawOpen;
  var shelfComposition = isSkullShelfCompositionActive();
  var shelfMix = clampRange(skullShelfCameraMix || (shelfComposition ? 1 : 0), 0, 1);
  var drift = skullBreathOffset(uniforms.uTime.value, shelfComposition);
  var ampTarget = clampRange(bass * 0.006 + mid * 0.004 + skullBeatFlash * 0.070, 0, 0.090);
  skullAmpPulse += (ampTarget - skullAmpPulse) * Math.min(1, dt * (ampTarget > skullAmpPulse ? 11.0 : 4.0));
  var shelfScale = 3.02;
  var targetScale = (SKULL_MODEL_SCALE + (shelfScale - SKULL_MODEL_SCALE) * shelfMix) * (1 + skullAmpPulse) * clampRange(1 - skullWheelZoom * 0.055, 0.92, 1.08);
  var shelfX = -1.18;
  var shelfY = 0.32;
  var targetX = (SKULL_MODEL_BASE_POSITION.x + (shelfX - SKULL_MODEL_BASE_POSITION.x) * shelfMix) + drift.x;
  var targetY = (SKULL_MODEL_BASE_POSITION.y + (shelfY - SKULL_MODEL_BASE_POSITION.y) * shelfMix) + drift.y;
  var targetZ = SKULL_MODEL_BASE_POSITION.z + drift.z;
  skullParticleGroup.position.x += (targetX - skullParticleGroup.position.x) * Math.min(1, dt * 4.2);
  skullParticleGroup.position.y += (targetY - skullParticleGroup.position.y) * Math.min(1, dt * 4.8);
  skullParticleGroup.position.z += (targetZ - skullParticleGroup.position.z) * Math.min(1, dt * 4.2);
  skullParticleGroup.scale.x += (targetScale - skullParticleGroup.scale.x) * Math.min(1, dt * 4.6);
  skullParticleGroup.scale.y = skullParticleGroup.scale.x;
  skullParticleGroup.scale.z = skullParticleGroup.scale.x;
  var targetRotY = SKULL_MODEL_BASE_ROTATION_Y + (orbit.centerLocked ? 0 : (headParallax.active ? headParallax.x * 0.5 : 0) + gestureRotation.y);
  var targetRotX = SKULL_MODEL_BASE_ROTATION_X + (orbit.centerLocked ? 0 : (headParallax.active ? -headParallax.y * 0.35 : 0) + gestureRotation.x);
  var rotEase = Math.min(1, dt * 7.4);
  skullParticleGroup.rotation.y += (targetRotY - skullParticleGroup.rotation.y) * rotEase;
  skullParticleGroup.rotation.x += (targetRotX - skullParticleGroup.rotation.x) * rotEase;
  skullParticleGroup.rotation.z += (0 - skullParticleGroup.rotation.z) * Math.min(1, dt * 6.0);
}

// ============================================================
//  封面背面粒子层 (v7.2)
//   - 独立 Points, 放在 z=-1.5 (主封面平面背面)
//   - 颜色取自封面镜像 UV
//   - 慢呼吸 + 小幅 noise 漂移
//   - 跟主粒子同步旋转 (在主循环里赋值)
//   - 视角转到背面才能看到 — 不需要手动控制 visible
// ============================================================
var BACK_COVER_COUNT = 3000;
var backCoverGroup = null;
var backCoverColorArr = null;

function createBackCoverLayer() {
  if (backCoverGroup) return;
  var bg = new THREE.BufferGeometry();
  var bp = new Float32Array(BACK_COVER_COUNT * 3);
  var bc = new Float32Array(BACK_COVER_COUNT * 3);
  var br = new Float32Array(BACK_COVER_COUNT);
  var bu = new Float32Array(BACK_COVER_COUNT * 2);  // 镜像 UV 用于采样封面
  for (var i = 0; i < BACK_COVER_COUNT; i++) {
    var u = Math.random();
    var v = Math.random();
    // 在 PLANE_SIZE 范围内分布
    bp[i*3]   = (u - 0.5) * PLANE_SIZE;
    bp[i*3+1] = (v - 0.5) * PLANE_SIZE;
    bp[i*3+2] = -1.5 - Math.random() * 0.4;  // 在主平面后方
    bu[i*2]   = 1.0 - u;  // 镜像 X
    bu[i*2+1] = v;
    br[i] = Math.random();
    bc[i*3] = 0.7; bc[i*3+1] = 0.6; bc[i*3+2] = 0.8;  // 占位
  }
  bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  bg.setAttribute('aColor',   new THREE.BufferAttribute(bc, 3));
  bg.setAttribute('aRand',    new THREE.BufferAttribute(br, 1));
  bg.setAttribute('aUv',      new THREE.BufferAttribute(bu, 2));

  var vs = `
    precision highp float;
    uniform float uTime, uBass, uPixel, uAlpha;
    attribute vec3 aColor;
    attribute vec2 aUv;
    attribute float aRand;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec3 pos = position;
      // 缓慢呼吸
      pos.x += sin(uTime * 0.20 + aRand * 8.0) * 0.20;
      pos.y += cos(uTime * 0.18 + aRand * 6.0) * 0.22;
      pos.z += sin(uTime * 0.12 + aRand * 5.0) * 0.18 + uBass * 0.12 * sin(aRand * 11.0);
      vC = aColor;
      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      float dist = -mvPos.z;
      vA = clamp(0.30 + 0.4 * sin(uTime * 0.6 + aRand * 5.0), 0.10, 0.65);
      float sz = clamp(46.0 / max(0.5, dist), 1.4, 4.5);
      gl_PointSize = sz * uPixel;
      gl_Position = projectionMatrix * mvPos;
    }
  `;
  var fs = `
    precision highp float;
    uniform sampler2D uDotTex;
    uniform float uAlpha;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec4 tex = texture2D(uDotTex, gl_PointCoord);
      if (tex.a < 0.02) discard;
      gl_FragColor = vec4(vC, tex.a * vA * uAlpha);
    }
  `;
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uBass: uniforms.uBass,
      uPixel: uniforms.uPixel,
      uDotTex: uniforms.uDotTex,
      uAlpha: uniforms.uAlpha,
    },
    vertexShader: vs, fragmentShader: fs,
    transparent:true, depthWrite:false, blending: THREE.NormalBlending,
  });
  backCoverGroup = new THREE.Points(bg, mat);
  backCoverGroup.frustumCulled = false;
  backCoverColorArr = bc;
  scene.add(backCoverGroup);
}

function destroyBackCoverLayer() {
  if (!backCoverGroup) return;
  scene.remove(backCoverGroup);
  backCoverGroup.geometry.dispose(); backCoverGroup.material.dispose();
  backCoverGroup = null; backCoverColorArr = null;
}

function refreshBackCoverColorsFromCanvas(coverCanvas) {
  if (!backCoverGroup || !coverCanvas || !backCoverColorArr) return;
  var ctx = coverCanvas.getContext('2d');
  var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
  var w = coverCanvas.width, h = coverCanvas.height;
  var attr = backCoverGroup.geometry.attributes;
  var uvA = attr.aUv.array;
  for (var i = 0; i < BACK_COVER_COUNT; i++) {
    var u = uvA[i*2], v = uvA[i*2+1];
    var sx = Math.floor(u * w);
    var sy = Math.floor(v * h);
    var di = (sy * w + sx) * 4;
    backCoverColorArr[i*3]   = img[di]   / 255 * 0.85;
    backCoverColorArr[i*3+1] = img[di+1] / 255 * 0.85;
    backCoverColorArr[i*3+2] = img[di+2] / 255 * 0.85;
  }
  attr.aColor.needsUpdate = true;
}
function updateFloatLayer(dt) {
  // 漂移已在 shader 中完成, JS 不需要每帧改 buffer
}
function refreshFloatColorsFromCover(coverCanvas) {
  if (!floatGroup || !coverCanvas) return;
  var ctx = coverCanvas.getContext('2d');
  var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
  var w = coverCanvas.width, h = coverCanvas.height;
  for (var i = 0; i < FLOAT_COUNT; i++) {
    var sx = Math.floor(Math.random() * w);
    var sy = Math.floor(Math.random() * h);
    var di = (sy * w + sx) * 4;
    floatColorArr[i*3]   = img[di]   / 255 * 0.95;
    floatColorArr[i*3+1] = img[di+1] / 255 * 0.95;
    floatColorArr[i*3+2] = img[di+2] / 255 * 0.95;
  }
  floatGroup.geometry.attributes.aColor.needsUpdate = true;
}
function resetFloatColorsToIdle() {
  if (!floatGroup || !floatColorArr) return;
  for (var i = 0; i < FLOAT_COUNT; i++) {
    var white = 0.88 + (i % 17) / 17 * 0.12;
    floatColorArr[i*3] = white;
    floatColorArr[i*3+1] = white;
    floatColorArr[i*3+2] = white;
  }
  floatGroup.geometry.attributes.aColor.needsUpdate = true;
}

// ============================================================
//  舞台歌词系统 v9 — Three.js 文字平面, 跟随专辑粒子 3D 运动
// ============================================================
var stageLyrics = {
  group: null,
  current: null,
  outgoing: [],
  currentIdx: -1,
  currentText: '',
  highBloom: 0,
  beatGlow: 0,
  glowFollowX: 0,
  glowFollowY: 0,
  glowFollowRoll: 0,
  palette: {
    primary: '#d6f8ff',
    secondary: '#9cffdf',
    highlight: '#eef7ff',
    shadow: 'rgba(2,8,12,0.42)',
    glow: 'rgba(143,233,255,0.34)',
  },
  coverPalette: {
    primary: '#d6f8ff',
    secondary: '#9cffdf',
    highlight: '#eef7ff',
    shadow: 'rgba(2,8,12,0.42)',
    glow: 'rgba(143,233,255,0.34)',
  },
  starRiver: null,
  starRiverWidth: 4.2,
  starRiverHeight: 0.58,
  lockFitScale: 1,
  snapCameraLockFrames: 0,
};
var lyricSunColor = new THREE.Color(0xffe6a4);
var lyricSunHotColor = new THREE.Color(0xfff4cc);
var lyricCameraDir = new THREE.Vector3();
var lyricCameraRight = new THREE.Vector3();
var lyricCameraUp = new THREE.Vector3();
var lyricCameraTarget = new THREE.Vector3();
var lyricLayoutBase = new THREE.Vector3();
var lyricLayoutTarget = new THREE.Vector3();
var lyricCoverWorldPos = new THREE.Vector3();
var lyricCoverWorldQuat = new THREE.Quaternion();
var lyricBaseEuler = new THREE.Euler(0, 0, 0, 'YXZ');
var lyricTiltEuler = new THREE.Euler(0, 0, 0, 'YXZ');
var lyricBaseQuat = new THREE.Quaternion();
var lyricTiltQuat = new THREE.Quaternion();
var lyricTargetQuat = new THREE.Quaternion();
var LYRIC_CAMERA_LOCK_MAX_SCALE = 0.80;
function setStageLyricViewBasisFromCameraOrQuaternion(fallbackQuat) {
  if (fallbackQuat) {
    lyricCameraDir.set(0, 0, 1).applyQuaternion(fallbackQuat);
    lyricCameraRight.set(1, 0, 0).applyQuaternion(fallbackQuat);
    lyricCameraUp.set(0, 1, 0).applyQuaternion(fallbackQuat);
  } else if (camera) {
    camera.getWorldDirection(lyricCameraDir);
    lyricCameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    lyricCameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  } else {
    lyricCameraDir.set(0, 0, 1);
    lyricCameraRight.set(1, 0, 0);
    lyricCameraUp.set(0, 1, 0);
  }
  lyricCameraDir.normalize();
  lyricCameraRight.normalize();
  lyricCameraUp.normalize();
}
function applyStageLyricLayoutOffset(target, x, y, z) {
  return target
    .addScaledVector(lyricCameraRight, x || 0)
    .addScaledVector(lyricCameraUp, y || 0)
    .addScaledVector(lyricCameraDir, z || 0);
}
function stageLyricTargetQuaternion(baseQuat, tiltX, tiltY) {
  lyricTiltEuler.set((tiltX || 0) * Math.PI / 180, (tiltY || 0) * Math.PI / 180, 0, 'YXZ');
  lyricTiltQuat.setFromEuler(lyricTiltEuler);
  return lyricTargetQuat.copy(baseQuat || lyricBaseQuat).multiply(lyricTiltQuat);
}
function getStageLyricLockBounds() {
  var maxW = 0, maxH = 0;
  function take(mesh) {
    if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
    var d = mesh.userData.lyric;
    var meshScale = Math.max(mesh.scale && isFinite(mesh.scale.x) ? mesh.scale.x : 1, mesh.scale && isFinite(mesh.scale.y) ? mesh.scale.y : 1);
    maxW = Math.max(maxW, (d.textWorldW || d.worldW || 6.1) * meshScale);
    maxH = Math.max(maxH, (d.textWorldH || d.worldH || 1.0) * meshScale);
  }
  take(stageLyrics.current);
  for (var i = 0; i < stageLyrics.outgoing.length; i++) take(stageLyrics.outgoing[i]);
  return { w: maxW || 5.4, h: maxH || 0.78 };
}
function lyricCameraLockFit(layoutScale, layoutX, layoutY, distance) {
  if (!camera || !camera.isPerspectiveCamera) return 1;
  layoutScale = Math.max(0.1, layoutScale || 1);
  var fov = (camera.fov || 45) * Math.PI / 180;
  var dist = Math.max(1.4, distance || 4.85);
  var visibleH = 2 * Math.tan(fov * 0.5) * dist;
  var visibleW = visibleH * (camera.aspect || (innerWidth / Math.max(1, innerHeight)) || 1.78);
  var bounds = getStageLyricLockBounds();
  var skullSafe = !!(fx && fx.preset === SKULL_PRESET_INDEX);
  var safeW = Math.max(visibleW * (skullSafe ? 0.36 : 0.42), visibleW * (skullSafe ? 0.70 : 0.84) - Math.abs(layoutX || 0) * (skullSafe ? 1.36 : 1.22));
  var safeH = Math.max(visibleH * (skullSafe ? 0.16 : 0.18), visibleH * (skullSafe ? 0.34 : 0.44) - Math.abs(layoutY || 0) * (skullSafe ? 0.98 : 0.82));
  var scaledW = Math.max(0.01, bounds.w * layoutScale);
  var scaledH = Math.max(0.01, bounds.h * layoutScale);
  var viewportFit = Math.min(1, safeW / scaledW, safeH / scaledH);
  var lockScaleCap = Math.min(1, (skullSafe ? 0.94 : LYRIC_CAMERA_LOCK_MAX_SCALE) / layoutScale);
  return clampRange(Math.min(viewportFit, lockScaleCap), skullSafe ? 0.36 : 0.42, 1);
}
// 兼容旧变量名以便其它代码不破坏
var lyricsParticles = null;
var lyricsGeo = null;

// 三个 attribute: 源位置(随机扩散态), 目标位置(组成字), color, brightness
var lyricsAttrTargetA = null;
var lyricsAttrTargetB = null;
var lyricsAttrSeed = null;

function createLyricsParticles() {
  if (stageLyrics.group) {
    ensureLyricStarRiver();
    return;
  }
  stageLyrics.group = new THREE.Group();
  stageLyrics.group.renderOrder = 38;
  scene.add(stageLyrics.group);
  ensureLyricStarRiver();
}

function ensureLyricStarRiver() {
  if (!stageLyrics.group || stageLyrics.starRiver) return stageLyrics.starRiver;
  var count = 420;
  var geo = new THREE.BufferGeometry();
  var seeds = new Float32Array(count);
  var lanes = new Float32Array(count);
  var depths = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    seeds[i] = Math.random() * 1000;
    lanes[i] = Math.random();
    depths[i] = Math.random();
  }
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('lane', new THREE.BufferAttribute(lanes, 1));
  geo.setAttribute('depthSeed', new THREE.BufferAttribute(depths, 1));
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uTime: uniforms.uTime,
      uPixel: uniforms.uPixel,
      uBass: uniforms.uBass,
      uBeat: uniforms.uBeat,
      uWidth: { value: stageLyrics.starRiverWidth || 4.2 },
      uHeight: { value: stageLyrics.starRiverHeight || 0.58 },
      uOpacity: { value: 0 },
      uColorA: { value: lyricThreeColor(stageLyrics.palette.secondary, '#9cffdf', 0.42) },
      uColorB: { value: lyricThreeColor(stageLyrics.palette.highlight, '#fff7d2', 0.44) }
    },
    vertexShader: [
      'precision highp float;',
      'attribute float seed,lane,depthSeed;',
      'uniform float uTime,uPixel,uBass,uBeat,uWidth,uHeight;',
      'varying float vSeed,vLane,vGlow;',
      'float hash(float n){return fract(sin(n)*43758.5453123);}',
      'void main(){',
      '  float laneBand = floor(lane * 5.0);',
      '  float laneLocal = fract(lane * 5.0);',
      '  float speed = 0.030 + hash(seed * 1.71) * 0.055 + laneBand * 0.005;',
      '  float flow = fract(hash(seed * 2.13) + uTime * speed);',
      '  float x = (flow - 0.5) * uWidth * (1.08 + hash(seed * 5.1) * 0.18);',
      '  float curve = sin(flow * 6.2831853 * (0.92 + hash(seed * 4.0) * 0.46) + seed * 0.071 + uTime * 0.34);',
      '  float breath = sin(uTime * (0.42 + hash(seed * 6.9) * 0.42) + seed * 0.093);',
      '  float y = (laneBand - 2.0) * uHeight * 0.135 + curve * uHeight * (0.20 + hash(seed * 9.0) * 0.18) + (laneLocal - 0.5) * uHeight * 0.16 + breath * uHeight * 0.10;',
      '  float z = -0.08 + (depthSeed - 0.5) * 0.44 + sin(uTime * (0.18 + hash(seed) * 0.24) + seed) * 0.08;',
      '  vec3 pos = vec3(x, y, z);',
      '  float edge = smoothstep(0.0, 0.18, flow) * (1.0 - smoothstep(0.82, 1.0, flow));',
      '  vSeed = seed;',
      '  vLane = lane;',
      '  vGlow = edge * (0.62 + 0.38 * sin(uTime * (0.9 + hash(seed * 8.0) * 0.7) + seed));',
      '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
      '  float dist = max(0.45, -mv.z);',
      '  float size = (0.030 + hash(seed * 12.0) * 0.040 + vGlow * 0.024 + uBeat * 0.010) * (1.0 + uBass * 0.18);',
      '  gl_PointSize = clamp(size * uPixel * 120.0 / dist, 1.0, 7.2);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColorA,uColorB;',
      'uniform float uOpacity,uTime,uBeat;',
      'varying float vSeed,vLane,vGlow;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  if(tex.a < 0.02) discard;',
      '  float tw = pow(0.5 + 0.5 * sin(uTime * (0.55 + fract(vSeed) * 0.35) + vSeed), 4.0);',
      '  vec3 col = mix(uColorA, uColorB, smoothstep(0.12, 0.92, vLane) * 0.45 + tw * 0.42 + vGlow * 0.26);',
      '  float alpha = tex.a * uOpacity * (0.20 + vGlow * 0.78 + tw * 0.32 + uBeat * 0.10);',
      '  gl_FragColor = vec4(col * (0.82 + vGlow * 0.72 + tw * 0.32), alpha);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  });
  var points = new THREE.Points(geo, mat);
  points.renderOrder = 45;
  points.frustumCulled = false;
  points.position.set(0, 0.20, 1.53);
  stageLyrics.group.add(points);
  stageLyrics.starRiver = points;
  return points;
}

function updateLyricStarRiver(dt) {
  var river = ensureLyricStarRiver();
  if (!river || !river.material || !river.material.uniforms) return;
  if (fx && fx.preset === SKULL_PRESET_INDEX) {
    river.visible = false;
    if (river.material.uniforms.uOpacity) river.material.uniforms.uOpacity.value = 0;
    return;
  }
  var u = river.material.uniforms;
  var data = stageLyrics.current && stageLyrics.current.userData ? stageLyrics.current.userData.lyric : null;
  var targetW = data ? clampRange((data.textWorldW || data.worldW || 4.2) * 1.12 + 0.80, 2.25, 7.20) : 3.4;
  var targetH = data ? clampRange((data.textWorldH || data.worldH || 0.58) * 1.85 + 0.18, 0.52, 1.35) : 0.58;
  stageLyrics.starRiverWidth += (targetW - stageLyrics.starRiverWidth) * Math.min(1, dt * 5.2);
  stageLyrics.starRiverHeight += (targetH - stageLyrics.starRiverHeight) * Math.min(1, dt * 4.6);
  u.uWidth.value = stageLyrics.starRiverWidth;
  u.uHeight.value = stageLyrics.starRiverHeight;
  var lyricGlowStrength = fx.lyricGlow ? Math.min(0.85, Math.max(0, fx.lyricGlowStrength)) : 0;
  var targetOpacity = (stageLyrics.current && fx.lyricGlowParticles)
    ? clampRange(0.22 + lyricGlowStrength * 0.58 + stageLyrics.highBloom * 0.16 + stageLyrics.beatGlow * 0.12, 0.16, 0.86)
    : 0;
  u.uOpacity.value += (targetOpacity - u.uOpacity.value) * (targetOpacity > u.uOpacity.value ? 0.10 : 0.055);
  u.uColorA.value.copy(lyricThreeColor(stageLyrics.palette.secondary || stageLyrics.palette.primary, '#9cffdf', 0.42));
  u.uColorB.value.copy(lyricThreeColor(stageLyrics.palette.highlight || stageLyrics.palette.primary, '#fff7d2', 0.46));
  river.visible = u.uOpacity.value > 0.01 || !!stageLyrics.current;
  var t = uniforms.uTime.value;
  river.position.y += ((0.18 + Math.sin(t * 0.44) * 0.035 + Math.sin(t * 0.91 + 1.7) * 0.018) - river.position.y) * 0.08;
  river.position.z += ((1.54 + Math.cos(t * 0.31) * 0.060) - river.position.z) * 0.08;
  river.rotation.z = Math.sin(t * 0.22) * 0.012;
}

function disposeLyricMesh(mesh) {
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.traverse(function(obj){
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(function(m){ if (m.map) m.map.dispose(); m.dispose(); });
      } else {
        if (obj.material.map) obj.material.map.dispose();
        if (obj.material.uniforms && obj.material.uniforms.uMap && obj.material.uniforms.uMap.value) obj.material.uniforms.uMap.value.dispose();
        obj.material.dispose();
      }
    }
    if (obj.geometry) obj.geometry.dispose();
  });
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h:h, s:s, l:l };
}
function hslToRgb(h, s, l) {
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  var r, g, b;
  if (s === 0) r = g = b = l;
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r:Math.round(r * 255), g:Math.round(g * 255), b:Math.round(b * 255) };
}
function rgbCss(c, a) {
  if (a == null) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
}
function clampRange(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normalizeCoverResolution(v) {
  return clampRange(Number(v) || 1, 0.75, 1.55);
}
function normalizePerformanceBackgroundMode(v, liveKeepFallback) {
  var value = String(v || '');
  if (value === 'keep' || liveKeepFallback === true) return 'keep';
  if (value === 'release') return 'release';
  return 'auto';
}
function normalizePerformanceQuality(v) {
  var value = String(v || '');
  return /^(eco|balanced|high|ultra)$/.test(value) ? value : fxDefaults.performanceQuality;
}
function coverParticleGridForResolution(v) {
  var grid = Math.round(118 * normalizeCoverResolution(v));
  grid = Math.max(88, Math.min(183, grid));
  return grid % 2 ? grid : grid + 1;
}
function coverParticleCountLabel(v) {
  var grid = coverParticleGridForResolution(v);
  return grid + 'x' + grid;
}
function coverTextureSizeForResolution(v) {
  v = normalizeCoverResolution(v);
  var size = 256;
  if (v >= 1.32) size = 512;
  else if (v >= 1.10) size = 384;
  if (mineradioUsesWebMediaBridge()) return Math.min(size, 256);
  return size;
}
function readSavedLyricLayout() {
  try {
    var savedLayoutRaw = localStorage.getItem(LYRIC_LAYOUT_STORE_KEY);
    var raw = savedLayoutRaw ? (JSON.parse(savedLayoutRaw) || {}) : packagedDefaultLyricLayoutRaw();
    var savedPreset = migrateVisualPresetIndex(raw.preset);
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) {
      savedPreset = 5;
    }
    var savedBgColor = normalizeHexColor(raw.backgroundColor || '#000000', '#000000');
    var savedBgOpacity = clampRange(raw.backgroundOpacity == null ? fxDefaults.backgroundOpacity : Number(raw.backgroundOpacity), 0, 1);
    var savedGlassOffset = clampRange(raw.controlGlassChromaticOffset == null ? fxDefaults.controlGlassChromaticOffset : Number(raw.controlGlassChromaticOffset), 0, 140);
    var savedBgMode = /^(cover|custom)$/.test(String(raw.backgroundColorMode || '')) ? String(raw.backgroundColorMode) : '';
    var savedBgCustom = savedBgMode
      ? savedBgMode === 'custom'
      : (raw.backgroundColorCustom === true || (raw.backgroundColorCustom !== false && savedBgColor !== '#000000') || savedBgOpacity < 1);
    var desktopLyricsSchemaReady = raw.desktopLyricsSchema === 'desktop-lyrics-v3';
    var savedShelfCameraMode = normalizeShelfCameraMode(raw.shelfCameraMode || fxDefaults.shelfCameraMode);
    var savedShelfAngleManual = raw.shelfAngleYManual === true;
    var savedShelfAngle = savedShelfAngleManual
      ? clampRange(raw.shelfAngleY == null ? shelfDefaultAngleForCameraMode(savedShelfCameraMode) : Number(raw.shelfAngleY), -30, 30)
      : shelfDefaultAngleForCameraMode(savedShelfCameraMode);
    return copyUnlistedFxFields(raw, {
      preset: savedPreset,
      intensity: clampRange(Number(raw.intensity) || fxDefaults.intensity, 0.2, 1.6),
      cinemaShake: clampRange(Number(raw.cinemaShake) || fxDefaults.cinemaShake, 0, 1.8),
      depth: clampRange(Number(raw.depth) || fxDefaults.depth, 0.2, 1.8),
      point: clampRange(Number(raw.point) || fxDefaults.point, 0.5, 2.2),
      speed: clampRange(Number(raw.speed) || fxDefaults.speed, 0.2, 2.5),
      twist: clampRange(Number(raw.twist) || fxDefaults.twist, 0, 0.6),
      color: clampRange(Number(raw.color) || fxDefaults.color, 0.5, 2.0),
      scatter: clampRange(Number(raw.scatter) || fxDefaults.scatter, 0, 0.5),
      bgFade: clampRange(Number(raw.bgFade) || fxDefaults.bgFade, 0, 1.2),
      bloomStrength: clampRange(Number(raw.bloomStrength) || fxDefaults.bloomStrength, 0, 1.6),
      lyricGlowStrength: clampRange(Number(raw.lyricGlowStrength) || fxDefaults.lyricGlowStrength, 0, 0.85),
      lyricScale: clampRange(Number(raw.lyricScale) || 1, 0.35, 1.65),
      lyricOffsetX: clampRange(Number(raw.lyricOffsetX) || 0, -2.0, 2.0),
      lyricOffsetY: clampRange(Number(raw.lyricOffsetY) || 0, -1.2, 1.35),
      lyricOffsetZ: clampRange(Number(raw.lyricOffsetZ) || 0, -1.6, 1.6),
      lyricTiltX: clampRange(Number(raw.lyricTiltX) || 0, -42, 42),
      lyricTiltY: clampRange(Number(raw.lyricTiltY) || 0, -42, 42),
      lyricCameraLock: !!raw.lyricCameraLock,
      lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
      lyricColor: normalizeHexColor(raw.lyricColor || '#a9b8c8'),
      lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
      lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || '#fff0b8'),
      lyricGlowLinked: raw.lyricGlowLinked !== false,
      lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || '#9db8cf'),
      lyricFont: normalizeLyricFontKey(raw.lyricFont),
      lyricLetterSpacing: clampRange(Number(raw.lyricLetterSpacing) || 0, -0.04, 0.18),
      lyricLineHeight: clampRange(Number(raw.lyricLineHeight) || 1, 0.86, 1.35),
      lyricWeight: clampRange(Number(raw.lyricWeight) || 900, 500, 900),
      lyricGlow: raw.lyricGlow !== false,
      lyricGlowBeat: raw.lyricGlowBeat !== false,
      lyricGlowParticles: !!raw.lyricGlowParticles,
      cinema: raw.cinema !== false,
      bloom: raw.bloom === true,
      edge: raw.edge === true,
      visualTintMode: raw.visualTintMode === 'custom' ? 'custom' : 'auto',
      visualTintColor: normalizeHexColor(raw.visualTintColor || '#9db8cf'),
      appTheme: window.MineradioThemes ? window.MineradioThemes.normalize(raw.appTheme || window.MineradioThemes.readStored()) : 'default',
      uiAccentColor: normalizeHexColor(raw.uiAccentColor || '#00f5d4', '#00f5d4'),
      homeAccentMode: raw.homeAccentMode === 'custom' ? 'custom' : 'auto',
      homeAccentColor: normalizeHexColor(raw.homeAccentColor || '#00f5d4'),
      homeIconColor: normalizeHexColor(raw.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a'),
      visualIconColor: normalizeHexColor(raw.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff'),
      backgroundColorMode: savedBgCustom ? 'custom' : 'cover',
      backgroundColor: savedBgColor,
      backgroundOpacity: savedBgOpacity,
      controlGlassChromaticOffset: savedGlassOffset,
      backgroundColorCustom: savedBgCustom,
      backgroundImage: normalizeCustomBackgroundImage(raw.backgroundImage),
      backgroundMedia: normalizeCustomBackgroundMedia(raw.backgroundMedia || raw.backgroundImage),
      desktopLyrics: raw.desktopLyrics === true,
      desktopLyricsSize: clampRange(Number(raw.desktopLyricsSize) || fxDefaults.desktopLyricsSize, 0.72, 1.55),
      desktopLyricsOpacity: clampRange(raw.desktopLyricsOpacity == null ? fxDefaults.desktopLyricsOpacity : Number(raw.desktopLyricsOpacity), 0.28, 1),
      desktopLyricsY: clampRange(raw.desktopLyricsY == null ? fxDefaults.desktopLyricsY : Number(raw.desktopLyricsY), 0.08, 0.92),
      desktopLyricsClickThrough: desktopLyricsSchemaReady ? raw.desktopLyricsClickThrough === true : fxDefaults.desktopLyricsClickThrough,
      desktopLyricsCinema: desktopLyricsSchemaReady ? raw.desktopLyricsCinema !== false : fxDefaults.desktopLyricsCinema,
      desktopLyricsHighlight: desktopLyricsSchemaReady ? raw.desktopLyricsHighlight === true : fxDefaults.desktopLyricsHighlight,
      desktopLyricsFps: desktopLyricsSchemaReady ? normalizeDesktopLyricsFps(raw.desktopLyricsFps) : fxDefaults.desktopLyricsFps,
      performanceBackground: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true),
      performanceQuality: normalizePerformanceQuality(raw.performanceQuality),
      liveBackgroundKeep: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true) === 'keep',
      wallpaperMode: false,
      wallpaperOpacity: clampRange(raw.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(raw.wallpaperOpacity), 0.35, 1),
      coverResolution: normalizeCoverResolution(raw.coverResolution),
      shelf: /^(off|side|stage)$/.test(String(raw.shelf || '')) ? raw.shelf : fxDefaults.shelf,
      shelfCameraMode: savedShelfCameraMode,
      shelfPresence: normalizeShelfPresence(raw.shelfPresence || fxDefaults.shelfPresence),
      shelfShowPodcasts: raw.shelfShowPodcasts !== false,
      shelfMergeCollections: raw.shelfMergeCollections === true,
      shelfSize: clampRange(raw.shelfSize == null ? fxDefaults.shelfSize : Number(raw.shelfSize), 0.65, 1.45),
      shelfOffsetX: clampRange(raw.shelfOffsetX == null ? fxDefaults.shelfOffsetX : Number(raw.shelfOffsetX), -1.2, 1.2),
      shelfOffsetY: clampRange(raw.shelfOffsetY == null ? fxDefaults.shelfOffsetY : Number(raw.shelfOffsetY), -0.9, 0.9),
      shelfOffsetZ: clampRange(raw.shelfOffsetZ == null ? fxDefaults.shelfOffsetZ : Number(raw.shelfOffsetZ), -0.9, 0.9),
      shelfAngleY: savedShelfAngle,
      shelfAngleYManual: savedShelfAngleManual,
      shelfOpacity: clampRange(raw.shelfOpacity == null ? fxDefaults.shelfOpacity : Number(raw.shelfOpacity), 0.25, 1),
      shelfBgOpacity: clampRange(raw.shelfBgOpacity == null ? fxDefaults.shelfBgOpacity : Number(raw.shelfBgOpacity), 0.25, 0.98),
      shelfAccentColor: normalizeHexColor(raw.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor),
      cam: /^(off|gesture)$/.test(String(raw.cam || '')) ? raw.cam : fxDefaults.cam
    });
  } catch (e) {
    return {};
  }
}
function copyUnlistedFxFields(raw, out) {
  Object.keys(fxDefaults).forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(out, key)) return;
    if (!raw || !Object.prototype.hasOwnProperty.call(raw, key)) return;
    var kind = typeof fxDefaults[key];
    if (kind === 'boolean') out[key] = raw[key] === true;
    else if (kind === 'number' && isFinite(Number(raw[key]))) out[key] = Number(raw[key]);
    else if (kind === 'string') out[key] = String(raw[key]);
  });
  return out;
}
function flushLyricLayoutSave() {
  try {
    var presetForSave = startupVisualPreviewActive && !playing && currentIdx < 0
      ? playbackVisualPreset
      : migrateVisualPresetIndex(fx.preset);
    localStorage.setItem(LYRIC_LAYOUT_STORE_KEY, JSON.stringify({
      visualPresetSchema: VISUAL_PRESET_SCHEMA,
      desktopLyricsSchema: 'desktop-lyrics-v3',
      preset: presetForSave,
      intensity: clampRange(Number(fx.intensity) || fxDefaults.intensity, 0.2, 1.6),
      cinemaShake: clampRange(Number(fx.cinemaShake) || fxDefaults.cinemaShake, 0, 1.8),
      depth: clampRange(Number(fx.depth) || fxDefaults.depth, 0.2, 1.8),
      point: clampRange(Number(fx.point) || fxDefaults.point, 0.5, 2.2),
      speed: clampRange(Number(fx.speed) || fxDefaults.speed, 0.2, 2.5),
      twist: clampRange(Number(fx.twist) || fxDefaults.twist, 0, 0.6),
      color: clampRange(Number(fx.color) || fxDefaults.color, 0.5, 2.0),
      scatter: clampRange(Number(fx.scatter) || fxDefaults.scatter, 0, 0.5),
      bgFade: clampRange(Number(fx.bgFade) || fxDefaults.bgFade, 0, 1.2),
      bloomStrength: clampRange(Number(fx.bloomStrength) || fxDefaults.bloomStrength, 0, 1.6),
      lyricGlowStrength: clampRange(Number(fx.lyricGlowStrength) || fxDefaults.lyricGlowStrength, 0, 0.85),
      lyricScale: clampRange(Number(fx.lyricScale) || 1, 0.35, 1.65),
      lyricOffsetX: clampRange(Number(fx.lyricOffsetX) || 0, -2.0, 2.0),
      lyricOffsetY: clampRange(Number(fx.lyricOffsetY) || 0, -1.2, 1.35),
      lyricOffsetZ: clampRange(Number(fx.lyricOffsetZ) || 0, -1.6, 1.6),
      lyricTiltX: clampRange(Number(fx.lyricTiltX) || 0, -42, 42),
      lyricTiltY: clampRange(Number(fx.lyricTiltY) || 0, -42, 42),
      lyricCameraLock: !!fx.lyricCameraLock,
      lyricColorMode: fx.lyricColorMode === 'custom' ? 'custom' : 'auto',
      lyricColor: normalizeHexColor(fx.lyricColor || '#a9b8c8'),
      lyricHighlightMode: fx.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
      lyricHighlightColor: normalizeHexColor(fx.lyricHighlightColor || '#fff0b8'),
      lyricGlowLinked: fx.lyricGlowLinked !== false,
      lyricGlowColor: normalizeHexColor(fx.lyricGlowColor || '#9db8cf'),
      lyricFont: normalizeLyricFontKey(fx.lyricFont),
      lyricLetterSpacing: clampRange(Number(fx.lyricLetterSpacing) || 0, -0.04, 0.18),
      lyricLineHeight: clampRange(Number(fx.lyricLineHeight) || 1, 0.86, 1.35),
      lyricWeight: clampRange(Number(fx.lyricWeight) || 900, 500, 900),
      lyricGlow: !!fx.lyricGlow,
      lyricGlowBeat: !!fx.lyricGlowBeat,
      lyricGlowParticles: !!fx.lyricGlowParticles,
      cinema: !!fx.cinema,
      bloom: !!fx.bloom,
      edge: !!fx.edge,
      visualTintMode: fx.visualTintMode === 'custom' ? 'custom' : 'auto',
      visualTintColor: normalizeHexColor(fx.visualTintColor || '#9db8cf'),
      appTheme: window.MineradioThemes ? window.MineradioThemes.normalize(fx.appTheme) : 'default',
      uiAccentColor: normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4'),
      homeAccentMode: fx.homeAccentMode === 'custom' ? 'custom' : 'auto',
      homeAccentColor: normalizeHexColor(fx.homeAccentColor || '#00f5d4'),
      homeIconColor: normalizeHexColor(fx.homeIconColor || '#f4d28a', '#f4d28a'),
      visualIconColor: normalizeHexColor(fx.visualIconColor || '#7fd8ff', '#7fd8ff'),
      backgroundColorMode: fx.backgroundColorMode === 'custom' || fx.backgroundColorCustom ? 'custom' : 'cover',
      backgroundColor: normalizeHexColor(fx.backgroundColor || '#000000', '#000000'),
      backgroundOpacity: clampRange(fx.backgroundOpacity == null ? fxDefaults.backgroundOpacity : Number(fx.backgroundOpacity), 0, 1),
      controlGlassChromaticOffset: clampRange(fx.controlGlassChromaticOffset == null ? fxDefaults.controlGlassChromaticOffset : Number(fx.controlGlassChromaticOffset), 0, 140),
      backgroundColorCustom: fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom,
      backgroundImage: normalizeCustomBackgroundImage(fx.backgroundImage),
      backgroundMedia: normalizeCustomBackgroundMedia(fx.backgroundMedia || fx.backgroundImage),
      desktopLyrics: !!fx.desktopLyrics,
      desktopLyricsSize: clampRange(Number(fx.desktopLyricsSize) || fxDefaults.desktopLyricsSize, 0.72, 1.55),
      desktopLyricsOpacity: clampRange(fx.desktopLyricsOpacity == null ? fxDefaults.desktopLyricsOpacity : Number(fx.desktopLyricsOpacity), 0.28, 1),
      desktopLyricsY: clampRange(fx.desktopLyricsY == null ? fxDefaults.desktopLyricsY : Number(fx.desktopLyricsY), 0.08, 0.92),
      desktopLyricsClickThrough: fx.desktopLyricsClickThrough === true,
      desktopLyricsCinema: fx.desktopLyricsCinema !== false,
      desktopLyricsHighlight: fx.desktopLyricsHighlight === true,
      desktopLyricsFps: normalizeDesktopLyricsFps(fx.desktopLyricsFps),
      performanceBackground: normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true),
      performanceQuality: normalizePerformanceQuality(fx.performanceQuality),
      liveBackgroundKeep: normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true) === 'keep',
      wallpaperMode: false,
      wallpaperOpacity: clampRange(fx.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(fx.wallpaperOpacity), 0.35, 1),
      coverResolution: normalizeCoverResolution(fx.coverResolution),
      shelf: /^(off|side|stage)$/.test(String(fx.shelf || '')) ? fx.shelf : fxDefaults.shelf,
      shelfCameraMode: normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode),
      shelfPresence: normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence),
      shelfShowPodcasts: fx.shelfShowPodcasts !== false,
      shelfMergeCollections: fx.shelfMergeCollections === true,
      shelfSize: clampRange(fx.shelfSize == null ? fxDefaults.shelfSize : Number(fx.shelfSize), 0.65, 1.45),
      shelfOffsetX: clampRange(fx.shelfOffsetX == null ? fxDefaults.shelfOffsetX : Number(fx.shelfOffsetX), -1.2, 1.2),
      shelfOffsetY: clampRange(fx.shelfOffsetY == null ? fxDefaults.shelfOffsetY : Number(fx.shelfOffsetY), -0.9, 0.9),
      shelfOffsetZ: clampRange(fx.shelfOffsetZ == null ? fxDefaults.shelfOffsetZ : Number(fx.shelfOffsetZ), -0.9, 0.9),
      shelfAngleY: clampRange(fx.shelfAngleY == null ? fxDefaults.shelfAngleY : Number(fx.shelfAngleY), -30, 30),
      shelfAngleYManual: fx.shelfAngleYManual === true,
      shelfOpacity: clampRange(fx.shelfOpacity == null ? fxDefaults.shelfOpacity : Number(fx.shelfOpacity), 0.25, 1),
      shelfBgOpacity: clampRange(fx.shelfBgOpacity == null ? fxDefaults.shelfBgOpacity : Number(fx.shelfBgOpacity), 0.25, 0.98),
      shelfAccentColor: normalizeHexColor(fx.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor),
      cam: /^(off|gesture)$/.test(String(fx.cam || '')) ? fx.cam : fxDefaults.cam
    }));
    var saved = JSON.parse(localStorage.getItem(LYRIC_LAYOUT_STORE_KEY) || '{}') || {};
    copyUnlistedFxFields(fx, saved);
    localStorage.setItem(LYRIC_LAYOUT_STORE_KEY, JSON.stringify(saved));
  } catch (e) {}
}
var saveLyricLayout = (function(){
  var flush = flushLyricLayoutSave;
  if (window.MineradioRuntime && typeof window.MineradioRuntime.debounce === 'function') {
    var debounced = window.MineradioRuntime.debounce(flush, 320);
    return function saveLyricLayout(opts) {
      opts = opts || {};
      if (opts.immediate) {
        debounced.cancel();
        flush();
        return;
      }
      debounced();
    };
  }
  return function saveLyricLayout() { flush(); };
})();
function normalizeHexColor(value, fallback) {
  var hex = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = '#' + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3);
  }
  fallback = /^#[0-9a-f]{6}$/i.test(String(fallback || '')) ? String(fallback).toLowerCase() : '#a9b8c8';
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
}
function normalizeDesktopLyricsFps(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  if (n <= 26) return 24;
  if (n <= 45) return 30;
  if (n <= 90) return 60;
  return 120;
}
function normalizeShelfCameraMode(value) {
  return String(value || '') === 'static' ? 'static' : 'dynamic';
}
function shelfDefaultAngleForCameraMode(mode) {
  return normalizeShelfCameraMode(mode) === 'static' ? -15 : 0;
}
function applyShelfCameraDefaultAngle(force) {
  if (!fx) return;
  fx.shelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  if (force || fx.shelfAngleYManual !== true) {
    fx.shelfAngleYManual = false;
    fx.shelfAngleY = shelfDefaultAngleForCameraMode(fx.shelfCameraMode);
  } else {
    fx.shelfAngleY = Math.round(clampRange(Number(fx.shelfAngleY) || 0, -30, 30));
  }
}
function normalizeShelfPresence(value) {
  return String(value || '') === 'always' ? 'always' : 'auto';
}
function normalizedShelfNumber(key, fallback, min, max) {
  var value = fx && fx[key] != null ? Number(fx[key]) : fallback;
  if (!isFinite(value)) value = fallback;
  return clampRange(value, min, max);
}
function shelfSettings() {
  var angleDeg = fx && fx.shelfAngleYManual === true
    ? normalizedShelfNumber('shelfAngleY', shelfDefaultAngleForCameraMode(fx.shelfCameraMode), -30, 30)
    : shelfDefaultAngleForCameraMode(fx && fx.shelfCameraMode);
  return {
    size: normalizedShelfNumber('shelfSize', fxDefaults.shelfSize, 0.65, 1.45),
    x: normalizedShelfNumber('shelfOffsetX', fxDefaults.shelfOffsetX, -1.2, 1.2),
    y: normalizedShelfNumber('shelfOffsetY', fxDefaults.shelfOffsetY, -0.9, 0.9),
    z: normalizedShelfNumber('shelfOffsetZ', fxDefaults.shelfOffsetZ, -0.9, 0.9),
    angle: angleDeg * Math.PI / 180,
    opacity: normalizedShelfNumber('shelfOpacity', fxDefaults.shelfOpacity, 0.25, 1),
    bgOpacity: normalizedShelfNumber('shelfBgOpacity', fxDefaults.shelfBgOpacity, 0.25, 0.98),
    accent: normalizeHexColor((fx && fx.shelfAccentColor) || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor)
  };
}
function shelfAlwaysVisible() {
  return !!(fx && normalizeShelfPresence(fx.shelfPresence) === 'always');
}
function shouldUseShelfDynamicCamera(type) {
  if (!/^shelf-/.test(String(type || ''))) return true;
  return !(fx && normalizeShelfCameraMode(fx.shelfCameraMode) === 'static');
}
function shelfAccentHex() {
  return normalizeHexColor((fx && fx.shelfAccentColor) || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor);
}
function shelfAccentRgba(alpha, fallback) {
  var rgb = hexToRgb(shelfAccentHex());
  if (!rgb) return fallback || 'rgba(244,210,138,' + alpha + ')';
  return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
}
function rgbToHexColor(r, g, b) {
  function part(v) {
    return Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0');
  }
  return '#' + part(r) + part(g) + part(b);
}
function normalizeLyricFontKey(value) {
  value = String(value || 'sans');
  return /^(sans|hei|song|bold-song|stone-song|kai-song|serif-en|gothic|editorial|humanist|round|mono|display)$/.test(value) ? value : 'sans';
}
function lyricFontStackForKey(key) {
  key = normalizeLyricFontKey(key);
  if (key === 'hei') return '"Noto Sans SC","Microsoft YaHei",SimHei,"PingFang SC",sans-serif';
  if (key === 'song') return '"Noto Serif SC","Source Han Serif SC",SimSun,"Songti SC",serif';
  if (key === 'bold-song') return '"Source Han Serif SC Heavy","Source Han Serif SC","Noto Serif SC Black","Noto Serif SC","STZhongsong","SimSun",serif';
  if (key === 'stone-song') return '"FZYaSongS-B-GB","FZCuSong-B09S","Source Han Serif SC Heavy","Noto Serif SC Black","STZhongsong","SimSun",serif';
  if (key === 'kai-song') return '"Kaiti SC","STKaiti","KaiTi","Source Han Serif SC","Noto Serif SC",serif';
  if (key === 'serif-en') return 'Georgia,"Times New Roman","Noto Serif SC","Source Han Serif SC",serif';
  if (key === 'gothic') return '"UnifrakturCook","UnifrakturMaguntia","Old English Text MT","Blackletter","Cinzel Decorative","Noto Serif SC",serif';
  if (key === 'editorial') return '"Didot","Bodoni 72","Libre Baskerville",Georgia,"Noto Serif SC",serif';
  if (key === 'humanist') return '"Avenir Next","Segoe UI","Inter","Noto Sans SC","PingFang SC",sans-serif';
  if (key === 'round') return '"HarmonyOS Sans SC","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif';
  if (key === 'mono') return '"JetBrains Mono",Consolas,"Noto Sans SC","Microsoft YaHei",monospace';
  if (key === 'display') return '"Alibaba PuHuiTi","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
  return 'Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif';
}
function lyricFontWeightValue() {
  if (normalizeLyricFontKey(fx && fx.lyricFont) === 'stone-song') return 900;
  return Math.round(clampRange(Number(fx && fx.lyricWeight) || 900, 500, 900) / 50) * 50;
}
function lyricFontCss(fontSize) {
  return lyricFontWeightValue() + ' ' + fontSize + 'px ' + lyricFontStackForKey(fx && fx.lyricFont);
}
function lyricLetterSpacingPx(fontSize) {
  return clampRange(Number(fx && fx.lyricLetterSpacing) || 0, -0.04, 0.18) * Math.max(1, fontSize || 1);
}
function lyricLineHeightFactor() {
  return clampRange(Number(fx && fx.lyricLineHeight) || 1, 0.86, 1.35);
}
function measureTextWithLetterSpacing(ctx, text, spacing) {
  text = String(text || '');
  spacing = Number(spacing) || 0;
  if (!spacing || text.length < 2) return ctx.measureText(text).width;
  var chars = Array.from(text);
  var w = 0;
  for (var i = 0; i < chars.length; i++) {
    w += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) w += spacing;
  }
  return Math.max(1, w);
}
function lyricMeasureText(ctx, text, fontSize) {
  return measureTextWithLetterSpacing(ctx, text, lyricLetterSpacingPx(fontSize));
}
function drawTextWithLetterSpacing(ctx, text, x, y, spacing, stroke) {
  text = String(text || '');
  spacing = Number(spacing) || 0;
  if (!spacing || text.length < 2) {
    if (stroke) ctx.strokeText(text, x, y);
    else ctx.fillText(text, x, y);
    return;
  }
  var chars = Array.from(text);
  var align = ctx.textAlign || 'left';
  var width = measureTextWithLetterSpacing(ctx, text, spacing);
  var start = x;
  if (align === 'center') start = x - width / 2;
  else if (align === 'right' || align === 'end') start = x - width;
  ctx.textAlign = 'left';
  var cursor = start;
  for (var i = 0; i < chars.length; i++) {
    if (stroke) ctx.strokeText(chars[i], cursor, y);
    else ctx.fillText(chars[i], cursor, y);
    cursor += ctx.measureText(chars[i]).width + (i < chars.length - 1 ? spacing : 0);
  }
  ctx.textAlign = align;
}
function lyricFillText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), false);
}
function lyricStrokeText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), true);
}
function applyStonePrintTexture(ctx, W, H, fontSize) {
  if (normalizeLyricFontKey(fx && fx.lyricFont) !== 'stone-song') return;
  var size = clampRange(fontSize || 128, 42, 180);
  var bandTop = H * 0.10;
  var bandH = H * 0.80;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';

  var noiseW = 300, noiseH = 110;
  var noise = document.createElement('canvas');
  noise.width = noiseW; noise.height = noiseH;
  var nctx = noise.getContext('2d');
  var img = nctx.createImageData(noiseW, noiseH);
  for (var p = 0; p < noiseW * noiseH; p++) {
    var x0 = p % noiseW;
    var y0 = Math.floor(p / noiseW);
    var vein = Math.sin(x0 * 0.19 + y0 * 0.043) * 0.10 + Math.sin(y0 * 0.31) * 0.06;
    var r = Math.random() + vein;
    var a = 0;
    if (r > 0.82) a = 78 + Math.random() * 92;
    else if (r > 0.62) a = 22 + Math.random() * 54;
    else if (r > 0.48) a = 4 + Math.random() * 24;
    img.data[p * 4] = 255;
    img.data[p * 4 + 1] = 255;
    img.data[p * 4 + 2] = 255;
    img.data[p * 4 + 3] = a;
  }
  nctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 0.34;
  ctx.drawImage(noise, 0, bandTop, W, bandH);

  var chips = Math.round(size * 7.2);
  for (var i = 0; i < chips; i++) {
    var x = Math.random() * W;
    var y = bandTop + Math.random() * bandH;
    var w = 0.7 + Math.random() * (size * 0.052);
    var h = 0.45 + Math.random() * (size * 0.026);
    ctx.globalAlpha = 0.16 + Math.random() * 0.36;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Math.random() - 0.5) * 0.38);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  ctx.lineCap = 'round';
  for (var s = 0; s < 44; s++) {
    var sx = Math.random() * W;
    var sy = bandTop + Math.random() * bandH;
    ctx.globalAlpha = 0.09 + Math.random() * 0.16;
    ctx.lineWidth = 0.45 + Math.random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10 + Math.random() * 86, sy + (Math.random() - 0.5) * 4.8);
    ctx.stroke();
  }

  for (var c = 0; c < 26; c++) {
    var cx = Math.random() * W;
    var cy = bandTop + Math.random() * bandH;
    var radius = 1.8 + Math.random() * (size * 0.060);
    ctx.globalAlpha = 0.08 + Math.random() * 0.18;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * (0.7 + Math.random() * 1.4), radius * (0.25 + Math.random() * 0.55), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
function hexToRgb(hex) {
  hex = normalizeHexColor(hex).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}
function normalizeCustomBackgroundImage(value) {
  var src = String(value || '').trim();
  if (!src) return '';
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return src;
  return '';
}
function normalizeCustomBackgroundMedia(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    var img = normalizeCustomBackgroundImage(value);
    if (img) return { type: 'image', src: img };
    if (/^data:video\/(mp4|webm|quicktime);base64,/i.test(value) || /^https?:\/\//i.test(value)) return { type: 'video', src: String(value) };
    return null;
  }
  if (typeof value !== 'object') return null;
  var type = value.type === 'video' ? 'video' : (value.type === 'image' ? 'image' : '');
  if (type === 'image') {
    var imageSrc = normalizeCustomBackgroundImage(value.src || value.url || '');
    return imageSrc ? { type: 'image', src: imageSrc } : null;
  }
  if (type === 'video') {
    var src = String(value.src || '').trim();
    var id = String(value.id || '').trim();
    if (!id && !/^data:video\/(mp4|webm|quicktime);base64,/i.test(src) && !/^https?:\/\//i.test(src)) return null;
    return {
      type: 'video',
      id: id,
      src: src,
      name: String(value.name || '').slice(0, 120),
      mime: String(value.mime || '').slice(0, 80),
      size: Math.max(0, Number(value.size) || 0)
    };
  }
  return null;
}
function customBackgroundMediaLabel(media) {
  media = normalizeCustomBackgroundMedia(media);
  if (!media) return '未设置';
  return media.type === 'video' ? '视频已设置' : '图片已设置';
}
var CUSTOM_BG_DB_NAME = 'mineradio-custom-background-v1';
var CUSTOM_BG_STORE = 'media';
var customBgObjectUrl = '';
var customBgApplyToken = 0;
function openCustomBackgroundDb() {
  return new Promise(function(resolve, reject){
    if (!window.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
    var req = indexedDB.open(CUSTOM_BG_DB_NAME, 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if (!db.objectStoreNames.contains(CUSTOM_BG_STORE)) db.createObjectStore(CUSTOM_BG_STORE, { keyPath: 'id' });
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error || new Error('indexedDB open failed')); };
  });
}
async function putCustomBackgroundBlob(id, blob, meta) {
  var db = await openCustomBackgroundDb();
  return new Promise(function(resolve, reject){
    var tx = db.transaction(CUSTOM_BG_STORE, 'readwrite');
    tx.objectStore(CUSTOM_BG_STORE).put(Object.assign({ id: id, blob: blob, savedAt: Date.now() }, meta || {}));
    tx.oncomplete = function(){ db.close(); resolve(); };
    tx.onerror = function(){ db.close(); reject(tx.error || new Error('indexedDB put failed')); };
  });
}
async function getCustomBackgroundBlob(id) {
  var db = await openCustomBackgroundDb();
  return new Promise(function(resolve, reject){
    var tx = db.transaction(CUSTOM_BG_STORE, 'readonly');
    var req = tx.objectStore(CUSTOM_BG_STORE).get(id);
    req.onsuccess = function(){ resolve(req.result && req.result.blob ? req.result.blob : null); };
    req.onerror = function(){ reject(req.error || new Error('indexedDB get failed')); };
    tx.oncomplete = function(){ db.close(); };
  });
}
var colorLabState = { picker: null, id: '', h: 0, s: 1, v: 1, dragging: false };
var COLOR_LAB_PRESETS = [
  { name: '极黑', color: '#000000' },
  { name: '极白', color: '#ffffff' },
  { name: '克莱因蓝', color: '#002fa7' },
  { name: '法拉利红', color: '#f00000' },
  { name: '香槟金', color: '#c8a96a' },
  { name: '孔雀绿', color: '#006b5b' },
  { name: '午夜紫', color: '#2b164f' },
  { name: '银雾', color: '#d9dde2' }
];
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var d = max - min, h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToHex(h, s, v) {
  h = ((h % 1) + 1) % 1; s = clampRange(s, 0, 1); v = clampRange(v, 0, 1);
  var i = Math.floor(h * 6), f = h * 6 - i;
  var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  var r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return rgbToHexColor(r * 255, g * 255, b * 255);
}
function applyColorLabValue(hex, silent) {
  hex = normalizeHexColor(hex || '#000000', '#000000');
  var id = colorLabState.id;
  if (id === 'ui-accent-picker') setUiAccentColor(hex, true);
  else if (id === 'visual-tint-picker') setVisualTintCustom(hex, true);
  else if (id === 'home-accent-picker') setHomeAccentColor(hex, true);
  else if (id === 'home-icon-picker') setHomeIconColor(hex, true);
  else if (id === 'visual-icon-picker') setVisualIconColor(hex, true);
  else if (id === 'bg-color-picker') setCustomBackgroundColor(hex, true, true);
  else if (id === 'shelf-accent-picker') setShelfAccentColor(hex, true);
  else if (id === 'lyric-color-picker') setLyricColorCustom(hex, true);
  else if (id === 'lyric-highlight-picker') setLyricHighlightCustom(hex, true);
  else if (id === 'lyric-glow-picker') setLyricGlowCustom(hex, true);
  if (!silent) showToast('颜色: ' + hex.toUpperCase());
}
function syncColorLabUi(hex) {
  hex = normalizeHexColor(hex || '#000000', '#000000');
  var rgb = hexToRgb(hex);
  var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  colorLabState.h = hsv.h; colorLabState.s = hsv.s; colorLabState.v = hsv.v;
  var pop = document.getElementById('color-lab-pop');
  var sv = document.getElementById('color-lab-sv');
  var cursor = document.getElementById('color-lab-cursor');
  var hue = document.getElementById('color-lab-hue');
  var hexInput = document.getElementById('color-lab-hex');
  var preview = document.getElementById('color-lab-preview');
  var hueHex = hsvToHex(colorLabState.h, 1, 1);
  if (pop) {
    pop.style.setProperty('--lab-color', hex);
    pop.style.setProperty('--lab-hue', hueHex);
  }
  if (sv) sv.style.setProperty('--lab-hue', hueHex);
  if (cursor) { cursor.style.left = (colorLabState.s * 100).toFixed(2) + '%'; cursor.style.top = ((1 - colorLabState.v) * 100).toFixed(2) + '%'; }
  if (hue) hue.value = Math.round(colorLabState.h * 360);
  if (hexInput) hexInput.value = hex.toUpperCase();
  if (preview) preview.style.setProperty('--lab-color', hex);
}
function closeColorLab() {
  var pop = document.getElementById('color-lab-pop');
  if (pop) pop.classList.remove('show');
  colorLabState.picker = null;
  colorLabState.id = '';
}
function placeFxFloatingPanel(pop, anchor, opts) {
  if (!pop || !anchor || !anchor.getBoundingClientRect) return;
  opts = opts || {};
  var gap = opts.gap == null ? 12 : opts.gap;
  var pad = opts.pad == null ? 14 : opts.pad;
  var rect = anchor.getBoundingClientRect();
  var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 320);
  var vh = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320);
  var pw = Math.min(pop.offsetWidth || pop.getBoundingClientRect().width || 330, vw - pad * 2);
  var ph = Math.min(pop.offsetHeight || pop.getBoundingClientRect().height || 260, vh - pad * 2);
  var left;
  var top;
  if (vw < 760) {
    left = Math.max(pad, Math.min(vw - pw - pad, rect.left + rect.width / 2 - pw / 2));
    top = rect.bottom + gap;
    if (top + ph > vh - pad) top = Math.max(pad, rect.top - ph - gap);
  } else {
    var roomRight = vw - rect.right - pad;
    var roomLeft = rect.left - pad;
    if (roomRight >= pw + gap || roomRight >= roomLeft) left = rect.right + gap;
    else left = rect.left - pw - gap;
    left = Math.max(pad, Math.min(vw - pw - pad, left));
    top = rect.top + rect.height / 2 - ph / 2;
    top = Math.max(pad, Math.min(vh - ph - pad, top));
  }
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  pop.style.transform = 'none';
}
function openColorLabForPicker(picker) {
  var pop = document.getElementById('color-lab-pop');
  if (!picker || !pop) return;
  if (pop.classList.contains('show') && colorLabState.picker === picker) {
    closeColorLab();
    return;
  }
  colorLabState.picker = picker;
  colorLabState.id = picker.id || '';
  var label = picker.closest('.lyric-color-row');
  var title = document.getElementById('color-lab-title');
  if (title) title.textContent = label ? (label.textContent || 'Color').replace(/#[0-9a-f]{6}/ig, '').trim().slice(0, 24) : 'Color';
  syncColorLabUi(picker.value || '#000000');
  var presets = document.getElementById('color-lab-presets');
  if (presets) {
    presets.innerHTML = COLOR_LAB_PRESETS.map(function(p){
      return '<button type="button" title="' + escHtml(p.name) + '" style="--c:' + p.color + '" data-color="' + p.color + '"></button>';
    }).join('');
  }
  pop.classList.add('show');
  placeFxFloatingPanel(pop, label || picker, { gap: 12, pad: 14 });
}
function updateColorLabFromSv(e) {
  var sv = document.getElementById('color-lab-sv');
  if (!sv) return;
  var rect = sv.getBoundingClientRect();
  colorLabState.s = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  colorLabState.v = 1 - clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  var hex = hsvToHex(colorLabState.h, colorLabState.s, colorLabState.v);
  syncColorLabUi(hex);
  applyColorLabValue(hex, true);
}
function bindColorLabPicker(picker) {
  if (!picker || picker._colorLabBound) return;
  picker._colorLabBound = true;
  picker.setAttribute('aria-haspopup', 'dialog');
  picker.setAttribute('data-color-lab-picker', '1');
  function openFromPickerEvent(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    picker._colorLabOpenedAt = Date.now();
    openColorLabForPicker(picker);
  }
  picker.addEventListener('pointerdown', openFromPickerEvent);
  picker.addEventListener('mousedown', function(e){ e.preventDefault(); e.stopPropagation(); });
  picker.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - (picker._colorLabOpenedAt || 0) < 260) return;
    openColorLabForPicker(picker);
  });
  picker.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ' ') openFromPickerEvent(e);
  });
}
function liftFxFloatingPopups() {
  ['cover-color-pop', 'color-lab-pop', 'cover-color-loupe'].forEach(function(id){
    var el = document.getElementById(id);
    if (el && el.parentElement !== document.body) document.body.appendChild(el);
  });
}
function bindColorLabRows() {
  document.querySelectorAll('.lyric-color-row').forEach(function(row){
    if (!row || row._colorLabRowBound || row.classList.contains('linked')) return;
    var picker = row.querySelector('.lyric-color-picker');
    if (!picker) return;
    row._colorLabRowBound = true;
    row.addEventListener('pointerdown', function(e){
      if (!e || !e.target) return;
      if (e.target.closest('button,.fx-mini-btn,input[type="range"],select,textarea')) return;
      e.preventDefault();
      e.stopPropagation();
      picker._colorLabOpenedAt = Date.now();
      openColorLabForPicker(picker);
    });
  });
}
function repositionFxFloatingPanels() {
  var colorPop = document.getElementById('color-lab-pop');
  if (colorPop && colorPop.classList.contains('show') && colorLabState.picker) {
    placeFxFloatingPanel(colorPop, colorLabState.picker.closest('.lyric-color-row') || colorLabState.picker, { gap: 12, pad: 14 });
  }
  var coverPop = document.getElementById('cover-color-pop');
  if (coverPop && coverPop.classList.contains('show')) {
    placeFxFloatingPanel(coverPop, document.getElementById('visual-tint-auto-btn') || document.getElementById('visual-tint-picker') || coverPop, { gap: 12, pad: 14 });
  }
}
window.addEventListener('resize', function(){
  if (window.requestAnimationFrame) requestAnimationFrame(repositionFxFloatingPanels);
  else repositionFxFloatingPanels();
});
function uiAccentHex(fallback) {
  return normalizeHexColor((fx && fx.uiAccentColor) || fallback || '#00f5d4', fallback || '#00f5d4');
}
function uiAccentRgba(alpha, fallback) {
  var c = hexToRgb(uiAccentHex(fallback));
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (alpha == null ? 1 : alpha) + ')';
}
function readableInkForHex(hex) {
  var c = hexToRgb(hex || '#00f5d4');
  var lum = (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255;
  return lum > 0.54 ? '#06100f' : '#f8fbff';
}
function lyricPaletteFromHex(hex) {
  var c = hexToRgb(hex);
  var hsl = rgbToHsl(c.r, c.g, c.b);
  var neutral = hsl.s < 0.035;
  var s = neutral ? 0 : clampRange(hsl.s * 1.08, 0.14, 0.92);
  var l = hsl.l;
  if (l < 0.11) l = 0.15 + l * 1.18;
  else if (l < 0.28) l = 0.21 + (l - 0.11) * 1.18;
  else l = clampRange(l, 0.30, 0.82);
  l = clampRange(l, 0.14, 0.84);
  var primary = hslToRgb(hsl.h, s, l);
  var secondary = hslToRgb((hsl.h + 0.055) % 1, neutral ? 0 : clampRange(s * 0.88, 0.12, 0.78), clampRange(l + (l < 0.38 ? 0.10 : -0.08), 0.18, 0.76));
  var highlight = hslToRgb((hsl.h + 0.018) % 1, neutral ? 0 : clampRange(s * 0.72, 0.10, 0.70), clampRange(l + 0.22, 0.38, 0.92));
  var darkText = l < 0.40;
  return {
    primary: rgbCss(primary),
    secondary: rgbCss(secondary),
    highlight: rgbCss(highlight),
    shadow: darkText ? 'rgba(0,6,10,0.46)' : 'rgba(248,253,255,0.34)',
    glow: rgbCss(primary, 0.26),
  };
}
function silverBlueLyricPalette() {
  return {
    primary: '#d8f1ff',
    secondary: '#9db8cf',
    highlight: '#eef7ff',
    shadow: 'rgba(0,7,12,0.48)',
    glow: 'rgba(138,190,255,0.26)',
  };
}
function setLyricSparkOpacity(data, value) {
  if (!data || !data.sparkMat) return;
  value = clampRange(Number(value) || 0, 0, 1);
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uOpacity) data.sparkMat.uniforms.uOpacity.value = value;
  else data.sparkMat.opacity = value;
}
function getLyricSparkOpacity(data) {
  if (!data || !data.sparkMat) return 0;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uOpacity) return Number(data.sparkMat.uniforms.uOpacity.value) || 0;
  return Number(data.sparkMat.opacity) || 0;
}
function setLyricSparkSize(data, value) {
  if (!data || !data.sparkMat) return;
  value = Math.max(0.002, Number(value) || 0.035);
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uSize) data.sparkMat.uniforms.uSize.value = value;
  else data.sparkMat.size = value;
}
function getLyricSparkSize(data) {
  if (!data || !data.sparkMat) return 0.035;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uSize) return Number(data.sparkMat.uniforms.uSize.value) || 0.035;
  return Number(data.sparkMat.size) || 0.035;
}
function setLyricSparkColor(data, color) {
  if (!data || !data.sparkMat) return;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uColor) data.sparkMat.uniforms.uColor.value.copy(color);
  else if (data.sparkMat.color) data.sparkMat.color.copy(color);
}
function applyLyricPaletteToMesh(mesh) {
  if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
  var pal = stageLyrics.palette || {};
  var data = mesh.userData.lyric;
  if (data.textMat && data.textMat.uniforms) {
    var u = data.textMat.uniforms;
    if (u.uBaseColor) u.uBaseColor.value.copy(lyricThreeColor(pal.primary, '#d6f8ff', 0.38));
    if (u.uHiColor) u.uHiColor.value.copy(lyricThreeColor(pal.highlight || pal.primary, '#fff0b8', 0.48));
    if (u.uGlowColor) u.uGlowColor.value.copy(lyricThreeColor(pal.glowColor || pal.secondary || pal.primary, '#9cffdf', 0.36));
    if (u.uSolarColor) u.uSolarColor.value.copy(lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50));
    if (u.uSolar && !isFinite(u.uSolar.value)) u.uSolar.value = 0;
    if (u.uOpacity && !isFinite(u.uOpacity.value)) u.uOpacity.value = 0;
    data.textMat.needsUpdate = true;
  }
  if (data.glowMat) data.glowMat.color.copy(lyricThreeColor(pal.glowColor || pal.secondary || pal.primary, '#9cffdf', 0.36));
  if (data.sparkMat) setLyricSparkColor(data, lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.46));
  if (data.sunMat) data.sunMat.color.copy(lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50));
}
function effectiveLyricPalette(pal) {
  var src = pal || stageLyrics.coverPalette || stageLyrics.palette || {};
  var out = {
    primary: src.primary || '#d6f8ff',
    secondary: src.secondary || '#9cffdf',
    highlight: src.highlight || '#eef7ff',
    shadow: src.shadow || 'rgba(2,8,12,0.42)',
    glow: src.glow || 'rgba(143,233,255,0.34)'
  };
  if (fx.lyricHighlightMode === 'custom') {
    var hi = lyricPaletteFromHex(fx.lyricHighlightColor);
    out.highlight = hi.primary;
    if (fx.lyricGlowLinked !== false) {
      out.glowColor = hi.secondary || hi.primary;
      out.glow = hi.glow || out.glow;
    }
  }
  if (fx.lyricGlowLinked === false) {
    var glowPal = lyricPaletteFromHex(fx.lyricGlowColor || '#9db8cf');
    out.glowColor = glowPal.primary;
    out.glow = glowPal.glow || out.glow;
  }
  if (!out.glowColor) out.glowColor = out.secondary;
  return out;
}
function setStageLyricPalette(pal) {
  stageLyrics.palette = effectiveLyricPalette(pal);
  lyricSunColor.copy(lyricThreeColor(stageLyrics.palette.glowColor || stageLyrics.palette.secondary || stageLyrics.palette.primary, '#ffe6a4', 0.44));
  lyricSunHotColor.copy(lyricThreeColor(stageLyrics.palette.highlight || stageLyrics.palette.primary, '#fff4cc', 0.54));
  applyLyricPaletteToMesh(stageLyrics.current);
  stageLyrics.outgoing.forEach(applyLyricPaletteToMesh);
  syncSkullParticleColors();
}
function lyricTextPaletteFromHsl(hsl, avgL, chroma) {
  if (avgL < 0.16 || chroma < 0.08) {
    return silverBlueLyricPalette();
  }
  var hue = hsl.h;
  if (avgL < 0.30 && (hue < 0.06 || hue > 0.86 || (hue > 0.75 && hue < 0.86))) return silverBlueLyricPalette();
  if (avgL > 0.82 && chroma < 0.12) {
    return {
      primary: '#064b5b',
      secondary: '#168c88',
      highlight: '#315f68',
      shadow: 'rgba(255,255,255,0.48)',
      glow: 'rgba(143,233,255,0.14)',
    };
  }
  var lightText = avgL < 0.52;
  var s = Math.max(0.42, Math.min(0.78, hsl.s + 0.16));
  var c1 = hslToRgb(hsl.h, s, lightText ? 0.74 : 0.34);
  var c2 = hslToRgb((hsl.h + 0.08) % 1, Math.max(0.36, s - 0.10), lightText ? 0.62 : 0.46);
  return {
    primary: rgbCss(c1),
    secondary: rgbCss(c2),
    highlight: rgbCss(hslToRgb((hsl.h + 0.03) % 1, Math.max(0.28, s - 0.18), lightText ? 0.86 : 0.58)),
    shadow: lightText ? 'rgba(0,6,10,0.44)' : 'rgba(248,253,255,0.40)',
    glow: rgbCss(c1, lightText ? 0.24 : 0.14),
  };
}
function updateLyricPaletteFromCover(coverCanvas) {
  if (!coverCanvas) return;
  try {
    var ctx = coverCanvas.getContext('2d');
    var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
    var w = coverCanvas.width, h = coverCanvas.height;
    var sumR = 0, sumG = 0, sumB = 0, count = 0;
    var best = { score:-1, r:143, g:233, b:255 };
    for (var y = 0; y < h; y += 8) {
      for (var x = 0; x < w; x += 8) {
        var di = (y * w + x) * 4;
        var r = img[di], g = img[di+1], b = img[di+2], a = img[di+3] / 255;
        if (a < 0.5) continue;
        var lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        var maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        var chroma = (maxC - minC) / 255;
        var edgePenalty = Math.abs(lum - 0.5);
        var score = chroma * 1.6 + (0.5 - edgePenalty) * 0.45;
        sumR += r; sumG += g; sumB += b; count++;
        if (lum > 0.08 && lum < 0.92 && score > best.score) best = { score:score, r:r, g:g, b:b };
      }
    }
    if (!count) return;
    var avgL = (sumR / count * 0.299 + sumG / count * 0.587 + sumB / count * 0.114) / 255;
    var hsl = rgbToHsl(best.r, best.g, best.b);
    stageLyrics.coverPalette = lyricTextPaletteFromHsl(hsl, avgL, Math.max(0, best.score));
    if (fx.lyricColorMode !== 'custom') setStageLyricPalette(stageLyrics.coverPalette);
  } catch (e) {}
}

function wrapLyricText(ctx, text, maxWidth, maxLines, fontSize) {
  text = String(text || '').trim();
  var useWords = /\s/.test(text) && /[A-Za-z0-9]/.test(text);
  var units = useWords ? text.split(/(\s+)/).filter(Boolean) : text.split('');
  var lines = [], line = '';
  for (var i = 0; i < units.length; i++) {
    var test = line + units[i];
    if (lyricMeasureText(ctx, test, fontSize) > maxWidth && line) {
      lines.push(line.trim());
      line = units[i].trimStart ? units[i].trimStart() : units[i].replace(/^\s+/, '');
      if (lines.length >= maxLines) {
        var rest = units.slice(i).join('').trim();
        if (rest) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.。,…，、\s]*$/, '') + '...';
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  return lines.length ? lines : [''];
}

function cssColorToThreeColor(css, fallback) {
  var c = new THREE.Color(fallback || '#d6f8ff');
  var value = String(css || fallback || '#d6f8ff').trim();
  try {
    if (/^#[0-9a-f]{3}$/i.test(value) || /^#[0-9a-f]{6}$/i.test(value)) {
      c.set(normalizeHexColor(value));
      return c;
    }
    var m = value.match(/^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)/i);
    if (m) {
      c.setRGB(
        Math.max(0, Math.min(255, parseFloat(m[1]))) / 255,
        Math.max(0, Math.min(255, parseFloat(m[2]))) / 255,
        Math.max(0, Math.min(255, parseFloat(m[3]))) / 255
      );
      return c;
    }
    c.setStyle(value);
  } catch (e) {
    try { c.set(normalizeHexColor(fallback || '#d6f8ff')); } catch (e2) {}
  }
  return c;
}
function lyricThreeColor(css, fallback, minLum) {
  var c = cssColorToThreeColor(css, fallback || '#d6f8ff');
  var lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  var floor = minLum == null ? 0.34 : minLum;
  if (lum < floor) {
    var lift = floor - lum;
    c.r = Math.min(1, c.r + lift);
    c.g = Math.min(1, c.g + lift);
    c.b = Math.min(1, c.b + lift);
  }
  return c;
}

var STAGE_LYRIC_MAX_LINES = 1;

function getStageLyricMaxLines() {
  if (typeof fx === 'undefined' || !fx) return 1;
  var mode = String(fx.lyricDisplayMode || 'cinema');
  if (mode === 'single') return 1;
  if (mode === 'dual') return 2;
  if (mode === 'triple') return 3;
  if (mode === 'custom') return Math.max(1, Math.min(10, Math.round(Number(fx.lyricCustomLineCount) || 5)));
  return 4; // cinema
}

function makeLyricMask(text) {
  var canvas = document.createElement('canvas');
  var maxLines = Math.max(1, Math.min(10, getStageLyricMaxLines()));
  STAGE_LYRIC_MAX_LINES = maxLines;
  var W = 2048, H = Math.min(1024, 300 + maxLines * 110);
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  var maxWidth = W - 190;
  var fontSize = maxLines >= 4 ? 96 : (maxLines >= 3 ? 108 : 128);
  var raw = String(text || '');
  var forcedLines = raw.indexOf('\n') >= 0
    ? raw.split(/\n/).map(function(s){ return String(s || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean)
    : null;
  var textOne = forcedLines ? '' : raw.replace(/\s+/g, ' ').trim();
  var lines = forcedLines && forcedLines.length ? forcedLines.slice(0, maxLines) : [textOne];
  var widest = 1;
  for (; fontSize >= 36; fontSize -= 4) {
    ctx.font = lyricFontCss(fontSize);
    if (!forcedLines) {
      lines = maxLines > 1 && lyricMeasureText(ctx, textOne, fontSize) > maxWidth
        ? wrapLyricText(ctx, textOne, maxWidth, maxLines, fontSize)
        : [textOne];
    }
    widest = 1;
    for (var li = 0; li < lines.length; li++) widest = Math.max(widest, lyricMeasureText(ctx, lines[li], fontSize));
    var blockProbe = fontSize + (lines.length - 1) * fontSize * (lines.length > 1 ? 1.08 : 1.0) * lyricLineHeightFactor();
    if (widest <= maxWidth && blockProbe <= H - 48) break;
  }
  ctx.font = lyricFontCss(fontSize);
  if (!lines.length) lines = [''];
  widest = 1;
  for (var mi = 0; mi < lines.length; mi++) widest = Math.max(widest, lyricMeasureText(ctx, lines[mi], fontSize));
  var width = Math.min(maxWidth, widest);
  var fitScaleX = maxLines <= 1 && widest > maxWidth ? Math.max(0.68, maxWidth / widest) : 1;
  if (fitScaleX < 1) width = Math.min(maxWidth, widest * fitScaleX);
  var lineHeight = fontSize * (lines.length > 1 ? 1.08 : 1.0) * lyricLineHeightFactor();
  var blockH = fontSize + (lines.length - 1) * lineHeight;
  var x = W / 2, y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  for (var di = 0; di < lines.length; di++) {
    var alpha = 1;
    if (lines.length > 1 && di !== Math.floor((lines.length - 1) / 2) && typeof fx !== 'undefined' && fx) {
      alpha = clampRange(Number(fx.lyricContextOpacity), 0.25, 1);
    }
    ctx.globalAlpha = alpha;
    if (fitScaleX < 1) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(fitScaleX, 1);
      lyricFillText(ctx, lines[di], 0, y0 + di * lineHeight, fontSize);
      ctx.restore();
    } else {
      lyricFillText(ctx, lines[di], x, y0 + di * lineHeight, fontSize);
    }
  }
  ctx.globalAlpha = 1;
  applyStonePrintTexture(ctx, W, H, fontSize);
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  return { texture:tex, width:W, height:H, textWidth:width, textHeight:blockH, fontSize:fontSize, lineHeight:lineHeight, lineCount:lines.length, lines:lines, fitScaleX:fitScaleX, textMin:(W / 2 - width / 2) / W, textMax:(W / 2 + width / 2) / W };
}

function makeLyricReadabilityTexture(mask) {
  var canvas = document.createElement('canvas');
  var W = mask && mask.width || 2048;
  var H = mask && mask.height || 384;
  var fontSize = mask && mask.fontSize || 128;
  var lines = mask && Array.isArray(mask.lines) && mask.lines.length ? mask.lines : [''];
  var lineHeight = mask && mask.lineHeight || fontSize * lyricLineHeightFactor();
  var fitScaleX = mask && mask.fitScaleX || 1;
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.font = lyricFontCss(fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  var blockH = fontSize + (lines.length - 1) * lineHeight;
  var y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  function strokeLines(dx, dy) {
    for (var i = 0; i < lines.length; i++) {
      var y = y0 + i * lineHeight + (dy || 0);
      if (fitScaleX < 1) {
        ctx.save();
        ctx.translate(W / 2 + (dx || 0), 0);
        ctx.scale(fitScaleX, 1);
        lyricStrokeText(ctx, lines[i], 0, y, fontSize);
        ctx.restore();
      } else {
        lyricStrokeText(ctx, lines[i], W / 2 + (dx || 0), y, fontSize);
      }
    }
  }

  // Black/white readability layer: text-shaped only, no rectangular backing.
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(18, fontSize * 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  strokeLines(0, fontSize * 0.018);
  ctx.restore();

  ctx.save();
  ctx.filter = 'blur(5px)';
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = Math.max(9, fontSize * 0.075);
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  strokeLines(0, fontSize * 0.012);
  ctx.restore();

  ctx.save();
  ctx.filter = 'blur(4px)';
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = Math.max(9, fontSize * 0.070);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  strokeLines(0, 0);
  ctx.restore();

  ctx.save();
  ctx.filter = 'blur(1.2px)';
  ctx.globalAlpha = 0.26;
  ctx.lineWidth = Math.max(3.2, fontSize * 0.030);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  strokeLines(0, 0);
  ctx.restore();

  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  return tex;
}

function makeLyricGlowTexture(text, fontSize, textWidth, lines, lineHeight, fitScaleX) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  var drawLines = Array.isArray(lines) && lines.length ? lines : [text];
  var canvas = document.createElement('canvas');
  var measureCanvas = document.createElement('canvas');
  var measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = lyricFontCss(fontSize);
  fitScaleX = fitScaleX || 1;
  var measuredWidth = Math.max(1, textWidth || lyricMeasureText(measureCtx, text, fontSize) * fitScaleX);
  for (var li = 0; li < drawLines.length; li++) measuredWidth = Math.max(measuredWidth, lyricMeasureText(measureCtx, drawLines[li], fontSize) * fitScaleX);
  var padX = Math.max(160, fontSize * 1.45);
  var padY = Math.max(86, fontSize * 0.78);
  var lh = lineHeight || fontSize * 1.04;
  var blockH = fontSize + (drawLines.length - 1) * lh;
  var W = Math.ceil(measuredWidth + padX * 2);
  var H = Math.ceil(blockH + padY * 2);
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = lyricFontCss(fontSize);
  var y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  function drawGlowText(dx, dy) {
    for (var i = 0; i < drawLines.length; i++) {
      var y = y0 + i * lh + (dy || 0);
      if (fitScaleX < 1) {
        ctx.save();
        ctx.translate(W / 2 + (dx || 0), 0);
        ctx.scale(fitScaleX, 1);
        if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], 0, y, fontSize);
        lyricFillText(ctx, drawLines[i], 0, y, fontSize);
        ctx.restore();
      } else {
        if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize);
        lyricFillText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize);
      }
    }
  }
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 0.46;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(10, fontSize * 0.10);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  ctx.save();
  ctx.filter = 'blur(34px)';
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(18, fontSize * 0.18);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  ctx.save();
  ctx.filter = 'blur(78px)';
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(28, fontSize * 0.26);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  ctx.save();
  ctx.filter = 'blur(116px)';
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(42, fontSize * 0.40);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(8px)';
  ctx.globalAlpha = 0.26;
  ctx.fillStyle = '#fff';
  for (var ri = 0; ri < 8; ri++) {
    var ang = ri / 8 * Math.PI * 2;
    drawGlowText(Math.cos(ang) * 7, Math.sin(ang) * 4);
  }
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  var xMask = ctx.createLinearGradient(0, 0, W, 0);
  xMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  xMask.addColorStop(0.10, 'rgba(255,255,255,1)');
  xMask.addColorStop(0.90, 'rgba(255,255,255,1)');
  xMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = xMask;
  ctx.fillRect(0, 0, W, H);
  var yMask = ctx.createLinearGradient(0, 0, 0, H);
  yMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  yMask.addColorStop(0.16, 'rgba(255,255,255,1)');
  yMask.addColorStop(0.84, 'rgba(255,255,255,1)');
  yMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = yMask;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.userData = { width:W, height:H, textWidth:measuredWidth };
  return tex;
}

var lyricSunBloomTexture = null;
function getLyricSunBloomTexture() {
  if (lyricSunBloomTexture) return lyricSunBloomTexture;
  var canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  var cx = canvas.width * 0.50, cy = canvas.height * 0.50;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(2.05, 1);
  var radial = ctx.createRadialGradient(0, 0, 0, 0, 0, canvas.height * 0.43);
  radial.addColorStop(0.00, 'rgba(255,246,186,0.92)');
  radial.addColorStop(0.18, 'rgba(255,219,126,0.44)');
  radial.addColorStop(0.46, 'rgba(255,186,82,0.15)');
  radial.addColorStop(1.00, 'rgba(255,186,82,0)');
  ctx.fillStyle = radial;
  ctx.fillRect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(34px)';
  ctx.fillStyle = 'rgba(255,235,168,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, canvas.width * 0.33, canvas.height * 0.14, -0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'blur(58px)';
  ctx.fillStyle = 'rgba(255,214,122,0.11)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, canvas.width * 0.45, canvas.height * 0.19, -0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'blur(18px)';
  var core = ctx.createRadialGradient(cx, cy, 0, cx, cy, canvas.width * 0.16);
  core.addColorStop(0.00, 'rgba(255,252,220,0.38)');
  core.addColorStop(0.34, 'rgba(255,230,158,0.20)');
  core.addColorStop(1.00, 'rgba(255,210,116,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  var xMask = ctx.createLinearGradient(0, 0, canvas.width, 0);
  xMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  xMask.addColorStop(0.11, 'rgba(255,255,255,1)');
  xMask.addColorStop(0.89, 'rgba(255,255,255,1)');
  xMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = xMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  var yMask = ctx.createLinearGradient(0, 0, 0, canvas.height);
  yMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  yMask.addColorStop(0.18, 'rgba(255,255,255,1)');
  yMask.addColorStop(0.82, 'rgba(255,255,255,1)');
  yMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = yMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  lyricSunBloomTexture = new THREE.CanvasTexture(canvas);
  lyricSunBloomTexture.minFilter = THREE.LinearFilter;
  lyricSunBloomTexture.magFilter = THREE.LinearFilter;
  lyricSunBloomTexture.generateMipmaps = false;
  return lyricSunBloomTexture;
}

function makeLyricShaderMaterial(mask, pal) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: mask.texture },
      uProgress: { value: 0 },
      uTextMin: { value: mask.textMin },
      uTextMax: { value: mask.textMax },
      uOpacity: { value: 0 },
      uBaseColor: { value: lyricThreeColor(pal.primary, '#d6f8ff', 0.38) },
      uHiColor: { value: lyricThreeColor(pal.highlight || pal.primary, '#fff0b8', 0.48) },
      uGlowColor: { value: lyricThreeColor(pal.glowColor || pal.secondary, '#9cffdf', 0.36) },
      uSolarColor: { value: lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50) },
      uFeather: { value: lyricsHasNativeKaraoke ? 0.030 : 0.055 },
      uSolar: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform float uProgress,uTextMin,uTextMax,uOpacity,uFeather,uSolar;',
      'uniform vec3 uBaseColor,uHiColor,uGlowColor,uSolarColor;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);',
      '  float mask = texture2D(uMap, uv).a;',
      '  if(mask < 0.01) discard;',
      '  float denom = max(0.001, uTextMax - uTextMin);',
      '  float p = clamp((uv.x - uTextMin) / denom, 0.0, 1.0);',
      '  float filled = 1.0 - smoothstep(uProgress, uProgress + uFeather, p);',
      '  float edge = 1.0 - smoothstep(0.0, uFeather * 2.8, abs(p - uProgress));',
      '  vec3 color = mix(uBaseColor, uHiColor, filled * 0.88);',
      '  color += uGlowColor * edge * 0.14;',
      '  vec3 solar = uSolarColor;',
      '  color = mix(color, color + solar * 0.34, uSolar * (0.25 + filled * 0.45));',
      '  color += solar * edge * uSolar * 0.22;',
      '  float lum = dot(color, vec3(0.299, 0.587, 0.114));',
      '  color += vec3(max(0.0, 0.30 - lum));',
      '  gl_FragColor = vec4(color, mask * uOpacity);',
      '}',
    ].join('\n'),
    transparent:true, depthWrite:false, depthTest:false, side:THREE.DoubleSide,
  });
}

function buildLyricMesh(text) {
  text = String(text || '');
  if (text.indexOf('\n') < 0) text = text.replace(/\s+/g, ' ').trim();
  else text = text.split(/\n/).map(function(s){ return String(s || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n');
  var mask = makeLyricMask(text);
  var pal = stageLyrics.palette;
  var worldW = 6.10;
  var worldH = worldW * (mask.height / mask.width);
  var geo = new THREE.PlaneGeometry(worldW, worldH, 1, 1);
  var textWorldW = worldW * (mask.textWidth / mask.width);
  var textWorldH = worldH * ((mask.textHeight || mask.fontSize) / mask.height);
  var group = new THREE.Group();
  group.renderOrder = 42;
  group.position.set((Math.random() - 0.5) * 0.08, 0.20, 1.46);
  group.scale.setScalar(0.96);
  group.userData.age = 0;
  group.userData.state = 'in';
  group.userData.lastLyricProgress = -1;
  group.userData.floatSeed = Math.random() * 100;

  var sunMat = new THREE.MeshBasicMaterial({
    map:getLyricSunBloomTexture(), transparent:true, opacity:0,
    depthWrite:false, depthTest:false, side:THREE.DoubleSide,
    blending:THREE.AdditiveBlending, color:lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#ffe7a6', 0.50)
  });
  var sunWorldW = Math.max(textWorldW + worldH * 1.10, textWorldW * 1.18);
  sunWorldW = Math.min(worldW * 1.16, Math.max(worldH * 1.35, sunWorldW));
  var sunWorldH = Math.max(worldH * 1.02, Math.min(worldH * 1.54, worldH + textWorldW * 0.070));
  var sun = new THREE.Mesh(new THREE.PlaneGeometry(sunWorldW, sunWorldH, 1, 1), sunMat);
  sun.renderOrder = 40;
  sun.position.set(0, 0.02, -0.030);
  sun.scale.set(0.78, 0.58, 1);
  group.add(sun);

  var glowTex = makeLyricGlowTexture(text, mask.fontSize, mask.textWidth, mask.lines, mask.lineHeight, mask.fitScaleX);
  var glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent:true, opacity:0, depthWrite:false, depthTest:false,
    side:THREE.DoubleSide, blending:THREE.AdditiveBlending, color:lyricThreeColor(pal.secondary, '#9cffdf', 0.36)
  });
  var glowMeta = glowTex.userData || {};
  var glowWorldW = textWorldW * ((glowMeta.width || mask.width) / Math.max(1, glowMeta.textWidth || mask.textWidth));
  glowWorldW = Math.min(worldW * 1.10, Math.max(textWorldW + worldH * 0.38, glowWorldW));
  var glowWorldH = worldH * ((glowMeta.height || mask.height) / mask.height);
  glowWorldH = Math.min(worldH * 1.42, Math.max(worldH * 0.92, glowWorldH));
  var glow = new THREE.Mesh(new THREE.PlaneGeometry(glowWorldW, glowWorldH, 1, 1), glowMat);
  glow.renderOrder = 41;
  glow.scale.set(1.0, 1.06, 1);
  group.add(glow);

  var readabilityTex = makeLyricReadabilityTexture(mask);
  var readabilityMat = new THREE.MeshBasicMaterial({
    map: readabilityTex, transparent:true, opacity:0, depthWrite:false, depthTest:false,
    side:THREE.DoubleSide
  });
  var readability = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH, 1, 1), readabilityMat);
  readability.renderOrder = 42;
  readability.position.set(0, 0, -0.012);
  group.add(readability);

  var textMat = makeLyricShaderMaterial(mask, pal);
  var textMesh = new THREE.Mesh(geo, textMat);
  textMesh.renderOrder = 43;
  group.add(textMesh);

  var sparkCount = 132;
  var pgeo = new THREE.BufferGeometry();
  var ppos = new Float32Array(sparkCount * 3);
  var pseed = new Float32Array(sparkCount);
  for (var i = 0; i < sparkCount; i++) {
    var angle = Math.random() * Math.PI * 2;
    var ring = 0.78 + Math.pow(Math.random(), 1.45) * 0.58;
    var rx = textWorldW * (0.50 + Math.random() * 0.22) + 0.10;
    var ry = worldH * (0.42 + Math.random() * 0.22) + 0.08;
    ppos[i*3] = Math.cos(angle) * rx * ring + (Math.random() - 0.5) * textWorldW * 0.12;
    ppos[i*3+1] = Math.sin(angle) * ry * ring + (Math.random() - 0.5) * worldH * 0.14;
    ppos[i*3+2] = (Math.random() - 0.5) * 0.24;
    pseed[i] = Math.random() * 1000;
  }
  pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
  pgeo.setAttribute('seed', new THREE.BufferAttribute(pseed, 1));
  var pmat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uSize: { value: 0.052 },
      uOpacity: { value: 0 },
      uColor: { value: lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff7d2', 0.30) },
      uPixel: uniforms.uPixel
    },
    vertexShader: [
      'attribute float seed;',
      'uniform float uSize;',
      'uniform float uPixel;',
      'varying float vSeed;',
      'void main(){',
      '  vSeed = seed;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  float jitter = 0.58 + fract(sin(seed * 19.17) * 43758.5453) * 1.18;',
      '  float depth = clamp(2.2 / max(0.35, -mv.z), 0.54, 1.55);',
      '  gl_PointSize = uSize * jitter * depth * uPixel * 120.0;',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColor;',
      'uniform float uOpacity;',
      'varying float vSeed;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  float twinkle = 0.72 + fract(sin(vSeed * 7.31) * 91.7) * 0.28;',
      '  gl_FragColor = vec4(uColor * twinkle, tex.a * uOpacity);',
      '}'
    ].join('\n'),
    transparent:true, depthWrite:false, depthTest:false, blending:THREE.AdditiveBlending
  });
  var sparks = new THREE.Points(pgeo, pmat);
  sparks.renderOrder = 44;
  sparks.visible = !!fx.lyricGlowParticles;
  group.add(sparks);

  group.userData.lyric = {
    mask:mask, textMesh:textMesh, readability:readability, glow:glow, sparks:sparks, sun:sun,
    textMat:textMat, readabilityMat:readabilityMat, glowMat:glowMat, sparkMat:pmat, sunMat:sunMat,
    basePositions:ppos.slice ? ppos.slice(0) : new Float32Array(ppos),
    textWorldW:textWorldW, textWorldH:textWorldH, worldW:worldW, worldH:worldH
  };
  updateLyricMeshProgress(group, 0);
  return group;
}

function updateLyricMeshProgress(mesh, progress) {
  if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
  progress = Math.max(0, Math.min(1, progress || 0));
  var d = mesh.userData.lyric;
  d.textMat.uniforms.uProgress.value = progress;
  mesh.userData.lastLyricProgress = progress;
}

function showStageLine(text, redrawOnly) {
  createLyricsParticles();
  if (!stageLyrics.group) return;
  if (!text) { clearStageLyrics(); return; }
  if (redrawOnly && stageLyrics.current) {
    disposeLyricMesh(stageLyrics.current);
    stageLyrics.current = null;
  } else if (stageLyrics.current) {
    stageLyrics.current.userData.state = 'out';
    stageLyrics.current.userData.age = 0;
    stageLyrics.outgoing.push(stageLyrics.current);
  }
  stageLyrics.currentText = text;
  var mesh = buildLyricMesh(text);
  stageLyrics.group.add(mesh);
  stageLyrics.current = mesh;
}

function refreshCurrentLyricStyle() {
  if (!stageLyrics || !stageLyrics.currentText || !stageLyrics.current) return;
  var progress = stageLyrics.current.userData ? (stageLyrics.current.userData.lastLyricProgress || 0) : 0;
  showStageLine(stageLyrics.currentText, true);
  updateLyricMeshProgress(stageLyrics.current, progress);
  if (stageLyrics.current && stageLyrics.current.userData) stageLyrics.current.userData.age = 0.48;
}

function clearStageLyrics() {
  disposeLyricMesh(stageLyrics.current);
  stageLyrics.current = null;
  stageLyrics.currentIdx = -1;
  stageLyrics.currentText = '';
  while (stageLyrics.outgoing.length) disposeLyricMesh(stageLyrics.outgoing.pop());
}

function updateStageLyrics3D(dt) {
  if (!stageLyrics.group) return;
  if (emptyHomeActive || (document.documentElement.classList.contains('folia-stage-live') && !document.body.classList.contains('folia-home-wall'))) {
    stageLyrics.group.visible = false;
    return;
  }
  stageLyrics.group.visible = true;
  if (!fx.particleLyrics && !stageLyrics.current && (!stageLyrics.outgoing || !stageLyrics.outgoing.length)) return;
  if (!isFinite(stageLyrics.highBloom)) stageLyrics.highBloom = 0;
  if (!isFinite(stageLyrics.beatGlow)) stageLyrics.beatGlow = 0;
  if (!isFinite(stageLyrics.glowFollowX)) stageLyrics.glowFollowX = 0;
  if (!isFinite(stageLyrics.glowFollowY)) stageLyrics.glowFollowY = 0;
  if (!isFinite(stageLyrics.glowFollowRoll)) stageLyrics.glowFollowRoll = 0;
  var t = uniforms.uTime.value;
  var lyricGlowStrength = fx.lyricGlow ? Math.min(0.85, Math.max(0, fx.lyricGlowStrength)) : 0;
  var glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.50));
  var glowBreath = lyricGlowStrength > 0 ? (0.5 + 0.5 * Math.sin(t * 1.05)) : 0;
  var musicBloom = Math.max(lyricSunEnergy, beatPulse * 0.10);
  var beatGlowRaw = fx.lyricGlowBeat && lyricGlowStrength > 0
    ? Math.max(beatPulse * 1.22, beatCam.punch * 0.86 + beatCam.radiusKick * 1.85)
    : 0;
  stageLyrics.beatGlow += (beatGlowRaw - stageLyrics.beatGlow) * (beatGlowRaw > stageLyrics.beatGlow ? 0.32 : 0.10);
  if (!isFinite(stageLyrics.beatGlow)) stageLyrics.beatGlow = 0;
  var skullLyricPreset = !!(fx && fx.preset === SKULL_PRESET_INDEX);
  var solarBloom = lyricGlowStrength > 0 ? (0.18 + glowBreath * 0.16 + musicBloom * 0.90 + stageLyrics.beatGlow * 1.18 + Math.sin(t * 0.37 + 1.2) * 0.035) * glowDrive : 0;
  if (skullLyricPreset && lyricGlowStrength > 0) {
    solarBloom = (0.035 + glowBreath * 0.030 + musicBloom * 0.11 + Math.pow(Math.max(0, stageLyrics.beatGlow), 1.26) * 1.45 + Math.pow(Math.max(0, skullBeatFlash || 0), 1.08) * 1.18) * glowDrive;
  }
  solarBloom = Math.max(0, Math.min(1.45, solarBloom));
  stageLyrics.highBloom += (solarBloom - stageLyrics.highBloom) * (solarBloom > stageLyrics.highBloom ? (skullLyricPreset ? 0.22 : 0.075) : (skullLyricPreset ? 0.070 : 0.050));
  if (!isFinite(stageLyrics.highBloom)) stageLyrics.highBloom = 0;
  updateLyricStarRiver(dt);
  var followDrive = fx.lyricGlowBeat && lyricGlowStrength > 0 ? Math.min(1.35, stageLyrics.beatGlow) : 0;
  var followXTarget = followDrive * (beatCam.thetaKick * 34 + beatCam.rollKick * 8);
  var followYTarget = followDrive * (beatCam.phiKick * 42 - beatCam.radiusKick * 0.48);
  var followRollTarget = followDrive * (beatCam.rollKick * 22 + beatCam.thetaKick * 10);
  stageLyrics.glowFollowX += (followXTarget - stageLyrics.glowFollowX) * 0.26;
  stageLyrics.glowFollowY += (followYTarget - stageLyrics.glowFollowY) * 0.24;
  stageLyrics.glowFollowRoll += (followRollTarget - stageLyrics.glowFollowRoll) * 0.22;
  stageLyrics.glowFollowX *= 0.92;
  stageLyrics.glowFollowY *= 0.92;
  stageLyrics.glowFollowRoll *= 0.90;
  var layoutScale = clampRange(Number(fx.lyricScale) || 1, 0.35, 1.65);
  var layoutX = clampRange(Number(fx.lyricOffsetX) || 0, -2.0, 2.0);
  var layoutY = clampRange(Number(fx.lyricOffsetY) || 0, -1.2, 1.35);
  var layoutZ = clampRange(Number(fx.lyricOffsetZ) || 0, -1.6, 1.6);
  var layoutTiltX = clampRange(Number(fx.lyricTiltX) || 0, -42, 42);
  var layoutTiltY = clampRange(Number(fx.lyricTiltY) || 0, -42, 42);
  var skullMouthLyrics = !!(camera && fx && fx.preset === SKULL_PRESET_INDEX && skullParticleGroup && skullParticleGroup.visible);
  var shelfDetailOpen = !!(shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
  var skullShelfDetailOpen = !!(fx && fx.preset === SKULL_PRESET_INDEX && shelfDetailOpen);
  var normalShelfDetailOpen = !!(shelfDetailOpen && !skullShelfDetailOpen);
  stageLyrics.group.renderOrder = shelfDetailOpen ? 24 : 38;
  var shelfDetailLyricProfile = shelfDetailOpen ? {
    opacity: skullShelfDetailOpen ? 0.30 : 0.38,
    readability: skullShelfDetailOpen ? 0.20 : 0.26,
    bloom: skullShelfDetailOpen ? 0.20 : 0.24,
    glowCap: skullShelfDetailOpen ? 0.050 : 0.070,
    outgoing: skullShelfDetailOpen ? 0.34 : 0.42,
    easeDown: 0.34
  } : {
    opacity: 0.96,
    readability: 0.86,
    bloom: 1,
    glowCap: 1.0,
    outgoing: 1,
    easeDown: 0.16
  };
  var shelfLyricAvoid = shouldAvoidStageLyricsForShelf();
  var wallpaperLyricLock = shouldUseWallpaperLyricCameraLock();
  var wallpaperShelfLyrics = wallpaperLyricLock && shouldDimWallpaperForShelf();
  if (wallpaperLyricLock) {
    layoutScale *= wallpaperShelfLyrics ? 0.60 : 0.84;
    layoutX = clampRange(layoutX + (wallpaperShelfLyrics ? -1.34 : 0), -2.0, 2.0);
    layoutY = clampRange(layoutY + (wallpaperShelfLyrics ? -0.04 : 0.08), -1.2, 1.35);
    layoutZ = clampRange(layoutZ + (wallpaperShelfLyrics ? 1.02 : 1.15), -1.6, 1.6);
  } else if (!skullMouthLyrics && shelfLyricAvoid && fx.lyricCameraLock) {
    layoutScale *= 0.72;
    layoutX = clampRange(layoutX - 1.36, -2.0, 2.0);
    layoutY = clampRange(layoutY + 0.06, -1.2, 1.35);
    layoutZ = clampRange(layoutZ + 0.72, -1.6, 1.6);
  } else if (!skullMouthLyrics && shouldOffsetLyricsForShelfDetail()) {
    layoutScale *= normalShelfDetailOpen ? 0.56 : 0.70;
    layoutX = clampRange(layoutX - (normalShelfDetailOpen ? 1.78 : 1.58), -2.0, 2.0);
    layoutY = clampRange(layoutY + (normalShelfDetailOpen ? 0.18 : 0.08), -1.2, 1.35);
    layoutZ = clampRange(layoutZ + 0.84, -1.6, 1.6);
  }
  if (skullMouthLyrics) {
    layoutScale *= skullShelfDetailOpen ? 0.52 : (shelfLyricAvoid ? 0.58 : 0.66);
    if (shelfLyricAvoid && !skullShelfDetailOpen) {
      layoutX = clampRange(layoutX - 0.36, -2.0, 2.0);
      layoutY = clampRange(layoutY + 0.02, -1.2, 1.35);
      layoutZ = clampRange(layoutZ + 0.18, -1.6, 1.6);
    }
  }
  var lockBaseDistance = wallpaperShelfLyrics ? 5.58 : 4.85;
  var lockDistance = lockBaseDistance + layoutZ;
  var cameraLockedLyrics = (fx.lyricCameraLock || wallpaperLyricLock) && camera;
  var skullLyricEdgeGuard = !!(fx && fx.preset === SKULL_PRESET_INDEX && (orbit.centerLocked || orbit.recentering));
  var lockFit = (cameraLockedLyrics || skullLyricEdgeGuard || skullMouthLyrics) ? lyricCameraLockFit(layoutScale, layoutX, layoutY, skullMouthLyrics ? Math.max(2.2, 4.4 + layoutZ) : lockDistance) : 1;
  if (skullMouthLyrics) lockFit = Math.min(lockFit, 1.12);
  if (!isFinite(stageLyrics.lockFitScale)) stageLyrics.lockFitScale = 1;
  stageLyrics.lockFitScale += (lockFit - stageLyrics.lockFitScale) * (lockFit < stageLyrics.lockFitScale ? 0.18 : 0.10);
  stageLyrics.group.scale.setScalar(layoutScale * stageLyrics.lockFitScale);
  if (skullMouthLyrics) {
    stageLyrics.snapCameraLockFrames = 0;
    skullParticleGroup.updateMatrixWorld(true);
    skullLyricMouthTarget.copy(skullLyricMouthLocal).applyMatrix4(skullParticleGroup.matrixWorld);
    skullParticleGroup.getWorldQuaternion(skullLyricMouthQuat);
    skullLyricMouthForward.set(0, 0, 1).applyQuaternion(skullLyricMouthQuat);
    skullLyricMouthTarget.addScaledVector(skullLyricMouthForward, 0.020);
    skullLyricReadableQuat.copy(skullLyricMouthQuat);
    setStageLyricViewBasisFromCameraOrQuaternion(skullLyricMouthQuat);
    lyricLayoutTarget.copy(skullLyricMouthTarget);
    applyStageLyricLayoutOffset(lyricLayoutTarget, layoutX, layoutY, layoutZ);
    stageLyricTargetQuaternion(skullLyricReadableQuat, layoutTiltX, layoutTiltY);
    stageLyrics.group.userData = stageLyrics.group.userData || {};
    if (!stageLyrics.group.userData.skullMouthLocked) {
      stageLyrics.group.position.copy(lyricLayoutTarget);
      stageLyrics.group.quaternion.copy(lyricTargetQuat);
      stageLyrics.group.userData.skullMouthLocked = true;
    } else {
      stageLyrics.group.position.lerp(lyricLayoutTarget, 0.26);
      stageLyrics.group.quaternion.slerp(lyricTargetQuat, 0.30);
    }
  } else if (cameraLockedLyrics) {
    if (stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
    setStageLyricViewBasisFromCameraOrQuaternion(null);
    lyricLayoutBase.copy(camera.position).addScaledVector(lyricCameraDir, lockBaseDistance);
    lyricCameraTarget.copy(lyricLayoutBase);
    applyStageLyricLayoutOffset(lyricCameraTarget, layoutX, layoutY, layoutZ);
    stageLyricTargetQuaternion(camera.quaternion, layoutTiltX, layoutTiltY);
    if (stageLyrics.snapCameraLockFrames > 0) {
      stageLyrics.group.position.copy(lyricCameraTarget);
      stageLyrics.group.quaternion.copy(lyricTargetQuat);
      stageLyrics.snapCameraLockFrames -= 1;
    } else {
      var lockPosEase = wallpaperLyricLock ? (wallpaperShelfLyrics ? 0.42 : 0.34) : 0.24;
      var lockQuatEase = wallpaperLyricLock ? (wallpaperShelfLyrics ? 0.44 : 0.36) : 0.22;
      stageLyrics.group.position.lerp(lyricCameraTarget, lockPosEase);
      stageLyrics.group.quaternion.slerp(lyricTargetQuat, lockQuatEase);
    }
  } else {
    if (stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
    stageLyrics.snapCameraLockFrames = 0;
    if (particles) {
      particles.updateMatrixWorld(true);
      particles.getWorldPosition(lyricCoverWorldPos);
      particles.getWorldQuaternion(lyricCoverWorldQuat);
    } else {
      lyricCoverWorldPos.set(0, 0, 0);
      lyricCoverWorldQuat.identity();
    }
    setStageLyricViewBasisFromCameraOrQuaternion(lyricCoverWorldQuat);
    lyricLayoutBase.copy(lyricCoverWorldPos);
    lyricLayoutTarget.copy(lyricLayoutBase);
    applyStageLyricLayoutOffset(lyricLayoutTarget, layoutX, layoutY, layoutZ);
    stageLyrics.group.position.copy(lyricLayoutTarget);
    stageLyricTargetQuaternion(lyricCoverWorldQuat, layoutTiltX, layoutTiltY);
    stageLyrics.group.quaternion.copy(lyricTargetQuat);
  }
  function tickMesh(mesh, isCurrent) {
    if (!mesh) return false;
    mesh.userData.age += dt;
    var a = Math.min(1, mesh.userData.age / (isCurrent ? 0.52 : 0.38));
    a = a * a * (3 - 2 * a);
    var data = mesh.userData.lyric || {};
    var followMix = isCurrent ? 1.0 : 0.64;
    var glowX = stageLyrics.glowFollowX * followMix;
    var glowY = stageLyrics.glowFollowY * followMix;
    var glowRoll = stageLyrics.glowFollowRoll * followMix;
    if (data.glow) {
      data.glow.position.set(glowX * 0.14, glowY * 0.12, -0.006);
      data.glow.rotation.z = glowRoll * 0.30;
    }
    if (data.sun) {
      data.sun.position.set(glowX * 0.42, 0.02 + glowY * 0.34, -0.035);
      data.sun.rotation.z = glowRoll * 0.36;
    }
    if (data.sparks) {
      data.sparks.position.set(glowX * 0.24, glowY * 0.22, 0.010);
      data.sparks.rotation.z = glowRoll * 0.22;
    }
    var opacity = 0;
    if (isCurrent) {
      var shelfDetailLyricDim = shelfDetailLyricProfile.bloom;
      var lyricOpacityTarget = shelfDetailLyricProfile.opacity;
      var currentOpacity = data.textMat ? data.textMat.uniforms.uOpacity.value : 0;
      var opacityEase = shelfDetailOpen && currentOpacity > lyricOpacityTarget ? shelfDetailLyricProfile.easeDown : 0.16;
      opacity = clampRange(currentOpacity + (lyricOpacityTarget - currentOpacity) * opacityEase, 0, 1);
      if (data.textMat) data.textMat.uniforms.uOpacity.value = opacity;
      if (data.readabilityMat) {
        var readabilityTarget = opacity * shelfDetailLyricProfile.readability;
        var readabilityEase = shelfDetailOpen && data.readabilityMat.opacity > readabilityTarget ? 0.28 : 0.16;
        data.readabilityMat.opacity += (readabilityTarget - data.readabilityMat.opacity) * readabilityEase;
      }
      if (data.textMat && data.textMat.uniforms.uSolar) {
        var solarTarget = stageLyrics.highBloom * shelfDetailLyricDim;
        var solarEase = shelfDetailOpen && data.textMat.uniforms.uSolar.value > solarTarget ? 0.26 : 0.12;
        data.textMat.uniforms.uSolar.value += (solarTarget - data.textMat.uniforms.uSolar.value) * solarEase;
      }
      var solar = stageLyrics.highBloom * shelfDetailLyricDim;
      var warmth = Math.max(0, Math.min(1, solar * 1.10));
      if (data.glowMat) {
        var glowTarget = lyricGlowStrength > 0 ? Math.min(shelfDetailLyricProfile.glowCap, (0.075 + solar * 0.34 + stageLyrics.beatGlow * 0.16 * shelfDetailLyricDim) * Math.min(3.0, glowDrive)) : 0;
        data.glowMat.opacity += (glowTarget - data.glowMat.opacity) * (glowTarget > data.glowMat.opacity ? 0.095 : (shelfDetailOpen ? 0.20 : 0.055));
        data.glowMat.color.copy(lyricThreeColor(stageLyrics.palette.glowColor || stageLyrics.palette.secondary, '#9cffdf', 0.36)).lerp(lyricSunHotColor, warmth);
      }
      if (data.sparkMat) {
        var sparkTarget = lyricGlowStrength > 0 && fx.lyricGlowParticles && !shelfDetailOpen ? Math.min(0.42, (0.10 + solar * 0.14 + stageLyrics.beatGlow * 0.10) * Math.min(1.6, glowDrive)) : 0;
        var sparkOpacity = getLyricSparkOpacity(data);
        sparkOpacity += (sparkTarget - sparkOpacity) * (sparkTarget > sparkOpacity ? 0.13 : (shelfDetailOpen ? 0.22 : 0.075));
        setLyricSparkOpacity(data, sparkOpacity);
        var sparkSizeTarget = fx.lyricGlowParticles && !shelfDetailOpen ? (0.050 + solar * 0.016 + stageLyrics.beatGlow * 0.026 + bass * 0.008) : 0.035;
        setLyricSparkSize(data, getLyricSparkSize(data) + (sparkSizeTarget - getLyricSparkSize(data)) * 0.12);
        var sparkColor = lyricSunHotColor.clone().lerp(lyricSunColor, 0.22 + solar * 0.18);
        setLyricSparkColor(data, sparkColor);
      }
      var seed = mesh.userData.floatSeed || 0;
      if (data.sunMat) {
        var sunTarget = lyricGlowStrength > 0 && !shelfDetailOpen ? Math.min(0.88, (Math.pow(Math.min(1.35, solar), 1.08) * 0.28 + stageLyrics.beatGlow * 0.20) * Math.min(2.4, glowDrive)) : 0;
        data.sunMat.opacity += (sunTarget - data.sunMat.opacity) * (shelfDetailOpen ? 0.18 : 0.055);
        data.sunMat.color.copy(lyricSunColor).lerp(lyricSunHotColor, solar * 0.55);
      }
      if (data.sun) {
        var sunPulse = solar;
        var beatScale = fx.lyricGlowBeat ? stageLyrics.beatGlow * 0.24 : 0;
        data.sun.scale.set(0.82 + sunPulse * 0.36 + beatScale + Math.sin(t * 1.6) * sunPulse * 0.018, 0.60 + sunPulse * 0.34 + beatScale * 0.72 + Math.cos(t * 1.25) * sunPulse * 0.020, 1);
        data.sun.rotation.z += Math.sin(t * 0.32 + seed) * 0.010 * sunPulse;
      }
      var breathe = Math.sin(t * 0.92 + seed) * 0.050 + Math.sin(t * 0.41 + seed * 0.7) * 0.028;
      if (skullMouthLyrics) {
        var mouthMeshY = -0.070 + Math.sin(t * 0.50 + seed) * 0.018 + Math.sin(t * 1.12 + seed) * 0.006;
        var mouthMeshZ = 0.018 + Math.cos(t * 0.46 + seed) * 0.007;
        var mouthMeshScale = 1.08 + a * 0.040 + breathe * 0.12 + bass * 0.024 + beatPulse * 0.014;
        if (!mesh.userData.skullMouthMeshLocked) {
          mesh.position.set(0, mouthMeshY, mouthMeshZ);
          mesh.userData.skullMouthMeshLocked = true;
        } else {
          mesh.position.x += (0 - mesh.position.x) * 0.18;
          mesh.position.y += (mouthMeshY - mesh.position.y) * 0.16;
          mesh.position.z += (mouthMeshZ - mesh.position.z) * 0.18;
        }
        mesh.scale.setScalar(mouthMeshScale);
        mesh.rotation.z = Math.sin(t * 0.30 + seed) * 0.010;
      } else {
        mesh.userData.skullMouthMeshLocked = false;
        var motion = String((fx && fx.lyricMotionStyle) || 'float');
        var soft = clampRange(Number(fx && fx.lyricMotionSoftness) || 0.72, 0.15, 1.2);
        var edgeFade = clampRange(Number(fx && fx.lyricEdgeFade) || 0.55, 0, 1);
        var motionAmp = 0.55 + soft * 0.85;
        var targetY = 0.18;
        var targetZ = 1.48;
        var targetScale = 0.96 + a * 0.055 + bass * 0.038 + beatPulse * 0.014;
        var targetRotZ = 0;
        var targetRotX = 0;
        var glitchKick = 0;
        if (motion === 'smooth') {
          targetY = 0.14 + Math.sin(t * 0.38 + seed) * 0.018 * motionAmp;
          targetZ = 1.42 + Math.cos(t * 0.28 + seed) * 0.028 * motionAmp;
          targetScale += Math.sin(t * 0.55 + seed) * 0.012 * soft;
          targetRotZ = Math.sin(t * 0.22 + seed) * 0.008;
        } else if (motion === 'glass') {
          targetY = 0.16 + Math.sin(t * 0.62 + seed) * 0.024 * motionAmp;
          targetZ = 1.50 + Math.sin(t * 1.1 + seed) * 0.04 * motionAmp;
          targetScale += 0.02 + Math.sin(t * 1.4 + seed) * 0.02;
          targetRotZ = Math.sin(t * 0.5 + seed) * 0.014;
          targetRotX = Math.sin(t * 0.34 + seed) * 0.02;
        } else if (motion === 'shine') {
          targetY = 0.17 + Math.sin(t * 0.9 + seed) * 0.03 * motionAmp;
          targetZ = 1.46 + Math.cos(t * 0.7 + seed) * 0.05 * motionAmp;
          targetScale += beatPulse * 0.03 + Math.sin(t * 2.1 + seed) * 0.016;
          targetRotZ = Math.sin(t * 0.8 + seed) * 0.02;
        } else if (motion === 'glitch') {
          var gInt = clampRange(Number(fx.lyricGlitchIntensity) || 1, 0, 1.5);
          var gRate = clampRange(Number(fx.lyricGlitchRate) || 1, 0.45, 2.2);
          var gJitter = clampRange(Number(fx.lyricGlitchJitter) || 1, 0, 1.8);
          var gSlice = clampRange(Number(fx.lyricGlitchSlice) || 1, 0, 1.4);
          var bindBeat = fx.lyricGlitchCameraBind !== false;
          glitchKick = (bindBeat ? Math.max(beatPulse, stageLyrics.beatGlow * 0.8) : 0.35) * gInt;
          var flicker = (Math.sin(t * (8.5 * gRate) + seed) > (0.72 - gInt * 0.18)) ? 1 : 0;
          targetY = 0.16 + (Math.random() - 0.5) * 0.08 * gJitter * glitchKick * flicker;
          targetZ = 1.46 + (Math.random() - 0.5) * 0.12 * gSlice * glitchKick * flicker;
          targetScale += (Math.random() - 0.5) * 0.06 * gInt * flicker;
          targetRotZ = (Math.random() - 0.5) * 0.08 * gJitter * flicker;
          mesh.position.x += ((Math.random() - 0.5) * 0.1 * gSlice * glitchKick * flicker - mesh.position.x) * 0.45;
          if (data.textMat && data.textMat.uniforms && data.textMat.uniforms.uOpacity) {
            var chroma = clampRange(Number(fx.lyricGlitchChroma) || 1, 0, 1.6);
            if (flicker && chroma > 0.2) data.textMat.uniforms.uOpacity.value = Math.max(0.35, opacity * (1 - chroma * 0.18 * Math.random()));
          }
        } else {
          // float (default)
          var breathe = Math.sin(t * 0.92 + seed) * 0.050 + Math.sin(t * 0.41 + seed * 0.7) * 0.028;
          breathe *= motionAmp;
          targetY = 0.18 + Math.sin(t * 0.55 + seed) * 0.055 + Math.sin(t * 1.35 + seed) * 0.014;
          targetZ = 1.48 + Math.cos(t * 0.48 + seed) * 0.080;
          targetScale = 0.96 + a * 0.055 + breathe + bass * 0.038 + beatPulse * 0.014;
          targetRotZ = Math.sin(t * 0.34 + seed) * 0.018;
        }
        if (edgeFade > 0.01 && data.textMat && data.textMat.uniforms && data.textMat.uniforms.uOpacity) {
          var fadeMul = 1 - edgeFade * 0.18 * (1 - soft);
          data.textMat.uniforms.uOpacity.value = Math.min(data.textMat.uniforms.uOpacity.value, opacity * fadeMul + opacity * (1 - fadeMul));
        }
        var ease = motion === 'glitch' ? 0.42 : (0.05 + soft * 0.08);
        mesh.position.y += (targetY - mesh.position.y) * ease;
        mesh.position.z += (targetZ - mesh.position.z) * ease;
        mesh.scale.setScalar(targetScale);
        mesh.rotation.z = targetRotZ;
        mesh.rotation.x = targetRotX;
      }
      if (data.sparks && data.sparkMat) data.sparks.visible = fx.lyricGlowParticles || getLyricSparkOpacity(data) > 0.015;
      if (data.sparks && data.basePositions) {
        var pos = data.sparks.geometry.attributes.position;
        var arr = pos.array, base = data.basePositions;
        data.sparks.rotation.z += ((fx.lyricGlowParticles ? 0.0009 : 0.00025) + stageLyrics.beatGlow * 0.0007) * (dt * 60);
        data.sparks.rotation.x = Math.sin(t * 0.12 + seed) * 0.012;
        for (var si = 0; si < arr.length / 3; si++) {
          var s = si * 12.989 + seed;
          var particleBeat = fx.lyricGlowParticles ? stageLyrics.beatGlow : 0;
          var dustBreath = fx.lyricGlowParticles ? (0.62 + 0.38 * Math.sin(t * (0.32 + (si % 7) * 0.025) + s)) : 0.18;
          var drift = fx.lyricGlowParticles ? 1 : 0.30;
          arr[si*3] = base[si*3] + Math.sin(t * (0.18 + (si % 5) * 0.025) + s) * (0.045 + bass * 0.030 + particleBeat * 0.052) * drift + Math.cos(t * 0.11 + s) * 0.018 * dustBreath;
          arr[si*3+1] = base[si*3+1] + Math.cos(t * (0.16 + (si % 6) * 0.024) + s) * (0.042 + mid * 0.026 + particleBeat * 0.046) * drift + Math.sin(t * 0.13 + s) * 0.016 * dustBreath;
          arr[si*3+2] = base[si*3+2] + Math.sin(t * (0.24 + (si % 4) * 0.035) + s) * (0.036 + particleBeat * 0.028) * drift;
        }
        pos.needsUpdate = true;
      }
      return true;
    }
    opacity = (1 - a) * 0.72 * shelfDetailLyricProfile.outgoing;
    if (data.textMat) data.textMat.uniforms.uOpacity.value = opacity;
    if (data.readabilityMat) data.readabilityMat.opacity = opacity * (shelfDetailOpen ? shelfDetailLyricProfile.readability : 0.58);
    if (data.textMat && data.textMat.uniforms.uSolar) data.textMat.uniforms.uSolar.value *= shelfDetailOpen ? 0.72 : 0.86;
    if (data.glowMat) data.glowMat.opacity = lyricGlowStrength > 0 ? (shelfDetailOpen ? Math.min(shelfDetailLyricProfile.glowCap * 0.40, opacity * 0.05 * lyricGlowStrength) : opacity * 0.08 * lyricGlowStrength) : 0;
    if (data.sparkMat) {
      var outgoingSpark = lyricGlowStrength > 0 && fx.lyricGlowParticles && !shelfDetailOpen ? Math.max(opacity * 0.24 * lyricGlowStrength, (1 - a) * 0.18 * lyricGlowStrength) : 0;
      setLyricSparkOpacity(data, outgoingSpark);
      setLyricSparkSize(data, 0.046 + (1 - a) * 0.020);
    }
    if (data.sunMat) data.sunMat.opacity = lyricGlowStrength > 0 && !shelfDetailOpen ? opacity * 0.08 * lyricGlowStrength : 0;
    mesh.position.z -= dt * 0.26;
    mesh.position.y += dt * 0.08;
    mesh.scale.setScalar(0.98 - a * 0.06);
    return a < 1;
  }
  tickMesh(stageLyrics.current, true);
  for (var i = stageLyrics.outgoing.length - 1; i >= 0; i--) {
    if (!tickMesh(stageLyrics.outgoing[i], false)) {
      disposeLyricMesh(stageLyrics.outgoing[i]);
      stageLyrics.outgoing.splice(i, 1);
    }
  }
}

function getLyricLineProgress(line, nextLine, now) {
  if (!line) return 0;
  now += line.words && line.words.length ? 0.030 : 0.020;
  if (line.words && line.words.length && line.charCount > 0) {
    var lastP = 0;
    for (var i = 0; i < line.words.length; i++) {
      var w = line.words[i];
      var ws = w.t;
      var we = w.t + Math.max(0.08, w.d || 0.24);
      if (now < ws) return lastP;
      var local = now >= we ? 1 : (now - ws) / Math.max(0.08, we - ws);
      local = Math.max(0, Math.min(1, local));
      var p = (w.c0 + (w.c1 - w.c0) * local) / line.charCount;
      lastP = Math.max(lastP, p);
      if (now < we) return lastP;
    }
    return 1;
  }
  var nextT = nextLine && nextLine.t > line.t ? nextLine.t : Math.min((audio && audio.duration) || now + 4, line.t + (line.duration || 4.8));
  var span = Math.max(0.75, nextT - line.t);
  var prog = Math.max(0, Math.min(1, (now - line.t) / span));
  return prog * prog * (3 - 2 * prog);
}

function composeDiyLyricStageText(idx, introText) {
  if (introText) return String(introText || '');
  if (!Array.isArray(lyricsLines) || !lyricsLines.length) return '';
  idx = Math.max(0, Math.min(lyricsLines.length - 1, idx | 0));
  var mode = (fx && fx.lyricDisplayMode) || 'cinema';
  var count = getStageLyricMaxLines();
  var start = idx;
  if (mode === 'dual') {
    start = idx;
    count = 2;
  } else if (mode === 'triple' || mode === 'cinema' || mode === 'custom') {
    start = Math.max(0, idx - Math.floor((count - 1) / 2));
  } else {
    start = idx;
    count = 1;
  }
  var end = Math.min(lyricsLines.length - 1, start + count - 1);
  if (end - start + 1 < count) start = Math.max(0, end - count + 1);
  var rows = [];
  var transMode = (fx && fx.lyricTranslationMode) || 'multi';
  var spreadPad = '';
  var spread = clampRange(Number(fx && fx.lyricContextSpread) || 1, 0.6, 2.4);
  if (spread > 1.35) spreadPad = ' ';
  for (var i = start; i <= end; i++) {
    var line = lyricsLines[i];
    if (!line) continue;
    var main = String(line.text || '').trim();
    if (!main) continue;
    if (i === idx) {
      rows.push(main);
      if (transMode !== 'off' && line.trans) {
        if (transMode === 'current' || transMode === 'dual' || transMode === 'multi') rows.push(String(line.trans).trim());
      }
    } else {
      rows.push(main);
      if (transMode === 'multi' && line.trans) rows.push(String(line.trans).trim());
      else if (transMode === 'dual' && Math.abs(i - idx) === 1 && line.trans) rows.push(String(line.trans).trim());
    }
  }
  if (!rows.length) {
    var cur = lyricsLines[idx];
    return cur ? String(cur.text || '') : '';
  }
  if (mode === 'single') {
    var only = String((lyricsLines[idx] && lyricsLines[idx].text) || rows[0] || '');
    if (transMode !== 'off' && lyricsLines[idx] && lyricsLines[idx].trans) {
      return only + '\n' + String(lyricsLines[idx].trans);
    }
    return only;
  }
  return rows.join('\n' + spreadPad);
}

function tickLyricsParticles() {
  if (!fx.particleLyrics) {
    if (stageLyrics.current || stageLyrics.currentText || (stageLyrics.outgoing && stageLyrics.outgoing.length)) clearStageLyrics();
    return;
  }
  if (!playing || !audio || !lyricsLines.length) {
    if (stageLyrics.current) {
      stageLyrics.current.userData.state = 'out';
      stageLyrics.current.userData.age = 0;
      stageLyrics.outgoing.push(stageLyrics.current);
      stageLyrics.current = null;
      stageLyrics.currentIdx = -1;
      stageLyrics.currentText = '';
    }
    return;
  }
  var t = audio.currentTime;
  var newIdx = -1;
  for (var i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].t <= t + 0.05) newIdx = i; else break;
  }
  if (newIdx < 0) {
    var introText = currentLyricFallbackText();
    if (!introText) {
      clearStageLyrics();
      return;
    }
    if (stageLyrics.currentIdx !== -2 || stageLyrics.currentText !== introText) {
      stageLyrics.currentIdx = -2;
      showStageLine(introText);
    }
    if (stageLyrics.current) {
      var firstLine = lyricsLines[0];
      var introEnd = firstLine && firstLine.t > 0 ? firstLine.t : Math.min((audio && audio.duration) || 4.8, 4.8);
      var introLine = { t:0, text:introText, duration:Math.max(0.8, introEnd), charCount:Math.max(1, introText.length), fallback:true };
      updateLyricMeshProgress(stageLyrics.current, getLyricLineProgress(introLine, null, t));
    }
    return;
  }
  var composed = composeDiyLyricStageText(newIdx);
  if (newIdx !== stageLyrics.currentIdx || stageLyrics.currentText !== composed) {
    stageLyrics.currentIdx = newIdx;
    showStageLine(composed);
  }
  if (stageLyrics.current) {
    var curLine = lyricsLines[newIdx] || { t:t };
    var nextLine = lyricsLines[newIdx + 1];
    var progress = getLyricLineProgress(curLine, nextLine, t);
    updateLyricMeshProgress(stageLyrics.current, progress);
  }
}

function disposeLyricsParticles() {
  clearStageLyrics();
  if (stageLyrics.starRiver) {
    if (stageLyrics.starRiver.parent) stageLyrics.starRiver.parent.remove(stageLyrics.starRiver);
    if (stageLyrics.starRiver.geometry) stageLyrics.starRiver.geometry.dispose();
    if (stageLyrics.starRiver.material) stageLyrics.starRiver.material.dispose();
    stageLyrics.starRiver = null;
  }
  if (stageLyrics.group) {
    scene.remove(stageLyrics.group);
    stageLyrics.group = null;
  }
}

// ============================================================
//  涟漪触发系统 — 3×3 九宫格 + bass 上升沿
// ============================================================
var rippleIdx = 0;
var lastRippleAt = 0;
var lastBassRising = false;
var BASS_THRESHOLD = 0.30;
var RIPPLE_COOLDOWN = 0.32;

var regions = [];
for (var ry = 0; ry < 3; ry++) for (var rx = 0; rx < 3; rx++) {
  regions.push({
    x: (rx / 2 - 0.5) * PLANE_SIZE * 0.72,
    y: (ry / 2 - 0.5) * PLANE_SIZE * 0.72,
  });
}

function triggerRipple(x, y, strength) {
  var r = ripples[rippleIdx];
  r.x = x; r.y = y; r.age = 0; r.str = strength;
  rippleIdx = (rippleIdx + 1) % RIPPLE_MAX;
}

function updateRipples(dt) {
  var isBassHit = bass > BASS_THRESHOLD && !lastBassRising;
  lastBassRising = bass > BASS_THRESHOLD * 0.75;
  var now = uniforms.uTime.value;
  if (isBassHit && (now - lastRippleAt) > RIPPLE_COOLDOWN) {
    lastRippleAt = now;
    var count = 2 + (Math.random() < 0.5 ? 0 : 1);
    var used = {};
    for (var k = 0; k < count; k++) {
      var idx, tries = 0;
      do { idx = Math.floor(Math.random() * 9); tries++; } while (used[idx] && tries < 12);
      used[idx] = true;
      var reg = regions[idx];
      var jx = reg.x + (Math.random() - 0.5) * 0.7;
      var jy = reg.y + (Math.random() - 0.5) * 0.7;
      var str = 0.65 + bass * 1.4 + Math.random() * 0.25;
      triggerRipple(jx, jy, str);
    }
  }

  for (var i = 0; i < RIPPLE_MAX; i++) {
    var r = ripples[i];
    if (r.str > 0.005) {
      r.age += dt;
      if (r.age > 2.0) { r.str = 0; r.age = -10; }
    }
    var off = i * 4;
    rippleData[off]   = r.x;
    rippleData[off+1] = r.y;
    rippleData[off+2] = r.age;
    rippleData[off+3] = r.str;
  }
  rippleTex.needsUpdate = true;

  var active = 0;
  for (var i = 0; i < RIPPLE_MAX; i++) if (ripples[i].str > 0.005) active++;
  uniforms.uRippleCount.value = active;
}

// ============================================================
//  封面 + 边缘 + 启发式深度 处理 (CPU 端)
//   生成 256×256 RGBA 纹理: R=depth G=edge B=fg-mask A=lum
// ============================================================
function coverDepthCacheId(raw) {
  var str = String(raw || '');
  if (!str) return '';
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return str.length + ':' + (h >>> 0).toString(36);
}
function getCoverDepthCache(raw) {
  var id = coverDepthCacheId(raw);
  if (!id || !coverDepthCache[id]) return null;
  coverDepthCache[id].at = Date.now();
  var idx = coverDepthCacheKeys.indexOf(id);
  if (idx >= 0) {
    coverDepthCacheKeys.splice(idx, 1);
    coverDepthCacheKeys.push(id);
  } else coverDepthCacheKeys.push(id);
  return coverDepthCache[id];
}
function setCoverDepthCache(raw, canvas, aiEnhanced) {
  var id = coverDepthCacheId(raw);
  if (!id || !canvas) return;
  var idx = coverDepthCacheKeys.indexOf(id);
  if (idx >= 0) coverDepthCacheKeys.splice(idx, 1);
  coverDepthCacheKeys.push(id);
  coverDepthCache[id] = { canvas: canvas, ai: !!aiEnhanced, at: Date.now() };
  while (coverDepthCacheKeys.length > 18) {
    var drop = coverDepthCacheKeys.shift();
    delete coverDepthCache[drop];
  }
}

function buildEdgeAndDepth(srcCanvas) {
  var W = 256, H = 256, N = W * H;
  var normalized = document.createElement('canvas');
  normalized.width = W;
  normalized.height = H;
  var sctx = normalized.getContext('2d');
  sctx.drawImage(srcCanvas, 0, 0, W, H);
  var src = sctx.getImageData(0, 0, W, H).data;
  var lum = new Float32Array(N), blur = new Float32Array(N), tmp = new Float32Array(N);
  // 1) Luminance
  for (var i = 0; i < N; i++) {
    var di = i * 4;
    lum[i] = (src[di] * 0.299 + src[di+1] * 0.587 + src[di+2] * 0.114) / 255;
  }
  // 2) Box blur 2 次 (深度基础)
  function blurH(s, d, r) {
    for (var y = 0; y < H; y++) {
      var sum = 0;
      for (var x = -r; x <= r; x++) sum += s[y * W + Math.max(0, Math.min(W-1, x))];
      for (var x = 0; x < W; x++) {
        d[y * W + x] = sum / (2*r + 1);
        var xR = Math.min(W-1, x + r + 1), xL = Math.max(0, x - r);
        sum += s[y * W + xR] - s[y * W + xL];
      }
    }
  }
  function blurV(s, d, r) {
    for (var x = 0; x < W; x++) {
      var sum = 0;
      for (var y = -r; y <= r; y++) sum += s[Math.max(0, Math.min(H-1, y)) * W + x];
      for (var y = 0; y < H; y++) {
        d[y * W + x] = sum / (2*r + 1);
        var yD = Math.min(H-1, y + r + 1), yU = Math.max(0, y - r);
        sum += s[yD * W + x] - s[yU * W + x];
      }
    }
  }
  blurH(lum, tmp, 4); blurV(tmp, blur, 4);

  // 3) Sobel 边缘 (在 blur 上做 - 减少噪声)
  var edge = new Float32Array(N);
  for (var y = 1; y < H-1; y++) for (var x = 1; x < W-1; x++) {
    var gx = -blur[(y-1)*W + (x-1)] - 2*blur[y*W + (x-1)] - blur[(y+1)*W + (x-1)]
            + blur[(y-1)*W + (x+1)] + 2*blur[y*W + (x+1)] + blur[(y+1)*W + (x+1)];
    var gy = -blur[(y-1)*W + (x-1)] - 2*blur[(y-1)*W + x] - blur[(y-1)*W + (x+1)]
            + blur[(y+1)*W + (x-1)] + 2*blur[(y+1)*W + x] + blur[(y+1)*W + (x+1)];
    edge[y*W + x] = Math.min(1.0, Math.sqrt(gx*gx + gy*gy) * 1.4);
  }
  // 4) 启发式深度:亮度 + 中心 mask + 边缘累积
  var depth = new Float32Array(N);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = y*W + x;
    var cx = (x / (W-1) - 0.5) * 2.0;
    var cy = (y / (H-1) - 0.5) * 2.0;
    var rr = Math.sqrt(cx*cx + cy*cy);
    var centerBias = 1.0 - Math.min(1, rr * 0.75);
    var bright = blur[i];
    depth[i] = Math.min(1.0, bright * 0.45 + centerBias * 0.55);
  }
  // 5) fg-mask: 中心 + 高对比区
  var fg = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var d = depth[i];
    var e = edge[i];
    fg[i] = Math.min(1.0, d * 0.6 + e * 0.5);
  }

  // 输出 256×256 RGBA
  var out = document.createElement('canvas'); out.width = W; out.height = H;
  var octx = out.getContext('2d'), imgOut = octx.createImageData(W, H);
  for (var i = 0; i < N; i++) {
    var di = i * 4;
    imgOut.data[di]   = Math.round(depth[i] * 255);
    imgOut.data[di+1] = Math.round(edge[i] * 255);
    imgOut.data[di+2] = Math.round(fg[i] * 255);
    imgOut.data[di+3] = Math.round(lum[i] * 255);
  }
  octx.putImageData(imgOut, 0, 0);
  return out;
}

// AI 深度估计 (Xenova/depth-anything-small) - 异步加载, 失败回退
async function ensureAIDepthPipeline() {
  if (aiDepthReady && aiDepthPipeline) return aiDepthPipeline;
  if (aiDepthBusy) return null;
  aiDepthBusy = true;
  try {
    showAIDepthChip('加载 AI 深度模型 (首次需下载 50MB)…');
    var mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    mod.env.allowLocalModels = false;
    if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) mod.env.backends.onnx.wasm.numThreads = 1;
    aiDepthPipeline = await mod.pipeline('depth-estimation', 'Xenova/depth-anything-small-hf');
    aiDepthReady = true;
    return aiDepthPipeline;
  } catch (e) {
    console.warn('AI depth pipeline failed:', e);
    return null;
  } finally {
    aiDepthBusy = false;
  }
}

function makeAIDepthInputCanvas(srcCanvas) {
  if (!srcCanvas) return srcCanvas;
  var size = 160;
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var ctx = cv.getContext('2d');
  try {
    ctx.drawImage(srcCanvas, 0, 0, size, size);
    return cv;
  } catch (e) {
    return srcCanvas;
  }
}

async function estimateAIDepth(srcCanvas, token) {
  if (!fx.aiDepth) return null;
  if (performance.now() < aiDepthFailUntil) return null;
  showAIDepthChip('后台增强封面深度…');
  try {
    var pipe = await ensureAIDepthPipeline();
    if (!pipe) { hideAIDepthChip(); return null; }
    if (token !== coverProcessToken) { hideAIDepthChip(); return null; }
    var inputCanvas = makeAIDepthInputCanvas(srcCanvas);
    var input = inputCanvas;
    try {
      if (inputCanvas && inputCanvas.toDataURL) input = inputCanvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      input = inputCanvas;
    }
    var result = await pipe(input);
    if (token !== coverProcessToken) { hideAIDepthChip(); return null; }
    var raw = result && (result.depth || result.predicted_depth || result);
    var rawCv = raw && raw.toCanvas ? await raw.toCanvas() : raw;
    hideAIDepthChip();
    return rawCv;
  } catch (e) {
    console.warn('AI depth estimation failed:', e);
    aiDepthFailUntil = performance.now() + 120000;
    hideAIDepthChip();
    return null;
  }
}

function mergeAIDepthIntoEdgeTexture(heuristicCanvas, aiCanvas) {
  // 把 AI 深度 (灰度) 写入 R 通道, 保留启发式的 G/B/A
  var W = heuristicCanvas.width || 256, H = heuristicCanvas.height || 256;
  var hctx = heuristicCanvas.getContext('2d');
  var hImg = hctx.getImageData(0, 0, W, H);

  var aiTmp = document.createElement('canvas'); aiTmp.width = W; aiTmp.height = H;
  var actx = aiTmp.getContext('2d');
  actx.drawImage(aiCanvas, 0, 0, W, H);
  var aData = actx.getImageData(0, 0, W, H).data;

  // 归一化 AI 深度
  var aiVals = new Float32Array(W * H), minV = 1, maxV = 0;
  for (var i = 0; i < aiVals.length; i++) {
    var di = i * 4;
    var v = (aData[di] * 0.299 + aData[di+1] * 0.587 + aData[di+2] * 0.114) / 255;
    aiVals[i] = v; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  var range = Math.max(0.001, maxV - minV);
  // 判断是否反相 (中心应该比边缘深, 表示前景在中)
  var centerSum = 0, centerCount = 0, edgeSum = 0, edgeCount = 0;
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = y * W + x;
    var cx = x / (W-1) - 0.5, cy = y / (H-1) - 0.5;
    var rr = Math.sqrt(cx*cx + cy*cy);
    if (rr < 0.22) { centerSum += aiVals[i]; centerCount++; }
    else if (rr > 0.46) { edgeSum += aiVals[i]; edgeCount++; }
  }
  var invert = (centerSum / Math.max(1, centerCount)) < (edgeSum / Math.max(1, edgeCount));

  for (var i = 0; i < aiVals.length; i++) {
    var n = (aiVals[i] - minV) / range;
    if (invert) n = 1.0 - n;
    hImg.data[i*4] = Math.round(n * 255);
  }
  hctx.putImageData(hImg, 0, 0);
  return heuristicCanvas;
}

function queueAIDepthForCover(srcCanvas, edgeCanvas, token, opts, cacheSeed, force) {
  opts = opts || {};
  if (mineradioUsesWebMediaBridge()) return;
  if (!fx.aiDepth || !srcCanvas || !edgeCanvas) return;
  if (!force && isHiddenForBackgroundOptimization()) return;
  if (performance.now() < aiDepthFailUntil || aiDepthBusy) return;
  var now = performance.now();
  if (!force && now - aiDepthLastRunAt < aiDepthMinGapMs) return;
  aiDepthLastRunAt = now;
  scheduleVisualApply(async function(){
    if (!fx.aiDepth || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    await yieldToIdle(force ? 900 : 2600);
    if (!fx.aiDepth || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    var aiCanvas = await estimateAIDepth(srcCanvas, token);
    if (!aiCanvas || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    mergeAIDepthIntoEdgeTexture(edgeCanvas, aiCanvas);
    coverEdgeTex.image = edgeCanvas;
    coverEdgeTex.needsUpdate = true;
    setCoverDepthState(1, 1.0, 360);
    setCoverDepthCache(cacheSeed, edgeCanvas, true);
    showToast('AI 深度已后台增强');
  }, force ? 240 : 1800, force ? 1200 : 3000);
}

function queueAIDepthForCurrentCover(force) {
  if (!coverTex || !coverTex.image || !coverEdgeTex || !coverEdgeTex.image) return;
  if (!uniforms.uHasCover.value || !uniforms.uHasDepth.value) return;
  queueAIDepthForCover(coverTex.image, coverEdgeTex.image, coverProcessToken, {}, '', !!force);
}

// 颜色渐变 tween (切歌时旧封面→新封面)
var colorMixTween = null;
function startColorMixTween(durationMs) {
  if (colorMixTween) cancelAnimationFrame(colorMixTween.raf);
  durationMs = Math.max(1, durationMs || 1);
  var start = performance.now();
  uniforms.uColorMixT.value = 0;
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    t = visualEase(t);
    uniforms.uColorMixT.value = t;
    if (t < 1) colorMixTween = { raf: requestAnimationFrame(step) };
    else colorMixTween = null;
  }
  colorMixTween = { raf: requestAnimationFrame(step) };
}

// 粒子整体透明度 tween (启动 fade-in)
var alphaTween = null;
var floatAlphaTween = null;
var IDLE_PARTICLE_ALPHA = 0;
function tweenParticleAlpha(from, to, durationMs) {
  if (alphaTween) cancelAnimationFrame(alphaTween.raf);
  var start = performance.now();
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    t = t * t * (3 - 2 * t);
    uniforms.uAlpha.value = from + (to - from) * t;
    if (t < 1) alphaTween = { raf: requestAnimationFrame(step) };
    else alphaTween = null;
  }
  alphaTween = { raf: requestAnimationFrame(step) };
}
function tweenFloatAlpha(from, to, durationMs) {
  if (floatAlphaTween) cancelAnimationFrame(floatAlphaTween.raf);
  var start = performance.now();
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    t = t * t * (3 - 2 * t);
    uniforms.uFloatAlpha.value = from + (to - from) * t;
    if (t < 1) floatAlphaTween = { raf: requestAnimationFrame(step) };
    else floatAlphaTween = null;
  }
  floatAlphaTween = { raf: requestAnimationFrame(step) };
}
function revealIdleParticles(target, durationMs) {
  if (!uniforms || !uniforms.uFloatAlpha) return;
  if (floatAlphaTween) { cancelAnimationFrame(floatAlphaTween.raf); floatAlphaTween = null; }
  uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
  return;
  var next = typeof target === 'number' ? target : IDLE_PARTICLE_ALPHA;
  var from = uniforms.uFloatAlpha.value || 0;
  if (from >= next - 0.01) return;
  tweenFloatAlpha(from, next, durationMs || 1800);
}

// 加载形态 tween (uLoading 0..1)
var loadingTween = null;
var loadingShownAt = 0;
var loadingHideTimer = null;
var coverDepthTween = null;
function visualEase(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
function tweenLoading(to, durationMs, onComplete) {
  if (loadingTween) cancelAnimationFrame(loadingTween.raf);
  durationMs = Math.max(1, durationMs || 1);
  if (isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
    uniforms.uLoading.value = to;
    loadingTween = null;
    if (onComplete) onComplete();
    return;
  }
  var start = performance.now();
  var from = uniforms.uLoading.value;
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    var eased = visualEase(t);
    uniforms.uLoading.value = from + (to - from) * eased;
    if (t < 1) loadingTween = { raf: requestAnimationFrame(step) };
    else {
      uniforms.uLoading.value = to;
      loadingTween = null;
      if (onComplete) onComplete();
    }
  }
  loadingTween = { raf: requestAnimationFrame(step) };
}
function showLoading(opts) {
  opts = opts || {};
  loadingShownAt = performance.now();
  if (loadingHideTimer) {
    clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }
  var current = uniforms.uLoading.value || 0;
  if (opts.light) tweenLoading(Math.max(current, 0.22), current > 0.04 ? 52 : 72);
  else tweenLoading(Math.max(current, 0.56), current > 0.04 ? 86 : 118);
}
function hideLoading() {
  if (loadingHideTimer) clearTimeout(loadingHideTimer);
  if (isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
    forceLoadingSettled('background-hide');
    return;
  }
  var elapsed = loadingShownAt ? performance.now() - loadingShownAt : 999;
  var wait = Math.max(0, 72 - elapsed);
  loadingHideTimer = setTimeout(function(){
    loadingHideTimer = null;
    var current = uniforms.uLoading.value || 0;
    if (current <= 0.015 || isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
      if (loadingTween) {
        cancelAnimationFrame(loadingTween.raf);
        loadingTween = null;
      }
      uniforms.uLoading.value = 0;
      return;
    }
    tweenLoading(0, current > 0.38 ? 126 : 96);
  }, wait);
}
function forceLoadingSettled(reason) {
  if (loadingHideTimer) {
    clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }
  if (loadingTween) {
    cancelAnimationFrame(loadingTween.raf);
    loadingTween = null;
  }
  uniforms.uLoading.value = 0;
  loadingShownAt = 0;
  if (reason && window.__mineradioDebugLoading) console.log('[LoadingSettled]', reason);
}
function recoverVisualsAfterBackground(reason) {
  applyRendererPowerMode();
  if (typeof scheduleMainRendererViewportRefresh === 'function') scheduleMainRendererViewportRefresh(reason || 'restore');
  if (audio && audio.src && !audio.paused && ((uniforms.uLoading.value || 0) > 0.015 || loadingTween || loadingHideTimer)) {
    forceLoadingSettled(reason || 'restore');
  }
  if (typeof markRenderInteraction === 'function') markRenderInteraction('restore', 1100);
}

function setCoverDepthState(depthTo, aiTo, durationMs) {
  depthTo = Math.max(0, Math.min(1, Number(depthTo) || 0));
  aiTo = Math.max(0, Math.min(1, Number(aiTo) || 0));
  if (coverDepthTween) {
    cancelAnimationFrame(coverDepthTween.raf);
    coverDepthTween = null;
  }
  durationMs = Math.max(1, durationMs || 1);
  var depthFrom = uniforms.uHasDepth.value || 0;
  var aiFrom = uniforms.uAiBoost.value || 0;
  if (durationMs <= 1 || (Math.abs(depthFrom - depthTo) < 0.001 && Math.abs(aiFrom - aiTo) < 0.001)) {
    uniforms.uHasDepth.value = depthTo;
    uniforms.uAiBoost.value = aiTo;
    return;
  }
  var start = performance.now();
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    var eased = visualEase(t);
    uniforms.uHasDepth.value = depthFrom + (depthTo - depthFrom) * eased;
    uniforms.uAiBoost.value = aiFrom + (aiTo - aiFrom) * eased;
    if (t < 1) coverDepthTween = { raf: requestAnimationFrame(step) };
    else {
      uniforms.uHasDepth.value = depthTo;
      uniforms.uAiBoost.value = aiTo;
      coverDepthTween = null;
    }
  }
  coverDepthTween = { raf: requestAnimationFrame(step) };
}

function coverApplyStillCurrent(opts) {
  opts = opts || {};
  return !opts.trackToken || opts.trackToken === trackSwitchToken;
}

function setControlCoverSrc(src) {
  var cover = document.getElementById('control-cover');
  if (!cover) return;
  src = normalizeListenCoverUrl(src) || src;
  if (!src) {
    cover.style.backgroundImage = '';
    cover.classList.add('cover-empty');
    return;
  }
  cover.style.backgroundImage = 'url("' + String(src).replace(/"/g, '\\"') + '")';
  cover.classList.remove('cover-empty');
}

function applyImmediateTrackCover(song, opts) {
  opts = opts || {};
  var coverUrl = '';
  try {
    var custom = typeof getCustomCoverForSong === 'function' ? getCustomCoverForSong(song) : '';
    coverUrl = custom || (typeof resolveSongCoverUrl === 'function' ? resolveSongCoverUrl(song, opts.size || 300) : '') || '';
  } catch (_) {}
  coverUrl = normalizeListenCoverUrl(coverUrl) || coverUrl;
  var displaySrc = coverUrl ? (coverProxySrc(coverUrl) || coverUrl) : '';
  var thumb = document.getElementById('thumb-cover');
  if (!coverUrl) {
    if (thumb) thumb.removeAttribute('src');
    setControlCoverSrc('');
    setAlbumBackground('');
    return '';
  }
  // Paint UI covers immediately from CDN URL; heavy particle texture can catch up later.
  if (thumb) thumb.src = displaySrc;
  setControlCoverSrc(displaySrc);
  setAlbumBackground(coverUrl);
  try {
    currentCoverSource = { kind: /^data:/i.test(coverUrl) ? 'data' : 'url', src: coverUrl };
  } catch (_) {}
  if (shelfManager && typeof shelfManager.onCoverChange === 'function') {
    try { shelfManager.onCoverChange(displaySrc); } catch (_) {}
  }
  return coverUrl;
}
function updateControlTrackInfo(song) {
  song = song || {};
  var title = document.getElementById('control-title');
  var artist = document.getElementById('control-artist');
  if (title) title.textContent = song.name || '';
  if (artist) artist.textContent = song.artist || '';
  // Instant UI paint; optional Bridge resolve only upgrades the control cover later.
  var previewCover = applyImmediateTrackCover(song, { size: 180 }) || resolveSongCoverUrl(song, 96);
  if (previewCover && mineradioUsesWebMediaBridge() && typeof window.__mineradioResolveCoverUrl === 'function') {
    var token = trackSwitchToken;
    window.__mineradioResolveCoverUrl(previewCover, false).then(function(resolved) {
      if (token !== trackSwitchToken || !resolved) return;
      setControlCoverSrc(resolved);
      var thumb = document.getElementById('thumb-cover');
      if (thumb) thumb.src = resolved;
    }).catch(function(){});
  }
  updatePlaybackQualityUi();
}
function prefetchSongCover(song) {
  if (!song || song.type === 'local' || song.source === 'local') return;
  var url = '';
  try { url = resolveSongCoverUrl(song, 300) || ''; } catch (_) {}
  if (!url || !/^https?:\/\//i.test(url)) return;
  var src = coverProxySrc(url) || url;
  try {
    var img = new Image();
    img.decoding = 'async';
    img.src = src;
  } catch (_) {}
}

function applyCoverCanvas(cv, thumbSrc, opts) {
  opts = opts || {};
  if (!cv || !coverApplyStillCurrent(opts)) return;
  var token = ++coverProcessToken;
  if (opts.coverSource && opts.coverSourceKind) {
    currentCoverSource = { kind: opts.coverSourceKind, src: opts.coverSource };
  }
  var cacheSeed = (opts.coverKey || thumbSrc || '') + '|tex=' + (cv.width || 0) + 'x' + (cv.height || 0);
  var cachedDepth = getCoverDepthCache(cacheSeed);
  // 切歌颜色渐变: 把当前 coverTex 当作 prevCoverTex
  if (uniforms.uHasCover.value > 0.5 && coverTex.image) {
    var prevW = coverTex.image.width || 256;
    var prevH = coverTex.image.height || 256;
    var prevScale = Math.min(1, 256 / Math.max(prevW, prevH, 1));
    var prevCv = document.createElement('canvas');
    prevCv.width = Math.max(1, Math.round(prevW * prevScale));
    prevCv.height = Math.max(1, Math.round(prevH * prevScale));
    try {
      prevCv.getContext('2d').drawImage(coverTex.image, 0, 0, prevCv.width, prevCv.height);
      prevCoverTex.image = prevCv;
      prevCoverTex.needsUpdate = true;
    } catch (e) {}
  }
  coverTex.image = cv; coverTex.needsUpdate = true;
  coverPickerCanvas = cv;
  uniforms.uHasCover.value = 1;
  if (cachedDepth && cachedDepth.canvas) {
    coverEdgeTex.image = cachedDepth.canvas;
    coverEdgeTex.needsUpdate = true;
    setCoverDepthState(1, cachedDepth.ai ? 1.0 : 0.55, opts.deferHeavy ? 180 : 120);
  } else {
    setCoverDepthState(opts.deferHeavy ? (uniforms.uHasDepth.value > 0.5 ? 0.22 : 0) : 0, opts.deferHeavy ? 0.20 : 0, opts.deferHeavy ? 120 : 1);
  }

  if (thumbSrc) {
    document.getElementById('thumb-cover').src = thumbSrc;
    setControlCoverSrc(thumbSrc);
  }
  if (shelfManager) shelfManager.onCoverChange(thumbSrc);

  // 启动颜色渐变 (1.4 秒)
  var colorMixMs = opts.colorMixDuration || (fx.preset === 0 ? 520 : 1400);
  startColorMixTween(opts.fromResolutionChange ? (fx.preset === 0 ? 300 : 520) : colorMixMs);

  function refreshCoverDependentColors() {
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    if (floatGroup) refreshFloatColorsFromCover(cv);
    if (backCoverGroup) refreshBackCoverColorsFromCanvas(cv);
    updateLyricPaletteFromCover(cv);
  }

  function runHeavyCoverWork() {
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    if (opts.deferHeavy && typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) {
      scheduleVisualApply(runHeavyCoverWork, 420, heavyTimeout || 1800);
      return;
    }
    var edgeCv = buildEdgeAndDepth(cv);
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    setCoverDepthCache(cacheSeed, edgeCv, false);
    coverEdgeTex.image = edgeCv; coverEdgeTex.needsUpdate = true;
    setCoverDepthState(1, 0.55, opts.deferHeavy ? 260 : 180);
    refreshCoverDependentColors();

    queueAIDepthForCover(cv, edgeCv, token, opts, cacheSeed, false);
  }
  if (cachedDepth && cachedDepth.canvas) {
    scheduleVisualApply(refreshCoverDependentColors, opts.deferHeavy ? 260 : 90, opts.deferHeavy ? 1200 : 700);
    if (!cachedDepth.ai) queueAIDepthForCover(cv, cachedDepth.canvas, token, opts, cacheSeed, false);
    return;
  }
  var heavyDelay = opts.deferHeavy ? (opts.delay || 620) : (opts.delay || 120);
  var heavyTimeout = opts.deferHeavy ? (opts.timeout || 1800) : (opts.timeout || 900);
  scheduleVisualApply(runHeavyCoverWork, heavyDelay, heavyTimeout);
}

// ============================================================
//  离线节拍预解析 (v7.2)
//    流程: fetch 完整音频 → OfflineAudioContext.decodeAudioData
//          → 低通滤波 (只保留 60-150Hz, 即 kick 频段)
//          → 短时能量曲线 → 自适应阈值检测峰值
//          → 输出 kick 时间戳数组 (单位: 秒)
//    优点: 完全规避人声干扰; 预先准备好节奏表
//    缺点: 每首歌首次要 1-3 秒
// ============================================================
function medianGap(times, minGap, maxGap) {
  if (!times || times.length < 2) return 0;
  var gaps = [];
  for (var i = 1; i < times.length; i++) {
    var gap = times[i] - times[i - 1];
    if (gap >= minGap && gap <= maxGap) gaps.push(gap);
  }
  gaps.sort(function(a,b){ return a - b; });
  return gaps.length ? gaps[Math.floor(gaps.length * 0.5)] : 0;
}

function normalizeMusicTempoBeats(times, duration) {
  if (!times || !times.length) return [];
  var sorted = times
    .filter(function(t){ return isFinite(t) && t >= 0.05 && (!duration || t < duration - 0.05); })
    .sort(function(a,b){ return a - b; });
  if (sorted.length < 4) return sorted;
  var gap = medianGap(sorted, 0.20, 1.20);
  var minMainGap = gap && gap < 0.42 ? Math.min(0.44, gap * 1.65) : 0.36;
  var out = [];
  var last = -10;
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i] - last >= minMainGap) {
      out.push(sorted[i]);
      last = sorted[i];
    }
  }
  return out;
}

function estimateTempoPhaseOffset(tempoBeats, beatCandidates, step, duration) {
  if (!tempoBeats || tempoBeats.length < 8 || !beatCandidates || beatCandidates.length < 4 || !step) return 0;
  var maxOffset = Math.min(0.26, Math.max(0.12, step * 0.58));
  var binSize = 0.025;
  var bins = {};
  var samples = [];
  var totalWeight = 0;
  var ti = 0;
  for (var i = 0; i < beatCandidates.length; i++) {
    var b = beatCandidates[i];
    if (!b || !isFinite(b.time)) continue;
    if (duration && (b.time < 1.0 || b.time > duration - 0.5)) continue;
    var strength = Math.max(0, Math.min(1, b.strength || 0));
    if (!b.camera && strength < 0.54) continue;
    if (b.low != null && b.low < 0.18 && strength < 0.66) continue;
    while (ti < tempoBeats.length - 1 && Math.abs(tempoBeats[ti + 1] - b.time) <= Math.abs(tempoBeats[ti] - b.time)) ti++;
    var base = tempoBeats[ti];
    var offset = b.time - base;
    if (!isFinite(offset) || Math.abs(offset) > maxOffset) continue;
    var weight = 0.20 + strength * strength * 1.35;
    if (b.primary) weight *= 1.35;
    if (b.camera) weight *= 1.18;
    if (b.mass != null) weight *= 0.82 + Math.max(0, Math.min(1, b.mass)) * 0.42;
    if (Math.abs(offset) < 0.025) weight *= 0.72;
    var key = Math.round(offset / binSize);
    bins[key] = (bins[key] || 0) + weight;
    samples.push({ offset: offset, weight: weight, key: key });
    totalWeight += weight;
  }
  if (samples.length < 4 || totalWeight <= 0) return 0;
  var bestKey = null;
  var bestWeight = 0;
  Object.keys(bins).forEach(function(k){
    var key = parseInt(k, 10);
    var w = (bins[key] || 0) + (bins[key - 1] || 0) * 0.72 + (bins[key + 1] || 0) * 0.72;
    if (w > bestWeight) {
      bestWeight = w;
      bestKey = key;
    }
  });
  if (bestKey == null || bestWeight < totalWeight * 0.26) return 0;
  var sum = 0;
  var wsum = 0;
  for (var si = 0; si < samples.length; si++) {
    var s = samples[si];
    if (Math.abs(s.key - bestKey) <= 1) {
      sum += s.offset * s.weight;
      wsum += s.weight;
    }
  }
  if (wsum <= 0) return 0;
  var offsetOut = sum / wsum;
  return Math.abs(offsetOut) >= 0.045 ? Math.max(-maxOffset, Math.min(maxOffset, offsetOut)) : 0;
}

var musicTempoLoadPromise = null;
function ensureMusicTempo() {
  if (window.MusicTempo) return Promise.resolve(window.MusicTempo);
  if (musicTempoLoadPromise) return musicTempoLoadPromise;
  musicTempoLoadPromise = fetch('/vendor/music-tempo.min.js')
    .then(function(resp){
      if (!resp.ok) throw new Error('music-tempo load failed: ' + resp.status);
      return resp.text();
    })
    .then(function(code){
      (0, eval)(code);
      return window.MusicTempo || null;
    })
    .catch(function(err){
      console.warn('music-tempo dynamic load failed:', err);
      return null;
    });
  return musicTempoLoadPromise;
}

var musicTempoWorkerUrl = null;
function getMusicTempoWorkerUrl() {
  if (musicTempoWorkerUrl) return musicTempoWorkerUrl;
  var code = [
    'self.onmessage=function(e){',
    'var d=e.data||{};',
    'try{',
    'importScripts(d.scriptUrl||"/vendor/music-tempo.min.js");',
    'var C=self.MusicTempo||(typeof MusicTempo!=="undefined"?MusicTempo:null);',
    'if(!C)throw new Error("MusicTempo unavailable");',
    'var mono=new Float32Array(d.mono);',
    'var mt=new C(mono,{bufferSize:2048,hopSize:Math.max(128,Math.round(d.sampleRate*0.010)),timeStep:0.010,minBeatInterval:0.36,maxBeatInterval:0.95,expiryTime:8});',
    'self.postMessage({ok:true,tempo:mt.tempo||0,beats:mt.beats||[]});',
    '}catch(err){self.postMessage({ok:false,error:(err&&err.message)||String(err)});}',
    '};'
  ].join('');
  musicTempoWorkerUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  return musicTempoWorkerUrl;
}

async function analyzeMusicTempoInWorker(buffer, token) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
  try {
    showBeatChip('后台锁定电影主拍…');
    await yieldToIdle(isHiddenForBackgroundOptimization() ? 20 : 180);
    if (token !== beatMapToken) return null;
    var channels = buffer.numberOfChannels;
    var len = buffer.length;
    var mono = new Float32Array(len);
    var chDataList = [];
    for (var ch = 0; ch < channels; ch++) chDataList.push(buffer.getChannelData(ch));
    var chScale = 1 / Math.max(1, channels);
    var monoChunk = Math.max(4096, Math.floor(buffer.sampleRate * 0.70));
    for (var monoStart = 0; monoStart < len; monoStart += monoChunk) {
      var monoEnd = Math.min(len, monoStart + monoChunk);
      for (var mi = monoStart; mi < monoEnd; mi++) {
        var sum = 0;
        for (var ci = 0; ci < channels; ci++) sum += chDataList[ci][mi] * chScale;
        mono[mi] = sum;
      }
      if ((monoStart / monoChunk) % 2 === 1) {
        await yieldToIdle(isHiddenForBackgroundOptimization() ? 10 : 60);
        if (token !== beatMapToken) return null;
      }
    }
    var worker = new Worker(getMusicTempoWorkerUrl());
    return await new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function(){
        if (done) return;
        done = true;
        worker.terminate();
        resolve(null);
      }, 16000);
      worker.onmessage = function(ev) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate();
        var data = ev.data || {};
        if (!data.ok) {
          console.warn('music-tempo worker failed:', data.error);
          resolve(null);
          return;
        }
        resolve(data);
      };
      worker.onerror = function(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate();
        console.warn('music-tempo worker error:', err && err.message ? err.message : err);
        resolve(null);
      };
      worker.postMessage({
        mono: mono.buffer,
        sampleRate: buffer.sampleRate,
        scriptUrl: location.origin + '/vendor/music-tempo.min.js'
      }, [mono.buffer]);
    });
  } catch (err) {
    console.warn('music-tempo worker setup failed:', err);
    return null;
  }
}

function hasResolvedBeatMapCache(songId) {
  var map = songId ? beatMapCache[songId] : null;
  return !!(map && !map.provisional);
}
function scheduleBeatAnalysis(songId, audioUrl, token, song, directAudioUrl) {
  if (!songId || !audioUrl) {
    hideBeatChip();
    clearProvisionalBeatChipTimer();
    return;
  }
  if (presetSkipsBeatAnalysisUi()) {
    hideBeatChip();
    clearProvisionalBeatChipTimer();
    return;
  }
  if (djMode.active) {
    cancelBeatAnalysisTimer();
    beatAnalysisStartedAt = 0;
    hideBeatChip();
    clearProvisionalBeatChipTimer();
    return;
  }
  cancelBeatAnalysisTimer();
  cancelBeatAnalysisWatchdog();
  beatAnalysisStartedAt = 0;
  clearProvisionalBeatChipTimer();
  beatAnalysisTimer = setTimeout(function waitForQuietStart(){
    beatAnalysisTimer = null;
    if (token !== beatMapToken || !audio) return;
    if (audio.paused) {
      beatAnalysisTimer = setTimeout(waitForQuietStart, 420);
      return;
    }
    var current = audio.currentTime || 0;
    if (current < beatAnalysisConfig.minPlaybackSec) {
      beatAnalysisTimer = setTimeout(waitForQuietStart, Math.max(500, (beatAnalysisConfig.minPlaybackSec - current) * 1000));
      return;
    }
    var startAnalysis = async function(){
      if (token !== beatMapToken || !audio || audio.paused || hasResolvedBeatMapCache(songId)) return;
      var diskMap = await readBeatDiskCache(songId);
      if (diskMap) {
        applyBeatMapCacheForCurrent(songId, diskMap, token, 'D盘节拍缓存命中:');
        return;
      }
      if (token !== beatMapToken || !audio || audio.paused || hasResolvedBeatMapCache(songId)) return;
      if (beatMapBusy) {
        beatAnalysisTimer = setTimeout(function(){
          beatAnalysisTimer = null;
          scheduleAnalysisTask(startAnalysis, 260);
        }, 420);
        return;
      }
      beatAnalysisStartedAt = performance.now();
      armBeatAnalysisWatchdog(token);
      analyzeAudioBeats(audioUrl, null, token, {
        skipMusicTempo: beatAnalysisConfig.skipMusicTempoWhilePlaying && !audio.paused,
        background: true,
        song: song || null,
        directUrl: directAudioUrl || ''
      }).then(function(map){
        cancelBeatAnalysisWatchdog();
        if (token !== beatMapToken) return;
        if (!map) {
          hideBeatChip();
          clearProvisionalBeatChipTimer();
          return;
        }
        smoothBeatMapHandoff(songId, map, token, song || null);
      }).catch(function(err){
        cancelBeatAnalysisWatchdog();
        console.warn('scheduled beat analysis failed:', err);
        hideBeatChip();
        clearProvisionalBeatChipTimer();
        if (mineradioUsesWebMediaBridge() && currentBeatMap && currentBeatMap.provisional) {
          showToast('节奏精分析失败，已继续使用临时网格。');
        }
      });
    };
    scheduleAnalysisTask(startAnalysis, beatAnalysisConfig.idleTimeout);
  }, beatAnalysisConfig.delayMs);
}

function beatMapSongKey(song) {
  if (!song) return '';
  if (song.type === 'local' && song.localKey) return 'local:' + song.localKey;
  if (songProviderKey(song) === 'kg') return 'kg:' + (song.hash || song.id || (song.name + '|' + song.artist));
  if (songProviderKey(song) === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return '';
}

function localBeatDiskKey(localKey, mode) {
  if (!localKey) return '';
  return 'local:' + localKey + ':' + (mode === 'dj' ? 'dj' : 'mr');
}

function updateBeatDiskCacheStatus(data) {
  if (!data) return;
  beatDiskCacheStatus.checked = true;
  beatDiskCacheStatus.enabled = !!data.enabled || data.mode === 'disk' || data.provider === 'web-local' || data.provider === 'extension-local';
  beatDiskCacheStatus.mode = data.mode || (beatDiskCacheStatus.enabled ? 'disk' : 'memory-only');
  beatDiskCacheStatus.reason = data.reason || '';
  if (!beatDiskCacheStatus.enabled && !beatDiskCacheNoticeLogged) {
    beatDiskCacheNoticeLogged = true;
    console.log('节拍磁盘缓存不可用，已降级为本次运行内存缓存:', beatDiskCacheStatus.reason || 'unknown');
  }
}

async function ensureBeatDiskCacheStatus() {
  if (beatDiskCacheStatus.checked) return beatDiskCacheStatus;
  try {
    updateBeatDiskCacheStatus(await apiJson('/api/beatmap/cache/status?t=' + Date.now()));
  } catch (e) {
    updateBeatDiskCacheStatus({ enabled:false, mode:'memory-only', reason:'STATUS_FAILED' });
  }
  return beatDiskCacheStatus;
}

async function readBeatDiskCache(key) {
  if (!key || hasResolvedBeatMapCache(key)) return beatMapCache[key] || null;
  var st = await ensureBeatDiskCacheStatus();
  if (!st.enabled) return null;
  try {
    var r = await apiJson('/api/beatmap/cache?key=' + encodeURIComponent(key) + '&t=' + Date.now());
    if (r && r.enabled === false) updateBeatDiskCacheStatus(r);
    if (!r || !r.hit || !r.map) return null;
    var map = unpackLocalBeatMap(r.map);
    if (!map) return null;
    beatMapCache[key] = map;
    return map;
  } catch (e) {
    console.warn('beat disk cache read failed:', e);
    return null;
  }
}

async function writeBeatDiskCache(key, map, song, mode) {
  if (!key || !map) return false;
  var st = await ensureBeatDiskCacheStatus();
  if (!st.enabled) return false;
  try {
    var packed = packLocalBeatMap(map);
    if (!packed) return false;
    var r = await apiJson('/api/beatmap/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: key,
        mode: mode || 'mr',
        provider: songProviderKey(song),
        title: song && song.name,
        artist: song && song.artist,
        map: packed
      })
    });
    if (r && r.enabled === false) updateBeatDiskCacheStatus(r);
    return !!(r && r.ok);
  } catch (e) {
    console.warn('beat disk cache write failed:', e);
    return false;
  }
}

function isBeatPrefetchCandidate(song) {
  if (!song || isPodcastSong(song) || song.type === 'local' || song.localUrl) return false;
  return !!beatMapSongKey(song);
}

function findNextBeatPrefetchIndex(fromIdx, seen) {
  if (!playQueue.length) return -1;
  seen = seen || {};
  var total = playQueue.length;
  for (var step = 1; step < total; step++) {
    var idx = (fromIdx + step + total) % total;
    if (idx === currentIdx) continue;
    var song = playQueue[idx];
    if (!isBeatPrefetchCandidate(song)) continue;
    var key = beatMapSongKey(song);
    if (!key || beatMapCache[key] || seen[key]) continue;
    return idx;
  }
  return -1;
}

function normalizeBeatPrefetchState(state) {
  state = state || {};
  return {
    keys: Object.assign({}, state.keys || state),
    count: Math.max(0, Number(state.count) || 0)
  };
}

async function fetchBeatPrefetchAudioUrl(song) {
  if (!song) return null;
  var isQQ = songProviderKey(song) === 'qq';
  var isKG = songProviderKey(song) === 'kg';
  var provider = isKG ? 'kg' : (isQQ ? 'qq' : 'netease');
  var requestedQuality = normalizePlaybackQualityForProvider(playbackQuality, provider);
  if (provider === 'netease' && requestedQuality === 'jymaster' && !hasProviderSvip('netease', loginStatus)) requestedQuality = 'hires';
  if (isQQ && qqPlaybackQualityCeiling && (requestedQuality === 'jymaster' || requestedQuality === 'hires' || requestedQuality === 'lossless')) requestedQuality = qqPlaybackQualityCeiling;
  var qualityParam = '&quality=' + encodeURIComponent(requestedQuality);
  var data = isKG
    ? await apiJson(kgPlaybackUrlQuery(song, qualityParam))
    : (isQQ
      ? await apiJson('/api/qq/song/url?mid=' + encodeURIComponent(song.mid || song.songmid || song.id || '') + '&mediaMid=' + encodeURIComponent(song.mediaMid || song.media_mid || '') + qualityParam)
      : await apiJson('/api/song/url?id=' + encodeURIComponent(song.id) + qualityParam));
  if (!data || !data.url || data.trial) return null;
  return {
    analysisUrl: resolveBeatAnalysisAudioUrl(data.url),
    directUrl: data.url
  };
}

function scheduleQueueBeatPrefetch(fromIdx, delayMs, state) {
  cancelBeatPrefetchTimer();
  if (mineradioUsesWebMediaBridge() && !BEAT_PREFETCH_LIMIT) return;
  if (!playQueue.length || beatPrefetchBusy || localBeatAnalysis.active) return;
  var prefetchState = normalizeBeatPrefetchState(state);
  if (prefetchState.count >= BEAT_PREFETCH_LIMIT) return;
  var token = beatMapToken;
  var seq = ++beatPrefetchToken;
  var startIdx = isFinite(fromIdx) ? fromIdx : currentIdx;
  var waitMs = delayMs == null ? 1800 : delayMs;
  if (typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) waitMs = Math.max(waitMs, 2200);
  beatPrefetchTimer = setTimeout(function(){
    beatPrefetchTimer = null;
    runQueueBeatPrefetch(startIdx, token, seq, prefetchState);
  }, waitMs);
}

async function runQueueBeatPrefetch(fromIdx, token, seq, state) {
  if (token !== beatMapToken || seq !== beatPrefetchToken || beatPrefetchBusy || !playQueue.length) return;
  if (audio && audio.paused) return;
  state = normalizeBeatPrefetchState(state);
  if (state.count >= BEAT_PREFETCH_LIMIT) return;
  var idx = findNextBeatPrefetchIndex(fromIdx, state.keys);
  if (idx < 0) return;
  var song = hydrateCustomCover(playQueue[idx]);
  var key = beatMapSongKey(song);
  if (!key) return;
  state.keys[key] = true;
  state.count++;
  beatPrefetchBusy = true;
  beatPrefetchLastKey = key;
  try {
    if (token !== beatMapToken || seq !== beatPrefetchToken) return;
    var diskMap = await readBeatDiskCache(key);
    if (diskMap) {
      console.log('队列节奏D盘缓存命中:', song.name || key, diskMap.visualBeatCount || 0);
      return;
    }
    var prefetchAudio = await fetchBeatPrefetchAudioUrl(song);
    var audioUrl = prefetchAudio && prefetchAudio.analysisUrl;
    var directAudioUrl = prefetchAudio && prefetchAudio.directUrl;
    if (token !== beatMapToken || seq !== beatPrefetchToken || !audioUrl || hasResolvedBeatMapCache(key)) return;
    while (typeof isRenderInteractionActive === 'function' && isRenderInteractionActive() && token === beatMapToken && seq === beatPrefetchToken) {
      await yieldToIdle(isHiddenForBackgroundOptimization() ? 30 : 320);
    }
    if (token !== beatMapToken || seq !== beatPrefetchToken || hasResolvedBeatMapCache(key)) return;
    while (beatMapBusy && token === beatMapToken && seq === beatPrefetchToken) {
      await yieldToIdle(isHiddenForBackgroundOptimization() ? 30 : 240);
    }
    if (token !== beatMapToken || seq !== beatPrefetchToken || hasResolvedBeatMapCache(key)) return;
    var map = await analyzeAudioBeats(audioUrl, null, token, {
      background: true,
      prefetch: true,
      song: song,
      directUrl: directAudioUrl || ''
    });
    if (token !== beatMapToken || seq !== beatPrefetchToken || !map) return;
    beatMapCache[key] = map;
    writeBeatDiskCache(key, map, song, 'mr');
    console.log('队列节奏预热完成:', song.name || key, map.visualBeatCount || 0);
  } catch (err) {
    console.warn('queue beat prefetch failed:', err && err.message ? err.message : err);
  } finally {
    beatPrefetchBusy = false;
    if (state.count < BEAT_PREFETCH_LIMIT && token === beatMapToken && seq === beatPrefetchToken && playQueue.length && !(audio && audio.paused)) {
      scheduleQueueBeatPrefetch(idx, 1600, state);
    }
  }
}

async function analyzeAudioBeats(audioUrl, durationSec, token, options) {
  options = options || {};
  var analysisProfile = cinemaAnalysisProfileForSong(options.song);
  var softGrooveAnalysis = !!(analysisProfile && analysisProfile.softGroove);
  try {
    beatMapBusy = true;
    if (options.prefetch) showBeatChip('预热下一首节奏…');
    else if (options.background) showBeatChip('后台缓冲节奏…');
    await yieldToIdle(beatAnalysisYieldMs(options, 140, 760));
    if (token !== beatMapToken) { hideBeatChip(); beatMapBusy = false; return null; }
    showBeatChip('正在分析节奏…');
    var ab = await fetchAnalysisAudioArrayBuffer(audioUrl, options && options.directUrl);
    if (token !== beatMapToken) { hideBeatChip(); return null; }

    // 用临时 AudioContext 解码 (我们不能复用 audioCtx 因为它可能 closed)
    var TmpCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!TmpCtx) { hideBeatChip(); return null; }
    var DecodeCtx = window.AudioContext || window.webkitAudioContext;
    var dc = new DecodeCtx();
    var buffer = await new Promise(function(resolve, reject){
      dc.decodeAudioData(ab.slice(0), resolve, reject);
    }).catch(function(e){ console.warn('decode failed:', e); return null; });
    dc.close && dc.close();
    if (!buffer) { hideBeatChip(); return null; }
    buffer = truncateAudioBufferForWebAnalysis(buffer);
    if (token !== beatMapToken) { hideBeatChip(); return null; }

    var musicTempoBeats = [];
    var musicTempoGridStep = 0;
    var musicTempoTask = options.skipMusicTempo ? Promise.resolve(null) : analyzeMusicTempoInWorker(buffer, token);

    // 用 OfflineAudioContext 分离低频重鼓 / 中频鼓身 / 高频敲击感.
    var sr = buffer.sampleRate;
    async function renderBand(hpFreq, lpFreq) {
      var off = new TmpCtx(1, buffer.length, sr);
      var src = off.createBufferSource(); src.buffer = buffer;
      var node = src;
      if (hpFreq) {
        var hp = off.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = Math.min(hpFreq, sr * 0.45);
        hp.Q.value = 0.85;
        node.connect(hp);
        node = hp;
      }
      if (lpFreq) {
        var lp = off.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.min(lpFreq, sr * 0.45);
        lp.Q.value = 0.9;
        node.connect(lp);
        node = lp;
      }
      node.connect(off.destination);
      src.start(0);
      var renderedBand = await off.startRendering();
      if (token !== beatMapToken) return null;
      await yieldToIdle(beatAnalysisYieldMs(options, 110, 620));
      return renderedBand.getChannelData(0);
    }
    var bands = [];
    bands.push(await renderBand(38, 155));
    if (token !== beatMapToken || !bands[0]) { hideBeatChip(); return null; }
    bands.push(await renderBand(130, 420));
    if (token !== beatMapToken || !bands[1]) { hideBeatChip(); return null; }
    bands.push(await renderBand(420, 2600));
    if (token !== beatMapToken || !bands[2]) { hideBeatChip(); return null; }
    bands.push(await renderBand(1800, 9000));
    if (token !== beatMapToken) { hideBeatChip(); return null; }
    var lowPcm = bands[0];
    var bodyPcm = bands[1];
    var vocalPcm = bands[2];
    var snapPcm = bands[3];

    // 帧化能量 (10ms 窗口)
    var winSize = Math.floor(sr * 0.010);
    async function makeFrameEnergy(pcm) {
      var frames = Math.floor(pcm.length / winSize);
      var out = new Float32Array(frames);
      for (var f = 0; f < frames; f++) {
        var s = 0;
        var off2 = f * winSize;
        for (var i = 0; i < winSize; i++) {
          var v = pcm[off2 + i];
          s += v * v;
        }
        out[f] = Math.sqrt(s / winSize);
        if (f > 0 && f % 520 === 0) {
          await yieldToPaint();
          if (token !== beatMapToken) return null;
        }
      }
      return out;
    }
    var frameBands = [];
    frameBands.push(await makeFrameEnergy(lowPcm));
    await yieldToIdle(beatAnalysisYieldMs(options, 90, 520));
    frameBands.push(await makeFrameEnergy(bodyPcm));
    await yieldToIdle(beatAnalysisYieldMs(options, 90, 520));
    frameBands.push(await makeFrameEnergy(vocalPcm));
    await yieldToIdle(beatAnalysisYieldMs(options, 90, 520));
    frameBands.push(await makeFrameEnergy(snapPcm));
    if (token !== beatMapToken || !frameBands[0] || !frameBands[1] || !frameBands[2] || !frameBands[3]) { hideBeatChip(); return null; }
    var energy = frameBands[0];
    var bodyEnergy = frameBands[1];
    var vocalEnergy = frameBands[2];
    var snapEnergy = frameBands[3];
    var nFrames = Math.min(energy.length, bodyEnergy.length, vocalEnergy.length, snapEnergy.length);
    function percentile(arr, p) {
      var copy = Array.prototype.slice.call(arr).sort(function(a,b){ return a-b; });
      return copy.length ? copy[Math.floor(copy.length * p)] : 0.001;
    }
    function bandAt(arr, f) {
      var a = arr[Math.max(0, f - 1)] || 0;
      var b = arr[f] || 0;
      var c = arr[Math.min(nFrames - 1, f + 1)] || 0;
      return (a + b * 2 + c) * 0.25;
    }
    var lowRef = Math.max(0.0008, percentile(energy, 0.86));
    var bodyRef = Math.max(0.0008, percentile(bodyEnergy, 0.86));
    var vocalRef = Math.max(0.0008, percentile(vocalEnergy, 0.86));
    var snapRef = Math.max(0.0008, percentile(snapEnergy, 0.86));

    // 计算 onset (能量正向差分), 然后取峰
    function makeOnset(arr) {
      var out = new Float32Array(nFrames);
      for (var oi = 1; oi < nFrames; oi++) {
        out[oi] = Math.max(0, arr[oi] - arr[oi - 1]);
      }
      return out;
    }
    var onset = makeOnset(energy);
    var bodyOnset = makeOnset(bodyEnergy);
    var vocalOnset = makeOnset(vocalEnergy);
    var snapOnset = makeOnset(snapEnergy);
    var lowOnsetRef = Math.max(0.00025, percentile(onset, 0.88));
    var bodyOnsetRef = Math.max(0.00025, percentile(bodyOnset, 0.88));
    var vocalOnsetRef = Math.max(0.00025, percentile(vocalOnset, 0.88));
    var snapOnsetRef = Math.max(0.00025, percentile(snapOnset, 0.88));

    function softGrooveFrameScore(frame) {
      var sf = Math.max(0, Math.min(nFrames - 1, Math.round(frame)));
      var lowTone = Math.min(2.2, bandAt(energy, sf) / lowRef);
      var bodyTone = Math.min(2.2, bandAt(bodyEnergy, sf) / bodyRef);
      var vocalTone = Math.min(2.2, bandAt(vocalEnergy, sf) / vocalRef);
      var snapTone = Math.min(2.2, bandAt(snapEnergy, sf) / snapRef);
      var lowRise = Math.min(2.6, (onset[sf] || 0) / lowOnsetRef);
      var bodyRise = Math.min(2.6, (bodyOnset[sf] || 0) / bodyOnsetRef);
      var vocalRise = Math.min(2.6, (vocalOnset[sf] || 0) / vocalOnsetRef);
      var snapRise = Math.min(2.6, (snapOnset[sf] || 0) / snapOnsetRef);
      var drumRise = lowRise * 0.52 + bodyRise * 0.42 + snapRise * 0.08;
      var drumTone = lowTone * 0.24 + bodyTone * 0.22 + snapTone * 0.05;
      var vocalLeak = Math.max(0, vocalRise + vocalTone * 0.30 - (lowRise + bodyRise) * 0.54 - 0.18);
      return Math.max(0, drumRise + drumTone - vocalLeak * 0.18);
    }

    function bestSoftGrooveFrameNear(time, radiusSec) {
      var center = Math.max(0, Math.min(nFrames - 1, Math.round(time / 0.010)));
      var radius = Math.max(1, Math.round(Math.max(0.010, radiusSec || 0.040) / 0.010));
      var base = softGrooveFrameScore(center);
      var bestFrame = center;
      var bestScore = base;
      for (var sf = Math.max(0, center - radius); sf <= Math.min(nFrames - 1, center + radius); sf++) {
        var dist = Math.abs(sf - center) / Math.max(1, radius);
        var score = softGrooveFrameScore(sf) * (1 - dist * 0.16);
        if (score > bestScore) {
          bestScore = score;
          bestFrame = sf;
        }
      }
      return { frame: bestFrame, time: bestFrame * 0.010, score: bestScore, base: base };
    }

    function scoreSoftGrooveTempoOffset(times, offset, step) {
      if (!times || !times.length) return 0;
      var total = 0;
      var weightTotal = 0;
      var localRadius = Math.min(0.026, Math.max(0.014, (step || 0.55) * 0.045));
      var stride = times.length > 720 ? 2 : 1;
      for (var si = 0; si < times.length; si += stride) {
        var t = times[si] + offset;
        if (!isFinite(t) || t < 1.0 || t > buffer.duration - 0.40) continue;
        var slot = si % 4;
        var slotWeight = slot === 0 ? 1.22 : (slot === 2 ? 1.06 : 0.88);
        var point = bestSoftGrooveFrameNear(t, localRadius);
        total += point.score * slotWeight;
        weightTotal += slotWeight;
      }
      return weightTotal > 0 ? total / weightTotal : 0;
    }

    function estimateSoftGrooveTempoOffset(times, step) {
      if (!softGrooveAnalysis || !times || times.length < 8 || !step) return 0;
      var maxOffset = Math.min(0.20, Math.max(0.075, step * 0.32));
      var baseScore = scoreSoftGrooveTempoOffset(times, 0, step);
      var bestOffset = 0;
      var bestScore = baseScore;
      for (var off = -maxOffset; off <= maxOffset + 0.0001; off += 0.010) {
        var score = scoreSoftGrooveTempoOffset(times, off, step);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = off;
        }
      }
      if (Math.abs(bestOffset) < 0.014) return 0;
      return bestScore > baseScore * 1.055 ? Math.max(-maxOffset, Math.min(maxOffset, bestOffset)) : 0;
    }

    function refineSoftGrooveBeatTime(time, step) {
      if (!softGrooveAnalysis || !analysisProfile.localRefine) return { time: time, score: 0, base: 0 };
      var radius = Math.min(0.058, Math.max(0.024, (step || 0.55) * 0.095));
      var point = bestSoftGrooveFrameNear(time, radius);
      if (Math.abs(point.time - time) < 0.011) return { time: time, score: point.score, base: point.base };
      if (point.score < point.base * 1.045) return { time: time, score: point.score, base: point.base };
      return { time: point.time, score: point.score, base: point.base };
    }

    function thinSoftGrooveCameraBeats(events, step, duration) {
      if (!analysisProfile.sparseCamera || !events || events.length < 6) return events || [];
      step = Math.max(0.001, step || medianGap(events.map(function(b){ return b.time; }), 0.30, 1.20) || 0.82);
      function moodScore(b) {
        if (!b) return 0;
        return (b.grooveEvidence || 0) * 0.56 + (b.impact || 0) * 0.34 + (b.strength || 0) * 0.18 + (b.low || 0) * 0.10 + (b.body || 0) * 0.08;
      }
      function eventPercentile(rows, p) {
        var vals = rows.map(function(row){ return row.score; }).sort(function(a,b){ return a-b; });
        return vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0;
      }
      function medianNumber(vals) {
        vals = vals.filter(function(v){ return isFinite(v); }).sort(function(a,b){ return a-b; });
        return vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
      }
      function cloneSparseBeat(b, score, accent, tag) {
        var out = Object.assign({}, b);
        out.primary = true;
        out.camera = true;
        out.pulse = true;
        out.sparse = true;
        out.tone = tag || 'sunset-groove';
        out.impact = clampRange((out.impact || out.strength || 0.30) * (accent ? 0.76 : 0.66) + score * 0.07, 0.18, accent ? 0.58 : 0.50);
        out.strength = clampRange((out.strength || 0.34) * (accent ? 0.76 : 0.68) + score * 0.055, 0.30, accent ? 0.64 : 0.56);
        out.mass = clampRange((out.mass || 0.48) * 0.78, 0.28, 0.60);
        out.sharpness = clampRange((out.sharpness || 0.10) * 0.66, 0.05, 0.32);
        out._sparseScore = score;
        return out;
      }
      function findBestEventNear(time, radius) {
        var best = null;
        var bestScore = -1;
        radius = radius || 0.20;
        for (var i = 0; i < events.length; i++) {
          var b = events[i];
          if (!b || !isFinite(b.time)) continue;
          var dist = Math.abs(b.time - time);
          if (dist > radius) continue;
          var score = moodScore(b) * (1 - dist / radius * 0.18);
          if (score > bestScore) {
            best = b;
            bestScore = score;
          }
        }
        return best ? { beat: best, score: Math.max(0, bestScore) } : null;
      }
      function buildBeatFromFrame(time, score, tag) {
        var f = Math.max(0, Math.min(nFrames - 1, Math.round(time / 0.010)));
        var lowTone = Math.min(2.0, bandAt(energy, f) / lowRef);
        var bodyTone = Math.min(2.0, bandAt(bodyEnergy, f) / bodyRef);
        var snapTone = Math.min(2.0, bandAt(snapEnergy, f) / snapRef);
        var toneTotal = Math.max(0.001, lowTone + bodyTone * 0.72 + snapTone * 0.58);
        var lowMix = lowTone / toneTotal;
        var bodyMix = (bodyTone * 0.72) / toneTotal;
        var snapMix = (snapTone * 0.58) / toneTotal;
        return {
          time: time,
          strength: clampRange(0.30 + score * 0.055, 0.30, 0.52),
          confidence: clampRange(0.46 + score * 0.08, 0.46, 0.66),
          primary: true,
          camera: true,
          pulse: true,
          sparse: true,
          tone: tag || 'sunset-pattern',
          impact: clampRange(0.18 + score * 0.060, 0.18, 0.48),
          low: Math.max(0.22, Math.min(0.74, lowMix)),
          body: bodyMix,
          snap: snapMix,
          mass: Math.max(0.30, Math.min(0.58, lowMix * 0.58 + bodyMix * 0.20)),
          sharpness: Math.max(0.05, Math.min(0.28, snapMix * 0.72))
        };
      }
      function learnIntroPattern() {
        if (!analysisProfile.introPattern) return null;
        var introEnd = Math.min(duration || 34, 34);
        var rows = events.filter(function(b){ return b && isFinite(b.time) && b.time >= 1.2 && b.time <= introEnd; })
          .map(function(b){ return { beat: b, score: moodScore(b) }; });
        if (rows.length < 6) return null;
        var scoreFloor = Math.max(0.34, eventPercentile(rows, 0.58));
        var hits = [];
        var minIntroGap = 1.08;
        rows.forEach(function(row){
          if (row.score < scoreFloor && !(row.beat && (row.beat.low || 0) > 0.42 && row.score > scoreFloor * 0.78)) return;
          var last = hits[hits.length - 1];
          if (last && row.beat.time - last.beat.time < minIntroGap) {
            if (row.score > last.score) hits[hits.length - 1] = row;
          } else {
            hits.push(row);
          }
        });
        if (hits.length < 5) return null;
        var gaps = [];
        for (var hi = 1; hi < hits.length; hi++) {
          var gap = hits[hi].beat.time - hits[hi - 1].beat.time;
          if (gap >= 1.18 && gap <= 2.45) gaps.push(gap);
        }
        if (gaps.length < 4) return null;
        var firstGaps = gaps.slice(0, Math.min(8, gaps.length));
        var evenGaps = [];
        var oddGaps = [];
        for (var gi = 0; gi < firstGaps.length; gi++) {
          (gi % 2 === 0 ? evenGaps : oddGaps).push(firstGaps[gi]);
        }
        var evenGap = medianNumber(evenGaps);
        var oddGap = medianNumber(oddGaps);
        var patternGaps;
        if (evenGap && oddGap && Math.abs(evenGap - oddGap) > 0.16) {
          patternGaps = [evenGap, oddGap].map(function(v){ return clampRange(v, 1.30, 2.22); });
        } else {
          patternGaps = [clampRange(medianNumber(firstGaps), 1.42, 2.12)];
        }
        var refScore = Math.max(0.35, eventPercentile(hits, 0.50));
        return {
          anchor: hits[0].beat.time,
          gaps: patternGaps,
          refScore: refScore,
          introHitCount: hits.length,
          introTimes: hits.slice(0, 10).map(function(row){ return row.beat.time; })
        };
      }
      function buildIntroPatternBeats() {
        var pattern = learnIntroPattern();
        if (!pattern) return null;
        var selected = [];
        var t = pattern.anchor;
        var gi = 0;
        var avgGap = pattern.gaps.reduce(function(a,b){ return a + b; }, 0) / Math.max(1, pattern.gaps.length);
        var refineRadius = Math.min(0.22, Math.max(0.14, avgGap * 0.10));
        var findRadius = Math.min(0.26, Math.max(0.18, avgGap * 0.13));
        while (t < (duration || 0) - 0.55) {
          var point = bestSoftGrooveFrameNear(t, refineRadius);
          var refinedTime = Math.abs(point.time - t) <= refineRadius ? point.time : t;
          var match = findBestEventNear(refinedTime, findRadius) || findBestEventNear(t, findRadius);
          var score = match ? match.score : Math.max(0.26, (point.score || 0) / Math.max(1.0, pattern.refScore * 2.2));
          var accent = (gi % pattern.gaps.length) === 0;
          var beat = match ? cloneSparseBeat(match.beat, score, accent, 'sunset-intro-pattern') : buildBeatFromFrame(refinedTime, score, 'sunset-intro-pattern');
          beat.time = refinedTime;
          beat.index = gi;
          beat.combo = accent ? 'downbeat' : 'rebound';
          beat.introPattern = true;
          selected.push(beat);
          t += pattern.gaps[gi % pattern.gaps.length];
          gi++;
          if (gi > 800) break;
        }
        for (var si = 0; si < selected.length; si++) delete selected[si]._sparseScore;
        console.log('soft-groove intro pattern camera:', selected.length, 'gaps:', pattern.gaps.map(function(v){ return v.toFixed(2); }).join('/'), 'anchor:', pattern.anchor.toFixed(2), 'introHits:', pattern.introHitCount);
        return selected.length >= 8 ? selected : null;
      }
      var introPatternBeats = buildIntroPatternBeats();
      if (introPatternBeats && introPatternBeats.length >= 8) return introPatternBeats;

      var railStep = step;
      while (railStep < 1.35) railStep *= 2;
      railStep = clampRange(railStep, 1.42, 2.12);
      var railMultiple = Math.max(1, Math.round(railStep / step));
      if (railMultiple < 2 && step < 1.20) railMultiple = 2;
      var phaseScores = new Array(railMultiple);
      for (var pi = 0; pi < phaseScores.length; pi++) phaseScores[pi] = 0;
      for (var ei = 0; ei < events.length; ei++) {
        var ev = events[ei];
        if (!ev || !isFinite(ev.time)) continue;
        if (ev.time < 1.0 || (duration && ev.time > duration - 0.65)) continue;
        var phase = Math.abs((ev.index == null ? ei : ev.index) % railMultiple);
        var earlyWeight = ev.time < 70 ? 1.18 : (ev.time < 205 ? 1.0 : 0.94);
        phaseScores[phase] += moodScore(ev) * earlyWeight;
      }
      var bestPhase = 0;
      for (var ps = 1; ps < phaseScores.length; ps++) {
        if (phaseScores[ps] > phaseScores[bestPhase]) bestPhase = ps;
      }
      var selected = [];
      var minGap = Math.max(1.12, railStep * 0.68);
      function pushSparse(b, score, accent) {
        if (!b || score < 0.28) return;
        var copy = cloneSparseBeat(b, score, accent, 'sunset-groove');
        copy.combo = selected.length % 2 === 0 ? 'downbeat' : 'rebound';
        var last = selected[selected.length - 1];
        if (last && copy.time - last.time < minGap) {
          if (score > (last._sparseScore || 0) + 0.05) selected[selected.length - 1] = copy;
          return;
        }
        selected.push(copy);
      }
      for (var si = 0; si < events.length; si++) {
        var b = events[si];
        if (!b || !isFinite(b.time)) continue;
        var idx = b.index == null ? si : b.index;
        var score = moodScore(b);
        var onRail = Math.abs(idx % railMultiple) === bestPhase;
        if (onRail) {
          pushSparse(b, score, false);
        } else if (score >= 0.82 && (!selected.length || b.time - selected[selected.length - 1].time >= minGap * 1.18)) {
          pushSparse(b, score, true);
        }
      }
      for (var ci = 0; ci < selected.length; ci++) {
        delete selected[ci]._sparseScore;
      }
      var minExpected = duration ? Math.max(16, Math.floor(duration / 3.2)) : 16;
      if (selected.length < minExpected) {
        var fallback = events.filter(function(b){ return b && b.camera !== false && b.pulse !== false; });
        selected = [];
        for (var fi = 0; fi < fallback.length; fi++) pushSparse(fallback[fi], moodScore(fallback[fi]), false);
        for (var di = 0; di < selected.length; di++) delete selected[di]._sparseScore;
      }
      console.log('soft-groove sparse camera:', selected.length, 'of', events.length, 'railStep:', railStep.toFixed(2), 'phase:', bestPhase + '/' + railMultiple);
      return selected.length >= 4 ? selected : events.filter(function(b){ return b && b.camera !== false; });
    }

    // 自适应阈值: 滑动均值 + 标准差, 输出带强度的 beat 事件.
    var winN = 50;  // 0.5 秒
    var candidates = [];
    var lastKickFrame = -winN;
    var minIntervalFrames = 12;  // 120ms, 粒子可响应较密集的低频瞬态.
    for (var f = winN; f < nFrames - 5; f++) {
      var sum = 0, sqSum = 0;
      for (var k = f - winN; k < f; k++) { sum += onset[k]; sqSum += onset[k] * onset[k]; }
      var mean = sum / winN;
      var std = Math.sqrt(Math.max(0, sqSum / winN - mean * mean));
      var thresh = mean + std * 2.35 + 0.0045;
      if (onset[f] > thresh && onset[f] > onset[f-1] && onset[f] >= onset[f+1]) {
        if (f - lastKickFrame >= minIntervalFrames) {
          var localScore = (onset[f] - thresh) / Math.max(0.006, std + mean * 0.35);
          candidates.push({
            frame: f,
            time: f * 0.010,
            raw: onset[f],
            score: localScore,
            lowTone: Math.min(2.0, bandAt(energy, f) / lowRef),
            bodyTone: Math.min(2.0, bandAt(bodyEnergy, f) / bodyRef),
            vocalTone: Math.min(2.0, bandAt(vocalEnergy, f) / vocalRef),
            snapTone: Math.min(2.0, bandAt(snapEnergy, f) / snapRef)
          });
          lastKickFrame = f;
        }
      }
      if (f > winN && f % 900 === 0) {
        await yieldToPaint();
        if (token !== beatMapToken) { hideBeatChip(); return null; }
      }
    }

    var scores = candidates.map(function(b){ return b.score; }).sort(function(a,b){ return a-b; });
    var p75 = scores.length ? scores[Math.floor(scores.length * 0.75)] : 1;
    var p92 = scores.length ? scores[Math.floor(scores.length * 0.92)] : Math.max(1, p75);
    var strongTimes = [];
    var beats = candidates.map(function(b, i){
      var strength = Math.max(0.18, Math.min(1, (b.score - p75 * 0.36) / Math.max(0.001, p92 - p75 * 0.36)));
      var lowDominance = b.lowTone / Math.max(0.001, b.vocalTone * 0.84 + b.bodyTone * 0.36 + b.snapTone * 0.10);
      var toneTotal = Math.max(0.001, b.lowTone + b.bodyTone * 0.72 + b.snapTone * 0.58);
      var lowMix = b.lowTone / toneTotal;
      var bodyMix = (b.bodyTone * 0.72) / toneTotal;
      var snapMix = (b.snapTone * 0.58) / toneTotal;
      var drumLike = b.lowTone > 0.38 && (lowMix > 0.42 || lowDominance > 0.72);
      if (strength > 0.55 && drumLike) strongTimes.push(b.time);
      var sharpness = Math.max(0.08, Math.min(1, snapMix * 1.55 + strength * 0.10));
      var mass = Math.max(0.25, Math.min(1, lowMix * 0.72 + bodyMix * 0.36 + strength * 0.20));
      var tone = snapMix > 0.34 && b.snapTone > 0.55 ? 'snap' : (bodyMix > 0.36 && b.bodyTone > 0.55 ? 'body' : (lowMix > 0.55 ? 'deep' : 'mixed'));
      return {
        time: b.time,
        strength: strength,
        confidence: Math.max(0.22, Math.min(1, b.score / Math.max(0.001, p92))),
        primary: drumLike && strength >= 0.50,
        camera: drumLike && strength >= 0.42,
        tone: tone,
        low: lowMix,
        body: bodyMix,
        snap: snapMix,
        mass: mass,
        sharpness: sharpness,
        index: i
      };
    });

    var gaps = [];
    for (var gi = 1; gi < strongTimes.length; gi++) {
      var gap = strongTimes[gi] - strongTimes[gi - 1];
      if (gap >= 0.26 && gap <= 0.86) gaps.push(gap);
    }
    gaps.sort(function(a,b){ return a-b; });
    var gridStep = gaps.length ? gaps[Math.floor(gaps.length * 0.5)] : 0;
    var cameraBeats = beats.filter(function(b){ return b.camera; });
    if (gridStep > 0) {
      for (var bi = 0; bi < beats.length; bi++) {
        var prevGap = bi > 0 ? beats[bi].time - beats[bi - 1].time : gridStep;
        var nextGap = bi < beats.length - 1 ? beats[bi + 1].time - beats[bi].time : gridStep;
        var gridLike = Math.abs(prevGap - gridStep) < gridStep * 0.32 || Math.abs(nextGap - gridStep) < gridStep * 0.32;
        beats[bi].primary = beats[bi].camera && beats[bi].strength >= (gridLike ? 0.42 : 0.58);
      }
      if (gridStep >= 0.38 && gridStep <= 0.88 && strongTimes.length >= 4) {
        var anchor = strongTimes[0];
        while (anchor - gridStep > 0.20) anchor -= gridStep;
        var gridBeats = [];
        var windowSec = Math.min(0.18, gridStep * 0.30);
        for (var gt = anchor; gt < buffer.duration - 0.05; gt += gridStep) {
          var best = null;
          var bestDist = windowSec;
          for (var ci = 0; ci < beats.length; ci++) {
            var dist = Math.abs(beats[ci].time - gt);
            if (dist < bestDist) {
              best = beats[ci];
              bestDist = dist;
            }
          }
          if (best && best.camera) {
            best.primary = true;
            best.strength = Math.max(best.strength, 0.54);
            best.confidence = Math.max(best.confidence, 0.58);
            gridBeats.push(best);
          } else {
            var gf = Math.max(0, Math.min(nFrames - 1, Math.round(gt / 0.010)));
            var lowTone = Math.min(2.0, bandAt(energy, gf) / lowRef);
            var bodyTone = Math.min(2.0, bandAt(bodyEnergy, gf) / bodyRef);
            var vocalTone = Math.min(2.0, bandAt(vocalEnergy, gf) / vocalRef);
            var snapTone = Math.min(2.0, bandAt(snapEnergy, gf) / snapRef);
            var lowDominance = lowTone / Math.max(0.001, vocalTone * 0.84 + bodyTone * 0.36 + snapTone * 0.10);
            var toneTotal = Math.max(0.001, lowTone + bodyTone * 0.72 + snapTone * 0.58);
            var lowMix = lowTone / toneTotal;
            var bodyMix = (bodyTone * 0.72) / toneTotal;
            var snapMix = (snapTone * 0.58) / toneTotal;
            if (lowTone <= 0.38 || (lowMix <= 0.42 && lowDominance <= 0.72)) continue;
            gridBeats.push({
              time: gt,
              strength: 0.53,
              confidence: 0.60,
              primary: true,
              ghost: true,
              tone: 'grid',
              low: lowMix,
              body: bodyMix,
              snap: snapMix,
              mass: Math.max(0.35, Math.min(0.82, lowMix * 0.72 + bodyMix * 0.36 + 0.16)),
              sharpness: Math.max(0.08, Math.min(0.65, snapMix * 1.25)),
              index: gridBeats.length
            });
          }
        }
        cameraBeats = gridBeats;
      }
    }

    var musicTempoResult = await musicTempoTask;
    if (token !== beatMapToken) { hideBeatChip(); return null; }
    if (musicTempoResult && musicTempoResult.beats && musicTempoResult.beats.length) {
      musicTempoBeats = normalizeMusicTempoBeats(musicTempoResult.beats || [], buffer.duration);
      musicTempoGridStep = medianGap(musicTempoBeats, 0.36, 1.00);
      console.log('music-tempo worker:', musicTempoResult.tempo, 'bpm, beats:', musicTempoBeats.length, 'step:', musicTempoGridStep);
    }

    if (musicTempoBeats.length >= 4) {
      var musicTempoPhaseOffset = estimateTempoPhaseOffset(musicTempoBeats, beats, musicTempoGridStep || gridStep, buffer.duration);
      if (musicTempoPhaseOffset) {
        musicTempoBeats = musicTempoBeats.map(function(t){ return t + musicTempoPhaseOffset; })
          .filter(function(t){ return isFinite(t) && t >= 0.05 && t < buffer.duration - 0.05; });
        console.log('music-tempo phase correction:', musicTempoPhaseOffset.toFixed(3), 's');
      }
      if (analysisProfile.phaseScan) {
        var softGroovePhaseOffset = estimateSoftGrooveTempoOffset(musicTempoBeats, musicTempoGridStep || gridStep);
        if (softGroovePhaseOffset) {
          musicTempoBeats = musicTempoBeats.map(function(t){ return t + softGroovePhaseOffset; })
            .filter(function(t){ return isFinite(t) && t >= 0.05 && t < buffer.duration - 0.05; });
          console.log('soft-groove phase correction:', softGroovePhaseOffset.toFixed(3), 's');
        }
      }
      var tempoCameraBeats = [];
      var tempoWindow = Math.min(0.16, Math.max(0.095, (musicTempoGridStep || 0.60) * 0.24));
      var tempoMetrics = [];
      for (var ti = 0; ti < musicTempoBeats.length; ti++) {
        var mtTime = musicTempoBeats[ti];
        var refinedPoint = refineSoftGrooveBeatTime(mtTime, musicTempoGridStep || gridStep);
        var metricTime = refinedPoint.time;
        var nearest = null;
        var nearestDist = tempoWindow;
        for (var nb = 0; nb < beats.length; nb++) {
          var nd = Math.abs(beats[nb].time - metricTime);
          if (nd < nearestDist) {
            nearest = beats[nb];
            nearestDist = nd;
          }
        }
        var mf = Math.max(0, Math.min(nFrames - 1, Math.round(metricTime / 0.010)));
        var mtLowTone = Math.min(2.0, bandAt(energy, mf) / lowRef);
        var mtBodyTone = Math.min(2.0, bandAt(bodyEnergy, mf) / bodyRef);
        var mtVocalTone = Math.min(2.0, bandAt(vocalEnergy, mf) / vocalRef);
        var mtSnapTone = Math.min(2.0, bandAt(snapEnergy, mf) / snapRef);
        var mtLowRise = Math.min(2.5, (onset[mf] || 0) / lowOnsetRef);
        var mtBodyRise = Math.min(2.5, (bodyOnset[mf] || 0) / bodyOnsetRef);
        var mtVocalRise = Math.min(2.5, (vocalOnset[mf] || 0) / vocalOnsetRef);
        var mtSnapRise = Math.min(2.5, (snapOnset[mf] || 0) / snapOnsetRef);
        var mtLowDominance = mtLowTone / Math.max(0.001, mtVocalTone * 0.84 + mtBodyTone * 0.36 + mtSnapTone * 0.10);
        var mtToneTotal = Math.max(0.001, mtLowTone + mtBodyTone * 0.72 + mtSnapTone * 0.58);
        var mtLowMix = mtLowTone / mtToneTotal;
        var mtBodyMix = (mtBodyTone * 0.72) / mtToneTotal;
        var mtSnapMix = (mtSnapTone * 0.58) / mtToneTotal;
        var mtPower = mtLowTone * 0.44 + mtBodyTone * 0.16 + mtSnapTone * 0.08 + Math.min(1.8, mtLowDominance) * 0.16 + (nearest ? nearest.strength * 0.46 : 0);
        if (softGrooveAnalysis) {
          var vocalLeak = Math.max(0, mtVocalRise + mtVocalTone * 0.22 - (mtLowRise + mtBodyRise) * 0.50 - 0.14);
          mtPower = mtLowTone * 0.26 + mtBodyTone * 0.24 + mtLowRise * 0.34 + mtBodyRise * 0.32 + mtSnapRise * 0.06 + Math.min(1.7, mtLowDominance) * 0.10 + (nearest ? nearest.strength * 0.30 : 0) - vocalLeak * 0.16;
        }
        tempoMetrics.push({
          time: metricTime,
          gridTime: mtTime,
          nearest: nearest,
          lowTone: mtLowTone,
          bodyTone: mtBodyTone,
          snapTone: mtSnapTone,
          lowRise: mtLowRise,
          bodyRise: mtBodyRise,
          snapRise: mtSnapRise,
          lowDominance: mtLowDominance,
          lowMix: mtLowMix,
          bodyMix: mtBodyMix,
          snapMix: mtSnapMix,
          power: mtPower,
          softScore: refinedPoint.score || 0,
          index: ti
        });
      }
      var tempoPowers = tempoMetrics.map(function(m){ return m.power; });
      var tempoLowTones = tempoMetrics.map(function(m){ return m.lowTone; });
      var tempoBodyTones = tempoMetrics.map(function(m){ return m.bodyTone; });
      var tempoSnapTones = tempoMetrics.map(function(m){ return m.snapTone; });
      var tempoLowRises = tempoMetrics.map(function(m){ return m.lowRise || 0; });
      var tempoBodyRises = tempoMetrics.map(function(m){ return m.bodyRise || 0; });
      var tempoSnapRises = tempoMetrics.map(function(m){ return m.snapRise || 0; });
      var powerFloor = Math.max(0.001, percentile(tempoPowers, 0.25));
      var powerCeil = Math.max(powerFloor + 0.001, percentile(tempoPowers, 0.90));
      var lowFloor = Math.max(0.001, percentile(tempoLowTones, 0.25));
      var lowCeil = Math.max(lowFloor + 0.001, percentile(tempoLowTones, 0.88));
      var bodyFloor = Math.max(0.001, percentile(tempoBodyTones, 0.25));
      var bodyCeil = Math.max(bodyFloor + 0.001, percentile(tempoBodyTones, 0.90));
      var snapFloor = Math.max(0.001, percentile(tempoSnapTones, 0.25));
      var snapCeil = Math.max(snapFloor + 0.001, percentile(tempoSnapTones, 0.90));
      var lowRiseFloor = Math.max(0.001, percentile(tempoLowRises, 0.25));
      var lowRiseCeil = Math.max(lowRiseFloor + 0.001, percentile(tempoLowRises, 0.90));
      var bodyRiseFloor = Math.max(0.001, percentile(tempoBodyRises, 0.25));
      var bodyRiseCeil = Math.max(bodyRiseFloor + 0.001, percentile(tempoBodyRises, 0.90));
      var snapRiseFloor = Math.max(0.001, percentile(tempoSnapRises, 0.25));
      var snapRiseCeil = Math.max(snapRiseFloor + 0.001, percentile(tempoSnapRises, 0.90));
      for (var tm = 0; tm < tempoMetrics.length; tm++) {
        var m = tempoMetrics[tm];
        var mtSlot = m.index % 4;
        var powerRel = clamp01((m.power - powerFloor) / (powerCeil - powerFloor));
        var lowRel = clamp01((m.lowTone - lowFloor) / (lowCeil - lowFloor));
        var bodyRel = clamp01((m.bodyTone - bodyFloor) / (bodyCeil - bodyFloor));
        var snapRel = clamp01((m.snapTone - snapFloor) / (snapCeil - snapFloor));
        var lowRiseRel = clamp01(((m.lowRise || 0) - lowRiseFloor) / (lowRiseCeil - lowRiseFloor));
        var bodyRiseRel = clamp01(((m.bodyRise || 0) - bodyRiseFloor) / (bodyRiseCeil - bodyRiseFloor));
        var snapRiseRel = clamp01(((m.snapRise || 0) - snapRiseFloor) / (snapRiseCeil - snapRiseFloor));
        var mtImpact = clamp01(powerRel * 0.50 + lowRel * 0.24 + bodyRel * 0.18 + snapRel * 0.08);
        if (m.nearest) mtImpact = Math.max(mtImpact, Math.min(1, m.nearest.strength * 0.58 + (m.nearest.primary ? 0.08 : 0)));
        if (softGrooveAnalysis) {
          mtImpact = clamp01(powerRel * 0.34 + lowRel * 0.18 + bodyRel * 0.18 + lowRiseRel * 0.24 + bodyRiseRel * 0.24 + snapRiseRel * 0.04);
          if (m.nearest) mtImpact = Math.max(mtImpact, Math.min(0.72, m.nearest.strength * 0.42 + (m.nearest.primary ? 0.06 : 0)));
        }
        var activeCamera = mtImpact >= 0.20 || (mtSlot === 0 && mtImpact >= 0.15 && (lowRel > 0.20 || bodyRel > 0.26));
        var activePulse = mtImpact >= 0.24 || (mtSlot === 0 && mtImpact >= 0.18);
        var grooveEvidence = lowRiseRel * 0.52 + bodyRiseRel * 0.48 + lowRel * 0.20 + bodyRel * 0.18;
        if (softGrooveAnalysis) {
          activeCamera = mtImpact >= 0.19 || (mtSlot === 0 && mtImpact >= 0.135 && grooveEvidence >= 0.32);
          activePulse = mtImpact >= 0.23 || (mtSlot === 0 && mtImpact >= 0.165 && grooveEvidence >= 0.28);
        }
        var downbeatLift = activeCamera ? (mtSlot === 0 ? 0.14 : (mtSlot === 2 ? 0.06 : 0)) : 0;
        var mtStrength = 0.26 + powerRel * 0.23 + lowRel * 0.10 + bodyRel * 0.08 + snapRel * 0.04 + downbeatLift;
        if (m.nearest) mtStrength = Math.max(mtStrength, 0.42 + m.nearest.strength * 0.28);
        if (mtSlot === 0 && activeCamera) mtStrength = Math.max(mtStrength, 0.54 + mtImpact * 0.16);
        if (!activeCamera) mtStrength = Math.min(mtStrength, 0.36);
        if (softGrooveAnalysis) {
          mtStrength = 0.24 + powerRel * 0.18 + lowRel * 0.08 + bodyRel * 0.08 + lowRiseRel * 0.13 + bodyRiseRel * 0.12 + downbeatLift * 0.90;
          if (m.nearest) mtStrength = Math.max(mtStrength, 0.36 + m.nearest.strength * 0.22);
          if (mtSlot === 0 && activeCamera) mtStrength = Math.max(mtStrength, 0.50 + mtImpact * 0.15);
          if (mtSlot === 2 && activeCamera) mtStrength = Math.max(mtStrength, 0.43 + mtImpact * 0.10);
          if (!activeCamera) mtStrength = Math.min(mtStrength, 0.34);
          mtStrength = Math.max(0.28, Math.min(0.76, mtStrength));
        } else {
          mtStrength = Math.max(0.30, Math.min(0.82, mtStrength));
        }
        var lowForCamera = Math.max(0.22, Math.min(0.78, m.lowMix * 0.82 + lowRel * 0.18));
        tempoCameraBeats.push({
          time: m.time,
          strength: mtStrength,
          confidence: m.nearest ? Math.max(0.60, m.nearest.confidence || 0) : Math.max(0.52, 0.48 + powerRel * 0.28),
          primary: activeCamera,
          camera: activeCamera,
          pulse: activePulse,
          impact: mtImpact,
          tone: 'music-tempo',
          grooveEvidence: grooveEvidence,
          low: lowForCamera,
          body: m.bodyMix,
          snap: m.snapMix,
          mass: Math.max(0.35, Math.min(0.86, lowForCamera * 0.68 + m.bodyMix * 0.24 + mtStrength * 0.16)),
          sharpness: Math.max(0.08, Math.min(0.65, m.snapMix * 1.18)),
          combo: mtSlot === 0 ? 'downbeat' : (mtSlot === 1 ? 'push' : (mtSlot === 2 ? 'drop' : 'rebound')),
          index: m.index
        });
      }
      if (tempoCameraBeats.length >= 4) {
        if (analysisProfile.sparseCamera) {
          tempoCameraBeats = thinSoftGrooveCameraBeats(tempoCameraBeats, musicTempoGridStep || gridStep, buffer.duration);
        }
        cameraBeats = tempoCameraBeats;
        gridStep = musicTempoGridStep || gridStep;
      }
    }

    var kicks = beats.map(function(b){ return b.time; });
    var visualBeatCount = 0;
    var pulseBeats = cameraBeats.filter(function(b){
      if (typeof b === 'number') {
        visualBeatCount++;
        return true;
      }
      var active = b.primary !== false && b.camera !== false && b.pulse !== false;
      if (active) visualBeatCount++;
      return active && (b.strength >= 0.38 || (b.impact || 0) >= 0.20);
    }).map(function(b){
      if (typeof b === 'number') return { time: b, strength: 0.42, impact: 0.42 };
      return {
        time: b.time,
        strength: b.strength,
        impact: b.impact == null ? b.strength : b.impact,
        combo: b.combo,
        low: b.low,
        body: b.body,
        snap: b.snap
      };
    });
    await yieldToPaint();
    if (token !== beatMapToken) { hideBeatChip(); return null; }
    if (options.prefetch) hideBeatChip();
    else showBeatChip('节奏缓冲中…');
    return { kicks: kicks, beats: beats, pulseBeats: pulseBeats, cameraBeats: cameraBeats, gridStep: gridStep, tempoSource: musicTempoBeats.length >= 4 ? 'music-tempo' : 'local', analysisProfile: analysisProfile.id || 'default', duration: buffer.duration, visualBeatCount: visualBeatCount, analyzedAt: Date.now() };
  } catch (e) {
    console.warn('beat analysis failed:', e);
    hideBeatChip();
    return null;
  } finally {
    beatMapBusy = false;
    cancelBeatAnalysisWatchdog();
  }
}

function schedulePodcastDjAnalysis(songKey, audioUrl, token, durationSec) {
  cancelDjBeatAnalysisTimer();
  if (!songKey || !audioUrl) return;
  djBeatAnalysisTimer = setTimeout(function waitForDjStart(){
    djBeatAnalysisTimer = null;
    if (token !== djBeatMapToken || !djMode.active || djMode.songKey !== songKey || djBeatMapCache[songKey]) return;
    var startAnalysis = function(){
      if (token !== djBeatMapToken || !djMode.active || djMode.songKey !== songKey || djBeatMapCache[songKey]) return;
      if (djBeatMapBusy) {
        djBeatAnalysisTimer = setTimeout(waitForDjStart, 900);
        return;
      }
      if (/^https?:\/\//i.test(audioUrl || '') && (durationSec <= 0 || durationSec > 3300)) {
        analyzePodcastDjIntroBeats(audioUrl, token, durationSec).then(function(map){
          if (token !== djBeatMapToken || !map) return;
          smoothPodcastDjIntroHandoff(songKey, map, token);
        }).catch(function(err){
          console.warn('podcast DJ intro beat analysis failed:', err);
        });
      }
      analyzePodcastDjBeats(audioUrl, token, durationSec).then(function(map){
        if (token !== djBeatMapToken || !map) return;
        smoothPodcastDjMapHandoff(songKey, map, token);
      }).catch(function(err){
        console.warn('podcast DJ beat analysis failed:', err);
        hideBeatChip();
      });
    };
    scheduleAnalysisTask(startAnalysis, 900);
  }, 900);
}

async function analyzePodcastDjIntroBeats(audioUrl, token, durationSec) {
  if (!/^https?:\/\//i.test(audioUrl || '')) return null;
  if (token !== djBeatMapToken || !djMode.active) return null;
  var introResp = await fetch('/api/podcast/dj-beatmap?url=' + encodeURIComponent(audioUrl) + '&duration=' + encodeURIComponent(durationSec || 0) + '&intro=180');
  if (token !== djBeatMapToken || !djMode.active) return null;
  var introData = await introResp.json().catch(function(){ return null; });
  if (introResp.ok && introData && introData.ok && introData.map && introData.map.cameraBeats && introData.map.cameraBeats.length >= 4) {
    return introData.map;
  }
  return null;
}

async function buildPodcastDjLowOnlyBeatMap(buffer, token) {
  if (!buffer) return null;
  var sr = buffer.sampleRate || 44100;
  var duration = buffer.duration || (buffer.length / sr) || 0;
  var hopSec = duration > 4200 ? 0.0125 : 0.010;
  var hopSize = Math.max(256, Math.floor(sr * hopSec));
  var nFrames = Math.max(1, Math.floor(buffer.length / hopSize));
  var lowEnergy = new Float32Array(nFrames);
  var hitEnergy = new Float32Array(nFrames);
  var channels = Math.max(1, buffer.numberOfChannels || 1);
  var ch0 = buffer.getChannelData(0);
  var ch1 = channels > 1 ? buffer.getChannelData(1) : null;
  var chList = null;
  if (channels > 2) {
    chList = [];
    for (var ch = 0; ch < channels; ch++) chList.push(buffer.getChannelData(ch));
  }
  function makeBiquad(type, freq, q) {
    freq = Math.max(8, Math.min(freq, sr * 0.45));
    var w0 = 2 * Math.PI * freq / sr;
    var cos = Math.cos(w0);
    var sin = Math.sin(w0);
    var alpha = sin / (2 * (q || 0.707));
    var b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      b0 = (1 + cos) * 0.5;
      b1 = -(1 + cos);
      b2 = (1 + cos) * 0.5;
    } else {
      b0 = (1 - cos) * 0.5;
      b1 = 1 - cos;
      b2 = (1 - cos) * 0.5;
    }
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
    var inv = 1 / a0;
    return { b0:b0 * inv, b1:b1 * inv, b2:b2 * inv, a1:a1 * inv, a2:a2 * inv, x1:0, x2:0, y1:0, y2:0 };
  }
  function runBiquad(st, x) {
    var y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
    return y;
  }
  var hp = makeBiquad('highpass', 32, 0.72);
  var lp = makeBiquad('lowpass', 178, 0.82);
  showBeatChip('DJ kick scan 0%');
  for (var f = 0; f < nFrames; f++) {
    var start = f * hopSize;
    var end = Math.min(buffer.length, start + hopSize);
    var sum = 0;
    var peak = 0;
    for (var i = start; i < end; i++) {
      var x;
      if (chList) {
        x = 0;
        for (var ci = 0; ci < channels; ci++) x += chList[ci][i];
        x /= channels;
      } else if (ch1) {
        x = (ch0[i] + ch1[i]) * 0.5;
      } else {
        x = ch0[i];
      }
      var y = runBiquad(lp, runBiquad(hp, x || 0));
      var ay = Math.abs(y);
      sum += y * y;
      if (ay > peak) peak = ay;
    }
    var count = Math.max(1, end - start);
    lowEnergy[f] = Math.sqrt(sum / count);
    hitEnergy[f] = peak;
    if (f > 0 && f % 720 === 0) {
      if (f % 4320 === 0) showBeatChip('DJ kick scan ' + Math.min(99, Math.round(f / nFrames * 100)) + '%');
      await yieldToPaint();
      if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    }
  }
  if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }

  function percentile(arr, p, maxSamples) {
    var len = arr ? arr.length : 0;
    if (!len) return 0.001;
    maxSamples = maxSamples || 14000;
    var sample;
    if (len <= maxSamples) {
      sample = Array.prototype.slice.call(arr);
    } else {
      sample = new Array(maxSamples);
      var step = (len - 1) / (maxSamples - 1);
      for (var si = 0; si < maxSamples; si++) sample[si] = arr[Math.min(len - 1, Math.floor(si * step))] || 0;
    }
    sample.sort(function(a,b){ return a - b; });
    return sample[Math.max(0, Math.min(sample.length - 1, Math.floor(sample.length * p)))] || 0.001;
  }
  function bandAt(arr, idx) {
    idx = Math.max(0, Math.min(nFrames - 1, idx | 0));
    var a = arr[Math.max(0, idx - 1)] || 0;
    var b = arr[idx] || 0;
    var c = arr[Math.min(nFrames - 1, idx + 1)] || 0;
    return (a + b * 2 + c) * 0.25;
  }
  function median(vals) {
    vals = vals.filter(function(v){ return isFinite(v); }).sort(function(a,b){ return a - b; });
    return vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
  }
  var lowFloor = Math.max(0.0004, percentile(lowEnergy, 0.22));
  var lowMid = Math.max(lowFloor + 0.0002, percentile(lowEnergy, 0.58));
  var lowRef = Math.max(lowMid + 0.0002, percentile(lowEnergy, 0.86));
  var lowCeil = Math.max(lowRef + 0.0004, percentile(lowEnergy, 0.96));
  var hitRef = Math.max(0.0004, percentile(hitEnergy, 0.86));

  showBeatChip('DJ locking kick grid...');
  var onset = new Float32Array(nFrames);
  for (var oi = 4; oi < nFrames; oi++) {
    var prev = lowEnergy[oi - 1] * 0.62 + lowEnergy[oi - 2] * 0.28 + lowEnergy[oi - 3] * 0.10;
    var lowRise = Math.max(0, lowEnergy[oi] - prev);
    var wideRise = Math.max(0, (lowEnergy[oi] + lowEnergy[oi - 1]) * 0.5 - (lowEnergy[oi - 3] + lowEnergy[oi - 4]) * 0.5);
    var peakRise = Math.max(0, hitEnergy[oi] - hitEnergy[oi - 2] * 0.84);
    onset[oi] = lowRise * 1.72 + wideRise * 0.86 + peakRise * 0.10;
  }

  var winN = Math.max(52, Math.round(0.82 / hopSec));
  var minFrameGap = Math.max(18, Math.round(0.215 / hopSec));
  var candidates = [];
  var sumO = 0, sqO = 0;
  for (var wi = 0; wi < winN; wi++) { var ow = onset[wi] || 0; sumO += ow; sqO += ow * ow; }
  for (var cf = winN + 4; cf < nFrames - 4; cf++) {
    var mean = sumO / winN;
    var std = Math.sqrt(Math.max(0, sqO / winN - mean * mean));
    var th = mean + std * 1.66 + lowRef * 0.0038;
    var o = onset[cf];
    if (o > th && o >= onset[cf - 1] && o > onset[cf + 1]) {
      var peakF = cf;
      var peakScore = o + lowEnergy[cf] * 0.10;
      for (var pf = cf - 2; pf <= cf + 3; pf++) {
        var ps = (onset[pf] || 0) + (lowEnergy[pf] || 0) * 0.10;
        if (ps > peakScore) { peakScore = ps; peakF = pf; }
      }
      var lowTone = Math.min(2.6, bandAt(lowEnergy, peakF) / lowRef);
      var hitTone = Math.min(2.6, bandAt(hitEnergy, peakF) / hitRef);
      var lowRel = clamp01((bandAt(lowEnergy, peakF) - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
      var score = (o - th) / Math.max(0.0006, std + mean * 0.38 + lowRef * 0.012);
      if (score > 0.16 && (lowTone > 0.32 || lowRel > 0.22 || hitTone > 0.52)) {
        var cand = {
          frame: peakF,
          time: peakF * hopSec,
          score: score,
          lowTone: lowTone,
          hitTone: hitTone,
          lowRel: lowRel,
          raw: o
        };
        cand.power = cand.score * 0.56 + Math.pow(clamp01((cand.lowTone - 0.22) / 1.42), 0.82) * 0.34 + Math.min(1.5, cand.hitTone) * 0.08 + cand.lowRel * 0.10;
        var last = candidates[candidates.length - 1];
        if (last && cand.frame - last.frame < minFrameGap) {
          if (cand.power > last.power) candidates[candidates.length - 1] = cand;
        } else {
          candidates.push(cand);
        }
      }
    }
    var old = onset[cf - winN] || 0;
    var next = onset[cf] || 0;
    sumO += next - old;
    sqO += next * next - old * old;
    if (cf > winN && cf % 3600 === 0) {
      await yieldToPaint();
      if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    }
  }
  if (!candidates.length) {
    return { kicks: [], beats: [], pulseBeats: [], cameraBeats: [], duration: duration, visualBeatCount: 0, tempoSource: 'podcast-dj-low-empty', analyzedAt: Date.now() };
  }

  var powers = candidates.map(function(c){ return c.power; });
  var p30 = percentile(powers, 0.30);
  var p50 = percentile(powers, 0.50);
  var p90 = Math.max(p50 + 0.001, percentile(powers, 0.90));
  var p96 = Math.max(p90 + 0.001, percentile(powers, 0.965));
  var strong = candidates.filter(function(c){ return c.power >= p50 && c.lowTone > 0.34; });
  if (strong.length < 16) strong = candidates.slice();
  function estimateStep(list) {
    if (!list || list.length < 3) return 0;
    var bin = 0.006;
    var hist = {};
    var medGaps = [];
    var minStep = 0.31;
    var maxStep = 0.86;
    for (var ai = 0; ai < list.length; ai++) {
      for (var bi = ai + 1; bi < list.length && bi < ai + 10; bi++) {
        var rawGap = list[bi].time - list[ai].time;
        if (rawGap < 0.24) continue;
        if (rawGap > 2.55) break;
        for (var div = 1; div <= 6; div++) {
          var g = rawGap / div;
          if (g < minStep) break;
          if (g > maxStep) continue;
          var weight = Math.sqrt(Math.max(0.001, list[ai].power * list[bi].power)) / Math.sqrt((bi - ai) * div);
          var key = Math.round(g / bin);
          hist[key] = (hist[key] || 0) + weight;
          medGaps.push(g);
        }
      }
    }
    var bestKey = null, bestScore = 0;
    Object.keys(hist).forEach(function(k){
      var key = parseInt(k, 10);
      var score = (hist[key] || 0) + (hist[key - 1] || 0) * 0.72 + (hist[key + 1] || 0) * 0.72;
      if (score > bestScore) { bestScore = score; bestKey = key; }
    });
    if (bestKey != null) return bestKey * bin;
    return median(medGaps);
  }
  var globalStep = estimateStep(strong) || estimateStep(candidates) || 0.50;
  globalStep = clampRange(globalStep, 0.32, 0.86);

  function nearestCandidate(center, windowSec, startIdx) {
    var best = null;
    var bestScore = -Infinity;
    var j = startIdx || 0;
    while (j < candidates.length && candidates[j].time < center - windowSec) j++;
    for (var ni = j; ni < candidates.length && candidates[ni].time <= center + windowSec; ni++) {
      var dist = Math.abs(candidates[ni].time - center);
      var score = candidates[ni].power * (1 - dist / Math.max(0.001, windowSec) * 0.42);
      if (score > bestScore) { best = candidates[ni]; bestScore = score; }
    }
    return best;
  }
  function scorePhase(anchorTime, step) {
    var start = anchorTime;
    while (start - step > 0.05) start -= step;
    var end = Math.min(duration, 180);
    var win = Math.max(0.055, Math.min(0.125, step * 0.18));
    var score = 0, count = 0, cursor = 0;
    for (var gt = start; gt < end; gt += step) {
      while (cursor < candidates.length && candidates[cursor].time < gt - win) cursor++;
      var best = null, bestScore = 0;
      for (var pi = cursor; pi < candidates.length && candidates[pi].time <= gt + win; pi++) {
        var dist = Math.abs(candidates[pi].time - gt);
        var s = candidates[pi].power * (1 - dist / win * 0.44);
        if (s > bestScore) { bestScore = s; best = candidates[pi]; }
      }
      score += best ? bestScore : -p30 * 0.08;
      count++;
    }
    return count ? score / count : -Infinity;
  }
  var phaseSource = strong.filter(function(c){ return c.time < Math.min(duration, 180); }).slice(0, 72);
  if (!phaseSource.length) phaseSource = strong.slice(0, 1);
  var bestAnchor = phaseSource[0] ? phaseSource[0].time : 0;
  var bestAnchorScore = -Infinity;
  for (var pa = 0; pa < phaseSource.length; pa++) {
    var sc = scorePhase(phaseSource[pa].time, globalStep);
    if (sc > bestAnchorScore) { bestAnchorScore = sc; bestAnchor = phaseSource[pa].time; }
  }
  var halfStep = globalStep * 0.5;
  if (halfStep >= 0.31) {
    var halfScore = scorePhase(bestAnchor, halfStep);
    if (halfScore > bestAnchorScore * 1.04) globalStep = halfStep;
  }
  var anchor = bestAnchor;
  while (anchor - globalStep > 0.05) anchor -= globalStep;

  var sectionLen = duration > 3600 ? 96 : 72;
  var sectionCount = Math.max(1, Math.ceil(duration / sectionLen));
  var sectionSteps = [];
  for (var secIdx = 0; secIdx < sectionCount; secIdx++) {
    var t0 = secIdx * sectionLen, t1 = Math.min(duration, t0 + sectionLen);
    var seg = strong.filter(function(c){ return c.time >= t0 && c.time < t1; });
    var prevStep = sectionSteps.length ? sectionSteps[sectionSteps.length - 1] : globalStep;
    var localStep = estimateStep(seg) || prevStep || globalStep;
    if (prevStep) localStep = clampRange(localStep, prevStep * 0.94, prevStep * 1.06);
    if (globalStep) localStep = clampRange(localStep, globalStep * 0.86, globalStep * 1.14);
    var blended = prevStep ? (localStep * 0.30 + prevStep * 0.70) : localStep;
    sectionSteps.push(blended || globalStep);
  }
  function stepAt(time) {
    var idx = Math.max(0, Math.min(sectionSteps.length - 1, Math.floor(time / sectionLen)));
    return sectionSteps[idx] || globalStep || 0.50;
  }

  var beats = [];
  var gridIndex = 0;
  var cursorIdx = 0;
  for (var gridT = anchor; gridT < duration - 0.04; ) {
    var localStep2 = stepAt(gridT) || globalStep || 0.50;
    var winSec = Math.max(0.060, Math.min(0.135, localStep2 * 0.20));
    while (cursorIdx < candidates.length && candidates[cursorIdx].time < gridT - winSec) cursorIdx++;
    var bestCand = nearestCandidate(gridT, winSec, cursorIdx);
    var gf = Math.max(0, Math.min(nFrames - 1, Math.round(gridT / hopSec)));
    var gridLow = bandAt(lowEnergy, gf);
    var gridHit = bandAt(hitEnergy, gf);
    var gridLowTone = Math.min(2.6, gridLow / lowRef);
    var gridHitTone = Math.min(2.6, gridHit / hitRef);
    var lowTone2 = bestCand ? Math.max(gridLowTone * 0.62, bestCand.lowTone) : gridLowTone;
    var hitTone2 = bestCand ? Math.max(gridHitTone * 0.62, bestCand.hitTone) : gridHitTone;
    var distPenalty = bestCand ? (1 - Math.min(1, Math.abs(bestCand.time - gridT) / winSec) * 0.26) : 0.54;
    var basePower = bestCand ? bestCand.power * distPenalty : (gridLowTone * 0.25 + gridHitTone * 0.06);
    var powerRel = clamp01((basePower - p30 * 0.78) / Math.max(0.001, p96 - p30 * 0.78));
    var lowRel2 = clamp01((gridLow - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
    var kickRel = clamp01(powerRel * 0.74 + lowRel2 * 0.22 + clamp01((hitTone2 - 0.26) / 1.70) * 0.04);
    var softGrid = (!bestCand && lowRel2 < 0.20) || kickRel < 0.16;
    var slot = gridIndex % 4;
    var combo = slot === 0 ? 'downbeat' : (slot === 1 ? 'push' : (slot === 2 ? 'drop' : 'rebound'));
    if (kickRel > 0.84 && combo !== 'downbeat') combo = 'accent';
    var visualRel = kickRel > 0.76 ? 0.76 + (kickRel - 0.76) * 0.52 : kickRel;
    var downLift = combo === 'downbeat' ? (visualRel > 0.18 ? (0.016 + visualRel * 0.036) : visualRel * 0.028) : 0;
    var sectionGate = clamp01((kickRel - 0.10) / 0.58);
    var impact = Math.max(0.020, Math.min(0.88, 0.022 + Math.pow(visualRel, 1.62) * 0.86 + downLift));
    var strength = Math.max(0.12, Math.min(0.93, 0.13 + Math.pow(visualRel, 1.12) * 0.68 + downLift * 0.70));
    if (softGrid) {
      var softMul = combo === 'downbeat' ? 0.48 : 0.30;
      impact *= softMul;
      strength *= 0.58 + sectionGate * 0.22;
    }
    var timingPull = bestCand ? (0.24 + clamp01((kickRel - 0.25) / 0.65) * 0.46) : 0;
    var sourceTime = bestCand ? (gridT * (1 - timingPull) + bestCand.time * timingPull) : gridT;
    var cameraActive = impact >= 0.13 || (combo === 'downbeat' && kickRel >= 0.14) || (bestCand && kickRel >= 0.18);
    var lowMix = Math.max(0.42, Math.min(0.90, 0.52 + visualRel * 0.32 + lowTone2 * 0.035 - (combo === 'accent' ? 0.10 : 0)));
    var bodyMix = Math.max(0.035, Math.min(0.54, 0.060 + visualRel * 0.12 + (combo === 'push' ? 0.18 : 0) + (combo === 'drop' ? 0.24 : 0)));
    var snapMix = Math.max(0.015, Math.min(0.62, 0.026 + (combo === 'accent' ? 0.40 : 0) + (combo === 'rebound' ? 0.08 : 0) + visualRel * 0.038));
    beats.push({
      time: sourceTime,
      strength: strength,
      confidence: Math.max(0.44, Math.min(0.99, 0.46 + kickRel * 0.43 + (bestCand ? 0.08 : -0.03))),
      impact: impact,
      primary: cameraActive,
      camera: cameraActive,
      pulse: impact > 0.16 || (combo === 'downbeat' && kickRel >= 0.18),
      tone: 'podcast-dj-low-grid',
      low: lowMix,
      body: bodyMix,
      snap: snapMix,
      mass: Math.max(0.36, Math.min(0.94, lowMix * 0.72 + Math.pow(visualRel, 1.22) * 0.24)),
      sharpness: Math.max(0.03, Math.min(0.28, snapMix * 1.18)),
      combo: combo,
      step: localStep2,
      index: beats.length,
      dj: true,
      grid: true,
      kickOnly: true
    });
    gridIndex++;
    gridT += localStep2;
    if (gridIndex > 0 && gridIndex % 1800 === 0) {
      await yieldToPaint();
      if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    }
  }

  var cameraBeats = beats.filter(function(b){ return b.camera !== false; });
  var pulseBeats = beats.filter(function(b){ return b.pulse !== false && (b.impact >= 0.16 || b.combo === 'downbeat'); }).map(function(b){
    return { time: b.time, strength: b.strength, impact: b.impact, combo: b.combo, low: b.low, body: b.body, snap: b.snap, dj: true };
  });
  console.log('podcast DJ low-only beatmap:', Math.round(duration) + 's', 'step:', globalStep.toFixed(3), 'candidates:', candidates.length, 'beats:', beats.length);
  return {
    kicks: beats.map(function(b){ return b.time; }),
    beats: beats,
    pulseBeats: pulseBeats,
    cameraBeats: cameraBeats,
    gridStep: globalStep,
    sectionSteps: sectionSteps,
    tempoSource: 'podcast-dj-low-offline',
    duration: duration,
    visualBeatCount: cameraBeats.length,
    analyzedAt: Date.now()
  };
}

async function analyzePodcastDjBeats(audioUrl, token, durationSec) {
  try {
    djBeatMapBusy = true;
    showBeatChip('DJ 离线锁拍…');
    await yieldToIdle(520);
    if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    durationSec = Math.max(0, Number(durationSec) || 0);
    var preferServerAnalysis = /^https?:\/\//i.test(audioUrl || '') && (durationSec <= 0 || durationSec > 3300);
    if (preferServerAnalysis) {
      showBeatChip('DJ 长播客后端锁拍...');
      var serverResp = await fetch('/api/podcast/dj-beatmap?url=' + encodeURIComponent(audioUrl) + '&duration=' + encodeURIComponent(durationSec));
      if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
      var serverData = await serverResp.json().catch(function(){ return null; });
      if (serverResp.ok && serverData && serverData.ok && serverData.map) return serverData.map;
      console.warn('podcast DJ server analysis failed:', serverData && serverData.error);
      hideBeatChip();
      if (durationSec <= 0 || durationSec > 3300) return null;
    }
    var fetchAudioUrl = resolveBeatAnalysisAudioUrl(/^https?:\/\//i.test(audioUrl || '') ? audioUrl : '');
    if (!fetchAudioUrl && audioUrl) fetchAudioUrl = audioUrl;
    var ab = await fetchAnalysisAudioArrayBuffer(fetchAudioUrl, audioUrl);
    if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }

    showBeatChip('DJ 解码音频…');
    var TmpCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var DecodeCtx = window.AudioContext || window.webkitAudioContext;
    if (!DecodeCtx) { hideBeatChip(); return null; }
    var dc = new DecodeCtx();
    var buffer = await new Promise(function(resolve, reject){
      dc.decodeAudioData(ab, resolve, reject);
    }).catch(function(e){ console.warn('podcast DJ decode failed:', e); return null; });
    ab = null;
    dc.close && dc.close();
    if (!buffer || token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    return await buildPodcastDjLowOnlyBeatMap(buffer, token);

    var sr = buffer.sampleRate;
    async function renderDjBand(hpFreq, lpFreq, label) {
      showBeatChip('DJ 分离' + label + '…');
      var off = new TmpCtx(1, buffer.length, sr);
      var src = off.createBufferSource();
      src.buffer = buffer;
      var node = src;
      if (hpFreq) {
        var hp = off.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = Math.min(hpFreq, sr * 0.45);
        hp.Q.value = 0.78;
        node.connect(hp);
        node = hp;
      }
      if (lpFreq) {
        var lp = off.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.min(lpFreq, sr * 0.45);
        lp.Q.value = 0.86;
        node.connect(lp);
        node = lp;
      }
      node.connect(off.destination);
      src.start(0);
      var rendered = await off.startRendering();
      if (token !== djBeatMapToken || !djMode.active) return null;
      await yieldToIdle(280);
      return rendered.getChannelData(0);
    }

    var lowPcm = await renderDjBand(34, 170, '低频');
    if (!lowPcm) { hideBeatChip(); return null; }
    var bodyPcm = await renderDjBand(150, 560, '鼓身');
    if (!bodyPcm) { hideBeatChip(); return null; }
    var snapPcm = await renderDjBand(1700, 9200, '高频');
    if (!snapPcm) { hideBeatChip(); return null; }

    var hopSec = 0.012;
    var hopSize = Math.max(256, Math.floor(sr * hopSec));
    async function makeEnergy(pcm, label) {
      showBeatChip('DJ 读取' + label + '…');
      var frames = Math.floor(pcm.length / hopSize);
      var out = new Float32Array(frames);
      for (var f = 0; f < frames; f++) {
        var sum = 0;
        var off2 = f * hopSize;
        for (var i = 0; i < hopSize; i++) {
          var v = pcm[off2 + i] || 0;
          sum += v * v;
        }
        out[f] = Math.sqrt(sum / hopSize);
        if (f > 0 && f % 1800 === 0) {
          await yieldToPaint();
          if (token !== djBeatMapToken || !djMode.active) return null;
        }
      }
      return out;
    }

    var lowEnergy = await makeEnergy(lowPcm, '低频');
    var bodyEnergy = await makeEnergy(bodyPcm, '鼓身');
    var snapEnergy = await makeEnergy(snapPcm, '高频');
    if (!lowEnergy || !bodyEnergy || !snapEnergy || token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }

    var nFrames = Math.min(lowEnergy.length, bodyEnergy.length, snapEnergy.length);
    function percentile(arr, p) {
      var copy = Array.prototype.slice.call(arr).sort(function(a,b){ return a-b; });
      return copy.length ? copy[Math.max(0, Math.min(copy.length - 1, Math.floor(copy.length * p)))] : 0.001;
    }
    function bandAt(arr, f) {
      var a = arr[Math.max(0, f - 1)] || 0;
      var b = arr[f] || 0;
      var c = arr[Math.min(nFrames - 1, f + 1)] || 0;
      return (a + b * 2 + c) * 0.25;
    }
    function median(vals) {
      vals = vals.filter(function(v){ return isFinite(v); }).sort(function(a,b){ return a-b; });
      return vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
    }
    var lowRef = Math.max(0.0008, percentile(lowEnergy, 0.86));
    var bodyRef = Math.max(0.0008, percentile(bodyEnergy, 0.84));
    var snapRef = Math.max(0.0008, percentile(snapEnergy, 0.84));

    showBeatChip('DJ 计算主拍…');
    var onset = new Float32Array(nFrames);
    for (var oi = 2; oi < nFrames; oi++) {
      var lowRise = Math.max(0, lowEnergy[oi] - lowEnergy[oi - 1]);
      var lowWide = Math.max(0, lowEnergy[oi] - lowEnergy[oi - 2]);
      var bodyRise = Math.max(0, bodyEnergy[oi] - bodyEnergy[oi - 1]);
      var snapRise = Math.max(0, snapEnergy[oi] - snapEnergy[oi - 1]);
      onset[oi] = lowRise * 1.52 + lowWide * 0.58 + bodyRise * 0.16 + snapRise * 0.035;
    }

    var winN = Math.max(44, Math.round(0.78 / hopSec));
    var minFrameGap = Math.max(18, Math.round(0.215 / hopSec));
    var candidates = [];
    var lastFrame = -minFrameGap;
    var sum = 0, sq = 0;
    for (var wi = 0; wi < winN; wi++) { sum += onset[wi] || 0; sq += (onset[wi] || 0) * (onset[wi] || 0); }
    for (var f2 = winN + 1; f2 < nFrames - 2; f2++) {
      var mean = sum / winN;
      var std = Math.sqrt(Math.max(0, sq / winN - mean * mean));
      var th = mean + std * 1.90 + lowRef * 0.006;
      var o = onset[f2];
      if (o > th && o >= onset[f2 - 1] && o > onset[f2 + 1] && f2 - lastFrame >= minFrameGap) {
        var lowTone = Math.min(2.2, bandAt(lowEnergy, f2) / lowRef);
        var bodyTone = Math.min(2.2, bandAt(bodyEnergy, f2) / bodyRef);
        var snapTone = Math.min(2.2, bandAt(snapEnergy, f2) / snapRef);
        var lowDom = lowTone / Math.max(0.001, bodyTone * 0.46 + snapTone * 0.18);
        var score = (o - th) / Math.max(0.0008, std + mean * 0.42);
        var kickLike = lowTone > 0.42 && (lowDom > 0.92 || lowTone > 0.82);
        if (kickLike && score > 0.28) {
          candidates.push({
            frame: f2,
            time: f2 * hopSec,
            score: score,
            lowTone: lowTone,
            bodyTone: bodyTone,
            snapTone: snapTone,
            lowDom: lowDom,
            raw: o
          });
          lastFrame = f2;
        }
      }
      var old = onset[f2 - winN] || 0;
      var next = onset[f2] || 0;
      sum += next - old;
      sq += next * next - old * old;
      if (f2 > winN && f2 % 2200 === 0) {
        await yieldToPaint();
        if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
      }
    }

    if (!candidates.length) {
      hideBeatChip();
      return { kicks: [], beats: [], pulseBeats: [], cameraBeats: [], duration: buffer.duration, visualBeatCount: 0, tempoSource: 'podcast-dj-empty', analyzedAt: Date.now() };
    }

    var strong = candidates.filter(function(c){ return c.score > 0.52 && c.lowTone > 0.52; });
    if (strong.length < 8) strong = candidates.slice();
    var allGaps = [];
    for (var gi = 1; gi < strong.length; gi++) {
      var g = strong[gi].time - strong[gi - 1].time;
      while (g > 0.94) g *= 0.5;
      while (g < 0.30) g *= 2.0;
      if (g >= 0.30 && g <= 0.94) allGaps.push(g);
    }
    var globalStep = median(allGaps) || 0.50;
    var sectionLen = 48;
    var sectionCount = Math.max(1, Math.ceil(buffer.duration / sectionLen));
    var sectionSteps = [];
    for (var si = 0; si < sectionCount; si++) {
      var t0 = si * sectionLen, t1 = t0 + sectionLen;
      var seg = strong.filter(function(c){ return c.time >= t0 && c.time < t1; });
      var gaps = [];
      for (var sg = 1; sg < seg.length; sg++) {
        var gap = seg[sg].time - seg[sg - 1].time;
        while (gap > 0.94) gap *= 0.5;
        while (gap < 0.30) gap *= 2.0;
        if (gap >= 0.30 && gap <= 0.94) gaps.push(gap);
      }
      var prevSectionStep = sectionSteps.length ? sectionSteps[sectionSteps.length - 1] : globalStep;
      var step = median(gaps) || prevSectionStep || globalStep;
      if (globalStep) step = clampRange(step, globalStep * 0.90, globalStep * 1.10);
      if (prevSectionStep && Math.abs(step - prevSectionStep) / prevSectionStep > 0.08) {
        step = step * 0.28 + prevSectionStep * 0.72;
      } else if (prevSectionStep) {
        step = step * 0.42 + prevSectionStep * 0.58;
      }
      sectionSteps.push(step || globalStep);
    }
    function stepAt(time) {
      var idx = Math.max(0, Math.min(sectionSteps.length - 1, Math.floor(time / sectionLen)));
      return sectionSteps[idx] || globalStep || 0.50;
    }

    var powers = candidates.map(function(c){
      c.power = c.score * 0.50 + c.lowTone * 0.26 + Math.min(1.8, c.lowDom) * 0.16 + c.bodyTone * 0.06 + c.snapTone * 0.02;
      return c.power;
    });
    var p35 = percentile(powers, 0.35);
    var p50 = percentile(powers, 0.50);
    var p90 = Math.max(p50 + 0.001, percentile(powers, 0.90));
    var phaseSource = strong.length ? strong : candidates;
    var phaseCandidates = phaseSource.filter(function(c){ return c.time < Math.min(buffer.duration, 120); }).slice(0, 56);
    if (!phaseCandidates.length) phaseCandidates = phaseSource.slice(0, 1);
    function nearestCandidate(center, windowSec, startIdx) {
      var best = null;
      var bestScore = -Infinity;
      var j = startIdx || 0;
      while (j < candidates.length && candidates[j].time < center - windowSec) j++;
      for (var ni = j; ni < candidates.length && candidates[ni].time <= center + windowSec; ni++) {
        var dist = Math.abs(candidates[ni].time - center);
        var score = candidates[ni].power * (1 - dist / Math.max(0.001, windowSec) * 0.48);
        if (score > bestScore) {
          best = candidates[ni];
          bestScore = score;
        }
      }
      return best;
    }
    function scorePhase(anchorTime) {
      var step = globalStep || 0.50;
      var start = anchorTime;
      while (start - step > 0.05) start -= step;
      var end = Math.min(buffer.duration, 132);
      var win = Math.max(0.060, Math.min(0.130, step * 0.18));
      var score = 0, count = 0, cursor = 0;
      for (var gt = start; gt < end; gt += step) {
        while (cursor < candidates.length && candidates[cursor].time < gt - win) cursor++;
        var best = null, bestScore = 0;
        for (var pi = cursor; pi < candidates.length && candidates[pi].time <= gt + win; pi++) {
          var dist = Math.abs(candidates[pi].time - gt);
          var s = candidates[pi].power * (1 - dist / win * 0.45);
          if (s > bestScore) { bestScore = s; best = candidates[pi]; }
        }
        if (best) score += bestScore;
        else score -= p35 * 0.10;
        count++;
      }
      return count ? score / count : -Infinity;
    }
    var bestAnchor = phaseCandidates[0] ? phaseCandidates[0].time : 0;
    var bestAnchorScore = -Infinity;
    for (var pa = 0; pa < phaseCandidates.length; pa++) {
      var sc = scorePhase(phaseCandidates[pa].time);
      if (sc > bestAnchorScore) {
        bestAnchorScore = sc;
        bestAnchor = phaseCandidates[pa].time;
      }
    }
    var anchor = bestAnchor;
    while (anchor - (globalStep || 0.50) > 0.05) anchor -= (globalStep || 0.50);

    var beats = [];
    var gridIndex = 0;
    var cursorIdx = 0;
    for (var gridT = anchor; gridT < buffer.duration - 0.05; ) {
      var localStep = stepAt(gridT) || globalStep || 0.50;
      var winSec = Math.max(0.070, Math.min(0.145, localStep * 0.22));
      while (cursorIdx < candidates.length && candidates[cursorIdx].time < gridT - winSec) cursorIdx++;
      var bestCand = nearestCandidate(gridT, winSec, cursorIdx);
      var gf = Math.max(0, Math.min(nFrames - 1, Math.round(gridT / hopSec)));
      var gridLowTone = Math.min(2.2, bandAt(lowEnergy, gf) / lowRef);
      var gridBodyTone = Math.min(2.2, bandAt(bodyEnergy, gf) / bodyRef);
      var gridSnapTone = Math.min(2.2, bandAt(snapEnergy, gf) / snapRef);
      var sourceTime = bestCand ? (gridT * 0.38 + bestCand.time * 0.62) : gridT;
      var powerBase = bestCand ? bestCand.power : (gridLowTone * 0.22 + gridBodyTone * 0.04 + gridSnapTone * 0.02);
      var distPenalty = bestCand ? (1 - Math.min(1, Math.abs(bestCand.time - gridT) / winSec) * 0.30) : 0.58;
      var powerRel = clamp01(((powerBase * distPenalty) - p35 * 0.78) / Math.max(0.001, p90 - p35 * 0.78));
      var lowTone2 = bestCand ? Math.max(gridLowTone * 0.55, bestCand.lowTone) : gridLowTone;
      var bodyTone2 = bestCand ? Math.max(gridBodyTone * 0.50, bestCand.bodyTone) : gridBodyTone;
      var snapTone2 = bestCand ? Math.max(gridSnapTone * 0.50, bestCand.snapTone) : gridSnapTone;
      var toneTotal = Math.max(0.001, lowTone2 + bodyTone2 * 0.72 + snapTone2 * 0.48);
      var lowMix = lowTone2 / toneTotal;
      var bodyMix = (bodyTone2 * 0.72) / toneTotal;
      var snapMix = (snapTone2 * 0.48) / toneTotal;
      var comboSlot = gridIndex % 4;
      var combo = comboSlot === 0 ? 'downbeat' : (comboSlot === 1 ? 'push' : (comboSlot === 2 ? 'drop' : 'rebound'));
      if (powerRel > 0.86 && combo !== 'downbeat') combo = 'accent';
      var weakGrid = !bestCand && gridLowTone < 0.50 && powerRel < 0.24;
      if (!weakGrid || comboSlot === 0 || powerRel > 0.18) {
        var downLift = combo === 'downbeat' ? 0.06 : 0;
        var strength = Math.max(0.18, Math.min(0.94, 0.20 + Math.pow(powerRel, 1.22) * 0.54 + lowMix * 0.08 + downLift));
        var impact = Math.max(0.10, Math.min(0.96, Math.pow(powerRel, 1.36) * 0.82 + lowMix * 0.12 + downLift));
        beats.push({
          time: sourceTime,
          strength: strength,
          confidence: Math.max(0.46, Math.min(0.98, 0.50 + powerRel * 0.38 + lowMix * 0.10 - (bestCand ? 0 : 0.10))),
          impact: impact,
          primary: true,
          camera: true,
          pulse: impact > 0.18 || combo === 'downbeat',
          tone: 'podcast-dj-grid',
          low: Math.max(0.24, Math.min(0.90, lowMix * 0.78 + powerRel * 0.18)),
          body: Math.max(0.03, Math.min(0.60, bodyMix)),
          snap: Math.max(0.02, Math.min(0.50, snapMix)),
          mass: Math.max(0.28, Math.min(0.96, lowMix * 0.74 + Math.pow(powerRel, 1.25) * 0.24)),
          sharpness: Math.max(0.03, Math.min(0.62, snapMix * 1.10)),
          combo: combo,
          step: localStep,
          index: beats.length,
          dj: true,
          grid: true
        });
      }
      gridIndex++;
      gridT += localStep;
      if (gridIndex > 0 && gridIndex % 1800 === 0) {
        await yieldToPaint();
        if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
      }
    }

    var pulseBeats = beats.filter(function(b){ return b.strength >= 0.38 || b.combo === 'downbeat'; }).map(function(b){
      return { time: b.time, strength: b.strength, impact: b.impact, combo: b.combo, low: b.low, body: b.body, snap: b.snap, dj: true };
    });
    await yieldToPaint();
    if (token !== djBeatMapToken || !djMode.active) { hideBeatChip(); return null; }
    return {
      kicks: beats.map(function(b){ return b.time; }),
      beats: beats,
      pulseBeats: pulseBeats,
      cameraBeats: beats,
      gridStep: globalStep,
      sectionSteps: sectionSteps,
      tempoSource: 'podcast-dj-offline',
      duration: buffer.duration,
      visualBeatCount: beats.length,
      analyzedAt: Date.now()
    };
  } catch (err) {
    console.warn('podcast DJ analysis failed:', err);
    hideBeatChip();
    return null;
  } finally {
    djBeatMapBusy = false;
  }
}

function applyPodcastDjProfileFromMap(map) {
  if (!map || !djMode.active) return;
  var density = (map.cameraBeats || []).length / Math.max(20, map.duration || 20);
  cinemaTrackProfile.density = density;
  var target = 0.82 + clamp01((density - 1.25) / 1.8) * 0.16;
  target = clampRange(target, 0.76, 1.10);
  cinemaTrackProfile.target = target;
  cinemaTrackProfile.scale += (target - cinemaTrackProfile.scale) * 0.34;
}

function smoothPodcastDjMapHandoff(songKey, map, token) {
  if (!map) return;
  showBeatChip('DJ 锁拍完成…');
  var apply = function() {
    if (token !== djBeatMapToken || !djMode.active || djMode.songKey !== songKey) return;
    djBeatMapCache[songKey] = map;
    currentDjBeatMap = map;
    applyPodcastDjProfileFromMap(map);
    syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
    notifyDesktopLyricsBeatMapReady();
    hideBeatChip();
    showToast('DJ 离线锁拍完成: ' + (map.visualBeatCount || 0) + ' 个主拍');
  };
  scheduleVisualApply(apply, 260, 360);
}

function smoothPodcastDjIntroHandoff(songKey, map, token) {
  if (!map || !map.partial) return;
  if (currentDjBeatMap && !currentDjBeatMap.partial) return;
  var apply = function() {
    if (token !== djBeatMapToken || !djMode.active || djMode.songKey !== songKey) return;
    if (currentDjBeatMap && !currentDjBeatMap.partial) return;
    currentDjBeatMap = map;
    applyPodcastDjProfileFromMap(map);
    syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
    notifyDesktopLyricsBeatMapReady();
    showBeatChip('DJ 开头已锁拍，全曲继续分析…');
  };
  scheduleVisualApply(apply, 0, 240);
}

function showBeatChip(text) {
  if (presetSkipsBeatAnalysisUi()) return;
  document.getElementById('beat-text').textContent = text || '分析节奏…';
  document.getElementById('beat-chip').classList.add('show');
  if (localBeatAnalysis && localBeatAnalysis.active) setLocalBeatStatus(text || '分析中...', 'warn');
}
function hideBeatChip() {
  document.getElementById('beat-chip').classList.remove('show');
}

function localBeatRound(v, scale) {
  v = Number(v);
  if (!isFinite(v)) return 0;
  scale = scale || 1000;
  return Math.round(v * scale) / scale;
}
function packLocalBeatEvent(ev) {
  if (typeof ev === 'number') return [localBeatRound(ev, 1000), 0.42, 0.72, 0.42, 0.62, 0.22, 0.16, 0, 7, 0.62, 0.12, 0];
  ev = ev || {};
  var comboIdx = Math.max(0, LOCAL_BEAT_COMBOS.indexOf(ev.combo || ''));
  var flags = 0;
  if (ev.primary !== false) flags |= 1;
  if (ev.camera !== false) flags |= 2;
  if (ev.pulse !== false) flags |= 4;
  if (ev.dj) flags |= 8;
  if (ev.grid) flags |= 16;
  if (ev.kickOnly) flags |= 32;
  return [
    localBeatRound(ev.time, 1000),
    localBeatRound(ev.strength == null ? 0.42 : ev.strength, 1000),
    localBeatRound(ev.confidence == null ? 0.72 : ev.confidence, 1000),
    localBeatRound(ev.impact == null ? (ev.strength == null ? 0.42 : ev.strength) : ev.impact, 1000),
    localBeatRound(ev.low == null ? 0.62 : ev.low, 1000),
    localBeatRound(ev.body == null ? 0.22 : ev.body, 1000),
    localBeatRound(ev.snap == null ? 0.16 : ev.snap, 1000),
    comboIdx,
    flags,
    localBeatRound(ev.mass == null ? 0.62 : ev.mass, 1000),
    localBeatRound(ev.sharpness == null ? 0.12 : ev.sharpness, 1000),
    localBeatRound(ev.step || 0, 1000)
  ];
}
function unpackLocalBeatEvent(row) {
  if (typeof row === 'number') return row;
  if (!Array.isArray(row)) return row;
  var flags = row[8] || 0;
  return {
    time: row[0] || 0,
    strength: row[1] == null ? 0.42 : row[1],
    confidence: row[2] == null ? 0.72 : row[2],
    impact: row[3] == null ? (row[1] || 0.42) : row[3],
    low: row[4] == null ? 0.62 : row[4],
    body: row[5] == null ? 0.22 : row[5],
    snap: row[6] == null ? 0.16 : row[6],
    combo: LOCAL_BEAT_COMBOS[row[7] || 0] || undefined,
    primary: !!(flags & 1),
    camera: !!(flags & 2),
    pulse: !!(flags & 4),
    dj: !!(flags & 8),
    grid: !!(flags & 16),
    kickOnly: !!(flags & 32),
    mass: row[9] == null ? 0.62 : row[9],
    sharpness: row[10] == null ? 0.12 : row[10],
    step: row[11] || 0
  };
}
function packLocalBeatMap(map) {
  if (!map) return null;
  var camera = (map.cameraBeats || map.beats || map.kicks || []).map(packLocalBeatEvent);
  var pulse = (map.pulseBeats || map.kicks || []).map(packLocalBeatEvent);
  return {
    v: 1,
    duration: localBeatRound(map.duration || 0, 1000),
    gridStep: localBeatRound(map.gridStep || 0, 1000),
    sectionSteps: (map.sectionSteps || []).map(function(v){ return localBeatRound(v, 1000); }),
    tempoSource: map.tempoSource || 'local',
    visualBeatCount: map.visualBeatCount || camera.length,
    analyzedAt: map.analyzedAt || Date.now(),
    partial: !!map.partial,
    partialUntilSec: map.partialUntilSec || 0,
    cameraBeats: camera,
    pulseBeats: pulse
  };
}
function unpackLocalBeatMap(stored) {
  if (!stored) return null;
  if (stored.v && stored.v !== 1 && stored.v !== 2) return stored;
  var camera = (stored.cameraBeats || []).map(unpackLocalBeatEvent);
  var pulse = (stored.pulseBeats || []).map(unpackLocalBeatEvent);
  return {
    kicks: camera.map(function(b){ return typeof b === 'number' ? b : b.time; }),
    beats: camera,
    pulseBeats: pulse,
    cameraBeats: camera,
    gridStep: stored.gridStep || 0,
    sectionSteps: stored.sectionSteps || [],
    tempoSource: stored.tempoSource || 'local',
    duration: stored.duration || 0,
    visualBeatCount: stored.visualBeatCount || camera.length,
    analyzedAt: stored.analyzedAt || Date.now(),
    partial: !!stored.partial,
    partialUntilSec: stored.partialUntilSec || 0
  };
}
function readLocalBeatPrefs() {
  try { return JSON.parse(localStorage.getItem(LOCAL_BEAT_PREF_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveLocalBeatPrefs() {
  try { localStorage.setItem(LOCAL_BEAT_PREF_STORE_KEY, JSON.stringify(localBeatMapPrefs || {})); } catch (e) {}
}
function readLocalBeatMapCache() {
  var out = {};
  try {
    var raw = JSON.parse(localStorage.getItem(LOCAL_BEATMAP_STORE_KEY) || '{}') || {};
    Object.keys(raw).forEach(function(key){
      var entry = raw[key] || {};
      out[key] = { updatedAt: entry.updatedAt || 0 };
      if (entry.mr) out[key].mr = unpackLocalBeatMap(entry.mr);
      if (entry.dj) out[key].dj = unpackLocalBeatMap(entry.dj);
    });
  } catch (e) {
    out = {};
  }
  return out;
}
function packLocalBeatCache(maxEntries) {
  var entries = Object.keys(localBeatMapCache || {}).map(function(key){
    var entry = localBeatMapCache[key] || {};
    return { key:key, updatedAt: entry.updatedAt || 0, entry:entry };
  }).sort(function(a,b){ return b.updatedAt - a.updatedAt; });
  if (maxEntries) entries = entries.slice(0, maxEntries);
  var packed = {};
  entries.forEach(function(item){
    packed[item.key] = { updatedAt: item.entry.updatedAt || Date.now() };
    if (item.entry.mr) packed[item.key].mr = packLocalBeatMap(item.entry.mr);
    if (item.entry.dj) packed[item.key].dj = packLocalBeatMap(item.entry.dj);
  });
  return packed;
}
function saveLocalBeatMapCache() {
  var attempts = [12, 8, 5, 3];
  for (var i = 0; i < attempts.length; i++) {
    try {
      localStorage.setItem(LOCAL_BEATMAP_STORE_KEY, JSON.stringify(packLocalBeatCache(attempts[i])));
      return true;
    } catch (e) {}
  }
  return false;
}
function getLocalBeatEntry(localKey, mode) {
  var entry = localKey && localBeatMapCache ? localBeatMapCache[localKey] : null;
  return entry && entry[mode] ? entry[mode] : null;
}
function storeLocalBeatEntry(localKey, mode, map, song, opts) {
  if (!localKey || !map) return;
  opts = opts || {};
  var entry = localBeatMapCache[localKey] || {};
  entry[mode] = map;
  entry.updatedAt = Date.now();
  localBeatMapCache[localKey] = entry;
  localBeatMapPrefs[localKey] = mode;
  saveLocalBeatPrefs();
  saveLocalBeatMapCache();
  if (!opts.skipDisk) writeBeatDiskCache(localBeatDiskKey(localKey, mode), map, song || { type:'local', localKey:localKey }, mode);
}
function setLocalBeatStatus(text, tone) {
  var el = document.getElementById('local-beat-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('warn', tone === 'warn');
  el.classList.toggle('fail', tone === 'fail');
}

function localBeatVisualCount(map) {
  return map ? (map.visualBeatCount || (map.cameraBeats && map.cameraBeats.length) || (map.beats && map.beats.length) || 0) : 0;
}
function setLocalBeatPreference(localKey, mode) {
  if (!localKey) return;
  localBeatMapPrefs[localKey] = mode === 'dj' ? 'dj' : 'mr';
  saveLocalBeatPrefs();
}
function applyLocalBeatMap(song, mode, map, fromCache) {
  if (!song || !song.localKey || !map) return false;
  mode = mode === 'dj' ? 'dj' : 'mr';
  song.localBeatMode = mode;
  setLocalBeatPreference(song.localKey, mode);
  if (mode === 'dj') {
    setDjModeActive(true, song);
    currentBeatMap = null;
    beatMapNextIdx = 0;
    currentDjBeatMap = map;
    djBeatMapCache[djSongKey(song)] = map;
    applyPodcastDjProfileFromMap(map);
    syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
    maybeAnnounceDjMode();
  } else {
    setDjModeActive(false, song);
    currentBeatMap = map;
    beatMapCache['local:' + song.localKey] = map;
    applyCinemaProfileFromBeatMap(map);
    syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, true);
  }
  hideBeatChip();
  notifyDesktopLyricsBeatMapReady();
  if (fromCache) showToast((mode === 'dj' ? 'DJ' : 'MR') + ' 本地节奏缓存已载入');
  return true;
}
function prepareLocalBeatAnalysis(song, audioUrl) {
  if (!song || !song.localKey || !audioUrl) return;
  var preferred = localBeatMapPrefs[song.localKey] === 'dj' ? 'dj' : 'mr';
  var cached = getLocalBeatEntry(song.localKey, preferred) ||
    getLocalBeatEntry(song.localKey, preferred === 'dj' ? 'mr' : 'dj');
  if (cached) {
    applyLocalBeatMap(song, cached === getLocalBeatEntry(song.localKey, 'dj') ? 'dj' : 'mr', cached, true);
    return;
  }
  var diskToken = trackSwitchToken;
  (async function(){
    var firstMode = preferred;
    var secondMode = preferred === 'dj' ? 'mr' : 'dj';
    var firstMap = await readBeatDiskCache(localBeatDiskKey(song.localKey, firstMode));
    var mode = firstMap ? firstMode : secondMode;
    var map = firstMap || await readBeatDiskCache(localBeatDiskKey(song.localKey, secondMode));
    if (diskToken !== trackSwitchToken || !currentLocalSong || currentLocalSong.localKey !== song.localKey) return;
    if (map) {
      storeLocalBeatEntry(song.localKey, mode, map, song, { skipDisk:true });
      applyLocalBeatMap(song, mode, map, true);
      return;
    }
    openLocalBeatModal(song, audioUrl);
  })().catch(function(){
    if (diskToken === trackSwitchToken && currentLocalSong && currentLocalSong.localKey === song.localKey) openLocalBeatModal(song, audioUrl);
  });
}
function openLocalBeatModal(song, audioUrl) {
  if (immersiveMode) setImmersiveMode(false);
  localBeatAnalysis.song = song || currentLocalSong;
  localBeatAnalysis.audioUrl = audioUrl || (audio && audio.src) || '';
  localBeatAnalysis.mode = (localBeatAnalysis.song && localBeatMapPrefs[localBeatAnalysis.song.localKey] === 'dj') ? 'dj' : 'mr';
  localBeatAnalysis.active = false;
  setLocalBeatStatus('', '');
  updateLocalBeatModal();
  openGsapModal(document.getElementById('local-beat-modal'));
}
function closeLocalBeatModal() {
  if (localBeatAnalysis.active) return;
  closeGsapModal(document.getElementById('local-beat-modal'));
}
function selectLocalBeatMode(mode) {
  if (localBeatAnalysis.active) return;
  localBeatAnalysis.mode = mode === 'dj' ? 'dj' : 'mr';
  updateLocalBeatModal();
}
function updateLocalBeatModal() {
  var song = localBeatAnalysis.song || currentLocalSong || {};
  var mode = localBeatAnalysis.mode === 'dj' ? 'dj' : 'mr';
  var modal = document.querySelector('#local-beat-modal .local-beat-modal');
  if (modal) modal.classList.toggle('analyzing', !!localBeatAnalysis.active);
  var title = document.getElementById('local-beat-title');
  var sub = document.getElementById('local-beat-sub');
  if (title) title.textContent = song.name || '本地歌曲';
  if (sub) {
    var cachedBits = [];
    if (song.localKey && getLocalBeatEntry(song.localKey, 'mr')) cachedBits.push('MR 已缓存');
    if (song.localKey && getLocalBeatEntry(song.localKey, 'dj')) cachedBits.push('DJ 已缓存');
    sub.textContent = cachedBits.length ? cachedBits.join(' / ') : '选择一种电影视角分析方式';
  }
  var mr = document.getElementById('local-beat-tab-mr');
  var dj = document.getElementById('local-beat-tab-dj');
  if (mr) mr.classList.toggle('active', mode === 'mr');
  if (dj) dj.classList.toggle('active', mode === 'dj');
  var desc = document.getElementById('local-beat-desc');
  if (desc) desc.textContent = mode === 'dj'
    ? '适合 DJ、长混音或鼓点密集的本地音频，会使用更稳定的低频锁拍并进入 DJ 视觉驱动。'
    : '适合普通歌曲和日常播放，会沿用 Mineradio 电影视角的综合节奏分析。';
  var start = document.getElementById('local-beat-start-btn');
  var cancel = document.getElementById('local-beat-cancel-btn');
  var later = document.getElementById('local-beat-later-btn');
  if (start) {
    start.disabled = !!localBeatAnalysis.active;
    start.textContent = getLocalBeatEntry(song.localKey, mode) ? '使用缓存' : '开始分析';
  }
  if (cancel) cancel.style.display = localBeatAnalysis.active ? '' : 'none';
  if (later) later.style.display = localBeatAnalysis.active ? 'none' : '';
}
function cancelLocalBeatAnalysis() {
  if (!localBeatAnalysis.active) {
    closeLocalBeatModal();
    return;
  }
  localBeatAnalysis.active = false;
  localBeatAnalysis.token++;
  beatMapToken++;
  djBeatMapToken++;
  beatMapBusy = false;
  djBeatMapBusy = false;
  cancelBeatAnalysisTimer();
  cancelDjBeatAnalysisTimer();
  hideBeatChip();
  if (localBeatAnalysis.mode === 'dj') setDjModeActive(false, localBeatAnalysis.song || currentLocalSong);
  setLocalBeatStatus('已取消分析', 'fail');
  updateLocalBeatModal();
}
async function startLocalBeatAnalysis(mode) {
  var song = localBeatAnalysis.song || currentLocalSong;
  var audioUrl = localBeatAnalysis.audioUrl || (song && song.localUrl) || (audio && audio.src) || '';
  mode = mode || localBeatAnalysis.mode;
  mode = mode === 'dj' ? 'dj' : 'mr';
  if (!song || !song.localKey || !audioUrl || localBeatAnalysis.active) return;
  var cached = getLocalBeatEntry(song.localKey, mode);
  if (cached) {
    applyLocalBeatMap(song, mode, cached, true);
    closeGsapModal(document.getElementById('local-beat-modal'));
    return;
  }
  localBeatAnalysis.active = true;
  localBeatAnalysis.mode = mode;
  localBeatAnalysis.token++;
  var localToken = localBeatAnalysis.token;
  updateLocalBeatModal();
  setLocalBeatStatus((mode === 'dj' ? 'DJ' : 'MR') + ' 分析准备中...', 'warn');
  try {
    var map = null;
    if (mode === 'dj') {
      setDjModeActive(true, song);
      djBeatMapToken++;
      resetDjBeatMapState();
      currentBeatMap = null;
      resetBeatCameraSync(audio ? audio.currentTime : 0);
      var djToken = djBeatMapToken;
      map = await analyzePodcastDjBeats(audioUrl, djToken, audio && isFinite(audio.duration) ? audio.duration : 0);
      if (localToken !== localBeatAnalysis.token || djToken !== djBeatMapToken) return;
      if (!map) throw new Error('DJ analysis returned empty map');
    } else {
      setDjModeActive(false, song);
      beatMapToken++;
      currentBeatMap = null;
      beatMapNextIdx = 0;
      resetBeatCameraSync(audio ? audio.currentTime : 0);
      var mrToken = beatMapToken;
      map = await analyzeAudioBeats(audioUrl, audio && isFinite(audio.duration) ? audio.duration : 0, mrToken, { background:false, song: song });
      if (localToken !== localBeatAnalysis.token || mrToken !== beatMapToken) return;
      if (!map) throw new Error('MR analysis returned empty map');
    }
    storeLocalBeatEntry(song.localKey, mode, map, song);
    applyLocalBeatMap(song, mode, map, false);
    localBeatAnalysis.active = false;
    setLocalBeatStatus((mode === 'dj' ? 'DJ' : 'MR') + ' 分析完成: ' + localBeatVisualCount(map) + ' 个主拍');
    updateLocalBeatModal();
    showToast((mode === 'dj' ? 'DJ' : 'MR') + ' 本地节奏分析完成');
    setTimeout(function(){
      if (!localBeatAnalysis.active) closeGsapModal(document.getElementById('local-beat-modal'));
    }, 900);
  } catch (err) {
    console.warn('local beat analysis failed:', err);
    localBeatAnalysis.active = false;
    hideBeatChip();
    if (mode === 'dj') setDjModeActive(false, song);
    setLocalBeatStatus('分析失败，请换另一种模式重试', 'fail');
    updateLocalBeatModal();
    showToast('本地节奏分析失败');
  }
}

function smoothBeatMapHandoff(songId, map, token, song) {
  if (!map) return;
  showBeatChip('节奏缓冲中…');
  var wait = Math.max(260, Math.min(720, 340 + (beatPulse + beatCam.punch) * 260));
  var apply = function() {
    if (token !== beatMapToken) return;
    beatMapCache[songId] = map;
    currentBeatMap = map;
    applyCinemaProfileFromBeatMap(map);
    var t = audio ? audio.currentTime : 0;
    syncBeatMapPlaybackCursor(t, true);
    hideBeatChip();
    notifyDesktopLyricsBeatMapReady();
    showToast('节奏分析完成: ' + (map.visualBeatCount || (map.cameraBeats && map.cameraBeats.length) || 0) + ' 个视觉主拍');
    writeBeatDiskCache(songId, map, song, 'mr');
    scheduleQueueBeatPrefetch(currentIdx, 1000);
  };
  scheduleVisualApply(apply, wait, 460);
}

function applyBeatMapCacheForCurrent(songId, map, token, message) {
  if (!songId || !map || token !== beatMapToken) return false;
  beatMapCache[songId] = map;
  currentBeatMap = map;
  applyCinemaProfileFromBeatMap(map);
  syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, true);
  hideBeatChip();
  notifyDesktopLyricsBeatMapReady();
  if (message) console.log(message, songId, map.visualBeatCount || 0);
  scheduleQueueBeatPrefetch(currentIdx, 1000);
  return true;
}

// 每帧调用 — 按 beatMap 触发预演鼓点
function syncBeatMapPlaybackCursor(t, preserveVisualState) {
  if (djMode.active) {
    syncPodcastDjMapCursor(t, preserveVisualState);
    return;
  }
  t = isFinite(t) ? t : 0;
  beatMapNextIdx = 0;
  var pulseEvents = currentBeatMap && (currentBeatMap.pulseBeats || currentBeatMap.kicks);
  if (pulseEvents) {
    while (beatMapNextIdx < pulseEvents.length && beatEventTime(pulseEvents[beatMapNextIdx]) < t) beatMapNextIdx++;
  }
  if (preserveVisualState) alignBeatCameraCursorToTime(t);
  else syncBeatCameraToTime(t);
}

function syncPodcastDjMapCursor(t, preserveVisualState) {
  t = isFinite(t) ? t : 0;
  djBeatMapNextIdx = 0;
  djBeatPulseNextIdx = 0;
  if (currentDjBeatMap) {
    var beatEvents = currentDjBeatMap.cameraBeats || currentDjBeatMap.beats || currentDjBeatMap.kicks || [];
    var camSyncTime = Math.max(0, t - 0.025);
    while (djBeatMapNextIdx < beatEvents.length && beatEventTime(beatEvents[djBeatMapNextIdx]) < camSyncTime) djBeatMapNextIdx++;
    var pulseEvents = currentDjBeatMap.pulseBeats || currentDjBeatMap.kicks || [];
    var pulseSyncTime = Math.max(0, t - 0.035);
    while (djBeatPulseNextIdx < pulseEvents.length && beatEventTime(pulseEvents[djBeatPulseNextIdx]) < pulseSyncTime) djBeatPulseNextIdx++;
  }
  if (!preserveVisualState) resetBeatCameraSync(t);
}

function tickPodcastDjBeatMap() {
  if (!djMode.active || !currentDjBeatMap || !audio || audio.paused) return;
  var t = audio.currentTime || 0;
  if (currentDjBeatMap.partialUntilSec && t > currentDjBeatMap.partialUntilSec + beatCam.lookahead) return;
  var beatEvents = currentDjBeatMap.cameraBeats || currentDjBeatMap.beats || currentDjBeatMap.kicks || [];
  var pulseEvents = currentDjBeatMap.pulseBeats || currentDjBeatMap.kicks || [];
  while (djBeatMapNextIdx < beatEvents.length) {
    var beat = beatEvents[djBeatMapNextIdx];
    var beatTime = beatEventTime(beat);
    if (beatTime > t + beatCam.lookahead) break;
    scheduleBeatCamera(beat, 'djmap');
    djBeatMapNextIdx++;
  }
  while (djBeatPulseNextIdx < pulseEvents.length && beatEventTime(pulseEvents[djBeatPulseNextIdx]) <= t) {
    triggerScheduledBeat(pulseEvents[djBeatPulseNextIdx]);
    djBeatPulseNextIdx++;
  }
}

function tickBeatMap() {
  if (djMode.active) return;
  if (!currentBeatMap || !audio || audio.paused) return;
  var t = audio.currentTime;
  var beatEvents = currentBeatMap.cameraBeats || currentBeatMap.beats || currentBeatMap.kicks || [];
  var pulseEvents = currentBeatMap.pulseBeats || currentBeatMap.kicks || [];
  var gridTimingLocked = currentBeatMap.tempoSource === 'music-tempo' && beatEvents.length >= 4;
  var provisionalMap = !!currentBeatMap.provisional;
  var liveFreshWindow = Math.max(0.50, rtBeat.tempoGap ? rtBeat.tempoGap * 1.18 : 0.50);
  var realtimeHasLock = rtBeat.lastHitAt > 0 && (t - rtBeat.lastHitAt) < liveFreshWindow;
  var mapDrivesTiming = provisionalMap || gridTimingLocked || !realtimeHasLock;
  while (beatCam.nextIdx < beatEvents.length) {
    var beat = beatEvents[beatCam.nextIdx];
    var beatTime = typeof beat === 'number' ? beat : beat.time;
    if (beatTime > t + beatCam.lookahead) break;
    if (mapDrivesTiming) scheduleBeatCamera(beat, 'map');
    beatCam.nextIdx++;
  }
  while (beatMapNextIdx < pulseEvents.length && beatEventTime(pulseEvents[beatMapNextIdx]) <= t) {
    // 触发预演冲击
    if (mapDrivesTiming) triggerScheduledBeat(pulseEvents[beatMapNextIdx]);
    beatMapNextIdx++;
  }
}

function triggerScheduledBeat(beat) {
  var strength = typeof beat === 'number' ? 0.42 : Math.max(0, Math.min(1, beat && beat.strength != null ? beat.strength : 0.42));
  var impact = typeof beat === 'number' ? strength : Math.max(0, Math.min(1, beat && beat.impact != null ? beat.impact : strength));
  if (impact < 0.18 && strength < 0.52) return;
  if ((cinemaTrackProfile.scale || 1) < 0.52 && impact < 0.46 && strength < 0.74) return;
  var body = typeof beat === 'number' ? 0 : Math.max(0, Math.min(1, beat && beat.body != null ? beat.body : 0));
  var combo = typeof beat === 'number' ? null : beat && beat.combo;
  var comboLift = combo === 'downbeat' ? 0.08 : (combo === 'drop' ? 0.04 : 0);
  var dynScale = cameraDynamicsScale(0.88 + impact * 0.16);
  var djPulse = beat && beat.dj;
  var pulse = (0.14 + strength * 0.46 + impact * 0.18 + body * 0.08 + comboLift) * dynScale;
  if (djPulse) pulse = (0.12 + strength * 0.50 + impact * 0.28 + comboLift * 0.70) * clampRange(dynScale, 0.78, 1.18);
  pulse = Math.min(djPulse ? 0.92 : 0.78, pulse);
  scheduledBeatPulse = Math.max(scheduledBeatPulse, pulse);
  scheduledBeatFlag = true;
}
var scheduledBeatPulse = 0;
var scheduledBeatFlag = false;

function ensurePlaybackBeatmapVisualFallback() {
  if (presetSkipsBeatAnalysisUi() || !playing || djMode.active || !mineradioUsesWebMediaBridge()) return;
  if (currentIdx < 0 || currentIdx >= playQueue.length) return;
  if (currentBeatMap) return;
  var song = playQueue[currentIdx];
  var key = beatMapSongKey(song);
  if (!key) return;
  if (hasResolvedBeatMapCache(key)) {
    currentBeatMap = beatMapCache[key];
    applyCinemaProfileFromBeatMap(currentBeatMap);
    syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, true);
    return;
  }
  maybeApplyProvisionalBeatMap(song, key, { silent: true });
}
function updateBeatmapFallbackVisualEnergy(dt) {
  var pulse = Math.max(beatPulse, scheduledBeatPulse * 0.76);
  var mapReady = !!(currentBeatMap && (
    (currentBeatMap.pulseBeats && currentBeatMap.pulseBeats.length) ||
    (currentBeatMap.kicks && currentBeatMap.kicks.length) ||
    (currentBeatMap.cameraBeats && currentBeatMap.cameraBeats.length)
  ));
  var base = mapReady ? 0.16 : 0.10;
  var breathe = base + 0.038 * Math.sin(uniforms.uTime.value * (mapReady ? 1.15 : 0.78));
  var bassTarget = Math.min(0.92, breathe + pulse * (mapReady ? 0.82 : 0.56));
  var midTarget = Math.min(0.64, breathe * 0.74 + pulse * 0.38);
  var trebTarget = Math.min(0.52, breathe * 0.60 + pulse * 0.30);
  var energyTarget = Math.min(0.76, breathe * 0.98 + pulse * 0.52);
  function env(prev, next, attack, release) {
    var k = next > prev ? attack : release;
    return prev + (next - prev) * k;
  }
  var prevBass = smoothBass;
  smoothBass = env(smoothBass, bassTarget, 0.44, 0.11);
  smoothMid = env(smoothMid, midTarget, 0.30, 0.10);
  smoothTreb = env(smoothTreb, trebTarget, 0.26, 0.09);
  smoothEnergy = env(smoothEnergy, energyTarget, 0.24, 0.08);
  if (pulse > 0.20 && bassTarget - prevBass > 0.06) beatOnsetFlag = true;
  beatPulse *= Math.pow(0.40, dt);
  updateCinemaDynamics(energyTarget, bassTarget);
  updateCinemaTrackProfile({
    energy: energyTarget,
    low: bassTarget,
    vocal: midTarget * 0.58,
    melody: midTarget,
    lowOnset: Math.max(0, bassTarget - prevBass),
    energyOnset: Math.max(0, energyTarget - prevEnergy)
  });
  prevEnergy = prevEnergy * 0.88 + energyTarget * 0.12;
  var sunRaw = clamp01((smoothEnergy - 0.14) / 0.40);
  lyricSunTarget = clamp01(sunRaw * 0.46);
  lyricSunEnergy += (lyricSunTarget - lyricSunEnergy) * 0.048;
}

function showAIDepthChip(text) {
  document.getElementById('ai-depth-text').textContent = text || 'AI 深度估计…';
  document.getElementById('ai-depth-chip').classList.add('show');
}
function hideAIDepthChip() {
  document.getElementById('ai-depth-chip').classList.remove('show');
}

function loadCoverFromUrl(directUrl, opts) {
  opts = opts || {};
  if (!directUrl || typeof directUrl !== 'string' || !/^https?:\/\//i.test(directUrl)) {
    if (!coverApplyStillCurrent(opts)) return;
    currentCoverSource = null;
    coverProcessToken++;
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    resetFloatColorsToIdle();
    document.getElementById('album-bg').classList.remove('visible');
    document.getElementById('thumb-cover').removeAttribute('src');
    setControlCoverSrc('');
    return;
  }
  resolveCoverUrlForCanvas(directUrl).then(function(safeSrc) {
    if (!coverApplyStillCurrent(opts)) return;
    if (safeSrc) {
      loadCoverFromUrlResolved(safeSrc, directUrl, opts);
      return;
    }
    // Last resort: display-path blob/data URL (may still be canvas-safe)
    if (mineradioUsesWebMediaBridge() && typeof window.__mineradioResolveCoverUrl === 'function') {
      return window.__mineradioResolveCoverUrl(directUrl, true).then(function(alt) {
        if (!coverApplyStillCurrent(opts)) return;
        if (alt && (/^data:image\//i.test(alt) || /^blob:/i.test(alt))) {
          loadCoverFromUrlResolved(alt, directUrl, opts);
        } else {
          finishCoverLoadError(opts);
        }
      }).catch(function(){ finishCoverLoadError(opts); });
    }
    finishCoverLoadError(opts);
  }).catch(function(){ finishCoverLoadError(opts); });
}
function loadCoverFromUrlResolved(proxiedUrl, directUrl, opts) {
  opts = opts || {};
  directUrl = normalizeListenCoverUrl(directUrl) || directUrl;
  proxiedUrl = normalizeListenCoverUrl(proxiedUrl) || proxiedUrl;
  var paintSrc = directUrl || proxiedUrl;
  if (paintSrc) {
    setAlbumBackground(paintSrc);
    var thumb = document.getElementById('thumb-cover');
    if (thumb) thumb.src = paintSrc;
    setControlCoverSrc(paintSrc);
  }
  if (!proxiedUrl) {
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    resetFloatColorsToIdle();
    return;
  }
  var img = new Image(); img.decoding = 'async';
  if (/^https?:\/\//i.test(proxiedUrl)) img.crossOrigin = 'anonymous';
  img.onload = function() {
    if (!coverApplyStillCurrent(opts)) return;
    var size = coverTextureSizeForResolution(fx.coverResolution);
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var cx = cv.getContext('2d');
    var iw = img.naturalWidth, ih = img.naturalHeight, s = Math.min(iw, ih);
    cx.drawImage(img, (iw-s)/2, (ih-s)/2, s, s, 0, 0, size, size);
    applyCoverCanvas(cv, proxiedUrl || directUrl, Object.assign({}, opts, { coverKey: directUrl || proxiedUrl || '', coverSourceKind: 'url', coverSource: directUrl }));
  };
  img.onerror = function() {
    resolveCoverUrlForCanvas(directUrl).then(function(retrySrc) {
      if (!coverApplyStillCurrent(opts)) return;
      if (!retrySrc || retrySrc === proxiedUrl) { finishCoverLoadError(opts); return; }
      loadCoverFromUrlResolved(retrySrc, directUrl, opts);
    }).catch(function(){ finishCoverLoadError(opts); });
  };
  img.src = proxiedUrl;
}
function finishCoverLoadError(opts) {
  if (!coverApplyStillCurrent(opts)) return;
  currentCoverSource = null;
  uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
  resetFloatColorsToIdle();
}

function setAlbumBackground(src) {
  var bg = document.getElementById('album-bg');
  if (!bg) return;
  if (!src) {
    bg.classList.remove('visible');
    bg.style.backgroundImage = '';
    return;
  }
  src = normalizeListenCoverUrl(src) || src;
  bg.style.backgroundImage = "url(" + src + ")";
  bg.classList.add('visible');
}

function makeSquareCoverCanvas(img, size, crop) {
  size = size || 512;
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var cx = cv.getContext('2d');
  cx.clearRect(0, 0, size, size);
  var iw = img.naturalWidth || img.width;
  var ih = img.naturalHeight || img.height;
  if (crop) {
    cx.drawImage(img, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, size, size);
  } else {
    var s = Math.min(iw, ih);
    cx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
  }
  return cv;
}

function coverCanvasToDataUrl(cv) {
  try {
    var webp = cv.toDataURL('image/webp', 0.88);
    if (/^data:image\/webp/i.test(webp)) return webp;
  } catch (e) {}
  return cv.toDataURL('image/jpeg', 0.88);
}

function applyCoverDataUrl(dataUrl, opts) {
  opts = opts || {};
  if (!dataUrl) return;
  var img = new Image();
  img.decoding = 'async';
  img.onload = function() {
    if (!coverApplyStillCurrent(opts)) return;
    var cv = makeSquareCoverCanvas(img, coverTextureSizeForResolution(fx.coverResolution));
    setAlbumBackground(dataUrl);
    applyCoverCanvas(cv, dataUrl, Object.assign({}, opts, { coverSourceKind: 'data', coverSource: dataUrl }));
  };
  img.src = dataUrl;
}

function commitCustomCoverCanvas(cv, opts) {
  var out = document.createElement('canvas');
  out.width = out.height = 512;
  out.getContext('2d').drawImage(cv, 0, 0, 512, 512);
  setCustomCoverForCurrent(coverCanvasToDataUrl(out), opts);
}

function loadCoverFromFile(file, opts) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var iw = img.naturalWidth || img.width;
      var ih = img.naturalHeight || img.height;
      if (Math.abs(iw - ih) <= 1) {
        commitCustomCoverCanvas(makeSquareCoverCanvas(img, 512), opts);
      } else {
        openCoverCropModal(img, e.target.result);
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function bindCoverCropModal() {
  if (coverCropBound) return;
  coverCropBound = true;
  var stage = document.getElementById('cover-crop-stage');
  var zoom = document.getElementById('cover-crop-zoom');
  if (!stage || !zoom) return;
  stage.addEventListener('pointerdown', function(e) {
    if (!coverCropState) return;
    e.preventDefault();
    coverCropState.dragging = true;
    coverCropState.lastX = e.clientX;
    coverCropState.lastY = e.clientY;
    stage.classList.add('dragging');
    if (stage.setPointerCapture) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    }
  });
  stage.addEventListener('pointermove', function(e) {
    if (!coverCropState || !coverCropState.dragging) return;
    e.preventDefault();
    var dx = e.clientX - coverCropState.lastX;
    var dy = e.clientY - coverCropState.lastY;
    coverCropState.lastX = e.clientX;
    coverCropState.lastY = e.clientY;
    coverCropState.x += dx;
    coverCropState.y += dy;
    updateCoverCropTransform();
  });
  function stopDrag() {
    if (!coverCropState) return;
    coverCropState.dragging = false;
    stage.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('wheel', function(e) {
    if (!coverCropState) return;
    e.preventDefault();
    var next = coverCropState.scaleFactor + (e.deltaY < 0 ? 0.10 : -0.10);
    coverCropState.scaleFactor = Math.max(1, Math.min(3.2, next));
    zoom.value = coverCropState.scaleFactor;
    updateCoverCropTransform();
  }, { passive: false });
  zoom.addEventListener('input', function() {
    if (!coverCropState) return;
    coverCropState.scaleFactor = Math.max(1, Math.min(3.2, parseFloat(zoom.value) || 1));
    updateCoverCropTransform();
  });
}

function openCoverCropModal(img, dataUrl) {
  bindCoverCropModal();
  var modal = document.getElementById('cover-crop-modal');
  var stage = document.getElementById('cover-crop-stage');
  var imgEl = document.getElementById('cover-crop-img');
  var zoom = document.getElementById('cover-crop-zoom');
  if (!modal || !stage || !imgEl || !zoom) return;
  imgEl.src = dataUrl;
  zoom.value = '1';
  coverCropState = {
    img: img,
    dataUrl: dataUrl,
    naturalW: img.naturalWidth || img.width,
    naturalH: img.naturalHeight || img.height,
    stageSize: 0,
    baseScale: 1,
    scaleFactor: 1,
    x: 0,
    y: 0,
    dragging: false,
    lastX: 0,
    lastY: 0
  };
  openGsapModal(modal);
  requestAnimationFrame(function(){
    initCoverCropGeometry();
    pulseCoverCropStage();
  });
}

function initCoverCropGeometry() {
  if (!coverCropState) return;
  var stage = document.getElementById('cover-crop-stage');
  var rect = stage ? stage.getBoundingClientRect() : null;
  var size = rect ? Math.max(220, Math.round(rect.width)) : 312;
  coverCropState.stageSize = size;
  coverCropState.baseScale = size / Math.min(coverCropState.naturalW, coverCropState.naturalH);
  coverCropState.x = 0;
  coverCropState.y = 0;
  updateCoverCropTransform();
}

function clampCoverCropPan() {
  if (!coverCropState) return;
  var s = coverCropState.baseScale * coverCropState.scaleFactor;
  var rw = coverCropState.naturalW * s;
  var rh = coverCropState.naturalH * s;
  var maxX = Math.max(0, (rw - coverCropState.stageSize) / 2);
  var maxY = Math.max(0, (rh - coverCropState.stageSize) / 2);
  coverCropState.x = Math.max(-maxX, Math.min(maxX, coverCropState.x));
  coverCropState.y = Math.max(-maxY, Math.min(maxY, coverCropState.y));
}

function updateCoverCropTransform() {
  if (!coverCropState) return;
  clampCoverCropPan();
  var imgEl = document.getElementById('cover-crop-img');
  if (!imgEl) return;
  var baseW = coverCropState.naturalW * coverCropState.baseScale;
  var baseH = coverCropState.naturalH * coverCropState.baseScale;
  imgEl.style.width = baseW + 'px';
  imgEl.style.height = baseH + 'px';
  imgEl.style.transform = 'translate(-50%, -50%) translate(' + coverCropState.x + 'px,' + coverCropState.y + 'px) scale(' + coverCropState.scaleFactor + ')';
  drawCoverCropPreview();
}

function currentCoverCropRect() {
  if (!coverCropState) return null;
  var s = coverCropState.baseScale * coverCropState.scaleFactor;
  var rw = coverCropState.naturalW * s;
  var rh = coverCropState.naturalH * s;
  var left = coverCropState.stageSize / 2 - rw / 2 + coverCropState.x;
  var top = coverCropState.stageSize / 2 - rh / 2 + coverCropState.y;
  var sx = (0 - left) / s;
  var sy = (0 - top) / s;
  var sSize = coverCropState.stageSize / s;
  sx = Math.max(0, Math.min(coverCropState.naturalW - sSize, sx));
  sy = Math.max(0, Math.min(coverCropState.naturalH - sSize, sy));
  return { sx: sx, sy: sy, sSize: sSize };
}

function drawCoverCropPreview() {
  if (!coverCropState) return;
  var preview = document.getElementById('cover-crop-preview');
  var crop = currentCoverCropRect();
  if (!preview || !crop) return;
  var ctx = preview.getContext('2d');
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.drawImage(coverCropState.img, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, preview.width, preview.height);
}

function pulseCoverCropStage() {
  var stage = document.getElementById('cover-crop-stage');
  if (!stage || !window.gsap) return;
  window.gsap.fromTo(stage, { scale: 0.985 }, { scale: 1, duration: 0.72, ease: 'expo.out', overwrite: true });
}

function closeCoverCropModal() {
  var modal = document.getElementById('cover-crop-modal');
  closeGsapModal(modal, function(){
    var imgEl = document.getElementById('cover-crop-img');
    if (imgEl) imgEl.removeAttribute('src');
    coverCropState = null;
  });
}

function commitCoverCrop() {
  if (!coverCropState) return;
  var crop = currentCoverCropRect();
  if (!crop) return;
  var cv = makeSquareCoverCanvas(coverCropState.img, 512, crop);
  commitCustomCoverCanvas(cv);
  closeCoverCropModal();
}

// ============================================================
//  3D 歌单架 — 双模式 (off / side / stage)
//   - side:   现版本精修, 右侧 5 张卡微角度堆叠
//   - stage:  弧形排列, 居中, 有倒影, 当前卡片"呼吸+光环"
//             卡片间粒子穿梭, 切歌时飞出动画
// ============================================================
var shelfPinnedOpen = false;
var shelfManager = null;
var shelfOpenAnimAt = -10;
var shelfHoverCue = { target: 0, value: 0, x: 0, y: 0, lastAt: 0, enteredAt: 0, zoneActive: false, guide: false };
var shelfVisibility = 0;  // 0..1, 侧栏自动隐藏的整体透明度系数
function isPortraitShelfViewport() {
  return innerHeight > innerWidth * 1.08;
}
function shelfLayoutProfile() {
  var portrait = isPortraitShelfViewport();
  var narrow = !portrait && innerWidth < 980;
  var skullShelf = shouldUseSkullSafeShelfCamera();
  var detailScale = portrait ? clampRange(innerWidth / 820, 0.70, 0.86) : (narrow ? 0.92 : 1.04);
  var shelfCtl = shelfSettings();
  return {
    portrait: portrait,
    narrow: narrow,
    sideX: (skullShelf ? (portrait ? 0.22 : (narrow ? 0.46 : 0.76)) : (portrait ? 1.56 : (narrow ? 2.48 : 3.18))) + shelfCtl.x,
    sideY: (skullShelf ? (portrait ? -0.22 : (narrow ? -0.30 : -0.34)) : 0) + shelfCtl.y,
    sideXStep: skullShelf ? (portrait ? 0.018 : 0.034) : (portrait ? 0.018 : 0.040),
    sideYStep: skullShelf ? (portrait ? 0.46 : 0.62) : (portrait ? 0.52 : 0.68),
    sideZ: (skullShelf ? (portrait ? 0.86 : 0.92) : (portrait ? 0.78 : 0.86)) + shelfCtl.z,
    sideZStep: skullShelf ? (portrait ? 0.108 : 0.158) : (portrait ? 0.118 : 0.170),
    sideEntryX: skullShelf ? (portrait ? 0.30 : 0.50) : (portrait ? 0.38 : 0.82),
    sideDetailShift: skullShelf ? (portrait ? 0.00 : 0.00) : (portrait ? 0.38 : 0.82),
    sideScale: (skullShelf ? (portrait ? 0.84 : (narrow ? 1.04 : 1.22)) : (portrait ? 0.70 : (narrow ? 0.86 : 1))) * shelfCtl.size,
    sideRotY: (skullShelf ? (portrait ? -0.085 : -0.190) : (portrait ? 0.12 : 0.28)) + shelfCtl.angle,
    sideRotX: skullShelf ? (portrait ? 0.018 : 0.030) : (portrait ? 0.022 : 0.042),
    stageX: shelfCtl.x,
    stageXStep: portrait ? 0.92 : (narrow ? 1.22 : 1.55),
    stageY: (portrait ? -2.46 : -2.20) + shelfCtl.y,
    stageZ: (portrait ? 0.84 : 1.0) + shelfCtl.z,
    stageScale: (portrait ? 0.72 : (narrow ? 0.86 : 1)) * shelfCtl.size,
    detail: {
      x: (skullShelf ? (portrait ? 0.16 : (narrow ? 0.40 : 0.64)) : (portrait ? 0.38 : (narrow ? 0.96 : 1.28))) + shelfCtl.x * 0.62,
      y: (skullShelf ? (portrait ? -0.40 : -0.68) : (portrait ? 0.10 : 0.18)) + shelfCtl.y * 0.55,
      z: (skullShelf ? (portrait ? 1.10 : 1.22) : (portrait ? 1.28 : 1.36)) + shelfCtl.z * 0.45,
      rx: skullShelf ? (portrait ? 0.006 : 0.014) : (portrait ? -0.004 : -0.008),
      ry: (skullShelf ? (portrait ? -0.070 : -0.165) : (portrait ? 0.00 : 0.020)) + shelfCtl.angle * 0.55,
      scale: (skullShelf ? detailScale * (portrait ? 0.88 : 1.02) : detailScale) * shelfCtl.size,
      rowStep: skullShelf ? (portrait ? 0.37 : 0.43) : (portrait ? 0.36 : 0.42),
      rowScale: skullShelf ? (portrait ? 0.90 : 1.02) : (portrait ? 0.88 : (narrow ? 0.96 : 1.00))
    }
  };
}
function shelfHotZoneWidth() {
  var ratio = isPortraitShelfViewport() ? 0.26 : 0.18;
  return Math.min(isPortraitShelfViewport() ? 280 : 360, Math.max(148, innerWidth * ratio));
}
function shelfPreviewUseZoneWidth() {
  return Math.min(820, Math.max(shelfHotZoneWidth(), innerWidth * 0.56));
}
function shelfWheelZoneWidth() {
  var portrait = isPortraitShelfViewport();
  var ratioWidth = innerWidth * (portrait ? 0.24 : 0.18);
  return Math.min(portrait ? 280 : 360, Math.max(shelfHotZoneWidth(), ratioWidth));
}
function isShelfClickZone(e) {
  var edge = shelfPinnedOpen ? Math.min(390, Math.max(210, innerWidth * 0.22)) : shelfHotZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 130 && e.clientY < innerHeight - 150;
}
function isShelfPreviewUseZone(e) {
  var edge = shelfPreviewUseZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 96 && e.clientY < innerHeight - 96;
}
function isShelfWheelZone(e) {
  var edge = shelfWheelZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 116 && e.clientY < innerHeight - 116;
}
function canUseSideShelfWithoutPinnedOpen() {
  return !!shelfAlwaysVisible();
}
function shelfPreviewIsVisible() {
  return shelfHoverCue.guide || shelfHoverCue.zoneActive || shelfHoverCue.target > 0 || shelfHoverCue.value > 0.10 || shelfVisibility > 0.12;
}
function shelfAutoHiddenInputReady() {
  if (shelfPinnedOpen || shelfAlwaysVisible()) return true;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return true;
  return !!(shelfHoverCue.guide || shelfHoverCue.zoneActive || shelfHoverCue.value > 0.18 || shelfVisibility > 0.16);
}
function canShowShelfHoverCueAt(e) {
  if (!e) return false;
  if (!shelfHoverCue.guide) return false;
  if (document.body.classList.contains('splash-active')) return false;
  if (visualGuideActive || emptyHomeActive || homeForcedOpen) return false;
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (isPointerOverUi(e)) return false;
  if (isShelfClickZone(e)) return true;
  return shelfPreviewIsVisible() && isShelfPreviewUseZone(e);
}
function shelfCueRect() {
  var w = shelfHotZoneWidth();
  var top = Math.max(136, innerHeight * 0.22);
  var h = Math.min(390, innerHeight - top - 142);
  return { left: innerWidth - w, top: top, width: w, height: h, right: innerWidth, bottom: top + h };
}
function shelfCueCenter() {
  var r = shelfCueRect();
  return { x: r.left + r.width * 0.58, y: r.top + r.height * 0.50 };
}
function setShelfGuideCueActive(on) {
  shelfHoverCue.guide = !!on;
  if (on) {
    var c = shelfCueCenter();
    shelfHoverCue.target = 1;
    shelfHoverCue.value = Math.max(shelfHoverCue.value, 0.72);
    shelfHoverCue.x = c.x;
    shelfHoverCue.y = c.y;
    shelfHoverCue.lastAt = performance.now();
    if (typeof wakeIdleGuideLoop === 'function') wakeIdleGuideLoop();
  } else {
    shelfHoverCue.target = 0;
  }
}
function updateShelfHoverCueFromPointer(e) {
  if (!e) {
    if (!shelfHoverCue.guide) shelfHoverCue.target = 0;
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
    return;
  }
  var active = false;
  var inZone = canShowShelfHoverCueAt(e);
  if (inZone && !shelfHoverCue.zoneActive) {
    shelfHoverCue.zoneActive = true;
    shelfHoverCue.enteredAt = performance.now();
  } else if (!inZone) {
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
  }
  active = inZone;
  if (!shelfHoverCue.guide) shelfHoverCue.target = active ? 1 : 0;
  shelfHoverCue.x = e.clientX;
  shelfHoverCue.y = e.clientY;
  shelfHoverCue.lastAt = performance.now();
  if ((active || shelfHoverCue.guide || shelfHoverCue.target > 0) && typeof wakeIdleGuideLoop === 'function') {
    wakeIdleGuideLoop();
  }
}
function tickShelfHoverCue(dt) {
  if (!shelfHoverCue.guide && shelfHoverCue.zoneActive) {
    var heldPointer = { clientX: shelfHoverCue.x, clientY: shelfHoverCue.y };
    if (canShowShelfHoverCueAt(heldPointer)) {
      if (performance.now() - shelfHoverCue.enteredAt > 260) shelfHoverCue.target = 1;
    } else {
      shelfHoverCue.zoneActive = false;
      shelfHoverCue.enteredAt = 0;
      shelfHoverCue.target = 0;
    }
  }
  if (!shelfHoverCue.guide && !shelfHoverCue.zoneActive && performance.now() - shelfHoverCue.lastAt > 650) shelfHoverCue.target = 0;
  var target = shelfHoverCue.guide ? 1 : shelfHoverCue.target;
  var rate = target > shelfHoverCue.value ? 0.12 : 0.10;
  shelfHoverCue.value += (target - shelfHoverCue.value) * Math.min(1, rate * Math.max(1, dt * 60));
  if (shelfHoverCue.value < 0.006 && !target) shelfHoverCue.value = 0;
  return shelfHoverCue.value;
}
function setShelfPinnedOpen(open, immediate) {
  var nextOpen = !!open;
  if (nextOpen && typeof suppressBottomControlsForShelf === 'function') suppressBottomControlsForShelf(980);
  if (nextOpen && !shelfPinnedOpen) {
    var nowT = uniforms && uniforms.uTime ? uniforms.uTime.value : performance.now() / 1000;
    var previewVisible = shelfHoverCue.guide || shelfHoverCue.value > 0.28 || shelfVisibility > 0.20;
    shelfOpenAnimAt = previewVisible ? nowT - 0.62 : nowT;
    shelfHoverCue.target = 0;
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
  }
  shelfPinnedOpen = nextOpen;
  var hint = document.getElementById('hint');
  if (hint) hint.classList.toggle('shelf-hidden', shelfPinnedOpen || !!(shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()));
  if (nextOpen && typeof setPeek === 'function') setPeek(document.getElementById('search-area'), false, 'search');
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return;
  if (typeof setFocusZone === 'function') setFocusZone(shelfPinnedOpen ? 'shelf-side' : null, immediate);
}
function clearShelfPreviewOnPointerExit() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return;
  var hasContent = shelfManager.hasOpenContent && shelfManager.hasOpenContent();
  updateShelfHoverCueFromPointer(null);
  shelfHoverCue.target = 0;
  shelfHoverCue.value = 0;
  shelfHoverCue.zoneActive = false;
  shelfHoverCue.enteredAt = 0;
  if (typeof setShelfHoverTabVisible === 'function') setShelfHoverTabVisible(false);
  if (shelfManager && shelfManager.clearSelected) shelfManager.clearSelected();
  if (hasContent && shelfManager.closeContent) safeShelfCloseContent('shelf-mode-reset');
  if (shelfPinnedOpen) setShelfPinnedOpen(false, true);
  shelfVisibility = 0;
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
function suppressShelfPreviewForPlaybackSwitch() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return;
  if (shelfPinnedOpen || (shelfManager.hasOpenContent && shelfManager.hasOpenContent())) return;
  updateShelfHoverCueFromPointer(null);
  shelfHoverCue.target = 0;
  shelfHoverCue.value = 0;
  shelfHoverCue.zoneActive = false;
  shelfHoverCue.enteredAt = 0;
  shelfHoverCue.guide = false;
  shelfVisibility = 0;
  if (typeof setShelfHoverTabVisible === 'function') setShelfHoverTabVisible(false);
  if (shelfManager && shelfManager.clearSelected) shelfManager.clearSelected();
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
function makeShelfManager() {
  var group = null;
  var cards = [];          // [{canvas, ctx, texture, mesh, item, index, slot}]
  var allItems = [];
  var renderedStart = -1;
  var SHELF_VISIBLE_RADIUS = 5;
  var SHELF_MAX_RENDER = SHELF_VISIBLE_RADIUS * 2 + 1;
  var shelfPane = 'mine';       // mine | fav
  var collectionReveal = 0;     // 滚轮阻尼累积，用于打开/返回收藏歌单
  var paneMemory = { mine:0, fav:0 };
  var paneSwitchAt = -10;
  var paneSwitchDir = 1;
  var mode = 'side';
  var lastSig = '';
  var lastUpdate = 0;
  var lastCardRedrawAt = -10;
  var lastCardPulseBucket = -1;
  var cardBuildQueue = null;
  var selectedIdx = -1;

  // v7.2 PSP 风格状态
  var centerIdx = 0;          // 当前居中卡片 index (在 items 数组中的位置)
  var centerTarget = 0;       // 目标 centerIdx (插值)
  var centerSmooth = 0;       // 当前实际 centerIdx 平滑值
  var openCardIdx = -1;       // 已打开内容框的卡片 (-1 表示无)
  var contentList = null;     // 二级 PSP 滚动列表 manager
  var connectorParticles = null;
  var floorMirror = null;

  // 一次性返回完整 items 数组 (不只 5 张, 全部参与 PSP 滚动)
  function splitPlaylists() {
    var mine = [], fav = [];
    userPlaylists.forEach(function(pl) {
      (pl.subscribed ? fav : mine).push(pl);
    });
    return { mine: mine, fav: fav };
  }

  function shelfShowsPodcasts() {
    return !fx || fx.shelfShowPodcasts !== false;
  }

  function shelfMergesCollections() {
    return !!(fx && fx.shelfMergeCollections === true);
  }

  function activePlaylists() {
    var panes = splitPlaylists();
    if (shelfMergesCollections()) return panes.mine.concat(panes.fav);
    var source = (shelfPane === 'fav') ? panes.fav : panes.mine;
    if (!source.length && shelfPane === 'mine' && panes.fav.length) source = panes.fav;
    if (!source.length && shelfPane === 'fav' && panes.mine.length) source = panes.mine;
    return source;
  }

  function currentItems() {
    if (hasAnyPlatformLogin() && (userPlaylists.length || myPodcastCollections.length)) {
      var source = activePlaylists();
      var items = source.map(function(pl){
        var provider = pl.provider === 'qq' ? 'qq' : (pl.provider === 'kg' ? 'kg' : 'netease');
        var sourceLabel = provider === 'qq' ? 'QQ' : (provider === 'kg' ? 'KG' : 'NE');
        return { type:'playlist', title: pl.name, sub:sourceLabel + ' · ' + (pl.trackCount||0)+' 首 · 播放 '+compactCount(pl.playCount||0),
          cover: normalizeShelfCoverUrl(pl.cover) || pl.cover || '', tag: pl.subscribed ? '收藏歌单' : '我的歌单', playlistId: playlistPanelProviderId(provider, pl.id), provider: provider };
      });
      if (shelfShowsPodcasts() && (shelfPane === 'mine' || shelfMergesCollections()) && myPodcastCollections.length) {
        myPodcastCollections.forEach(function(pc){
          items.push({ type:'podcastCollection', title: pc.title, sub:(pc.count || 0) + ' items', cover: pc.cover || '', tag:'我的播客', podcastKey: pc.key, itemType: pc.itemType });
        });
      }
      if (items.length) return items;
    }
    if (playQueue.length) {
      return playQueue.map(function(song, idx){
        return { type:'queue', title: song.name, sub: song.artist || '未知歌手',
          cover: songCoverSrc(song, 360), tag: idx === currentIdx ? '正在播放' : ('#' + (idx+1)), queueIndex: idx };
      });
    }
    return [];
  }

  function makeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    var chars = String(text || '').split('');
    var line = '', lines = [];
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line); line = chars[i];
        if (lines.length >= maxLines - 1) break;
      } else line = test;
    }
    if (line && lines.length < maxLines) lines.push(line);
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], x, y + j * lineHeight);
  }
  function cardDrawSignature(card, item) {
    item = item || {};
    var rec = item.cover ? playlistCoverCacheRec(item.cover) : null;
    var coverState = item.cover ? (rec && rec.loaded ? 'ready' : (rec && rec.failed ? 'fail' : 'wait')) : 'none';
    var pulseBucket = card && card.isCenter ? Math.round((bass + beatPulse * 0.85) * 6) : 0;
    return [
      item.type || '', item.title || '', item.sub || '', item.tag || '',
      item.playlistId || '', item.podcastKey || '', item.queueIndex == null ? '' : item.queueIndex,
      item.cover || '', coverState, card && card.isCenter ? 1 : 0, card && card.selected ? 1 : 0,
      card && card.dofBucket == null ? -1 : card.dofBucket, pulseBucket, shelfAccentHex(), shelfSettings().bgOpacity
    ].join('|');
  }

  function drawCard(card, item) {
    item = item || card.item || {};
    var nextDrawKey = cardDrawSignature(card, item);
    if (card.drawKey === nextDrawKey) return;
    card.drawKey = nextDrawKey;
    var cv = card.canvas, ctx = card.ctx;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    var pad = 18;
    var isNow = item.type === 'queue' && item.tag === '正在播放';
    var shelfLook = shelfSettings();

    // 卡片底
    makeRoundRect(ctx, pad, pad, W - pad*2, H - pad*2, 32);
    ctx.fillStyle = 'rgba(0,0,0,' + shelfLook.bgOpacity.toFixed(3) + ')'; ctx.fill();
    var grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(255,255,255,0.018)');
    ctx.fillStyle = grad; ctx.fill();

    if (isNow) {
      ctx.strokeStyle = shelfAccentRgba(0.72);
      ctx.lineWidth = 1.8 + Math.sin(uniforms.uTime.value * 3) * 0.28 + bass * 1.2;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.1;
    }
    ctx.stroke();

    if (card.selected) {
      ctx.save();
      makeRoundRect(ctx, pad + 2, pad + 2, W - pad*2 - 4, H - pad*2 - 4, 30);
      ctx.shadowColor = shelfAccentRgba(0.58);
      ctx.shadowBlur = 18;
      ctx.strokeStyle = shelfAccentRgba(0.72);
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    // 大封面方块
    var coverSize = H - pad*2 - 8;
    var cx = pad + 6, cy = pad + 4;
    makeRoundRect(ctx, cx, cy, coverSize, coverSize, 26);
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fill();
    if (item.cover) {
      var rec = playlistCoverCacheRec(item.cover);
      if (rec && rec.loaded && rec.img) {
        ctx.save(); makeRoundRect(ctx, cx, cy, coverSize, coverSize, 26); ctx.clip();
        ctx.drawImage(rec.img, cx, cy, coverSize, coverSize); ctx.restore();
      } else if (!rec || !rec.loading) {
        if (!rec || !rec.failed || !rec.canvasRetried) {
          requestPlaylistCover(item.cover, function(){
            var latest = playlistCoverCacheRec(item.cover);
            if (latest && latest.failed) latest.canvasRetried = true;
            drawCard(card, item);
          });
        }
      }
    }

    // 文本区
    var tx = pad + coverSize + 32;
    ctx.font = '700 17px Inter, Arial';
    ctx.fillStyle = isNow ? shelfAccentRgba(0.92) : 'rgba(255,255,255,0.92)';
    ctx.fillText(item.tag || '', tx, pad + 36);

    ctx.font = '700 30px Inter, Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    wrapText(ctx, item.title || '', tx, pad + 78, W - tx - pad - 14, 36, 2);

    ctx.font = '400 17px Inter, Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.52)';
    wrapText(ctx, item.sub || '', tx, pad + 156, W - tx - pad - 14, 24, 2);

    // 律动进度条
    ctx.strokeStyle = isNow ? shelfAccentRgba(0.90) : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(tx, H - pad - 22);
    ctx.lineTo(tx + Math.min(260, 80 + bass * 320), H - pad - 22);
    ctx.stroke();

    if (card.isCenter) {
      var actionY = H - pad - 78;
      if (item.type === 'playlist') {
        makeRoundRect(ctx, tx, actionY, 138, 38, 18);
        var playGrad = ctx.createLinearGradient(tx, actionY, tx + 138, actionY + 38);
        playGrad.addColorStop(0, 'rgba(255,255,255,0.88)');
        playGrad.addColorStop(0.55, shelfAccentRgba(0.94));
        playGrad.addColorStop(1, shelfAccentRgba(0.58));
        ctx.fillStyle = playGrad; ctx.fill();
        ctx.strokeStyle = shelfAccentRgba(0.44);
        ctx.lineWidth = 1.1; ctx.stroke();
        ctx.font = '800 14px Inter, "Microsoft YaHei", Arial';
        ctx.fillStyle = readableInkForHex(shelfAccentHex());
        ctx.fillText('▶ 播放歌单', tx + 25, actionY + 24);

        makeRoundRect(ctx, tx + 150, actionY, 104, 38, 18);
        ctx.fillStyle = 'rgba(255,255,255,0.055)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1.1; ctx.stroke();
        ctx.font = '700 14px Inter, "Microsoft YaHei", Arial';
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillText('详情', tx + 184, actionY + 24);
      } else if (item.type === 'queue') {
        ctx.font = '600 14px Inter, "Microsoft YaHei", Arial';
        ctx.fillStyle = shelfAccentRgba(0.84);
        ctx.fillText('点击播放', tx, actionY + 25);
      }
    }

    var dof = card.dofBlur || 0;
    if (dof > 0.12) {
      makeRoundRect(ctx, pad, pad, W - pad*2, H - pad*2, 32);
      ctx.fillStyle = 'rgba(0,0,0,' + Math.min(0.28, dof * 0.18).toFixed(3) + ')';
      ctx.fill();
    }

    card.texture.needsUpdate = true;
  }

  function buildOneCard(item, i) {
    var cv = document.createElement('canvas');
    cv.width = 720; cv.height = 360;
    var ctx = cv.getContext('2d');
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    var mat = new THREE.MeshBasicMaterial({ map: tx, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    var geo = new THREE.PlaneGeometry(2.05, 1.025, 1, 1);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 50 + i;
    mesh.userData.action = item.type === 'playlist'
      ? { kind:'loadPlaylist', playlistId: item.playlistId, title: item.title }
      : (item.type === 'podcastCollection'
        ? { kind:'loadPlaylist', playlistId: 'podcast:' + item.podcastKey, title: item.title }
        : (item.type === 'queue' ? { kind:'playQueue', index: item.queueIndex } : { kind:'empty' }));
    group.add(mesh);
    var card = { canvas: cv, ctx: ctx, texture: tx, mesh: mesh, item: item, index: i, isCenter: false, selected: i === selectedIdx, floatMix: 0, fxPulse: 0, dofBlur: 0, dofBucket: -1, drawKey: '' };
    return card;
  }

  function warmTextureUpload(tex) {
    if (!tex || !renderer || typeof renderer.initTexture !== 'function') return;
    try { renderer.initTexture(tex); } catch (e) {}
  }

  function cancelCardBuildQueue() {
    if (!cardBuildQueue) return;
    cardBuildQueue.cancelled = true;
    if (cardBuildQueue.raf) cancelAnimationFrame(cardBuildQueue.raf);
    cardBuildQueue = null;
  }

  function disposeRenderedCards() {
    cancelCardBuildQueue();
    while (group && group.children.length) {
      var ch = group.children.pop();
      if (ch.material) { if (ch.material.map) ch.material.map.dispose(); ch.material.dispose(); }
      if (ch.geometry) ch.geometry.dispose();
    }
    cards = [];
    renderedStart = -1;
  }

  function scheduleQueuedCardBuild(job) {
    function step(deadline) {
      if (!job || job.cancelled || cardBuildQueue !== job || !group) return;
      var started = performance.now();
      var built = 0;
      while (job.next <= job.end && built < 2 && performance.now() - started < 7) {
        var card = buildOneCard(allItems[job.next], job.next);
        cards.push(card);
        drawCard(card, card.item);
        warmTextureUpload(card.texture);
        job.next += 1;
        built += 1;
      }
      if (job.next <= job.end) {
        if (window.requestIdleCallback) {
          requestIdleCallback(step, { timeout: 180 });
        } else {
          job.raf = requestAnimationFrame(step);
        }
      } else {
        cardBuildQueue = null;
      }
    }
    if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 180 });
    else job.raf = requestAnimationFrame(step);
  }

  function syncRenderedWindow(force, asyncBuild) {
    if (!group) return;
    var total = allItems.length;
    if (!total) { disposeRenderedCards(); return; }
    var center = Math.round(centerTarget);
    var start = Math.max(0, center - SHELF_VISIBLE_RADIUS);
    var end = Math.min(total - 1, start + SHELF_MAX_RENDER - 1);
    start = Math.max(0, end - SHELF_MAX_RENDER + 1);
    if (!force && start === renderedStart && cards.length === (end - start + 1)) {
      cards.forEach(function(c) {
        var nextItem = allItems[c.index] || c.item;
        if (c.item !== nextItem) {
          c.item = nextItem;
          c.drawKey = '';
          drawCard(c, c.item);
        }
      });
      return;
    }
    disposeRenderedCards();
    renderedStart = start;
    if (asyncBuild) {
      cardBuildQueue = { start:start, end:end, next:start, cancelled:false, raf:0 };
      scheduleQueuedCardBuild(cardBuildQueue);
      return;
    }
    for (var itemIdx = start; itemIdx <= end; itemIdx++) {
      var card = buildOneCard(allItems[itemIdx], itemIdx);
      cards.push(card);
      drawCard(card, card.item);
    }
  }

  function rebuild(asyncCards) {
    if (!group) return;
    disposeRenderedCards();
    if (connectorParticles) {
      if (connectorParticles.parent) connectorParticles.parent.remove(connectorParticles);
      if (connectorParticles.geometry) connectorParticles.geometry.dispose();
      if (connectorParticles.material) connectorParticles.material.dispose();
      connectorParticles = null;
    }
    if (floorMirror) {
      if (floorMirror.parent) floorMirror.parent.remove(floorMirror);
      if (floorMirror.geometry) floorMirror.geometry.dispose();
      if (floorMirror.material) floorMirror.material.dispose();
      floorMirror = null;
    }
    allItems = currentItems();
    lastSig = sig(allItems);
    lastCardRedrawAt = -10;
    lastCardPulseBucket = -1;
    // center 起始 = currentIdx (如果是 queue), 否则 0
    if (allItems.length && allItems[0].type === 'queue' && currentIdx >= 0) {
      centerTarget = Math.min(allItems.length - 1, currentIdx);
      centerSmooth = centerTarget;
      centerIdx = centerTarget;
    } else if (centerTarget >= allItems.length) {
      centerTarget = Math.max(0, allItems.length - 1);
      centerSmooth = centerTarget;
    }
    if (selectedIdx >= allItems.length) selectedIdx = -1;
    syncRenderedWindow(true, !!asyncCards);
    if (mode === 'stage') {
      createStageExtras();
    }
  }

  // ====================================================
  //  PSP 弧形布局: 以 centerSmooth 为基准, 卡片绕弧排列
  //  i 距离 center 越远 → 越靠后, 越小, 越淡
  // ====================================================
  function placeCard(card, i, totalCards, modeIs) {
    var delta = card.index - centerSmooth;     // 正=下方, 负=上方
    var absD = Math.abs(delta);
    // 隐藏太远的卡 (>4 全隐藏)
    if (absD > SHELF_VISIBLE_RADIUS + 0.5) { card.mesh.visible = false; return; }
    card.mesh.visible = true;
    card.mesh.renderOrder = 60 + Math.round((SHELF_VISIBLE_RADIUS + 1 - Math.min(absD, SHELF_VISIBLE_RADIUS + 1)) * 10);
    var parX = pointerParallax.x || 0;
    var parY = pointerParallax.y || 0;
    var parWeight = Math.max(0, 1 - absD * 0.16);
    var pulse = card.fxPulse || 0;
    var layout = shelfLayoutProfile();
    var shelfLook = shelfSettings();
    var nextDof = Math.max(0, Math.min(1, (absD - 0.45) / 3.2));
    var nextDofBucket = Math.round(nextDof * 5);
    if (card.dofBucket !== nextDofBucket) {
      card.dofBucket = nextDofBucket;
      card.dofBlur = nextDof;
      drawCard(card, card.item);
    }

    if (modeIs === 'side') {
      // 右侧 3D 架: 恢复更靠近、更斜切的打开姿态，让卡片有真正的前后层次。
      var detailOpenSide = contentList && contentList.isOpen();
      var nowT = uniforms.uTime.value;
      var hoverBreath = (!shelfPinnedOpen && !detailOpenSide) ? shelfVisibility : 0;
      var passiveAlways = shelfAlwaysVisible() && !shelfPinnedOpen && !detailOpenSide;
      var liftTarget = card.selected && !detailOpenSide ? 1 : 0;
      var liftRate = liftTarget > (card.floatMix || 0) ? 0.20 : 0.13;
      card.floatMix = (card.floatMix || 0) + (liftTarget - (card.floatMix || 0)) * liftRate;
      if (!liftTarget && card.floatMix < 0.004) card.floatMix = 0;
      var lift = card.floatMix || 0;
      var sideLayer = Math.max(0, SHELF_VISIBLE_RADIUS + 1 - Math.min(absD, SHELF_VISIBLE_RADIUS + 1));
      card.mesh.renderOrder = passiveAlways
        ? (30 + Math.round(sideLayer * 1.1) + Math.round(lift * 96))
        : (60 + Math.round(sideLayer * 10) + Math.round(lift * 70));
      var breathPulse = hoverBreath * (0.5 + 0.5 * Math.sin(nowT * 1.22 + card.index * 0.74));
      var revealRaw = Math.max(0, Math.min(1, (nowT - shelfOpenAnimAt - absD * 0.035) / 0.62));
      var reveal = revealRaw * revealRaw * (3 - 2 * revealRaw);
      var entry = (1 - reveal) * (0.82 + absD * 0.075);
      var paneRaw = Math.max(0, Math.min(1, (nowT - paneSwitchAt - absD * 0.030) / 0.72));
      var paneEase = 1 - paneRaw * paneRaw * (3 - 2 * paneRaw);
      var wallpaperShelfPose = shouldUseWallpaperSafeShelfCamera();
      var skullShelfPose = shouldUseSkullSafeShelfCamera();
      var safeShelfPose = wallpaperShelfPose || skullShelfPose;
      var px = layout.sideX + absD * layout.sideXStep - (detailOpenSide ? layout.sideDetailShift : 0) + entry * layout.sideEntryX;
      var py = (layout.sideY || 0) - delta * layout.sideYStep + (1 - reveal) * (delta < 0 ? -0.18 : 0.18);
      var pz = layout.sideZ - absD * layout.sideZStep - (1 - reveal) * 0.20;
      px += paneEase * paneSwitchDir * 0.60;
      py += paneEase * (delta < 0 ? -0.16 : 0.16);
      pz -= paneEase * 0.22;
      px += parX * 0.060 * parWeight;
      py += parY * 0.046 * parWeight;
      pz += (parY * 0.026 - parX * 0.028) * parWeight;
      py += Math.sin(nowT * 0.92 + card.index * 0.64) * 0.052 * hoverBreath * Math.max(0.20, parWeight);
      pz += Math.cos(nowT * 0.78 + card.index * 0.52) * 0.030 * hoverBreath * parWeight;
      if (lift > 0.001) {
        px -= lift * (skullShelfPose ? 0.035 : (layout.portrait ? 0.065 : 0.145));
        py += lift * (skullShelfPose ? 0.045 : (layout.portrait ? 0.075 : 0.105));
        pz += lift * (skullShelfPose ? 0.080 : 0.220);
      }
      var scale = (absD < 0.5 ? 1.12 : Math.max(0.55, 1.04 - absD * 0.14)) * (0.88 + reveal * 0.12) * (1 + pulse * 0.056 + breathPulse * 0.026 + lift * (skullShelfPose ? 0.045 : 0.075)) * layout.sideScale;
      if (wallpaperShelfPose) scale *= 1.22;
      else if (skullShelfPose) scale *= 1.04;
      card.mesh.position.set(px, py, pz);
      if (skullShelfPose && camera) {
        card.mesh.quaternion.copy(camera.quaternion);
        card.mesh.rotateX(layout.sideRotX - delta * 0.008 - parY * 0.004 * parWeight);
        card.mesh.rotateY(layout.sideRotY + (1 - reveal) * 0.012 + parX * 0.006 * parWeight);
      } else {
        var safeRotY = wallpaperShelfPose ? 0.12 : layout.sideRotY;
        var safeEntryRotY = wallpaperShelfPose ? 0.05 : 0.16;
        card.mesh.rotation.y = (safeShelfPose ? safeRotY : layout.sideRotY) + (1 - reveal) * safeEntryRotY + parX * (safeShelfPose ? 0.014 : 0.038) * parWeight;
        var safeRotX = wallpaperShelfPose ? 0.020 : layout.sideRotX;
        card.mesh.rotation.x = -delta * (safeShelfPose ? safeRotX : layout.sideRotX) - parY * (safeShelfPose ? 0.010 : 0.024) * parWeight;
      }
      card.mesh.scale.setScalar(scale);
      var disabledByDetail = detailOpenSide;
      var opacity = absD < 0.5 ? 1.0 : Math.max(0.22, 1.0 - absD * 0.30);
      if (disabledByDetail) {
        opacity *= card.index === openCardIdx ? 0.16 : 0.08;
        card.mesh.material.color.setScalar(card.index === openCardIdx ? 0.42 : 0.25);
      } else {
        if (passiveAlways) opacity *= 0.92 + lift * 0.08;
        card.mesh.material.color.setScalar(passiveAlways ? (0.96 + lift * 0.04) : 1);
      }
      // v8: 自动隐藏 — shelf 不在 focus 区时整体淡化
      card.mesh.material.opacity = Math.min(1, opacity * (shelfVisibility != null ? shelfVisibility : 1) * reveal * (1 - paneEase * 0.24) + pulse * 0.10 * reveal + breathPulse * 0.035) * shelfLook.opacity;
      setCardCenter(card, absD < 0.5);
    } else {
      // 舞台 PSP: 水平展开 + center 突出, dock 在底部
      var pxStage = (layout.stageX || 0) + delta * layout.stageXStep;
      var pyStage = layout.stageY;
      var pzStage = absD < 0.5 ? layout.stageZ : (layout.stageZ - Math.min(2.0, absD) * 0.55);
      var paneRawS = Math.max(0, Math.min(1, (uniforms.uTime.value - paneSwitchAt - absD * 0.030) / 0.72));
      var paneEaseS = 1 - paneRawS * paneRawS * (3 - 2 * paneRawS);
      pxStage += paneEaseS * paneSwitchDir * 0.80;
      pzStage -= paneEaseS * 0.28;
      pxStage += parX * 0.110 * parWeight;
      pyStage += parY * 0.060 * parWeight;
      pzStage += (parY * 0.040 - parX * 0.035) * parWeight;
      var scaleS = (absD < 0.5 ? 1.20 : Math.max(0.45, 1.0 - absD * 0.22)) * (1 + pulse * 0.060) * layout.stageScale;
      card.mesh.position.set(pxStage, pyStage, pzStage);
      card.mesh.rotation.y = -delta * 0.22 + parX * 0.050 * parWeight;
      card.mesh.rotation.x = 0.10 - absD * 0.04 - parY * 0.028 * parWeight;
      card.mesh.scale.setScalar(scaleS);
      var disabledStage = contentList && contentList.isOpen();
      var opS = absD < 0.5 ? 1.0 : Math.max(0.18, 1.0 - absD * 0.32);
      if (disabledStage) {
        opS *= card.index === openCardIdx ? 0.16 : 0.08;
        card.mesh.material.color.setScalar(card.index === openCardIdx ? 0.42 : 0.25);
      } else {
        card.mesh.material.color.setScalar(1);
      }
      card.mesh.material.opacity = Math.min(1, opS * (shelfVisibility != null ? shelfVisibility : 1) * (1 - paneEaseS * 0.24) + pulse * 0.10) * shelfLook.opacity;
      setCardCenter(card, absD < 0.5);
    }
  }

  function setCardCenter(card, isCenter) {
    if (card.isCenter !== isCenter) {
      card.isCenter = isCenter;
      drawCard(card, card.item);
    } else {
      card.isCenter = isCenter;
    }
  }

  function playPlaylistCard(card) {
    if (!card || !card.mesh || !card.mesh.userData) return false;
    var action = card.mesh.userData.action;
    if (!action || action.kind !== 'loadPlaylist' || !action.playlistId) return false;
    if (String(action.playlistId).indexOf('podcast:') === 0) return false;
    pulseCard(card, 1.05);
    if (contentList && contentList.isOpen && contentList.isOpen()) contentList.close();
    openCardIdx = -1;
    setShelfPinnedOpen(false, true);
    if (typeof setFocusZone === 'function') setFocusZone(null, true);
    loadPlaylistIntoQueueById(action.playlistId, true, action.title || (card.item && card.item.title) || '');
    return true;
  }

  function pulseCard(card, amount) {
    if (!card) return;
    pulseObjectValue(card, 'fxPulse', amount || 1, 0.46);
  }

  function createStageExtras() {
    if (!group) return;
    var pcount = 80;
    var pgeo = new THREE.BufferGeometry();
    var ppos = new Float32Array(pcount * 3);
    var pcol = new Float32Array(pcount * 3);
    var prnd = new Float32Array(pcount);
    for (var i = 0; i < pcount; i++) {
      ppos[i*3] = (Math.random() - 0.5) * 6;
      ppos[i*3+1] = (Math.random() - 0.5) * 1.2 + 0.3;
      ppos[i*3+2] = 1.0 + Math.random() * 1.5;
      pcol[i*3] = 0.56; pcol[i*3+1] = 0.91; pcol[i*3+2] = 1.0;
      prnd[i] = Math.random();
    }
    pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
    pgeo.setAttribute('aColor',   new THREE.BufferAttribute(pcol, 3));
    pgeo.setAttribute('aRand',    new THREE.BufferAttribute(prnd, 1));
    var pmat = new THREE.ShaderMaterial({
      uniforms:{ uTime: uniforms.uTime, uPixel: uniforms.uPixel, uDotTex: uniforms.uDotTex },
      vertexShader:`precision highp float; uniform float uTime, uPixel; attribute vec3 aColor; attribute float aRand;
varying vec3 vC; varying float vA;
void main(){
  vec3 p = position;
  p.x += sin(uTime * 0.4 + aRand * 6.0) * 1.5;
  p.y += sin(uTime * 0.6 + aRand * 4.0) * 0.2;
  p.z += cos(uTime * 0.5 + aRand * 5.0) * 0.4;
  vC = aColor; vA = 0.4 + 0.4 * sin(uTime * 1.5 + aRand * 7.0);
  vec4 m = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = 4.0 * uPixel;
  gl_Position = projectionMatrix * m;
}`,
      fragmentShader:`precision highp float; uniform sampler2D uDotTex;
varying vec3 vC; varying float vA;
void main(){ vec4 t = texture2D(uDotTex, gl_PointCoord); if (t.a < 0.02) discard; gl_FragColor = vec4(vC, t.a * vA); }`,
      transparent:true, depthWrite:false, blending: THREE.AdditiveBlending,
    });
    connectorParticles = new THREE.Points(pgeo, pmat);
    connectorParticles.frustumCulled = false;
    connectorParticles.renderOrder = 49;
    connectorParticles.position.set(0, -2.2, 0);
    if (group.parent) group.parent.add(connectorParticles); else scene.add(connectorParticles);
    // 底部地面反射
    var mGeo = new THREE.PlaneGeometry(10, 1.8);
    var mCanvas = document.createElement('canvas'); mCanvas.width = 256; mCanvas.height = 64;
    var mctx = mCanvas.getContext('2d');
    var mg = mctx.createLinearGradient(0, 0, 0, 64);
    mg.addColorStop(0, 'rgba(255,255,255,0.07)'); mg.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = mg; mctx.fillRect(0, 0, 256, 64);
    var mTex = new THREE.CanvasTexture(mCanvas);
    mTex.generateMipmaps = false;
    var mMat = new THREE.MeshBasicMaterial({ map: mTex, transparent:true, depthWrite:false, opacity:0.55 });
    floorMirror = new THREE.Mesh(mGeo, mMat);
    floorMirror.position.set(0, -2.85, 0.4);
    floorMirror.rotation.x = -Math.PI / 2;
    if (group.parent) group.parent.add(floorMirror); else scene.add(floorMirror);
  }

  function sig(items) {
    if (hasAnyPlatformLogin() && (userPlaylists.length || myPodcastCollections.length)) {
      var source = activePlaylists();
      items = items || currentItems();
      var sampleItems = items.slice(0, 3).concat(items.slice(Math.max(3, items.length - 3)));
      return [
        'platform',
        shelfPane,
        shelfMergesCollections() ? 1 : 0,
        shelfShowsPodcasts() ? 1 : 0,
        source.length,
        myPodcastCollections.length,
        sampleItems.map(function(it){
          return [it.type || '', it.playlistId || '', it.podcastKey || '', it.title || '', it.sub || '', it.tag || ''].join('|');
        }).join('||')
      ].join('::');
    }
    items = items || playQueue.map(function(song, idx){
      return { type:'queue', title: song.name, queueIndex: idx };
    });
    var sample = items.slice(0, 3).concat(items.slice(Math.max(3, items.length - 3)));
    return ['queue', items.length, currentIdx, sample.map(function(it){ return [it.type, it.playlistId||'', it.queueIndex||'', it.title||''].join('|'); }).join('||')].join('::');
  }

  function switchPane(nextPane) {
    if (shelfMergesCollections()) return false;
    if (nextPane === shelfPane) return false;
    paneMemory[shelfPane] = Math.max(0, Math.round(centerTarget));
    shelfPane = nextPane;
    collectionReveal = 0;
    var targetList = activePlaylists();
    var remembered = paneMemory[nextPane] || 0;
    centerTarget = Math.max(0, Math.min(Math.max(0, targetList.length - 1), remembered));
    centerSmooth = centerTarget + (nextPane === 'fav' ? 1.85 : -1.85);
    centerIdx = centerTarget;
    paneSwitchAt = uniforms.uTime.value;
    paneSwitchDir = nextPane === 'fav' ? 1 : -1;
    shelfOpenAnimAt = uniforms.uTime.value;
    if (contentList) contentList.close();
    selectedIdx = Math.round(centerTarget);
    playShelfSelectTick(paneSwitchDir, 'card');
    rebuild();
    showToast(nextPane === 'fav' ? '收藏歌单' : '我的歌单');
    return true;
  }

  function applySelectedIndex(idx) {
    idx = idx == null || idx < 0 ? -1 : Math.round(idx);
    selectedIdx = idx;
    cards.forEach(function(c) {
      var next = c.index === selectedIdx;
      if (c.selected !== next) {
        c.selected = next;
        drawCard(c, c.item);
      }
    });
  }

  function step(direction) {
    if (!allItems.length) return;
    var panes = splitPlaylists();
    var atEnd = centerTarget >= allItems.length - 1 && direction > 0;
    var atStart = centerTarget <= 0 && direction < 0;
    if (!shelfMergesCollections()) {
      if (hasAnyPlatformLogin() && userPlaylists.length && shelfPane === 'mine' && atEnd && panes.fav.length) {
        collectionReveal += Math.min(1.5, Math.abs(direction));
        if (collectionReveal >= 3) switchPane('fav');
        return;
      }
      if (hasAnyPlatformLogin() && userPlaylists.length && shelfPane === 'fav' && atStart && panes.mine.length) {
        collectionReveal += Math.min(1.5, Math.abs(direction));
        if (collectionReveal >= 3) switchPane('mine');
        return;
      }
    }
    collectionReveal = 0;
    var prevTarget = Math.round(centerTarget);
    centerTarget = Math.max(0, Math.min(allItems.length - 1, centerTarget + direction));
    var nextTarget = Math.round(centerTarget);
    paneMemory[shelfPane] = Math.max(0, Math.round(centerTarget));
    syncRenderedWindow(false);
    applySelectedIndex(nextTarget);
    if (nextTarget !== prevTarget) playShelfSelectTick(direction, 'card');
    pulseCard(cards.find(function(c){ return c.index === nextTarget; }), 0.55);
  }

  function screenHitCard(card, sx, sy, pad) {
    if (!card || !card.mesh || !card.mesh.visible || !group || !group.visible) return null;
    var params = card.mesh.geometry && card.mesh.geometry.parameters || {};
    var hw = (params.width || 1.7) / 2;
    var hh = (params.height || 0.85) / 2;
    var pts = [
      new THREE.Vector3(-hw, -hh, 0),
      new THREE.Vector3( hw, -hh, 0),
      new THREE.Vector3( hw,  hh, 0),
      new THREE.Vector3(-hw,  hh, 0),
    ];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    card.mesh.updateMatrixWorld(true);
    for (var i = 0; i < pts.length; i++) {
      pts[i].applyMatrix4(card.mesh.matrixWorld).project(camera);
      var x = (pts[i].x + 1) * innerWidth / 2;
      var y = (1 - pts[i].y) * innerHeight / 2;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    pad = pad == null ? 28 : pad;
    if (sx < minX - pad || sx > maxX + pad || sy < minY - pad || sy > maxY + pad) return null;
    var u = clampRange((sx - minX) / Math.max(1, maxX - minX), 0, 1);
    var v = 1 - clampRange((sy - minY) / Math.max(1, maxY - minY), 0, 1);
    return { x: u, y: v };
  }

  function pickCardAtScreen(sx, sy, pad) {
    if (!cards.length || !group || !group.visible) return null;
    var ordered = cards.slice().sort(function(a, b){ return (b.mesh.renderOrder || 0) - (a.mesh.renderOrder || 0); });
    for (var i = 0; i < ordered.length; i++) {
      var uv = screenHitCard(ordered[i], sx, sy, pad == null ? 72 : pad);
      if (uv) return { card: ordered[i], uv: uv, screenPick: true };
    }
    return null;
  }

  return {
    setMode: function(m) {
      if (m === mode && group) return;
      mode = m;
      if (m === 'off') {
        if (group) { scene.remove(group); cards.forEach(function(c){ c.texture.dispose(); c.mesh.material.dispose(); c.mesh.geometry.dispose(); }); }
        if (connectorParticles) { scene.remove(connectorParticles); connectorParticles.geometry.dispose(); connectorParticles.material.dispose(); connectorParticles = null; }
        if (floorMirror) { scene.remove(floorMirror); floorMirror.geometry.dispose(); floorMirror.material.dispose(); floorMirror = null; }
        group = null; cards = [];
        if (contentList) contentList.close();
        return;
      }
      if (!group) {
        group = new THREE.Group();
        group.renderOrder = 50;
        scene.add(group);
      }
      var asyncCards = mode === 'side' && document.body.classList.contains('splash-active');
      rebuild(asyncCards);
    },
    getMode: function(){ return mode; },
    update: function(dt) {
      if (!group) return;
      // PSP 滚动平滑
      centerSmooth += (centerTarget - centerSmooth) * 0.16;
      if (Math.abs(centerSmooth - centerTarget) < 0.001) centerSmooth = centerTarget;
      var px = pointerParallax.x, py = pointerParallax.y;
      var appRevealed = !document.body.classList.contains('splash-active');
      var cueVis = tickShelfHoverCue(dt);
      // v8: shelf 自动可见度 — 启动页期间不显示；侧栏只在右侧停留时淡入。
      var targetVis;
      if (!appRevealed) {
        targetVis = 0;
      } else if (mode === 'side') {
        var contentOpen = contentList && contentList.isOpen();
        if (!allItems.length && !contentOpen) targetVis = 0;
        else targetVis = (contentOpen || shelfPinnedOpen || shelfAlwaysVisible()) ? 1.0 : (cueVis > 0.01 ? Math.max(0.16, cueVis * 0.88) : 0);
      } else {
        targetVis = allItems.length ? 1.0 : 0;
      }
      shelfVisibility += (targetVis - shelfVisibility) * (targetVis > shelfVisibility ? 0.22 : 0.18);
      if (shelfVisibility < 0.01 && targetVis === 0) shelfVisibility = 0;
      group.visible = appRevealed && (mode !== 'side' || shelfVisibility > 0) && (allItems.length > 0 || (contentList && contentList.isOpen()));
      if (connectorParticles) connectorParticles.visible = group.visible && mode === 'stage';
      if (floorMirror) floorMirror.visible = group.visible && mode === 'stage';
      if (mode === 'side') {
        var passiveAlwaysGroup = shelfAlwaysVisible() && !shelfPinnedOpen && !(contentList && contentList.isOpen());
        var liftedCardActive = passiveAlwaysGroup && cards.some(function(c){ return c.selected || (c.floatMix || 0) > 0.025; });
        group.renderOrder = passiveAlwaysGroup && !liftedCardActive ? 30 : 50;
        group.position.set(0, 0, 0);
        var bindToCover = shelfAlwaysVisible() && particles && particles.rotation && !(contentList && contentList.isOpen());
        if (bindToCover) {
          group.rotation.x += ((particles.rotation.x - py * 0.010) - group.rotation.x) * 0.075;
          group.rotation.y += ((particles.rotation.y + px * 0.018) - group.rotation.y) * 0.075;
          group.rotation.z += (particles.rotation.z - group.rotation.z) * 0.075;
        } else {
          group.rotation.y += ((px * 0.018) - group.rotation.y) * 0.045;
          group.rotation.x += ((-py * 0.010) - group.rotation.x) * 0.045;
          group.rotation.z += (0 - group.rotation.z) * 0.045;
        }
      } else {
        group.renderOrder = 50;
        var t = uniforms.uTime.value;
        group.position.y = Math.sin(t * 0.3) * 0.04;
        group.position.x = px * 0.10;
        group.rotation.y = px * 0.025;
        group.rotation.x = -py * 0.012;
      }
      for (var i = 0; i < cards.length; i++) {
        placeCard(cards[i], i, cards.length, mode);
      }
      // 内容更新 (节流)
      if (uniforms.uTime.value - lastUpdate > 0.8) {
        lastUpdate = uniforms.uTime.value;
        var nextSig = sig();
        if (nextSig !== lastSig) rebuild();
        else {
          var pulseBucket = Math.round((bass + beatPulse * 0.85) * 10);
          var redrawInterval = playing ? 1.35 : 4.0;
          if (pulseBucket !== lastCardPulseBucket || uniforms.uTime.value - lastCardRedrawAt > redrawInterval) {
            lastCardPulseBucket = pulseBucket;
            lastCardRedrawAt = uniforms.uTime.value;
            cards.forEach(function(c){
              c.item = allItems[c.index] || c.item;
              c.isCenter = Math.abs(c.index - centerSmooth) < 0.5;
              if (c.isCenter || c.dofBucket <= 1 || c.index === currentIdx) drawCard(c, c.item);
            });
          }
        }
      }
      // 二级内容框 update
      if (contentList) contentList.update(dt);
    },
    onCoverChange: function() {
      if (group && mode !== 'off' && uniforms.uTime.value - lastUpdate > 0.2) {
        lastUpdate = uniforms.uTime.value;
        rebuild();
      }
    },
    rebuild: rebuild,
    refreshTheme: function() {
      cards.forEach(function(c) {
        c.drawKey = '';
        drawCard(c, c.item);
      });
      if (contentList && contentList.refreshTheme) contentList.refreshTheme();
    },
    raycastCards: function(raycaster) {
      if (!group || !group.visible || !cards.length) return null;
      var visibleMeshes = cards.filter(function(c){ return c.mesh.visible; }).map(function(c){ return c.mesh; });
      var hits = raycaster.intersectObjects(visibleMeshes, false);
      if (!hits.length) return null;
      var card = cards.find(function(c){ return c.mesh === hits[0].object; });
      return { card: card, point: hits[0].point, uv: hits[0].uv };
    },
    pickCardAtScreen: pickCardAtScreen,
    // PSP 步进
    next: function() { step(1); },
    prev: function() { step(-1); },
    scrollBy: function(d) { step(d); },
    getCenterIdx: function() { return Math.round(centerSmooth); },
    getCardAt: function(idx) { return cards.find(function(c){ return c.index === idx; }); },
    getCards: function() { return cards; },
    playPlaylistAt: function(idx) {
      return playPlaylistCard(cards.find(function(c){ return c.index === idx; }));
    },
    clearSelected: function() {
      applySelectedIndex(-1);
    },
    setSelected: function(idx) {
      applySelectedIndex(idx);
    },
    triggerAction: function(action) {
      if (!action) return;
      var card = cards.find(function(c) { return c.mesh.userData.action === action; });
      pulseCard(card, action.kind === 'loadPlaylist' ? 1.0 : 0.70);
      if (action.kind === 'playQueue') {
        playQueueAt(action.index);
      } else if (action.kind === 'loadPlaylist') {
        if (!contentList) contentList = makeContentListManager();
        openCardIdx = card ? card.index : -1;
        contentList.open(action.playlistId, action.title || (card && card.item.title), card);
        setShelfPinnedOpen(true, true);
        if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
        if (typeof setFocusZone === 'function') setFocusZone('shelf-detail', true);
      } else if (action.kind === 'empty') {
        togglePlaylistPanel(true);
      }
    },
    // 二级内容框 open/close
    openContent: function(cardIdx) {
      var card = cards.find(function(c){ return c.index === cardIdx; });
      if (!card) return;
      var action = card.mesh.userData.action;
      if (!action) return;
      pulseCard(card, 1.0);
      // queue 类型 → 直接播放, 不需要内容框
      if (action.kind === 'playQueue') {
        playQueueAt(action.index);
        return;
      }
      if (action.kind === 'loadPlaylist') {
        if (!contentList) contentList = makeContentListManager();
        openCardIdx = card.index;
        contentList.open(action.playlistId, action.title || card.item.title, card);
        setShelfPinnedOpen(true, true);
        if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
        if (typeof setFocusZone === 'function') setFocusZone('shelf-detail', true);
      }
      if (action.kind === 'empty') togglePlaylistPanel(true);
    },
    closeContent: function() {
      openCardIdx = -1;
      if (contentList) contentList.close();
      var hint = document.getElementById('hint');
      if (hint) hint.classList.toggle('shelf-hidden', shelfPinnedOpen);
      if (typeof setFocusZone === 'function') setFocusZone(shelfPinnedOpen ? 'shelf-side' : null, true);
      if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
    },
    hasOpenContent: function() { return contentList && contentList.isOpen(); },
    getContentList: function() { return contentList; },
    getOpenContentIndex: function() { return openCardIdx; },
    canInteract: function() { return mode !== 'off' && allItems.length > 0; }
  };
}
shelfManager = makeShelfManager();
function safeShelfRebuild(reason, asyncCards) {
  if (!shelfManager || typeof shelfManager.rebuild !== 'function') return false;
  try {
    shelfManager.rebuild(asyncCards);
    return true;
  } catch (e) {
    console.warn('[ShelfRebuild]', reason || 'unknown', e);
    return false;
  }
}
var deferredShelfRebuild = { raf: 0, reason: '', asyncCards: true, token: 0 };
function scheduleShelfRebuild(reason, asyncCards) {
  deferredShelfRebuild.reason = reason || deferredShelfRebuild.reason || 'deferred';
  deferredShelfRebuild.asyncCards = asyncCards !== false;
  deferredShelfRebuild.token += 1;
  var token = deferredShelfRebuild.token;
  if (deferredShelfRebuild.raf) cancelAnimationFrame(deferredShelfRebuild.raf);
  deferredShelfRebuild.raf = requestAnimationFrame(function(){
    deferredShelfRebuild.raf = 0;
    scheduleUiWarmTask(function(){
      if (token !== deferredShelfRebuild.token) return;
      safeShelfRebuild(deferredShelfRebuild.reason, deferredShelfRebuild.asyncCards);
    }, 260);
  });
}
function safeShelfCloseContent(reason) {
  if (!shelfManager || typeof shelfManager.closeContent !== 'function') return false;
  try {
    shelfManager.closeContent();
    return true;
  } catch (e) {
    console.warn('[ShelfCloseContent]', reason || 'unknown', e);
    return false;
  }
}
function isPlaylistPanelVisibleForRender() {
  var panel = document.getElementById('playlist-panel');
  var panelOpen = panel && (panel.classList.contains('show') || panel.classList.contains('peek') || panel.classList.contains('pinned'));
  return !!(panelOpen || miniQueueOpen);
}
function safeRenderQueuePanel(reason, opts) {
  opts = opts || {};
  if (!isPlaylistPanelVisibleForRender() && opts.deferWhenHidden !== false) {
    queuePanelDirty = true;
    return true;
  }
  try {
    renderQueuePanel(opts);
    queuePanelDirty = false;
    return true;
  } catch (e) {
    console.warn('[QueuePanelRender]', reason || 'unknown', e);
    return false;
  }
}
function flushDeferredQueuePanel(reason) {
  if (!queuePanelDirty) return;
  safeRenderQueuePanel(reason || 'flush-deferred-queue', { animate: false, scrollCurrent: miniQueueOpen, deferWhenHidden: false });
}
function safeSwitchPlaylistTab(tab, reason) {
  try {
    switchPlaylistTab(tab);
    return true;
  } catch (e) {
    console.warn('[PlaylistTabSwitch]', reason || tab || 'unknown', e);
    return false;
  }
}
window.addEventListener('blur', clearShelfPreviewOnPointerExit);
document.addEventListener('mouseleave', clearShelfPreviewOnPointerExit);
document.addEventListener('mouseout', function(e) {
  if (!e.relatedTarget && !e.toElement) clearShelfPreviewOnPointerExit();
});

// ============================================================
//  二级内容框 (歌单内的歌曲列表) — 同样 PSP 风格滚动
// ============================================================
function makeContentListManager() {
  var group = null;
  var rows = [];           // 每行一张卡 (歌曲)
  var panel = null;
  var allTracks = [];
  var renderedStart = -1;
  var CONTENT_VISIBLE_RADIUS = 5;
  var CONTENT_MAX_RENDER = CONTENT_VISIBLE_RADIUS * 2 + 1;
  var open = false;
  var centerTarget = 0, centerSmooth = 0;
  var playlistTitle = '';
  var contentKind = 'playlist';
  var sourceCard = null;
  var requestToken = 0;
  var openAnimAt = -10;
  var rowAnimAt = -10;
  var panelDirty = true, rowsDirty = true;
  var panelDrawAt = -10, rowDrawAt = -10;
  var LOADING_ANIM_INTERVAL = 1 / 30;
  var DETAIL_BASE = { x: 1.28, y: 0.18, z: 1.36, rx: -0.008, ry: 0.020 };
  function detailLayout() {
    return shelfLayoutProfile().detail || DETAIL_BASE;
  }

  function makeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  function ellipsize(ctx, text, maxWidth) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    var out = text;
    while (out.length > 1 && ctx.measureText(out + '...').width > maxWidth) out = out.slice(0, -1);
    return out + '...';
  }
  function canvasAccent(alpha, fallback) {
    return shelfAccentRgba(alpha, fallback);
  }

  function ensurePanel() {
    if (panel || !group) return;
    var cv = document.createElement('canvas');
    cv.width = 900; cv.height = 1024;
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    var mat = new THREE.MeshBasicMaterial({ map:tx, transparent:true, opacity:0.86, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
    var geo = new THREE.PlaneGeometry(2.62, 3.02, 1, 1);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-0.02, 0.0, 0.20);
    mesh.renderOrder = 232;
    group.add(mesh);
    panel = { canvas:cv, texture:tx, mesh:mesh };
  }

  function drawPanel() {
    ensurePanel();
    if (!panel) return;
    var ctx = panel.canvas.getContext('2d');
    var W = panel.canvas.width, H = panel.canvas.height;
    ctx.clearRect(0, 0, W, H);
    makeRoundRect(ctx, 24, 28, W - 48, H - 56, 34);
    var bg = ctx.createLinearGradient(0, 0, W, H);
    var panelBgAlpha = shelfSettings().bgOpacity;
    bg.addColorStop(0, 'rgba(0,0,0,' + Math.min(0.98, panelBgAlpha + 0.02).toFixed(3) + ')');
    bg.addColorStop(0.42, 'rgba(0,0,0,' + panelBgAlpha.toFixed(3) + ')');
    bg.addColorStop(1, 'rgba(0,0,0,' + Math.max(0.20, panelBgAlpha - 0.04).toFixed(3) + ')');
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.font = '800 38px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = 'rgba(255,246,220,0.94)';
    ctx.fillText(ellipsize(ctx, playlistTitle || '歌单详情', W - 310), 72, 92);
    ctx.font = '500 18px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = canvasAccent(0.62);
    var playableCount = allTracks.filter(function(song){ return song && song.id && song.type !== 'podcast-radio'; }).length;
    var contentCount = allTracks.filter(function(song){ return song && song.id; }).length;
    var isLoading = allTracks.length === 1 && isLoadingLabel(allTracks[0] && allTracks[0].name);
    var countLabel = contentKind === 'podcast'
      ? (contentCount ? (contentCount + ' 项播客内容') : (isLoading ? '正在载入' : '暂无播客内容'))
      : (playableCount ? (playableCount + ' 首歌曲') : (isLoading ? '正在载入' : '暂无可播放歌曲'));
    ctx.fillText(countLabel, 74, 128);
    var coverUrl = sourceCard && sourceCard.item && sourceCard.item.cover;
    var coverSize = 96, coverX = W - 172, coverY = 56;
    makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (coverUrl) {
      var coverRec = playlistCoverCacheRec(coverUrl);
      if (coverRec && coverRec.loaded && coverRec.img) {
        ctx.save();
        makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 22);
        ctx.clip();
        ctx.drawImage(coverRec.img, coverX, coverY, coverSize, coverSize);
        ctx.restore();
      } else if (!coverRec || !coverRec.loading) {
        if (!coverRec || !coverRec.failed || !coverRec.canvasRetried) {
          requestPlaylistCover(coverUrl, function(){
            var latest = playlistCoverCacheRec(coverUrl);
            if (latest && latest.failed) latest.canvasRetried = true;
            drawPanel();
          });
        }
      }
    }
    var sweep = (Math.sin((uniforms.uTime.value || 0) * 1.7) + 1) * 0.5;
    var shine = ctx.createLinearGradient(70, 154, W - 80, 154);
    shine.addColorStop(0, canvasAccent(0));
    shine.addColorStop(Math.max(0.01, sweep * 0.72), canvasAccent(0.14));
    shine.addColorStop(Math.min(0.99, sweep * 0.72 + 0.14), canvasAccent(0.56));
    shine.addColorStop(1, canvasAccent(0));
    ctx.fillStyle = shine;
    ctx.fillRect(72, 154, W - 144, 2);
    panel.texture.needsUpdate = true;
  }

  function disposePanelObject(targetPanel) {
    if (!targetPanel) return;
    if (targetPanel.mesh && targetPanel.mesh.parent) targetPanel.mesh.parent.remove(targetPanel.mesh);
    if (targetPanel.texture) targetPanel.texture.dispose();
    if (targetPanel.mesh && targetPanel.mesh.material) targetPanel.mesh.material.dispose();
    if (targetPanel.mesh && targetPanel.mesh.geometry) targetPanel.mesh.geometry.dispose();
  }

  function disposePanel() {
    disposePanelObject(panel);
    panel = null;
  }

  function isLoadingLabel(text) {
    return /加载中|正在载入/.test(String(text || ''));
  }

  function isLoadingContent() {
    return allTracks.length === 1 && isLoadingLabel(allTracks[0] && allTracks[0].name);
  }

  function drawPanelIfNeeded(force, nowT) {
    nowT = nowT == null ? (uniforms.uTime.value || 0) : nowT;
    if (!force && !panelDirty && (!isLoadingContent() || nowT - panelDrawAt < LOADING_ANIM_INTERVAL)) return;
    drawPanel();
    panelDirty = false;
    panelDrawAt = nowT;
  }

  function drawRow(row, song, isCenter) {
    var cv = row.canvas, ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var isPodcastRadio = !!(song && song.type === 'podcast-radio');
    var playable = !!(song && song.id && !isPodcastRadio);
    var actionReady = playable || isPodcastRadio;
    ctx.clearRect(0, 0, W, H);
    makeRoundRect(ctx, 14, 10, W - 28, H - 20, 22);
    var rowGrad = ctx.createLinearGradient(0, 0, W, H);
    var rowBgAlpha = shelfSettings().bgOpacity;
    var centerRowBgAlpha = isCenter ? Math.max(rowBgAlpha, 0.92) : rowBgAlpha;
    if (isCenter) {
      rowGrad.addColorStop(0, 'rgba(8,14,24,' + Math.min(0.985, centerRowBgAlpha + 0.040).toFixed(3) + ')');
      rowGrad.addColorStop(0.48, 'rgba(0,0,0,' + Math.min(0.985, centerRowBgAlpha + 0.030).toFixed(3) + ')');
      rowGrad.addColorStop(1, 'rgba(0,0,0,' + Math.min(0.98, centerRowBgAlpha + 0.015).toFixed(3) + ')');
    } else {
      rowGrad.addColorStop(0, 'rgba(16,16,20,' + Math.max(0.20, rowBgAlpha - 0.02).toFixed(3) + ')');
      rowGrad.addColorStop(1, 'rgba(0,0,0,' + Math.max(0.20, rowBgAlpha - 0.04).toFixed(3) + ')');
    }
    if (isCenter) {
      ctx.shadowColor = canvasAccent(0.20);
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = rowGrad;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = isCenter ? canvasAccent(0.48) : 'rgba(255,255,255,0.10)';
    ctx.lineWidth = isCenter ? 1.6 : 1;
    ctx.stroke();
    ctx.font = '700 18px Inter, Arial';
    ctx.fillStyle = isCenter ? canvasAccent(0.95) : 'rgba(255,255,255,0.34)';
    var n = String(row.index + 1);
    if (n.length < 2) n = '0' + n;
    ctx.fillText(n, 32, 52);
    var coverSize = 54;
    var coverX = 84;
    var coverY = H/2 - coverSize/2;
    var songCover = resolveSongCoverUrl(song, 80) || '';
    var hasSongCover = !!songCover;
    if (actionReady || hasSongCover) {
      makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 13);
      ctx.fillStyle = isCenter ? canvasAccent(0.12) : 'rgba(255,255,255,0.07)';
      ctx.fill();
      if (hasSongCover) {
        var songCoverRec = playlistCoverCacheRec(songCover);
        if (songCoverRec && songCoverRec.loaded && songCoverRec.img) {
          ctx.save();
          makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 13);
          ctx.clip();
          ctx.drawImage(songCoverRec.img, coverX, coverY, coverSize, coverSize);
          ctx.restore();
        } else if (!songCoverRec || !songCoverRec.loading) {
          if (!songCoverRec || !songCoverRec.failed || !songCoverRec.canvasRetried) {
            requestPlaylistCover(songCover, function(){
              var latest = playlistCoverCacheRec(songCover);
              if (latest && latest.failed) latest.canvasRetried = true;
              if (row && row.mesh && row.mesh.parent) drawRow(row, row.song, !!row.lastCenter);
            });
          }
        }
      }
    }
    // 标题
    var textX = (actionReady || hasSongCover) ? 154 : 82;
    var btnW = 104, btnH = 48, btnX = W - 144, btnY = H/2 - btnH/2;
    var miniBtn = 44, likeX = btnX - 156, collectX = btnX - 104, nextX = btnX - 52;
    var textMax = actionReady && isCenter ? (isPodcastRadio ? btnX - textX - 24 : likeX - textX - 24) : W - textX - 42;
    var loadingRow = !playable && isLoadingLabel(song && song.name);
    if (loadingRow) {
      ctx.font = '700 22px Inter, "Microsoft YaHei", Arial';
      ctx.fillStyle = 'rgba(255,247,224,0.88)';
      ctx.fillText('正在载入歌单', textX, 42);
      var phase = ((uniforms.uTime.value || 0) * 0.85) % 1;
      for (var sk = 0; sk < 3; sk++) {
        var barY = 58 + sk * 13;
        var barW = sk === 0 ? 330 : (sk === 1 ? 250 : 180);
        makeRoundRect(ctx, textX, barY, barW, 7, 4);
        var skGrad = ctx.createLinearGradient(textX, barY, textX + barW, barY);
        var hot = (phase + sk * 0.14) % 1;
        skGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
        skGrad.addColorStop(Math.max(0, hot - 0.18), canvasAccent(0.10));
        skGrad.addColorStop(Math.min(0.99, hot), canvasAccent(0.34));
        skGrad.addColorStop(1, 'rgba(255,255,255,0.08)');
        ctx.fillStyle = skGrad; ctx.fill();
      }
      row.texture.needsUpdate = true;
      return;
    }
    ctx.font = isCenter ? '800 24px Inter, "Microsoft YaHei", Arial' : '600 20px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = isCenter ? 'rgba(255,247,224,0.96)' : 'rgba(255,255,255,0.80)';
    ctx.fillText(ellipsize(ctx, song.name || '', textMax), textX, 44);
    ctx.font = '500 15px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = isCenter ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.64)';
    ctx.fillText(ellipsize(ctx, song.artist || '', textMax), textX, 72);
    // center 行右侧显示红心/收藏/播放按钮
    if (isCenter && actionReady) {
      if (!isPodcastRadio) {
      var liked = isSongLiked(song);
      makeRoundRect(ctx, likeX, btnY + 2, miniBtn, btnH - 4, 15);
      ctx.fillStyle = liked ? 'rgba(255,122,144,0.18)' : 'rgba(255,255,255,0.075)';
      ctx.fill();
      ctx.strokeStyle = liked ? 'rgba(255,122,144,0.52)' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      drawCanvasHeart(ctx, likeX + miniBtn / 2, btnY + 26, 20, liked ? '#ff7a90' : 'rgba(255,255,255,0.76)');

      makeRoundRect(ctx, collectX, btnY + 2, miniBtn, btnH - 4, 15);
      var collectGrad = ctx.createLinearGradient(collectX, btnY + 2, collectX + miniBtn, btnY + btnH);
      collectGrad.addColorStop(0, 'rgba(255,255,255,0.080)');
      collectGrad.addColorStop(1, canvasAccent(0.075));
      ctx.fillStyle = collectGrad;
      ctx.fill();
      ctx.strokeStyle = canvasAccent(0.22);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      var collectCx = collectX + miniBtn / 2;
      var collectCy = btnY + btnH / 2;
      ctx.strokeStyle = canvasAccent(0.72);
      ctx.lineWidth = 2.35;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(collectCx - 11, collectCy + 1);
      ctx.lineTo(collectCx - 11, collectCy + 12);
      ctx.lineTo(collectCx + 11, collectCy + 12);
      ctx.lineTo(collectCx + 11, collectCy + 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(collectCx, collectCy - 9);
      ctx.lineTo(collectCx, collectCy + 5);
      ctx.moveTo(collectCx - 7, collectCy - 2);
      ctx.lineTo(collectCx + 7, collectCy - 2);
      ctx.stroke();

      makeRoundRect(ctx, nextX, btnY + 2, miniBtn, btnH - 4, 15);
      var nextGrad = ctx.createLinearGradient(nextX, btnY + 2, nextX + miniBtn, btnY + btnH);
      nextGrad.addColorStop(0, 'rgba(255,255,255,0.082)');
      nextGrad.addColorStop(0.62, 'rgba(255,255,255,0.045)');
      nextGrad.addColorStop(1, canvasAccent(0.055));
      ctx.fillStyle = nextGrad;
      ctx.fill();
      ctx.strokeStyle = canvasAccent(0.24);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      var nextCx = nextX + miniBtn / 2;
      var nextCy = btnY + btnH / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.90)';
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(nextCx, nextCy - 8);
      ctx.lineTo(nextCx, nextCy + 8);
      ctx.moveTo(nextCx - 8, nextCy);
      ctx.lineTo(nextCx + 8, nextCy);
      ctx.stroke();
      }

      makeRoundRect(ctx, btnX, btnY, btnW, btnH, 18);
      var btnGrad = ctx.createLinearGradient(btnX, btnY, btnX + btnW, btnY + btnH);
      btnGrad.addColorStop(0, 'rgba(255,255,255,0.88)');
      btnGrad.addColorStop(0.56, canvasAccent(0.94));
      btnGrad.addColorStop(1, canvasAccent(0.58));
      ctx.fillStyle = btnGrad; ctx.fill();
      ctx.strokeStyle = canvasAccent(0.42);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = '700 15px Inter, Arial';
      ctx.fillStyle = readableInkForHex(shelfAccentHex());
      ctx.fillText('播放', btnX + 36, btnY + 29);
    }
    row.texture.needsUpdate = true;
  }

  function place(row, i) {
    var delta = row.index - centerSmooth;
    var absD = Math.abs(delta);
    if (absD > CONTENT_VISIBLE_RADIUS + 0.5) { row.mesh.visible = false; return; }
    row.mesh.visible = true;
    row.mesh.renderOrder = 240 + Math.round((CONTENT_VISIBLE_RADIUS + 1 - Math.min(absD, CONTENT_VISIBLE_RADIUS + 1)) * 14);
    var nowT = uniforms.uTime.value;
    var revealRaw = Math.max(0, Math.min(1, (nowT - rowAnimAt - absD * 0.040) / 0.72));
    var reveal = revealRaw * revealRaw * (3 - 2 * revealRaw);
    var parX = pointerParallax.x || 0;
    var parY = pointerParallax.y || 0;
    var parWeight = Math.max(0, 1 - absD * 0.12);
    var pulse = row.fxPulse || 0;
    var settle = group && group.userData ? (group.userData.rowSettle || 0) : 0;
    var layout = detailLayout();
    var shelfLook = shelfSettings();
    var skullDetail = shouldUseSkullSafeShelfCamera();
    var rowBaseX = skullDetail ? 0.22 : -0.04;
    var rowSpreadX = skullDetail ? 0.030 : 0.014;
    var rowIntroX = skullDetail ? 0.58 : 0.38;
    var rowCenterZ = skullDetail ? 0.62 : 0.62;
    var rowBackZ = skullDetail ? 0.58 : 0.58;
    var rowDepthStep = skullDetail ? 0.046 : 0.048;
    var px = rowBaseX + absD * rowSpreadX + (1 - reveal) * (rowIntroX + absD * rowSpreadX);
    var py = -delta * layout.rowStep + (1 - reveal) * (0.20 + (delta < 0 ? -0.10 : 0.10));
    var pz = (absD < 0.5 ? rowCenterZ : (rowBackZ - absD * rowDepthStep)) - (1 - reveal) * (skullDetail ? 0.10 : 0.16);
    px += settle * ((skullDetail ? 0.11 : 0.12) + absD * (skullDetail ? 0.010 : 0.012));
    py += settle * (delta < 0 ? -0.08 : 0.08);
    pz -= settle * (skullDetail ? 0.045 : 0.08);
    px += parX * (skullDetail ? 0.022 : 0.026) * parWeight;
    py += parY * (skullDetail ? 0.024 : 0.036) * parWeight;
    pz += (parY * (skullDetail ? 0.014 : 0.024) - parX * (skullDetail ? 0.010 : 0.020)) * parWeight;
    var scale = (absD < 0.5 ? 1.00 : Math.max(0.66, 0.94 - absD * 0.070)) * (0.90 + reveal * 0.10) * (1 + pulse * 0.052) * (1 - settle * 0.025) * layout.rowScale;
    row.mesh.position.set(px, py, pz);
    row.mesh.scale.setScalar(scale);
    var rowOpacityBase = Math.min(1, (absD < 0.5 ? 1.0 : Math.max(0.34, 1.0 - absD * 0.12)) * reveal + pulse * 0.14);
    var rowOpacityScale = absD < 0.5 ? Math.max(0.94, shelfLook.opacity) : shelfLook.opacity;
    row.mesh.material.opacity = Math.min(1, rowOpacityBase * rowOpacityScale);
    row.mesh.rotation.y = (skullDetail ? -0.070 : 0.10) + (1 - reveal) * (skullDetail ? 0.018 : 0.052) + parX * (skullDetail ? 0.010 : 0.018) * parWeight;
    row.mesh.rotation.x = (skullDetail ? 0.010 : 0) - delta * (skullDetail ? 0.010 : 0.022) - parY * (skullDetail ? 0.006 : 0.014) * parWeight;
  }

  function disposeRowList(rowList) {
    while (rowList.length) {
      var row = rowList.pop();
      if (row.mesh && row.mesh.parent) row.mesh.parent.remove(row.mesh);
      if (row.mesh && row.mesh.material) {
        if (row.mesh.material.map) row.mesh.material.map.dispose();
        row.mesh.material.dispose();
      }
      if (row.mesh && row.mesh.geometry) row.mesh.geometry.dispose();
    }
  }

  function disposeRows() {
    disposeRowList(rows);
    renderedStart = -1;
  }

  function disposeCapturedDetail(targetGroup, targetRows, targetPanel) {
    if (targetGroup && targetGroup.parent) targetGroup.parent.remove(targetGroup);
    disposeRowList(targetRows || []);
    disposePanelObject(targetPanel);
  }

  function startRowsLoadedIntro() {
    rowAnimAt = uniforms.uTime.value;
    panelDirty = true;
    rowsDirty = true;
    if (!group || !group.userData) return;
    group.userData.rowSettle = 1;
    if (window.gsap) {
      window.gsap.killTweensOf(group.userData, 'rowSettle');
      window.gsap.to(group.userData, { rowSettle: 0, duration: 0.76, ease: 'expo.out' });
    } else {
      group.userData.rowSettle = 0;
    }
  }

  function syncRenderedRows(force) {
    if (!group) return;
    var nowT = uniforms.uTime.value || 0;
    var refreshLoading = isLoadingContent() && nowT - rowDrawAt >= LOADING_ANIM_INTERVAL;
    drawPanelIfNeeded(force || refreshLoading, nowT);
    var total = allTracks.length;
    if (!total) { disposeRows(); return; }
    var center = Math.round(centerTarget);
    var start = Math.max(0, center - CONTENT_VISIBLE_RADIUS);
    var end = Math.min(total - 1, start + CONTENT_MAX_RENDER - 1);
    start = Math.max(0, end - CONTENT_MAX_RENDER + 1);
    if (!force && start === renderedStart && rows.length === (end - start + 1)) {
      rows.forEach(function(row) { row.song = allTracks[row.index] || row.song; });
      if (rowsDirty || refreshLoading) {
        rows.forEach(function(row) {
          var isCenter = Math.abs(row.index - centerSmooth) < 0.5;
          drawRow(row, row.song, isCenter);
          row.lastCenter = isCenter;
        });
        rowsDirty = false;
        rowDrawAt = nowT;
      }
      return;
    }
    disposeRows();
    renderedStart = start;
    for (var idx = start; idx <= end; idx++) {
      var row = makeRow(allTracks[idx], idx);
      rows.push(row);
      drawRow(row, row.song, idx === Math.round(centerSmooth));
      row.lastCenter = idx === Math.round(centerSmooth);
    }
    rowsDirty = false;
    rowDrawAt = nowT;
  }

  return {
    isOpen: function() { return open; },
    refreshTheme: function() {
      panelDirty = true;
      rowsDirty = true;
      if (!open || !group) return;
      drawPanelIfNeeded(true);
      syncRenderedRows(true);
    },
    open: async function(playlistId, title, fromCard) {
      open = true;
      playlistTitle = title;
      sourceCard = fromCard;
      var token = ++requestToken;
      openAnimAt = uniforms.uTime.value;
      rowAnimAt = openAnimAt;
      centerTarget = 0;
      centerSmooth = 0;
      panelDirty = true;
      rowsDirty = true;
      panelDrawAt = -10;
      rowDrawAt = -10;
      if (!group) {
        group = new THREE.Group();
        scene.add(group);
      }
      var openLayout = detailLayout();
      var openSkullDetail = shouldUseSkullSafeShelfCamera();
      var openDynamicDetail = !openSkullDetail && shouldUseShelfDynamicCamera('shelf-detail') && camera;
      var openCoverRx = particles && particles.rotation ? particles.rotation.x : 0;
      var openCoverRy = particles && particles.rotation ? particles.rotation.y : 0;
      var openCoverRz = particles && particles.rotation ? particles.rotation.z : 0;
      group.userData.detailIntro = 1;
      group.position.set(openLayout.x + (openSkullDetail ? 0.10 : 0.16), openLayout.y - (openSkullDetail ? 0.02 : 0.024), openLayout.z - (openSkullDetail ? 0.05 : 0.070));
      if ((openSkullDetail || openDynamicDetail) && camera) {
        group.quaternion.copy(camera.quaternion);
        group.rotateX(openLayout.rx);
        group.rotateY(openLayout.ry + (openSkullDetail ? 0.014 : 0.018));
      } else {
        group.rotation.y = openCoverRy * 0.82 + openLayout.ry + 0.018;
        group.rotation.x = openCoverRx * 0.72 + openLayout.rx;
        group.rotation.z = openCoverRz * 0.70;
      }
      group.scale.setScalar(openLayout.scale * 0.965);
      if (window.gsap) {
        window.gsap.killTweensOf(group.userData);
        window.gsap.to(group.userData, { detailIntro: 0, duration: 0.48, ease: 'power3.out' });
      } else {
        group.userData.detailIntro = 0;
      }
      try {
        drawPanelIfNeeded(true);
        // 清旧
        disposeRows();
        // loading 行
        allTracks = [{ name: '加载中…', artist: '' }];
        panelDirty = true;
        rowsDirty = true;
        syncRenderedRows(true);
      } catch (renderLoadingErr) {
        console.warn('[ShelfContentLoadingRender]', playlistId, renderLoadingErr);
      }
      var podcastCollectionKey = String(playlistId || '').indexOf('podcast:') === 0 ? String(playlistId).slice(8) : '';
      var qqPlaylistId = String(playlistId || '').indexOf('qq:') === 0 ? String(playlistId).slice(3) : '';
      contentKind = podcastCollectionKey ? 'podcast' : 'playlist';
      // 拉取歌单/播客集合
      var r = null;
      try {
        r = podcastCollectionKey
          ? await apiJson('/api/podcast/my/items?key=' + encodeURIComponent(podcastCollectionKey) + '&limit=36')
          : (qqPlaylistId
            ? await apiJson(qqPlaylistTracksApiUrl(qqPlaylistId))
            : await apiJson('/api/playlist/tracks?id=' + encodeURIComponent(playlistId)));
      } catch (e) {
        if (!open || token !== requestToken) return;
        console.warn('[ShelfContentLoadApi]', playlistId, e);
        try {
          allTracks = [{ name: '歌单加载失败', artist: '' }];
          panelDirty = true;
          rowsDirty = true;
          startRowsLoadedIntro();
          syncRenderedRows(true);
        } catch (renderErrorErr) {
          console.warn('[ShelfContentErrorRender]', playlistId, renderErrorErr);
        }
        showToast('歌单加载失败');
        return;
      }
      if (!open || token !== requestToken) return;
      try {
        // 清 loading
        disposeRows();
        var tracks = podcastCollectionKey ? (r.items || []) : (r.tracks || []);
        if (!tracks.length) {
          allTracks = [{ name: podcastCollectionKey ? '播客为空' : '歌单为空', artist: '' }];
          panelDirty = true;
          rowsDirty = true;
          startRowsLoadedIntro();
          syncRenderedRows(true);
          return;
        }
        allTracks = tracks;
        // Backfill QQ playlist cover onto shelf card / playlist cache (API list often lacks logo).
        if (qqPlaylistId) {
          var metaCover = normalizeShelfCoverUrl((r.playlist && r.playlist.cover) || (r.meta && r.meta.cover) || '');
          if (!metaCover && tracks[0]) metaCover = resolveSongCoverUrl(tracks[0], 300) || '';
          if (metaCover) {
            if (sourceCard && sourceCard.item) sourceCard.item.cover = metaCover;
            var plHit = findQQPlaylistById(qqPlaylistId);
            if (plHit) plHit.cover = metaCover;
            if (qqPlaylists && qqPlaylists.length) {
              qqPlaylists.forEach(function(pl) {
                if (pl && String(pl.id || pl.qqId || '') === String(qqPlaylistId)) pl.cover = metaCover;
              });
            }
            scheduleShelfRebuild('qq-cover-backfill', true);
            panelDirty = true;
          }
        }
        centerTarget = 0; centerSmooth = 0;
        panelDirty = true;
        rowsDirty = true;
        startRowsLoadedIntro();
        syncRenderedRows(true);
      } catch (renderReadyErr) {
        console.warn('[ShelfContentReadyRender]', playlistId, renderReadyErr);
        showToast('歌单已载入，3D列表刷新失败');
      }
    },
    close: function() {
      open = false;
      requestToken++;
      var targetGroup = group;
      var targetRows = rows.slice();
      var targetPanel = panel;
      group = null;
      rows = [];
      panel = null;
      renderedStart = -1;
      allTracks = [];
      contentKind = 'playlist';
      sourceCard = null;
      panelDirty = true;
      rowsDirty = true;
      panelDrawAt = -10;
      rowDrawAt = -10;
      if (!targetGroup) return;
      var materials = targetRows.map(function(row){ return row.mesh && row.mesh.material; }).filter(Boolean);
      if (targetPanel && targetPanel.mesh && targetPanel.mesh.material) materials.push(targetPanel.mesh.material);
      if (window.gsap) {
        window.gsap.killTweensOf(targetGroup.position);
        window.gsap.killTweensOf(targetGroup.scale);
        window.gsap.to(targetGroup.scale, { x: 0.965, y: 0.965, z: 0.965, duration: 0.18, ease: 'power2.in' });
        window.gsap.to(targetGroup.position, {
          x: targetGroup.position.x + 0.18,
          y: targetGroup.position.y - 0.02,
          z: targetGroup.position.z - 0.10,
          duration: 0.18,
          ease: 'power2.in'
        });
        var finishClose = function(){ disposeCapturedDetail(targetGroup, targetRows, targetPanel); };
        if (materials.length) {
          window.gsap.to(materials, {
            opacity: 0,
            duration: 0.16,
            ease: 'power2.in',
            onComplete: finishClose
          });
        } else {
          window.gsap.delayedCall(0.18, finishClose);
        }
      } else {
        disposeCapturedDetail(targetGroup, targetRows, targetPanel);
      }
    },
    update: function(dt) {
      if (!group || !open) return;
      var intro = group.userData.detailIntro || 0;
      var parX = pointerParallax.x || 0;
      var parY = pointerParallax.y || 0;
      var layout = detailLayout();
      var skullDetail = shouldUseSkullSafeShelfCamera();
      var dynamicDetail = !skullDetail && shouldUseShelfDynamicCamera('shelf-detail') && camera;
      var coverBoundDetail = !skullDetail && !dynamicDetail && particles && particles.rotation;
      var coverBindX = coverBoundDetail ? particles.rotation.y * 0.18 : 0;
      var coverBindY = coverBoundDetail ? particles.rotation.x * -0.16 : 0;
      var coverBindZ = coverBoundDetail ? Math.abs(particles.rotation.y) * 0.030 : 0;
      group.position.set(
        layout.x + coverBindX + intro * (skullDetail ? 0.10 : 0.16) + parX * (skullDetail ? 0.024 : 0.030),
        layout.y + coverBindY - intro * (skullDetail ? 0.02 : 0.024) + parY * (skullDetail ? 0.026 : 0.026),
        layout.z + coverBindZ - intro * (skullDetail ? 0.05 : 0.070) + parY * (skullDetail ? 0.014 : 0.016) - parX * (skullDetail ? 0.010 : 0.010)
      );
      if (skullDetail && camera) {
        group.quaternion.copy(camera.quaternion);
        group.rotateX(layout.rx - parY * 0.004);
        group.rotateY(layout.ry + intro * 0.004 + parX * 0.004);
      } else if (dynamicDetail) {
        group.quaternion.copy(camera.quaternion);
        group.rotateX(layout.rx - parY * 0.006);
        group.rotateY(layout.ry + intro * 0.012 + parX * 0.008);
      } else {
        var coverRx = particles && particles.rotation ? particles.rotation.x : 0;
        var coverRy = particles && particles.rotation ? particles.rotation.y : 0;
        var coverRz = particles && particles.rotation ? particles.rotation.z : 0;
        group.rotation.x += ((coverRx * 0.72 + layout.rx - parY * 0.010) - group.rotation.x) * 0.16;
        group.rotation.y += ((coverRy * 0.82 + layout.ry + intro * 0.018 + parX * 0.014) - group.rotation.y) * 0.16;
        group.rotation.z += ((coverRz * 0.70) - group.rotation.z) * 0.14;
      }
      group.scale.setScalar(layout.scale * (1 - intro * (skullDetail ? 0.020 : 0.035)));
      centerSmooth += (centerTarget - centerSmooth) * 0.18;
      if (Math.abs(centerSmooth - centerTarget) < 0.001) centerSmooth = centerTarget;
      syncRenderedRows(false);
      if (panel && panel.mesh) {
        var pr = Math.max(0, Math.min(1, (uniforms.uTime.value - openAnimAt) / 0.72));
        pr = pr * pr * (3 - 2 * pr);
        panel.mesh.material.opacity = 0.86 * pr * shelfSettings().opacity;
      }
      for (var i = 0; i < rows.length; i++) {
        place(rows[i], i);
        var isC = Math.abs(rows[i].index - centerSmooth) < 0.5;
        if (rows[i].lastCenter !== isC) {
          rows[i].lastCenter = isC;
          drawRow(rows[i], rows[i].song, isC);
        }
      }
    },
    next: function() {
      if (allTracks.length) {
        var prevTarget = Math.round(centerTarget);
        centerTarget = Math.min(allTracks.length - 1, centerTarget + 1);
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(1, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    prev: function() {
      if (allTracks.length) {
        var prevTarget = Math.round(centerTarget);
        centerTarget = Math.max(0, centerTarget - 1);
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(-1, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    scrollBy: function(d) {
      if (allTracks.length) {
        var prevTarget = Math.round(centerTarget);
        centerTarget = Math.max(0, Math.min(allTracks.length - 1, centerTarget + d));
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(d, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    getRows: function() { return rows; },
    getCenterIdx: function() { return Math.round(centerSmooth); },
    pulseRow: function(row, amount) {
      if (!row) return;
      pulseObjectValue(row, 'fxPulse', amount || 1, 0.42);
    },
    raycastRows: function(rc) {
      if (!rows.length) return null;
      var vm = rows.filter(function(r){return r.mesh.visible;}).map(function(r){return r.mesh;});
      var hits = rc.intersectObjects(vm, false);
      if (!hits.length) return null;
      var row = rows.find(function(r){ return r.mesh === hits[0].object; });
      return { row: row, uv: hits[0].uv };
    },
    pickRowAtScreen: function(sx, sy) {
      if (!rows.length || !open) return null;
      var ordered = rows.filter(function(r){ return r.mesh && r.mesh.visible; }).sort(function(a, b){
        return (b.mesh.renderOrder || 0) - (a.mesh.renderOrder || 0);
      });
      for (var ri = 0; ri < ordered.length; ri++) {
        var row = ordered[ri];
        var params = row.mesh.geometry && row.mesh.geometry.parameters || {};
        var hw = (params.width || 2.50) / 2;
        var hh = (params.height || 0.36) / 2;
        var pts = [
          new THREE.Vector3(-hw, -hh, 0),
          new THREE.Vector3( hw, -hh, 0),
          new THREE.Vector3( hw,  hh, 0),
          new THREE.Vector3(-hw,  hh, 0),
        ];
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        row.mesh.updateMatrixWorld(true);
        for (var pi = 0; pi < pts.length; pi++) {
          pts[pi].applyMatrix4(row.mesh.matrixWorld).project(camera);
          var x = (pts[pi].x + 1) * innerWidth / 2;
          var y = (1 - pts[pi].y) * innerHeight / 2;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        var padX = 24, padY = 16;
        if (sx < minX - padX || sx > maxX + padX || sy < minY - padY || sy > maxY + padY) continue;
        var u = clampRange((sx - minX) / Math.max(1, maxX - minX), 0, 1);
        var v = 1 - clampRange((sy - minY) / Math.max(1, maxY - minY), 0, 1);
        return { row: row, uv: { x: u, y: v }, screenPick: true };
      }
      return null;
    },
    raycastPanel: function(rc) {
      if (!panel || !panel.mesh) return null;
      var hits = rc.intersectObject(panel.mesh, false);
      return hits && hits.length ? hits[0] : null;
    },
    screenContainsPanel: function(sx, sy) {
      if (!panel || !panel.mesh || !open) return false;
      var params = panel.mesh.geometry && panel.mesh.geometry.parameters || {};
      var hw = (params.width || 2.62) / 2;
      var hh = (params.height || 3.02) / 2;
      var pts = [
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3( hw, -hh, 0),
        new THREE.Vector3( hw,  hh, 0),
        new THREE.Vector3(-hw,  hh, 0),
      ];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      panel.mesh.updateMatrixWorld(true);
      for (var pi = 0; pi < pts.length; pi++) {
        pts[pi].applyMatrix4(panel.mesh.matrixWorld).project(camera);
        var x = (pts[pi].x + 1) * innerWidth / 2;
        var y = (1 - pts[pi].y) * innerHeight / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      var pad = 42;
      return sx >= minX - pad && sx <= maxX + pad && sy >= minY - pad && sy <= maxY + pad;
    },
    rowActionAtScreen: function(row, sx, sy) {
      if (!row || !row.mesh || !row.mesh.visible) return null;
      var song = row.song || {};
      var isCenter = Math.abs(row.index - Math.round(centerSmooth)) < 0.5;
      if (!isCenter || !((song && song.id) || song.type === 'podcast-radio')) return null;
      var params = row.mesh.geometry && row.mesh.geometry.parameters || {};
      var hw = (params.width || 2.50) / 2;
      var hh = (params.height || 0.36) / 2;
      var corners = [
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3( hw, -hh, 0),
        new THREE.Vector3( hw,  hh, 0),
        new THREE.Vector3(-hw,  hh, 0),
      ];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      row.mesh.updateMatrixWorld(true);
      for (var i = 0; i < corners.length; i++) {
        corners[i].applyMatrix4(row.mesh.matrixWorld).project(camera);
        var x = (corners[i].x + 1) * innerWidth / 2;
        var y = (1 - corners[i].y) * innerHeight / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      var w = Math.max(1, maxX - minX);
      var h = Math.max(1, maxY - minY);
      var u = clampRange((sx - minX) / w, 0, 1);
      var v = clampRange((sy - minY) / h, 0, 1);
      if (u > 0.60 && u < 0.68 && v > 0.12 && v < 0.88) return 'like';
      if (u >= 0.68 && u < 0.75 && v > 0.12 && v < 0.88) return 'collect';
      if (u >= 0.75 && u < 0.82 && v > 0.12 && v < 0.88) return 'next';
      if (u >= 0.82 && v > 0.10 && v < 0.90) return 'play';
      return null;
    },
    playRow: function(row) {
      // 把整个歌单导入队列, 从这首开始播
      pulseObjectValue(row, 'fxPulse', 1.0, 0.34);
      var idx = row.index;
      if (idx < 0) return;
      if (row.song && row.song.type === 'podcast-radio') {
        loadPodcastRadioIntoQueue(row.song.id || row.song.radioId, true, row.song.name || playlistTitle);
        var smRadio = shelfManager;
        if (smRadio) safeShelfCloseContent('content-play-podcast-radio');
        return;
      }
      var playIndex = allTracks.slice(0, idx + 1).filter(function(song){ return song && song.id; }).length - 1;
      var allSongs = allTracks.filter(function(song){ return song && song.id; }).map(function(song){
        return cloneSong(song);
      });
      if (!allSongs.length || playIndex < 0) return;
      playQueue = allSongs;
      currentIdx = playIndex;
      safeRenderQueuePanel('content-play-row');
      safeShelfRebuild('content-play-row');
      forcePlaybackControlsInteractive();
      playQueueAt(playIndex, { preserveHomeState: true }).catch(function(e){
        console.warn('[ContentPlayRow]', e);
      });
      // 关闭内容框
      var sm = shelfManager;
      if (sm) safeShelfCloseContent('content-play-row');
    }
  };

  function makeRow(song, i) {
    var cv = document.createElement('canvas');
    cv.width = 800; cv.height = 104;
    var ctx = cv.getContext('2d');
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    var mat = new THREE.MeshBasicMaterial({ map: tx, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    var geo = new THREE.PlaneGeometry(2.50, 0.36, 1, 1);
      var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 240 + i;
      group.add(mesh);
      return { canvas: cv, texture: tx, mesh: mesh, song: song, index: i, fxPulse: 0 };
    }
}

function compactCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}
function drawCanvasHeart(ctx, cx, cy, size, color) {
  var s = (size || 20) / 28;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 10.2);
  ctx.bezierCurveTo(-8.9, 2.6, -13.8, -1.9, -13.8, -7.4);
  ctx.bezierCurveTo(-13.8, -12.0, -10.3, -15.2, -5.9, -15.2);
  ctx.bezierCurveTo(-3.2, -15.2, -1.1, -13.9, 0, -11.9);
  ctx.bezierCurveTo(1.1, -13.9, 3.2, -15.2, 5.9, -15.2);
  ctx.bezierCurveTo(10.3, -15.2, 13.8, -12.0, 13.8, -7.4);
  ctx.bezierCurveTo(13.8, -1.9, 8.9, 2.6, 0, 10.2);
  ctx.closePath();
  ctx.fillStyle = color || '#ff7a90';
  ctx.fill();
  ctx.restore();
}
function normalizeShelfCoverUrl(url) {
  url = normalizeListenCoverUrl(url);
  if (!url) return '';
  if (/y\.qq\.com\/music\/photo_new\//i.test(url)) {
    url = url.replace('://y.qq.com/music/photo_new/', '://y.gtimg.cn/music/photo_new/');
  }
  // Snap invalid T002R{px} sizes (e.g. 320/120) to QQ-supported sizes.
  if (/\/music\/photo_new\/T00[12]R\d+x\d+M000/i.test(url)) {
    var m = url.match(/T00[12]R(\d+)x(\d+)M000/i);
    var cur = m ? Number(m[1]) : 0;
    if (!cur || QQ_COVER_SIZES.indexOf(cur) < 0) url = snapQQPhotoNewCoverUrl(url, cur || 300);
  }
  return url;
}
function playlistCoverCacheRec(url) {
  if (!url) return null;
  var key = normalizeShelfCoverUrl(url) || url;
  return playlistCoverCache[url] || playlistCoverCache[key] || null;
}
function requestPlaylistCover(url, cb) {
  if (!url) { if (cb) cb(null); return; }
  var normalized = normalizeShelfCoverUrl(url) || String(url || '').trim();
  if (!normalized) { if (cb) cb(null); return; }
  var rec = playlistCoverCacheRec(url) || playlistCoverCacheRec(normalized);
  if (rec && rec.loaded) {
    playlistCoverCache[url] = rec;
    playlistCoverCache[normalized] = rec;
    if (cb) setTimeout(function(){ cb(rec.img); }, 0);
    return;
  }
  if (rec && rec.loading) {
    playlistCoverCache[url] = rec;
    playlistCoverCache[normalized] = rec;
    if (cb) rec.waiters.push(cb);
    return;
  }
  // Allow retry after previous CORS/`crossOrigin` failures (common for QQ CDN).
  if (rec && rec.failed) {
    delete playlistCoverCache[url];
    delete playlistCoverCache[normalized];
  }
  rec = { loaded:false, loading:true, waiters: cb ? [cb] : [], img:null, failed:false };
  playlistCoverCache[url] = rec;
  playlistCoverCache[normalized] = rec;

  function finishOk(img) {
    rec.loaded = true; rec.loading = false; rec.failed = false; rec.img = img;
    rec.waiters.splice(0).forEach(function(fn){ setTimeout(function(){ fn(img); }, 0); });
  }
  function finishFail() {
    rec.loading = false; rec.failed = true; rec.img = null;
    rec.waiters.splice(0).forEach(function(fn){ setTimeout(function(){ fn(null); }, 0); });
  }
  function loadImage(src) {
    if (!src) { finishFail(); return; }
    var img = new Image();
    img.decoding = 'async';
    // Only require CORS for remote http(s); blob/data URLs are already canvas-safe.
    if (/^https?:\/\//i.test(src) && !isInlineCoverSrc(src)) img.crossOrigin = 'anonymous';
    img.onload = function(){ finishOk(img); };
    img.onerror = function(){
      // Last resort: same-origin /api/cover proxy without waiting on bridge canvas helper.
      if (!img.dataset || img.dataset.proxyRetry === '1') { finishFail(); return; }
      var proxied = coverProxySrc(normalized, true);
      if (!proxied || proxied === src || mineradioUsesWebMediaBridge()) { finishFail(); return; }
      img.dataset.proxyRetry = '1';
      img.crossOrigin = 'anonymous';
      img.src = proxied;
    };
    img.src = src;
  }

  resolveCoverUrlForCanvas(normalized).then(function(safeSrc) {
    if (safeSrc) {
      loadImage(safeSrc);
      return;
    }
    var fallback = coverProxySrc(normalized) || normalized;
    loadImage(fallback);
  }).catch(function() {
    loadImage(coverProxySrc(normalized) || normalized);
  });
}

// ============================================================
//  3D 卡片交互 - PSP 风格
//   - 滚轮: 滚动 center 卡 (一级或二级)
//   - 点击 center 卡: 打开内容框 (歌单) 或 播放 (队列)
//   - 点击两侧卡: 滚到那张
//   - ESC: 关闭内容框
// ============================================================
function raycasterFromPointerEvent(e) {
  var mx = (e.clientX / innerWidth) * 2 - 1;
  var my = -(e.clientY / innerHeight) * 2 + 1;
  var rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), camera);
  return rc;
}
function pointerCardHit(rc, e, screenPad) {
  if (!shelfManager) return null;
  return shelfManager.raycastCards(rc) || (shelfManager.pickCardAtScreen && shelfManager.pickCardAtScreen(e.clientX, e.clientY, screenPad));
}
function isSideShelfFocusHit(e) {
  if (!e || !shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return true;
  if (shelfAlwaysVisible()) return !!pointerCardHit(raycasterFromPointerEvent(e), e, 18);
  if (!shelfAutoHiddenInputReady()) return false;
  if (shelfVisibility > 0.34 && (isShelfClickZone(e) || isShelfPreviewUseZone(e))) return true;
  return !!(shelfPreviewIsVisible() && pointerCardHit(raycasterFromPointerEvent(e), e, 24));
}
function updateShelfCardHoverSelection(e) {
  if (!shelfManager || !shelfManager.clearSelected || !shelfManager.setSelected) return;
  if (!e || document.body.classList.contains('splash-active') || isPointerOverUi(e)) {
    shelfManager.clearSelected();
    return;
  }
  var mode = shelfManager.getMode && shelfManager.getMode();
  if (!mode || mode === 'off') {
    shelfManager.clearSelected();
    return;
  }
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    shelfManager.clearSelected();
    return;
  }
  var canInteract = shelfManager.canInteract && shelfManager.canInteract();
  if (!canInteract) {
    shelfManager.clearSelected();
    return;
  }
  if (mode === 'side') {
    if (!shelfPinnedOpen && shelfAlwaysVisible()) {
      var alwaysHit = pointerCardHit(raycasterFromPointerEvent(e), e, 18);
      if (alwaysHit && alwaysHit.card) shelfManager.setSelected(alwaysHit.card.index);
      else shelfManager.clearSelected();
      return;
    }
    var sideUsable = shelfPinnedOpen || shelfAutoHiddenInputReady();
    if (!sideUsable) {
      shelfManager.clearSelected();
      return;
    }
  } else if (mode !== 'stage') {
    shelfManager.clearSelected();
    return;
  }
  var hit = pointerCardHit(raycasterFromPointerEvent(e), e);
  if (hit && hit.card) shelfManager.setSelected(hit.card.index);
  else shelfManager.clearSelected();
}
function setGestureHudState(label, progress, detail) {
  gestureHudCache.pendingLabel = label || '待命';
  gestureHudCache.pendingDetail = detail || '将手放进摄像头视野';
  gestureHudCache.pendingProgress = progress || 0;
}

function flushGestureHud(force) {
  var label = gestureHudCache.pendingLabel;
  if (label == null) return;
  var detail = gestureHudCache.pendingDetail || '将手放进摄像头视野';
  var progress = gestureHudCache.pendingProgress || 0;
  if (!force &&
    gestureHudCache.label === label &&
    gestureHudCache.detail === detail &&
    Math.abs(gestureHudCache.progress - progress) < 0.03) return;
  gestureHudCache.label = label;
  gestureHudCache.detail = detail;
  gestureHudCache.progress = progress;
  var hud = document.getElementById('gesture-hud');
  if (!hud) return;
  var labelEl = document.getElementById('gesture-label');
  var detailEl = document.getElementById('gesture-confirm');
  var fill = document.getElementById('gesture-fill');
  if (labelEl) labelEl.textContent = label;
  if (detailEl) detailEl.textContent = detail;
  if (fill) fill.style.width = Math.max(0, Math.min(100, progress * 100)) + '%';
  hud.classList.add('show');
}

function scheduleGestureHandDraw(lm, isPinch, openness, isFist) {
  gestureHandDrawPending = { lm: lm, isPinch: isPinch, openness: openness, isFist: isFist };
  if (gestureHandDrawRaf) return;
  gestureHandDrawRaf = requestAnimationFrame(function(){
    gestureHandDrawRaf = 0;
    var pending = gestureHandDrawPending;
    gestureHandDrawPending = null;
    if (!pending || !gestureActive) return;
    flushGestureHud(false);
    drawHandSkeleton(pending.lm, pending.isPinch, pending.openness, pending.isFist);
  });
}

function raycasterFromNormPointer(normX, normY) {
  if (!gestureShelfRaycaster) gestureShelfRaycaster = new THREE.Raycaster();
  gestureShelfRayNdc.set(normX * 2 - 1, -(normY * 2 - 1));
  gestureShelfRaycaster.setFromCamera(gestureShelfRayNdc, camera);
  return gestureShelfRaycaster;
}
function updateShelfHandHoverSelection(normX, normY, openness) {
  if (!gestureActive || openness < 0.42) return;
  var now = performance.now();
  if (now - gestureShelfHoverLastAt < 140) return;
  gestureShelfHoverLastAt = now;
  if (!shelfManager || !shelfManager.clearSelected || !shelfManager.setSelected) return;
  var mode = shelfManager.getMode && shelfManager.getMode();
  if (!mode || mode === 'off') return;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return;
  if (!(shelfManager.canInteract && shelfManager.canInteract())) return;
  var fakeEvent = { clientX: clampRange(normX, 0, 1) * innerWidth, clientY: clampRange(normY, 0, 1) * innerHeight };
  if (mode === 'side' && !shelfPinnedOpen && !shelfAlwaysVisible()) {
    if (!shelfAutoHiddenInputReady()) {
      shelfManager.clearSelected();
      return;
    }
  }
  var hit = pointerCardHit(raycasterFromNormPointer(normX, normY), fakeEvent, 24);
  if (hit && hit.card) shelfManager.setSelected(hit.card.index);
  else shelfManager.clearSelected();
}
function isShelfPlaylistPlayHit(hit) {
  if (!hit || !hit.card || !hit.uv || !hit.card.item || hit.card.item.type !== 'playlist') return false;
  return hit.uv.x >= 0.49 && hit.uv.x <= 0.72 && hit.uv.y >= 0.13 && hit.uv.y <= 0.42;
}
renderer.domElement.addEventListener('click', function(e){
  if (!shelfManager || shelfManager.getMode() === 'off') return;
  if (document.body.classList.contains('splash-active')) return;
  if (isPointerOverUi(e)) return;
  if (mouseDownAt.hadDrag) { mouseDownAt.hadDrag = false; return; }

  var rc = raycasterFromPointerEvent(e);
  var mode = shelfManager.getMode();
  var canInteract = shelfManager.canInteract && shelfManager.canInteract();

  // 优先二级内容框
  if (shelfManager.hasOpenContent()) {
    var cl = shelfManager.getContentList && shelfManager.getContentList();
    if (cl) {
      var rowHit = cl.raycastRows(rc);
      if (!rowHit && cl.pickRowAtScreen) rowHit = cl.pickRowAtScreen(e.clientX, e.clientY);
      if (rowHit) {
        if (cl.pulseRow) cl.pulseRow(rowHit.row, 0.72);
        var selectedRow = Math.abs(rowHit.row.index - cl.getCenterIdx()) < 0.5;
        var rowIsPodcastRadio = !!(rowHit.row.song && rowHit.row.song.type === 'podcast-radio');
        var hitLikeButton = rowHit.uv && rowHit.uv.x > 0.61 && rowHit.uv.x < 0.68 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        var hitCollectButton = rowHit.uv && rowHit.uv.x >= 0.68 && rowHit.uv.x < 0.75 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        var hitNextButton = rowHit.uv && rowHit.uv.x >= 0.75 && rowHit.uv.x < 0.82 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        var hitPlayButton = rowHit.uv && rowHit.uv.x >= 0.82 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        var screenAction = (!rowHit.uv && cl.rowActionAtScreen) ? cl.rowActionAtScreen(rowHit.row, e.clientX, e.clientY) : null;
        hitLikeButton = hitLikeButton || screenAction === 'like';
        hitCollectButton = hitCollectButton || screenAction === 'collect';
        hitNextButton = hitNextButton || screenAction === 'next';
        hitPlayButton = hitPlayButton || screenAction === 'play';
        // 详情页支持直接点歌曲播放；红心/收藏按钮仍然保留原动作。
        if (selectedRow && !rowIsPodcastRadio && hitLikeButton) {
          toggleLikeDetailSong(rowHit.row.song);
        } else if (selectedRow && !rowIsPodcastRadio && hitCollectButton) {
          collectDetailSong(rowHit.row.song);
        } else if (selectedRow && !rowIsPodcastRadio && hitNextButton) {
          queueDetailSongNext(rowHit.row.song);
        } else if ((rowHit.row.song && rowHit.row.song.id) || rowIsPodcastRadio || (selectedRow && hitPlayButton)) {
          cl.playRow(rowHit.row);
        } else {
          // 滚到这行
          cl.scrollBy(rowHit.row.index - cl.getCenterIdx());
        }
        return;
      }
      var returnHit = shelfManager.raycastCards(rc);
      safeShelfCloseContent('shelf-card-return');
      if (mode === 'side') setShelfPinnedOpen(true, true);
      if (returnHit && returnHit.card) {
        shelfManager.scrollBy(returnHit.card.index - shelfManager.getCenterIdx());
      }
      return;
    }
  }

  // 一级卡片
  var hit = pointerCardHit(rc, e, mode === 'side' && !shelfPinnedOpen && shelfAlwaysVisible() ? 18 : undefined);
  if (mode === 'side' && !shelfPinnedOpen && !canUseSideShelfWithoutPinnedOpen()) return;

  if (hit) {
    if (mode === 'side') setShelfPinnedOpen(true, true);
    var idx = hit.card.index;
    if (Math.abs(idx - shelfManager.getCenterIdx()) < 0.5) {
      if (isShelfPlaylistPlayHit(hit) && shelfManager.playPlaylistAt && shelfManager.playPlaylistAt(idx)) return;
      shelfManager.openContent(idx);
    } else {
      shelfManager.scrollBy(idx - shelfManager.getCenterIdx());
    }
  } else if (mode === 'side' && shelfPinnedOpen) {
    setShelfPinnedOpen(false, true);
  }
});

renderer.domElement.addEventListener('contextmenu', function(e){
  if (document.body.classList.contains('splash-active')) return;
  if (isPointerOverUi(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof suppressBottomControlsForShelf === 'function') suppressBottomControlsForShelf(980);
  if (!shelfManager) return;
  var mode = shelfManager.getMode && shelfManager.getMode();
  if (mode === 'off') {
    setShelfMode('side');
    mode = 'side';
  }
  if (mode !== 'side') return;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    var rc = raycasterFromPointerEvent(e);
    var cl = shelfManager.getContentList && shelfManager.getContentList();
    var rowHit = cl && cl.raycastRows ? cl.raycastRows(rc) : null;
    if (rowHit && rowHit.row && rowHit.row.song && rowHit.row.song.id && rowHit.row.song.type !== 'podcast-radio') {
      if (cl.pulseRow) cl.pulseRow(rowHit.row, 0.88);
      queueDetailSongNext(rowHit.row.song);
      return;
    }
    safeShelfCloseContent('shelf-context-toggle');
    setShelfPinnedOpen(true, true);
    return;
  }
  setShelfPinnedOpen(!shelfPinnedOpen, true);
  if (!shelfPinnedOpen && typeof setFocusZone === 'function') setFocusZone(null, true);
});

// 滚轮: 在真实卡片或右侧窄热区内滚卡片; 否则保留给封面粒子/视角
//   side 模式: 常驻不再用半屏预览区接管滚轮
//   stage 模式: 鼠标 y > 60% 屏幕高
//   shift + wheel: 强制滚卡片
var wheelOverShelf = false;
renderer.domElement.addEventListener('wheel', function(e){
  if (isPointerOverUi(e)) return;
  if (!shelfManager || shelfManager.getMode() === 'off') return;
  markRenderInteraction('shelf-wheel', 900);
  var rc = raycasterFromPointerEvent(e);
  // 二级框打开时, 只有真正命中详情行才接管滚轮
  if (shelfManager.hasOpenContent()) {
    var cl = shelfManager.getContentList();
    if (cl) {
      var rowHit = cl.raycastRows(rc);
      var panelHit = !rowHit && cl.raycastPanel ? cl.raycastPanel(rc) : null;
      var panelScreenHit = !rowHit && !panelHit && cl.screenContainsPanel ? cl.screenContainsPanel(e.clientX, e.clientY) : false;
      if (!rowHit && !panelHit && !panelScreenHit) return;
      e.preventDefault(); e.stopImmediatePropagation();
      cl.scrollBy(e.deltaY > 0 ? 1 : -1);
      return;
    }
  }
  var mode = shelfManager.getMode();
  var inShelfArea = false;
  var canScrollShelf = shelfManager.canInteract && shelfManager.canInteract();
  var shelfPreviewActive = shelfAutoHiddenInputReady();
  var cardWheelHit = canScrollShelf ? pointerCardHit(rc, e, mode === 'side' && !shelfPinnedOpen && shelfAlwaysVisible() ? 18 : undefined) : null;
  if (canScrollShelf && e.shiftKey && (mode !== 'side' || shelfPinnedOpen || shelfPreviewActive || shelfAlwaysVisible())) inShelfArea = true;
  else if (canScrollShelf && mode === 'side') {
    if (shelfPinnedOpen) inShelfArea = isShelfWheelZone(e) || !!cardWheelHit;
    else if (shelfAlwaysVisible()) inShelfArea = !!cardWheelHit;
    else if (shelfPreviewActive) inShelfArea = isShelfWheelZone(e) || !!cardWheelHit;
  }
  else if (canScrollShelf && mode === 'stage' && cardWheelHit) inShelfArea = true;
  if (inShelfArea) {
    e.preventDefault();
    e.stopImmediatePropagation();
    shelfManager.scrollBy(e.deltaY > 0 ? 1 : -1);
  }
}, { passive: false, capture: true });

// 键盘 / 全局事件
function isFreeCameraControlCode(code) {
  return /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(code);
}
function consumeFreeCameraKeyEvent(e, isDown) {
  if (isTypingTarget(e.target)) return false;
  if (isDown && e.code === 'KeyR') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return true;
    toggleFreeCamera();
    return true;
  }
  if (!freeCamera || !freeCamera.active) return false;
  if (isDown && e.code === 'KeyK') {
    e.preventDefault();
    e.stopImmediatePropagation();
    resetFreeCameraToDefault();
    return true;
  }
  if (!isFreeCameraControlCode(e.code)) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  freeCamera.keys = freeCamera.keys || {};
  freeCamera.keys[e.code] = !!isDown;
  markRenderInteraction('free-camera-key', 900);
  return true;
}
document.addEventListener('keydown', function(e){
  consumeFreeCameraKeyEvent(e, true);
}, true);
document.addEventListener('keyup', function(e){
  consumeFreeCameraKeyEvent(e, false);
}, true);
document.addEventListener('keydown', function(e){
  if (isTypingTarget(e.target)) return;
  markRenderInteraction('keyboard', 700);
  if (e.code === 'KeyK') {
    e.preventDefault();
    if (freeCamera && (freeCamera.active || freeCamera.locked)) resetFreeCameraToDefault();
    else {
      recenterCamera();
      showToast('镜头已回正');
    }
    return;
  }
  if (e.code === 'KeyR') {
    if (e.repeat) return;
    e.preventDefault();
    toggleFreeCamera();
    return;
  }
  if (freeCamera && freeCamera.active) {
    if (/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      freeCamera.keys[e.code] = true;
      return;
    }
  }
  if (!shelfManager) return;
  if (e.code === 'BracketRight' || e.code === 'PageDown') shelfManager.next();
  else if (e.code === 'BracketLeft' || e.code === 'PageUp') shelfManager.prev();
});
document.addEventListener('keyup', function(e){
  if (!freeCamera || !freeCamera.keys) return;
  if (/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) {
    freeCamera.keys[e.code] = false;
  }
});
window.addEventListener('blur', function(){
  if (freeCamera && freeCamera.keys) freeCamera.keys = {};
});

// ============================================================
//  API 助手
// ============================================================
async function apiJson(url, opts) {
  if (!window.desktopWindow && typeof window.__mineradioWebApiJson === 'function') {
    return window.__mineradioWebApiJson(url, opts);
  }
  opts = opts || {};
  var timeoutMs = Number(opts.timeoutMs) || 0;
  var fetchOpts = Object.assign({}, opts);
  delete fetchOpts.timeoutMs;
  var timer = null;
  if (timeoutMs && window.AbortController && !fetchOpts.signal) {
    var controller = new AbortController();
    fetchOpts.signal = controller.signal;
    timer = setTimeout(function(){ controller.abort(); }, timeoutMs);
  }
  try {
    var res = await fetch(url, fetchOpts);
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
if (typeof window.__mineradioNotifyApiJsonReady === 'function') window.__mineradioNotifyApiJsonReady();
function escHtml(s){ var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function playbackQualityProvider() {
  if (currentIdx >= 0 && currentIdx < playQueue.length) {
    var song = playQueue[currentIdx];
    if (song && song.type !== 'local' && song.source !== 'local') return songProviderKey(song);
  }
  if (typeof activeAccountProvider === 'string' && activeAccountProvider) return activeAccountProvider;
  return 'netease';
}
var PLAYBACK_QUALITY_PROFILES = {
  netease: [
    { value: 'jymaster', label: '超清母带', short: '母带', hint: 'SVIP / 最高规格', svip: true },
    { value: 'hires', label: '高清臻音', short: '臻音', hint: '默认 / 细节优先' },
    { value: 'lossless', label: '无损 SQ', short: 'SQ', hint: 'FLAC 优先' },
    { value: 'exhigh', label: '极高 HQ', short: 'HQ', hint: '320kbps' },
    { value: 'standard', label: '标准', short: 'STD', hint: '128kbps' }
  ],
  qq: [
    { value: 'hires', label: 'Hi-Res FLAC', short: 'Hi-Res', hint: '最高无损规格' },
    { value: 'lossless', label: '无损 FLAC', short: 'SQ', hint: 'F000 / SQ' },
    { value: 'exhigh', label: '极高 HQ', short: 'HQ', hint: '320k MP3' },
    { value: 'standard', label: '标准', short: 'STD', hint: '128k MP3' }
  ],
  kg: [
    { value: 'lossless', label: '无损 SQ', short: 'SQ', hint: '酷狗无损', vip: true },
    { value: 'exhigh', label: '极高 HQ', short: 'HQ', hint: '320kbps', vip: true },
    { value: 'standard', label: '标准', short: 'STD', hint: '128kbps' }
  ]
};
function playbackQualityProfile(provider) {
  provider = provider || playbackQualityProvider();
  var profiles = PLAYBACK_QUALITY_PROFILES;
  if (!profiles) return [];
  return profiles[provider] || profiles.netease || [];
}
function normalizePlaybackQualityForProvider(value, provider) {
  value = normalizePlaybackQuality(value);
  provider = provider || playbackQualityProvider();
  if (provider === 'qq') {
    if (value === 'jymaster') return 'hires';
    return value;
  }
  if (provider === 'kg') {
    if (value === 'jymaster' || value === 'hires') return 'lossless';
    return value;
  }
  return value;
}
function playbackQualityOptionMeta(value, provider) {
  value = normalizePlaybackQuality(value);
  provider = provider || playbackQualityProvider();
  var profile = playbackQualityProfile(provider);
  for (var i = 0; i < profile.length; i++) {
    if (profile[i].value === value) return profile[i];
  }
  return profile[0] || { value: value, label: playbackQualityLabel(value), short: playbackQualityShortLabel(value), hint: '' };
}
function playbackQualityLockHint(provider, option) {
  if (provider === 'netease' && option.svip) return '需网易云 SVIP';
  if (provider === 'qq' && option.vip) return '需 QQ VIP';
  if (provider === 'kg' && option.vip) return '需酷狗 VIP';
  return '';
}
function playbackQualityOptionLocked(provider, option) {
  if (provider === 'netease' && option.svip) return !hasProviderSvip('netease', loginStatus);
  if (option.vip) {
    if (provider === 'kg') return !hasProviderVip('kg', loginStatus);
    if (provider === 'qq') return !hasProviderVip('qq', loginStatus);
  }
  return false;
}
function renderPlaybackQualityOptions() {
  var host = document.getElementById('quality-options');
  if (!host) return;
  var provider = playbackQualityProvider();
  var profile = playbackQualityProfile(provider);
  host.innerHTML = profile.map(function(option){
    var lockHint = playbackQualityLockHint(provider, option);
    var hint = option.hint + (lockHint ? ' · ' + lockHint : '');
    return '<button class="quality-option' + (option.svip ? ' svip-only' : '') + '" data-quality="' + option.value + '"' +
      (option.svip ? ' data-svip="1"' : '') +
      (option.vip ? ' data-vip="1"' : '') +
      ' onclick="setPlaybackQuality(\'' + option.value + '\')"><span>' + option.label + '</span><small>' + hint + '</small></button>';
  }).join('');
}
function normalizePlaybackQuality(value) {
  value = String(value || '').toLowerCase();
  if (value === 'jymaster' || value === 'master' || value === 'svip') return 'jymaster';
  if (value === 'hires' || value === 'hi-res' || value === 'highres' || value === 'highest') return 'hires';
  if (value === 'lossless' || value === 'flac' || value === 'sq') return 'lossless';
  if (value === 'exhigh' || value === 'high' || value === '320k' || value === 'hq') return 'exhigh';
  if (value === 'standard' || value === 'normal' || value === 'std') return 'standard';
  return 'hires';
}
function playbackQualityLabel(value, provider) {
  var meta = playbackQualityOptionMeta(value, provider);
  return meta.label || '高清臻音';
}
function playbackQualityShortLabel(value, provider) {
  var meta = playbackQualityOptionMeta(value, provider);
  return meta.short || meta.label || '臻音';
}
function playbackQualityRank(value) {
  value = normalizePlaybackQuality(value);
  if (value === 'jymaster') return 5;
  if (value === 'hires') return 4;
  if (value === 'lossless') return 3;
  if (value === 'exhigh') return 2;
  if (value === 'standard') return 1;
  return 4;
}
function playbackQualityWasDowngraded(requested, resolved) {
  return playbackQualityRank(resolved) < playbackQualityRank(requested);
}
function playbackBitrateLabel(br) {
  br = Number(br) || 0;
  if (!br) return '';
  if (br >= 1000000) return (br / 1000000).toFixed(br >= 2000000 ? 1 : 2).replace(/\.0+$/, '') + ' Mbps';
  return Math.round(br / 1000) + ' kbps';
}
function playbackResolvedQualityText(data) {
  data = data || {};
  var label = playbackQualityLabel(data.level || data.quality || playbackQuality);
  var br = playbackBitrateLabel(data.br);
  return br ? (label + ' · ' + br) : label;
}
function readPlaybackQualityPreference() {
  try {
    return normalizePlaybackQuality(localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY) || 'hires');
  } catch (e) {
    return 'hires';
  }
}
function savePlaybackQualityPreference() {
  try { localStorage.setItem(PLAYBACK_QUALITY_STORE_KEY, playbackQuality); } catch (e) {}
}
function updatePlaybackQualityUi() {
  var provider = playbackQualityProvider();
  if (provider !== playbackQualityUiProvider) {
    playbackQualityUiProvider = provider;
    renderPlaybackQualityOptions();
  }
  var label = document.getElementById('quality-btn-label');
  var btn = document.getElementById('quality-btn');
  var effectiveQuality = normalizePlaybackQualityForProvider(playbackQuality, provider);
  var canUseSvip = hasProviderSvip('netease', loginStatus);
  var displayQuality = playbackQuality === 'jymaster' && provider === 'netease' && !canUseSvip ? 'hires' : effectiveQuality;
  if (label) label.textContent = playbackQualityShortLabel(displayQuality, provider);
  if (btn) {
    var providerName = provider === 'qq' ? 'QQ 音乐' : (provider === 'kg' ? '酷狗音乐' : '网易云');
    btn.title = provider === 'netease' && playbackQuality === 'jymaster' && !canUseSvip
      ? ('音质: ' + playbackQualityLabel(displayQuality, provider) + ' · 超清母带需网易云 SVIP · ' + providerName)
      : ('音质: ' + playbackQualityLabel(displayQuality, provider) + ' · ' + providerName);
  }
  document.querySelectorAll('.quality-option').forEach(function(option){
    var q = normalizePlaybackQuality(option.dataset.quality);
    var profileOption = playbackQualityOptionMeta(q, provider);
    var locked = playbackQualityOptionLocked(provider, profileOption);
    option.classList.toggle('active', q === displayQuality);
    option.classList.toggle('locked', locked);
    option.classList.toggle('has-lock-hint', locked && !!playbackQualityLockHint(provider, profileOption));
    option.disabled = locked;
    option.title = locked ? playbackQualityLockHint(provider, profileOption) : playbackQualityLabel(q, provider);
  });
}
function setPlaybackQuality(value) {
  var provider = playbackQualityProvider();
  var next = normalizePlaybackQuality(value);
  var option = playbackQualityOptionMeta(next, provider);
  if (playbackQualityOptionLocked(provider, option)) {
    if (provider === 'netease' && option.svip) {
      showToast(hasPlatformLogin('netease') ? '超清母带需要网易云 SVIP' : '登录网易云 SVIP 后可用超清母带');
      if (!hasPlatformLogin('netease')) openProviderLogin('netease');
    } else if (provider === 'qq') {
      showToast(hasPlatformLogin('qq') ? '该音质需要 QQ VIP' : '登录 QQ 音乐 VIP 后可用');
      if (!hasPlatformLogin('qq')) openProviderLogin('qq');
    } else if (provider === 'kg') {
      showToast(hasPlatformLogin('kg') ? '该音质需要酷狗 VIP' : '登录酷狗 VIP 后可用');
      if (!hasPlatformLogin('kg')) openProviderLogin('kg');
    }
    return;
  }
  playbackQuality = next;
  savePlaybackQualityPreference();
  updatePlaybackQualityUi();
  var wrap = document.getElementById('quality-control');
  if (wrap) wrap.classList.remove('open');
  applyPlaybackQualityToCurrentTrack(next);
}
function canReloadCurrentTrackForQuality() {
  if (currentIdx < 0 || currentIdx >= playQueue.length) return false;
  if (!audio || !audio.src || audio.paused || audio.ended) return false;
  var song = playQueue[currentIdx];
  if (!song || song.type === 'local' || song.source === 'local') return false;
  return songProviderKey(song) === 'netease' || songProviderKey(song) === 'qq' || songProviderKey(song) === 'kg';
}
function applyPlaybackQualityToCurrentTrack(nextQuality) {
  var label = playbackQualityLabel(nextQuality || playbackQuality, playbackQualityProvider());
  if (!canReloadCurrentTrackForQuality()) {
    showToast('音质偏好: ' + label + ' · 下次播放生效');
    return;
  }
  var resumeAt = audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
  showToast('正在切换音质: ' + label);
  Promise.resolve(playQueueAt(currentIdx, {
    qualityOverride: nextQuality || playbackQuality,
    qualitySwitch: true,
    resumeAt: resumeAt,
    preserveHomeState: true,
  })).catch(function(e){
    console.warn('[QualitySwitch]', e);
    showToast('音质切换失败，已保留偏好');
  }).finally(forcePlaybackControlsInteractive);
}
function toggleQualityPanel(e) {
  if (e) e.stopPropagation();
  var wrap = document.getElementById('quality-control');
  if (wrap) wrap.classList.toggle('open');
}
function bindQualityControl() {
  var wrap = document.getElementById('quality-control');
  if (wrap) {
    wrap.addEventListener('mouseenter', function(){ wrap.classList.add('open'); });
    wrap.addEventListener('mouseleave', function(){ setTimeout(function(){ if (!wrap.matches(':hover')) wrap.classList.remove('open'); }, 260); });
  }
  document.addEventListener('click', function(e){
    if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
  });
  updatePlaybackQualityUi();
}
function isTypingTarget(target) {
  if (!target) return false;
  var tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(target.isContentEditable || (target.closest && target.closest('[contenteditable="true"]')));
}
function readCustomCoverMap() {
  try {
    var raw = localStorage.getItem(CUSTOM_COVER_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}
function saveCustomCoverMap() {
  try {
    localStorage.setItem(CUSTOM_COVER_STORE_KEY, JSON.stringify(customCoverMap || {}));
    return true;
  } catch (e) {
    console.warn('custom cover save failed:', e);
    return false;
  }
}
function isInlineCoverSrc(src) {
  return typeof src === 'string' && (/^data:image\//i.test(src) || /^blob:/i.test(src));
}
function isProxyableCoverUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}
function mineradioUsesWebMediaBridge() {
  return !!(window.__mineradioWebMode);
}
function audioProxyPathFromDirect(url) {
  if (!url) return '';
  if (mineradioUsesWebMediaBridge()) return url;
  return '/api/audio?url=' + encodeURIComponent(url);
}
function resolveBeatAnalysisAudioUrl(url) {
  url = String(url || '').trim();
  if (!url) return '';
  if (/^\/api\/audio/i.test(url)) return url.indexOf('purpose=') >= 0 ? url : (url + (url.indexOf('?') >= 0 ? '&' : '?') + 'purpose=analysis');
  if (mineradioUsesWebMediaBridge() || /^https?:\/\//i.test(url)) {
    return '/api/audio?url=' + encodeURIComponent(url) + '&purpose=analysis';
  }
  return audioProxyPathFromDirect(url);
}
function songDurationSec(song) {
  var durationSec = Math.max(0, Number(song && song.duration) || 0);
  if (durationSec > 10000) durationSec /= 1000;
  return durationSec;
}
function buildProvisionalBeatMap(song) {
  var durationSec = Math.max(48, songDurationSec(song) || 240);
  var bpm = 118;
  var gap = 60 / bpm;
  var kicks = [];
  var cameraBeats = [];
  for (var t = 0.5; t < durationSec - 0.2; t += gap) {
    var idx = Math.round(t / gap);
    var isDown = idx % 4 === 0;
    var ev = {
      time: t,
      strength: isDown ? 0.62 : 0.48,
      confidence: 0.55,
      impact: isDown ? 0.58 : 0.42,
      primary: isDown,
      combo: isDown ? 'downbeat' : (idx % 4 === 2 ? 'drop' : 'push'),
      low: 0.65,
      body: 0.22,
      snap: 0.14
    };
    kicks.push(ev);
    if (isDown || idx % 2 === 0) cameraBeats.push(ev);
  }
  return {
    kicks: kicks,
    cameraBeats: cameraBeats,
    pulseBeats: kicks,
    provisional: true,
    tempoSource: 'provisional',
    duration: durationSec,
    visualBeatCount: cameraBeats.length
  };
}
function maybeApplyProvisionalBeatMap(song, songId, opts) {
  opts = opts || {};
  if (presetSkipsBeatAnalysisUi() || !mineradioUsesWebMediaBridge() || djMode.active || !songId) return false;
  if (hasResolvedBeatMapCache(songId)) return false;
  if (currentBeatMap && currentBeatMap.provisional && provisionalBeatMapKey === String(songId)) return true;
  var map = buildProvisionalBeatMap(song);
  currentBeatMap = map;
  applyCinemaProfileFromBeatMap(map);
  syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0);
  if (!opts.silent) scheduleProvisionalBeatChip(songId);
  return true;
}
async function fetchAnalysisAudioArrayBuffer(analysisUrl, directUrl) {
  analysisUrl = String(analysisUrl || '').trim();
  if (!analysisUrl) throw new Error('missing analysis url');
  directUrl = String(directUrl || '').trim();
  if (mineradioUsesWebMediaBridge() && /^\/api\//i.test(analysisUrl)) {
    var payload = null;
    var fetchErr = null;
    var webFetchOpts = beatAnalysisFetchOptions();
    try {
      payload = await apiJson(analysisUrl, webFetchOpts);
    } catch (err) {
      fetchErr = err;
    }
    if ((!payload || payload.error) && directUrl) {
      var retryUrl = resolveBeatAnalysisAudioUrl(directUrl);
      if (retryUrl && retryUrl !== analysisUrl) {
        try {
          payload = await apiJson(retryUrl, webFetchOpts);
          fetchErr = null;
        } catch (err2) {
          fetchErr = err2;
        }
      }
    }
    if (fetchErr) throw fetchErr;
    if (payload && payload.error) throw new Error(payload.error);
    if (payload && payload.__binary && payload.buffer) {
      var rawBin = payload.buffer;
      if (rawBin instanceof ArrayBuffer) return rawBin;
      if (ArrayBuffer.isView(rawBin)) return rawBin.buffer.slice(rawBin.byteOffset, rawBin.byteOffset + rawBin.byteLength);
      if (Array.isArray(rawBin)) return new Uint8Array(rawBin).buffer;
    }
    if (payload && payload.url && /^blob:/i.test(payload.url)) {
      var blobResp = await fetch(payload.url);
      if (!blobResp.ok) throw new Error('analysis blob fetch failed');
      return blobResp.arrayBuffer();
    }
    if (payload && payload.url && /^https?:\/\//i.test(payload.url)) {
      throw new Error('网页版节奏分析需 Mineradio Bridge 扩展代理音频');
    }
    throw new Error('analysis audio empty');
  }
  var resp = await fetch(analysisUrl);
  if (!resp.ok) throw new Error('analysis fetch failed:' + resp.status);
  return resp.arrayBuffer();
}
async function resolvePlaybackAudioUrl(url) {
  url = String(url || '').trim();
  if (!url) return '';
  if (/^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
  if (/^blob:/i.test(url) || /^data:/i.test(url)) return url;
  if (mineradioUsesWebMediaBridge()) return url;
  return audioProxyPathFromDirect(url);
}
var webPlaybackUnlockDone = false;
function configurePlaybackAudioElement(audioEl, srcUrl) {
  if (!audioEl) return;
  audioEl.preload = 'auto';
  if (mineradioUsesWebMediaBridge()) {
    try {
      audioEl.removeAttribute('crossorigin');
      audioEl.crossOrigin = null;
    } catch (_) {}
    return;
  }
  audioEl.crossOrigin = 'anonymous';
}
function canUsePlaybackAudioGraph() {
  return !mineradioUsesWebMediaBridge();
}
function playbackStreamNeedsRefresh() {
  if (!audio || !audio.src) return true;
  if (audio.error) return true;
  if (audio.volume <= 0.001 && targetVolume > 0.01) return true;
  var now = Date.now();
  if (playbackPausedAt && now - playbackPausedAt > PLAYBACK_STREAM_STALE_MS) return true;
  if (playbackStreamLoadedAt && now - playbackStreamLoadedAt > PLAYBACK_STREAM_STALE_MS) return true;
  return false;
}
function markPlaybackPaused() {
  playbackPausedAt = Date.now();
}
async function fetchPlaybackSourceData(song, opts) {
  opts = opts || {};
  var cacheKey = playbackSourceCacheKey(song, opts);
  var cached = readPlaybackSourceCache(cacheKey);
  if (cached) return cached;
  if (playbackSourceInflight[cacheKey]) return playbackSourceInflight[cacheKey];
  playbackSourceInflight[cacheKey] = (async function(){
    var isQQPlayback = songProviderKey(song) === 'qq';
    var isKGPlayback = songProviderKey(song) === 'kg';
    var provider = isKGPlayback ? 'kg' : (isQQPlayback ? 'qq' : 'netease');
    var requestedQuality = normalizePlaybackQualityForProvider(opts.qualityOverride || playbackQuality, provider);
    if (provider === 'netease' && requestedQuality === 'jymaster' && !hasProviderSvip('netease', loginStatus)) requestedQuality = 'hires';
    if (provider === 'netease' && requestedQuality === 'hires' && !hasProviderSvip('netease', loginStatus)) requestedQuality = 'lossless';
    if (isQQPlayback && qqPlaybackQualityCeiling && (requestedQuality === 'jymaster' || requestedQuality === 'hires' || requestedQuality === 'lossless')) {
      requestedQuality = qqPlaybackQualityCeiling;
    }
    var qualityParam = '&quality=' + encodeURIComponent(requestedQuality);
    var data = isKGPlayback
      ? await apiJson(kgPlaybackUrlQuery(song, qualityParam))
      : (isQQPlayback
        ? await apiJson('/api/qq/song/url?mid=' + encodeURIComponent(song.mid || song.songmid || song.id || '') + '&mediaMid=' + encodeURIComponent(song.mediaMid || song.media_mid || '') + qualityParam)
        : await apiJson('/api/song/url?id=' + song.id + qualityParam));
    if (data && data.url) writePlaybackSourceCache(cacheKey, data);
    return data;
  })().finally(function(){ delete playbackSourceInflight[cacheKey]; });
  return playbackSourceInflight[cacheKey];
}
async function refreshCurrentPlaybackStream(opts) {
  opts = opts || {};
  if (currentIdx < 0 || currentIdx >= playQueue.length) return false;
  var song = playQueue[currentIdx];
  var token = trackSwitchToken;
  var resumeAt = opts.resumeAt != null ? opts.resumeAt : (audio && isFinite(audio.currentTime) ? audio.currentTime : 0);
  try {
    if (!opts.silent) showLoading();
    var data = await fetchPlaybackSourceData(song, opts);
    if (token !== trackSwitchToken || !data || !data.url) return false;
    currentPlaybackDirectUrl = data.url;
    playbackStreamLoadedAt = Date.now();
    playbackPausedAt = 0;
    if (!audio) audio = new Audio();
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio._mineradioRefreshAttempt = false;
    configurePlaybackAudioElement(audio, data.url);
    bindPlaybackProgressEvents(audio);
    applyVolumeToAudio();
    restorePlaybackGain();
    audio.src = await resolvePlaybackAudioUrl(data.url);
    audio.load();
    if (resumeAt > 0.35) scheduleAudioResumePosition(audio, resumeAt, token);
    return await attemptAudioPlay({ manual: true, resume: true, silent: !!opts.silent });
  } catch (err) {
    console.warn('[RefreshPlaybackStream]', err);
    return false;
  } finally {
    if (!opts.silent) hideLoading();
  }
}
function releaseWebPlaybackCaptureIfNeeded() {
  if (!mineradioUsesWebMediaBridge()) return;
  if (source || gainNode) {
    try {
      if (source) { source.disconnect(); source = null; }
      if (analyser) { analyser.disconnect(); analyser = null; }
      if (beatAnalyser) { beatAnalyser.disconnect(); beatAnalyser = null; }
      if (gainNode) { gainNode.disconnect(); gainNode = null; }
    } catch (_) {}
    audioReady = false;
    if (audio) {
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_) {}
    }
    audio = new Audio();
    configurePlaybackAudioElement(audio, '');
    bindPlaybackProgressEvents(audio);
    applyVolumeToAudio();
    return;
  }
  if (audio) configurePlaybackAudioElement(audio, '');
}
function primeWebPlaybackUnlockIfNeeded(opts) {
  opts = opts || {};
  if (!mineradioUsesWebMediaBridge() || opts.autoRepeat || webPlaybackUnlockDone) return;
  try {
    releaseWebPlaybackCaptureIfNeeded();
    if (!audio) {
      audio = new Audio();
      configurePlaybackAudioElement(audio, '');
      bindPlaybackProgressEvents(audio);
    }
    applyVolumeToAudio();
    var unlock = audio.play();
    if (unlock && unlock.then) {
      unlock.then(function(){
        if (audio && !audio.src) {
          audio.pause();
          audio.currentTime = 0;
        }
      }).catch(function(){});
    }
    webPlaybackUnlockDone = true;
  } catch (_) {}
}
function coverProxySrc(url, cacheBust) {
  url = normalizeListenCoverUrl(url);
  if (!url) return '';
  if (isInlineCoverSrc(url)) return url;
  if (!isProxyableCoverUrl(url)) return '';
  if (mineradioUsesWebMediaBridge()) return url;
  return '/api/cover?url=' + encodeURIComponent(url) + (cacheBust ? '&v=' + Date.now() : '');
}
function isNeteaseCoverUrl(url) {
  return /(?:music\.163|126\.net|126\.cdn)/i.test(String(url || ''));
}
// QQ photo_new CDN only serves fixed sizes; arbitrary px (80/96/120/320/400) return 404.
var QQ_COVER_SIZES = [68, 90, 126, 150, 180, 300, 500, 800];
function qqOfficialCoverSize(size) {
  var want = Math.max(1, Number(size) || 300);
  var best = QQ_COVER_SIZES[0];
  var bestDiff = Math.abs(want - best);
  for (var i = 1; i < QQ_COVER_SIZES.length; i++) {
    var px = QQ_COVER_SIZES[i];
    var diff = Math.abs(want - px);
    if (diff < bestDiff || (diff === bestDiff && px > best)) {
      best = px;
      bestDiff = diff;
    }
  }
  return best;
}
function snapQQPhotoNewCoverUrl(url, size) {
  url = String(url || '');
  if (!/\/music\/photo_new\/T00[12]R\d+x\d+M000/i.test(url)) return url;
  var px = qqOfficialCoverSize(size || 300);
  return url.replace(/(T00[12]R)\d+x\d+(M000)/i, '$1' + px + 'x' + px + '$2');
}
function qqAlbumCoverUrl(albumMid, size) {
  albumMid = String(albumMid || '').trim();
  if (!albumMid) return '';
  var px = qqOfficialCoverSize(size || 300);
  return 'https://y.gtimg.cn/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}
function qqSingerCoverUrl(singerMid, size) {
  singerMid = String(singerMid || '').trim();
  if (!singerMid) return '';
  var px = qqOfficialCoverSize(size || 300);
  return 'https://y.gtimg.cn/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}
function resolveSongCoverUrl(song, size) {
  if (!song) return '';
  var custom = getCustomCoverForSong(song);
  if (custom) return custom;
  var cover = normalizeListenCoverUrl(song.cover || song.picUrl || song.albumimg || song.pic || '');
  if (cover && /y\.qq\.com\/music\/photo_new\//i.test(cover)) {
    cover = cover.replace('://y.qq.com/music/photo_new/', '://y.gtimg.cn/music/photo_new/');
  }
  if (songProviderKey(song) === 'qq') {
    if (!cover) cover = qqAlbumCoverUrl(song.albumMid || song.album_mid || song.albummid || '', size || 300);
    if (!cover) {
      var singerMid = song.singerMid || song.singer_mid || (song.artists && song.artists[0] && (song.artists[0].mid || song.artists[0].id)) || '';
      cover = qqSingerCoverUrl(singerMid, size || 300);
    }
  }
  if (!cover) return '';
  return coverUrlWithSize(cover, size);
}
function coverUrlWithSize(url, size) {
  url = normalizeListenCoverUrl(url);
  if (!url || isInlineCoverSrc(url) || !/^https?:\/\//i.test(url)) return url || '';
  if (/\{size\}/i.test(url)) return url.replace(/\{size\}/gi, String(qqOfficialCoverSize(size || 300)));
  if (/y\.qq\.com\/music\/photo_new\/T00[12]R\d+x\d+M000/i.test(url)) {
    return snapQQPhotoNewCoverUrl(url.replace('://y.qq.com/music/photo_new/', '://y.gtimg.cn/music/photo_new/'), size || 300);
  }
  if (/y\.gtimg\.cn\/music\/photo_new\/T00[12]R\d+x\d+M000/i.test(url)) {
    return snapQQPhotoNewCoverUrl(url, size || 300);
  }
  if (!isNeteaseCoverUrl(url)) return url;
  if (!size) return url;
  var param = 'param=' + size + 'y' + size;
  if (/[?&]param=\d+y\d+/i.test(url)) return url.replace(/([?&])param=\d+y\d+/i, '$1' + param);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param;
}
function normalizeListenCoverUrl(url) {
  url = String(url || '').trim();
  if (!url || /^blob:/i.test(url)) return '';
  if (/^\/api\/cover\?/i.test(url)) {
    try {
      var m = url.match(/[?&]url=([^&]+)/);
      if (m) url = decodeURIComponent(m[1]);
    } catch (e) { return ''; }
  }
  if (/^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
  if (/^data:/i.test(url) || /^https?:\/\//i.test(url)) return url;
  if (/^\/\//.test(url)) return 'https:' + url;
  return '';
}
function listenCoverFromSong(song) {
  if (!song) return '';
  return resolveSongCoverUrl(song, 240);
}
function enrichListenRecord(record) {
  if (!record) return null;
  var out = Object.assign({}, record);
  out.cover = normalizeListenCoverUrl(out.cover);
  if (!out.cover && out.key && listenStatsState.songs[out.key]) {
    out.cover = normalizeListenCoverUrl(listenStatsState.songs[out.key].cover);
  }
  if (!out.cover && out.key && currentIdx >= 0 && playQueue[currentIdx] && queueItemKey(playQueue[currentIdx]) === out.key) {
    out.cover = listenCoverFromSong(playQueue[currentIdx]);
  }
  return out;
}
var webCoverResolveState = { pending: 0, max: 4, waiters: [] };
var homeCoverObserver = null;
function runWebCoverResolveTask(factory) {
  if (!mineradioUsesWebMediaBridge() || typeof window.__mineradioResolveCoverUrl !== 'function') {
    return Promise.resolve(typeof factory === 'function' ? factory() : factory);
  }
  return new Promise(function(resolve, reject) {
    function launch() {
      webCoverResolveState.pending++;
      Promise.resolve().then(function(){ return typeof factory === 'function' ? factory() : factory; })
        .then(resolve, reject)
        .finally(function(){
          webCoverResolveState.pending--;
          var next = webCoverResolveState.waiters.shift();
          if (next) next();
        });
    }
    if (webCoverResolveState.pending < webCoverResolveState.max) launch();
    else webCoverResolveState.waiters.push(launch);
  });
}
function resolveCoverUrlForDisplay(raw, allowBlob) {
  raw = normalizeListenCoverUrl(raw);
  if (!raw) return Promise.resolve('');
  if (/^blob:/i.test(raw)) return Promise.resolve(raw);
  if (mineradioUsesWebMediaBridge() && typeof window.__mineradioResolveCoverUrl === 'function') {
    return runWebCoverResolveTask(function() {
      return window.__mineradioResolveCoverUrl(raw, !!allowBlob).then(function(resolved) {
        return resolved || coverProxySrc(raw) || raw;
      }).catch(function(){ return coverProxySrc(raw) || raw; });
    });
  }
  return Promise.resolve(coverProxySrc(raw) || raw);
}
function resolveCoverUrlForCanvas(raw) {
  raw = normalizeListenCoverUrl(raw);
  if (!raw) return Promise.resolve('');
  if (/^data:image\//i.test(raw)) return Promise.resolve(raw);
  if (!mineradioUsesWebMediaBridge()) return Promise.resolve(coverProxySrc(raw) || raw);
  if (typeof window.__mineradioResolveCoverUrlForCanvas === 'function') {
    return window.__mineradioResolveCoverUrlForCanvas(raw, false).then(function(dataUrl) {
      if (dataUrl) return dataUrl;
      return window.__mineradioResolveCoverUrlForCanvas(raw, true);
    });
  }
  if (typeof window.__mineradioResolveCoverUrl !== 'function') return Promise.resolve('');
  return window.__mineradioResolveCoverUrl(raw, false).then(function(resolved) {
    if (resolved && (/^blob:/i.test(resolved) || /^data:image\//i.test(resolved))) return resolved;
    return window.__mineradioResolveCoverUrl(raw, true);
  }).then(function(resolved) {
    return (resolved && (/^blob:/i.test(resolved) || /^data:image\//i.test(resolved))) ? resolved : '';
  });
}
function mergeQQSongCoverMeta(song, meta) {
  if (!song || !meta) return song;
  if (meta.albumMid && !song.albumMid) song.albumMid = meta.albumMid;
  if (meta.cover && !song.cover) song.cover = meta.cover;
  if (meta.mediaMid && !song.mediaMid) song.mediaMid = meta.mediaMid;
  return song;
}
function reloadParticleCoverForSong(song, token, delay) {
  if (!song || !coverApplyStillCurrent({ trackToken: token })) return;
  var coverSrc = resolveSongCoverUrl(song, mineradioUsesWebMediaBridge() ? 300 : 500);
  if (!coverSrc) return;
  loadCoverFromUrl(coverSrc, {
    trackToken: token,
    deferHeavy: true,
    delay: delay || 80,
    timeout: 4500
  });
}
function ensureHomeCoverObserver() {
  if (homeCoverObserver || typeof IntersectionObserver !== 'function') return homeCoverObserver;
  homeCoverObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      homeCoverObserver.unobserve(el);
      if (el.dataset.coverHydrated === '1') return;
      el.dataset.coverHydrated = '1';
      var raw = el.getAttribute('data-cover-url') || '';
      if (raw) applyHomeCoverElement(el, raw);
    });
  }, { root: null, rootMargin: '120px 0px', threshold: 0.01 });
  return homeCoverObserver;
}
function applyHomeCoverElement(el, raw) {
  if (!el) return;
  raw = normalizeListenCoverUrl(raw);
  if (!raw) return;
  resolveCoverUrlForDisplay(raw, false).then(function(resolved) {
    if (!resolved || !el.isConnected) return;
    el.style.backgroundImage = 'url("' + cssImageUrl(resolved) + '")';
    el.classList.add('has-cover');
    el.classList.remove('home-skeleton');
  });
}
function songCustomCoverKey(song) {
  if (!song) return '';
  if (song.customCoverKey) return String(song.customCoverKey);
  if (song.provider === 'kg' || song.source === 'kg' || song.type === 'kg') return 'kg:' + (song.hash || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.localKey) return 'local:' + song.localKey;
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.id != null && song.id !== '') return 'id:' + song.id;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  return (title || artist) ? ('meta:' + (title + '|' + artist).slice(0, 220)) : '';
}
function getCustomCoverForSong(song) {
  if (!song) return '';
  if (song.customCover) return song.customCover;
  var key = songCustomCoverKey(song);
  return key && customCoverMap[key] ? customCoverMap[key] : '';
}
function hydrateCustomCover(song) {
  if (!song) return song;
  var custom = getCustomCoverForSong(song);
  if (custom) song.customCover = custom;
  return song;
}
function songCoverSrc(song, size) {
  var url = resolveSongCoverUrl(song, size);
  return url ? coverProxySrc(url) : '';
}
function mineradioRetryCoverImg(img) {
  if (!img || img.dataset.coverRetry === '1') { if (img) img.style.opacity = 0.2; return; }
  var raw = img.getAttribute('data-cover-url') || img.src || '';
  if (!raw || !window.__mineradioResolveCoverUrl) { img.style.opacity = 0.2; return; }
  img.dataset.coverRetry = '1';
  resolveCoverUrlForDisplay(raw, false).then(function(resolved) {
    if (resolved && resolved !== raw) img.src = resolved;
    else img.style.opacity = 0.2;
  }).catch(function(){ img.style.opacity = 0.2; });
}
function cssImageUrl(url) {
  url = normalizeListenCoverUrl(url) || String(url || '');
  return url.replace(/\\/g, '\\\\').replace(/"/g, '%22');
}
function setHomeArt(id, url, size) {
  var el = document.getElementById(id);
  if (!el) return;
  var normalized = normalizeListenCoverUrl(url);
  var src = normalized ? coverUrlWithSize(normalized, size || 260) : '';
  var proxied = src ? coverProxySrc(src) : '';
  el.style.backgroundImage = proxied ? 'url("' + cssImageUrl(proxied) + '")' : '';
  el.classList.toggle('has-cover', !!proxied);
  el.classList.toggle('home-skeleton', !proxied && homeDiscoverState.loading);
  if (normalized && mineradioUsesWebMediaBridge()) {
    resolveCoverUrlForDisplay(src || normalized, false).then(function(resolved) {
      if (!resolved || !el || !el.isConnected) return;
      el.style.backgroundImage = 'url("' + cssImageUrl(resolved) + '")';
      el.classList.add('has-cover');
      el.classList.remove('home-skeleton');
    });
  }
}
function compactHomeCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return Math.round(n / 10000) + '万';
  return n ? String(n) : '';
}
function loadListenStatsState() {
  try {
    var raw = localStorage.getItem(HOME_LISTEN_STATS_KEY);
    if (!raw) return { history: [], songs: {}, artists: {}, updatedAt: 0 };
    var data = JSON.parse(raw);
    return {
      history: Array.isArray(data.history) ? data.history.slice(0, 180) : [],
      songs: data.songs && typeof data.songs === 'object' ? data.songs : {},
      artists: data.artists && typeof data.artists === 'object' ? data.artists : {},
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch (e) {
    return { history: [], songs: {}, artists: {}, updatedAt: 0 };
  }
}
function migrateListenStatsCovers() {
  var changed = false;
  (listenStatsState.history || []).forEach(function(item, i) {
    if (!item) return;
    var norm = normalizeListenCoverUrl(item.cover);
    if (norm !== (item.cover || '')) {
      listenStatsState.history[i].cover = norm;
      changed = true;
    }
  });
  Object.keys(listenStatsState.songs || {}).forEach(function(key) {
    var song = listenStatsState.songs[key];
    if (!song) return;
    var norm = normalizeListenCoverUrl(song.cover);
    if (norm !== (song.cover || '')) {
      song.cover = norm;
      changed = true;
    }
  });
  if (changed) saveListenStatsState();
}
function saveListenStatsState() {
  try {
    listenStatsState.updatedAt = Date.now();
    localStorage.setItem(HOME_LISTEN_STATS_KEY, JSON.stringify(listenStatsState));
  } catch (e) {}
}
function listenSongSnapshot(song) {
  song = song || {};
  return {
    key: queueItemKey(song),
    id: song.id || '',
    mid: song.mid || song.songmid || '',
    mediaMid: song.mediaMid || song.media_mid || '',
    type: song.type || 'song',
    sourceKey: song.source || song.provider || '',
    name: song.name || song.title || '未知歌曲',
    artist: song.artist || '',
    cover: listenCoverFromSong(song) || '',
    source: songSourceLabel(song),
    provider: song.provider || song.source || song.type || '',
    duration: Number(song.duration) || 0,
  };
}
function accumulateListenSessionTick(force) {
  if (!listenSession || !audio || !audio.duration || audio.paused) return;
  var now = Date.now();
  var audioTime = isFinite(audio.currentTime) ? audio.currentTime : 0;
  var deltaByAudio = Math.max(0, audioTime - (listenSession.lastAudioTime || 0)) * 1000;
  var deltaByWall = Math.max(0, now - (listenSession.lastWallAt || now));
  var delta = deltaByAudio > 0 ? Math.min(deltaByAudio, deltaByWall || deltaByAudio, 4200) : 0;
  if (force && delta <= 0) delta = Math.min(deltaByWall, 1500);
  if (delta > 0 && delta < 8000) listenSession.listenMs += delta;
  listenSession.lastWallAt = now;
  listenSession.lastAudioTime = audioTime;
  listenSession.maxProgress = Math.max(listenSession.maxProgress || 0, audio.duration ? audioTime / audio.duration : 0);
}
function beginListenSession(song, context) {
  if (!song) return;
  var snap = listenSongSnapshot(song);
  if (!snap.key) return;
  if (listenSession && listenSession.key !== snap.key) finalizeListenSession(false);
  listenSession = {
    key: snap.key,
    song: snap,
    context: context || activeRadioContext || null,
    startedAt: Date.now(),
    lastWallAt: Date.now(),
    lastAudioTime: audio && isFinite(audio.currentTime) ? audio.currentTime : 0,
    listenMs: 0,
    maxProgress: 0,
  };
}
function updateListenStatsTick(force) {
  if (!audio || !audio.duration || audio.paused) return;
  var song = currentCoverSong();
  if (!song) return;
  var key = queueItemKey(song);
  if (!listenSession) beginListenSession(song, activeRadioContext);
  if (!listenSession || listenSession.key !== key) return;
  accumulateListenSessionTick(force);
}
function finalizeListenSession(completed) {
  if (!listenSession) return;
  accumulateListenSessionTick(true);
  var session = listenSession;
  listenSession = null;
  var effective = completed || session.listenMs >= 45000 || session.maxProgress >= 0.5 || (!audio || !audio.duration ? session.listenMs >= 30000 : false);
  if (!effective) return;
  var now = Date.now();
  var snap = session.song || {};
  var record = {
    key: session.key,
    id: snap.id || '',
    mid: snap.mid || '',
    mediaMid: snap.mediaMid || '',
    type: snap.type || 'song',
    sourceKey: snap.sourceKey || '',
    name: snap.name || '未知歌曲',
    artist: snap.artist || '',
    cover: normalizeListenCoverUrl(snap.cover || ''),
    source: snap.source || '',
    playedAt: now,
    listenMs: Math.round(session.listenMs),
    completed: !!completed,
    context: session.context || null,
  };
  listenStatsState.history = [record].concat((listenStatsState.history || []).filter(function(item){ return item && item.key !== record.key; })).slice(0, 180);
  var songStat = listenStatsState.songs[record.key] || { key: record.key, name: record.name, artist: record.artist, cover: record.cover, source: record.source, plays: 0, listenMs: 0, completed: 0, lastPlayedAt: 0 };
  songStat.name = record.name;
  songStat.artist = record.artist;
  songStat.cover = record.cover || songStat.cover || '';
  songStat.source = record.source || songStat.source || '';
  songStat.plays += 1;
  songStat.listenMs += record.listenMs;
  songStat.completed += completed ? 1 : 0;
  songStat.lastPlayedAt = now;
  listenStatsState.songs[record.key] = songStat;
  String(record.artist || '').split(/\s*\/\s*|\s*,\s*|、|&/).forEach(function(name){
    name = name.trim();
    if (!name) return;
    var artistStat = listenStatsState.artists[name] || { name: name, plays: 0, listenMs: 0, lastPlayedAt: 0 };
    artistStat.plays += 1;
    artistStat.listenMs += record.listenMs;
    artistStat.lastPlayedAt = now;
    listenStatsState.artists[name] = artistStat;
  });
  saveListenStatsState();
  if (emptyHomeActive) renderHomeDiscover();
}
function mostPlayedSong() {
  var list = Object.keys((listenStatsState && listenStatsState.songs) || {}).map(function(key){ return listenStatsState.songs[key]; });
  list.sort(function(a, b){ return (b.plays - a.plays) || (b.listenMs - a.listenMs) || (b.lastPlayedAt - a.lastPlayedAt); });
  return list[0] || null;
}
function topListenArtist() {
  var list = Object.keys((listenStatsState && listenStatsState.artists) || {}).map(function(key){ return listenStatsState.artists[key]; });
  list.sort(function(a, b){ return (b.plays - a.plays) || (b.listenMs - a.listenMs) || (b.lastPlayedAt - a.lastPlayedAt); });
  return list[0] || null;
}
function homeListenSummary() {
  var stats = listenStatsState || { history: [], songs: {}, artists: {} };
  var recent = enrichListenRecord((stats.history || [])[0] || null);
  var topSongRaw = mostPlayedSong();
  var topSong = topSongRaw ? enrichListenRecord(topSongRaw) : null;
  var topArtist = topListenArtist();
  var totalPlays = Object.keys(stats.songs || {}).reduce(function(sum, key){ return sum + ((stats.songs[key] && stats.songs[key].plays) || 0); }, 0);
  return { recent: recent, topSong: topSong, topArtist: topArtist, totalPlays: totalPlays };
}
function fallbackHomeTiles() {
  return [
    { kind: 'login', title: '登录同步歌单', sub: '网易云 / QQ 音乐' },
    { kind: 'search', title: '搜索一首歌', sub: '原唱优先', query: '' },
    { kind: 'local', title: '导入本地音乐', sub: '本地文件也能可视化' },
    { kind: 'podcastSearch', title: '搜索播客', sub: '长内容 / 电台' },
  ];
}
function coverForListenArtist(artistName) {
  var name = String(artistName || '').trim();
  if (!name) return '';
  var list = Object.keys(listenStatsState.songs || {}).map(function(key){ return listenStatsState.songs[key]; });
  list.sort(function(a, b){ return (b.plays - a.plays) || (b.lastPlayedAt - a.lastPlayedAt); });
  for (var i = 0; i < list.length; i++) {
    var song = list[i];
    if (!song || !song.cover) continue;
    if (String(song.artist || '').indexOf(name) >= 0) return normalizeListenCoverUrl(song.cover);
  }
  return '';
}
function homeTileSong(item) {
  if (!item) return null;
  if (item.kind === 'song' || item.kind === 'weatherSong') return item.song || null;
  if (item.kind === 'recent') return item.record ? songFromListenRecord(item.record) : null;
  return null;
}
function homeCardSong(key) {
  var summary = homeListenSummary();
  if (key === 'daily') return homeDiscoverState.songs[0] || null;
  if (key === 'private') return homeDiscoverState.songs[1] || null;
  if (key === 'library-song') return homeDiscoverState.songs[2] || null;
  if (key === 'continue') return summary.recent ? songFromListenRecord(summary.recent) : null;
  return null;
}
function homeFeaturedReviewSong(index) {
  var item = homeFeaturedReviewsState.reviews[index];
  return item && item.song ? normalizeFeaturedReviewPlaySong(item.song) : null;
}
function isHomeSongPlaying(song) {
  if (!song || currentIdx < 0 || !playQueue.length) return false;
  var current = playQueue[currentIdx];
  return !!(current && queueItemKey(current) === queueItemKey(song));
}
function beginHomePlayback(song) {
  if (!song) return Promise.resolve(null);
  primeWebPlaybackUnlockIfNeeded({});
  showLoading({ light: !!firstPlayDone });
  var urlFetchPromise = fetchPlaybackSourceData(song).catch(function(err){
    console.warn('[HomePlayPrefetch]', err);
    return null;
  });
  prefetchPlaybackAudioForSong(song);
  return urlFetchPromise;
}
function refreshHomePlayingState() {
  if (!emptyHomeActive) return;
  var playingKey = currentIdx >= 0 && playQueue[currentIdx] ? queueItemKey(playQueue[currentIdx]) : '';
  document.querySelectorAll('.home-card[data-home-card]').forEach(function(card){
    var song = homeCardSong(card.getAttribute('data-home-card'));
    card.classList.toggle('playing', !!(song && playingKey && queueItemKey(song) === playingKey));
  });
  var row = document.getElementById('home-tile-row');
  if (row && row._homeTiles) {
    row.querySelectorAll('.home-tile[data-home-tile-index]').forEach(function(tile){
      var i = Number(tile.getAttribute('data-home-tile-index'));
      var song = homeTileSong(row._homeTiles[i]);
      tile.classList.toggle('playing', !!(song && playingKey && queueItemKey(song) === playingKey));
    });
  }
  var reviewCard = document.querySelector('#home-reviews-feed .home-review-card');
  if (reviewCard && homeFeaturedReviewsState.reviews.length) {
    var reviewSong = homeFeaturedReviewSong(homeFeaturedReviewsState.index);
    reviewCard.classList.toggle('playing', !!(reviewSong && playingKey && queueItemKey(reviewSong) === playingKey));
  }
}
function scheduleHomeSongPrefetch(song) {
  if (!song) return;
  clearTimeout(homeHoverPrefetchTimer);
  homeHoverPrefetchTimer = setTimeout(function(){
    prefetchPlaybackSourceForSong(song);
    prefetchPlaybackAudioForSong(song);
  }, 260);
}
function bindHomePlaybackPrefetch() {
  if (homePrefetchBound) return;
  homePrefetchBound = true;
  var root = document.getElementById('empty-home');
  if (!root) return;
  root.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    var tile = e.target && e.target.closest ? e.target.closest('.home-tile[data-home-tile-index]') : null;
    if (tile) {
      var row = document.getElementById('home-tile-row');
      var item = row && row._homeTiles && row._homeTiles[Number(tile.getAttribute('data-home-tile-index'))];
      var song = homeTileSong(item);
      if (song) {
        fetchPlaybackSourceData(song).catch(function(){});
        prefetchPlaybackAudioForSong(song);
      }
      return;
    }
    var card = e.target && e.target.closest ? e.target.closest('.home-card[data-home-card]') : null;
    if (card) {
      var cardSong = homeCardSong(card.getAttribute('data-home-card'));
      if (cardSong) {
        fetchPlaybackSourceData(cardSong).catch(function(){});
        prefetchPlaybackAudioForSong(cardSong);
      }
      return;
    }
    var reviewPlay = e.target && e.target.closest ? e.target.closest('.home-review-play') : null;
    if (reviewPlay) {
      var reviewSong = homeFeaturedReviewSong(homeFeaturedReviewsState.index);
      if (reviewSong) {
        fetchPlaybackSourceData(reviewSong).catch(function(){});
        prefetchPlaybackAudioForSong(reviewSong);
      }
    }
  }, { passive: true });
  root.addEventListener('mouseover', function(e){
    var tile = e.target && e.target.closest ? e.target.closest('.home-tile[data-home-tile-index]') : null;
    if (tile) {
      var row = document.getElementById('home-tile-row');
      var item = row && row._homeTiles && row._homeTiles[Number(tile.getAttribute('data-home-tile-index'))];
      scheduleHomeSongPrefetch(homeTileSong(item));
      return;
    }
    var card = e.target && e.target.closest ? e.target.closest('.home-card[data-home-card]') : null;
    if (card) scheduleHomeSongPrefetch(homeCardSong(card.getAttribute('data-home-card')));
    else if (e.target && e.target.closest && e.target.closest('.home-review-card')) scheduleHomeSongPrefetch(homeFeaturedReviewSong(homeFeaturedReviewsState.index));
  }, { passive: true });
  root.addEventListener('mouseleave', function(e){
    if (!root.contains(e.relatedTarget)) clearTimeout(homeHoverPrefetchTimer);
  }, { passive: true });
}
function homeTileCover(item) {
  if (!item) return '';
  if (item.kind === 'song' || item.kind === 'weatherSong') return songCoverSrc(item.song, 220);
  if (item.kind === 'recent' && item.cover) return coverProxySrc(coverUrlWithSize(normalizeListenCoverUrl(item.cover), 220));
  if (item.cover) return coverProxySrc(coverUrlWithSize(normalizeListenCoverUrl(item.cover), 220));
  return '';
}
function homeTileCoverRaw(item) {
  if (!item) return '';
  if (item.kind === 'song' || item.kind === 'weatherSong') return normalizeListenCoverUrl(item.song && item.song.cover);
  if (item.kind === 'recent' && item.record) return enrichListenRecord(item.record).cover || normalizeListenCoverUrl(item.cover);
  return normalizeListenCoverUrl(item.cover);
}
function hydrateHomeTileCovers() {
  var row = document.getElementById('home-tile-row');
  var mosaic = document.getElementById('home-mosaic');
  var targets = [];
  if (row) targets = targets.concat(Array.prototype.slice.call(row.querySelectorAll('.home-tile-cover[data-cover-url]')));
  if (mosaic) targets = targets.concat(Array.prototype.slice.call(mosaic.querySelectorAll('.home-mosaic-cell[data-cover-url]')));
  if (!targets.length) return;
  if (mineradioUsesWebMediaBridge() && typeof IntersectionObserver === 'function') {
    var obs = ensureHomeCoverObserver();
    if (obs) {
      targets.forEach(function(el) {
        if (el.dataset.coverHydrated === '1') return;
        obs.observe(el);
      });
      return;
    }
  }
  targets.forEach(function(el) {
    applyHomeCoverElement(el, el.getAttribute('data-cover-url') || '');
  });
}
function homeToneForItem(item, index) {
  if (!item) return 'daily';
  if (item.kind === 'weatherSong') return 'daily';
  if (item.kind === 'recent') return 'search';
  if (item.kind === 'profile') return 'local';
  if (item.tone) return item.tone;
  if (item.kind === 'song') return index % 2 ? 'search' : 'daily';
  if (item.kind === 'playlist') return 'playlist';
  if (item.kind === 'podcast' || item.kind === 'podcastSearch') return 'podcast';
  if (item.kind === 'local') return 'local';
  if (item.kind === 'guide') return 'guide';
  if (item.kind === 'login') return 'library';
  if (item.kind === 'search') return 'search';
  return ['daily', 'playlist', 'local', 'guide', 'search'][index % 5];
}
function renderHomeMosaic(items) {
  var cells = document.querySelectorAll('#home-mosaic .home-mosaic-cell');
  if (!cells.length) return;
  var covers = [];
  var coverRaws = [];
  (items || []).forEach(function(item){
    var cover = homeTileCover(item);
    var raw = homeTileCoverRaw(item);
    if (cover) covers.push(cover);
    if (raw) coverRaws.push(raw);
  });
  for (var i = 0; i < cells.length; i++) {
    var src = covers[i] || covers[(i + 1) % Math.max(1, covers.length)] || '';
    var rawSrc = coverRaws[i] || coverRaws[(i + 1) % Math.max(1, coverRaws.length)] || '';
    cells[i].style.backgroundImage = (src && !mineradioUsesWebMediaBridge()) ? 'url("' + cssImageUrl(src) + '")' : '';
    if (rawSrc) {
      cells[i].setAttribute('data-cover-url', rawSrc);
      delete cells[i].dataset.coverHydrated;
    } else cells[i].removeAttribute('data-cover-url');
    cells[i].classList.toggle('has-cover', !!(src && !mineradioUsesWebMediaBridge()));
    cells[i].classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
  }
}
function renderHomeTiles() {
  var row = document.getElementById('home-tile-row');
  var title = document.getElementById('home-rail-title');
  var note = document.getElementById('home-rail-note');
  if (!row) return;
  var tiles = [];
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var weatherSongs = homeWeatherRadioState.radio && homeWeatherRadioState.radio.songs || [];
  var summary = homeListenSummary();
  if (summary.recent && tiles.length < HOME_TILE_MAX) {
    tiles.push({ kind: 'recent', title: summary.recent.name || '继续听', sub: summary.recent.artist || summary.recent.source || '', cover: summary.recent.cover, record: summary.recent });
  }
  if (summary.topArtist && tiles.length < HOME_TILE_MAX) {
    tiles.push({
      kind: 'profile',
      title: summary.topArtist.name,
      sub: '常听歌手 · ' + summary.topArtist.plays + ' 次',
      query: summary.topArtist.name,
      cover: coverForListenArtist(summary.topArtist.name) || ((mostPlayedSong() && mostPlayedSong().cover) || ''),
    });
  }
  if (!loggedOutHome) {
    homeDiscoverState.songs.slice(0, Math.max(0, HOME_TILE_MAX - 2 - tiles.length)).forEach(function(song, i){
      tiles.push({ kind: 'song', index: i, song: song, title: song.name || '今日歌曲', sub: song.artist || songSourceLabel(song) });
    });
    homeDiscoverState.playlists.slice(0, Math.max(0, HOME_TILE_MAX - tiles.length)).forEach(function(pl, i){
      tiles.push({ kind: 'playlist', index: i, title: pl.name || '推荐歌单', sub: (pl.trackCount ? pl.trackCount + ' 首' : 'Playlist') + (pl.playCount ? ' · ' + compactHomeCount(pl.playCount) + ' 播放' : ''), cover: pl.cover });
    });
    if (tiles.length < HOME_TILE_MAX) {
      homeDiscoverState.podcasts.slice(0, HOME_TILE_MAX - tiles.length).forEach(function(p, i){
        tiles.push({ kind: 'podcast', index: i, title: p.name || '热门播客', sub: p.djName || p.category || 'Podcast', cover: p.cover });
      });
    }
  }
  if (tiles.length < HOME_TILE_MAX) {
    weatherSongs.slice(0, HOME_TILE_MAX - tiles.length).forEach(function(song, i){
      tiles.push({ kind: 'weatherSong', index: i, song: song, title: song.name || '天气电台歌曲', sub: song.artist || songSourceLabel(song) });
    });
  }
  if (!tiles.length) tiles = fallbackHomeTiles();
  tiles = tiles.slice(0, HOME_TILE_MAX);
  if (title) title.textContent = summary.recent ? '接着听' : (loggedOutHome ? '先从这里开始' : '你的歌单与推荐');
  if (note) {
    var liveNote = homeDiscoverState.updatedAt ? '刚刚更新 · 点击即可播放' : '点击即可播放';
    note.textContent = homeDiscoverState.loading ? '正在整理推荐' : (loggedOutHome && !weatherSongs.length ? '不会自动拉取外部推荐' : (homeDiscoverState.error ? '离线精选' : liveNote));
  }
  row.innerHTML = tiles.map(function(item, i){
    var cover = homeTileCover(item);
    var coverRaw = homeTileCoverRaw(item);
    var tone = homeToneForItem(item, i);
    var webLazyCover = mineradioUsesWebMediaBridge();
    var coverClass = 'home-tile-cover' + (cover && !webLazyCover ? ' has-cover' : '');
    var coverAttr = coverRaw ? (' data-cover-url="' + escHtml(coverRaw) + '"') : '';
    var coverStyle = (cover && !webLazyCover) ? ('background-image:url(&quot;' + escHtml(cssImageUrl(cover)) + '&quot;)') : '';
    var playing = isHomeSongPlaying(homeTileSong(item));
    return '<button class="home-tile' + (playing ? ' playing' : '') + (!cover && homeDiscoverState.loading ? ' home-skeleton' : '') + '" data-home-tone="' + escHtml(tone) + '" data-home-tile-index="' + i + '" type="button" onclick="handleHomeTileClick(' + i + ')">' +
      '<div class="' + coverClass + '"' + coverAttr + ' style="' + coverStyle + '"></div>' +
      '<div class="home-tile-title">' + escHtml(item.title || '') + '</div>' +
      '<div class="home-tile-sub">' + escHtml(item.sub || '') + '</div>' +
    '</button>';
  }).join('');
  row._homeTiles = tiles;
  renderHomeMosaic(tiles);
  hydrateHomeTileCovers();
  refreshHomePlayingState();
}
var listenStatsCoversMigrated = false;
var homeRecentCoverFetchToken = 0;
async function fetchListenCoverByRecord(record) {
  if (!record) return '';
  var keyword = [record.name, record.artist].filter(Boolean).join(' ').trim();
  if (!keyword && !record.id && !record.mid) return '';
  try {
    var isQQ = record.sourceKey === 'qq' || String(record.key || '').indexOf('qq:') === 0 || record.type === 'qq';
    if (isQQ) {
      var qr = await apiJson('/api/qq/search?keywords=' + encodeURIComponent(keyword || record.name || '') + '&limit=6');
      var qsongs = (qr && qr.songs) || [];
      for (var i = 0; i < qsongs.length; i++) {
        var qs = qsongs[i];
        if ((record.mid && (qs.mid === record.mid || qs.songmid === record.mid)) || (record.id && String(qs.id) === String(record.id))) {
          return normalizeListenCoverUrl(qs.cover);
        }
      }
    } else {
      var r = await apiJson('/api/search?keywords=' + encodeURIComponent(keyword || record.name || '') + '&limit=8');
      var songs = (r && r.songs) || [];
      for (var j = 0; j < songs.length; j++) {
        var ns = songs[j];
        if (record.id && String(ns.id) === String(record.id) && ns.cover) return normalizeListenCoverUrl(ns.cover);
      }
      if (songs[0] && songs[0].cover) return normalizeListenCoverUrl(songs[0].cover);
    }
  } catch (e) {}
  return '';
}
async function backfillRecentListenCoverIfNeeded() {
  var recent = homeListenSummary().recent;
  if (!recent || recent.cover) return;
  var token = ++homeRecentCoverFetchToken;
  var cover = await fetchListenCoverByRecord(recent);
  if (!cover || token !== homeRecentCoverFetchToken) return;
  if (listenStatsState.history[0] && listenStatsState.history[0].key === recent.key) {
    listenStatsState.history[0].cover = cover;
  }
  if (listenStatsState.songs[recent.key]) listenStatsState.songs[recent.key].cover = cover;
  saveListenStatsState();
  if (emptyHomeActive) renderHomeDiscover();
}
function renderHomeDiscover() {
  if (!listenStatsCoversMigrated) {
    listenStatsCoversMigrated = true;
    migrateListenStatsCovers();
  }
  var sub = document.getElementById('home-subtitle');
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var weather = homeWeatherRadioState.weather;
  var radio = homeWeatherRadioState.radio;
  var weatherLocation = weather && weather.location && weather.location.name || homeWeatherRadioState.city || '上海';
  var weatherTitle = document.getElementById('home-weather-title');
  var weatherKicker = document.getElementById('home-weather-kicker');
  var weatherMeta = document.getElementById('home-weather-meta');
  if (weatherTitle) weatherTitle.textContent = '我的音乐库';
  if (weatherKicker) weatherKicker.textContent = 'Mineradio · Your Library';
  if (sub) {
    if (loggedOutHome) sub.textContent = '登录后会把你的歌单、常听歌手和最近播放放在这里；也可以直接搜索或导入本地音乐。';
    else sub.textContent = '从你的歌单、最近播放和常听歌手开始，天气电台放在需要氛围的时候再开。';
  }
  if (weatherMeta) {
    var meta = [];
    if (weather) {
      meta.push(weatherLocation);
      meta.push(weather.label + ' · ' + Math.round(weather.temperature || 0) + '°');
      meta.push('体感 ' + Math.round(weather.apparentTemperature || weather.temperature || 0) + '°');
      if (isFinite(weather.humidity)) meta.push('湿度 ' + Math.round(weather.humidity) + '%');
    } else {
      meta.push(weatherLocation);
      meta.push(homeWeatherRadioState.error ? '天气暂不可用' : '正在整理天气');
    }
    weatherMeta.innerHTML = meta.map(function(text){ return '<span class="home-weather-pill">' + escHtml(text) + '</span>'; }).join('');
  }
  var daily = homeDiscoverState.songs[0] || null;
  var cardSongB = homeDiscoverState.songs[1] || null;
  var cardSongC = homeDiscoverState.songs[2] || null;
  var playlistItem = homeDiscoverState.playlists[0] || null;
  var podcastItem = homeDiscoverState.podcasts[0] || null;
  var summary = homeListenSummary();
  var weatherCardTitle = document.getElementById('home-weather-card-title');
  var weatherCardSub = document.getElementById('home-weather-card-sub');
  var dailyTitle = document.getElementById('home-daily-title');
  var dailySub = document.getElementById('home-daily-sub');
  var privateTitle = document.getElementById('home-private-title');
  var privateSub = document.getElementById('home-private-sub');
  var continueTitle = document.getElementById('home-continue-title');
  var continueSub = document.getElementById('home-continue-sub');
  var profileTitle = document.getElementById('home-profile-title');
  var profileSub = document.getElementById('home-profile-sub');
  var libTitle = document.getElementById('home-library-title');
  var libSub = document.getElementById('home-library-sub');
  if (weatherCardTitle) weatherCardTitle.textContent = '我的歌单';
  if (weatherCardSub) {
    weatherCardSub.textContent = playlistItem ? (((playlistItem.trackCount || 0) ? playlistItem.trackCount + ' 首 · ' : '') + (playlistItem.creator || '打开左侧歌单库')) : '打开左侧歌单库';
  }
  if (continueTitle) continueTitle.textContent = summary.recent ? summary.recent.name : '继续听';
  if (continueSub) continueSub.textContent = summary.recent ? (summary.recent.artist || summary.recent.source || '最近播放') : '最近播放会出现在这里';
  if (profileTitle) profileTitle.textContent = summary.topArtist ? summary.topArtist.name : (summary.topSong ? summary.topSong.name : '听歌画像');
  if (profileSub) profileSub.textContent = summary.topArtist ? ('常听歌手 · ' + summary.topArtist.plays + ' 次') : (summary.totalPlays ? summary.totalPlays + ' 次有效播放' : '播放几首后生成偏好');
  if (loggedOutHome) {
    if (dailyTitle) dailyTitle.textContent = '每日推荐';
    if (dailySub) dailySub.textContent = '登录后同步你的今日歌曲';
    if (privateTitle) privateTitle.textContent = '推荐歌曲';
    if (privateSub) privateSub.textContent = '登录后同步更多歌曲';
    if (libTitle) libTitle.textContent = '更多歌曲';
    if (libSub) libSub.textContent = '播放后会继续补全推荐';
    setHomeArt('home-weather-art', '', 280);
    setHomeArt('home-daily-art', '', 280);
    setHomeArt('home-private-art', '', 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover, 280);
    setHomeArt('home-library-art', '', 280);
  } else {
    if (dailyTitle) dailyTitle.textContent = daily ? daily.name : '每日推荐';
    if (dailySub) {
      if (daily) dailySub.textContent = (daily.artist || songSourceLabel(daily) || '今日歌曲') + ' · 点击播放今日队列';
      else if (homeDiscoverState.loading) dailySub.textContent = '正在同步今日推荐…';
      else if (homeDiscoverState.error) dailySub.textContent = '同步失败 · 点击重试';
      else if (hasPlatformLogin('netease')) dailySub.textContent = '今日推荐暂不可用 · 点击重试';
      else dailySub.textContent = '需登录网易云后同步今日歌曲';
    }
    if (privateTitle) privateTitle.textContent = cardSongB ? cardSongB.name : '私人雷达';
    if (privateSub) privateSub.textContent = cardSongB ? (cardSongB.artist || songSourceLabel(cardSongB) || '推荐歌曲') : (homeDiscoverState.songs.length + ' 首 · 根据今日推荐与常听偏好');
    if (libTitle) libTitle.textContent = cardSongC ? cardSongC.name : (summary.topArtist ? summary.topArtist.name : '更多歌曲');
    if (libSub) libSub.textContent = cardSongC ? (cardSongC.artist || songSourceLabel(cardSongC) || '推荐歌曲') : (summary.topArtist ? ('歌手偏好 · ' + summary.topArtist.plays + ' 次') : '播放几首后生成你的偏好');
    setHomeArt('home-weather-art', (userPlaylists[0] && userPlaylists[0].cover) || (playlistItem && playlistItem.cover) || daily && daily.cover, 280);
    setHomeArt('home-daily-art', daily && daily.cover, 280);
    setHomeArt('home-private-art', cardSongB && cardSongB.cover || daily && daily.cover || summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || podcastItem && podcastItem.cover, 280);
    setHomeArt('home-library-art', cardSongC && cardSongC.cover || summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover || podcastItem && podcastItem.cover, 280);
  }
  renderHomeTiles();
  backfillRecentListenCoverIfNeeded();
  refreshHomePlayingState();
}
function stopHomeFeaturedReviewsAuto() {
  if (homeFeaturedReviewsTimer) {
    clearInterval(homeFeaturedReviewsTimer);
    homeFeaturedReviewsTimer = null;
  }
}
function startHomeFeaturedReviewsAuto() {
  stopHomeFeaturedReviewsAuto();
  if (!emptyHomeActive || !homeFeaturedReviewsState.reviews.length) return;
  homeFeaturedReviewsTimer = setInterval(function(){
    if (!emptyHomeActive || homeFeaturedReviewsState.reviews.length < 2) return;
    homeFeaturedReviewGo((homeFeaturedReviewsState.index + 1) % homeFeaturedReviewsState.reviews.length, true);
  }, 6800);
}
function hasAnyPlatformLogin() {
  return !!(loginStatus.loggedIn || qqLoginStatus.loggedIn || kgLoginStatus.loggedIn);
}
function featuredReviewSeedPayload(song) {
  song = song || {};
  var provider = songProviderKey(song);
  return {
    provider: provider,
    source: provider,
    type: song.type || (provider === 'qq' ? 'qq' : 'song'),
    id: song.id,
    qqId: song.qqId,
    mid: song.mid || song.songmid,
    songmid: song.mid || song.songmid,
    name: song.name,
    artist: song.artist,
    cover: song.cover
  };
}
function truncateFeaturedReviewText(text, maxLen) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  maxLen = maxLen || 128;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
function featuredReviewSongCover(song, size) {
  song = song || {};
  var cover = song.cover ? coverUrlWithSize(song.cover, size || 120) : '';
  if (cover) return coverProxySrc(cover);
  return '';
}
function renderHomeFeaturedReviews() {
  var feed = document.getElementById('home-reviews-feed');
  var dots = document.getElementById('home-reviews-dots');
  var sub = document.getElementById('home-reviews-sub');
  if (!feed) return;
  var reviews = homeFeaturedReviewsState.reviews || [];
  if (sub) {
    if (homeFeaturedReviewsState.loading && !reviews.length) sub.textContent = '正在整理高赞热评…';
    else if (homeFeaturedReviewsState.error === 'FEATURED_REVIEWS_FAILED') sub.textContent = '暂时无法拉取热评，稍后会自动重试';
    else if (homeFeaturedReviewsState.error === 'EMPTY') sub.textContent = hasAnyPlatformLogin() ? '暂未拉到热评，正在重试…' : '登录后会从每日推荐里摘取乐评';
    else if (reviews.length) sub.textContent = '从今日歌曲里摘取高赞热评 · 点击播放即可收听';
    else sub.textContent = hasAnyPlatformLogin() ? '正在整理高赞热评…' : '登录后会从每日推荐里摘取乐评';
  }
  if (homeFeaturedReviewsState.loading && !reviews.length) {
    feed.innerHTML = '<div class="home-reviews-loading home-skeleton">正在载入精选乐评…</div>';
    if (dots) dots.innerHTML = '';
    return;
  }
  if (!reviews.length) {
    feed.innerHTML = hasAnyPlatformLogin()
      ? '<div class="home-reviews-empty">热评加载中，若长时间空白请刷新页面或确认 Bridge 扩展已启用。</div>'
      : '<div class="home-reviews-empty">登录后，这里会展示来自每日推荐的高赞乐评。</div>';
    if (dots) dots.innerHTML = '';
    return;
  }
  if (homeFeaturedReviewsState.index >= reviews.length) homeFeaturedReviewsState.index = 0;
  var item = reviews[homeFeaturedReviewsState.index];
  var song = item && item.song || {};
  var user = item && item.user || {};
  var avatar = user.avatar ? coverUrlWithSize(user.avatar, 64) : '';
  var coverRaw = song.cover ? normalizeListenCoverUrl(song.cover) : '';
  var webLazyCover = mineradioUsesWebMediaBridge();
  var cover = webLazyCover ? '' : featuredReviewSongCover(song, 120);
  var coverStyle = cover ? ('background-image:url(&quot;' + escHtml(cssImageUrl(cover)) + '&quot;)') : '';
  var coverAttr = coverRaw ? (' data-cover-url="' + escHtml(coverRaw) + '"') : '';
  feed.innerHTML =
    '<article class="home-review-card is-active" onclick="openHomeFeaturedReviewDetail(' + homeFeaturedReviewsState.index + ')">' +
      '<div class="home-review-song">' +
        '<div class="home-review-cover' + (cover ? ' has-cover' : '') + '"' + coverAttr + ' style="' + coverStyle + '"></div>' +
        '<div class="home-review-song-main">' +
          '<div class="home-review-song-name">' + escHtml(song.name || '未知歌曲') + '</div>' +
          '<div class="home-review-song-artist">' + escHtml(song.artist || songSourceLabel(song) || '音乐用户') + '</div>' +
        '</div>' +
        '<button class="home-review-play" type="button" title="播放这首歌" aria-label="播放这首歌" onclick="event.stopPropagation();playHomeFeaturedReview(' + homeFeaturedReviewsState.index + ')">' +
          '<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="home-review-quote">“' + escHtml(truncateFeaturedReviewText(item.content, 132)) + '”</div>' +
      '<div class="home-review-foot">' +
        (avatar ? ('<img class="home-review-user-avatar" src="' + escHtml(coverProxySrc(avatar)) + '" alt="" loading="lazy" decoding="async">') : '<div class="home-review-user-avatar"></div>') +
        '<div class="home-review-user-meta">' + escHtml(user.nickname || '音乐用户') + (item.time ? (' · ' + escHtml(commentTimeLabel(item.time))) : '') + '</div>' +
        (item.likedCount ? ('<div class="home-review-like">' + escHtml(String(item.likedCount)) + ' 赞</div>') : '') +
      '</div>' +
    '</article>';
  if (dots) {
    dots.innerHTML = reviews.map(function(_, i){
      return '<button class="home-reviews-dot' + (i === homeFeaturedReviewsState.index ? ' active' : '') + '" type="button" aria-label="第 ' + (i + 1) + ' 条乐评" onclick="homeFeaturedReviewGo(' + i + ')"></button>';
    }).join('');
  }
  if (webLazyCover && coverRaw) {
    var coverEl = feed.querySelector('.home-review-cover[data-cover-url]');
    if (coverEl) applyHomeCoverElement(coverEl, coverEl.getAttribute('data-cover-url') || coverRaw);
  }
  refreshHomePlayingState();
}
function homeFeaturedReviewGo(index, auto) {
  var reviews = homeFeaturedReviewsState.reviews || [];
  if (!reviews.length) return;
  index = ((Number(index) || 0) % reviews.length + reviews.length) % reviews.length;
  if (index === homeFeaturedReviewsState.index && !auto) return;
  homeFeaturedReviewsState.index = index;
  var feed = document.getElementById('home-reviews-feed');
  if (feed) {
    var card = feed.querySelector('.home-review-card');
    if (card) {
      card.classList.remove('is-active');
      card.classList.add('is-entering');
      setTimeout(function(){
        renderHomeFeaturedReviews();
        var next = feed.querySelector('.home-review-card');
        if (next) {
          next.classList.add('is-entering');
          requestAnimationFrame(function(){
            next.classList.remove('is-entering');
            next.classList.add('is-active');
          });
        }
      }, auto ? 120 : 80);
      return;
    }
  }
  renderHomeFeaturedReviews();
}
function normalizeFeaturedReviewPlaySong(song) {
  song = cloneSong(song || {});
  var provider = songProviderKey(song);
  if (provider === 'qq') {
    song.provider = 'qq';
    song.source = 'qq';
    song.type = 'qq';
    if (!song.mid && song.songmid) song.mid = song.songmid;
    if (!song.id && song.mid) song.id = song.mid;
    return song;
  }
  song.provider = 'netease';
  song.source = 'netease';
  song.type = song.type || 'song';
  if (song.id != null && song.id !== '') song.id = String(song.id);
  return song;
}
async function resolveFeaturedReviewPlaySong(song, songIdHint) {
  song = normalizeFeaturedReviewPlaySong(song);
  if (songProviderKey(song) === 'qq') return song;
  var targetId = String(songIdHint || song.id || '').trim();
  if (!targetId) return song;
  song.id = targetId;
  var label = [song.name, song.artist].filter(Boolean).join(' ').trim();
  if (!label) return song;
  try {
    var data = await apiJson('/api/search?keywords=' + encodeURIComponent(label) + '&limit=16');
    var list = (data && (data.songs || data.result || [])) || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === targetId) return normalizeFeaturedReviewPlaySong(list[i]);
    }
    for (var j = 0; j < list.length; j++) {
      if (isSameTitleArtist(song, list[j])) return normalizeFeaturedReviewPlaySong(list[j]);
    }
  } catch (e) {
    console.warn('Featured review play resolve failed:', e);
  }
  return song;
}
async function playHomeFeaturedReview(index) {
  var item = homeFeaturedReviewsState.reviews[index];
  if (!item || !item.song) return;
  var song = await resolveFeaturedReviewPlaySong(item.song, item.songId);
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  playQueue = [song];
  currentIdx = 0;
  safeRenderQueuePanel('home-featured-review');
  safeShelfRebuild('home-featured-review', true);
  var reviewFetch = beginHomePlayback(song);
  playQueueAt(0, { fromSearch: true, urlFetchPromise: reviewFetch }).catch(function(e){ console.warn('[HomeFeaturedReviewPlay]', e); });
}
function openHomeFeaturedReviewDetail(index) {
  var item = homeFeaturedReviewsState.reviews[index];
  if (!item || !item.song) return;
  openTrackDetailModal('song', normalizeFeaturedReviewPlaySong(item.song));
}
async function loadHomeFeaturedReviews(force) {
  if (!emptyHomeActive) return;
  var cached = !force && readHomeFeaturedReviewsCache();
  if (cached && cached.reviews.length) {
    applyHomeFeaturedReviewsPayload(cached);
    homeFeaturedReviewsState.loading = false;
    renderHomeFeaturedReviews();
    startHomeFeaturedReviewsAuto();
    if (homeFeaturedReviewsState.loaded && !force) {
      refreshHomeFeaturedReviewsInBackground(false);
      return;
    }
  }
  if (homeFeaturedReviewsState.loading) return;
  if (homeFeaturedReviewsState.loaded && !force) return;
  await refreshHomeFeaturedReviewsInBackground(!!force);
}
async function refreshHomeFeaturedReviewsInBackground(showLoading) {
  if (!emptyHomeActive) return;
  if (homeFeaturedReviewsState.loading) return;
  var token = ++homeFeaturedReviewsToken;
  var hadReviews = !!(homeFeaturedReviewsState.reviews && homeFeaturedReviewsState.reviews.length);
  homeFeaturedReviewsState.loading = true;
  homeFeaturedReviewsState.error = '';
  if (showLoading || !hadReviews) renderHomeFeaturedReviews();
  try {
    var seeds = (homeDiscoverState.songs || []).slice(0, 4).map(featuredReviewSeedPayload);
    var query = '/api/home/featured-reviews';
    var params = [];
    if (seeds.length) params.push('seeds=' + encodeURIComponent(JSON.stringify(seeds)));
    if (showLoading) params.push('t=' + Date.now());
    if (params.length) query += '?' + params.join('&');
    var data = await apiJson(query);
    if (token !== homeFeaturedReviewsToken) return;
    applyHomeFeaturedReviewsPayload(data);
    if (homeFeaturedReviewsState.reviews.length) {
      writeHomeFeaturedReviewsCache(data);
    } else if (hasAnyPlatformLogin() && !showLoading) {
      setTimeout(function(){
        if (emptyHomeActive && !homeFeaturedReviewsState.reviews.length) refreshHomeFeaturedReviewsInBackground(true);
      }, 4500);
    }
  } catch (e) {
    if (token === homeFeaturedReviewsToken && !hadReviews) {
      homeFeaturedReviewsState.error = 'FEATURED_REVIEWS_FAILED';
      homeFeaturedReviewsState.reviews = [];
    }
    console.warn('Home featured reviews failed:', e);
  } finally {
    if (token === homeFeaturedReviewsToken) {
      homeFeaturedReviewsState.loading = false;
      renderHomeFeaturedReviews();
      startHomeFeaturedReviewsAuto();
    }
  }
}
async function loadHomeDiscover(force) {
  if (homeDiscoverState.loading) return;
  if (homeDiscoverState.loaded && !force) return;
  var token = ++homeDiscoverToken;
  homeDiscoverState.loading = true;
  homeDiscoverState.error = '';
  renderHomeDiscover();
  try {
    var data = await apiJson('/api/discover/home?t=' + Date.now());
    if (token !== homeDiscoverToken) return;
    homeDiscoverState.loggedIn = hasAnyPlatformLogin() && !!(data && data.loggedIn);
    homeDiscoverState.mode = data && data.mode || (homeDiscoverState.loggedIn ? 'member' : 'starter');
    homeDiscoverState.songs = (data && data.dailySongs || []).map(cloneSong);
    if (homeDiscoverState.songs.length && hasAnyPlatformLogin()) homeDiscoverState.loggedIn = true;
    homeDiscoverState.playlists = homeDiscoverState.loggedIn ? (data && data.playlists || []) : [];
    homeDiscoverState.podcasts = homeDiscoverState.loggedIn ? (data && data.podcasts || []) : [];
    homeDiscoverState.updatedAt = Number(data && data.updatedAt) || Date.now();
    homeDiscoverState.loaded = true;
  } catch (e) {
    console.warn('home discover failed:', e);
    if (token === homeDiscoverToken) homeDiscoverState.error = 'DISCOVER_FAILED';
  } finally {
    if (token === homeDiscoverToken) {
      homeDiscoverState.loading = false;
      renderHomeDiscover();
      if (homeDiscoverState.songs.length && (!homeFeaturedReviewsState.reviews.length || !homeFeaturedReviewsState.loaded)) {
        refreshHomeFeaturedReviewsInBackground(false);
      }
    }
  }
}
function homeWeatherRadioUrl(opts) {
  opts = opts || {};
  var params = [];
  if (opts.lat != null && opts.lon != null) {
    params.push('lat=' + encodeURIComponent(opts.lat));
    params.push('lon=' + encodeURIComponent(opts.lon));
    params.push('city=' + encodeURIComponent(opts.city || '当前位置'));
  } else {
    params.push('city=' + encodeURIComponent(opts.city || homeWeatherRadioState.city || '上海'));
  }
  params.push('timezone=' + encodeURIComponent(opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto'));
  params.push('t=' + Date.now());
  return '/api/weather/radio?' + params.join('&');
}
async function loadHomeWeatherRadio(force, opts) {
  opts = opts || {};
  if (homeWeatherRadioState.loading && homeWeatherLoadPromise && opts.lat == null && opts.lon == null && !opts.city) {
    return homeWeatherLoadPromise;
  }
  if (homeWeatherRadioState.loading && !force) return homeWeatherRadioState;
  if (homeWeatherRadioState.loaded && !force && !opts.lat) return homeWeatherRadioState;
  var token = ++homeWeatherToken;
  homeWeatherRadioState.loading = true;
  homeWeatherRadioState.error = '';
  renderHomeDiscover();
  var loadPromise = (async function(){
    try {
      var data = await apiJson(homeWeatherRadioUrl(opts), { timeoutMs: 14000 });
      if (token !== homeWeatherToken) return homeWeatherRadioState;
      homeWeatherRadioState.weather = data && data.weather || null;
      homeWeatherRadioState.radio = data && data.radio || null;
      homeWeatherRadioState.loaded = true;
      homeWeatherRadioState.updatedAt = Date.now();
      if (homeWeatherRadioState.weather && homeWeatherRadioState.weather.location && homeWeatherRadioState.weather.location.name) {
        homeWeatherRadioState.city = homeWeatherRadioState.weather.location.name;
        localStorage.setItem(HOME_WEATHER_CITY_KEY, homeWeatherRadioState.city);
      } else if (opts.city) {
        homeWeatherRadioState.city = opts.city;
        localStorage.setItem(HOME_WEATHER_CITY_KEY, homeWeatherRadioState.city);
      }
    } catch (e) {
      console.warn('weather radio failed:', e);
      if (token === homeWeatherToken) homeWeatherRadioState.error = 'WEATHER_FAILED';
    } finally {
      if (token === homeWeatherToken) {
        homeWeatherRadioState.loading = false;
        renderHomeDiscover();
      }
    }
    return homeWeatherRadioState;
  })();
  homeWeatherLoadPromise = loadPromise;
  try {
    return await loadPromise;
  } finally {
    if (homeWeatherLoadPromise === loadPromise) homeWeatherLoadPromise = null;
  }
}
function scheduleHomeWeatherLoad(delay) {
  if (homeWeatherLoadTimer) return;
  homeWeatherLoadTimer = setTimeout(function(){
    homeWeatherLoadTimer = null;
    if (!emptyHomeActive) return;
    loadHomeWeatherRadio(false);
  }, delay || 760);
}
function weatherRadioContext() {
  var weather = homeWeatherRadioState.weather || {};
  var radio = homeWeatherRadioState.radio || {};
  return {
    type: 'weather-radio',
    provider: 'open-meteo',
    title: radio.title || '天气电台',
    location: weather.location && weather.location.name || homeWeatherRadioState.city || '',
    weather: weather.label || '',
    temperature: weather.temperature,
    mood: weather.mood && weather.mood.key || '',
  };
}
async function startWeatherRadio(opts) {
  opts = opts || {};
  if (weatherRadioStartBusy) return;
  weatherRadioStartBusy = true;
  try {
  if (!homeWeatherRadioState.loaded || !(homeWeatherRadioState.radio && homeWeatherRadioState.radio.songs && homeWeatherRadioState.radio.songs.length)) {
    showToast('正在生成天气电台');
    await loadHomeWeatherRadio(true);
  }
  var radio = homeWeatherRadioState.radio;
  if (!radio || !radio.songs || !radio.songs.length) {
    var seed = radio && radio.seedQueries && radio.seedQueries[0] || '雨天 R&B';
    showToast('天气队列暂时为空，先打开搜索');
    runHomeSearch(seed);
    return;
  }
  activeRadioContext = weatherRadioContext();
  playQueue = radio.songs.map(function(song){
    var cloned = cloneSong(song);
    cloned.radioContext = activeRadioContext;
    return cloned;
  });
  currentIdx = 0;
  homeForcedOpen = false;
  if (!opts.preserveHomeState) homeSuppressed = false;
  setHomeControlsLocked(false);
  safeRenderQueuePanel('weather-radio-start');
  safeShelfRebuild('weather-radio-start', true);
  forcePlaybackControlsInteractive();
  try {
    await playQueueAt(0, { context: activeRadioContext });
  } catch (e) {
    console.warn('[WeatherRadioStartPlay]', e);
    showToast('天气电台已载入，播放启动失败');
  }
  forcePlaybackControlsInteractive();
  showToast((radio.title || '天气电台') + ' · ' + playQueue.length + ' 首');
  } finally {
    weatherRadioStartBusy = false;
  }
}
var emptyHomeStartEl = document.getElementById('empty-home');
if (emptyHomeStartEl) {
  emptyHomeStartEl.addEventListener('click', function(e){
    var start = e.target && e.target.closest ? e.target.closest('[data-home-radio-start]') : null;
    if (!start || !emptyHomeStartEl.contains(start)) return;
    e.preventDefault();
    e.stopPropagation();
    startWeatherRadio();
  }, true);
  emptyHomeStartEl.addEventListener('scroll', syncEmptyHomeScrollHint, { passive: true });
}
window.addEventListener('resize', function(){
  if (emptyHomeActive) scheduleUiWarmTask(syncEmptyHomeScrollHint, 80);
});
function locateWeatherRadio() {
  var previousWeatherCity = homeWeatherRadioState.city || '上海';
  homeWeatherToken++;
  homeWeatherRadioState.loading = true;
  homeWeatherRadioState.loaded = false;
  homeWeatherRadioState.error = '';
  homeWeatherRadioState.weather = null;
  homeWeatherRadioState.radio = null;
  homeWeatherRadioState.city = '定位中';
  renderHomeDiscover();
  var locationSettled = false;
  var ipFallbackStarted = false;
  function useIpFallback() {
    if (locationSettled || ipFallbackStarted) return;
    ipFallbackStarted = true;
    apiJson('/api/weather/ip-location?t=' + Date.now()).then(function(data){
      var loc = data && data.location;
      if (!loc || !isFinite(Number(loc.latitude)) || !isFinite(Number(loc.longitude))) throw new Error(data && data.error || 'IP_LOCATION_FAILED');
      if (locationSettled) return;
      locationSettled = true;
      homeWeatherRadioState.city = loc.city || '当前位置';
      localStorage.setItem(HOME_WEATHER_CITY_KEY, homeWeatherRadioState.city);
      renderHomeDiscover();
      showToast('已用网络位置定位到 ' + (loc.city || '当前位置'));
      loadHomeWeatherRadio(true, {
        lat: loc.latitude,
        lon: loc.longitude,
        city: loc.city || '当前位置',
        timezone: loc.timezone || '',
      });
    }).catch(function(e){
      console.warn('weather ip location failed:', e);
      if (locationSettled) return;
      homeWeatherRadioState.loading = false;
      homeWeatherRadioState.error = 'LOCATION_FAILED';
      homeWeatherRadioState.city = previousWeatherCity;
      renderHomeDiscover();
      showToast('定位不可用，可以手动换城市');
    });
  }
  // Desktop users need a stable city label; browser coordinates can be stale or cityless.
  useIpFallback();
}
function changeWeatherCity() {
  var city = window.prompt('输入城市名', homeWeatherRadioState.city || '上海');
  city = String(city || '').trim();
  if (!city) return;
  homeWeatherRadioState.city = city;
  localStorage.setItem(HOME_WEATHER_CITY_KEY, city);
  homeWeatherRadioState.loaded = false;
  loadHomeWeatherRadio(true, { city: city });
}
function shouldShowEmptyHomeCore(ignoreSplash) {
  if (!ignoreSplash && document.body.classList.contains('splash-active')) return false;
  if (immersiveMode) return false;
  if (homeForcedOpen) return true;
  if (homeSuppressed) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (playQueue && playQueue.length) return false;
  if (currentIdx >= 0 && playQueue[currentIdx]) return false;
  if (playing) return false;
  return true;
}
function shouldShowEmptyHome() {
  return shouldShowEmptyHomeCore(false);
}
function shouldShowEmptyHomeAfterSplash() {
  return shouldShowEmptyHomeCore(true);
}
function shouldForceEmptyHomeAfterSplash() {
  if (immersiveMode) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (playQueue && playQueue.length) return false;
  if (currentIdx >= 0 && playQueue[currentIdx]) return false;
  if (playing) return false;
  return true;
}
function shouldUseIdleWallpaperPreview(ignoreSplash) {
  if (!ignoreSplash && document.body.classList.contains('splash-active')) return false;
  if (immersiveMode || playing || (audio && !audio.paused)) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  return true;
}
function setHomeControlsLocked(locked) {
  document.body.classList.toggle('home-controls-locked', !!locked);
  var bottom = document.getElementById('bottom-bar');
  if (bottom && locked && !hasActivePlaybackControls()) bottom.classList.add('soft-hidden');
  if (bottom && !locked) bottom.classList.remove('soft-hidden');
  if (locked) closeMiniQueue();
}
function openHomePlayerConsole() {
  setHomeControlsLocked(false);
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.add('visible');
    bar.classList.remove('soft-hidden');
    bar.style.pointerEvents = '';
  }
  wakeBottomHandle(2800);
  setControlsHidden(false);
  forcePlaybackControlsInteractive();
  updateControlsChromeState();
  if (controlsAutoHide) scheduleControlsHide(1800);
  showToast('播放器控制台已展开');
}
function ensureHomeWallpaperParticles(opts) {
  opts = opts || {};
  if (uniforms && uniforms.uAlpha && opts.instant) {
    uniforms.uAlpha.value = 0.96;
  } else if (uniforms && uniforms.uAlpha && uniforms.uAlpha.value < 0.88) {
    tweenParticleAlpha(uniforms.uAlpha.value || 0, 0.96, 920);
  }
  if (uniforms && uniforms.uFloatAlpha) uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
}
function activateHomeWallpaperPreview(opts) {
  opts = opts || {};
  document.body.classList.add('home-wallpaper-preview');
  ensureHomeWallpaperParticles(opts);
}
var homeWallpaperPrewarmStarted = false;
function prewarmHomeWallpaperPreview() {
  if (homeWallpaperPrewarmStarted) return;
  homeWallpaperPrewarmStarted = true;
  if (!shouldUseIdleWallpaperPreview(true)) return;
  scheduleVisualApply(function(){
    if (!shouldUseIdleWallpaperPreview(true)) return;
    activateHomeWallpaperPreview({ skipTransition: true, instant: true });
  }, 900, 2600);
}
function deactivateHomeWallpaperPreview(playback) {
  document.body.classList.remove('home-wallpaper-preview');
  if (!homeVisualPresetActive) return;
  homeVisualPresetActive = false;
  var nextPreset = typeof homeVisualPrevPreset === 'number' ? homeVisualPrevPreset : (fx && typeof fx.preset === 'number' ? fx.preset : 0);
  if (typeof setPreset === 'function' && fx.preset !== nextPreset) {
    setPreset(nextPreset, { silent: true, preserveCamera: false, skipTransition: false, noSave: true });
  }
}
function switchPlaybackVisualToEmily() {
  if (homeVisualPresetActive) {
    deactivateHomeWallpaperPreview(true);
    return;
  }
  document.body.classList.remove('home-wallpaper-preview');
  var targetPreset = typeof playbackVisualPreset === 'number' ? playbackVisualPreset : fxDefaults.preset;
  startupVisualPreviewActive = false;
  if (typeof setPreset === 'function' && fx.preset !== targetPreset) {
    setPreset(targetPreset, { silent: true, preserveCamera: false, noSave: true });
  } else if (typeof syncFxUniforms === 'function') {
    syncFxUniforms();
  }
}
function applyStartupStarfieldPreset() {
  if (playing || currentIdx >= 0) return;
  startupVisualPreviewActive = true;
  if (typeof setPreset === 'function' && fx.preset !== 5) {
    setPreset(5, { silent: true, preserveCamera: false, skipTransition: true, noSave: true });
  } else if (typeof syncFxUniforms === 'function') {
    syncFxUniforms();
  }
}
function syncEmptyHomeScrollHint() {
  var el = document.getElementById('empty-home');
  if (!el || !emptyHomeActive) return;
  var canScroll = el.scrollHeight > el.clientHeight + 4;
  var atEnd = !canScroll || el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.classList.toggle('can-scroll', canScroll);
  el.classList.toggle('scroll-end', atEnd);
}
function updateEmptyHomeVisibility(opts) {
  opts = opts || {};
  var show = shouldShowEmptyHome();
  emptyHomeActive = show;
  document.body.classList.toggle('empty-home-active', show);
  if (stageLyrics && stageLyrics.group) stageLyrics.group.visible = !show;
  if (!show) {
    setHomeControlsLocked(false);
    stopHomeFeaturedReviewsAuto();
  }
  if (show) activateHomeWallpaperPreview();
  else deactivateHomeWallpaperPreview(false);
  if (show) {
    setPeek(document.getElementById('search-area'), true, 'search');
    bindHomePlaybackPrefetch();
    renderHomeDiscover();
    loadHomeFeaturedReviews(false);
    scheduleHomeWeatherLoad(opts.forceLoad ? 1400 : 2400);
    if (!hasAnyPlatformLogin()) {
      homeDiscoverState.loading = false;
      homeDiscoverState.loaded = true;
      homeDiscoverState.loggedIn = false;
      homeDiscoverState.mode = 'starter';
      homeDiscoverState.songs = [];
      homeDiscoverState.playlists = [];
      homeDiscoverState.podcasts = [];
      renderHomeDiscover();
    } else {
      renderHomeDiscover();
      scheduleVisualApply(function(){ loadHomeDiscover(!!opts.forceLoad); }, 220, 1200);
    }
    scheduleUiWarmTask(syncEmptyHomeScrollHint, 120);
  }
  if (!show) {
    var homeEl = document.getElementById('empty-home');
    if (homeEl) homeEl.classList.remove('can-scroll', 'scroll-end');
  }
  updateRenderPowerClasses();
  applyRendererPowerMode();
  return show;
}
function runHomeSearch(query, mode) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility();
  if (mode) setSearchMode(mode);
  else if (searchMode === 'podcast') setSearchMode('song');
  var q = String(query || '').trim();
  var area = document.getElementById('search-area');
  if (area) setPeek(area, true, 'search');
  if ($input) {
    $input.value = q;
    $input.focus();
  }
  if (q) doSearch(q);
  else if (searchMode === 'podcast') loadPodcastHot();
  else renderSearchHistory();
}
function skipLoginAndFocusSearch() {
  closeLoginModal({ skipAccountReturn: true });
  setTimeout(function(){ runHomeSearch(''); }, 180);
}
function openHomeLocalImport() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility();
  var input = document.getElementById('file-input');
  if (input) input.click();
}
function openHomeProductGuide() {
  // Visual onboarding tour removed.
}
async function waitForHomeDiscoverIdle(timeout) {
  var started = Date.now();
  while (homeDiscoverState.loading && Date.now() - started < (timeout || 2200)) {
    await new Promise(function(resolve){ setTimeout(resolve, 80); });
  }
}
async function playHomeDaily() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasPlatformLogin('netease')) {
    showLoginModal({ source: 'home-daily' });
    return;
  }
  await waitForHomeDiscoverIdle();
  if (!homeDiscoverState.loaded || (!homeDiscoverState.songs.length && !homeDiscoverState.loading)) {
    await loadHomeDiscover(true);
  }
  if (!homeDiscoverState.songs.length) {
    showToast('每日推荐暂不可用，请确认网易云已登录后重试');
    return;
  }
  playQueue = homeDiscoverState.songs.map(cloneSong);
  currentIdx = 0;
  safeRenderQueuePanel('home-daily');
  safeShelfRebuild('home-daily', true);
  forcePlaybackControlsInteractive();
  var urlFetchPromise = beginHomePlayback(playQueue[0]);
  prefetchAdjacentPlaybackSources(0);
  playQueueAt(0, { fromSearch: true, urlFetchPromise: urlFetchPromise }).catch(function(e){ console.warn('[HomeDailyPlay]', e); });
}
async function playHomePrivateRadio() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    showLoginModal({ source: 'home-private' });
    return;
  }
  await waitForHomeDiscoverIdle();
  if (!homeDiscoverState.loaded || ((!homeDiscoverState.playlists.length && !homeDiscoverState.songs.length) && !homeDiscoverState.loading)) {
    await loadHomeDiscover(true);
  }
  if (homeDiscoverState.songs.length) {
    playQueue = homeDiscoverState.songs.map(cloneSong);
    currentIdx = 0;
    safeRenderQueuePanel('home-private-radio');
    safeShelfRebuild('home-private-radio', true);
    forcePlaybackControlsInteractive();
    var privateFetch = beginHomePlayback(playQueue[0]);
    prefetchAdjacentPlaybackSources(0);
    playQueueAt(0, { fromSearch: true, urlFetchPromise: privateFetch }).catch(function(e){ console.warn('[HomePrivatePlay]', e); });
    return;
  }
  var item = homeDiscoverState.playlists[0];
  if (item && item.id) {
    await loadPlaylistIntoQueueById(item.id, true, item.name || '私人雷达');
    return;
  }
  openHomeLibrary();
}
function playHomeSong(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  var song = homeDiscoverState.songs[index];
  if (!song) {
    if (index > 0) playHomePrivateRadio();
    else playHomeDaily();
    return;
  }
  playQueue = homeDiscoverState.songs.map(cloneSong);
  currentIdx = Math.max(0, Math.min(playQueue.length - 1, index));
  safeRenderQueuePanel('home-song-card');
  safeShelfRebuild('home-song-card', true);
  forcePlaybackControlsInteractive();
  var cardFetch = beginHomePlayback(playQueue[currentIdx]);
  prefetchAdjacentPlaybackSources(currentIdx);
  playQueueAt(currentIdx, { fromSearch: true, urlFetchPromise: cardFetch }).catch(function(e){ console.warn('[HomeSongPlay]', e); });
}
function openHomePlaylist(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    runHomeSearch('');
    return;
  }
  openPlaylistPanelTab('playlists', true);
  var item = homeDiscoverState.playlists[index];
  if (!item || !item.id) {
    openHomeLibrary();
    return;
  }
  loadPlaylistIntoQueueById(item.id, true, item.name || '');
}
function openHomePodcast(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  openPlaylistPanelTab('podcasts', true);
  var item = homeDiscoverState.podcasts[index];
  if (!item || !item.id) {
    setSearchMode('podcast');
    loadPodcastHot();
    return;
  }
  loadPodcastRadioIntoQueue(item.id, true, item.name || '');
}
function openHomeThirdCard() {
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    openHomeLocalImport();
    return;
  }
  openHomePodcast(0);
}
function openHomeLibrary() {
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    showLoginModal({ source: 'home-library' });
    return;
  }
  homeSuppressed = false;
  setHomeControlsLocked(false);
  openPlaylistPanelTab('playlists', true);
  refreshUserPlaylists(true);
}
function prepareHomeSurface() {
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) safeShelfCloseContent('open-empty-home');
  if (typeof setShelfPinnedOpen === 'function') setShelfPinnedOpen(false, true);
  togglePlaylistPanel(false);
  setPeek(document.getElementById('playlist-panel'), false, 'pl');
  setPeek(document.getElementById('fx-panel'), false, 'fx');
  setPeek(document.getElementById('search-area'), true, 'search');
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
  if (orbit && orbit.focus) orbit.focus.active = false;
}
function goHome() {
  var folia = window.MineradioFolia;
  if (folia && typeof folia.homeStyle === 'function' && folia.homeStyle() === 'wall') {
    var wallOpen = typeof folia.isWallOpen === 'function'
      ? folia.isWallOpen()
      : document.body.classList.contains('folia-home-wall');
    if (wallOpen) {
      if (typeof folia.setWallOpen === 'function') folia.setWallOpen(false, { silent: true });
      else if (typeof folia.toggleWall === 'function') folia.toggleWall({ silent: true });
      dismissHomePage({ toast: false });
      showToast('已关闭 Home');
      return;
    }
    // Folia 海报墙作为 Home：打开墙，并压住 Mineradio 空场 Home，避免关墙后露出来
    homeForcedOpen = false;
    homeSuppressed = true;
    setHomeControlsLocked(false);
    prepareHomeSurface();
    updateEmptyHomeVisibility({ forceLoad: false });
    if (typeof folia.setWallOpen === 'function') folia.setWallOpen(true, { silent: true });
    else if (typeof folia.toggleWall === 'function') folia.toggleWall({ silent: true });
    showToast('已回到 Home');
    return;
  }
  if (homeForcedOpen || emptyHomeActive) {
    dismissHomePage({ toast: true });
    showToast('已关闭 Home');
    return;
  }
  homeSuppressed = false;
  homeForcedOpen = true;
  setHomeControlsLocked(true);
  prepareHomeSurface();
  updateEmptyHomeVisibility({ forceLoad: true });
  showToast('已回到 Home');
}
function dismissHomePage(opts) {
  opts = opts || {};
  homeForcedOpen = false;
  homeSuppressed = true;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility({ forceLoad: false });
  setPeek(document.getElementById('search-area'), false, 'search');
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
function isPointInsideRectWithPad(x, y, rect, pad) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  pad = Number(pad) || 0;
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}
function isPointNearHomeContent(x, y) {
  var selectors = [
    '.home-card',
    '.home-tile',
    '.home-chip'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var nodes = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < nodes.length; j++) {
      if (isPointInsideRectWithPad(x, y, nodes[j].getBoundingClientRect(), 12)) return true;
    }
  }
  return false;
}
function isHomeBlankDismissClick(e) {
  if (!emptyHomeActive || !e || e.defaultPrevented) return false;
  if (e.button != null && e.button !== 0) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  var target = e.target;
  if (!target || !target.closest) return false;
  var blockedSelector = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '#desktop-titlebar',
    '#search-area',
    '#top-right',
    '#bottom-bar',
    '#bottom-handle',
    '#fx-fab',
    '#fx-fab-hide-btn',
    '#fx-panel',
    '#playlist-panel',
    '#mini-queue-popover',
    '#visual-guide',
    '#upload-tip',
    '#toast',
    '#trial-banner',
    '#source-fallback-notice',
    '.modal-mask',
    '.modal',
    '.track-detail-modal',
    '.cover-color-pop',
    '.color-lab-pop'
  ].join(',');
  if (target.closest(blockedSelector)) return false;
  var x = e.clientX;
  var y = e.clientY;
  var home = document.getElementById('empty-home');
  if (!home) return false;
  var homeRect = home.getBoundingClientRect();
  if (!isPointInsideRectWithPad(x, y, homeRect, 0)) return false;
  if (isPointNearHomeContent(x, y)) return false;
  return true;
}
document.addEventListener('click', function(e) {
  if (!isHomeBlankDismissClick(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dismissHomePage({ reason: 'blank-click' });
}, true);
function songFromListenRecord(record) {
  record = enrichListenRecord(record);
  if (!record) return null;
  var provider = record.sourceKey || '';
  if (!provider && record.type === 'qq') provider = 'qq';
  if (!provider) provider = record.mid ? 'qq' : 'netease';
  return {
    provider: provider,
    source: provider,
    type: record.type || (provider === 'qq' ? 'qq' : 'song'),
    id: record.id || record.mid || record.key || '',
    mid: record.mid || '',
    songmid: record.mid || '',
    mediaMid: record.mediaMid || '',
    name: record.name || '继续听',
    artist: record.artist || '',
    cover: record.cover || '',
  };
}
async function playHomeRecent(record) {
  record = record || homeListenSummary().recent;
  if (!record) {
    showToast('还没有听歌记录');
    return;
  }
  var song = songFromListenRecord(record);
  if (!song || (!song.id && !song.mid)) {
    runHomeSearch(record.name || '');
    return;
  }
  activeRadioContext = null;
  playQueue = [cloneSong(song)];
  currentIdx = 0;
  safeRenderQueuePanel('home-recent-song');
  safeShelfRebuild('home-recent-song', true);
  forcePlaybackControlsInteractive();
  var recentFetch = beginHomePlayback(song);
  playQueueAt(0, { fromSearch: true, urlFetchPromise: recentFetch }).catch(function(e){ console.warn('[HomeRecentPlay]', e); });
}
function openHomeInsight() {
  var summary = homeListenSummary();
  if (summary.topArtist && summary.topArtist.name) {
    runHomeSearch(summary.topArtist.name);
    return;
  }
  if (summary.topSong && summary.topSong.name) {
    runHomeSearch(summary.topSong.name);
    return;
  }
  showToast('播放几首歌后会生成听歌画像');
}
async function playWeatherSong(index) {
  var radio = homeWeatherRadioState.radio;
  var songs = radio && radio.songs || [];
  if (!songs[index]) {
    startWeatherRadio();
    return;
  }
  activeRadioContext = weatherRadioContext();
  playQueue = songs.map(function(song){
    var cloned = cloneSong(song);
    cloned.radioContext = activeRadioContext;
    return cloned;
  });
  currentIdx = index;
  safeRenderQueuePanel('weather-radio-song');
  safeShelfRebuild('weather-radio-song', true);
  forcePlaybackControlsInteractive();
  var weatherFetch = beginHomePlayback(playQueue[index]);
  prefetchAdjacentPlaybackSources(index);
  playQueueAt(index, { context: activeRadioContext, fromSearch: true, urlFetchPromise: weatherFetch }).catch(function(e){ console.warn('[WeatherSongPlay]', e); });
}
function handleHomeTileClick(index) {
  var row = document.getElementById('home-tile-row');
  var item = row && row._homeTiles && row._homeTiles[index];
  if (!item) return;
  if (item.kind === 'weatherSong') playWeatherSong(item.index);
  else if (item.kind === 'recent') playHomeRecent(item.record);
  else if (item.kind === 'profile') openHomeInsight();
  else if (item.kind === 'song') playHomeSong(item.index);
  else if (item.kind === 'login') showLoginModal({ source: 'home-tile' });
  else if (item.kind === 'local') openHomeLocalImport();
  else if (item.kind === 'playlist') openHomePlaylist(item.index);
  else if (item.kind === 'podcast') openHomePodcast(item.index);
  else if (item.kind === 'podcastSearch') { setSearchMode('podcast'); loadPodcastHot(); }
  else if (item.kind === 'library') openHomeLibrary();
  else runHomeSearch(item.query || item.title || '');
}
function currentCoverSong() {
  if (currentIdx >= 0 && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}
function songDurationLabel(song) {
  var sec = playbackDurationFromSong(song);
  if (!sec && audio && isFinite(audio.duration) && audio.duration > 0) sec = audio.duration;
  if (!sec) return '未知';
  return formatProgramTime(sec);
}
function songSourceLabel(song) {
  if (!song) return '未知';
  if (song.provider === 'kg' || song.source === 'kg' || song.type === 'kg') return '酷狗音乐';
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'QQ 音乐';
  if (song.type === 'local') return '本地上传';
  if (song.type === 'podcast' || song.source === 'podcast') return '网易云播客';
  return '网易云音乐';
}
function detailRow(label, value) {
  value = value == null || value === '' ? '未知' : value;
  return '<div class="detail-k">' + escHtml(label) + '</div><div class="detail-v">' + escHtml(String(value)) + '</div>';
}
function currentArtistNames(song) {
  var text = String((song && song.artist) || '').trim();
  if (!text) return [];
  return text.split(/\s*\/\s*|\s*,\s*|、/).map(function(s){ return s.trim(); }).filter(Boolean);
}
var trackDetailSeq = 0;
var detailCurrentSong = null;
var detailComments = [];
var SONG_DETAIL_COMMENT_BATCH = 10;
var songDetailCommentRenderLimit = SONG_DETAIL_COMMENT_BATCH;
var detailArtistSongs = [];
var ARTIST_DETAIL_BATCH_SIZE = 12;
var artistDetailRenderLimit = ARTIST_DETAIL_BATCH_SIZE;
var artistDetailScrollBound = false;
var artistDetailPrefetchBound = false;
var artistDetailHoverPrefetchTimer = 0;
function normalizeArtistNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s·・,，、/\\|&＋+_-]+/g, '')
    .replace(/[()（）\[\]【】"'“”‘’]/g, '');
}
function artistNameMatches(expectedNames, actualName) {
  var actual = normalizeArtistNameForMatch(actualName);
  if (!actual) return false;
  return (expectedNames || []).some(function(name){
    var expected = normalizeArtistNameForMatch(name);
    return expected && (expected === actual || expected.indexOf(actual) >= 0 || actual.indexOf(expected) >= 0);
  });
}
function currentKGArtistId(song) {
  if (!song || songProviderKey(song) !== 'kg') return '';
  if (song.singerId) return String(song.singerId);
  if (song.artistId) return String(song.artistId);
  return '';
}
function currentArtistId(song) {
  if (!song) return '';
  if (!isCloudSong(song)) return '';
  if (song.artistId) return String(song.artistId);
  var artists = song.artists || [];
  for (var i = 0; i < artists.length; i++) {
    if (artists[i] && artists[i].id) return String(artists[i].id);
  }
  return '';
}
function currentQQArtistMid(song) {
  if (!song || songProviderKey(song) !== 'qq') return '';
  if (song.artistMid) return String(song.artistMid);
  if (song.singerMid) return String(song.singerMid);
  if (song.artistId && !/^\d+$/.test(String(song.artistId))) return String(song.artistId);
  var artists = song.artists || [];
  for (var i = 0; i < artists.length; i++) {
    if (artists[i] && artists[i].mid) return String(artists[i].mid);
    if (artists[i] && artists[i].id && !/^\d+$/.test(String(artists[i].id))) return String(artists[i].id);
  }
  return '';
}
function commentTimeLabel(ms) {
  var t = Number(ms) || 0;
  if (!t) return '';
  try {
    return new Date(t).toLocaleDateString('zh-CN', { month:'short', day:'numeric' });
  } catch (e) {
    return '';
  }
}
function renderDetailComments(comments) {
  detailComments = (comments || []).slice();
  resetSongDetailCommentRenderLimit();
  if (!detailComments.length) return '<div class="detail-empty">暂无评论</div>';
  return buildDetailCommentsContainerHtml();
}
function resetSongDetailCommentRenderLimit() {
  songDetailCommentRenderLimit = SONG_DETAIL_COMMENT_BATCH;
}
function isSongDetailPlaying(song) {
  return isSearchResultPlaying(song);
}
function canOpenArtistFromSong(song) {
  if (!song) return false;
  return !!(String(song.artist || '').trim() || currentArtistId(song) || currentQQArtistMid(song) || currentKGArtistId(song));
}
function buildDetailArtistSubHtml(song) {
  song = song || {};
  var artist = String(song.artist || '').trim();
  if (!artist) return escHtml(song.type === 'local' ? '本地文件' : '未知歌手');
  if (canOpenArtistFromSong(song)) {
    return '<button class="detail-artist-link" type="button" onclick="openDetailCurrentArtist()">' + escHtml(artist) + '</button>';
  }
  return escHtml(artist);
}
function buildSongDetailHeroHtml(song) {
  song = song || {};
  var playing = isSongDetailPlaying(song);
  var cover = songCoverSrc(song, 180);
  var coverHtml = cover ? '<img class="detail-cover" src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.18">' : '<div class="detail-cover"></div>';
  var vipTag = songVipTagHtml(song);
  var playBadge = playing ? '<span class="search-play-badge">播放中</span>' : '';
  var liked = isSongLiked(song);
  return '<div class="detail-hero' + (playing ? ' playing' : '') + '" id="song-detail-hero">' + coverHtml +
    '<div class="detail-hero-main">' +
      '<div class="detail-title">' + playBadge + escHtml(song.name || '当前歌曲') + vipTag + '</div>' +
      '<div class="detail-sub">' + buildDetailArtistSubHtml(song) + '</div>' +
      '<div class="detail-action-row">' +
        '<button class="detail-action-btn primary" type="button" onclick="playDetailCurrentSong()">播放</button>' +
        '<button class="detail-action-btn detail-like-btn' + (liked ? ' liked' : '') + '" type="button" onclick="toggleLikeDetailSong(detailCurrentSong)">' + heartIconSvg() + (liked ? ' 已喜欢' : ' 喜欢') + '</button>' +
        '<button class="detail-action-btn" type="button" onclick="collectDetailSong(detailCurrentSong)">' + artistCollectTrayIconSvg() + ' 收藏</button>' +
        '<button class="detail-action-btn" type="button" onclick="queueDetailSongNext(detailCurrentSong)">' + artistNextPlusIconSvg() + ' 下一首</button>' +
        (canOpenArtistFromSong(song) ? '<button class="detail-action-btn" type="button" onclick="openDetailCurrentArtist()">歌手</button>' : '') +
      '</div>' +
    '</div></div>';
}
function buildDetailCommentItemHtml(c, i) {
  var user = c.user || {};
  var avatar = user.avatar ? coverUrlWithSize(user.avatar, 64) : '';
  var top = (Number(c.likedCount) || 0) >= 100;
  return '<div class="comment-item' + (top ? ' top-comment' : '') + '" data-comment-index="' + i + '">' +
    (avatar ? '<img class="comment-avatar" src="' + escHtml(coverProxySrc(avatar)) + '" alt="" loading="lazy" decoding="async">' : '<div class="comment-avatar"></div>') +
    '<div class="comment-main"><div class="comment-meta">' + escHtml(user.nickname || '音乐用户') + (c.time ? (' · ' + escHtml(commentTimeLabel(c.time))) : '') + '</div>' +
    '<div class="comment-text">' + escHtml(c.content || '') + '</div></div>' +
    (c.likedCount ? ('<div class="detail-comment-like">' + escHtml(String(c.likedCount)) + ' 赞</div>') : '') +
  '</div>';
}
function buildDetailCommentsContainerHtml() {
  var visible = detailComments.slice(0, songDetailCommentRenderLimit);
  var html = '<div class="detail-comment-list-head"><span>评论 · <strong>' + detailComments.length + '</strong> 条</span><span class="detail-comment-list-hint">按热度排序</span></div>';
  html += '<div class="detail-scroll song-comment-list" id="song-comment-list">';
  html += visible.map(function(c, i){ return buildDetailCommentItemHtml(c, i); }).join('');
  if (detailComments.length > visible.length) {
    html += '<button type="button" class="fx-mini-btn ghost detail-comment-load-more" onclick="growSongDetailCommentRenderLimit()">加载更多 ' + visible.length + '/' + detailComments.length + '</button>';
  }
  html += '</div>';
  return html;
}
function growSongDetailCommentRenderLimit() {
  if (!detailComments.length) return;
  var prev = songDetailCommentRenderLimit;
  var next = Math.min(detailComments.length, songDetailCommentRenderLimit + SONG_DETAIL_COMMENT_BATCH);
  if (next <= prev) return;
  songDetailCommentRenderLimit = next;
  var list = document.getElementById('song-comment-list');
  var loadBtn = list && list.querySelector('.detail-comment-load-more');
  if (!list) {
    var target = document.getElementById('song-comments');
    if (target) target.innerHTML = buildDetailCommentsContainerHtml();
    bindSongDetailListAfterRender();
    return;
  }
  var wrap = document.createElement('div');
  var chunk = '';
  for (var i = prev; i < next; i++) chunk += buildDetailCommentItemHtml(detailComments[i], i);
  wrap.innerHTML = chunk;
  var frag = document.createDocumentFragment();
  while (wrap.firstChild) frag.appendChild(wrap.firstChild);
  if (loadBtn) list.insertBefore(frag, loadBtn);
  else list.appendChild(frag);
  if (loadBtn) {
    if (next >= detailComments.length) loadBtn.remove();
    else loadBtn.textContent = '加载更多 ' + next + '/' + detailComments.length;
  }
  if (window.gsap && next > prev) {
    animateListItems(list, '.comment-item:nth-last-child(n+' + (next - prev + (loadBtn ? 1 : 0)) + ')', { x: 0, y: 8, stagger: 0.01, duration: 0.16, limit: next - prev });
  }
}
function refreshSongDetailPlayingState() {
  if (!detailCurrentSong) return;
  var hero = document.getElementById('song-detail-hero');
  if (!hero) return;
  var playing = isSongDetailPlaying(detailCurrentSong);
  hero.classList.toggle('playing', playing);
  var title = hero.querySelector('.detail-title');
  if (!title) return;
  var badge = title.querySelector('.search-play-badge');
  if (playing && !badge) title.insertAdjacentHTML('afterbegin', '<span class="search-play-badge">播放中</span>');
  else if (!playing && badge) badge.remove();
}
function refreshSongDetailLikeState() {
  if (!detailCurrentSong) return;
  var btn = document.querySelector('#song-detail-hero .detail-like-btn');
  if (!btn) return;
  var liked = isSongLiked(detailCurrentSong);
  btn.classList.toggle('liked', liked);
  btn.innerHTML = heartIconSvg() + (liked ? ' 已喜欢' : ' 喜欢');
}
function refreshSongDetailUiState() {
  refreshSongDetailPlayingState();
  refreshSongDetailLikeState();
}
function bindSongDetailListAfterRender() {
  bindArtistDetailLazyScroll();
  refreshSongDetailUiState();
}
function playDetailCurrentSong() {
  var song = detailCurrentSong;
  if (!song) return;
  primeWebPlaybackUnlockIfNeeded({});
  showLoading({ light: !!firstPlayDone });
  var urlFetchPromise = fetchPlaybackSourceData(song).catch(function(err){
    console.warn('[DetailPlayPrefetch]', err);
    return null;
  });
  prefetchPlaybackAudioForSong(song);
  var key = queueItemKey(song);
  var matchIdx = -1;
  for (var i = 0; i < playQueue.length; i++) if (queueItemKey(playQueue[i]) === key) { matchIdx = i; break; }
  if (matchIdx >= 0) currentIdx = matchIdx;
  else { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  safeRenderQueuePanel('detail-song-play');
  safeShelfRebuild('detail-song-play', true);
  closeTrackDetailModal();
  prefetchAdjacentPlaybackSources(currentIdx);
  playQueueAt(currentIdx, { fromSearch: true, urlFetchPromise: urlFetchPromise }).catch(function(e){ console.warn('[DetailPlay]', e); });
}
function openDetailCurrentArtist() {
  if (!detailCurrentSong) return;
  openArtistDetailForSong(detailCurrentSong);
}
function resetArtistDetailRenderLimit() {
  artistDetailRenderLimit = ARTIST_DETAIL_BATCH_SIZE;
}
function isArtistDetailSongPlaying(song) {
  return isSearchResultPlaying(song);
}
function buildArtistSongItemHtml(s, i) {
  var playing = isArtistDetailSongPlaying(s);
  var cover = songCoverSrc(s, 80);
  var coverHtml = cover ? '<img class="artist-song-cover" src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.18">' : '<div class="artist-song-cover"></div>';
  var durationText = searchResultDurationText(s) || (s.duration ? songDurationLabel(s) : '');
  var vipTag = songVipTagHtml(s);
  var playBadge = playing ? '<span class="search-play-badge">播放中</span>' : '';
  var actionsHtml = '<div class="artist-song-actions">' +
    '<button class="artist-song-action collect" type="button" title="收藏到歌单" aria-label="收藏到歌单" onclick="event.stopPropagation();collectArtistDetailSong(' + i + ')">' + artistCollectTrayIconSvg() + '</button>' +
    '<button class="artist-song-action next" type="button" title="下一首播放" aria-label="下一首播放" onclick="event.stopPropagation();queueArtistDetailSongNext(' + i + ')">' + artistNextPlusIconSvg() + '</button>' +
  '</div>';
  return '<div class="artist-song-item' + (playing ? ' playing' : '') + '" data-artist-song-index="' + i + '" onclick="playArtistDetailSong(' + i + ')">' +
    '<div class="artist-song-rank' + (i < 3 ? ' artist-song-rank-top' : '') + '">' + String(i + 1).padStart(2, '0') + '</div>' +
    coverHtml +
    '<div class="artist-song-main"><div class="artist-song-name">' + playBadge + escHtml(s.name || '') + vipTag + '</div>' +
    '<div class="artist-song-meta">' + escHtml(s.album || '未知专辑') + '</div></div>' +
    '<div class="artist-song-side">' +
      (durationText ? ('<span class="artist-song-duration">' + escHtml(durationText) + '</span>') : '') +
      actionsHtml +
    '</div>' +
  '</div>';
}
function buildArtistSongListContainerHtml() {
  var visible = detailArtistSongs.slice(0, artistDetailRenderLimit);
  var html = '<div class="artist-detail-list-head"><span>热门歌曲 · <strong>' + detailArtistSongs.length + '</strong> 首</span><span class="artist-detail-list-hint">点击播放 · 将载入整页歌单</span></div>';
  html += '<div class="detail-scroll artist-song-list" id="artist-song-list">';
  html += visible.map(function(s, i){ return buildArtistSongItemHtml(s, i); }).join('');
  if (detailArtistSongs.length > visible.length) {
    html += '<button type="button" class="fx-mini-btn ghost artist-song-load-more" onclick="growArtistDetailRenderLimit()">加载更多 ' + visible.length + '/' + detailArtistSongs.length + '</button>';
  }
  html += '</div>';
  return html;
}
function growArtistDetailRenderLimit() {
  if (!detailArtistSongs.length) return;
  var prev = artistDetailRenderLimit;
  var next = Math.min(detailArtistSongs.length, artistDetailRenderLimit + ARTIST_DETAIL_BATCH_SIZE);
  if (next <= prev) return;
  artistDetailRenderLimit = next;
  var list = document.getElementById('artist-song-list');
  var loadBtn = list && list.querySelector('.artist-song-load-more');
  if (!list) {
    var target = document.getElementById('artist-hot-songs');
    if (target) target.innerHTML = buildArtistSongListContainerHtml();
    bindArtistDetailListAfterRender();
    return;
  }
  var wrap = document.createElement('div');
  var chunk = '';
  for (var i = prev; i < next; i++) chunk += buildArtistSongItemHtml(detailArtistSongs[i], i);
  wrap.innerHTML = chunk;
  var frag = document.createDocumentFragment();
  while (wrap.firstChild) frag.appendChild(wrap.firstChild);
  if (loadBtn) list.insertBefore(frag, loadBtn);
  else list.appendChild(frag);
  if (loadBtn) {
    if (next >= detailArtistSongs.length) loadBtn.remove();
    else loadBtn.textContent = '加载更多 ' + next + '/' + detailArtistSongs.length;
  }
  if (window.gsap && next > prev) {
    animateListItems(list, '.artist-song-item:nth-last-child(n+' + (next - prev + (loadBtn ? 1 : 0)) + ')', { x: 0, y: 8, stagger: 0.01, duration: 0.16, limit: next - prev });
  }
  bindArtistDetailListAfterRender();
}
function refreshArtistDetailPlayingState() {
  var list = document.getElementById('artist-song-list');
  if (!list) return;
  list.querySelectorAll('.artist-song-item[data-artist-song-index]').forEach(function(row){
    var i = Number(row.getAttribute('data-artist-song-index'));
    var song = detailArtistSongs[i];
    var playing = isArtistDetailSongPlaying(song);
    row.classList.toggle('playing', playing);
    var title = row.querySelector('.artist-song-name');
    if (!title) return;
    var badge = title.querySelector('.search-play-badge');
    if (playing && !badge) title.insertAdjacentHTML('afterbegin', '<span class="search-play-badge">播放中</span>');
    else if (!playing && badge) badge.remove();
  });
}
function bindArtistDetailLazyScroll() {
  var body = document.getElementById('track-detail-body');
  if (!body || artistDetailScrollBound) return;
  artistDetailScrollBound = true;
  body.addEventListener('scroll', function(){
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 140) return;
    if (detailArtistSongs.length && artistDetailRenderLimit < detailArtistSongs.length) growArtistDetailRenderLimit();
    if (detailComments.length && songDetailCommentRenderLimit < detailComments.length) growSongDetailCommentRenderLimit();
  }, { passive: true });
}
function bindArtistDetailPrefetch() {
  if (artistDetailPrefetchBound) return;
  artistDetailPrefetchBound = true;
  document.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    var row = e.target && e.target.closest ? e.target.closest('.artist-song-item[data-artist-song-index]') : null;
    if (!row) return;
    var song = detailArtistSongs[Number(row.getAttribute('data-artist-song-index'))];
    if (!song) return;
    fetchPlaybackSourceData(song).catch(function(){});
    prefetchPlaybackAudioForSong(song);
  }, { passive: true });
  document.addEventListener('mouseover', function(e){
    var row = e.target && e.target.closest ? e.target.closest('.artist-song-item[data-artist-song-index]') : null;
    if (!row) return;
    var index = Number(row.getAttribute('data-artist-song-index'));
    if (!isFinite(index) || index < 0) return;
    clearTimeout(artistDetailHoverPrefetchTimer);
    artistDetailHoverPrefetchTimer = setTimeout(function(){
      var song = detailArtistSongs[index];
      if (song) {
        prefetchPlaybackSourceForSong(song);
        prefetchPlaybackAudioForSong(song);
      }
    }, 260);
  }, { passive: true });
  document.addEventListener('mouseout', function(e){
    var row = e.target && e.target.closest ? e.target.closest('.artist-song-item[data-artist-song-index]') : null;
    if (!row) return;
    var related = e.relatedTarget;
    if (related && row.contains(related)) return;
    clearTimeout(artistDetailHoverPrefetchTimer);
  }, { passive: true });
}
function bindArtistDetailListAfterRender() {
  bindArtistDetailLazyScroll();
  bindArtistDetailPrefetch();
  refreshArtistDetailPlayingState();
}
function renderArtistSongList(songs) {
  detailArtistSongs = (songs || []).map(cloneSong);
  resetArtistDetailRenderLimit();
  if (!detailArtistSongs.length) return '<div class="detail-empty">暂无热门歌曲</div>';
  return buildArtistSongListContainerHtml();
}
function playArtistDetailSong(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  primeWebPlaybackUnlockIfNeeded({});
  showLoading({ light: !!firstPlayDone });
  var urlFetchPromise = fetchPlaybackSourceData(song).catch(function(err){
    console.warn('[ArtistDetailPlayPrefetch]', err);
    return null;
  });
  prefetchPlaybackAudioForSong(song);
  playQueue = detailArtistSongs.map(cloneSong);
  currentIdx = i;
  safeRenderQueuePanel('artist-detail-play');
  safeShelfRebuild('artist-detail-play', true);
  closeTrackDetailModal();
  prefetchAdjacentPlaybackSources(i);
  playQueueAt(i, { fromSearch: true, urlFetchPromise: urlFetchPromise }).catch(function(e){ console.warn('[ArtistDetailPlay]', e); });
}
function collectArtistDetailSong(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  collectDetailSong(song);
}
function queueArtistDetailSongNext(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  queueDetailSongNext(song);
}
function bindTrackDetailScrollers() {
  var body = document.getElementById('track-detail-body');
  bindSmoothWheelScroll(body);
  if (body) body.querySelectorAll('.detail-scroll').forEach(bindSmoothWheelScroll);
  bindArtistDetailListAfterRender();
  bindSongDetailListAfterRender();
}
function closeTrackDetailModal() {
  closeGsapModal(document.getElementById('track-detail-modal'));
}
function openTrackDetailModal(type, songOverride) {
  var song = songOverride || currentCoverSong();
  if (!song) { showToast('先播放或选择一首歌'); return; }
  if (immersiveMode) setImmersiveMode(false);
  var heading = document.getElementById('track-detail-heading');
  var body = document.getElementById('track-detail-body');
  if (!heading || !body) return;
  var cover = songCoverSrc(song, 180);
  var coverHtml = cover ? '<img class="detail-cover" src="' + cover + '" alt="">' : '<div class="detail-cover"></div>';
  var title = song.name || '当前歌曲';
  var artists = currentArtistNames(song);
  var seq = ++trackDetailSeq;
  if (type === 'artist') {
    detailCurrentSong = null;
    detailComments = [];
    var providerKey = songProviderKey(song);
    var artistId = currentArtistId(song);
    var qqArtistMid = currentQQArtistMid(song);
    var kgArtistId = currentKGArtistId(song);
    var artistDetailUrl = '';
    if (providerKey === 'kg') {
      if (kgArtistId) artistDetailUrl = '/api/kg/artist/detail?id=' + encodeURIComponent(kgArtistId) + '&limit=36';
      else if (artists.length || song.artist) artistDetailUrl = '/api/kg/artist/detail?name=' + encodeURIComponent(artists[0] || song.artist || '') + '&limit=36';
    } else if (artistId) {
      artistDetailUrl = '/api/artist/detail?id=' + encodeURIComponent(artistId) + '&limit=36';
    } else if (qqArtistMid) {
      artistDetailUrl = '/api/qq/artist/detail?mid=' + encodeURIComponent(qqArtistMid) + '&limit=36';
    }
    var artistName = artists.join(' / ') || song.artist || '未知歌手';
    var artistNamesForMatch = artists.length ? artists : (song.artist ? [song.artist] : []);
    var artistInitial = artistName && artistName !== '未知歌手' ? artistName.slice(0, 1) : '歌';
    var artistCoverHtml = '<div id="artist-detail-cover" class="detail-cover detail-artist-avatar">' + escHtml(artistInitial) + '</div>';
    var artistEmptyText = providerKey === 'qq'
      ? '当前 QQ 歌曲缺少 singerMid，无法打开 QQ 歌手主页。'
      : (providerKey === 'kg' ? '当前酷狗歌曲缺少歌手信息，无法打开歌手主页。' : '当前歌曲缺少可用的歌手主页信息');
    var artistLoadingText = providerKey === 'qq' ? '正在载入 QQ 歌手主页...' : (providerKey === 'kg' ? '正在载入酷狗歌手主页...' : '正在载入歌手主页...');
    heading.textContent = '歌手详情';
    body.innerHTML =
      '<div class="detail-hero">' + artistCoverHtml +
        '<div style="min-width:0;flex:1"><div class="detail-title">' + escHtml(artistName) + '</div>' +
        '<div class="detail-sub">来自当前播放 · ' + escHtml(title) + '</div></div>' +
      '</div>' +
      '<div class="detail-grid">' +
        detailRow('当前歌曲', title) +
        detailRow('关联歌手', artistName) +
        detailRow('所属专辑', song.album || (song.type === 'podcast' ? (song.radioName || 'Podcast') : '未知')) +
        detailRow('来源', songSourceLabel(song)) +
      '</div>' +
      '<div class="detail-chip-row">' + (artists.length ? artists.map(function(name){ return '<span class="detail-chip">' + escHtml(name) + '</span>'; }).join('') : '<span class="detail-chip">未知歌手</span>') + '</div>' +
      '<div class="detail-section"><div id="artist-hot-songs">' + (artistDetailUrl ? '<div class="detail-loading">' + escHtml(artistLoadingText) + '</div>' : '<div class="detail-empty">' + escHtml(artistEmptyText) + '</div>') + '</div></div>';
    if (artistDetailUrl) {
      var cachedArtist = detailCacheGet(artistDetailUrl);
      if (cachedArtist) {
        var returnedNameCached = cachedArtist.artist && cachedArtist.artist.name;
        var targetCached = document.getElementById('artist-hot-songs');
        if (returnedNameCached && artistNamesForMatch.length && providerKey !== 'kg' && !artistNameMatches(artistNamesForMatch, returnedNameCached)) {
          if (targetCached) targetCached.innerHTML = '<div class="detail-empty">歌手资料与当前歌曲不匹配，已停止展示错误主页。</div>';
        } else {
          if (returnedNameCached) {
            var titleElCached = body.querySelector('.detail-title');
            if (titleElCached) titleElCached.textContent = cachedArtist.artist.name;
          }
          if (cachedArtist.artist && cachedArtist.artist.avatar) {
            var avatarElCached = document.getElementById('artist-detail-cover');
            if (avatarElCached) {
              avatarElCached.textContent = '';
              avatarElCached.style.backgroundImage = 'url("' + coverUrlWithSize(cachedArtist.artist.avatar, 180).replace(/"/g, '\\"') + '")';
              avatarElCached.style.backgroundSize = 'cover';
              avatarElCached.style.backgroundPosition = 'center';
            }
          }
          if (targetCached) targetCached.innerHTML = cachedArtist.error ? '<div class="detail-empty">歌手主页加载失败</div>' : renderArtistSongList(cachedArtist.songs || []);
        }
        bindTrackDetailScrollers();
      } else {
      apiJson(artistDetailUrl).then(function(r){
        if (seq !== trackDetailSeq) return;
        detailCacheSet(artistDetailUrl, r || { error: true, songs: [] });
        var returnedName = r && r.artist && r.artist.name;
        var target = document.getElementById('artist-hot-songs');
        if (returnedName && artistNamesForMatch.length && providerKey !== 'kg' && !artistNameMatches(artistNamesForMatch, returnedName)) {
          if (target) target.innerHTML = '<div class="detail-empty">歌手资料与当前歌曲不匹配，已停止展示错误主页。</div>';
          bindTrackDetailScrollers();
          return;
        }
        if (returnedName) {
          var titleEl = body.querySelector('.detail-title');
          if (titleEl) titleEl.textContent = r.artist.name;
        }
        if (r && r.artist && r.artist.avatar) {
          var avatarEl = document.getElementById('artist-detail-cover');
          if (avatarEl) {
            avatarEl.textContent = '';
            avatarEl.style.backgroundImage = 'url("' + coverUrlWithSize(r.artist.avatar, 180).replace(/"/g, '\\"') + '")';
            avatarEl.style.backgroundSize = 'cover';
            avatarEl.style.backgroundPosition = 'center';
          }
        }
        if (target) target.innerHTML = r && !r.error ? renderArtistSongList(r.songs || []) : '<div class="detail-empty">歌手主页加载失败</div>';
        bindTrackDetailScrollers();
      }).catch(function(){
        var target = document.getElementById('artist-hot-songs');
        if (seq === trackDetailSeq && target) target.innerHTML = '<div class="detail-empty">歌手主页加载失败</div>';
        bindTrackDetailScrollers();
      });
      }
    }
  } else {
    heading.textContent = '歌曲详情';
    detailCurrentSong = cloneSong(song);
    detailComments = [];
    var detailIsQQ = songProviderKey(song) === 'qq';
    var detailIsKG = songProviderKey(song) === 'kg';
    var detailCanLoadComments = isCloudSong(song) || detailIsQQ || detailIsKG;
    var detailCommentTitle = detailIsQQ ? 'QQ 音乐评论' : (detailIsKG ? '酷狗音乐评论' : '网易云评论');
    var detailEmptyText = detailIsQQ ? '当前 QQ 歌曲暂无评论' : (detailIsKG ? '当前酷狗歌曲暂无评论' : '本地文件暂无网易云评论');
    body.innerHTML =
      buildSongDetailHeroHtml(song) +
      '<div class="detail-grid">' +
        detailRow('歌曲名', title) +
        detailRow('歌手', song.artist || '未知歌手') +
        detailRow('专辑', song.album || (song.type === 'podcast' ? (song.radioName || 'Podcast') : '未知')) +
        detailRow('时长', songDurationLabel(song)) +
        detailRow('来源', songSourceLabel(song)) +
        detailRow('歌词源', lyricSourceMode === 'custom' ? '自定义歌词' : (lyricsTimingSource === 'fallback' ? '占位歌词' : '原词')) +
      '</div>' +
      '<div class="detail-chip-row">' +
        '<span class="detail-chip">' + escHtml(songSourceLabel(song)) + '</span>' +
        (isSongLiked(song) ? '<span class="detail-chip">红心喜欢</span>' : '') +
        (getCustomCoverForSong(song) ? '<span class="detail-chip">自定义封面</span>' : '') +
        (hasCustomLyricForSong(song) ? '<span class="detail-chip">自定义歌词</span>' : '') +
        (songVipTagHtml(song) ? ('<span class="detail-chip">' + escHtml(songProviderKey(song) === 'qq' ? 'QQ 会员' : '会员') + '</span>') : '') +
      '</div>' +
      '<div class="detail-section"><div class="detail-section-head"><div class="detail-section-title">' + detailCommentTitle + '</div></div><div id="song-comments">' + (detailCanLoadComments ? '<div class="detail-loading">正在载入评论...</div>' : '<div class="detail-empty">' + detailEmptyText + '</div>') + '</div></div>';
    if (detailCanLoadComments) {
      var commentUrl = detailIsKG
        ? ('/api/kg/song/comments?hash=' + encodeURIComponent(song.hash || song.id || '') + '&albumAudioId=' + encodeURIComponent(song.albumAudioId || song.album_audio_id || song.albumId || '') + '&limit=18')
        : (detailIsQQ
          ? ('/api/qq/song/comments?id=' + encodeURIComponent(song.qqId || '') + '&mid=' + encodeURIComponent(song.mid || song.songmid || song.id || '') + '&limit=18')
          : ('/api/song/comments?id=' + encodeURIComponent(song.id) + '&limit=18'));
      var cachedComments = detailCacheGet(commentUrl);
      if (cachedComments) {
        var targetCachedComments = document.getElementById('song-comments');
        if (targetCachedComments) targetCachedComments.innerHTML = cachedComments.error ? '<div class="detail-empty">评论加载失败</div>' : renderDetailComments(cachedComments.comments || []);
        bindSongDetailListAfterRender();
      } else {
      apiJson(commentUrl).then(function(r){
        if (seq !== trackDetailSeq) return;
        detailCacheSet(commentUrl, r || { error: true, comments: [] });
        var target = document.getElementById('song-comments');
        if (target) target.innerHTML = r && !r.error ? renderDetailComments(r.comments || []) : '<div class="detail-empty">评论加载失败</div>';
        bindTrackDetailScrollers();
        bindSongDetailListAfterRender();
      }).catch(function(){
        var target = document.getElementById('song-comments');
        if (seq === trackDetailSeq && target) target.innerHTML = '<div class="detail-empty">评论加载失败</div>';
        bindTrackDetailScrollers();
      });
      }
    }
  }
  bindTrackDetailScrollers();
  openGsapModal(document.getElementById('track-detail-modal'));
}
function openArtistDetailForSong(song) {
  if (!song) { showToast('未找到歌手信息'); return; }
  if (currentArtistId(song) || currentQQArtistMid(song) || currentKGArtistId(song)) {
    openTrackDetailModal('artist', song);
    return;
  }
  var artist = String(song.artist || '').split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i).filter(Boolean)[0] || '';
  if (artist) {
    resolveArtistSongForDetail(song, artist).then(function(found){
      openTrackDetailModal('artist', found || Object.assign({}, song, { artist: artist }));
    }).catch(function(){
      openTrackDetailModal('artist', Object.assign({}, song, { artist: artist }));
    });
    showToast('正在查找歌手主页: ' + artist);
  } else {
    showToast('当前歌曲缺少歌手主页信息');
  }
}
function resolveArtistSongForDetail(song, artist) {
  var provider = songProviderKey(song);
  var url = provider === 'qq'
    ? '/api/qq/search?keywords=' + encodeURIComponent(artist) + '&limit=8'
    : (provider === 'kg'
      ? '/api/kg/search?keywords=' + encodeURIComponent(artist) + '&limit=10'
      : '/api/search?keywords=' + encodeURIComponent(artist) + '&limit=10');
  return apiJson(url).then(function(r){
    var songs = (r && r.songs) || [];
    for (var i = 0; i < songs.length; i++) {
      var candidate = songs[i];
      if (!candidate) continue;
      if (!artistNameMatches([artist], candidate.artist || '')) continue;
      if (currentArtistId(candidate) || currentQQArtistMid(candidate) || currentKGArtistId(candidate)) return candidate;
    }
    return null;
  });
}
function setCustomCoverForCurrent(dataUrl, opts) {
  if (!dataUrl) return;
  var song = currentCoverSong();
  var saved = false;
  var hasKey = false;
  if (song) {
    var key = songCustomCoverKey(song);
    song.customCover = dataUrl;
    if (key) {
      hasKey = true;
      customCoverMap[key] = dataUrl;
      saved = saveCustomCoverMap();
      for (var i = 0; i < playQueue.length; i++) {
        if (songCustomCoverKey(playQueue[i]) === key) playQueue[i].customCover = dataUrl;
      }
      if (currentLocalSong && songCustomCoverKey(currentLocalSong) === key) currentLocalSong.customCover = dataUrl;
    }
  }
  applyCoverDataUrl(dataUrl, opts);
  safeRenderQueuePanel('custom-cover-apply', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('custom-cover-apply');
  updateCustomCoverButton();
  showToast(song ? (!hasKey ? '封面已应用' : (saved ? '封面已保存' : '封面已应用，存储空间不足')) : '已应用临时封面');
}
function updateCustomCoverButton() {
  var btn = document.getElementById('clear-cover-btn');
  var hasCover = !!getCustomCoverForSong(currentCoverSong());
  var area = document.getElementById('search-area');
  if (area) area.classList.toggle('has-cover-action', hasCover);
  if (!btn) return;
  btn.classList.toggle('has-cover', hasCover);
  btn.title = hasCover ? '取消自定义封面' : '当前没有自定义封面';
  btn.setAttribute('aria-label', btn.title);
}
function clearCustomCoverForCurrent() {
  var song = currentCoverSong();
  if (!song) {
    showToast('先播放或选择一首歌');
    updateCustomCoverButton();
    return;
  }
  var custom = getCustomCoverForSong(song);
  if (!custom) {
    showToast('当前没有自定义封面');
    updateCustomCoverButton();
    return;
  }
  var key = songCustomCoverKey(song);
  if (key && customCoverMap[key]) {
    delete customCoverMap[key];
    saveCustomCoverMap();
  }
  delete playlistCoverCache[custom];
  delete song.customCover;
  if (key) {
    for (var i = 0; i < playQueue.length; i++) {
      if (songCustomCoverKey(playQueue[i]) === key) delete playQueue[i].customCover;
    }
  }
  if (key && currentLocalSong && songCustomCoverKey(currentLocalSong) === key) delete currentLocalSong.customCover;
  if (currentIdx >= 0 && playQueue[currentIdx] && playQueue[currentIdx].cover) loadCoverFromUrl(coverUrlWithSize(playQueue[currentIdx].cover, 400));
  else loadCoverFromUrl('');
  safeRenderQueuePanel('custom-cover-clear', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('custom-cover-clear');
  updateCustomCoverButton();
  showToast('已恢复默认封面');
}
function readCustomLyricMap() {
  try {
    var raw = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_STORE_KEY) || '{}') || {};
    var out = {};
    Object.keys(raw).forEach(function(key){
      var item = raw[key];
      if (typeof item === 'string') out[key] = { text: item, updatedAt: 0 };
      else if (item && typeof item.text === 'string') out[key] = { text: item.text, updatedAt: item.updatedAt || 0 };
    });
    return out;
  } catch (e) {
    return {};
  }
}
function saveCustomLyricMap() {
  try {
    localStorage.setItem(CUSTOM_LYRIC_STORE_KEY, JSON.stringify(customLyricMap || {}));
    return true;
  } catch (e) {
    console.warn('custom lyric save failed:', e);
    return false;
  }
}
function readCustomLyricPrefs() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveCustomLyricPrefs() {
  try { localStorage.setItem(CUSTOM_LYRIC_PREF_STORE_KEY, JSON.stringify(customLyricPrefs || {})); } catch (e) {}
}
function songCustomLyricKey(song) {
  return songCustomCoverKey(song);
}
function currentLyricSong() {
  if (currentIdx >= 0 && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}
function getCustomLyricEntry(song) {
  var key = songCustomLyricKey(song);
  return key && customLyricMap[key] ? customLyricMap[key] : null;
}
function hasCustomLyricForSong(song) {
  var entry = getCustomLyricEntry(song);
  return !!(entry && String(entry.text || '').trim());
}
function cloneLyricLine(line) {
  var copy = Object.assign({}, line || {});
  if (line && Array.isArray(line.words)) copy.words = line.words.map(function(w){ return Object.assign({}, w); });
  return copy;
}
function cloneLyricLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(cloneLyricLine);
}
function setOriginalLyricsState(lines, hasNativeKaraoke, timingSource) {
  originalLyricsState = {
    lines: cloneLyricLines(lines || []),
    hasNativeKaraoke: !!hasNativeKaraoke,
    timingSource: timingSource || 'fallback'
  };
}
function applyLyricsState(lines, hasNativeKaraoke, timingSource) {
  lyricsHasNativeKaraoke = !!hasNativeKaraoke;
  lyricsTimingSource = timingSource || 'fallback';
  lyricsLines = cloneLyricLines(lines || []);
  if (!lyricsLines.length) lyricsLines = withLyricFallback([]);
  if (lyricsLines.length && lyricsLines[0].fallback) lyricsTimingSource = 'fallback';
  renderLyrics();
  updateCustomLyricControls();
  try {
    if (window.MineradioFolia && typeof window.MineradioFolia.refresh === 'function' && window.MineradioFolia.isEnabled()) {
      window.MineradioFolia.refresh();
    }
  } catch (_) {}
}
function applyOriginalLyricsState() {
  lyricSourceMode = 'original';
  applyLyricsState(originalLyricsState.lines, originalLyricsState.hasNativeKaraoke, originalLyricsState.timingSource);
}
function parseCustomLyricText(text) {
  var raw = String(text || '').trim();
  if (!raw) return [];
  var lrcLines = parseLyricText(raw);
  if (lrcLines.length && !lrcLines.every(function(line){ return isNoLyricText(line.text); })) {
    return lrcLines.map(function(line){
      var copy = cloneLyricLine(line);
      copy.source = 'custom-lrc';
      return copy;
    });
  }
  var rows = raw.split(/\r?\n/).map(function(line){ return line.trim(); }).filter(function(line){ return line && !isNoLyricText(line); });
  if (!rows.length) return [];
  var duration = audio && isFinite(audio.duration) && audio.duration > 8 ? audio.duration : 0;
  var gap = duration ? Math.max(2.8, Math.min(7.2, duration / Math.max(1, rows.length))) : 4.8;
  return finalizeLyricLineDurations(rows.map(function(line, i){
    return { t: i * gap, duration: gap, text: line, source: 'custom-text', charCount: Math.max(1, line.length) };
  }));
}
function applyCustomLyricState(song, silent) {
  song = song || currentLyricSong();
  var entry = getCustomLyricEntry(song);
  if (!entry || !String(entry.text || '').trim()) {
    if (!silent) openCustomLyricModal();
    updateCustomLyricControls();
    return false;
  }
  var lines = parseCustomLyricText(entry.text);
  if (!lines.length) {
    if (!silent) showToast('自定义歌词内容为空');
    updateCustomLyricControls();
    return false;
  }
  lyricSourceMode = 'custom';
  lyricsHasNativeKaraoke = false;
  lyricsTimingSource = lines[0] && lines[0].source === 'custom-lrc' ? 'custom-lrc' : 'custom-text';
  lyricsLines = withLyricFallback(lines);
  if (lyricsLines.length && lyricsLines[0].fallback) lyricsTimingSource = 'fallback';
  renderLyrics();
  updateCustomLyricControls();
  return true;
}
function preferredLyricSourceForSong(song) {
  var key = songCustomLyricKey(song);
  var hasCustom = hasCustomLyricForSong(song);
  if (!hasCustom) return 'original';
  var pref = key ? customLyricPrefs[key] : '';
  if (pref === 'custom') return 'custom';
  if (pref === 'original') return 'original';
  return originalLyricsState.timingSource === 'fallback' ? 'custom' : 'original';
}
function applyPreferredLyricsForCurrent(silent) {
  var song = currentLyricSong();
  if (preferredLyricSourceForSong(song) === 'custom' && applyCustomLyricState(song, true)) return;
  applyOriginalLyricsState();
  if (!silent) updateCustomLyricControls();
}
function setLyricSourceMode(mode, silent) {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  mode = mode === 'custom' ? 'custom' : 'original';
  if (mode === 'custom') {
    if (!applyCustomLyricState(song, true)) {
      if (!silent) openCustomLyricModal();
      return false;
    }
    if (!silent) openCustomLyricModal();
  } else {
    applyOriginalLyricsState();
  }
  if (key) {
    customLyricPrefs[key] = mode;
    saveCustomLyricPrefs();
  }
  if (!silent) showToast(mode === 'custom' ? '已切换到自定义歌词' : '已切换到原歌词');
  updateCustomLyricControls();
  return true;
}
function updateCustomLyricControls() {
  var song = currentLyricSong();
  var hasCustom = hasCustomLyricForSong(song);
  var originalBtn = document.getElementById('lyric-source-original');
  var customBtn = document.getElementById('lyric-source-custom');
  if (originalBtn) {
    originalBtn.classList.toggle('active', lyricSourceMode !== 'custom');
    originalBtn.title = '使用网易云或本地解析歌词';
  }
  if (customBtn) {
    customBtn.classList.toggle('active', lyricSourceMode === 'custom');
    customBtn.classList.toggle('has-custom', hasCustom);
    customBtn.title = hasCustom ? '打开并编辑自定义歌词' : '新增自定义歌词';
  }
}
function setCustomLyricStatus(text, tone) {
  var el = document.getElementById('custom-lyric-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('good', tone === 'good');
  el.classList.toggle('fail', tone === 'fail');
}
function openCustomLyricModal() {
  var song = currentLyricSong();
  if (!song) {
    showToast('先播放或选择一首歌');
    return;
  }
  if (immersiveMode) setImmersiveMode(false);
  var entry = getCustomLyricEntry(song);
  var title = document.getElementById('custom-lyric-title');
  var sub = document.getElementById('custom-lyric-sub');
  var input = document.getElementById('custom-lyric-input');
  if (title) title.textContent = song.name || '当前歌曲';
  if (sub) sub.textContent = (song.artist || (song.type === 'podcast' ? 'Podcast' : '')) + (entry ? ' · 已保存自定义歌词' : ' · 可粘贴 LRC 或逐行输入');
  if (input) input.value = entry ? (entry.text || '') : '';
  setCustomLyricStatus(entry ? '已读取本地自定义歌词' : '提示：带 [00:12.00] 时间轴会更精准；纯文本会自动铺开', entry ? 'good' : '');
  openGsapModal(document.getElementById('custom-lyric-modal'));
  setTimeout(function(){ if (input) input.focus(); }, 120);
}
function closeCustomLyricModal() {
  closeGsapModal(document.getElementById('custom-lyric-modal'));
}
function saveCustomLyricForCurrent() {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  var input = document.getElementById('custom-lyric-input');
  var text = input ? String(input.value || '').trim() : '';
  if (!song || !key) {
    setCustomLyricStatus('请先播放或选择一首歌', 'fail');
    showToast('先播放或选择一首歌');
    return;
  }
  if (!text) {
    setCustomLyricStatus('请输入歌词内容', 'fail');
    return;
  }
  var lines = parseCustomLyricText(text);
  if (!lines.length) {
    setCustomLyricStatus('没有识别到可显示的歌词行', 'fail');
    return;
  }
  customLyricMap[key] = { text: text, updatedAt: Date.now() };
  customLyricPrefs[key] = 'custom';
  var saved = saveCustomLyricMap();
  saveCustomLyricPrefs();
  applyCustomLyricState(song, true);
  setCustomLyricStatus(saved ? ('已保存 ' + lines.length + ' 行，并切换为自定义歌词') : '已应用，但本地存储空间不足', saved ? 'good' : 'fail');
  showToast(saved ? '自定义歌词已保存' : '自定义歌词已应用');
  setTimeout(function(){ closeCustomLyricModal(); }, 520);
}
function deleteCustomLyricForCurrent() {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  if (!song || !key) {
    setCustomLyricStatus('请先播放或选择一首歌', 'fail');
    return;
  }
  if (!customLyricMap[key]) {
    setCustomLyricStatus('当前歌曲没有自定义歌词', 'fail');
    return;
  }
  delete customLyricMap[key];
  delete customLyricPrefs[key];
  saveCustomLyricMap();
  saveCustomLyricPrefs();
  applyOriginalLyricsState();
  var input = document.getElementById('custom-lyric-input');
  if (input) input.value = '';
  setCustomLyricStatus('已删除，恢复原歌词', 'good');
  showToast('已恢复原歌词');
}
function isCloudSong(song) {
  if (!song || !song.id) return false;
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return false;
  if (song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return false;
  return !song.provider || song.provider === 'netease' || song.source === 'netease' || song.type === 'song';
}
function isQQNumericSongId(value) {
  var digits = String(value || '').replace(/\D/g, '');
  var raw = String(value || '').trim();
  return digits.length >= 5 && !(/^[0-9A-Za-z]{10,20}$/.test(raw) && !/^\d+$/.test(raw));
}
function qqSongMidForApi(song) {
  if (!song) return '';
  var mid = String(song.mid || song.songmid || '').trim();
  if (mid && /^[0-9A-Za-z]{10,20}$/.test(mid) && !/^\d+$/.test(mid)) return mid;
  var id = String(song.id || '').trim();
  if (id && /^[0-9A-Za-z]{10,20}$/.test(id) && !/^\d+$/.test(id)) return id;
  return mid;
}
function qqNumericIdForApi(song) {
  if (!song) return '';
  var qqId = String(song.qqId || '').replace(/\D/g, '');
  if (isQQNumericSongId(qqId)) return qqId;
  return '';
}
function likeSongKey(song) {
  if (!song) return '';
  if (songProviderKey(song) === 'qq') {
    var qqId = qqNumericIdForApi(song);
    return qqId ? ('qq:' + qqId) : ('qqmid:' + qqSongMidForApi(song));
  }
  if (songProviderKey(song) === 'kg') {
    var kgHash = String(song.hash || song.id || '').trim().toLowerCase();
    return kgHash ? ('kg:' + kgHash) : '';
  }
  return song.id != null ? String(song.id) : '';
}
function isSongLiked(song) {
  var key = likeSongKey(song);
  return !!(key && likedSongMap[key]);
}
function ensureLoggedInForAction(song) {
  if (song && songProviderKey(song) === 'qq') {
    if (qqLoginStatus.loggedIn) return true;
    showToast('登录 QQ 音乐后可同步');
    showLoginModal('qq');
    return false;
  }
  if (song && songProviderKey(song) === 'kg') {
    if (kgLoginStatus.loggedIn) return true;
    showToast('登录酷狗音乐后可同步');
    showLoginModal('kg');
    return false;
  }
  if (loginStatus.loggedIn) return true;
  showToast('登录后可同步到网易云');
  showLoginModal();
  return false;
}
function updateLikeButtons(song) {
  song = song || currentCoverSong();
  var liked = isSongLiked(song);
  var busy = !!(song && likeSongKey(song) && likeBusyMap[likeSongKey(song)]);
  var btn = document.getElementById('heart-btn');
  if (btn) {
    btn.classList.toggle('liked', liked);
    btn.classList.toggle('busy', busy);
    btn.title = liked ? '取消红心' : '红心喜欢';
  }
  var collectBtn = document.getElementById('collect-btn');
  if (collectBtn) collectBtn.classList.toggle('busy', collectBusy);
}
function heartIconSvg() {
  return '<svg class="heart-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z"/></svg>';
}
function playlistPlusIconSvg() {
  return '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10"/><path d="M4 11h10"/><path d="M4 16h7"/><path d="M18 14v6"/><path d="M15 17h6"/></svg>';
}
function artistCollectTrayIconSvg() {
  return '<svg fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9"/><path d="M7.5 9.5h9"/><path d="M4.5 12.5v6h15v-6"/></svg>';
}
function artistNextPlusIconSvg() {
  return '<svg fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13"/><path d="M5.5 12h13"/></svg>';
}
function songActionHtml(kind, source, index, song) {
  var liked = isSongLiked(song);
  if (kind === 'like') {
    return '<button class="song-action-btn' + (liked ? ' liked' : '') + '" title="' + (liked ? '取消红心' : '红心喜欢') + '" onclick="event.stopPropagation();toggleLike' + source + '(' + index + ')">' + heartIconSvg() + '</button>';
  }
  return '<button class="song-action-btn" title="收藏到歌单" onclick="event.stopPropagation();collect' + source + '(' + index + ')">' + playlistPlusIconSvg() + '</button>';
}
function afterLikeStatusSync(opts) {
  opts = opts || {};
  var searchVisible = $results && $results.classList.contains('show');
  if (!opts.searchContext || miniQueueOpen) {
    safeRenderQueuePanel('like-status-sync', { scrollCurrent: miniQueueOpen });
  }
  if (searchVisible) refreshSearchResultActionStates();
  updateLikeButtons();
}
function syncLikeStatusForSongs(songs, opts) {
  opts = opts || {};
  if (!songs || !songs.length) return;
  if (opts.limit && songs.length > opts.limit) songs = songs.slice(0, opts.limit);
  var token = ++likeStatusToken;
  var neteaseSongs = songs.filter(isCloudSong);
  var qqSongs = songs.filter(function(s){ return songProviderKey(s) === 'qq' && (s.qqId || s.mid || s.id); });
  var kgSongs = songs.filter(function(s){ return songProviderKey(s) === 'kg' && (s.hash || s.id); });
  if (loginStatus.loggedIn && neteaseSongs.length) {
    var ids = neteaseSongs.map(function(s){ return String(s.id); });
    apiJson('/api/song/like/check?ids=' + encodeURIComponent(ids.join(','))).then(function(r){
      if (token < likeStatusToken - 3 || !r || !r.liked) return;
      Object.keys(r.liked).forEach(function(id){
        neteaseSongs.forEach(function(song){
          if (String(song.id) === String(id)) likedSongMap[likeSongKey(song)] = !!r.liked[id];
        });
      });
      afterLikeStatusSync(opts);
    }).catch(function(err){ console.warn('like check failed:', err); });
  }
  if (qqLoginStatus.loggedIn && qqSongs.length) {
    var qqIds = qqSongs.map(function(s){
      var qqId = qqNumericIdForApi(s);
      if (qqId) return qqId;
      return qqSongMidForApi(s);
    }).filter(Boolean);
    if (!qqIds.length) { /* skip qq batch */ } else {
    apiJson('/api/qq/song/like/check?ids=' + encodeURIComponent(qqIds.join(','))).then(function(r){
      if (token < likeStatusToken - 3 || !r || !r.liked) return;
      qqSongs.forEach(function(song){
        var qqId = qqNumericIdForApi(song);
        var qqMid = qqSongMidForApi(song);
        if (qqId && Object.prototype.hasOwnProperty.call(r.liked, qqId)) likedSongMap[likeSongKey(song)] = !!r.liked[qqId];
        else if (qqMid && Object.prototype.hasOwnProperty.call(r.liked, qqMid)) likedSongMap[likeSongKey(song)] = !!r.liked[qqMid];
      });
      afterLikeStatusSync(opts);
    }).catch(function(err){ console.warn('qq like check failed:', err); });
    }
  }
  if (kgLoginStatus.loggedIn && kgSongs.length) {
    var kgIds = kgSongs.map(function(s){ return String(s.hash || s.id || '').trim().toLowerCase(); }).filter(Boolean);
    if (kgIds.length) {
      apiJson('/api/kg/song/like/check?ids=' + encodeURIComponent(kgIds.join(','))).then(function(r){
        if (token < likeStatusToken - 3 || !r || !r.liked) return;
        kgSongs.forEach(function(song){
          var kgHash = String(song.hash || song.id || '').trim().toLowerCase();
          if (kgHash && Object.prototype.hasOwnProperty.call(r.liked, kgHash)) likedSongMap[likeSongKey(song)] = !!r.liked[kgHash];
        });
        afterLikeStatusSync(opts);
      }).catch(function(err){ console.warn('kg like check failed:', err); });
    }
  }
}
function syncLikeStatusForSong(song) {
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') { updateLikeButtons(song); return; }
  syncLikeStatusForSongs([song]);
}
function isLikedPlaylistContext(id, title, meta) {
  var sid = String(id || '');
  var text = String(title || (meta && meta.name) || '').trim();
  var hit = userPlaylists.find(function(pl){ return String(pl.id || '') === sid; });
  if (hit) {
    if (Number(hit.specialType || 0) === 5) return true;
    text = text || hit.name || '';
  }
  return /我喜欢|喜欢的音乐|liked/i.test(text);
}
function markSongsLiked(songs, liked) {
  (songs || []).forEach(function(song){
    var key = likeSongKey(song);
    if (key && (isCloudSong(song) || songProviderKey(song) === 'qq' || songProviderKey(song) === 'kg')) likedSongMap[key] = !!liked;
  });
}
function refreshSearchResultActionStates() {
  if (!playlist || !$results || !$results.children.length) return;
  Array.prototype.forEach.call($results.querySelectorAll('[data-like-index]'), function(btn){
    var i = Number(btn.getAttribute('data-like-index'));
    var song = playlist[i];
    var liked = isSongLiked(song);
    btn.classList.toggle('liked', liked);
    btn.title = liked ? '取消红心' : '红心喜欢';
  });
}
async function toggleLikeSong(song) {
  if (!song) return;
  if (song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') {
    showToast('本地/播客暂不支持红心同步');
    return;
  }
  var provider = songProviderKey(song);
  if (!ensureLoggedInForAction(song)) return;
  var key = likeSongKey(song);
  if (!key) {
    showToast(provider === 'qq' ? 'QQ 歌曲缺少可同步 ID' : (provider === 'kg' ? '酷狗歌曲缺少 hash' : '歌曲缺少可同步 ID'));
    return;
  }
  if (likeBusyMap[key]) return;
  var next = !likedSongMap[key];
  likeBusyMap[key] = true;
  likedSongMap[key] = next;
  updateLikeButtons(song);
  safeRenderQueuePanel('like-toggle-optimistic', { scrollCurrent: miniQueueOpen });
  refreshSearchResultActionStates();
  refreshSongDetailLikeState();
  try {
    var r;
    if (provider === 'qq') {
      var qqId = qqNumericIdForApi(song);
      var qqMid = qqSongMidForApi(song);
      r = await apiJson('/api/qq/song/like?id=' + encodeURIComponent(qqId) + '&mid=' + encodeURIComponent(qqMid) + '&like=' + encodeURIComponent(String(next)));
    } else if (provider === 'kg') {
      r = await apiJson('/api/kg/song/like?hash=' + encodeURIComponent(String(song.hash || song.id || '')) +
        '&albumId=' + encodeURIComponent(String(song.albumId || song.album_id || '')) +
        '&albumAudioId=' + encodeURIComponent(String(song.albumAudioId || song.album_audio_id || '')) +
        '&name=' + encodeURIComponent(String(song.name || '')) +
        '&like=' + encodeURIComponent(String(next)));
    } else {
      r = await apiJson('/api/song/like?id=' + encodeURIComponent(String(song.id)) + '&like=' + encodeURIComponent(String(next)));
    }
    if (r && r.error) throw new Error(r.error);
    if (provider === 'qq' && next && r && r.liked === false) throw new Error('QQ_LIKE_FAILED');
    if (provider === 'qq' && !next && r && r.liked === true) throw new Error('QQ_UNLIKE_FAILED');
    likedSongMap[key] = next;
    showToast(next ? '已加入红心喜欢' : '已取消红心');
  } catch (err) {
    likedSongMap[key] = !next;
    var errMsg = String((err && err.message) || err || '');
    if (provider === 'qq' && errMsg === 'LOGIN_REQUIRED') showToast('QQ 音乐登录已失效，请重新登录');
    else if (provider === 'qq' && errMsg === 'MISSING_QQ_SONG_ID') showToast('QQ 歌曲缺少可同步 ID');
    else showToast('红心操作失败' + (errMsg && errMsg !== 'QQ_LIKE_FAILED' && errMsg !== 'QQ_UNLIKE_FAILED' ? ('：' + errMsg) : ''));
  } finally {
    delete likeBusyMap[key];
    updateLikeButtons(song);
    safeRenderQueuePanel('like-toggle-final', { scrollCurrent: miniQueueOpen });
    refreshSearchResultActionStates();
    refreshSongDetailLikeState();
  }
}
function toggleLikeCurrent() { toggleLikeSong(currentCoverSong()); }
function toggleLikeSearchResult(i) { if (playlist[i]) toggleLikeSong(playlist[i]); }
function toggleLikeQueueIndex(i) { if (playQueue[i]) toggleLikeSong(playQueue[i]); }
function toggleLikeDetailSong(song) { toggleLikeSong(song); }
function openCollectModal(song) {
  var provider = songProviderKey(song);
  if (provider === 'local' || (song && (song.type === 'local' || song.type === 'podcast' || song.source === 'podcast'))) {
    showToast('本地文件暂不支持收藏到歌单');
    return;
  }
  if (provider === 'qq') {
    showToast('QQ 音乐收藏到歌单待接口接入，可用红心同步');
    return;
  }
  if (provider !== 'kg' && !isCloudSong(song)) {
    showToast('本地文件暂不支持收藏到网易云歌单');
    return;
  }
  if (!ensureLoggedInForAction(song)) return;
  collectTargetSong = song;
  renderCollectModal();
  openGsapModal(document.getElementById('collect-modal'));
  refreshUserPlaylists(false).then(function(){ renderCollectModal(); }).catch(function(){ renderCollectModal(); });
}
function openCollectModalForCurrent() { openCollectModal(currentCoverSong()); }
function collectSearchResult(i) { if (playlist[i]) openCollectModal(playlist[i]); }
function collectQueueIndex(i) { if (playQueue[i]) openCollectModal(playQueue[i]); }
function collectDetailSong(song) { openCollectModal(song); }
function closeCollectModal() {
  closeGsapModal(document.getElementById('collect-modal'), function(){
    collectTargetSong = null;
    var input = document.getElementById('collect-new-name');
    if (input) input.value = '';
  });
}
function renderCollectModal() {
  var current = document.getElementById('collect-current');
  var list = document.getElementById('collect-list');
  if (!current || !list) return;
  var song = collectTargetSong || {};
  var provider = songProviderKey(song);
  var cover = songCoverSrc(song, 80);
  current.innerHTML = (cover ? '<img src="' + cover + '" alt="">' : '<div class="cover-placeholder"></div>') +
    '<div style="min-width:0"><div class="collect-title">' + escHtml(song.name || '当前歌曲') + '</div><div class="collect-sub">' + escHtml(song.artist || '') + '</div></div>';
  var providerLoggedIn = provider === 'kg' ? kgLoginStatus.loggedIn : loginStatus.loggedIn;
  if (!providerLoggedIn) {
    list.innerHTML = '<div class="collect-empty">登录后显示你的歌单</div>';
    return;
  }
  var playlists = (userPlaylists || []).filter(function(pl){
    if (provider === 'kg') return pl && pl.provider === 'kg' && !pl.subscribed;
    return pl && (!pl.provider || pl.provider === 'netease') && !pl.subscribed;
  });
  if (!playlists.length) {
    list.innerHTML = (userPlaylists && userPlaylists.length)
      ? '<div class="collect-empty">还没有可写入的歌单，可以先新建一个</div>'
      : miniQueueSkeleton();
    return;
  }
  list.innerHTML = playlists.map(function(pl){
    var thumb = pl.cover ? coverUrlWithSize(pl.cover, 80) : '';
    return '<div class="collect-item" data-collect-pid="' + escHtml(String(pl.id || '')) + '" onclick="addCollectTargetToPlaylist(this.getAttribute(\'data-collect-pid\'))">' +
      (thumb ? '<img src="' + thumb + '" alt="">' : '<div class="cover-placeholder"></div>') +
      '<div style="min-width:0"><div class="collect-title">' + escHtml(pl.name || '') + '</div><div class="collect-sub">' + (pl.trackCount || 0) + ' 首</div></div>' +
    '</div>';
  }).join('');
  if (window.gsap) animateListItems(list, '.collect-item', { x: 0, y: 6, stagger: 0.012, duration: 0.18, ease: 18 });
}
function setCollectBusyPid(pid, busy) {
  var list = document.getElementById('collect-list');
  if (!list) return;
  list.querySelectorAll('.collect-item').forEach(function(item){
    item.classList.toggle('busy', !!busy && item.getAttribute('data-collect-pid') === String(pid));
  });
}
async function createPlaylistFromCollect() {
  var song = collectTargetSong;
  var provider = songProviderKey(song);
  if (!ensureLoggedInForAction(song)) return;
  var input = document.getElementById('collect-new-name');
  var name = input ? input.value.trim() : '';
  if (!name) { showToast('先输入歌单名称'); return; }
  try {
    var r = provider === 'kg'
      ? await apiJson('/api/kg/playlist/create?name=' + encodeURIComponent(name))
      : await apiJson('/api/playlist/create?name=' + encodeURIComponent(name));
    if (r && r.error) throw new Error(r.error);
    if (input) input.value = '';
    showToast('歌单已创建');
    await refreshUserPlaylists(true);
    renderCollectModal();
    var created = r && r.playlist;
    var pid = created && created.id;
    if (pid && collectTargetSong) addCollectTargetToPlaylist(pid);
  } catch (err) {
    showToast('创建歌单失败');
  }
}
function collectResultMessage(r) {
  if (!r) return '收藏失败';
  var msg = r.error || r.message || r.msg || '';
  if (msg === 'LOGIN_REQUIRED') return '登录后可同步到网易云';
  if (/exist|重复|已存在|already/i.test(String(msg))) return '歌曲已在歌单中';
  return msg ? ('收藏失败: ' + msg) : '收藏失败';
}
async function verifySongInPlaylist(pid, songId) {
  songId = String(songId || '');
  if (!pid || !songId) return false;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise(function(resolve){ setTimeout(resolve, attempt === 1 ? 360 : 820); });
    }
    try {
      var detail = await apiJson('/api/playlist/tracks?id=' + encodeURIComponent(pid));
      var tracks = (detail && detail.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        if (String(tracks[i].id) === songId) return true;
      }
    } catch (e) {
      console.warn('collect verify failed:', e);
    }
  }
  return false;
}
async function addCollectTargetToPlaylist(pid) {
  if (collectBusy || !collectTargetSong || !pid) return;
  collectBusy = true;
  setCollectBusyPid(pid, true);
  updateLikeButtons();
  showToast('正在收藏到歌单...');
  try {
    var song = collectTargetSong;
    var provider = songProviderKey(song);
    var r;
    if (provider === 'kg') {
      r = await apiJson('/api/kg/playlist/add-song', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: pid,
          hash: song.hash || song.id || '',
          albumId: song.albumId || song.album_id || '',
          albumAudioId: song.albumAudioId || song.album_audio_id || '',
          name: song.name || ''
        })
      });
      if (!(r && r.success)) throw new Error(collectResultMessage(r));
    } else {
      var songId = String(song.id || '');
      r = await apiJson('/api/playlist/add-song', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: pid, id: songId })
      });
      if (!(r && r.success)) throw new Error(collectResultMessage(r));
      setTimeout(function(){
        verifySongInPlaylist(pid, songId).then(function(ok){
          if (!ok) console.warn('collect submitted but verify did not find song yet:', pid, songId);
        });
      }, 900);
    }
    showToast('已收藏到歌单');
    closeCollectModal();
    refreshUserPlaylists(true);
  } catch (err) {
    showToast(err && err.message ? err.message : '收藏失败');
  } finally {
    collectBusy = false;
    setCollectBusyPid(pid, false);
    updateLikeButtons();
  }
}
function cloneSong(song){ return hydrateCustomCover(Object.assign({}, song)); }
function isQQAvatarHostUrl(url) {
  return /(?:^|\.)(?:qlogo\.cn|qpic\.cn|qq\.com|gtimg\.cn)\//i.test(String(url || '').replace(/^https?:\/\//i, ''));
}
function qqAvatarFromUin(uin, size) {
  uin = String(uin || '').replace(/\D/g, '');
  if (!/^\d{5,12}$/.test(uin)) return '';
  var spec = Math.max(40, Math.min(640, Number(size) || 100));
  return 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(uin) + '&s=' + spec;
}
function normalizeAvatarUrl(url) {
  url = normalizeListenCoverUrl(url);
  if (!url) return '';
  if (/y\.qq\.com\/music\/photo_new\//i.test(url)) {
    url = url.replace('://y.qq.com/music/photo_new/', '://y.gtimg.cn/music/photo_new/');
  }
  return url;
}
function avatarSrc(url) {
  url = normalizeAvatarUrl(url);
  if (!url) return '';
  // QQ headimg CDNs are often missing from /api/cover allowlists; <img> can load them directly.
  if (isQQAvatarHostUrl(url)) return url;
  return coverProxySrc(url, true);
}
function mineradioRetryAvatarImg(img) {
  if (!img) return;
  var step = Number(img.dataset.avatarRetry || 0) || 0;
  var provider = img.dataset.avatarProvider || '';
  var uin = img.dataset.avatarUin || '';
  var raw = normalizeAvatarUrl(img.dataset.avatarRaw || '');
  if (step === 0 && raw && mineradioUsesWebMediaBridge() && typeof window.__mineradioResolveCoverUrl === 'function') {
    img.dataset.avatarRetry = '1';
    resolveCoverUrlForDisplay(raw, false).then(function(resolved) {
      if (!img.isConnected) return;
      if (resolved && resolved !== img.src) img.src = resolved;
      else mineradioRetryAvatarImg(img);
    }).catch(function(){ mineradioRetryAvatarImg(img); });
    return;
  }
  if (step <= 1 && provider === 'qq' && uin) {
    var uinDigits = String(uin).replace(/\D/g, '');
    var candidates = [
      qqAvatarFromUin(uinDigits, 100),
      uinDigits ? ('https://q1.qlogo.cn/headimg_dl?dst_uin=' + encodeURIComponent(uinDigits) + '&spec=100') : ''
    ];
    img.dataset.avatarRetry = '2';
    var next = '';
    for (var i = 0; i < candidates.length; i++) {
      var cand = normalizeAvatarUrl(candidates[i]);
      if (cand && cand !== raw) { next = cand; break; }
    }
    if (next) {
      img.dataset.avatarRaw = next;
      var proxied = avatarSrc(next);
      if (proxied) {
        img.src = proxied;
        if (mineradioUsesWebMediaBridge()) {
          resolveCoverUrlForDisplay(next, false).then(function(resolved) {
            if (resolved && img.isConnected) img.src = resolved;
          }).catch(function(){});
        }
        return;
      }
    }
  }
  img.dataset.avatarRetry = '3';
  img.onerror = null;
  img.src = providerAvatarFallbackSrc(provider || 'qq');
}
function applyAccountAvatar(img, provider, status) {
  if (!img) return;
  status = status || platformStatus(provider) || {};
  var raw = resolveProviderAvatarUrl(provider, status);
  img.dataset.avatarProvider = provider || '';
  img.dataset.avatarUin = String(status.userId || status.uin || '');
  img.dataset.avatarRetry = '0';
  img.referrerPolicy = 'no-referrer';
  if (!raw) {
    img.dataset.avatarRaw = '';
    img.onerror = null;
    img.src = providerAvatarFallbackSrc(provider);
    return;
  }
  img.dataset.avatarRaw = raw;
  img.onerror = function(){ mineradioRetryAvatarImg(img); };
  var proxied = avatarSrc(raw) || providerAvatarFallbackSrc(provider);
  img.src = proxied;
  if (mineradioUsesWebMediaBridge() && raw && !isInlineCoverSrc(raw)) {
    resolveCoverUrlForDisplay(raw, false).then(function(resolved) {
      if (!resolved || !img.isConnected) return;
      if (img.dataset.avatarRaw !== raw) return;
      img.src = resolved;
    }).catch(function(){});
  }
}

// ============================================================
//  搜索
// ============================================================
var searchTimer = null;
var searchRequestSeq = 0;
var searchLastResultQuery = '';
var searchResultCache = Object.create(null);
var searchAbortController = null;
var searchPartialEmitTimer = null;
var searchPartialEmitPending = false;
var SEARCH_CACHE_TTL_MS = 120000;
var SEARCH_INPUT_DEBOUNCE_MS = 100;
var SEARCH_PARTIAL_EMIT_MS = 36;
var SEARCH_PAGE_SIZE = 10;
/* Aggregate: NE alone first (parallel QQ/KG congests Bridge and blanks All) */
var SEARCH_NE_TIMEOUT_MS = 12000;
var SEARCH_SIDE_TIMEOUT_MS = 8000;
var searchPagingState = { query: '', mode: '', page: 0, hasMore: false, loading: false };
var detailResponseCache = Object.create(null);
var DETAIL_CACHE_TTL_MS = 180000;
function detailCacheGet(key) {
  var hit = detailResponseCache[key];
  if (hit && Date.now() - hit.at < DETAIL_CACHE_TTL_MS) return hit.data;
  return null;
}
function detailCacheSet(key, data) {
  if (!key) return;
  detailResponseCache[key] = { at: Date.now(), data: data };
}
var SEARCH_HISTORY_STORE_KEY = 'mineradio-search-history';
var $input = document.getElementById('search-input');
var $results = document.getElementById('search-results');
var $loading = document.getElementById('loading-overlay');
var syncSearchAreaTimer = null;
function syncSearchAreaResultState() {
  var searchArea = document.getElementById('search-area');
  if (!searchArea || !$results) return;
  var hasVisibleResults = $results.classList.contains('show') && $results.children.length > 0;
  var hasIntent = !!($input && String($input.value || '').trim()) || searchMode === 'podcast';
  searchArea.classList.toggle('has-results', hasVisibleResults && hasIntent);
}
function syncSearchAreaResultStateDebounced() {
  clearTimeout(syncSearchAreaTimer);
  syncSearchAreaTimer = setTimeout(syncSearchAreaResultState, 0);
}
var searchResultsLazyBound = false;
function maybeLoadMoreSearchResultsOnScroll() {
  if (!$results || !searchPagingState.hasMore || searchPagingState.loading) return;
  if ($results.scrollTop + $results.clientHeight >= $results.scrollHeight - 120) loadMoreSearchResults();
}
function bindSearchResultsLazyLoad() {
  if (!$results || searchResultsLazyBound) return;
  searchResultsLazyBound = true;
  $results.addEventListener('scroll', maybeLoadMoreSearchResultsOnScroll, { passive: true });
}
function bindSearchResultsHoverPrefetch() {
  if (!$results || searchResultsHoverBound) return;
  searchResultsHoverBound = true;
  function warmSearchResultPlayback(e) {
    var row = e.target && e.target.closest ? e.target.closest('.search-result[data-search-index]') : null;
    if (!row) return;
    var index = Number(row.getAttribute('data-search-index'));
    if (!isFinite(index) || index < 0) return;
    var song = playlist[index];
    if (!song) return;
    fetchPlaybackSourceData(song).catch(function(){});
    prefetchPlaybackAudioForSong(song);
  }
  $results.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    warmSearchResultPlayback(e);
  }, { passive: true });
  $results.addEventListener('touchstart', warmSearchResultPlayback, { passive: true });
  $results.addEventListener('mouseover', function(e){
    var row = e.target && e.target.closest ? e.target.closest('.search-result[data-search-index]') : null;
    if (!row) return;
    var index = Number(row.getAttribute('data-search-index'));
    if (!isFinite(index) || index < 0) return;
    clearTimeout(searchHoverPrefetchTimer);
    searchHoverPrefetchTimer = setTimeout(function(){
      var song = playlist[index];
      if (song) {
        prefetchPlaybackSourceForSong(song);
        prefetchPlaybackAudioForSong(song);
      }
    }, 120);
  }, { passive: true });
  $results.addEventListener('mouseleave', function(e){
    if (e.target === $results || !$results.contains(e.relatedTarget)) clearTimeout(searchHoverPrefetchTimer);
  }, { passive: true });
}
function prefetchSearchNextPage(q, mode) {
  if (!q || !searchPagingState.hasMore || searchPagingState.page !== 1) return;
  var cacheKey = searchResultKeyWithPage(q, mode, 2);
  var cached = searchResultCache[cacheKey];
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return;
  fetchMusicSearchPage(q, mode, 2).then(function(result){
    if (!result || !result.songs || !result.songs.length) return;
    searchResultCache[cacheKey] = { at: Date.now(), songs: result.songs.slice(), hasMore: !!result.hasMore };
  }).catch(function(){});
}
if (window.MutationObserver && $results) {
  new MutationObserver(syncSearchAreaResultStateDebounced).observe($results, { childList: true, attributes: true, attributeFilter: ['class'] });
}
bindSearchResultsLazyLoad();
bindSearchResultsHoverPrefetch();
function abortActiveSearchRequests() {
  if (searchAbortController) {
    try { searchAbortController.abort(); } catch (_) {}
    searchAbortController = null;
  }
  clearTimeout(searchPartialEmitTimer);
  searchPartialEmitTimer = null;
  searchPartialEmitPending = false;
}
function beginSearchRequest() {
  abortActiveSearchRequests();
  if (window.AbortController) searchAbortController = new AbortController();
}
function searchApiJson(url) {
  var opts = {};
  if (searchAbortController) opts.signal = searchAbortController.signal;
  return apiJson(url, opts);
}
function searchProviderJson(url, timeoutMs) {
  timeoutMs = Math.max(1000, Number(timeoutMs) || SEARCH_NE_TIMEOUT_MS);
  var settled = false;
  return new Promise(function(resolve) {
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve({ songs: [], error: 'SEARCH_TIMEOUT', timedOut: true });
    }, timeoutMs);
    searchApiJson(url).then(function(r) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r && typeof r === 'object' ? r : { songs: [] });
    }).catch(function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ songs: [], error: (err && err.message) || 'SEARCH_FAILED' });
    });
  });
}
function isMusicSearchMode(mode) {
  return mode !== 'podcast';
}
function searchResultKey(q, mode) {
  return (mode || searchMode || 'song') + '|' + String(q || '').trim();
}
function clearSearchResults() {
  searchRequestSeq++;
  abortActiveSearchRequests();
  searchLastResultQuery = '';
  resetSearchPaging();
  playlist = [];
  podcastResults = [];
  podcastPrograms = [];
  podcastCurrentRadio = null;
  $results.innerHTML = '';
  $results.classList.remove('show');
}
function isImePinyinDraftQuery(q) {
  q = String(q || '').trim();
  if (!q) return true;
  // Chinese IME syllable drafts: mei'ren'y / wang'zi'jian
  if (/^[a-z]+(?:'[a-z]*)+$/i.test(q)) return true;
  if (/[a-z]'[a-z]/i.test(q) && !/[\u4e00-\u9fff]/.test(q)) return true;
  return false;
}
function normalizeSearchHistoryItem(q) {
  q = String(q || '').trim().replace(/\s+/g, ' ');
  if (!q || isImePinyinDraftQuery(q)) return '';
  return q.slice(0, 48);
}
function readSearchHistory() {
  try {
    var raw = JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    var seen = {};
    var cleaned = [];
    raw.forEach(function(v){
      var item = normalizeSearchHistoryItem(v);
      if (!item) return;
      var key = item.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      cleaned.push(item);
    });
    cleaned = cleaned.slice(0, 10);
    if (cleaned.length !== raw.length) writeSearchHistory(cleaned);
    return cleaned;
  } catch (e) {
    return [];
  }
}
function writeSearchHistory(items) {
  try { localStorage.setItem(SEARCH_HISTORY_STORE_KEY, JSON.stringify((items || []).slice(0, 10))); } catch (e) {}
}
function rememberSearchQuery(q) {
  q = normalizeSearchHistoryItem(q);
  if (!q) return;
  var items = readSearchHistory().filter(function(item){ return item.toLowerCase() !== q.toLowerCase(); });
  items.unshift(q);
  writeSearchHistory(items);
}
function renderSearchHistory() {
  if (searchMode !== 'song') return false;
  var items = readSearchHistory();
  if (!items.length) {
    $results.innerHTML = '';
    $results.classList.remove('show');
    return false;
  }
  $results.innerHTML =
    '<div class="search-history">' +
      '<div class="search-history-head"><span>搜索历史</span><button class="search-history-clear" type="button" data-clear-history="1">清空</button></div>' +
      '<div class="search-history-list">' +
        items.map(function(q){ return '<button class="search-history-chip" type="button" data-history-query="' + escHtml(q) + '">' + escHtml(q) + '</button>'; }).join('') +
      '</div>' +
    '</div>';
  $results.classList.add('show');
  requestAnimationFrame(updateSearchPillGlassDisplacementMap);
  return true;
}
function clearSearchHistory() {
  writeSearchHistory([]);
  renderSearchHistory();
}
function runSearchHistory(q) {
  q = String(q || '').trim();
  if (!q) return;
  $input.value = q;
  setPeek(document.getElementById('search-area'), true, 'search');
  submitSearch();
  $input.focus();
}
function tryHydrateSearchFromCache(q, mode, opts) {
  opts = opts || {};
  if (!q || !isMusicSearchMode(mode)) return false;
  var cacheKey = searchResultKeyWithPage(q, mode, 1);
  var cached = searchResultCache[cacheKey];
  if (!cached || Date.now() - cached.at >= SEARCH_CACHE_TTL_MS) return false;
  /* Never hydrate a blank All-search cache — side providers may have timed out earlier */
  if (!cached.songs || !cached.songs.length) return false;
  resetSearchPaging();
  searchPagingState.query = q;
  searchPagingState.mode = mode;
  searchPagingState.page = 1;
  searchPagingState.hasMore = !!cached.hasMore;
  renderSongSearchResults(cached.songs.slice(), { skipLikeSync: !!opts.skipLikeSync, skipAnimate: true });
  searchLastResultQuery = searchResultKey(q, mode);
  return true;
}
function submitSearch(opts) {
  opts = opts || {};
  clearTimeout(searchTimer);
  var q = String($input && $input.value || '').trim();
  var searchArea = document.getElementById('search-area');
  if (searchArea) setPeek(searchArea, true, 'search');
  if (!q) {
    if (searchMode === 'podcast') loadPodcastHot();
    else renderSearchHistory();
    return;
  }
  if (isMusicSearchMode(searchMode) && !tryHydrateSearchFromCache(q, searchMode, { skipLikeSync: true })) {
    $results.innerHTML = '<div class="search-empty">正在搜索 “' + escHtml(q) + '”…</div>';
    $results.classList.add('show');
  }
  doSearch(q, { autoPlayFirst: !!opts.autoPlayFirst, remember: true });
}
function updateSearchModeTabs() {
  var songBtn = document.getElementById('search-mode-song');
  var neteaseBtn = document.getElementById('search-mode-netease');
  var qqBtn = document.getElementById('search-mode-qq');
  var kgBtn = document.getElementById('search-mode-kg');
  var podcastBtn = document.getElementById('search-mode-podcast');
  if (songBtn) {
    songBtn.classList.toggle('active', searchMode === 'song');
    songBtn.setAttribute('aria-selected', searchMode === 'song' ? 'true' : 'false');
  }
  if (neteaseBtn) {
    neteaseBtn.classList.toggle('active', searchMode === 'netease');
    neteaseBtn.setAttribute('aria-selected', searchMode === 'netease' ? 'true' : 'false');
  }
  if (qqBtn) {
    qqBtn.classList.toggle('active', searchMode === 'qq');
    qqBtn.setAttribute('aria-selected', searchMode === 'qq' ? 'true' : 'false');
  }
  if (kgBtn) {
    kgBtn.classList.toggle('active', searchMode === 'kg');
    kgBtn.setAttribute('aria-selected', searchMode === 'kg' ? 'true' : 'false');
  }
  if (podcastBtn) {
    podcastBtn.classList.toggle('active', searchMode === 'podcast');
    podcastBtn.setAttribute('aria-selected', searchMode === 'podcast' ? 'true' : 'false');
  }
  if ($input) {
    $input.placeholder = searchMode === 'podcast'
      ? '搜索播客、电台...'
      : (searchMode === 'qq' ? '搜索 QQ 音乐...' : (searchMode === 'kg' ? '搜索酷狗音乐...' : (searchMode === 'netease' ? '搜索网易云音乐...' : '搜索歌曲、歌手...')));
  }
  requestAnimationFrame(updateSearchPillGlassDisplacementMap);
}
function setSearchMode(mode) {
  mode = (mode === 'podcast' || mode === 'netease' || mode === 'qq' || mode === 'kg') ? mode : 'song';
  if (searchMode === mode) return;
  searchMode = mode;
  updateSearchModeTabs();
  clearSearchResults();
  var searchArea = document.getElementById('search-area');
  if (searchArea) setPeek(searchArea, true, 'search');
  var q = $input ? $input.value.trim() : '';
  if (searchMode === 'podcast') {
    if (q) doSearch(q);
    else loadPodcastHot();
  } else if (q) {
    doSearch(q);
  } else {
    renderSearchHistory();
  }
}
function podcastMetaText(item) {
  item = item || {};
  var bits = [];
  if (item.djName) bits.push(item.djName);
  if (item.programCount) bits.push(item.programCount + ' episodes');
  if (item.subCount) bits.push(Math.round(item.subCount / 1000) + 'k follows');
  return bits.join('  ·  ');
}
function formatProgramTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = Math.floor(sec % 60);
  return h ? (h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')) : (m + ':' + String(s).padStart(2, '0'));
}
function programMetaText(item) {
  item = item || {};
  var bits = [];
  if (item.radioName || item.artist) bits.push(item.radioName || item.artist);
  if (item.djName && item.djName !== item.artist) bits.push(item.djName);
  if (item.duration) bits.push(formatProgramTime(Math.round(item.duration / 1000)));
  return bits.join('  ·  ');
}
function searchThumbHtml(src) {
  return src
    ? '<img src="' + coverUrlWithSize(src, 80) + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">'
    : '<div style="width:40px;height:40px;border-radius:6px;background:rgba(255,255,255,0.06);flex-shrink:0"></div>';
}
function renderPodcastRadios(items, label) {
  podcastResults = items || [];
  podcastPrograms = [];
  playlist = [];
  if (!podcastResults.length) {
    $results.innerHTML = '<div class="search-empty">No podcast found</div>';
    $results.classList.add('show');
    return;
  }
  $results.innerHTML = podcastResults.map(function(p, i){
    return '<div class="search-result">' +
      '<div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0" onclick="openPodcastPrograms(' + i + ')">' +
        searchThumbHtml(p.cover) +
        '<div class="search-result-info">' +
          '<div class="search-result-title">' + escHtml(p.name || '') + '<span class="tag-podcast">Podcast</span></div>' +
          '<div class="search-result-meta">' + escHtml(podcastMetaText(p) || label || 'NetEase Radio') + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="add-btn" title="Open" onclick="event.stopPropagation();openPodcastPrograms(' + i + ')">›</button>' +
    '</div>';
  }).join('');
  $results.classList.add('show');
  if (window.gsap) animateListItems($results, '.search-result', { x: 0, y: 6, stagger: 0.012, duration: 0.18, limit: 18 });
}
async function loadPodcastHot() {
  var requestSeq = ++searchRequestSeq;
  $results.innerHTML = '<div class="search-empty">Loading podcasts...</div>';
  $results.classList.add('show');
  try {
    var data = await apiJson('/api/podcast/hot?limit=18');
    if (requestSeq !== searchRequestSeq || searchMode !== 'podcast') return;
    renderPodcastRadios(data.podcasts || [], 'Hot podcasts');
  } catch (err) {
    console.error('Podcast hot:', err);
    if (requestSeq === searchRequestSeq) $results.innerHTML = '<div class="search-empty">Podcast load failed</div>';
  }
}
async function doPodcastSearch(q) {
  var requestSeq = ++searchRequestSeq;
  try {
    var data = await apiJson('/api/podcast/search?keywords=' + encodeURIComponent(q) + '&limit=18');
    if (requestSeq !== searchRequestSeq || searchMode !== 'podcast' || $input.value.trim() !== q) return;
    renderPodcastRadios(data.podcasts || [], 'Search results');
  } catch (err) {
    console.error('Podcast search:', err);
  }
}
async function openPodcastPrograms(i) {
  var radio = podcastResults[i]; if (!radio) return;
  var requestSeq = ++searchRequestSeq;
  podcastCurrentRadio = radio;
  $results.innerHTML = '<div class="search-empty">Loading episodes...</div>';
  $results.classList.add('show');
  try {
    var data = await apiJson('/api/podcast/programs?id=' + encodeURIComponent(radio.id) + '&limit=36');
    if (requestSeq !== searchRequestSeq || searchMode !== 'podcast') return;
    podcastCurrentRadio = Object.assign({}, radio, data.radio || {});
    podcastPrograms = data.programs || [];
    playlist = podcastPrograms;
    renderPodcastPrograms();
  } catch (err) {
    console.error('Podcast programs:', err);
    if (requestSeq === searchRequestSeq) $results.innerHTML = '<div class="search-empty">Episodes load failed</div>';
  }
}
function renderPodcastPrograms(opts) {
  opts = opts || {};
  var radio = podcastCurrentRadio || {};
  if (!opts.keepLimit) podcastEpisodeRenderLimit = PODCAST_EPISODE_INITIAL;
  if (!podcastPrograms.length) {
    $results.innerHTML = '<div class="podcast-result-head"><button class="podcast-back-btn" onclick="event.stopPropagation();renderPodcastRadios(podcastResults)">‹</button><div class="search-result-info"><div class="search-result-title">' + escHtml(radio.name || 'Podcast') + '</div><div class="search-result-meta">No playable episodes</div></div></div>';
    $results.classList.add('show');
    return;
  }
  podcastEpisodeRenderLimit = Math.max(PODCAST_EPISODE_INITIAL, Math.min(podcastPrograms.length, podcastEpisodeRenderLimit || PODCAST_EPISODE_INITIAL));
  var visiblePrograms = podcastPrograms.slice(0, podcastEpisodeRenderLimit);
  var episodeHtml = visiblePrograms.map(function(p, i){
    return '<div class="search-result">' +
      '<div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0" onclick="playPodcastProgram(' + i + ')">' +
        searchThumbHtml(p.cover) +
        '<div class="search-result-info">' +
          '<div class="search-result-title">' + escHtml(p.name || '') + '</div>' +
          '<div class="search-result-meta">' + escHtml(programMetaText(p)) + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="add-btn" title="下一首播放" onclick="event.stopPropagation();queuePodcastProgram(' + i + ')">+</button>' +
    '</div>';
  }).join('');
  if (podcastPrograms.length > visiblePrograms.length) {
    episodeHtml += '<button type="button" class="fx-mini-btn ghost podcast-load-more" onclick="growPodcastEpisodeRenderLimit()">加载更多 ' + visiblePrograms.length + '/' + podcastPrograms.length + '</button>';
  }
  $results.innerHTML =
    '<div class="podcast-result-head">' +
      '<button class="podcast-back-btn" onclick="event.stopPropagation();renderPodcastRadios(podcastResults)">‹</button>' +
      searchThumbHtml(radio.cover) +
      '<div class="search-result-info"><div class="search-result-title">' + escHtml(radio.name || 'Podcast') + '<span class="tag-podcast">Podcast</span></div><div class="search-result-meta">' + escHtml(radio.djName || (podcastPrograms.length + ' episodes')) + '</div></div>' +
    '</div>' +
    episodeHtml;
  $results.classList.add('show');
  if (window.gsap) animateListItems($results, '.search-result', { x: 0, y: 6, stagger: 0.010, duration: 0.18, limit: 18 });
}
function growPodcastEpisodeRenderLimit() {
  podcastEpisodeRenderLimit = Math.min(podcastPrograms.length, (podcastEpisodeRenderLimit || PODCAST_EPISODE_INITIAL) + PODCAST_EPISODE_BATCH);
  renderPodcastPrograms({ keepLimit: true });
}
function queuePodcastProgram(i) {
  var item = podcastPrograms[i]; if (!item) return;
  queueSongNext(item);
  showToast('已设为下一首: ' + item.name);
}
function playPodcastProgram(i) {
  var item = podcastPrograms[i]; if (!item) return;
  playSearchResult(i);
}

var searchImeComposing = false;
function scheduleLiveSearchFromInput() {
  clearTimeout(searchTimer);
  if (searchImeComposing) return;
  var q = $input.value.trim();
  if (!q) {
    if (searchMode === 'podcast') loadPodcastHot();
    else renderSearchHistory();
    return;
  }
  // Don't live-search raw IME pinyin drafts; wait for composition to finish.
  if (isImePinyinDraftQuery(q)) return;
  if (isMusicSearchMode(searchMode)) {
    if (!tryHydrateSearchFromCache(q, searchMode, { skipLikeSync: true })) {
      $results.innerHTML = '<div class="search-empty">正在搜索 “' + escHtml(q) + '”…</div>';
      $results.classList.add('show');
    }
  }
  searchTimer = setTimeout(function(){ doSearch(q); }, SEARCH_INPUT_DEBOUNCE_MS);
}
$input.addEventListener('compositionstart', function(){
  searchImeComposing = true;
  clearTimeout(searchTimer);
});
$input.addEventListener('compositionend', function(){
  searchImeComposing = false;
  scheduleLiveSearchFromInput();
});
$input.addEventListener('input', function(e){
  if ((e && e.isComposing) || searchImeComposing) return;
  scheduleLiveSearchFromInput();
});
$input.addEventListener('focus', function(){
  var searchArea = document.getElementById('search-area');
  if (searchArea) setPeek(searchArea, true, 'search');
  if (!$input.value.trim() && isMusicSearchMode(searchMode)) renderSearchHistory();
  else if ($results.children.length > 0) $results.classList.add('show');
  else if (searchMode === 'podcast') loadPodcastHot();
});
var searchBoxEl = document.getElementById('search-box');
var searchSubmitBtn = document.getElementById('search-submit-btn');
if (searchBoxEl) {
  searchBoxEl.addEventListener('click', function(e){
    if (e.target.closest && e.target.closest('#search-submit-btn')) return;
    if ($input) $input.focus();
  });
}
if (searchSubmitBtn) {
  searchSubmitBtn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    submitSearch();
    if ($input) $input.focus();
  });
}
$input.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    submitSearch();
  } else if (e.key === 'Escape') {
    clearTimeout(searchTimer);
    $input.blur();
    clearSearchResults();
    if (!emptyHomeActive) setPeek(document.getElementById('search-area'), false, 'search');
  }
});
$results.addEventListener('click', function(e){
  var clearBtn = e.target && e.target.closest ? e.target.closest('[data-clear-history]') : null;
  if (clearBtn) {
    e.preventDefault();
    e.stopPropagation();
    clearSearchHistory();
    return;
  }
  var item = e.target && e.target.closest ? e.target.closest('[data-history-query]') : null;
  if (item) {
    e.preventDefault();
    e.stopPropagation();
    runSearchHistory(item.getAttribute('data-history-query') || '');
  }
});
document.addEventListener('click', function(e){
  var searchArea = document.getElementById('search-area');
  if (!searchArea.contains(e.target)) {
    $results.classList.remove('show');
    if (!emptyHomeActive) setPeek(searchArea, false, 'search');
  }
});
updateSearchModeTabs();

function songProviderKey(song) {
  if (song && (song.provider === 'kg' || song.source === 'kg' || song.type === 'kg')) return 'kg';
  if (song && (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq')) return 'qq';
  return 'netease';
}
function kgPlaybackUrlQuery(song, qualityParam) {
  return '/api/kg/song/url?hash=' + encodeURIComponent(song.hash || song.hash128 || song.id || '') +
    '&albumId=' + encodeURIComponent(song.albumId || song.album_id || '') +
    '&albumAudioId=' + encodeURIComponent(song.albumAudioId || song.album_audio_id || '') +
    '&hash320=' + encodeURIComponent(song.hash320 || '') +
    '&hashSq=' + encodeURIComponent(song.hashSq || '') +
    qualityParam;
}
function playbackSourceCacheKey(song, opts) {
  opts = opts || {};
  if (!song) return '';
  var provider = songProviderKey(song);
  var q = normalizePlaybackQualityForProvider(opts.qualityOverride || playbackQuality, provider);
  if (provider === 'kg') {
    return 'kg:' + (song.hash || song.id || '') + '|' + (song.albumId || '') + '|' + (song.albumAudioId || '') + '|' + q;
  }
  if (provider === 'qq') {
    return 'qq:' + (song.mid || song.songmid || song.id || '') + '|' + (song.mediaMid || song.media_mid || '') + '|' + q;
  }
  return 'ne:' + (song.id || '') + '|' + q;
}
function readPlaybackSourceCache(key) {
  if (!key) return null;
  var hit = playbackSourceCache[key];
  if (!hit || !hit.data || !hit.data.url) return null;
  if (Date.now() - hit.at > PLAYBACK_SOURCE_CACHE_TTL_MS) {
    delete playbackSourceCache[key];
    return null;
  }
  return hit.data;
}
function writePlaybackSourceCache(key, data) {
  if (!key || !data || !data.url) return;
  var prev = playbackSourceCache[key];
  playbackSourceCache[key] = { data: data, at: Date.now(), resolvedUrl: prev && prev.resolvedUrl ? prev.resolvedUrl : '' };
  var keys = Object.keys(playbackSourceCache);
  if (keys.length > 24) {
    keys.sort(function(a, b){ return (playbackSourceCache[a].at || 0) - (playbackSourceCache[b].at || 0); });
    keys.slice(0, keys.length - 24).forEach(function(k){ delete playbackSourceCache[k]; });
  }
}
function rememberPlaybackSourceResolvedUrl(key, resolvedUrl) {
  if (!key || !resolvedUrl) return;
  var hit = playbackSourceCache[key];
  if (hit) hit.resolvedUrl = resolvedUrl;
}
function canSwapPrefetchedPlaybackAudio() {
  // Always allow hot-swapping a warm prefetched <audio>; graph is reattached in initAudio.
  return true;
}
function preparePrefetchAudioElementSwap() {
  if (!canUsePlaybackAudioGraph()) {
    audioReady = false;
    return;
  }
  try {
    if (source) { source.disconnect(); source = null; }
    if (analyser) { analyser.disconnect(); analyser = null; }
    if (beatAnalyser) { beatAnalyser.disconnect(); beatAnalyser = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
  } catch (_) {}
  audioReady = false;
}
function retirePlaybackAudioElement(el) {
  if (!el) return;
  try { el.onended = null; } catch (_) {}
  try { el.onerror = null; } catch (_) {}
  try { el.pause(); } catch (_) {}
  try {
    el.removeAttribute('src');
    el.load();
  } catch (_) {}
}
function disposePlaybackAudioPrefetchMedia() {
  if (!playbackAudioPrefetch.media) return;
  try {
    playbackAudioPrefetch.media.onended = null;
    playbackAudioPrefetch.media.pause();
    playbackAudioPrefetch.media.removeAttribute('src');
    playbackAudioPrefetch.media.load();
  } catch (_) {}
  playbackAudioPrefetch.media = null;
}
function cancelInFlightPlaybackAudioPrefetch(exceptKey) {
  if (playbackAudioPrefetch.key && playbackAudioPrefetch.key !== exceptKey) {
    playbackAudioPrefetchToken++;
    disposePlaybackAudioPrefetchMedia();
    playbackAudioPrefetch = { key: '', idx: -1, media: null, directUrl: '', resolvedUrl: '', token: 0 };
  }
}
function resolveNextQueueIndex(fromIdx) {
  if (!playQueue.length) return -1;
  if (playMode === 'shuffle') return Math.floor(Math.random() * playQueue.length);
  if (playMode === 'single') return fromIdx;
  return (fromIdx + 1) % playQueue.length;
}
function takePrefetchedPlaybackAudio(key) {
  if (!key || playbackAudioPrefetch.key !== key) return null;
  var out = {
    media: canSwapPrefetchedPlaybackAudio() ? playbackAudioPrefetch.media : null,
    directUrl: playbackAudioPrefetch.directUrl,
    resolvedUrl: playbackAudioPrefetch.resolvedUrl,
    warm: !!(playbackAudioPrefetch.media && playbackAudioPrefetch.media.readyState >= 2)
  };
  if (out.media) playbackAudioPrefetch.media = null;
  else disposePlaybackAudioPrefetchMedia();
  playbackAudioPrefetch = { key: '', idx: -1, media: null, directUrl: '', resolvedUrl: '', token: 0 };
  return out;
}
async function prefetchPlaybackAudioForSong(song, opts) {
  if (!song || song.type === 'local' || song.source === 'local') return;
  opts = opts || {};
  prefetchSongCover(song);
  var key = playbackSourceCacheKey(song, opts);
  if (playbackAudioPrefetch.key === key && playbackAudioPrefetch.media && playbackAudioPrefetch.media.readyState >= 2) return;
  var myToken = ++playbackAudioPrefetchToken;
  try {
    var data = await fetchPlaybackSourceData(song, opts);
    if (myToken !== playbackAudioPrefetchToken || !data || !data.url) return;
    var resolvedUrl = await resolvePlaybackAudioUrl(data.url);
    if (myToken !== playbackAudioPrefetchToken || !resolvedUrl) return;
    rememberPlaybackSourceResolvedUrl(key, resolvedUrl);
    // Reuse the same warm element if URL is unchanged.
    if (playbackAudioPrefetch.key === key && playbackAudioPrefetch.media && playbackAudioPrefetch.resolvedUrl === resolvedUrl) {
      playbackAudioPrefetch.token = myToken;
      return;
    }
    disposePlaybackAudioPrefetchMedia();
    var media = new Audio();
    configurePlaybackAudioElement(media, data.url);
    media.preload = 'auto';
    media.src = resolvedUrl;
    media.load();
    // Nudge buffering without audible play (muted play is blocked on some browsers; load() is enough).
    playbackAudioPrefetch = { key: key, idx: -1, media: media, directUrl: data.url, resolvedUrl: resolvedUrl, token: myToken };
  } catch (_) {}
}
function prefetchPlaybackSourceForSong(song, opts) {
  if (!song || song.type === 'local' || song.source === 'local') return;
  opts = opts || {};
  var key = playbackSourceCacheKey(song, opts);
  if (readPlaybackSourceCache(key)) return;
  fetchPlaybackSourceData(song, opts).catch(function(){});
}
function prefetchPlaybackSourceForIndex(idx, opts) {
  if (idx < 0 || idx >= playQueue.length) return;
  prefetchPlaybackSourceForSong(playQueue[idx], opts);
}
async function prefetchPlaybackAudioForIndex(idx, opts) {
  if (idx < 0 || idx >= playQueue.length) return;
  var song = playQueue[idx];
  if (!song) return;
  playbackAudioPrefetch.idx = idx;
  await prefetchPlaybackAudioForSong(song, opts);
}
function maybePrefetchNextTrackDuringPlayback() {
  if (!audio || audio.paused || audio.ended || !playQueue.length || currentIdx < 0) return;
  var now = Date.now();
  if (now - lastPlaybackPrefetchAt < 1400) return;
  var duration = getPlaybackDurationSeconds();
  var current = getPlaybackCurrentSeconds();
  var shouldPrefetch = false;
  if (duration > 0) {
    // Start warming the next track early so manual next / auto-advance feel seamless.
    shouldPrefetch = (duration - current) <= 90 || (current / duration) >= 0.12 || current >= 6;
  } else if (current >= 6) {
    shouldPrefetch = true;
  }
  if (!shouldPrefetch) return;
  lastPlaybackPrefetchAt = now;
  var nextIdx = resolveNextQueueIndex(currentIdx);
  if (nextIdx < 0 || nextIdx === currentIdx) return;
  prefetchPlaybackSourceForIndex(nextIdx);
  prefetchPlaybackAudioForIndex(nextIdx);
}
function prefetchAdjacentPlaybackSources(fromIdx) {
  if (!playQueue.length) return;
  var nextIdx = resolveNextQueueIndex(fromIdx);
  prefetchPlaybackSourceForIndex(nextIdx);
  if (nextIdx >= 0 && playQueue[nextIdx]) prefetchSongCover(playQueue[nextIdx]);
  if (playMode !== 'shuffle' && fromIdx + 1 < playQueue.length && fromIdx + 1 !== nextIdx) {
    prefetchPlaybackSourceForIndex(fromIdx + 1);
    if (playQueue[fromIdx + 1]) prefetchSongCover(playQueue[fromIdx + 1]);
  }
  if (playQueue.length > 2 && playMode !== 'shuffle') prefetchPlaybackSourceForIndex(fromIdx - 1);
  // Always warm the actual next audio element (not only the URL) for gapless-ish switches.
  if (nextIdx >= 0 && nextIdx !== fromIdx) prefetchPlaybackAudioForIndex(nextIdx);
  else if (fromIdx + 1 < playQueue.length) prefetchPlaybackAudioForIndex(fromIdx + 1);
}
function isQQSongVipRequired(song) {
  return !!(song && songProviderKey(song) === 'qq' && Number(song.fee) === 1);
}
function songVipTagHtml(song) {
  if (!song) return '';
  var key = songProviderKey(song);
  var isVip = key === 'qq'
    ? isQQSongVipRequired(song)
    : (Number(song.fee) === 1 || (key === 'kg' && (song.vip === 1 || song.isVip === true)));
  if (!isVip) return '';
  var cls = 'tag-vip' + (key === 'kg' ? ' kg' : (key === 'qq' ? ' qq' : ''));
  return '<span class="' + cls + '">VIP</span>';
}
function songSourceTagHtml(song) {
  var key = songProviderKey(song);
  var label = key === 'qq' ? 'QQ' : (key === 'kg' ? 'KG' : 'NE');
  return '<span class="tag-source ' + key + '">' + label + '</span>';
}
function searchModeLabel(mode) {
  mode = mode || searchMode;
  return mode === 'qq' ? 'QQ 音乐' : (mode === 'kg' ? '酷狗音乐' : (mode === 'netease' ? '网易云' : '综合'));
}
function searchResultDurationText(song) {
  var sec = songDurationSec(song);
  if (!sec) return '';
  return formatProgramTime(sec);
}
function isSearchResultPlaying(song) {
  if (!song || currentIdx < 0 || !playQueue.length) return false;
  var current = playQueue[currentIdx];
  if (!current) return false;
  return queueItemKey(current) === queueItemKey(song);
}
function buildSearchResultsHeadHtml(count, q) {
  count = Math.max(0, Number(count) || 0);
  q = String(q || '').trim();
  var modeText = searchModeLabel(searchPagingState.mode || searchMode);
  var title = count ? (modeText + ' · <strong>' + count + '</strong> 条结果') : (modeText + ' · 搜索中…');
  if (q) title = '“' + escHtml(q.length > 18 ? q.slice(0, 18) + '…' : q) + '” · ' + title;
  return '<div class="search-results-head"><span>' + title + '</span><span class="search-results-hint">点击播放 · + 下一首</span></div>';
}
function updateSearchResultsHead(count, q) {
  if (!$results) return;
  var head = $results.querySelector('.search-results-head');
  var html = buildSearchResultsHeadHtml(count != null ? count : playlist.length, q || searchPagingState.query || ($input && $input.value.trim()) || '');
  if (head) head.outerHTML = html;
  else $results.insertAdjacentHTML('afterbegin', html);
}
function refreshSearchResultPlayingState() {
  if (!$results || !$results.classList.contains('show')) return;
  var playingKey = currentIdx >= 0 && playQueue[currentIdx] ? queueItemKey(playQueue[currentIdx]) : '';
  $results.querySelectorAll('.search-result[data-search-index]').forEach(function(row){
    var index = Number(row.getAttribute('data-search-index'));
    var song = playlist[index];
    var playing = !!(song && playingKey && queueItemKey(song) === playingKey);
    row.classList.toggle('playing', playing);
    var badge = row.querySelector('.search-play-badge');
    if (playing) {
      if (!badge) {
        var title = row.querySelector('.search-result-title');
        if (title) title.insertAdjacentHTML('afterbegin', '<span class="search-play-badge">播放中</span>');
      }
    } else if (badge) badge.remove();
  });
}
function searchResultMetaText(song) {
  var bits = [];
  if (song.artist) bits.push(song.artist);
  if (song.album) bits.push(song.album);
  if (songProviderKey(song) === 'qq' && !song.playable && !hasPlatformLogin('qq')) bits.push('QQ 需登录');
  if (isQQSongVipRequired(song)) bits.push('QQ 会员');
  if (songProviderKey(song) === 'kg' && Number(song.fee) === 1) bits.push('酷狗会员');
  return bits.join('  ·  ') || songSourceLabel(song);
}
function searchResultMetaHtml(song, index) {
  song = song || {};
  var artist = String(song.artist || '').trim();
  var bits = [];
  if (song.album) bits.push(song.album);
  if (songProviderKey(song) === 'qq' && !song.playable && !hasPlatformLogin('qq')) bits.push('QQ 需登录');
  if (isQQSongVipRequired(song)) bits.push('QQ 会员');
  if (songProviderKey(song) === 'kg' && Number(song.fee) === 1) bits.push('酷狗会员');
  var tail = bits.length ? (' · ' + escHtml(bits.join('  ·  '))) : '';
  if (!artist) return escHtml(searchResultMetaText(song));
  return '<button class="search-artist-link" type="button" onclick="event.stopPropagation();openSearchResultArtist(' + index + ')">' + escHtml(artist) + '</button>' + tail;
}
function openSearchResultArtist(index) {
  var song = playlist && playlist[index];
  if (!song) return;
  openArtistDetailForSong(song);
}
function searchIntentPrefersQQ(q) {
  q = String(q || '').toLowerCase();
  return /(^|\s)qq($|\s)|qq音乐|qq音樂|周杰伦|周杰倫|jay\s*chou|jay/.test(q);
}
function simpleSearchNorm(text) {
  return String(text || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
}
function searchMentionsKnownArtist(q, artist) {
  var rawQ = String(q || '').toLowerCase();
  var rawArtist = String(artist || '').toLowerCase();
  if (!rawArtist) return false;
  if (/周杰伦|周杰倫|jay\s*chou/.test(rawQ) && /周杰伦|周杰倫|jay\s*chou/.test(rawArtist)) return true;
  var nq = simpleSearchNorm(q);
  var na = simpleSearchNorm(artist);
  return !!(na && na.length >= 2 && nq.indexOf(na) >= 0);
}
function searchLooksLikeDerivative(text) {
  return /(翻唱|cover|伴奏|instrumental|remix|片段|demo|女声|男声|karaoke|完整版\s*cover|抖音版|dj版|合唱版|改编版|赵露思版|超燃|硬曲|剪辑|二创|tribute|made\s*famous\s*by)/i.test(String(text || ''));
}
var SEARCH_ORIGINAL_ARTIST_HINTS = [
  { titles: ['日落大道'], artists: ['梁博'] },
  { titles: ['beautyandabeat', 'beauty and a beat'], artists: ['justin bieber', 'nicki minaj'] }
];
function canonicalOriginalArtistsForSearch(q, song) {
  var qNorm = simpleSearchNorm(q);
  var titleNorm = simpleSearchNorm(song && song.name);
  var joined = qNorm + ' ' + titleNorm;
  var artists = [];
  SEARCH_ORIGINAL_ARTIST_HINTS.forEach(function(rule){
    var matched = (rule.titles || []).some(function(title){
      var nt = simpleSearchNorm(title);
      var titleMatches = !!(titleNorm && (titleNorm === nt || titleNorm.indexOf(nt) >= 0));
      return !!(nt && (qNorm.indexOf(nt) >= 0 || titleMatches));
    });
    if (matched) {
      (rule.artists || []).forEach(function(artist){
        if (artists.indexOf(artist) < 0) artists.push(artist);
      });
    }
  });
  return artists;
}
function songArtistMatchesAny(song, artists) {
  var songArtist = simpleSearchNorm(song && song.artist);
  if (!songArtist || !artists || !artists.length) return false;
  return artists.some(function(artist){
    var na = simpleSearchNorm(artist);
    return !!(na && (songArtist.indexOf(na) >= 0 || na.indexOf(songArtist) >= 0));
  });
}
function searchLooksLikeSameTitleCover(song, nq, name, album, raw, originalArtistMatch, sourceIndex) {
  if (!song || !nq || !name || originalArtistMatch) return false;
  var sameTitle = name === nq || nq.indexOf(name) >= 0 || name.indexOf(nq) === 0;
  if (!sameTitle) return false;
  var selfTitledSingle = !!(album && (album === name || album === nq || album.indexOf(name) >= 0 || name.indexOf(album) >= 0));
  return selfTitledSingle || searchLooksLikeDerivative(raw) || (sourceIndex || 0) > 0;
}
function buildSearchScoreContext(q) {
  var qs = String(q || '');
  return {
    q: qs,
    nq: simpleSearchNorm(qs),
    qAsksDerivative: /(live|现场|翻唱|cover|伴奏|instrumental|remix|dj|片段|demo|女声|男声|karaoke)/i.test(qs),
    qPrefersQQ: searchIntentPrefersQQ(qs),
    qJayChou: /周杰伦|周杰倫|jay\s*chou/i.test(qs),
    qPrefersKG: /酷狗|kugou|kg音乐/i.test(qs)
  };
}
function scoreSongSearchResult(song, q, sourceIndex, ctx) {
  ctx = ctx || buildSearchScoreContext(q);
  var nq = ctx.nq;
  var name = simpleSearchNorm(song && song.name);
  var artist = simpleSearchNorm(song && song.artist);
  var album = simpleSearchNorm(song && song.album);
  var raw = String(((song && song.name) || '') + ' ' + ((song && song.artist) || '') + ' ' + ((song && song.album) || '')).toLowerCase();
  var qAsksDerivative = ctx.qAsksDerivative;
  var derivative = searchLooksLikeDerivative(raw);
  var artistMentioned = searchMentionsKnownArtist(q, song && song.artist);
  var originalArtists = canonicalOriginalArtistsForSearch(q, song);
  var originalArtistMatch = songArtistMatchesAny(song, originalArtists);
  var score = 0;
  if (name === nq) score += 90;
  else if (name.indexOf(nq) === 0) score += 55;
  else if (name.indexOf(nq) >= 0) score += 32;
  if (name && nq && nq.indexOf(name) >= 0) score += name.length >= 2 ? 68 : 18;
  if (originalArtistMatch && name && nq && (name === nq || nq.indexOf(name) >= 0 || name.indexOf(nq) >= 0)) score += 122;
  else if (!qAsksDerivative && originalArtists.length && name && nq && (name === nq || nq.indexOf(name) >= 0 || name.indexOf(nq) >= 0)) score -= 58;
  if (artistMentioned) score += 96;
  else if (artist && nq && nq.indexOf(artist) >= 0) score += 64;
  else if (artist && artist.indexOf(nq) >= 0) score += 22;
  if (artistMentioned && name && nq.indexOf(name) >= 0) score += 34;
  if (ctx.qJayChou && !artistMentioned) score -= 28;
  if (album && nq && (album.indexOf(nq) >= 0 || nq.indexOf(album) >= 0)) score += 8;
  if (songProviderKey(song) === 'netease') score += 6;
  if (songProviderKey(song) === 'qq') score += ctx.qPrefersQQ ? 48 : 4;
  if (songProviderKey(song) === 'kg') score += ctx.qPrefersKG ? 42 : 3;
  if (song && song.playable === false) score -= 12;
  if (!qAsksDerivative) {
    if (derivative) score -= artistMentioned ? 76 : 96;
    if (/(live|现场)/i.test(raw)) score -= artistMentioned ? 28 : 42;
    if (originalArtists.length && searchLooksLikeSameTitleCover(song, nq, name, album, raw, originalArtistMatch, sourceIndex)) score -= 46;
  }
  score -= (sourceIndex || 0) * 0.75;
  return score;
}
function resetSearchPaging() {
  searchPagingState = { query: '', mode: '', page: 0, hasMore: false, loading: false };
}
function searchResultKeyWithPage(q, mode, page) {
  return searchResultKey(q, mode) + '|p=' + (page || 1);
}
function mergeSongSearchResults(neteaseSongs, qqSongs, limit, q, kgSongs, balanced) {
  var ctx = buildSearchScoreContext(q);
  var out = [];
  var seen = {};
  var neList = neteaseSongs || [];
  var qqList = qqSongs || [];
  var kgList = kgSongs || [];
  function songKey(song) {
    return songProviderKey(song) + ':' + (song.hash || song.mid || song.id || (song.name + '|' + song.artist));
  }
  function push(song, sourceIndex) {
    if (!song || !song.name) return;
    var key = songKey(song);
    if (seen[key]) return;
    seen[key] = true;
    song._searchScore = scoreSongSearchResult(song, q, sourceIndex, ctx);
    out.push(song);
  }
  if (balanced) {
    neList.forEach(function(s, i){ push(s, i); });
    qqList.forEach(function(s, i){ push(s, neList.length + i); });
    kgList.forEach(function(s, i){ push(s, neList.length + qqList.length + i); });
  } else {
    neList.forEach(function(s, i){ push(s, i); });
    qqList.forEach(function(s, i){ push(s, i); });
    kgList.forEach(function(s, i){ push(s, i); });
  }
  out.sort(function(a, b){ return (b._searchScore || 0) - (a._searchScore || 0); });
  if (!balanced) return out.slice(0, limit);
  // Reserve slots so KuGou isn't wiped when NE/QQ scores dominate.
  var reserve = Math.max(2, Math.floor(limit / 3));
  var byProvider = { netease: [], qq: [], kg: [] };
  out.forEach(function(song) {
    var p = songProviderKey(song);
    if (byProvider[p]) byProvider[p].push(song);
  });
  var picked = [];
  var used = {};
  ['netease', 'qq', 'kg'].forEach(function(p) {
    byProvider[p].slice(0, reserve).forEach(function(song) {
      var key = songKey(song);
      if (used[key]) return;
      used[key] = true;
      picked.push(song);
    });
  });
  out.forEach(function(song) {
    if (picked.length >= limit) return;
    var key = songKey(song);
    if (used[key]) return;
    used[key] = true;
    picked.push(song);
  });
  picked.sort(function(a, b){ return (b._searchScore || 0) - (a._searchScore || 0); });
  return picked.slice(0, limit);
}
async function fetchMusicSearchPage(q, mode, page) {
  page = Math.max(1, Number(page) || 1);
  var pageSize = SEARCH_PAGE_SIZE;
  var cacheKey = searchResultKeyWithPage(q, mode, page);
  var cached = searchResultCache[cacheKey];
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return { songs: cached.songs.slice(), hasMore: !!cached.hasMore };
  }
  var offset = (page - 1) * pageSize;
  var hasMore = false;
  var songs = [];
  if (mode === 'qq') {
    var qqOnly = await searchApiJson('/api/qq/search?keywords=' + encodeURIComponent(q) + '&limit=' + pageSize + '&page=' + page);
    songs = (qqOnly.songs || []).slice();
    hasMore = !!(qqOnly && qqOnly.hasMore);
    if (!hasMore && songs.length >= pageSize) hasMore = true;
  } else if (mode === 'kg') {
    var kgOnly = await searchApiJson('/api/kg/search?keywords=' + encodeURIComponent(q) + '&limit=' + pageSize + '&page=' + page);
    songs = (kgOnly.songs || []).slice();
    hasMore = !!(kgOnly && kgOnly.hasMore);
    if (!hasMore && songs.length >= pageSize) hasMore = true;
  } else if (mode === 'netease') {
    var neOnly = await searchApiJson('/api/search?keywords=' + encodeURIComponent(q) + '&limit=' + pageSize + '&offset=' + offset);
    if (neOnly && neOnly.error) console.warn('Netease search error:', neOnly.error);
    songs = (neOnly.songs || []).slice();
    hasMore = !!(neOnly && neOnly.hasMore);
    if (!hasMore && songs.length >= pageSize) hasMore = true;
  } else {
    var per = Math.max(8, pageSize);
    var side = Math.max(4, Math.ceil(pageSize / 3));
    var neRes = await searchProviderJson('/api/search?keywords=' + encodeURIComponent(q) + '&limit=' + per + '&offset=' + offset, SEARCH_NE_TIMEOUT_MS);
    var neteaseSongs = (neRes && neRes.songs) || [];
    if (neRes && neRes.error) console.warn('Netease search error:', neRes.error);
    var qqRes = await searchProviderJson('/api/qq/search?keywords=' + encodeURIComponent(q) + '&limit=' + side + '&page=' + page, SEARCH_SIDE_TIMEOUT_MS);
    var kgRes = await searchProviderJson('/api/kg/search?keywords=' + encodeURIComponent(q) + '&limit=' + side + '&page=' + page, SEARCH_SIDE_TIMEOUT_MS);
    var qqSongsMerged = (qqRes && qqRes.songs) || [];
    var kgSongsMerged = (kgRes && kgRes.songs) || [];
    songs = mergeSongSearchResults(neteaseSongs, qqSongsMerged, pageSize, q, kgSongsMerged, true);
    hasMore = neteaseSongs.length >= per || qqSongsMerged.length >= side || kgSongsMerged.length >= side;
  }
  if (songs.length) searchResultCache[cacheKey] = { at: Date.now(), songs: songs.slice(), hasMore: hasMore };
  return { songs: songs, hasMore: hasMore };
}
async function fetchMusicSearchResults(q, mode, onPartial) {
  if (searchPagingState.query !== q || searchPagingState.mode !== mode) resetSearchPaging();
  searchPagingState.query = q;
  searchPagingState.mode = mode;
  searchPagingState.page = 1;
  if (mode === 'song') {
    var neteaseSongs = [];
    var qqSongsMerged = [];
    var kgSongsMerged = [];
    var per = Math.max(8, SEARCH_PAGE_SIZE);
    var side = Math.max(4, Math.ceil(SEARCH_PAGE_SIZE / 3));
    var searchGen = searchRequestSeq;
    function emitAllPartial() {
      if (typeof onPartial !== 'function') return;
      if (searchGen !== searchRequestSeq) return;
      var partial = mergeSongSearchResults(neteaseSongs, qqSongsMerged, SEARCH_PAGE_SIZE, q, kgSongsMerged, true);
      if (partial.length) onPartial(partial, false);
    }
    function finishCache() {
      if (searchGen !== searchRequestSeq) return [];
      var mergedNow = mergeSongSearchResults(neteaseSongs, qqSongsMerged, SEARCH_PAGE_SIZE, q, kgSongsMerged, true);
      searchPagingState.hasMore = neteaseSongs.length >= per || qqSongsMerged.length >= side || kgSongsMerged.length >= side;
      if (mergedNow.length) {
        searchResultCache[searchResultKeyWithPage(q, mode, 1)] = {
          at: Date.now(),
          songs: mergedNow.slice(),
          hasMore: searchPagingState.hasMore
        };
      }
      return mergedNow;
    }
    /* Identical NE request to the NE tab — do not parallelize with QQ/KG (Bridge congestion) */
    try {
      var neRes = await searchApiJson('/api/search?keywords=' + encodeURIComponent(q) + '&limit=' + per + '&offset=0');
      if (searchGen !== searchRequestSeq) return [];
      neteaseSongs = (neRes && neRes.songs) || [];
      if (neRes && neRes.error) console.warn('Netease search error:', neRes.error);
    } catch (err) {
      if (searchGen !== searchRequestSeq) return [];
      console.warn('Netease search failed:', err);
      neteaseSongs = [];
    }
    if (neteaseSongs.length) emitAllPartial();
    var merged = finishCache();
    /* Enrich QQ then KG sequentially after UI already shows NE */
    (async function enrichAggregateSides() {
      try {
        var qqRes = await searchProviderJson(
          '/api/qq/search?keywords=' + encodeURIComponent(q) + '&limit=' + side + '&page=1',
          SEARCH_SIDE_TIMEOUT_MS
        );
        if (searchGen !== searchRequestSeq) return;
        qqSongsMerged = (qqRes && qqRes.songs) || [];
        if (qqRes && qqRes.timedOut) console.warn('QQ search timed out');
        if (qqSongsMerged.length) emitAllPartial();
        var kgRes = await searchProviderJson(
          '/api/kg/search?keywords=' + encodeURIComponent(q) + '&limit=' + side + '&page=1',
          SEARCH_SIDE_TIMEOUT_MS
        );
        if (searchGen !== searchRequestSeq) return;
        kgSongsMerged = (kgRes && kgRes.songs) || [];
        if (kgRes && kgRes.timedOut) console.warn('KuGou search timed out');
        finishCache();
        if (qqSongsMerged.length || kgSongsMerged.length) emitAllPartial();
      } catch (err) {
        console.warn('Aggregate side search failed:', err);
      }
    })();
    return merged;
  }
  var pageResult = await fetchMusicSearchPage(q, mode, 1);
  searchPagingState.hasMore = pageResult.hasMore;
  return pageResult.songs;
}
function buildSearchResultRowHtml(s, i) {
  var vipTag = songVipTagHtml(s);
  var sourceTag = songSourceTagHtml(s);
  var sourceClass = songProviderKey(s) + '-source';
  var playing = isSearchResultPlaying(s);
  var playBadge = playing ? '<span class="search-play-badge">播放中</span>' : '';
  var durationText = searchResultDurationText(s);
  var thumb = songCoverSrc(s, 80);
  var imgTag = thumb
    ? '<img src="' + thumb + '" data-cover-url="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="mineradioRetryCoverImg(this)">'
    : '<div style="width:42px;height:42px;border-radius:8px;background:rgba(255,255,255,0.06);flex-shrink:0"></div>';
  return '<div class="search-result ' + sourceClass + (playing ? ' playing' : '') + '" data-search-index="' + i + '">' +
    '<span class="search-result-index">' + (i + 1) + '</span>' +
    '<div class="search-result-main" onclick="playSearchResult(' + i + ')">' +
      imgTag +
      '<div class="search-result-info">' +
        '<div class="search-result-title">' + playBadge + escHtml(s.name) + sourceTag + vipTag + '</div>' +
        '<div class="search-result-meta">' + searchResultMetaHtml(s, i) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="search-result-side">' +
      (durationText ? ('<span class="search-result-duration">' + durationText + '</span>') : '') +
      '<div class="search-result-actions">' +
        '<button class="song-action-btn' + (isSongLiked(s) ? ' liked' : '') + '" data-like-index="' + i + '" title="' + (isSongLiked(s) ? '取消红心' : '红心喜欢') + '" onclick="event.stopPropagation();toggleLikeSearchResult(' + i + ')">' + heartIconSvg() + '</button>' +
        '<button class="song-action-btn" title="收藏到歌单" onclick="event.stopPropagation();collectSearchResult(' + i + ')">' + playlistPlusIconSvg() + '</button>' +
        '<button class="add-btn" title="下一首播放" onclick="event.stopPropagation();queueSearchResult(' + i + ')">+</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}
function updateSearchLoadMoreButton() {
  if (!$results) return;
  var btn = $results.querySelector('.search-load-more');
  if (searchPagingState.hasMore) {
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fx-mini-btn ghost search-load-more';
      btn.onclick = function(){ loadMoreSearchResults(); };
      $results.appendChild(btn);
    }
    btn.disabled = !!searchPagingState.loading;
    btn.textContent = searchPagingState.loading ? '正在加载...' : ('加载更多 · 已显示 ' + playlist.length + ' 条');
  } else if (btn) {
    btn.remove();
  }
}
function appendSearchResultRows(songs, startIndex) {
  if (!$results || startIndex >= songs.length) return;
  var wrap = document.createElement('div');
  var html = '';
  for (var i = startIndex; i < songs.length; i++) html += buildSearchResultRowHtml(songs[i], i);
  wrap.innerHTML = html;
  var loadMoreBtn = $results.querySelector('.search-load-more');
  var frag = document.createDocumentFragment();
  while (wrap.firstChild) frag.appendChild(wrap.firstChild);
  if (loadMoreBtn) $results.insertBefore(frag, loadMoreBtn);
  else $results.appendChild(frag);
  updateSearchResultsHead(songs.length);
  updateSearchLoadMoreButton();
  if (window.gsap && songs.length > startIndex) {
    var added = songs.length - startIndex;
    animateListItems($results, '.search-result:nth-last-child(n+' + (added + (loadMoreBtn ? 1 : 0)) + ')', { x: 0, y: 8, stagger: 0.01, duration: 0.16, limit: added });
  }
}
function renderSongSearchResults(songs, opts) {
  opts = opts || {};
  var q = searchPagingState.query || ($input && $input.value.trim()) || '';
  if (opts.softUpdate && playlist.length && songs.length === playlist.length) {
    playlist = songs || [];
    updateSearchResultsHead(playlist.length, q);
    updateSearchLoadMoreButton();
    refreshSearchResultPlayingState();
    if (!opts.skipLikeSync) scheduleUiWarmTask(function(){ syncLikeStatusForSongs(playlist, { limit: 10, searchContext: true }); }, mineradioUsesWebMediaBridge() ? 720 : 320);
    return;
  }
  if (opts.incremental && playlist.length && songs.length > playlist.length) {
    var prevLen = playlist.length;
    playlist = songs || [];
    updateSearchResultsHead(playlist.length, q);
    appendSearchResultRows(playlist, prevLen);
    if (!opts.skipLikeSync) scheduleUiWarmTask(function(){ syncLikeStatusForSongs(playlist.slice(prevLen), { limit: 8, searchContext: true }); }, mineradioUsesWebMediaBridge() ? 720 : 320);
    return;
  }
  playlist = songs || [];
  var html = buildSearchResultsHeadHtml(playlist.length, q);
  html += playlist.map(function(s, i){ return buildSearchResultRowHtml(s, i); }).join('');
  if (searchPagingState.hasMore) {
    html += '<button type="button" class="fx-mini-btn ghost search-load-more" onclick="loadMoreSearchResults()" ' + (searchPagingState.loading ? 'disabled' : '') + '>' +
      (searchPagingState.loading ? '正在加载...' : ('加载更多 · 已显示 ' + playlist.length + ' 条')) +
    '</button>';
  }
  $results.innerHTML = html;
  $results.classList.add('show');
  if (!opts.skipLikeSync) {
    scheduleUiWarmTask(function(){ syncLikeStatusForSongs(playlist, { limit: 10, searchContext: true }); }, mineradioUsesWebMediaBridge() ? 720 : 320);
  }
  if (!opts.skipAnimate && window.gsap && !mineradioUsesWebMediaBridge()) {
    animateListItems($results, '.search-result', { x: 0, y: 6, stagger: 0.012, duration: 0.18, limit: SEARCH_PAGE_SIZE });
  }
  refreshSearchResultPlayingState();
}
async function loadMoreSearchResults() {
  if (searchPagingState.loading || !searchPagingState.hasMore) return;
  var q = searchPagingState.query || ($input && $input.value.trim()) || '';
  var mode = searchPagingState.mode || searchMode;
  if (!q) return;
  var requestSeq = searchRequestSeq;
  var prevLen = playlist.length;
  searchPagingState.loading = true;
  updateSearchLoadMoreButton();
  try {
    var nextPage = (searchPagingState.page || 1) + 1;
    var pageResult = await fetchMusicSearchPage(q, mode, nextPage);
    if (requestSeq !== searchRequestSeq || $input.value.trim() !== q) return;
    var seen = {};
    playlist.forEach(function(song){
      var key = songProviderKey(song) + ':' + (song.hash || song.mid || song.id || (song.name + '|' + song.artist));
      seen[key] = true;
    });
    (pageResult.songs || []).forEach(function(song){
      var key = songProviderKey(song) + ':' + (song.hash || song.mid || song.id || (song.name + '|' + song.artist));
      if (seen[key]) return;
      seen[key] = true;
      playlist.push(song);
    });
    searchPagingState.page = nextPage;
    searchPagingState.hasMore = !!pageResult.hasMore;
    if (playlist.length > prevLen) appendSearchResultRows(playlist, prevLen);
    else updateSearchLoadMoreButton();
  } catch (err) {
    console.warn('[SearchLoadMore]', err);
    searchPagingState.loading = false;
    updateSearchLoadMoreButton();
  } finally {
    searchPagingState.loading = false;
    updateSearchLoadMoreButton();
  }
}

function searchResultsStillLoading() {
  if (!$results) return false;
  var text = String($results.textContent || '');
  return /正在搜索/.test(text);
}
async function doSearch(q, opts) {
  opts = opts || {};
  q = String(q || '').trim();
  if (!q) {
    if (searchMode === 'podcast') loadPodcastHot();
    else renderSearchHistory();
    return;
  }
  if (searchMode === 'podcast') {
    doPodcastSearch(q);
    return;
  }
  beginSearchRequest();
  var requestSeq = ++searchRequestSeq;
  try {
    var mode = searchMode;
    var partialRendered = false;
    var partialLen = 0;
    var songs = await fetchMusicSearchResults(q, mode, function(partial){
      if (requestSeq !== searchRequestSeq || $input.value.trim() !== q || !partial || !partial.length) return;
      partialRendered = true;
      renderSongSearchResults(partial, { skipLikeSync: true, skipAnimate: true, incremental: partialLen > 0 && partial.length > partialLen });
      partialLen = partial.length;
    });
    if (requestSeq !== searchRequestSeq || $input.value.trim() !== q) return;
    if (!songs.length) {
      if (partialRendered) return;
      playlist = [];
      searchLastResultQuery = '';
      $results.innerHTML = '<div class="search-empty">没有找到相关歌曲</div>';
      $results.classList.add('show');
      return;
    }
    searchLastResultQuery = searchResultKey(q, mode);
    if (opts.remember) rememberSearchQuery(q);
    if (!partialRendered) renderSongSearchResults(songs);
    else renderSongSearchResults(songs, { skipAnimate: true, softUpdate: songs.length === partialLen, skipLikeSync: songs.length === partialLen });
    scheduleUiWarmTask(function(){ prefetchSearchNextPage(q, mode); }, 480);
    if (opts.autoPlayFirst) playSearchResult(0);
  } catch (err) {
    if (err && (err.name === 'AbortError' || String(err.message || '').indexOf('aborted') >= 0)) return;
    console.error('Search:', err);
    if (requestSeq === searchRequestSeq && searchResultsStillLoading()) {
      $results.innerHTML = '<div class="search-empty">搜索失败，请重试</div>';
      $results.classList.add('show');
    }
  } finally {
    if (requestSeq === searchRequestSeq && searchResultsStillLoading() && !(playlist && playlist.length)) {
      $results.innerHTML = '<div class="search-empty">没有找到相关歌曲</div>';
      $results.classList.add('show');
    }
  }
}

