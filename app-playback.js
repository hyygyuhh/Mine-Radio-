'use strict';

// ============================================================
//  音频上下文 & 频谱分析
// ============================================================
function initAudio() {
  if (!canUsePlaybackAudioGraph()) {
    audioReady = true;
    return;
  }
  // After seamless element swap, analyser may still exist while source was cleared.
  if (analyser && source) {
    audioReady = true;
    return;
  }
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audio && !source) {
      if (analyser) { try { analyser.disconnect(); } catch (_) {} analyser = null; }
      if (beatAnalyser) { try { beatAnalyser.disconnect(); } catch (_) {} beatAnalyser = null; }
      if (gainNode) { try { gainNode.disconnect(); } catch (_) {} gainNode = null; }
      source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      beatAnalyser = audioCtx.createAnalyser();
      gainNode = audioCtx.createGain();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.58;
      beatAnalyser.fftSize = BEAT_FFT_SIZE;
      beatAnalyser.smoothingTimeConstant = 0.10;
      source.connect(analyser);
      source.connect(beatAnalyser);
      analyser.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      applyVolumeToAudio();
      frequencyData.fill(0);
      beatFrequencyData.fill(0);
      beatTimeDomainData.fill(128);
      resetRealtimeBeatEngine();
    }
    audioReady = true;
  } catch (err) {
    console.warn('[InitAudio]', err);
    audioReady = true;
  }
}
function waitForPlaybackAudioReady(media, timeoutMs) {
  if (!media || media.readyState >= 2) return Promise.resolve();
  return new Promise(function(resolve) {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      resolve();
    }
    var timer = setTimeout(finish, timeoutMs || 8000);
    media.addEventListener('canplay', function(){ clearTimeout(timer); finish(); }, { once: true });
    media.addEventListener('error', function(){ clearTimeout(timer); finish(); }, { once: true });
  });
}
function resumeAudioAnalysis() {
  if (audioCtx && audioCtx.state === 'suspended') return audioCtx.resume().catch(function(e){ console.warn('audio context resume failed:', e); });
  return Promise.resolve();
}

function ensureUiSfxContext() {
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!uiSfxCtx || uiSfxCtx.state === 'closed') uiSfxCtx = new AudioContextCtor();
  if (uiSfxCtx.state === 'suspended' && uiSfxCtx.resume) uiSfxCtx.resume().catch(function(){});
  return uiSfxCtx;
}

function playShelfSelectTick(direction, variant) {
  var nowMs = performance.now();
  var minGap = variant === 'row' ? 36 : 42;
  if (nowMs - lastShelfSelectSfxAt < minGap) return;
  var ctx = ensureUiSfxContext();
  if (!ctx) return;
  lastShelfSelectSfxAt = nowMs;
  var dir = direction < 0 ? -1 : 1;
  var pitch = dir > 0 ? 1.035 : 0.965;
  var rowScale = variant === 'row' ? 0.74 : 1.0;
  var volumeScale = 0.38 + Math.max(0, Math.min(1, targetVolume == null ? 0.65 : targetVolume)) * 0.62;
  var t = ctx.currentTime + 0.002;
  var out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(0.058 * rowScale * volumeScale, t + 0.002);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 0.082);
  out.connect(ctx.destination);

  var sampleRate = ctx.sampleRate || 44100;
  var len = Math.max(1, Math.floor(sampleRate * 0.034));
  var buf = ctx.createBuffer(1, len, sampleRate);
  var data = buf.getChannelData(0);
  for (var i = 0; i < len; i++) {
    var e = Math.pow(1 - i / len, 4.2);
    data[i] = (Math.random() * 2 - 1) * e;
  }
  var noise = ctx.createBufferSource();
  noise.buffer = buf;
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(4200 * pitch, t);
  var bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(8400 * pitch, t);
  bp.Q.setValueAtTime(7.2, t);
  var ng = ctx.createGain();
  ng.gain.setValueAtTime(0.56, t);
  noise.connect(hp);
  hp.connect(bp);
  bp.connect(ng);
  ng.connect(out);
  noise.start(t);
  noise.stop(t + 0.040);

  function clickOsc(type, freq, delay, dur, gainValue, bend) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    var start = t + delay;
    var end = start + dur;
    osc.type = type;
    osc.frequency.setValueAtTime(freq * pitch, start);
    osc.frequency.exponentialRampToValueAtTime(freq * pitch * (bend || 0.72), end);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gainValue, start + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(out);
    osc.start(start);
    osc.stop(end + 0.004);
  }

  clickOsc('triangle', 720, 0.000, 0.030, 0.18, 0.70);
  clickOsc('square', 2180, 0.004, 0.022, 0.30, 0.86);
  clickOsc('triangle', 4200, 0.011, 0.018, 0.18, 0.94);
  clickOsc('square', 7100, 0.018, 0.012, 0.070, 0.98);
  setTimeout(function(){
    try { out.disconnect(); } catch (_) {}
  }, 160);
}

function clearAudioFadeTimers() {
  if (audioFadeTimer) {
    clearTimeout(audioFadeTimer);
    audioFadeTimer = null;
  }
  if (audioElementFadeFrame) {
    cancelAnimationFrame(audioElementFadeFrame);
    audioElementFadeFrame = 0;
  }
}
function currentAudioOutputGain() {
  if (gainNode && gainNode.gain && isFinite(gainNode.gain.value)) return clampRange(Number(gainNode.gain.value), 0, 1);
  if (audio && isFinite(audio.volume)) return clampRange(Number(audio.volume), 0, 1);
  return clampRange(targetVolume, 0, 1);
}
function audioSilentFloor() {
  return targetVolume > 0.001 ? AUDIO_SILENCE_GAIN : 0;
}
function normalizeAudioFadeTarget(value) {
  value = clampRange(Number(value) || 0, 0, 1);
  return value <= 0.001 ? audioSilentFloor() : value;
}
function holdAudioOutputGain(now) {
  var current = currentAudioOutputGain();
  if (!gainNode || !audioCtx || !gainNode.gain) return current;
  var param = gainNode.gain;
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
      return currentAudioOutputGain();
    }
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
  } catch (e) {
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
    } catch (_) {}
  }
  return current;
}
function setAudioOutputGainImmediate(value) {
  value = normalizeAudioFadeTarget(value);
  clearAudioFadeTimers();
  if (gainNode && audioCtx) {
    var now = audioCtx.currentTime || 0;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(value, now);
  } else if (audio) {
    audio.volume = value;
  }
}
function rampAudioOutputGain(value, durationMs) {
  value = normalizeAudioFadeTarget(value);
  durationMs = Math.max(0, Number(durationMs) || 0);
  clearAudioFadeTimers();
  var serial = audioFadeSerial;
  if (gainNode && audioCtx) {
    var now = audioCtx.currentTime || 0;
    holdAudioOutputGain(now);
    if (durationMs <= 0) {
      gainNode.gain.setValueAtTime(value, now);
      return;
    }
    gainNode.gain.linearRampToValueAtTime(value, now + durationMs / 1000);
    return;
  }
  if (!audio) return;
  var from = currentAudioOutputGain();
  var started = performance.now();
  function tickAudioFade(nowMs) {
    if (serial !== audioFadeSerial || !audio) return;
    var t = durationMs ? clampRange((nowMs - started) / durationMs, 0, 1) : 1;
    var eased = 1 - Math.pow(1 - t, 3);
    audio.volume = from + (value - from) * eased;
    if (t < 1) audioElementFadeFrame = requestAnimationFrame(tickAudioFade);
    else audioElementFadeFrame = 0;
  }
  audioElementFadeFrame = requestAnimationFrame(tickAudioFade);
}
function preparePlaybackFadeIn() {
  audioFadeSerial++;
  setAudioOutputGainImmediate(0);
}
function startPlaybackFadeIn() {
  audioFadeSerial++;
  if (targetVolume <= 0.001) {
    setAudioOutputGainImmediate(0);
    return;
  }
  rampAudioOutputGain(targetVolume, AUDIO_FADE_IN_MS);
}
function restorePlaybackGain() {
  audioFadeSerial++;
  setAudioOutputGainImmediate(targetVolume);
}
function fadeOutAndPauseAudio() {
  if (!audio || audio.paused) return Promise.resolve(false);
  markPlaybackPaused();
  if (mineradioUsesWebMediaBridge()) {
    clearAudioFadeTimers();
    try { audio.pause(); } catch (pauseErr) { console.warn('[TogglePlayPause]', pauseErr); }
    return Promise.resolve(true);
  }
  var serial = ++audioFadeSerial;
  rampAudioOutputGain(0, AUDIO_FADE_OUT_MS);
  return new Promise(function(resolve) {
    audioFadeTimer = setTimeout(function(){
      audioFadeTimer = null;
      if (serial !== audioFadeSerial || !audio) {
        resolve(false);
        return;
      }
      try { audio.pause(); } catch (pauseErr) { console.warn('[TogglePlayPause]', pauseErr); }
      setAudioOutputGainImmediate(0);
      resolve(true);
    }, AUDIO_FADE_OUT_MS + 80);
  });
}

function applyVolumeToAudio() {
  if (audio) {
    audio.muted = false;
    audio.volume = gainNode ? 1 : targetVolume;
  }
  if (gainNode && audioCtx) {
    var now = audioCtx.currentTime || 0;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setTargetAtTime(targetVolume, now, 0.025);
  }
}

function updateVolumeUi() {
  var slider = document.getElementById('volume-slider');
  var value = document.getElementById('volume-value');
  var icon = document.getElementById('volume-icon');
  var wrap = document.getElementById('volume-control');
  var pct = Math.round(targetVolume * 100);
  if (slider && Math.abs(parseFloat(slider.value) - targetVolume) > 0.001) slider.value = targetVolume;
  if (value) value.textContent = pct + '%';
  if (wrap) wrap.classList.toggle('muted', targetVolume <= 0.01);
  if (icon) {
    icon.innerHTML = targetVolume <= 0.01
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="17" y1="9" x2="22" y2="14"/><line x1="22" y1="9" x2="17" y2="14"/>'
      : targetVolume < 0.45
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 10.5a2 2 0 0 1 0 3"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>';
  }
}

function setVolume(value, silent) {
  var next = Math.max(0, Math.min(1, Number(value) || 0));
  targetVolume = next;
  if (next > 0.01) lastNonZeroVolume = next;
  try { localStorage.setItem('apex-player-volume', String(next)); } catch (e) {}
  applyVolumeToAudio();
  updateVolumeUi();
  if (!silent) showToast('音量 ' + Math.round(next * 100) + '%');
}
function adjustVolumeByKeyboard(delta) {
  var step = Number(delta) || 0;
  if (!step) return;
  setVolume(clampRange(targetVolume + step, 0, 1), false);
}

function toggleVolumePanel(e) {
  if (e) e.stopPropagation();
  var wrap = document.getElementById('volume-control');
  if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
  if (wrap) wrap.classList.toggle('open');
}

function toggleMute() {
  setVolume(targetVolume > 0.01 ? 0 : (lastNonZeroVolume || 0.8));
}

function bindVolumeControls() {
  var slider = document.getElementById('volume-slider');
  var btn = document.getElementById('volume-btn');
  var wrap = document.getElementById('volume-control');
  function keepVolumePanelOpen() {
    if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
    if (wrap) wrap.classList.add('open');
  }
  function closeVolumePanelSoon() {
    if (volumeCloseTimer) clearTimeout(volumeCloseTimer);
    volumeCloseTimer = setTimeout(function(){
      volumeCloseTimer = null;
      if (wrap) wrap.classList.remove('open');
    }, 520);
  }
  if (wrap) {
    wrap.addEventListener('mouseenter', keepVolumePanelOpen);
    wrap.addEventListener('mouseleave', closeVolumePanelSoon);
  }
  if (slider) {
    slider.addEventListener('input', function(){ setVolume(slider.value, true); });
    slider.addEventListener('focus', keepVolumePanelOpen);
    slider.addEventListener('blur', closeVolumePanelSoon);
    slider.addEventListener('change', function(){ showToast('音量 ' + Math.round(targetVolume * 100) + '%'); });
  }
  if (btn) {
    btn.addEventListener('dblclick', function(e){ e.stopPropagation(); toggleMute(); });
  }
  document.addEventListener('click', function(e){
    if (!wrap) return;
    if (!wrap.contains(e.target)) {
      if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
      wrap.classList.remove('open');
    }
  });
  updateVolumeUi();
  applyVolumeToAudio();
}

// ============================================================
//  播放队列
// ============================================================
function queueItemKey(song) {
  if (!song) return '';
  if (song.provider === 'kg' || song.source === 'kg' || song.type === 'kg') return 'kg:' + (song.hash || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.localKey) return 'local:' + song.localKey;
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return String(song.name || '') + '|' + String(song.artist || '');
}
function queueSong(song, opts) {
  opts = opts || {};
  if (!song) return -1;
  var cloned = cloneSong(song);
  var insertAt = playQueue.length;
  if (opts.position === 'next') {
    var key = queueItemKey(cloned);
    var existing = -1;
    if (key) {
      for (var i = 0; i < playQueue.length; i++) {
        if (queueItemKey(playQueue[i]) === key) { existing = i; break; }
      }
    }
    if (existing === currentIdx) return currentIdx;
    if (existing >= 0) {
      cloned = playQueue.splice(existing, 1)[0];
      if (currentIdx >= 0 && existing < currentIdx) currentIdx -= 1;
    }
    var hasCurrent = currentIdx >= 0 && currentIdx < playQueue.length;
    insertAt = hasCurrent ? Math.min(playQueue.length, currentIdx + 1) : playQueue.length;
    playQueue.splice(insertAt, 0, cloned);
  } else {
    playQueue.push(cloned);
    insertAt = playQueue.length - 1;
  }
  safeRenderQueuePanel('queue-song');
  safeShelfRebuild('queue-song');
  if (currentIdx >= 0) prefetchAdjacentPlaybackSources(currentIdx);
  return insertAt;
}
function queueSongNext(song) {
  return queueSong(song, { position: 'next' });
}
function queueSearchResult(i) {
  var song = playlist[i]; if (!song) return;
  queueSongNext(song);
  showToast('已设为下一首: ' + song.name);
}
function queueDetailSongNext(song) {
  if (!song || song.type === 'podcast-radio') return;
  queueSongNext(song);
  showToast('已设为下一首: ' + (song.name || ''));
}
function queueIndexNext(i) {
  i = Number(i);
  if (!isFinite(i) || i < 0 || i >= playQueue.length) return;
  var song = playQueue[i];
  queueSongNext(song);
  showToast('已设为下一首: ' + (song && song.name ? song.name : ''));
}
function openQueueArtist(i) {
  var song = playQueue && playQueue[i];
  if (song) openArtistDetailForSong(song);
}
function moveQueueIndexToTop(idx) {
  idx = Number(idx);
  if (!isFinite(idx) || idx < 0 || idx >= playQueue.length) return -1;
  if (idx === 0) return 0;
  var item = playQueue.splice(idx, 1)[0];
  playQueue.unshift(item);
  if (currentIdx === idx) currentIdx = 0;
  else if (currentIdx >= 0 && currentIdx < idx) currentIdx += 1;
  return 0;
}
function playSearchResult(i) {
  var song = playlist[i]; if (!song) return;
  var typedQuery = String(($input && $input.value) || '').trim();
  if (typedQuery) rememberSearchQuery(typedQuery);
  else if (searchPagingState && searchPagingState.query) rememberSearchQuery(searchPagingState.query);
  primeWebPlaybackUnlockIfNeeded({});
  showLoading({ light: !!firstPlayDone });
  var urlFetchPromise = fetchPlaybackSourceData(song).catch(function(err){
    console.warn('[SearchPlayPrefetch]', err);
    return null;
  });
  prefetchPlaybackAudioForSong(song);
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!playQueue.length) { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  else {
    var matchIdx = -1;
    var targetKey = queueItemKey(song);
    for (var j = 0; j < playQueue.length; j++) if (queueItemKey(playQueue[j]) === targetKey) { matchIdx = j; break; }
    if (matchIdx >= 0) currentIdx = moveQueueIndexToTop(matchIdx);
    else { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  }
  $results.classList.remove('show');
  $input.value = ''; $input.blur();
  prefetchAdjacentPlaybackSources(currentIdx);
  playQueueAt(currentIdx, { fromSearch: true, urlFetchPromise: urlFetchPromise });
}
var firstPlayDone = false;

function playbackProviderLabel(song) {
  var key = songProviderKey(song);
  return key === 'qq' ? 'QQ 音乐' : (key === 'kg' ? '酷狗音乐' : '网易云');
}
function playbackLoginProvider(song) {
  var key = songProviderKey(song);
  return key === 'qq' ? 'qq' : (key === 'kg' ? 'kg' : 'netease');
}
function playbackRestrictionMessage(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  var category = data.reason || restriction.category || '';
  var provider = playbackProviderLabel(song);
  var message = data.message || restriction.message || '';
  if (!message) {
    if (category === 'login_required') message = provider + '需要登录后再尝试播放';
    else if (category === 'vip_required') message = provider + '歌曲需要会员权限';
    else if (category === 'paid_required') message = provider + '歌曲需要购买或更高权限';
    else if (category === 'trial_only') message = provider + '仅返回试听片段';
    else if (category === 'copyright_unavailable') message = provider + '版权暂不可播';
    else message = provider + '没有返回可播放地址';
  }
  if (category === 'login_required') return message + ' · 正在打开登录';
  if (category === 'copyright_unavailable' || category === 'url_unavailable') return message + ' · 可以试试另一个平台版本';
  return message;
}
function qqPlaybackRetryQualities(requestedQuality, resolvedLevel) {
  requestedQuality = normalizePlaybackQuality(requestedQuality || playbackQuality);
  resolvedLevel = String(resolvedLevel || '').toLowerCase();
  var pool = [];
  if (requestedQuality === 'jymaster' || requestedQuality === 'hires' || requestedQuality === 'lossless' || resolvedLevel === 'hires' || resolvedLevel === 'lossless') {
    pool = ['exhigh', 'standard'];
  } else if (requestedQuality === 'exhigh' || resolvedLevel === 'exhigh') {
    pool = ['standard'];
  }
  return pool.filter(function(q){ return q !== requestedQuality; });
}
async function retryQQPlaybackWithCompatibleQuality(song, idx, token, opts, data, requestedQuality) {
  opts = opts || {};
  var tried = Array.isArray(opts.qqQualityTried) ? opts.qqQualityTried.slice() : [];
  [requestedQuality, data && data.level].forEach(function(q){
    q = normalizePlaybackQuality(q || '');
    if (q && tried.indexOf(q) < 0) tried.push(q);
  });
  var candidates = qqPlaybackRetryQualities(requestedQuality, data && data.level).filter(function(q){ return tried.indexOf(q) < 0; });
  if (!candidates.length || token !== trackSwitchToken) return false;
  var nextQuality = candidates[0];
  var resolvedQuality = normalizePlaybackQuality(data && data.level);
  if (resolvedQuality === 'hires' || resolvedQuality === 'lossless') qqPlaybackQualityCeiling = nextQuality;
  showSourceFallbackNotice('QQ 音质自动兼容', '当前音质启动失败，正在切到 ' + playbackQualityLabel(nextQuality) + '。');
  await playQueueAt(idx, Object.assign({}, opts, {
    qualityOverride: nextQuality,
    qqQualityTried: tried,
  }));
  return true;
}
var sourceFallbackNoticeTimer = null;
function closeSourceFallbackNotice() {
  var notice = document.getElementById('source-fallback-notice');
  if (sourceFallbackNoticeTimer) { clearTimeout(sourceFallbackNoticeTimer); sourceFallbackNoticeTimer = null; }
  if (notice) notice.classList.remove('show');
}
function showSourceFallbackNotice(title, body) {
  var notice = document.getElementById('source-fallback-notice');
  var titleEl = document.getElementById('source-fallback-title');
  var bodyEl = document.getElementById('source-fallback-body');
  if (!notice || !titleEl || !bodyEl) return;
  titleEl.textContent = title || '自动换源';
  bodyEl.textContent = body || '';
  notice.classList.add('show');
  if (sourceFallbackNoticeTimer) clearTimeout(sourceFallbackNoticeTimer);
  sourceFallbackNoticeTimer = setTimeout(closeSourceFallbackNotice, 5000);
}
function normalizeMatchText(text) {
  return String(text || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|]+/g, '');
}
function artistNameParts(song) {
  var parts = [];
  if (song && Array.isArray(song.artists)) {
    song.artists.forEach(function(a){ if (a && a.name) parts.push(a.name); });
  }
  if (song && song.artist) {
    String(song.artist).split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i).forEach(function(name){
      if (name && name.trim()) parts.push(name.trim());
    });
  }
  return parts.map(normalizeMatchText).filter(Boolean);
}
function isSameTitleArtist(source, candidate) {
  if (!source || !candidate) return false;
  if (normalizeMatchText(source.name || source.title) !== normalizeMatchText(candidate.name || candidate.title)) return false;
  var a = artistNameParts(source);
  var b = artistNameParts(candidate);
  if (!a.length || !b.length) return false;
  return a.some(function(name){ return b.indexOf(name) >= 0; });
}
function alternatePlaybackProvider(song) {
  return songProviderKey(song) === 'qq' ? 'netease' : 'qq';
}
async function searchAlternatePlatformSong(song) {
  var target = alternatePlaybackProvider(song);
  var artist = artistNameParts(song)[0] || '';
  var query = [song.name || song.title || '', song.artist || artist].filter(Boolean).join(' ').trim();
  if (!query) return null;
  var url = target === 'qq'
    ? '/api/qq/search?keywords=' + encodeURIComponent(query) + '&limit=8'
    : '/api/search?keywords=' + encodeURIComponent(query) + '&limit=12';
  var data = await apiJson(url);
  var list = data && (data.songs || data.result || []);
  for (var i = 0; i < list.length; i++) {
    if (isSameTitleArtist(song, list[i])) return cloneSong(list[i]);
  }
  return null;
}
function markQueueItemPlaybackFailed(idx) {
  if (playQueue[idx]) playQueue[idx]._lastPlaybackFailAt = Date.now();
}
function nextUnblockedQueueIndex(idx) {
  var now = Date.now();
  for (var step = 1; step < playQueue.length; step++) {
    var nextIdx = (idx + step) % playQueue.length;
    var failedAt = Number(playQueue[nextIdx] && playQueue[nextIdx]._lastPlaybackFailAt) || 0;
    if (!failedAt || now - failedAt > 18000) return nextIdx;
  }
  return -1;
}
function skipFailedQueueItem(idx, token, message) {
  hideLoading();
  if (token !== trackSwitchToken) return;
  markQueueItemPlaybackFailed(idx);
  if (playQueue.length <= 1) {
    showSourceFallbackNotice('没有可跳过的下一首', message || '当前歌曲不可播放，队列里没有其他歌曲。');
    return;
  }
  var nextIdx = nextUnblockedQueueIndex(idx);
  if (nextIdx < 0) {
    showSourceFallbackNotice('队列暂时没有可播歌曲', '已尝试绕开受限歌曲，当前队列没有新的可播放项。');
    return;
  }
  showSourceFallbackNotice('已跳过受限歌曲', message || '未找到同名同歌手的另一个平台版本，正在播放下一首。');
  currentIdx = nextIdx;
  playQueueAt(nextIdx, { fallbackDepth: 0 });
}
async function tryAutoPlaybackFallback(song, data, idx, token, opts) {
  opts = opts || {};
  if (opts.fallbackDepth > 0) {
    skipFailedQueueItem(idx, token, '自动换源后的版本仍不可播，正在播放下一首。');
    return true;
  }
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return false;
  var restriction = (data && data.restriction) || {};
  var category = (data && data.reason) || restriction.category || '';
  var fromLabel = playbackProviderLabel(song);
  var targetLabel = alternatePlaybackProvider(song) === 'qq' ? 'QQ 音乐' : '网易云';
  showSourceFallbackNotice('正在自动换源', fromLabel + ' 当前不可播，正在查找 ' + targetLabel + ' 的同名同歌手版本。');
  try {
    var alternate = await searchAlternatePlatformSong(song);
    if (token !== trackSwitchToken) return true;
    if (!alternate) {
      if (category === 'login_required') return false;
      skipFailedQueueItem(idx, token, '没有找到同名同歌手的 ' + targetLabel + ' 版本，正在播放下一首。');
      return true;
    }
    alternate.autoFallbackFrom = songProviderKey(song);
    playQueue[idx] = hydrateCustomCover(alternate);
    safeRenderQueuePanel('source-fallback', { scrollCurrent: miniQueueOpen });
    safeShelfRebuild('source-fallback');
    showSourceFallbackNotice('已自动切换音源', (song.name || '当前歌曲') + ' 已从 ' + fromLabel + ' 切到 ' + targetLabel + '。');
    await playQueueAt(idx, { fallbackDepth: 1 });
    return true;
  } catch (e) {
    if (token !== trackSwitchToken) return true;
    skipFailedQueueItem(idx, token, '自动换源搜索失败，正在播放下一首。');
    return true;
  }
}
function handlePlaybackUnavailable(song, data) {
  hideLoading();
  forcePlaybackControlsInteractive();
  var provider = playbackLoginProvider(song);
  var restriction = (data && data.restriction) || {};
  var category = (data && data.reason) || restriction.category || '';
  showToast(playbackRestrictionMessage(song, data));
  if (category === 'login_required') {
    setTimeout(function(){
      var modal = document.getElementById('login-modal');
      if (!modal || modal.classList.contains('show')) return;
      openProviderLogin(provider);
    }, 520);
  }
}

function pauseCurrentAudioForTrackSwitch() {
  playToggleBusy = false;
  if (!audio) return;
  try {
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio.onended = null;
    audio.pause();
  } catch (e) {}
  playing = false;
  setPlayIcon(false);
  syncPlaybackStateFromAudioEvent('track-switch');
}

var DEFAULT_PAGE_TITLE = 'Mineradio — 免费网页版在线听歌';
var mediaSessionActionsBound = false;
function updateNowPlayingPresentation(song) {
  song = song || (playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null);
  var isPlaying = !!(audio && audio.src && !audio.paused && !audio.ended);
  try {
    if (song && (song.name || song.title)) {
      var label = String(song.name || song.title || '');
      var artist = String(song.artist || '');
      document.title = artist ? (label + ' · ' + artist + ' · Mineradio') : (label + ' · Mineradio');
    } else {
      document.title = DEFAULT_PAGE_TITLE;
    }
  } catch (_) {}
  if (!('mediaSession' in navigator)) return;
  try {
    if (!song) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    var artwork = [];
    var cover = '';
    try {
      cover = (typeof resolveSongCoverUrl === 'function' ? resolveSongCoverUrl(song, 300) : '') || song.cover || '';
    } catch (_) {}
    if (cover && /^https?:\/\//i.test(cover)) {
      artwork = [
        { src: cover, sizes: '300x300', type: 'image/jpeg' },
        { src: cover, sizes: '512x512', type: 'image/jpeg' }
      ];
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: String(song.name || song.title || 'Mineradio'),
      artist: String(song.artist || 'Mineradio'),
      album: String(song.album || (song.al && song.al.name) || 'Mineradio'),
      artwork: artwork
    });
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    if (!mediaSessionActionsBound) {
      mediaSessionActionsBound = true;
      try { navigator.mediaSession.setActionHandler('play', function(){ togglePlay(); }); } catch (_) {}
      try { navigator.mediaSession.setActionHandler('pause', function(){ togglePlay(); }); } catch (_) {}
      try { navigator.mediaSession.setActionHandler('previoustrack', function(){ prevTrack(); }); } catch (_) {}
      try { navigator.mediaSession.setActionHandler('nexttrack', function(){ nextTrack(); }); } catch (_) {}
    }
  } catch (_) {}
}
function syncPlaybackStateFromAudioEvent(reason) {
  var isPlaying = !!(audio && audio.src && !audio.paused && !audio.ended);
  playing = isPlaying;
  setPlayIcon(isPlaying);
  if (!isPlaying) hideLoading();
  if (reason === 'play' || reason === 'playing') switchPlaybackVisualToEmily();
  forcePlaybackControlsInteractive();
  try {
    if (window.MineradioFolia && typeof MineradioFolia.notifyPlayback === 'function') {
      MineradioFolia.notifyPlayback();
    }
  } catch (_) {}
  if (reason === 'play' || reason === 'playing' || reason === 'pause' || reason === 'ended' || reason === 'emptied') {
    try { updateNowPlayingPresentation(); } catch (_) {}
  }
}

function isPlaybackRecursionError(err) {
  var msg = String((err && err.message) || err || '');
  return err instanceof RangeError || /maximum call stack size exceeded/i.test(msg);
}

function safePlaybackStep(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[PlaybackSetupStep]', label, err);
    return null;
  }
}

function playbackFailureToastText(err) {
  if (isPlaybackRecursionError(err)) return '播放准备异常，已保持播放器可操作';
  return '播放失败: ' + (err && err.message ? err.message : err);
}
function scheduleAudioResumePosition(media, seconds, token) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (!media || seconds < 0.35) return;
  var applied = false;
  function applyResume() {
    if (applied || token !== trackSwitchToken || !media) return;
    var duration = Number(media.duration) || 0;
    var target = duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.45)) : seconds;
    try {
      media.currentTime = target;
      applied = true;
      if (typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(target, true);
      if (typeof syncPodcastDjMapCursor === 'function') syncPodcastDjMapCursor(target, true);
      updatePlaybackProgressUi();
    } catch (e) {}
  }
  media.addEventListener('loadedmetadata', applyResume, { once: true });
  media.addEventListener('canplay', applyResume, { once: true });
  setTimeout(applyResume, 520);
  applyResume();
}

async function playQueueAt(idx, opts) {
  opts = opts || {};
  if (idx < 0 || idx >= playQueue.length) return;
  applyWebPlaybackPerfTuning();
  primeWebPlaybackUnlockIfNeeded(opts);
  markRenderInteraction('track-switch', mineradioUsesWebMediaBridge() ? (!firstPlayDone ? 2000 : 900) : 1500);
  var playPhase = 'start';
  function markPlayPhase(name) { playPhase = name; }
  try {
  markPlayPhase('session-finalize');
  safePlaybackStep('session-finalize', function(){ finalizeListenSession(false); });
  homeForcedOpen = false;
  if (!opts.preserveHomeState) homeSuppressed = false;
  currentIdx = idx;
  trackSwitchToken++;
  markPlayPhase('cancel-previous-track');
  cancelBeatAnalysisTimer();
  cancelBeatPrefetchTimer();
  if (localBeatAnalysis.active) cancelLocalBeatAnalysis();
  closeGsapModal(document.getElementById('local-beat-modal'));
  beatMapToken++;
  var token = trackSwitchToken;
  var firstVisualPlay = !firstPlayDone;
  markPlayPhase('track-setup');
  var song = safePlaybackStep('hydrate-song', function(){ return hydrateCustomCover(playQueue[idx]); }) || playQueue[idx];
  playQueue[idx] = song;
  cancelInFlightPlaybackAudioPrefetch(playbackSourceCacheKey(song, opts));
  var playbackContext = opts.context || (song && song.radioContext) || null;
  activeRadioContext = playbackContext || null;
  safeRenderQueuePanel('play-queue-at-switch', { scrollCurrent: miniQueueOpen });
  safePlaybackStep('shelf-preview-suppress', suppressShelfPreviewForPlaybackSwitch);
  pauseCurrentAudioForTrackSwitch();
  var urlFetchPromise = opts.urlFetchPromise || fetchPlaybackSourceData(song, opts).catch(function(err){
    console.warn('[PlaybackUrlPrefetch]', err);
    return null;
  });
  prefetchAdjacentPlaybackSources(idx);
  var bmKey = safePlaybackStep('beatmap-key', function(){ return beatMapSongKey(song); }) || '';
  var podcastDjMode = !!safePlaybackStep('podcast-mode', function(){ return isPodcastSong(song); });
  safePlaybackStep('dj-mode', function(){ setDjModeActive(podcastDjMode, song); });
  safePlaybackStep('visual-switch', switchPlaybackVisualToEmily);
  currentLocalSong = null;
  safePlaybackStep('cover-button', updateCustomCoverButton);
  safePlaybackStep('like-buttons', function(){ updateLikeButtons(song); });
  if (opts.fromSearch) {
    scheduleUiWarmTask(function(){ syncLikeStatusForSong(song); }, 520);
  } else {
    safePlaybackStep('like-status', function(){ syncLikeStatusForSong(song); });
  }
  safePlaybackStep('cinema-track-profile', function(){ resetCinemaTrackProfile(song); });
  safePlaybackStep('empty-home', function(){ if (!opts.preserveHomeState) updateEmptyHomeVisibility(); });
  safePlaybackStep('track-ui', function(){
    document.getElementById('hint').classList.add('hidden');
    document.getElementById('thumb-title').textContent = song.name;
    document.getElementById('thumb-artist').textContent = song.artist;
    // Cover first so UI / Folia don't linger on the previous artwork.
    if (typeof applyImmediateTrackCover === 'function') applyImmediateTrackCover(song, { size: 300 });
    updateControlTrackInfo(song);
    document.getElementById('thumb-wrap').classList.add('visible');
  });
  safePlaybackStep('folia-track-sync', function(){
    try {
      if (window.MineradioFolia && typeof MineradioFolia.notifyTrackChange === 'function') {
        MineradioFolia.notifyTrackChange();
      }
    } catch (_) {}
    try {
      if (window.MineradioListeningPet && typeof MineradioListeningPet.notifyTrackChange === 'function') {
        MineradioListeningPet.notifyTrackChange();
      }
    } catch (_) {}
  });
  markPlayPhase('lyric-prep');
  safePlaybackStep('lyric-prep', function(){
    var initialLyricLines = withLyricFallback([]);
    setOriginalLyricsState(initialLyricLines, false, 'fallback');
    applyPreferredLyricsForCurrent(true);
  });

  markPlayPhase('cover-load');
  safePlaybackStep('cover-load', function(){
    var customCover = getCustomCoverForSong(song);
    var webMode = mineradioUsesWebMediaBridge();
    var seamlessCover = !!(opts.seamless || opts.fastSwitch || !firstVisualPlay);
    // UI already swapped; keep particle/depth work light and soon, not delayed ~1s.
    var coverOpts = {
      trackToken: token,
      deferHeavy: !seamlessCover,
      delay: firstVisualPlay ? (webMode ? 220 : 160) : (seamlessCover ? 0 : 80),
      timeout: firstVisualPlay ? (webMode ? 2800 : 1600) : (webMode ? 2200 : 1200),
      colorMixDuration: seamlessCover ? 280 : undefined
    };
    if (customCover) applyCoverDataUrl(customCover, coverOpts);
    else {
      var coverSrc = resolveSongCoverUrl(song, webMode ? 300 : 500);
      loadCoverFromUrl(coverSrc, coverOpts);
    }
  });
  safePlaybackStep('trial-banner-reset', function(){ document.getElementById('trial-banner').classList.remove('show'); });
  // Seamless next/prev: skip the loading veil when the next track was already warm-buffered.
  var expectSeamless = !!(opts.seamless || opts.prefetchedWarm);
  if (!expectSeamless) {
    safePlaybackStep('show-loading', function(){ showLoading({ light: !firstVisualPlay }); });
  }
  lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;

  // 首次播放: 粒子从暗处浮出 (Apple 风格)
  if (firstVisualPlay) {
    safePlaybackStep('first-visual-alpha', function(){
      firstPlayDone = true;
      tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220);
    });
  }

  try {
    markPlayPhase('source-url');
    var data = await urlFetchPromise;
    if (token !== trackSwitchToken) return;
    if (!data || !data.url) {
      if (data) {
        var isQQPlayback = songProviderKey(song) === 'qq';
        var requestedQuality = normalizePlaybackQuality(opts.qualityOverride || playbackQuality);
        if (isQQPlayback && await retryQQPlaybackWithCompatibleQuality(song, idx, token, opts, data, requestedQuality)) return;
        if (await tryAutoPlaybackFallback(song, data, idx, token, opts)) return;
        handlePlaybackUnavailable(song, data);
      } else {
        showToast('获取播放地址失败，请重试');
        hideLoading();
      }
      return;
    }
    var provider = songProviderKey(song);
    if (provider === 'qq') {
      mergeQQSongCoverMeta(song, data);
      playQueue[idx] = song;
      updateControlTrackInfo(song);
      reloadParticleCoverForSong(song, token, 60);
    }
    var requestedQuality = normalizePlaybackQualityForProvider(opts.qualityOverride || playbackQuality, provider);
    var resolvedQualityText = playbackResolvedQualityText(data);
    if (playbackQualityWasDowngraded(requestedQuality, data.level)) {
      var providerLabel = provider === 'qq' ? 'QQ 音乐' : (provider === 'kg' ? '酷狗音乐' : '网易云');
      showSourceFallbackNotice(providerLabel + '音质自动降级', '请求 ' + playbackQualityLabel(requestedQuality, provider) + '，实际播放 ' + resolvedQualityText + '。');
    } else if (opts.qualitySwitch) {
      showSourceFallbackNotice('音质已切换', '实际播放: ' + resolvedQualityText + '。');
    }
    if (data.trial) {
      var txt;
      if (data.loggedIn && data.vipLevel === 'svip') txt = '此歌曲需要单曲、专辑购买或更高权限';
      else if (data.loggedIn && data.vipLevel === 'vip') txt = '此歌曲需要 SVIP 或购买 · 当前仅播放试听片段';
      else if (data.loggedIn) txt = '此歌曲需 VIP · 当前仅播放试听片段';
      else txt = '当前未登录 · 仅播放试听片段';
      document.getElementById('trial-text').textContent = txt;
      var trialLoginBtn = document.getElementById('trial-login-btn');
      if (trialLoginBtn) {
        trialLoginBtn.style.display = data.loggedIn ? 'none' : '';
        trialLoginBtn.onclick = function(){ openProviderLogin('netease'); };
      }
      document.getElementById('trial-banner').classList.add('show');
    }
    markPlayPhase('audio-element');
    var sourceKey = playbackSourceCacheKey(song, opts);
    var cacheEntry = playbackSourceCache[sourceKey];
    // Detach WebAudio graph so we can hot-swap the warm prefetched <audio> element.
    if (playbackAudioPrefetch.key === sourceKey && playbackAudioPrefetch.media) {
      preparePrefetchAudioElementSwap();
    }
    var prefetched = takePrefetchedPlaybackAudio(sourceKey);
    var usedPrefetchMedia = false;
    releaseWebPlaybackCaptureIfNeeded();
    if (prefetched && prefetched.media) {
      if (audio && audio !== prefetched.media) {
        audioFadeSerial++;
        clearAudioFadeTimers();
        if (typeof retirePlaybackAudioElement === 'function') retirePlaybackAudioElement(audio);
        else {
          try { audio.onended = null; audio.pause(); } catch (_) {}
        }
      }
      audio = prefetched.media;
      usedPrefetchMedia = true;
    } else if (!audio) audio = new Audio();
    else {
      audioFadeSerial++;
      clearAudioFadeTimers();
      audio.pause();
    }
    configurePlaybackAudioElement(audio, data.url);
    bindPlaybackProgressEvents(audio);
    applyVolumeToAudio();
    var proxyAudioUrl = (prefetched && prefetched.resolvedUrl) || (cacheEntry && cacheEntry.resolvedUrl) || await resolvePlaybackAudioUrl(data.url);
    rememberPlaybackSourceResolvedUrl(sourceKey, proxyAudioUrl);
    var analysisAudioUrl = resolveBeatAnalysisAudioUrl(data.url);
    currentPlaybackDirectUrl = (prefetched && prefetched.directUrl) || data.url;
    playbackStreamLoadedAt = Date.now();
    playbackPausedAt = 0;
    if (!usedPrefetchMedia || audio.src !== proxyAudioUrl) {
      audio.src = proxyAudioUrl;
      audio.load();
    }
    var prefetchedWarm = !!(prefetched && (prefetched.warm || (usedPrefetchMedia && audio.readyState >= 2)));
    if (!prefetchedWarm && expectSeamless) {
      safePlaybackStep('show-loading-late', function(){ showLoading({ light: true }); });
    } else if (prefetchedWarm) {
      hideLoading();
    }
    updatePlaybackProgressUi();
    audio.onended = function(){
      if (token !== trackSwitchToken) return;
      finalizeListenSession(true);
      if (playMode === 'single') setTimeout(function(){ playQueueAt(currentIdx, { autoRepeat: true }); }, 0);
      else setTimeout(nextTrack, 0);
    };
    scheduleAudioResumePosition(audio, opts.resumeAt, token);
    markPlayPhase('audio-start');
    var isQQPlayback = provider === 'qq';
    var useManualPlay = !!(opts.manual || (mineradioUsesWebMediaBridge() && !opts.autoRepeat && !opts.fallbackDepth && !opts.fromSearch && !opts.seamless));
    var fastSwitch = !!(opts.seamless || opts.fastSwitch || (!opts.manual && !opts.qualitySwitch && !opts.autoRepeat && (!firstVisualPlay || !!opts.fromSearch)));
    var playbackStarted = await playAudio({
      silent: isQQPlayback,
      manual: useManualPlay,
      fade: !mineradioUsesWebMediaBridge() && !opts.seamless && !prefetchedWarm,
      fastSwitch: fastSwitch,
      fromSearch: !!opts.fromSearch,
      prefetchedWarm: prefetchedWarm,
      resume: !!(opts.resumeAt > 0.35)
    });
    if (!playbackStarted) {
      if (isQQPlayback && await retryQQPlaybackWithCompatibleQuality(song, idx, token, opts, data, requestedQuality)) return;
      forcePlaybackControlsInteractive();
      if (opts.manual) {
        showToast('播放启动失败，请重新选择歌曲');
      } else {
        showSourceFallbackNotice('歌曲已载入', '点击播放器中间的播放按钮继续播放。');
      }
      return;
    }
    forcePlaybackControlsInteractive();
    prefetchAdjacentPlaybackSources(idx);
    markPlayPhase('visual-prep');
    try {
    // 重置 beatmap 状态
    currentBeatMap = null;
    beatMapNextIdx = 0;
    resetAudioVisualState();
    resetBeatCameraSync(0);
    cancelBeatAnalysisTimer();
    cancelBeatAnalysisWatchdog();
    clearProvisionalBeatChipTimer();
    beatMapToken++;
    var bmTok = beatMapToken;
    if (podcastDjMode) {
      // 播客走独立 DJ 离线锁拍系统, 不写入普通歌曲 beatMap.
      djBeatMapToken++;
      cancelDjBeatAnalysisTimer();
      resetDjBeatMapState();
      currentBeatMap = null;
      beatMapNextIdx = 0;
      var djTok = djBeatMapToken;
      var djKey = djSongKey(song);
      if (djBeatMapCache[djKey]) {
        currentDjBeatMap = djBeatMapCache[djKey];
        applyPodcastDjProfileFromMap(currentDjBeatMap);
        syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
        hideBeatChip();
        notifyDesktopLyricsBeatMapReady();
        console.log('podcast DJ beatmap 缓存命中:', currentDjBeatMap.cameraBeats.length, '个主拍');
      } else {
        showBeatChip('DJ 离线锁拍准备中…');
        var djDurationSec = Math.max(0, Number(song.duration) || 0);
        if (djDurationSec > 10000) djDurationSec /= 1000;
        schedulePodcastDjAnalysis(djKey, analysisAudioUrl, djTok, djDurationSec);
      }
      maybeAnnounceDjMode();
    } else if (bmKey && hasResolvedBeatMapCache(bmKey)) {
      // 如果缓存有, 直接用
      currentBeatMap = beatMapCache[bmKey];
      applyCinemaProfileFromBeatMap(currentBeatMap);
      syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0);
      notifyDesktopLyricsBeatMapReady();
      console.log('beatmap 缓存命中:', currentBeatMap.kicks.length, '个鼓点');
      scheduleQueueBeatPrefetch(idx, 2600);
    } else {
      var diskKey = bmKey;
      if (diskKey) {
        readBeatDiskCache(diskKey).then(function(diskBeatMap){
          if (!diskBeatMap || bmTok !== beatMapToken) return;
          if (hasResolvedBeatMapCache(diskKey)) return;
          applyBeatMapCacheForCurrent(diskKey, diskBeatMap, bmTok, 'D盘节拍缓存命中:');
          cancelBeatAnalysisTimer();
          cancelBeatAnalysisWatchdog();
          clearProvisionalBeatChipTimer();
        });
      }
      maybeApplyProvisionalBeatMap(song, bmKey || String(song.id || ''));
      scheduleBeatAnalysis(bmKey || song.id, analysisAudioUrl, bmTok, song, data.url);
    }
    } catch (visualErr) {
      console.warn('[PlaybackVisualPrep]', song && song.name, visualErr);
      if (!maybeApplyProvisionalBeatMap(song, bmKey)) {
        currentBeatMap = null;
        beatMapNextIdx = 0;
      }
      safePlaybackStep('visual-prep-hide-chip', hideBeatChip);
    }
    markPlayPhase('session-begin');
    safePlaybackStep('listen-session-begin', function(){ beginListenSession(song, playbackContext); });
    markPlayPhase('lyrics-fetch');
    if (song.type === 'podcast') {
      safePlaybackStep('podcast-lyrics', function(){
        var podcastLyricLines = withLyricFallback([]);
        setOriginalLyricsState(podcastLyricLines, false, 'fallback');
        applyPreferredLyricsForCurrent(true);
      });
    } else if (mineradioUsesWebMediaBridge()) {
      var foliaWantsLyrics = false;
      try { foliaWantsLyrics = !!(window.MineradioFolia && MineradioFolia.isEnabled()); } catch (_) {}
      // Folia needs lyrics ASAP; otherwise delay slightly so first audio frame wins the network.
      scheduleUiWarmTask(function(){ fetchLyric(song, token); }, foliaWantsLyrics ? 80 : 480);
    } else {
      fetchLyric(song, token);
    }
    safeRenderQueuePanel('play-queue-at');
    scheduleUiWarmTask(function(){
      if (token !== trackSwitchToken) return;
      refreshSearchResultPlayingState();
      refreshArtistDetailPlayingState();
      refreshSongDetailUiState();
      refreshHomePlayingState();
    }, 180);
    scheduleShelfRebuild('play-queue-at', true);
    safePlaybackStep('shelf-preview-suppress-end', suppressShelfPreviewForPlaybackSwitch);
    safePlaybackStep('media-session', function(){ updateNowPlayingPresentation(song); });
  } catch (err) {
    console.error('Play failed:', { phase: playPhase, error: err }, err);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!isPlaybackRecursionError(err) && token === trackSwitchToken && !opts.manual && playQueue.length > 1) {
      skipFailedQueueItem(idx, token, '当前歌曲加载失败，正在尝试队列里的下一首。');
      return;
    }
    showToast(playbackFailureToastText(err));
  }
  } catch (setupErr) {
    console.error('Play setup failed:', { phase: playPhase, error: setupErr }, setupErr);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!isPlaybackRecursionError(setupErr) && typeof token !== 'undefined' && token === trackSwitchToken && !opts.manual && playQueue.length > 1) {
      skipFailedQueueItem(idx, token, '当前歌曲切换失败，正在尝试队列里的下一首。');
      return;
    }
    showToast(playbackFailureToastText(setupErr));
  }
}
async function attemptAudioPlay(opts) {
  opts = opts || {};
  var webMode = mineradioUsesWebMediaBridge();
  if (webMode) opts.fade = false;
  try {
      if (!audio) return false;
      restorePlaybackGain();
      var quickPlay = webMode && audio.src && (opts.fastSwitch || opts.fromSearch);
      if (quickPlay) {
        if (!audioReady) initAudio();
        if (opts.fade !== false) preparePlaybackFadeIn();
        try {
          await resumeAudioAnalysis();
          await audio.play();
          if (!audio.paused) {
            switchPlaybackVisualToEmily();
            playing = true; setPlayIcon(true);
            playbackPausedAt = 0;
            ensurePlaybackBeatmapVisualFallback();
            if (opts.fade !== false) startPlaybackFadeIn();
            else restorePlaybackGain();
            forcePlaybackControlsInteractive();
            hideLoading();
            return true;
          }
        } catch (quickErr) {
          console.warn('Quick play retry:', quickErr && (quickErr.message || quickErr));
        }
      }
      if (webMode && audio.src) {
        var readyTimeout = opts.prefetchedWarm ? 420 : (opts.fastSwitch || opts.fromSearch ? 1100 : (opts.resume ? 4500 : 6500));
        if (opts.prefetchedWarm && audio.readyState >= 2) {
          // 预缓冲命中
        } else if (audio.readyState < 2) {
          await waitForPlaybackAudioReady(audio, readyTimeout);
        }
      }
      if (!audioReady) initAudio();
      if (opts.fade !== false) preparePlaybackFadeIn();
      if (opts.manual) {
        var manualPlay = audio.play();
        await resumeAudioAnalysis();
        await manualPlay;
      } else {
        await resumeAudioAnalysis();
        await audio.play();
      }
      await resumeAudioAnalysis();
      if (audio.paused) throw new Error('play stalled');
      switchPlaybackVisualToEmily();
      playing = true; setPlayIcon(true);
      playbackPausedAt = 0;
      ensurePlaybackBeatmapVisualFallback();
    if (opts.fade !== false) startPlaybackFadeIn();
    else restorePlaybackGain();
    forcePlaybackControlsInteractive();
    hideLoading();
    return true;
  } catch (err) {
    console.warn('Audio play blocked:', err && (err.message || err));
    restorePlaybackGain();
    playing = false; setPlayIcon(false);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!opts.silent) showToast(opts.manual ? '播放启动失败, 请重新选择歌曲' : '播放被系统拦截, 请点击播放按钮');
    return false;
  }
}
async function playAudio(opts) {
  opts = opts || {};
  return attemptAudioPlay({
    manual: !!opts.manual,
    silent: !!opts.silent,
    fastSwitch: !!opts.fastSwitch,
    fromSearch: !!opts.fromSearch,
    prefetchedWarm: !!opts.prefetchedWarm,
    resume: !!opts.resume,
    fade: opts.fade
  });
}
async function togglePlay() {
  if (playToggleBusy) return;
  playToggleBusy = true;
  try {
    forcePlaybackControlsInteractive();
    if ((!audio || !audio.src) && playQueue.length && currentIdx >= 0) {
      var resumeAt = typeof consumePlaybackResumeAt === 'function' ? consumePlaybackResumeAt() : 0;
      await playQueueAt(currentIdx, { manual: true, resumeAt: resumeAt });
      return;
    }
    if (!audio) return;
    if (audio.paused || audio.ended) {
      restorePlaybackGain();
      if (playbackStreamNeedsRefresh()) {
        var refreshed = await refreshCurrentPlaybackStream({ resumeAt: audio.currentTime, manual: true });
        if (refreshed) return;
        if (playbackStreamNeedsRefresh()) {
          showToast('播放链接已过期，正在重新加载…');
          refreshed = await refreshCurrentPlaybackStream({ resumeAt: 0, manual: true });
          if (refreshed) return;
        }
      }
      await attemptAudioPlay({ manual: true, resume: true });
    } else {
      await fadeOutAndPauseAudio();
      playing = false;
      setPlayIcon(false);
      hideLoading();
      safePlaybackStep('listen-stats-pause', function(){ updateListenStatsTick(true); });
      forcePlaybackControlsInteractive();
      safePlaybackStep('sync-pause-state', function(){ syncPlaybackStateFromAudioEvent('manual-pause'); });
      safePlaybackStep('pause-controls-hide', function(){ scheduleControlsHide(520); });
    }
  } catch (err) {
    console.warn('[TogglePlay]', err);
    playing = !!(audio && !audio.paused);
    setPlayIcon(playing);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!audio || !audio.src) showToast('播放控制失败');
  } finally {
    playToggleBusy = false;
  }
}
function setPlayIcon(p) {
  document.getElementById('play-icon').innerHTML = p
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<path d="M8 5v14l11-7z"/>';
}
function nextTrack() {
  if (!playQueue.length) return;
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  var nextIdx = playMode === 'shuffle'
    ? Math.floor(Math.random() * playQueue.length)
    : (currentIdx + 1) % playQueue.length;
  Promise.resolve(playQueueIndexSeamless(nextIdx)).finally(forcePlaybackControlsInteractive);
}
function prevTrack() {
  if (!playQueue.length) return;
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  var prevIdx = (currentIdx - 1 + playQueue.length) % playQueue.length;
  Promise.resolve(playQueueIndexSeamless(prevIdx)).finally(forcePlaybackControlsInteractive);
}
async function playQueueIndexSeamless(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  var song = playQueue[idx];
  var key = playbackSourceCacheKey(song);
  if (!key || playbackAudioPrefetch.key !== key || !playbackAudioPrefetch.media) {
    prefetchPlaybackAudioForIndex(idx);
  }
  await waitForPrefetchWarm(key, 480);
  currentIdx = idx;
  return playQueueAt(idx, { seamless: true, fastSwitch: true });
}
function waitForPrefetchWarm(key, timeoutMs) {
  if (!key) return Promise.resolve(false);
  if (playbackAudioPrefetch.key === key && playbackAudioPrefetch.media && playbackAudioPrefetch.media.readyState >= 2) {
    return Promise.resolve(true);
  }
  return new Promise(function(resolve) {
    var started = Date.now();
    var limit = Math.max(80, Number(timeoutMs) || 400);
    function tick() {
      if (playbackAudioPrefetch.key === key && playbackAudioPrefetch.media && playbackAudioPrefetch.media.readyState >= 2) {
        resolve(true);
        return;
      }
      // URL cache alone still helps even if the element isn't fully buffered yet.
      if (readPlaybackSourceCache(key) && Date.now() - started >= Math.min(160, limit)) {
        resolve(false);
        return;
      }
      if (Date.now() - started >= limit) {
        resolve(false);
        return;
      }
      setTimeout(tick, 32);
    }
    tick();
  });
}
function shuffleQueue() {
  for (var i = playQueue.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = playQueue[i]; playQueue[i] = playQueue[j]; playQueue[j] = tmp;
  }
  currentIdx = 0; safeRenderQueuePanel('shuffle-queue', { reset: true });
  showToast('队列已随机');
  safeShelfRebuild('shuffle-queue');
}
function clearQueue() {
  playQueue = []; currentIdx = -1;
  resetMiniQueueRenderLimit();
  safeRenderQueuePanel('clear-queue');
  safeShelfRebuild('clear-queue');
  updateCustomCoverButton();
  updateCustomLyricControls();
  updateEmptyHomeVisibility({ forceLoad: false });
}
function removeFromQueue(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  playQueue.splice(idx, 1);
  if (currentIdx >= playQueue.length) currentIdx = playQueue.length - 1;
  safeRenderQueuePanel('remove-queue-item');
  safeShelfRebuild('remove-queue-item');
  updateCustomCoverButton();
  updateCustomLyricControls();
  updateEmptyHomeVisibility({ forceLoad: false });
}
function playModeLabel(mode) {
  return { loop: '顺序循环', shuffle: '随机播放', single: '单曲循环' }[mode] || '顺序循环';
}

function playModeIconMarkup(mode) {
  if (mode === 'shuffle') {
    return '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>';
  }
  if (mode === 'single') {
    return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M12 9v6"/><path d="M10.5 10.5 12 9l1.5 1.5"/>';
  }
  return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
}

function updatePlayModeButton(animate) {
  var label = playModeLabel(playMode);
  var chip = document.getElementById('play-mode-chip');
  var btn = document.getElementById('play-mode-btn');
  var icon = document.getElementById('play-mode-icon');
  if (chip) chip.textContent = label;
  if (btn) {
    btn.dataset.mode = playMode;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', playMode !== 'loop');
  }
  if (icon) icon.innerHTML = playModeIconMarkup(playMode);
  if (!animate || !btn) return;
  if (window.gsap) {
    window.gsap.killTweensOf(btn);
    if (icon) window.gsap.killTweensOf(icon);
    window.gsap.timeline({ defaults: { overwrite: true } })
      .fromTo(btn, { scale: 0.86, rotate: -8 }, { scale: 1.12, rotate: 4, duration: 0.16, ease: 'power2.out' })
      .to(btn, { scale: 1, rotate: 0, duration: 0.34, ease: 'back.out(2.1)' });
    window.gsap.fromTo(btn,
      { boxShadow: '0 0 0 0 rgba(255,63,85,.36)' },
      { boxShadow: '0 0 0 14px rgba(255,63,85,0)', duration: 0.58, ease: 'sine.out', overwrite: false, onComplete: function(){ window.gsap.set(btn, { clearProps: 'boxShadow' }); } }
    );
    if (icon) window.gsap.fromTo(icon, { y: 4, autoAlpha: 0.32, rotate: -22, scale: 0.74 }, { y: 0, autoAlpha: 1, rotate: 0, scale: 1, duration: 0.42, ease: 'expo.out', overwrite: true });
  } else {
    btn.classList.remove('mode-switching');
    void btn.offsetWidth;
    btn.classList.add('mode-switching');
    setTimeout(function(){ btn.classList.remove('mode-switching'); }, 460);
  }
}

function cyclePlayMode() {
  var modes = ['loop', 'shuffle', 'single'];
  var idx = modes.indexOf(playMode);
  playMode = modes[(idx + 1) % modes.length];
  updatePlayModeButton(true);
  safeRenderQueuePanel('cycle-play-mode', { animate: false, scrollCurrent: miniQueueOpen });
  showToast('播放模式: ' + playModeLabel(playMode));
}
updatePlayModeButton(false);

var controlGlassState = { key: '', searchBoxKey: '', searchPillKey: '' };
function normalizeControlGlassChromaticOffset(value) {
  var n = Number(value);
  if (!isFinite(n)) n = fxDefaults.controlGlassChromaticOffset;
  return clampRange(n, 0, 140);
}
function applyControlGlassChromaticOffset() {
  if (!fx) return;
  fx.controlGlassChromaticOffset = normalizeControlGlassChromaticOffset(fx.controlGlassChromaticOffset);
  var filter = document.getElementById('mineradio-control-glass-filter');
  if (!filter) return;
  var dx = String(-Math.round(fx.controlGlassChromaticOffset));
  filter.querySelectorAll('feOffset').forEach(function(node){
    node.setAttribute('dx', dx);
    node.setAttribute('dy', '0');
  });
}
function supportsControlGlassSvgFilter() {
  try {
    var ua = navigator.userAgent || '';
    if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) return false;
    var div = document.createElement('div');
    div.style.backdropFilter = 'url(#mineradio-control-glass-filter)';
    return div.style.backdropFilter !== '';
  } catch (e) {
    return false;
  }
}
function generateControlGlassDisplacementMap(width, height, radius) {
  width = Math.max(240, Math.round(width || 400));
  height = Math.max(48, Math.round(height || 92));
  radius = Math.max(12, Math.round(radius || 50));
  var borderWidth = 0.07;
  var edge = Math.min(width, height) * (borderWidth * 0.5);
  var innerW = Math.max(1, width - edge * 2);
  var innerH = Math.max(1, height - edge * 2);
  var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<linearGradient id="glass-red" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>' +
    '<linearGradient id="glass-blue" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>' +
    '</defs>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="black"/>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" rx="' + radius + '" fill="url(#glass-red)"/>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" rx="' + radius + '" fill="url(#glass-blue)" style="mix-blend-mode:difference"/>' +
    '<rect x="' + edge.toFixed(2) + '" y="' + edge.toFixed(2) + '" width="' + innerW.toFixed(2) + '" height="' + innerH.toFixed(2) + '" rx="' + radius + '" fill="hsl(0 0% 50% / 1)" style="filter:blur(11px)"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function updateGlassDisplacementMapForElement(el, img, stateKey) {
  if (!el || !img) return;
  var rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  var radius = parseFloat(getComputedStyle(el).borderRadius) || 24;
  var key = Math.round(rect.width) + 'x' + Math.round(rect.height) + ':' + Math.round(radius);
  if (key === controlGlassState[stateKey]) return;
  controlGlassState[stateKey] = key;
  var href = generateControlGlassDisplacementMap(rect.width, rect.height, radius);
  img.setAttribute('href', href);
  try { img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href); } catch (e) {}
}
function updateControlGlassDisplacementMap() {
  updateGlassDisplacementMapForElement(
    document.getElementById('bottom-bar'),
    document.getElementById('control-glass-map'),
    'key'
  );
}
function updateSearchBoxGlassDisplacementMap() {
  updateGlassDisplacementMapForElement(
    document.getElementById('search-box'),
    document.getElementById('search-box-glass-map'),
    'searchBoxKey'
  );
}
function updateSearchPillGlassDisplacementMap() {
  var img = document.getElementById('search-pill-glass-map');
  if (!img) return;
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.search-mode-tabs button,.search-history-chip'));
  if (!nodes.length) return;
  var maxW = 0, maxH = 0, maxRadius = 14;
  nodes.forEach(function(el){
    if (!el || el.offsetParent === null) return;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    maxW = Math.max(maxW, rect.width);
    maxH = Math.max(maxH, rect.height);
    maxRadius = Math.max(maxRadius, parseFloat(getComputedStyle(el).borderRadius) || Math.round(rect.height / 2) || 14);
  });
  if (maxW < 2 || maxH < 2) return;
  var width = Math.max(96, Math.round(maxW));
  var height = Math.max(32, Math.round(maxH));
  var radius = Math.max(12, Math.min(Math.round(maxRadius), Math.round(height / 2) + 10));
  var key = width + 'x' + height + ':' + radius;
  if (key === controlGlassState.searchPillKey) return;
  controlGlassState.searchPillKey = key;
  var href = generateControlGlassDisplacementMap(width, height, radius);
  img.setAttribute('href', href);
  try { img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href); } catch (e) {}
}
function initControlGlassSurface() {
  var phoneShell = false;
  try {
    phoneShell = document.body.classList.contains('phone-shell') ||
      window.matchMedia('(max-width:720px), (max-height:520px) and (max-width:960px)').matches;
  } catch (_) {}
  if (supportsControlGlassSvgFilter()) {
    window.__mineradioControlGlassSvgOk = true;
    if (!phoneShell) document.documentElement.classList.add('control-glass-svg-ok');
  }
  applyControlGlassChromaticOffset();
  updateControlGlassDisplacementMap();
  updateSearchBoxGlassDisplacementMap();
  updateSearchPillGlassDisplacementMap();
  var bar = document.getElementById('bottom-bar');
  var searchBox = document.getElementById('search-box');
  var searchTabs = document.getElementById('search-mode-tabs');
  var searchResults = document.getElementById('search-results');
  if (window.ResizeObserver && (bar || searchBox || searchTabs || searchResults) && !phoneShell) {
    var ro = new ResizeObserver(function(){
      requestAnimationFrame(updateControlGlassDisplacementMap);
      requestAnimationFrame(updateSearchBoxGlassDisplacementMap);
      requestAnimationFrame(updateSearchPillGlassDisplacementMap);
    });
    if (bar) ro.observe(bar);
    if (searchBox) ro.observe(searchBox);
    if (searchTabs) ro.observe(searchTabs);
    if (searchResults) ro.observe(searchResults);
  }
  if (window.MutationObserver && (searchTabs || searchResults)) {
    var mo = new MutationObserver(function(){
      requestAnimationFrame(updateSearchPillGlassDisplacementMap);
    });
    if (searchTabs) mo.observe(searchTabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (searchResults) mo.observe(searchResults, { childList: true, subtree: true });
  }
  window.addEventListener('resize', function(){
    requestAnimationFrame(updateControlGlassDisplacementMap);
    requestAnimationFrame(updateSearchBoxGlassDisplacementMap);
    requestAnimationFrame(updateSearchPillGlassDisplacementMap);
  });
}

function bindPlayerControlAnimations() {
  if (!window.gsap) return;
  document.querySelectorAll('#bottom-bar .ctrl-btn').forEach(function(btn){
    if (!btn || btn.dataset.controlAnimBound === '1') return;
    btn.dataset.controlAnimBound = '1';
    var isPlay = btn.id === 'play-btn';
    var iconTarget = btn.querySelector('svg,.lyrics-word-icon,#quality-btn-label');
    function canAnimate() {
      return !btn.disabled && !btn.classList.contains('busy');
    }
    function hoverIn(e) {
      if (!canAnimate() || (e && e.pointerType === 'touch')) return;
      window.gsap.to(btn, { y: -2, scale: isPlay ? 1.07 : 1.08, duration: 0.20, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: isPlay ? 1.08 : 1.10, duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
    }
    function hoverOut() {
      window.gsap.to(btn, { y: 0, scale: 1, rotate: 0, duration: 0.26, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: 1, rotate: 0, duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
    }
    function pressDown() {
      if (!canAnimate()) return;
      window.gsap.to(btn, { y: 0, scale: isPlay ? 0.91 : 0.90, duration: 0.10, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: 0.88, duration: 0.10, ease: 'power2.out', overwrite: 'auto' });
    }
    function release(e) {
      if (!canAnimate()) return;
      var hovered = e && e.pointerType !== 'touch' && btn.matches(':hover');
      window.gsap.to(btn, { y: hovered ? -2 : 0, scale: hovered ? (isPlay ? 1.07 : 1.08) : 1, duration: 0.24, ease: 'back.out(1.9)', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: hovered ? 1.06 : 1, duration: 0.22, ease: 'back.out(1.8)', overwrite: 'auto' });
    }
    function clickPulse() {
      if (!canAnimate() || btn.id === 'play-mode-btn') return;
      var pulseSize = isPlay ? 18 : 10;
      var pulseColor = isPlay ? 'rgba(255,63,85,.34)' : 'rgba(255,255,255,.22)';
      window.gsap.killTweensOf(btn, 'boxShadow');
      window.gsap.fromTo(btn,
        { boxShadow: '0 0 0 0 ' + pulseColor },
        { boxShadow: '0 0 0 ' + pulseSize + 'px rgba(255,63,85,0)', duration: isPlay ? 0.58 : 0.42, ease: 'sine.out', overwrite: false, onComplete: function(){ window.gsap.set(btn, { clearProps: 'boxShadow' }); } }
      );
      if (iconTarget) window.gsap.fromTo(iconTarget, { rotate: isPlay ? 0 : -5 }, { rotate: 0, duration: 0.34, ease: 'elastic.out(1,0.55)', overwrite: 'auto' });
    }
    btn.addEventListener('pointerenter', hoverIn);
    btn.addEventListener('pointerleave', hoverOut);
    btn.addEventListener('pointercancel', hoverOut);
    btn.addEventListener('mousedown', function(e){ e.preventDefault(); });
    btn.addEventListener('pointerdown', pressDown);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('click', clickPulse);
    btn.addEventListener('focus', function(){ hoverIn(); });
    btn.addEventListener('blur', hoverOut);
  });
}

function clearPlayerControlFocusState(reason) {
  try {
    document.querySelectorAll('#bottom-bar .ctrl-btn').forEach(function(btn){
      if (!btn) return;
      if (document.activeElement === btn) btn.blur();
      btn.classList.remove('focus-visible');
      if (window.gsap) {
        window.gsap.killTweensOf(btn);
        window.gsap.set(btn, { y: 0, scale: 1, rotate: 0, clearProps: 'boxShadow' });
        var iconTarget = btn.querySelector('svg,.lyrics-word-icon,#quality-btn-label');
        if (iconTarget) {
          window.gsap.killTweensOf(iconTarget);
          window.gsap.set(iconTarget, { scale: 1, rotate: 0 });
        }
      } else {
        btn.style.transform = '';
        btn.style.boxShadow = '';
      }
    });
  } catch (e) {
    console.warn('[ControlFocusClear]', reason || 'unknown', e);
  }
}

// ============================================================
//  歌词
// ============================================================
async function fetchLyric(songOrId, token) {
  try {
    var song = (songOrId && typeof songOrId === 'object') ? songOrId : null;
    var provider = songProviderKey(song);
    var endpoint;
    if (provider === 'qq') {
      var mid = song.mid || song.songmid || song.id || '';
      var qqId = song.qqId || (/^\d+$/.test(String(song.id || '')) ? song.id : '');
      endpoint = '/api/qq/lyric?mid=' + encodeURIComponent(mid) + '&id=' + encodeURIComponent(qqId);
    } else if (provider === 'kg') {
      var kgHash = song.hash || song.id || '';
      var kgAlbumAudioId = song.albumAudioId || song.album_audio_id || song.mixsongid || '';
      var kgKeyword = ((song.artist ? (song.artist + ' - ') : '') + (song.name || '')).replace(/\.(mp3|flac|m4a)$/i, '').trim();
      endpoint = '/api/kg/lyric?hash=' + encodeURIComponent(kgHash)
        + '&albumAudioId=' + encodeURIComponent(kgAlbumAudioId)
        + '&duration=' + encodeURIComponent(String(song.duration || ''))
        + '&keyword=' + encodeURIComponent(kgKeyword);
    } else {
      var songId = song ? song.id : songOrId;
      endpoint = '/api/lyric?id=' + encodeURIComponent(songId);
    }
    var r = await apiJson(endpoint);
    if (token !== trackSwitchToken) return;
    var nativeLines = parseYrcText(r.yrc || '');
    var lrcLines = parseLyricText(r.lyric || '');
    var hasNativeKaraoke = nativeLines.some(function(line){ return line.words && line.words.length; });
    var timingSource = hasNativeKaraoke ? 'yrc-word' : (nativeLines.length ? 'yrc-line' : (lrcLines.length ? 'lrc-line' : 'fallback'));
    var lines = withLyricFallback(nativeLines.length ? nativeLines : lrcLines);
    if (lines.length && lines[0].fallback) timingSource = 'fallback';
    mergeLyricTranslations(lines, r.tlyric || r.tLyric || r.transLyric || '');
    setOriginalLyricsState(lines, hasNativeKaraoke, timingSource);
    applyPreferredLyricsForCurrent(true);
  } catch (e) {
    if (token !== trackSwitchToken) return;
    var fallbackLines = withLyricFallback([]);
    setOriginalLyricsState(fallbackLines, false, 'fallback');
    applyPreferredLyricsForCurrent(true);
  }
}
function currentLyricFallbackText() {
  var song = currentLyricSong() || {};
  var title = (song.name || document.getElementById('thumb-title').textContent || '').trim();
  var artist = (song.artist || document.getElementById('thumb-artist').textContent || '').trim();
  if (!title) return '';
  return artist ? title + ' - ' + artist : title;
}
function isNoLyricText(text) {
  var compact = String(text || '').replace(/\s+/g, '').replace(/[，,。.!！?？、~～]/g, '');
  return !compact ||
    compact === '纯音乐请欣赏' ||
    compact === '暂无歌词' ||
    compact === '暂无歌词敬请期待' ||
    compact === '此歌曲为没有填词的纯音乐请您欣赏';
}
function withLyricFallback(lines) {
  lines = Array.isArray(lines) ? lines.filter(function(line){ return line && String(line.text || '').trim(); }) : [];
  if (lines.length && !lines.every(function(line){ return isNoLyricText(line.text); })) return lines;
  var text = currentLyricFallbackText();
  return text ? [{ t:0, text:text, duration:9999, charCount:Math.max(1, text.length), fallback:true }] : [];
}
function lyricTagTimeToSeconds(min, sec, frac) {
  var t = (parseInt(min, 10) || 0) * 60 + (parseInt(sec, 10) || 0);
  if (frac) t += (parseInt(frac, 10) || 0) / Math.pow(10, Math.min(3, frac.length));
  return t;
}
function finalizeLyricLineDurations(lines) {
  lines.sort(function(a, b){ return a.t - b.t; });
  for (var i = 0; i < lines.length; i++) {
    var next = lines[i + 1];
    var inferred = next && next.t > lines[i].t ? next.t - lines[i].t : 4.8;
    if (!isFinite(lines[i].duration) || lines[i].duration <= 0) lines[i].duration = inferred;
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration));
    lines[i].charCount = Math.max(1, lines[i].charCount || String(lines[i].text || '').length);
  }
  return lines;
}
function parseLyricText(text) {
  var lines = [], reg = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach(function(line){
    var times = [], m;
    reg.lastIndex = 0;
    while ((m = reg.exec(line))) times.push(lyricTagTimeToSeconds(m[1], m[2], m[3]));
    if (!times.length) return;
    var txt = line.replace(reg, '').trim();
    if (!txt) return;
    times.forEach(function(t){ lines.push({ t: t, text: txt, source:'lrc' }); });
  });
  return finalizeLyricLineDurations(lines);
}
function mergeLyricTranslations(lines, tlyricText) {
  if (!Array.isArray(lines) || !lines.length || !tlyricText) return lines;
  var transLines = parseLyricText(String(tlyricText || ''));
  if (!transLines.length) return lines;
  lines.forEach(function(line){
    if (!line || line.trans) return;
    var best = null, bestDiff = 1e9;
    for (var i = 0; i < transLines.length; i++) {
      var diff = Math.abs((transLines[i].t || 0) - (line.t || 0));
      if (diff < bestDiff) { bestDiff = diff; best = transLines[i]; }
    }
    if (best && bestDiff <= 1.25 && best.text && best.text !== line.text) line.trans = best.text;
  });
  return lines;
}
function parseYrcText(text) {
  var lines = [];
  String(text || '').split(/\r?\n/).forEach(function(line){
    var m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) return;
    var lineStartMs = parseInt(m[1], 10) || 0;
    var lineDurMs = parseInt(m[2], 10) || 0;
    var body = m[3] || '';
    var words = [], fullText = '';
    var reg = /\((\d+),(\d+),\d+\)([^()]*)/g, wm;
    while ((wm = reg.exec(body))) {
      var txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;
      var rawStart = parseInt(wm[1], 10) || 0;
      var rawDur = parseInt(wm[2], 10) || 0;
      var absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;
      var c0 = fullText.length;
      fullText += txt;
      words.push({ text:txt, t:absStartMs / 1000, d:Math.max(0.06, rawDur / 1000), c0:c0, c1:fullText.length });
    }
    if (!fullText) fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    var leading = (fullText.match(/^\s+/) || [''])[0].length;
    fullText = fullText.replace(/\s+/g, ' ').trim();
    if (!fullText) return;
    if (words.length) {
      words.forEach(function(w){
        w.c0 = Math.max(0, Math.min(fullText.length, w.c0 - leading));
        w.c1 = Math.max(w.c0, Math.min(fullText.length, w.c1 - leading));
      });
      words = words.filter(function(w){ return w.c1 > w.c0; });
    }
    lines.push({ t:lineStartMs / 1000, duration:lineDurMs / 1000, text:fullText, words:words, charCount:Math.max(1, fullText.length), source: words.length ? 'yrc-word' : 'yrc-line' });
  });
  return finalizeLyricLineDurations(lines);
}
function renderLyrics() {
  // v8: 歌词渲染由 stageLyrics 在每帧 tickLyricsParticles 里推动
  clearStageLyrics();
}
function toggleLyricsPanel(force) {
  if (force === false) fx.particleLyrics = false;
  else if (force === true) fx.particleLyrics = true;
  else fx.particleLyrics = !fx.particleLyrics;
  if (fx.particleLyrics) {
    createLyricsParticles();
    showToast('歌词已开启');
  } else {
    clearStageLyrics();
    showToast('歌词已关闭');
  }
  lyricsVisible = fx.particleLyrics;
}
function updateLyricsHighlight() { /* v8: 由 tickLyricsParticles 接管 */ }

// ============================================================
//  播放列表面板
// ============================================================
function animateListItems(container, selector, opts) {
  if (!container || !window.gsap) return;
  // 手机端跳过列表入场淡入，避免每次打开面板整表闪一下
  try {
    if (document.body.classList.contains('phone-shell')) return;
  } catch (_) {}
  opts = opts || {};
  var items = Array.prototype.slice.call(container.querySelectorAll(selector));
  if (!items.length) return;
  var limit = opts.limit || 18;
  var targets = items.slice(0, limit);
  window.gsap.killTweensOf(targets);
  window.gsap.fromTo(targets, {
    autoAlpha: 0,
    y: opts.y == null ? 8 : opts.y,
    x: opts.x == null ? -6 : opts.x
  }, {
    autoAlpha: 1,
    y: 0,
    x: 0,
    duration: opts.duration || 0.22,
    stagger: opts.stagger || 0.012,
    ease: opts.ease || 'power2.out',
    force3D: true,
    overwrite: true
  });
}
function smoothScrollToItem(scroller, item, opts) {
  if (!scroller || !item) return;
  opts = opts || {};
  var target = item.offsetTop - Math.max(0, (scroller.clientHeight - item.offsetHeight) * (opts.align == null ? 0.42 : opts.align));
  target = Math.max(0, Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
  if (window.gsap) {
    if (typeof scroller.__syncSmoothWheelTarget === 'function') scroller.__syncSmoothWheelTarget(target);
    window.gsap.killTweensOf(scroller);
    window.gsap.to(scroller, { scrollTop: target, duration: opts.duration || 0.30, ease: opts.ease || 'power2.out', overwrite: true });
  } else if (scroller.scrollTo) {
    scroller.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    scroller.scrollTop = target;
  }
}
function bindSmoothWheelScroll(scroller) {
  if (!scroller || scroller.__smoothWheelBound) return;
  scroller.__smoothWheelBound = true;
  var targetTop = scroller.scrollTop;
  var tween = null;
  scroller.__syncSmoothWheelTarget = function(top){
    if (tween) {
      tween.kill();
      tween = null;
    }
    targetTop = isFinite(top) ? top : scroller.scrollTop;
  };
  scroller.addEventListener('wheel', function(e){
    if (!window.gsap || e.ctrlKey) return;
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (max <= 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    var delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 18;
    else if (e.deltaMode === 2) delta *= scroller.clientHeight;
    var current = tween ? targetTop : scroller.scrollTop;
    var next = Math.max(0, Math.min(max, current + delta));
    if (next === current && ((delta < 0 && scroller.scrollTop <= 0) || (delta > 0 && scroller.scrollTop >= max - 1))) {
      targetTop = scroller.scrollTop;
      return;
    }
    e.preventDefault();
    targetTop = next;
    if (tween) tween.kill();
    tween = window.gsap.to(scroller, {
      scrollTop: targetTop,
      duration: 0.24,
      ease: 'power2.out',
      overwrite: true,
      onComplete: function(){
        tween = null;
        targetTop = scroller.scrollTop;
      }
    });
  }, { passive: false });
  scroller.addEventListener('scroll', function(){
    if (!tween) targetTop = scroller.scrollTop;
  }, { passive: true });
}
function bindSmoothQueueScrolling() {
  if (smoothWheelScrollBound) return;
  smoothWheelScrollBound = true;
  [
    'mini-queue-list',
    'search-results',
    'fx-panel',
    'playlist-panel',
    'track-detail-body'
  ].forEach(function(id){
    bindSmoothWheelScroll(document.getElementById(id));
  });
}
function animateVisiblePanelList(listEl, selector, scroller, activeSelector, opts) {
  if (!listEl) return;
  opts = opts || {};
  requestAnimationFrame(function(){
    animateListItems(listEl, selector, { x: -8, y: 6, stagger: 0.01, duration: 0.20, limit: 16 });
    var active = activeSelector ? listEl.querySelector(activeSelector) : null;
    if (active && scroller && opts.scrollActive !== false) smoothScrollToItem(scroller, active, { duration: 0.32 });
  });
}
function miniQueueSkeleton() {
  return '<div class="mini-queue-skeleton"></div><div class="mini-queue-skeleton"></div><div class="mini-queue-skeleton"></div>';
}
function togglePlaylistPanel(force) {
  var el = document.getElementById('playlist-panel');
  if (force === false) el.classList.remove('show');
  else if (force === true) el.classList.add('show');
  else el.classList.toggle('show');
  if (el.classList.contains('show')) {
    if (window.gsap && !isPhoneQueueShell()) window.gsap.fromTo(el, { x: -12, autoAlpha: 0.92 }, { x: 0, autoAlpha: 1, duration: 0.22, ease: 'power2.out', overwrite: true });
    if (isPhoneQueueShell()) {
      el.classList.add('peek');
      document.body.classList.add('phone-queue-open');
      setPhoneQueueBackdrop(true);
      syncPhoneQueueBtn();
    }
    scheduleUiWarmTask(function(){
      flushDeferredQueuePanel('playlist-panel-open');
      if (!playQueue.length && queueViewTab === 'queue') switchPlaylistTab('playlists');
      if (playQueue.length && currentIdx >= 0 && queueViewTab !== 'queue') switchPlaylistTab('queue');
      if (queueViewTab === 'queue') animateVisiblePanelList(document.getElementById('queue-list'), '.queue-item', el, '.queue-item.now', { scrollActive: false });
      else if (queueViewTab === 'playlists') animateVisiblePanelList(document.getElementById('pl-list'), '.pl-card', el);
      else animateVisiblePanelList(document.getElementById('podcast-list'), '.pl-card', el);
    }, 180);
  } else if (isPhoneQueueShell()) {
    closePhonePlaylistPanel();
  }
}
function applyPlaylistPanelPinState(openPanel) {
  var panel = document.getElementById('playlist-panel');
  var btn = document.getElementById('playlist-pin-btn');
  if (panel) {
    panel.classList.toggle('pinned', !!playlistPanelPinned);
    if (playlistPanelPinned || openPanel) {
      panel.dataset.preserveTabOnOpen = '1';
      setPeek(panel, true, 'pl');
    }
  }
  if (btn) {
    btn.classList.toggle('active', !!playlistPanelPinned);
    btn.title = playlistPanelPinned ? '取消常开歌单' : '常开歌单';
  }
}
function setPlaylistPanelPinned(on, silent) {
  playlistPanelPinned = !!on;
  saveBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, playlistPanelPinned);
  applyPlaylistPanelPinState(playlistPanelPinned);
  if (!silent) showToast(playlistPanelPinned ? '左侧歌单已常开' : '左侧歌单已恢复自动隐藏');
}
function togglePlaylistPanelPinned() {
  setPlaylistPanelPinned(!playlistPanelPinned);
}
function applyFxPanelPinState() {
  var panel = document.getElementById('fx-panel');
  var btn = document.getElementById('fx-panel-pin-btn');
  var phone = false;
  try { phone = document.body.classList.contains('phone-shell'); } catch (_) {}
  if (panel) {
    panel.classList.toggle('pinned', !!fxPanelPinned);
    // 手机端固定只影响「打开后不自动收」，刷新时不要强行弹出控制台
    if (fxPanelPinned && diyPlayerMode && !phone) {
      panel.classList.add('peek');
      panel.classList.remove('closing');
      document.body.classList.add('fx-console-open');
      updateFxConsoleStatus();
      var fab = document.getElementById('fx-fab');
      if (fab) fab.classList.add('active');
    }
  }
  if (btn) {
    btn.classList.toggle('active', !!fxPanelPinned);
    btn.setAttribute('aria-pressed', fxPanelPinned ? 'true' : 'false');
    btn.title = fxPanelPinned ? '取消固定控制台' : '固定控制台';
    btn.setAttribute('aria-label', btn.title);
  }
}
function setFxPanelPinned(on, silent) {
  fxPanelPinned = !!on;
  saveBooleanPreference(FX_PANEL_PIN_STORE_KEY, fxPanelPinned);
  applyFxPanelPinState();
  if (!silent) showToast(fxPanelPinned ? 'DIY 控制台已固定' : 'DIY 控制台已恢复自动隐藏');
}
function toggleFxPanelPinned() {
  if (!diyPlayerMode) {
    showToast('请先开启 DIY 玩家模式');
    return;
  }
  setFxPanelPinned(!fxPanelPinned);
}
function upcomingQueueIndex() {
  if (!playQueue.length || currentIdx < 0) return -1;
  if (playMode === 'single') return currentIdx;
  if (playMode === 'shuffle') return -1;
  return (currentIdx + 1) % playQueue.length;
}
function queueItemPlaybackClass(i) {
  var cls = '';
  if (i === currentIdx) cls += ' now';
  var nextIdx = upcomingQueueIndex();
  if (nextIdx >= 0 && i === nextIdx && i !== currentIdx) cls += ' next-up';
  return cls;
}
function queuePlaybackBadgeHtml(i) {
  if (i === currentIdx) return '<span class="queue-play-badge now">播放中</span>';
  var nextIdx = upcomingQueueIndex();
  if (nextIdx >= 0 && i === nextIdx) return '<span class="queue-play-badge next">下一首</span>';
  return '';
}
function updateQueuePlaybackHints() {
  var hint = document.getElementById('queue-next-hint');
  var nextIdx = upcomingQueueIndex();
  if (hint) {
    if (nextIdx >= 0 && playQueue[nextIdx]) {
      var nextSong = playQueue[nextIdx];
      hint.textContent = '下一首 · ' + nextSong.name + (nextSong.artist ? ' — ' + nextSong.artist : '');
      hint.classList.add('show');
    } else if (playMode === 'shuffle' && playQueue.length > 1) {
      hint.textContent = '随机播放 · 队列共 ' + playQueue.length + ' 首';
      hint.classList.add('show');
    } else if (playMode === 'single' && playQueue[currentIdx]) {
      hint.textContent = '单曲循环 · ' + playQueue[currentIdx].name;
      hint.classList.add('show');
    } else {
      hint.textContent = '';
      hint.classList.remove('show');
    }
  }
  var $count = document.getElementById('mini-queue-count');
  if ($count) {
    if (!playQueue.length) $count.textContent = '0 首';
    else {
      var bits = [playQueue.length + ' 首'];
      if (currentIdx >= 0) bits.push('第 ' + (currentIdx + 1) + ' 首播放中');
      if (nextIdx >= 0 && playQueue[nextIdx]) bits.push('下一首 ' + playQueue[nextIdx].name);
      else if (playMode === 'shuffle' && playQueue.length > 1) bits.push('随机模式');
      $count.textContent = bits.join(' · ');
    }
  }
}
function scheduleQueueItemPrefetch(index) {
  index = Number(index);
  if (!isFinite(index) || index < 0 || index >= playQueue.length) return;
  clearTimeout(queueHoverPrefetchTimer);
  queueHoverPrefetchTimer = setTimeout(function(){
    var song = playQueue[index];
    if (!song) return;
    prefetchPlaybackSourceForSong(song);
    if (index === upcomingQueueIndex() || index === currentIdx + 1) prefetchPlaybackAudioForSong(song);
  }, 220);
}
function bindMiniQueueLazyRender() {
  var list = document.getElementById('mini-queue-list');
  if (!list || list._miniQueueLazyBound) return;
  list._miniQueueLazyBound = true;
  list.addEventListener('scroll', function(){
    if (!miniQueueOpen) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) growMiniQueueRenderLimit();
  }, { passive: true });
}
function bindQueuePlaybackPrefetch() {
  if (queuePrefetchBound) return;
  queuePrefetchBound = true;
  document.addEventListener('mouseover', function(e){
    var item = e.target && e.target.closest ? e.target.closest('[data-queue-index]') : null;
    if (!item) return;
    scheduleQueueItemPrefetch(item.getAttribute('data-queue-index'));
  }, { passive: true });
  document.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    var item = e.target && e.target.closest ? e.target.closest('[data-queue-index]') : null;
    if (!item) return;
    var index = Number(item.getAttribute('data-queue-index'));
    var song = playQueue[index];
    if (song) {
      prefetchPlaybackSourceForSong(song);
      prefetchPlaybackAudioForSong(song);
    }
  }, { passive: true });
}
function resetMiniQueueRenderLimit() {
  miniQueueRenderLimit = MINI_QUEUE_BATCH_SIZE;
}
function growMiniQueueRenderLimit() {
  if (!playQueue.length) return;
  var next = Math.min(playQueue.length, (miniQueueRenderLimit || MINI_QUEUE_BATCH_SIZE) + MINI_QUEUE_BATCH_SIZE);
  if (next <= miniQueueRenderLimit) return;
  miniQueueRenderLimit = next;
  renderMiniQueuePanel({ scrollCurrent: true });
}
function miniQueueVisibleSlice() {
  var total = playQueue.length;
  if (total <= MINI_QUEUE_BATCH_SIZE + 4) return { start: 0, end: total };
  var start = Math.max(0, currentIdx - 3);
  var end = Math.min(total, Math.max(start + miniQueueRenderLimit, currentIdx + 5));
  if (end - start < miniQueueRenderLimit) start = Math.max(0, end - miniQueueRenderLimit);
  var nextIdx = upcomingQueueIndex();
  if (nextIdx >= 0 && nextIdx >= end) end = Math.min(total, nextIdx + 1);
  if (nextIdx >= 0 && nextIdx < start) start = Math.max(0, nextIdx);
  return { start: start, end: end };
}
function scrollPlaylistPanelToCurrent() {
  var panel = document.getElementById('playlist-panel');
  var list = document.getElementById('queue-list');
  if (!panel || !list || queueViewTab !== 'queue') return;
  var now = performance.now();
  if (panel.__lastCurrentScrollAt && now - panel.__lastCurrentScrollAt < 650) return;
  panel.__lastCurrentScrollAt = now;
  requestAnimationFrame(function(){
    smoothScrollToItem(panel, list.querySelector('.queue-item.now'), { duration: 0.28, align: 0.34 });
  });
}
function switchPlaylistTab(tab) {
  tab = tab === 'podcasts' ? 'podcasts' : (tab === 'playlists' ? 'playlists' : 'queue');
  queueViewTab = tab;
  document.getElementById('tab-queue').classList.toggle('active', tab === 'queue');
  document.getElementById('tab-pl').classList.toggle('active', tab === 'playlists');
  var podcastTab = document.getElementById('tab-podcast');
  if (podcastTab) podcastTab.classList.toggle('active', tab === 'podcasts');
  document.getElementById('queue-pane').style.display = tab === 'queue' ? '' : 'none';
  document.getElementById('pl-pane').style.display = tab === 'playlists' ? '' : 'none';
  var podcastPane = document.getElementById('podcast-pane');
  if (podcastPane) podcastPane.style.display = tab === 'podcasts' ? '' : 'none';
  if (tab === 'playlists' || tab === 'podcasts') refreshUserPlaylists();
  if (tab === 'playlists') updateUserPlaylistProviderTabs();
  if (tab === 'queue') animateVisiblePanelList(document.getElementById('queue-list'), '.queue-item', document.getElementById('playlist-panel'), '.queue-item.now');
  if (tab === 'playlists') animateVisiblePanelList(document.getElementById('pl-list'), '.pl-card', document.getElementById('playlist-panel'));
  if (tab === 'podcasts') animateVisiblePanelList(document.getElementById('podcast-list'), '.pl-card', document.getElementById('playlist-panel'));
}
function isPhoneQueueShell() {
  try { return document.body.classList.contains('phone-shell'); } catch (_) { return false; }
}
function isPhonePlaylistOpen() {
  var panel = document.getElementById('playlist-panel');
  return !!(panel && (panel.classList.contains('show') || panel.classList.contains('peek')));
}
function syncPhoneQueueBtn() {
  var btn = document.getElementById('mini-queue-btn');
  if (!btn || !isPhoneQueueShell()) return;
  btn.classList.toggle('active', isPhonePlaylistOpen());
}
function setPhoneQueueBackdrop(on) {
  var bd = document.getElementById('phone-queue-backdrop');
  if (!bd) return;
  bd.hidden = !on;
  bd.setAttribute('aria-hidden', on ? 'false' : 'true');
}
function closePhonePlaylistPanel() {
  var panel = document.getElementById('playlist-panel');
  if (!panel) return;
  try {
    if (typeof peekTimers !== 'undefined' && peekTimers && peekTimers.pl) {
      clearTimeout(peekTimers.pl);
      peekTimers.pl = null;
    }
  } catch (_) {}
  panel.classList.remove('show', 'peek');
  document.body.classList.remove('phone-queue-open');
  setPhoneQueueBackdrop(false);
  syncPhoneQueueBtn();
}
function setMiniQueueOpen(open) {
  if (isPhoneQueueShell()) {
    // 手机端改走底部队列表，不再用迷你气泡
    if (open) {
      closeMiniQueueDesktopOnly();
      openPlaylistPanelTab('queue');
    } else {
      closePhonePlaylistPanel();
    }
    return;
  }
  miniQueueOpen = !!open;
  var pop = document.getElementById('mini-queue-popover');
  var btn = document.getElementById('mini-queue-btn');
  if (pop) pop.classList.toggle('show', miniQueueOpen);
  if (btn) btn.classList.toggle('active', miniQueueOpen);
  if (miniQueueOpen) {
    var seq = ++miniQueueRenderSeq;
    requestAnimationFrame(function(){
      if (seq !== miniQueueRenderSeq || !miniQueueOpen) return;
      renderMiniQueuePanel({ animate: true, scrollCurrent: true });
    });
    revealBottomControls(1300);
  }
}
function closeMiniQueueDesktopOnly() {
  miniQueueOpen = false;
  var pop = document.getElementById('mini-queue-popover');
  if (pop) pop.classList.remove('show');
}
function toggleMiniQueue(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (isPhoneQueueShell()) {
    closeMiniQueueDesktopOnly();
    if (isPhonePlaylistOpen()) {
      closePhonePlaylistPanel();
      return;
    }
    openPlaylistPanelTab('queue');
    if (typeof revealBottomControls === 'function') revealBottomControls(900);
    syncPhoneQueueBtn();
    return;
  }
  setMiniQueueOpen(!miniQueueOpen);
}
function closeMiniQueue() {
  if (isPhoneQueueShell()) {
    closePhonePlaylistPanel();
    return;
  }
  setMiniQueueOpen(false);
}
function openPlaylistPanelTab(tab, preserve) {
  tab = tab === 'podcasts' ? 'podcasts' : (tab === 'playlists' ? 'playlists' : 'queue');
  var panel = document.getElementById('playlist-panel');
  if (panel && panel.dataset && preserve !== false) panel.dataset.preserveTabOnOpen = '1';
  switchPlaylistTab(tab);
  setPeek(panel, true, 'pl');
  if (isPhoneQueueShell()) {
    panel.classList.add('show');
    document.body.classList.add('phone-queue-open');
    setPhoneQueueBackdrop(true);
    syncPhoneQueueBtn();
  }
}
window.closePhonePlaylistPanel = closePhonePlaylistPanel;
window.setPhoneQueueBackdrop = setPhoneQueueBackdrop;
window.syncPhoneQueueBtn = syncPhoneQueueBtn;
function renderMiniQueuePanel(opts) {
  opts = opts || {};
  var $list = document.getElementById('mini-queue-list');
  if (!$list) return;
  updateQueuePlaybackHints();
  if (!miniQueueOpen && !opts.animate && !opts.scrollCurrent) return;
  if (!playQueue.length) {
    $list.innerHTML = '<div class="mini-queue-empty">队列为空，先搜索或打开歌单</div>';
    return;
  }
  var slice = miniQueueVisibleSlice();
  var html = '';
  if (slice.start > 0) html += '<div class="mini-queue-empty" style="padding:8px 0;font-size:10.5px">… 上方还有 ' + slice.start + ' 首</div>';
  for (var i = slice.start; i < slice.end; i++) {
    var song = playQueue[i];
    var thumb = songCoverSrc(song, 60);
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="mini-queue-cover"></div>';
    html += '<div class="mini-queue-item' + queueItemPlaybackClass(i) + '" data-queue-index="' + i + '" onclick="playQueueAt(' + i + ')">' +
      imgTag +
      '<div class="mini-queue-info"><div class="mini-queue-name">' + queuePlaybackBadgeHtml(i) + '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(song.name) + '</span></div><div class="mini-queue-sub">' + escHtml(song.artist || '') + '</div></div>' +
      '<button class="mini-queue-remove mini-queue-next" onclick="event.stopPropagation();queueIndexNext(' + i + ')" title="下一首播放">下</button>' +
      '<button class="mini-queue-remove" onclick="event.stopPropagation();removeFromQueue(' + i + ')" title="移除">×</button>' +
    '</div>';
  }
  if (slice.end < playQueue.length) {
    html += '<button type="button" class="fx-mini-btn ghost" style="width:100%;margin-top:4px" onclick="growMiniQueueRenderLimit()">加载更多 ' + slice.end + '/' + playQueue.length + '</button>';
  }
  $list.innerHTML = html;
  if (opts.animate || opts.scrollCurrent) {
    requestAnimationFrame(function(){
      if (opts.animate) animateListItems($list, '.mini-queue-item', { x: 0, y: 6, stagger: 0.01, duration: 0.20, limit: 14 });
      if (opts.scrollCurrent) smoothScrollToItem($list, $list.querySelector('.mini-queue-item.now'), { duration: 0.30, align: 0.42 });
    });
  }
}
document.addEventListener('click', function(e){
  if (miniQueueOpen && !(e.target && e.target.closest && e.target.closest('#bottom-bar'))) closeMiniQueue();
});
bindSmoothQueueScrolling();
bindPlaylistPanelLazyRender();
bindQueuePanelLazyRender();
bindQueuePlaybackPrefetch();
bindMiniQueueLazyRender();
bindModalBackdropClose();
function resetQueuePanelRenderLimit() {
  queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
}
function growQueuePanelRenderLimit() {
  if (!playQueue.length) return;
  var next = Math.min(playQueue.length, (queuePanelRenderLimit || QUEUE_PANEL_BATCH_SIZE) + QUEUE_PANEL_BATCH_SIZE);
  if (next <= queuePanelRenderLimit) return;
  queuePanelRenderLimit = next;
  renderQueuePanel({ animate: false });
}
function bindQueuePanelLazyRender() {
  var panel = document.getElementById('playlist-panel');
  if (!panel || queuePanelLazyBound) return;
  queuePanelLazyBound = true;
  panel.addEventListener('scroll', function(){
    if (queueViewTab !== 'queue' || queuePanelRenderLimit >= playQueue.length) return;
    if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 180) growQueuePanelRenderLimit();
  }, { passive: true });
}
function queuePanelVisibleSlice() {
  var limit = Math.max(QUEUE_PANEL_BATCH_SIZE, Math.min(playQueue.length, queuePanelRenderLimit || QUEUE_PANEL_BATCH_SIZE));
  var nextIdx = upcomingQueueIndex();
  if (currentIdx >= 0 && currentIdx >= limit) limit = Math.min(playQueue.length, Math.max(limit, currentIdx + 1));
  if (nextIdx >= 0 && nextIdx >= limit) limit = Math.min(playQueue.length, nextIdx + 1);
  queuePanelRenderLimit = limit;
  return playQueue.slice(0, limit);
}
function renderQueuePanel(opts) {
  opts = opts || {};
  if (opts.reset) resetQueuePanelRenderLimit();
  var $ql = document.getElementById('queue-list');
  var seq = ++queueRenderSeq;
  if (!playQueue.length) {
    resetQueuePanelRenderLimit();
    $ql.innerHTML = '<div style="text-align:center;padding:24px 0;color:rgba(255,255,255,.32);font-size:11.5px">队列为空，搜索后点 + 设为下一首</div>';
    updateQueuePlaybackHints();
    renderMiniQueuePanel();
    var panel = document.getElementById('playlist-panel');
    if (panel && (panel.classList.contains('show') || panel.classList.contains('peek')) && queueViewTab === 'queue') switchPlaylistTab('playlists');
    schedulePlaybackSessionSave();
    return;
  }
  var visibleQueue = queuePanelVisibleSlice();
  var visibleCount = visibleQueue.length;
  $ql.innerHTML = visibleQueue.map(function(song, i){
    var thumb = songCoverSrc(song, 60);
    var imgTag = thumb
      ? (mineradioUsesWebMediaBridge()
        ? '<img src="' + thumb + '" data-cover-url="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="mineradioRetryCoverImg(this)">'
        : '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">')
      : '<div style="width:38px;height:38px;border-radius:6px;background:rgba(255,255,255,.06);flex-shrink:0"></div>';
    return '<div class="queue-item' + queueItemPlaybackClass(i) + '" data-queue-index="' + i + '" onclick="playQueueAt(' + i + ')">' +
      imgTag +
      '<div class="qi-info"><div class="qi-name">' + queuePlaybackBadgeHtml(i) + '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(song.name) + '</span></div><div class="qi-sub"><button class="queue-artist-link" type="button" onclick="event.stopPropagation();openQueueArtist(' + i + ')">' + escHtml(song.artist || '未知歌手') + '</button></div></div>' +
      '<div class="qi-act">' +
        '<button class="' + (isSongLiked(song) ? 'liked' : '') + '" onclick="event.stopPropagation();toggleLikeQueueIndex(' + i + ')" title="' + (isSongLiked(song) ? '取消红心' : '红心喜欢') + '">' + heartIconSvg() + '</button>' +
        '<button class="queue-next" onclick="event.stopPropagation();queueIndexNext(' + i + ')" title="下一首播放">下</button>' +
        '<button onclick="event.stopPropagation();collectQueueIndex(' + i + ')" title="收藏到歌单">' + playlistPlusIconSvg() + '</button>' +
        '<button onclick="event.stopPropagation();removeFromQueue(' + i + ')" title="移除">×</button>' +
      '</div>' +
    '</div>';
  }).join('');
  if (playQueue.length > visibleCount) {
    $ql.insertAdjacentHTML('beforeend', '<button type="button" class="fx-mini-btn ghost queue-load-more" onclick="growQueuePanelRenderLimit()">加载更多 ' + visibleCount + '/' + playQueue.length + '</button>');
  }
  updateQueuePlaybackHints();
  if (opts.animate && seq === queueRenderSeq) animateVisiblePanelList($ql, '.queue-item', document.getElementById('playlist-panel'), '.queue-item.now');
  renderMiniQueuePanel({ scrollCurrent: miniQueueOpen });
  if (opts.scrollCurrent !== false && queueViewTab === 'queue') scheduleUiWarmTask(scrollPlaylistPanelToCurrent, 80);
  schedulePlaybackSessionSave();
}
async function refreshUserPlaylists(force) {
  updateUserPlaylistProviderTabs();
  if (!loginStatus.loggedIn && !qqLoginStatus.loggedIn && !kgLoginStatus.loggedIn) {
    resetPlaylistPanelRenderLimit();
    document.getElementById('pl-list').innerHTML = '<div style="text-align:center;padding:24px 0;color:rgba(255,255,255,.32);font-size:11.5px">登录后显示个人歌单</div>';
    var podcastListLoggedOut = document.getElementById('podcast-list');
    if (podcastListLoggedOut) podcastListLoggedOut.innerHTML = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">登录后显示我的播客</div>';
    return;
  }
  if (force) resetPlaylistPanelRenderLimit();
  var hasCachedQQPlaylists = userPlaylists.some(function(pl){ return pl && pl.provider === 'qq'; });
  var hasCachedKGPlaylists = userPlaylists.some(function(pl){ return pl && pl.provider === 'kg'; });
  var needsQQRefresh = qqLoginStatus.loggedIn && !hasCachedQQPlaylists;
  var needsKGRefresh = kgLoginStatus.loggedIn && !hasCachedKGPlaylists;
  if (!force && !needsQQRefresh && !needsKGRefresh && (userPlaylists.length || myPodcastCollections.length)) {
    if (Date.now() - userPlaylistsCacheAt < USER_PLAYLISTS_TTL_MS) {
      var cachedAnimate = isPlaylistPanelVisibleForRender();
      renderUserPlaylistsList({ animate: cachedAnimate });
      renderMyPodcastCollections({ animate: cachedAnimate });
      return;
    }
  }
  var $pl = document.getElementById('pl-list');
  if ($pl) {
    $pl.innerHTML = miniQueueSkeleton();
    if (window.gsap) animateListItems($pl, '.mini-queue-skeleton', { x: 0, y: 6, stagger: 0.018, duration: 0.18, limit: 3 });
  }
  var $pod = document.getElementById('podcast-list');
  if ($pod) $pod.innerHTML = miniQueueSkeleton();
  try {
    var result = await Promise.all([
      loginStatus.loggedIn ? apiJson('/api/user/playlists') : Promise.resolve({ playlists: [] }),
      (loginStatus.loggedIn && queueViewTab === 'podcasts') ? apiJson('/api/podcast/my') : Promise.resolve({ collections: myPodcastCollections || [], loggedIn: loginStatus.loggedIn }),
      qqLoginStatus.loggedIn ? apiJson('/api/qq/user/playlists') : Promise.resolve({ playlists: [] }),
      kgLoginStatus.loggedIn ? apiJson('/api/kg/user/playlists') : Promise.resolve({ playlists: [] })
    ]);
    var neteaseLists = (result[0].playlists || []).map(function(pl){ pl.provider = 'netease'; pl.source = 'netease'; return pl; });
    if (loginStatus.loggedIn && loginStatus.pendingProfile && result[0].userId) {
      loginStatus.userId = result[0].userId;
      if (result[0].nickname) loginStatus.nickname = result[0].nickname;
      loginStatus.pendingProfile = false;
      renderUserBtn();
    }
    var prevPlaylistCount = userPlaylists.length;
    qqPlaylists = (result[2].playlists || []).map(function(pl){ pl.provider = 'qq'; pl.source = 'qq'; return pl; });
    var kgPlaylists = (result[3].playlists || []).map(function(pl){ pl.provider = 'kg'; pl.source = 'kg'; return pl; });
    userPlaylists = neteaseLists.concat(qqPlaylists).concat(kgPlaylists);
    userPlaylistsCacheAt = Date.now();
    reindexUserPlaylistsGrouped();
    myPodcastCollections = result[1].collections || [];
    if (kgLoginStatus.loggedIn && kgPlaylists.length && !hasPlatformLogin('netease') && !hasPlatformLogin('qq')) {
      userPlaylistProviderTab = 'kg';
      saveUserPlaylistProviderTab();
    } else if (kgLoginStatus.loggedIn && kgPlaylists.length && normalizeUserPlaylistProvider(userPlaylistProviderTab) !== 'kg' && force) {
      // Keep current tab, but make shelf/list data available; toast once if empty-looking for KG users refreshing.
    }
    if (kgLoginStatus.loggedIn && force) {
      var kgPl = result[3] || {};
      if (kgPl.message) showToast(kgPl.message);
      else if (!kgPlaylists.length) showToast('酷狗歌单为空（source=' + (kgPl.source || 'empty') + '）');
      else showToast('已同步酷狗歌单 ' + kgPlaylists.length + ' 个');
    }
    var animatePanel = isPlaylistPanelVisibleForRender();
    renderUserPlaylistsList({ animate: animatePanel, reset: force });
    renderMyPodcastCollections({ animate: animatePanel });
    updateUserPlaylistProviderTabs();
    if (emptyHomeActive) renderHomeDiscover();
    if (force || userPlaylists.length !== prevPlaylistCount || kgPlaylists.length) scheduleShelfRebuild('refresh-user-playlists', true);
    try {
      if (window.MineradioFolia && typeof MineradioFolia.isWallOpen === 'function' && MineradioFolia.isWallOpen() && typeof MineradioFolia.refresh === 'function') {
        MineradioFolia.refresh();
      }
    } catch (_) {}
  } catch (e) { console.warn(e); }
}
var playlistPanelDetailState = { key: '', loading: false, playlist: null, tracks: [], token: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER };
function playlistPanelKey(provider, id) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
  return provider + ':' + String(id || '');
}
function playlistPanelProviderId(provider, id) {
  if (provider === 'qq') return 'qq:' + id;
  if (provider === 'kg') return 'kg:' + id;
  return id;
}
function findQQPlaylistById(pid) {
  pid = String(pid || '');
  return (userPlaylists || []).find(function(pl) {
    return pl && pl.provider === 'qq' && String(pl.id || pl.qqId || '') === pid;
  }) || (qqPlaylists || []).find(function(pl) {
    return pl && String(pl.id || pl.qqId || '') === pid;
  }) || null;
}
function qqPlaylistTracksApiUrl(plOrId, dirid) {
  var pl = typeof plOrId === 'object' ? plOrId : findQQPlaylistById(plOrId);
  var id = pl ? (pl.id || pl.qqId || '') : String(plOrId || '');
  var dir = dirid != null && dirid !== '' ? dirid : (pl && pl.dirid);
  var url = '/api/qq/playlist/tracks?id=' + encodeURIComponent(String(id || ''));
  if (dir != null && dir !== '') url += '&dirid=' + encodeURIComponent(String(dir));
  return url;
}
function playlistPanelDetailHtml(pl, provider) {
  var key = playlistPanelKey(provider, pl && pl.id);
  if (playlistPanelDetailState.key !== key) return '';
  var tracks = playlistPanelDetailState.tracks || [];
  var loading = playlistPanelDetailState.loading;
  var cover = pl && pl.cover ? ((provider === 'qq' || provider === 'kg') ? pl.cover : (pl.cover + '?param=96y96')) : '';
  var img = cover ? '<img class="pl-detail-cover" src="' + escHtml(cover) + '" alt="" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="pl-detail-cover"></div>';
  var renderLimit = loading ? 0 : Math.max(PLAYLIST_DETAIL_INITIAL_RENDER, playlistPanelDetailState.renderLimit || PLAYLIST_DETAIL_INITIAL_RENDER);
  renderLimit = Math.min(tracks.length, renderLimit);
  var visibleTracks = loading ? [] : tracks.slice(0, renderLimit);
  var rows = loading
    ? '<div class="pl-detail-row"><div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06)"></div><div style="flex:1;min-width:0"><div class="pl-detail-row-title">正在载入歌单</div><div class="pl-detail-row-artist">请稍候</div></div></div>'
    : visibleTracks.map(function(song, i){
        var thumb = songCoverSrc(song, 60);
        var imgTag = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
        return '<div class="pl-detail-row" data-pl-detail-row="' + i + '">' +
          imgTag +
          '<div style="flex:1;min-width:0"><div class="pl-detail-row-title">' + escHtml(song.name || '') + '</div>' +
          '<button type="button" class="pl-detail-row-artist" data-pl-detail-artist="' + i + '">' + escHtml(song.artist || '未知歌手') + '</button></div>' +
        '</div>';
      }).join('');
  if (!loading && !rows) rows = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.30);font-size:11.5px">歌单暂无可播放歌曲</div>';
  if (!loading && tracks.length > renderLimit) {
    rows += '<button type="button" class="fx-mini-btn ghost pl-detail-load-more" data-pl-detail-load-more="1">加载更多 ' + renderLimit + '/' + tracks.length + '</button>';
  } else if (!loading && tracks.length > PLAYLIST_DETAIL_INITIAL_RENDER) {
    rows += '<div class="pl-detail-progress">已显示全部 ' + tracks.length + ' 首</div>';
  }
  return '<div class="pl-inline-detail" data-pl-detail="' + escHtml(key) + '">' +
    '<div class="pl-detail-sticky">' +
      '<div class="pl-detail-head">' + img + '<div style="flex:1;min-width:0"><div class="pl-detail-title">' + escHtml(pl.name || '歌单详情') + '</div><div class="pl-detail-sub">' + escHtml((pl.trackCount || tracks.length || 0) + ' 首 · ' + (pl.creator || (provider === 'qq' ? 'QQ 音乐' : (provider === 'kg' ? '酷狗音乐' : '网易云音乐')))) + '</div></div><div class="pl-detail-count">' + (loading ? '载入中' : (renderLimit + '/' + tracks.length)) + '</div></div>' +
      '<div class="pl-detail-actions"><button class="pl-detail-play" type="button" data-pl-detail-play="' + escHtml(key) + '"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放歌单</button><button class="fx-mini-btn ghost pl-detail-top-btn" type="button" data-pl-detail-top="1">回到顶部</button></div>' +
    '</div>' +
    '<div class="pl-detail-list">' + rows + '</div>' +
  '</div>';
}
function renderPlaylistPanelDetailState() {
  renderUserPlaylistsList();
}
function scrollPlaylistPanelToTop() {
  var panel = document.getElementById('playlist-panel');
  if (!panel) return;
  try { panel.scrollTo({ top: 0, behavior: 'smooth' }); }
  catch (e) { panel.scrollTop = 0; }
}
function scrollPlaylistPanelDetailIntoView(key) {
  var panel = document.getElementById('playlist-panel');
  if (!panel || !key) return;
  requestAnimationFrame(function(){
    var detail = null;
    Array.prototype.some.call(panel.querySelectorAll('[data-pl-detail]'), function(node){
      if (node.getAttribute('data-pl-detail') === key) {
        detail = node;
        return true;
      }
      return false;
    });
    if (!detail) return;
    var anchor = detail.previousElementSibling || detail;
    var top = Math.max(0, anchor.offsetTop - 10);
    try { panel.scrollTo({ top: top, behavior: 'smooth' }); }
    catch (e) { panel.scrollTop = top; }
  });
}
async function openPlaylistPanelDetail(provider, pid, title, dirid) {
  if (!pid) return;
  provider = provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
  var key = playlistPanelKey(provider, pid);
  var pl = userPlaylists.find(function(item){ return playlistPanelKey(item.provider, item.id) === key; }) || { id: pid, provider: provider, name: title || '歌单详情', dirid: dirid || '' };
  if (provider === 'qq' && !pl.dirid && dirid) pl.dirid = dirid;
  if (playlistPanelDetailState.key === key && !playlistPanelDetailState.loading && playlistPanelDetailState.tracks.length) {
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    playlistPanelDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
    renderPlaylistPanelDetailState();
    return;
  }
  var token = ++playlistPanelDetailState.token;
  playlistPanelDetailState = { key: key, loading: true, playlist: pl, tracks: [], token: token, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER };
  renderPlaylistPanelDetailState();
  scrollPlaylistPanelDetailIntoView(key);
  var tracksCacheKey = 'pl-tracks:' + key;
  var cachedTracks = detailCacheGet(tracksCacheKey);
  if (cachedTracks && cachedTracks.tracks && cachedTracks.tracks.length) {
    playlistPanelDetailState.loading = false;
    playlistPanelDetailState.tracks = cachedTracks.tracks.map(cloneSong);
    playlistPanelDetailState.renderLimit = Math.min(playlistPanelDetailState.tracks.length, PLAYLIST_DETAIL_INITIAL_RENDER);
    renderPlaylistPanelDetailState();
    return;
  }
  try {
    var r = provider === 'qq'
      ? await apiJson(qqPlaylistTracksApiUrl(pl))
      : (provider === 'kg'
        ? await apiJson('/api/kg/playlist/tracks?id=' + encodeURIComponent(pid)
          + (pl.globalCollectionId ? ('&globalCollectionId=' + encodeURIComponent(pl.globalCollectionId)) : ''))
        : await apiJson('/api/playlist/tracks?id=' + encodeURIComponent(pid)));
    if (playlistPanelDetailState.token !== token) return;
    playlistPanelDetailState.loading = false;
    playlistPanelDetailState.tracks = (r && r.tracks || []).map(cloneSong);
    // 酷狗「我喜欢」等歌单列表常无封面，用首曲封面回填
    if (provider === 'kg') {
      var kgCover = normalizeShelfCoverUrl((r.playlist && r.playlist.cover) || '')
        || (playlistPanelDetailState.tracks[0] ? (resolveSongCoverUrl(playlistPanelDetailState.tracks[0], 240) || '') : '');
      if (kgCover) {
        if (playlistPanelDetailState.playlist) playlistPanelDetailState.playlist.cover = kgCover;
        (userPlaylists || []).forEach(function(item) {
          if (item && songProviderKey(item) === 'kg' && String(item.id || item.listId || '') === String(pid)) {
            item.cover = kgCover;
          }
        });
        try { renderUserPlaylistsList(); } catch (_) {}
        try { scheduleShelfRebuild('kg-cover-backfill', true); } catch (_) {}
      }
    }
    detailCacheSet(tracksCacheKey, { tracks: playlistPanelDetailState.tracks.map(cloneSong) });
    playlistPanelDetailState.renderLimit = Math.min(playlistPanelDetailState.tracks.length, PLAYLIST_DETAIL_INITIAL_RENDER);
    renderPlaylistPanelDetailState();
  } catch (e) {
    console.warn('[PlaylistPanelDetail]', pid, e);
    if (playlistPanelDetailState.token !== token) return;
    playlistPanelDetailState.loading = false;
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
    renderPlaylistPanelDetailState();
    showToast('歌单详情加载失败');
  }
}
function playPlaylistPanelDetail() {
  var st = playlistPanelDetailState;
  if (!st || !st.key) return;
  var parts = st.key.split(':');
  var provider = parts[0] === 'qq' ? 'qq' : (parts[0] === 'kg' ? 'kg' : 'netease');
  var pid = parts.slice(1).join(':');
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, st.playlist && st.playlist.name || '');
}
function playPlaylistPanelDetailTrack(index) {
  var tracks = playlistPanelDetailState.tracks || [];
  if (!tracks[index]) return;
  playQueue = tracks.map(cloneSong);
  currentIdx = index;
  safeRenderQueuePanel('playlist-panel-detail');
  safeSwitchPlaylistTab('queue', 'playlist-panel-detail');
  safeShelfRebuild('playlist-panel-detail', true);
  forcePlaybackControlsInteractive();
  playQueueAt(index).catch(function(e){ console.warn('[PlaylistPanelDetailPlay]', e); });
}
function openPlaylistPanelDetailArtist(index) {
  var song = playlistPanelDetailState.tracks && playlistPanelDetailState.tracks[index];
  if (song) openArtistDetailForSong(song);
}
function growPlaylistPanelDetailRenderLimit(amount) {
  var st = playlistPanelDetailState;
  var total = st && st.tracks ? st.tracks.length : 0;
  if (!st || st.loading || !st.key || !total) return false;
  var current = Math.max(PLAYLIST_DETAIL_INITIAL_RENDER, st.renderLimit || PLAYLIST_DETAIL_INITIAL_RENDER);
  var next = Math.min(total, current + (amount || PLAYLIST_DETAIL_BATCH_SIZE));
  if (next <= current) return false;
  var panel = document.getElementById('playlist-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  st.renderLimit = next;
  renderPlaylistPanelDetailState();
  if (panel) panel.scrollTop = keepTop;
  return true;
}
function maybeGrowPlaylistPanelDetailRenderLimit() {
  var panel = document.getElementById('playlist-panel');
  var st = playlistPanelDetailState;
  if (!panel || !st || st.loading || !st.key || !st.tracks || st.renderLimit >= st.tracks.length) return;
  if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 240) {
    growPlaylistPanelDetailRenderLimit();
  }
}
function resetPlaylistPanelRenderLimit() {
  playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
  playlistGroupRenderLimit = { netease: PLAYLIST_PANEL_BATCH_SIZE, qq: PLAYLIST_PANEL_BATCH_SIZE, kg: PLAYLIST_PANEL_BATCH_SIZE };
}
function growPlaylistPanelRenderLimit() {
  reindexUserPlaylistsGrouped();
  var provider = normalizeUserPlaylistProvider(userPlaylistProviderTab);
  var items = userPlaylistsGrouped[provider] || [];
  var current = playlistGroupRenderLimit[provider] || PLAYLIST_PANEL_BATCH_SIZE;
  if (items.length <= current) return;
  playlistGroupRenderLimit[provider] = Math.min(items.length, current + PLAYLIST_PANEL_BATCH_SIZE);
  playlistPanelRenderLimit = Math.min(userPlaylists.length, (playlistPanelRenderLimit || PLAYLIST_PANEL_BATCH_SIZE) + PLAYLIST_PANEL_BATCH_SIZE);
  renderUserPlaylistsList({ animate: true });
}
function userPlaylistsHaveMoreToRender() {
  reindexUserPlaylistsGrouped();
  var provider = normalizeUserPlaylistProvider(userPlaylistProviderTab);
  var items = userPlaylistsGrouped[provider] || [];
  return items.length > (playlistGroupRenderLimit[provider] || PLAYLIST_PANEL_BATCH_SIZE);
}
function bindPlaylistPanelLazyRender() {
  var panel = document.getElementById('playlist-panel');
  if (!panel || playlistPanelLazyBound) return;
  playlistPanelLazyBound = true;
  panel.addEventListener('scroll', function(){
    maybeGrowPlaylistPanelDetailRenderLimit();
    if (queueViewTab !== 'playlists' || !userPlaylistsHaveMoreToRender()) return;
    if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 180) growPlaylistPanelRenderLimit();
  }, { passive: true });
}
function renderUserPlaylistsList(opts) {
  opts = opts || {};
  var $pl = document.getElementById('pl-list');
  if (!$pl) return;
  var seq = ++playlistRenderSeq;
  updateUserPlaylistProviderTabs();
  var provider = normalizeUserPlaylistProvider(userPlaylistProviderTab);
  reindexUserPlaylistsGrouped();
  var items = userPlaylistsGrouped[provider] || [];
  if (!hasPlatformLogin(provider)) {
    $pl.innerHTML = '<div style="text-align:center;padding:28px 12px 16px;color:rgba(255,255,255,.32);font-size:11.5px;line-height:1.65">' +
      escHtml(userPlaylistProviderLabel(provider)) + ' 未登录<br><button type="button" class="fx-mini-btn ghost" style="margin-top:12px" onclick="openProviderLogin(\'' + provider + '\')">前往登录</button></div>';
    return;
  }
  if (!items.length) {
    $pl.innerHTML = '<div style="text-align:center;padding:28px 12px 16px;color:rgba(255,255,255,.32);font-size:11.5px;line-height:1.65">暂无' + escHtml(userPlaylistProviderLabel(provider)) + '歌单<br><button type="button" class="fx-mini-btn ghost" style="margin-top:12px" onclick="refreshUserPlaylists(true)">刷新</button></div>';
    return;
  }
  function playlistCardHtml(pl) {
    var plProvider = pl.provider === 'qq' ? 'qq' : (pl.provider === 'kg' ? 'kg' : 'netease');
    var thumb = pl.cover ? ((plProvider === 'qq' || plProvider === 'kg') ? pl.cover : (pl.cover + '?param=88y88')) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.06);flex-shrink:0"></div>';
    var key = playlistPanelKey(plProvider, pl.id);
    var expanded = playlistPanelDetailState.key === key ? ' expanded' : '';
    return '<div class="pl-card' + expanded + '" data-playlist-provider="' + plProvider + '" data-playlist-id="' + escHtml(String(pl.id || '')) + '" data-playlist-dirid="' + escHtml(String(pl.dirid || '')) + '" data-playlist-title="' + escHtml(pl.name || '') + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pl.name) + '</div><div class="pl-sub">' + pl.trackCount + ' 首 · ' + escHtml(plProvider === 'kg' ? ((pl.isFavorite ? '我喜欢' : (pl.subscribed ? '收藏' : '自建')) + ' · ' + (pl.creator || '酷狗音乐')) : (pl.creator || '')) + '</div></div>' +
    '</div>' + playlistPanelDetailHtml(pl, plProvider);
  }
  if (opts.reset) resetPlaylistPanelRenderLimit();
  var limit = playlistGroupRenderLimit[provider] || PLAYLIST_PANEL_BATCH_SIZE;
  var visible = items.slice(0, limit);
  $pl.innerHTML = visible.map(playlistCardHtml).join('');
  if (userPlaylistsHaveMoreToRender()) {
    $pl.insertAdjacentHTML('beforeend', '<button type="button" class="fx-mini-btn ghost pl-load-more" data-pl-load-more="1">加载更多 ' + visible.length + '/' + items.length + '</button>');
  }
  if (opts.animate && seq === playlistRenderSeq) animateVisiblePanelList($pl, '.pl-card', document.getElementById('playlist-panel'));
}
function renderMyPodcastCollections(opts) {
  opts = opts || {};
  var $pod = document.getElementById('podcast-list');
  if (!$pod) return;
  if (!loginStatus.loggedIn) {
    $pod.innerHTML = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">登录后显示我的播客</div>';
    return;
  }
  var items = myPodcastCollections || [];
  if (!items.length) {
    $pod.innerHTML = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无播客数据</div>';
    return;
  }
  $pod.innerHTML = items.map(function(pc){
    var thumb = pc.cover ? coverUrlWithSize(pc.cover, 88) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>';
    return '<div class="pl-card podcast-card" data-podcast-key="' + escHtml(pc.key || '') + '" data-podcast-title="' + escHtml(pc.title || '') + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pc.title || '') + '</div><div class="pl-sub">' + (pc.count || 0) + ' 项 · ' + escHtml(pc.sub || '') + '</div></div>' +
    '</div>';
  }).join('');
  if (opts.animate) animateVisiblePanelList($pod, '.pl-card', document.getElementById('playlist-panel'));
}
document.getElementById('pl-list').addEventListener('click', function(e){
  var loadMore = e.target && e.target.closest ? e.target.closest('[data-pl-load-more]') : null;
  if (loadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelRenderLimit();
    return;
  }
  var detailLoadMore = e.target && e.target.closest ? e.target.closest('[data-pl-detail-load-more]') : null;
  if (detailLoadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelDetailRenderLimit();
    return;
  }
  var detailTop = e.target && e.target.closest ? e.target.closest('[data-pl-detail-top]') : null;
  if (detailTop) {
    e.preventDefault();
    e.stopPropagation();
    scrollPlaylistPanelToTop();
    return;
  }
  var playDetail = e.target && e.target.closest ? e.target.closest('[data-pl-detail-play]') : null;
  if (playDetail) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetail();
    return;
  }
  var artist = e.target && e.target.closest ? e.target.closest('[data-pl-detail-artist]') : null;
  if (artist) {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistPanelDetailArtist(Number(artist.getAttribute('data-pl-detail-artist')));
    return;
  }
  var row = e.target && e.target.closest ? e.target.closest('[data-pl-detail-row]') : null;
  if (row) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetailTrack(Number(row.getAttribute('data-pl-detail-row')));
    return;
  }
  var card = e.target && e.target.closest ? e.target.closest('.pl-card') : null;
  if (!card) return;
  var provider = card.getAttribute('data-playlist-provider') || 'netease';
  var pid = card.getAttribute('data-playlist-id') || '';
  var dirid = card.getAttribute('data-playlist-dirid') || '';
  openPlaylistPanelDetail(provider, pid, card.getAttribute('data-playlist-title') || '', dirid);
});
var podcastListEl = document.getElementById('podcast-list');
if (podcastListEl) {
  podcastListEl.addEventListener('click', function(e){
    if (e.target && e.target.closest && e.target.closest('[data-podcast-back]')) {
      renderMyPodcastCollections({ animate: true });
      return;
    }
    var radioCard = e.target && e.target.closest ? e.target.closest('[data-podcast-radio-id]') : null;
    if (radioCard) {
      loadPodcastRadioIntoQueue(radioCard.getAttribute('data-podcast-radio-id'), true, radioCard.getAttribute('data-podcast-title') || '');
      return;
    }
    var card = e.target && e.target.closest ? e.target.closest('[data-podcast-key]') : null;
    if (!card) return;
    openMyPodcastCollection(card.getAttribute('data-podcast-key'), card.getAttribute('data-podcast-title') || '');
  });
}
function renderMyPodcastRadioItems(key, title, items) {
  var $pod = document.getElementById('podcast-list');
  if (!$pod) return;
  if (!items.length) {
    $pod.innerHTML = '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title || '我的播客') + '</div><button class="fx-mini-btn ghost" data-podcast-back="1" style="height:24px;padding:0 9px;font-size:10.5px">返回</button></div>' +
      '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>';
    return;
  }
  $pod.innerHTML = '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title || '我的播客') + '</div><button class="fx-mini-btn ghost" data-podcast-back="1" style="height:24px;padding:0 9px;font-size:10.5px">返回</button></div>' +
    items.map(function(r){
      var thumb = r.cover ? coverUrlWithSize(r.cover, 88) : '';
      var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>';
      return '<div class="pl-card podcast-card podcast-child" data-podcast-radio-id="' + escHtml(String(r.id || r.radioId || '')) + '" data-podcast-title="' + escHtml(r.name || '') + '">' +
        imgTag +
        '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(r.name || '') + '</div><div class="pl-sub">' + escHtml((r.djName || r.artist || 'Podcast') + (r.programCount ? (' · ' + r.programCount + ' 集') : '')) + '</div></div>' +
      '</div>';
    }).join('');
  animateVisiblePanelList($pod, '.pl-card', document.getElementById('playlist-panel'));
}
async function openMyPodcastCollection(key, title) {
  if (!key) return;
  showLoading();
  try {
    var r = await apiJson('/api/podcast/my/items?key=' + encodeURIComponent(key) + '&limit=36');
    if (r && r.loggedIn === false) { showLoginModal(); return; }
    var items = r.items || [];
    myPodcastItems[key] = items;
    if (!items.length) {
      showToast('暂无内容: ' + (title || key));
      renderMyPodcastRadioItems(key, title, []);
      return;
    }
    if (r.itemType === 'voice' || (items[0] && items[0].type === 'podcast')) {
      playQueue = items.map(cloneSong);
      currentIdx = 0;
      safeRenderQueuePanel('podcast-collection-voice');
      safeSwitchPlaylistTab('queue', 'podcast-collection-voice');
      safeShelfRebuild('podcast-collection-voice', true);
      forcePlaybackControlsInteractive();
      await playQueueAt(0);
      showToast('载入: ' + (title || '喜欢的声音'));
      return;
    }
    renderMyPodcastRadioItems(key, title, items);
  } catch (e) {
    console.warn(e);
    showToast('播客加载失败');
  } finally {
    hideLoading();
  }
}
async function loadPodcastRadioIntoQueue(id, autoplay, title) {
  if (!id) return;
  showLoading();
  try {
    var r = await apiJson('/api/podcast/programs?id=' + encodeURIComponent(id) + '&limit=36');
    if (r.error) { showToast('播客加载失败: ' + r.error); return; }
    if (!r.programs || !r.programs.length) { showToast('播客暂无可播放节目'); return; }
    playQueue = r.programs.map(cloneSong);
    currentIdx = 0;
    safeRenderQueuePanel('podcast-radio');
    safeSwitchPlaylistTab('queue', 'podcast-radio');
    safeShelfRebuild('podcast-radio', true);
    forcePlaybackControlsInteractive();
    if (autoplay) await playQueueAt(0);
    showToast('载入: ' + (title || '播客'));
  } catch (e) {
    console.warn(e);
    showToast('播客加载失败');
  } finally {
    hideLoading();
  }
}
async function loadPlaylistIntoQueueById(id, autoplay, title) {
  if (!id) return;
  homeForcedOpen = false;
  homeSuppressed = false;
  updateEmptyHomeVisibility();
  showLoading();
  var qqPlaylistId = String(id || '').indexOf('qq:') === 0 ? String(id).slice(3) : '';
  var kgPlaylistId = String(id || '').indexOf('kg:') === 0 ? String(id).slice(3) : '';
  var kgMeta = kgPlaylistId
    ? (userPlaylists || []).find(function(pl){
        return songProviderKey(pl) === 'kg' && String(pl.id || pl.listId || '') === String(kgPlaylistId);
      })
    : null;
  var r = null;
  try {
    r = qqPlaylistId
      ? await apiJson(qqPlaylistTracksApiUrl(qqPlaylistId))
      : (kgPlaylistId
        ? await apiJson('/api/kg/playlist/tracks?id=' + encodeURIComponent(kgPlaylistId)
          + (kgMeta && kgMeta.globalCollectionId
            ? ('&globalCollectionId=' + encodeURIComponent(kgMeta.globalCollectionId))
            : ''))
        : await apiJson('/api/playlist/tracks?id=' + encodeURIComponent(id)));
  } catch (e) {
    console.warn('[PlaylistLoadApi]', id, e);
    showToast('歌单加载失败');
    hideLoading();
    return;
  }
  try {
    if (r.error) { showToast('歌单加载失败: ' + r.error); return; }
    if (!r.tracks || !r.tracks.length) { showToast('歌单为空'); return; }
    playQueue = r.tracks.map(cloneSong);
    if (!qqPlaylistId && isLikedPlaylistContext(id, title, r.playlist)) markSongsLiked(playQueue, true);
    if (!qqPlaylistId) syncLikeStatusForSongs(playQueue);
    currentIdx = 0;
    safeRenderQueuePanel('playlist-load');
    safeSwitchPlaylistTab('queue', 'playlist-load');
    safeShelfRebuild('playlist-load', true);
    forcePlaybackControlsInteractive();
    if (autoplay) {
      try {
        await playQueueAt(0);
      } catch (playErr) {
        console.warn('[PlaylistAutoplay]', id, playErr);
        showToast('歌单已载入，播放启动失败');
      }
    }
    forcePlaybackControlsInteractive();
    showToast('载入: ' + (title || ('歌单 ' + id)));
  } catch (e) {
    console.warn('[PlaylistLoadState]', id, e);
    forcePlaybackControlsInteractive();
    showToast('歌单已载入，界面刷新失败');
  } finally {
    hideLoading();
  }
}

// 进度条
var progressDragState = { active: false, lastParticleAt: 0 };
function normalizePlaybackDurationSeconds(value) {
  var raw = Number(value);
  if (!isFinite(raw) || raw <= 0) return 0;
  return raw > 1000 ? raw / 1000 : raw;
}
function playbackDurationFromSong(song) {
  if (!song) return 0;
  return normalizePlaybackDurationSeconds(song.duration || song.durationMs || song.dt || 0);
}
function getPlaybackDurationSeconds() {
  if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return playbackDurationFromSong(currentCoverSong());
}
function getPlaybackCurrentSeconds() {
  if (audio && audio.src && isFinite(audio.currentTime)) return Math.max(0, audio.currentTime);
  return Math.max(0, Number(restoredPlaybackSeconds) || 0);
}
var PLAYBACK_SESSION_STORE_KEY = 'mineradio-playback-session-v1';
var restoredPlaybackSeconds = 0;
var pendingPlaybackResumeAt = 0;
var playbackSessionSaveTimer = 0;
function slimPlaybackSong(song) {
  if (!song || typeof song !== 'object') return null;
  var drop = { lyric: 1, lyrics: 1, lrc: 1, yrc: 1, yrcRaw: 1, trans: 1, roma: 1, words: 1, raw: 1, comment: 1, comments: 1 };
  var out = {};
  Object.keys(song).forEach(function(key) {
    if (drop[key]) return;
    var value = song[key];
    if (typeof value === 'function') return;
    if (typeof value === 'string' && value.length > 4000) return;
    if (value && typeof value === 'object') {
      try {
        if (JSON.stringify(value).length > 6000) return;
      } catch (e) { return; }
    }
    out[key] = value;
  });
  return out.name || out.id || out.mid || out.hash ? out : null;
}
function writePlaybackSession() {
  try {
    if (!playQueue || !playQueue.length || currentIdx < 0) {
      localStorage.removeItem(PLAYBACK_SESSION_STORE_KEY);
      return;
    }
    var songs = [];
    for (var i = 0; i < playQueue.length && songs.length < 80; i++) {
      var slim = slimPlaybackSong(playQueue[i]);
      if (slim) songs.push(slim);
    }
    if (!songs.length) return;
    var time = getPlaybackCurrentSeconds();
    localStorage.setItem(PLAYBACK_SESSION_STORE_KEY, JSON.stringify({
      index: Math.max(0, Math.min(currentIdx, songs.length - 1)),
      time: time,
      songs: songs
    }));
  } catch (e) {}
}
function schedulePlaybackSessionSave() {
  if (playbackSessionSaveTimer) clearTimeout(playbackSessionSaveTimer);
  playbackSessionSaveTimer = setTimeout(function() {
    playbackSessionSaveTimer = 0;
    writePlaybackSession();
  }, 700);
}
function consumePlaybackResumeAt() {
  var time = pendingPlaybackResumeAt;
  pendingPlaybackResumeAt = 0;
  restoredPlaybackSeconds = 0;
  return time;
}
function restorePlaybackSession() {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(PLAYBACK_SESSION_STORE_KEY) || 'null'); } catch (e) {}
  if (!raw || !Array.isArray(raw.songs) || !raw.songs.length) return;
  if (playQueue && playQueue.length) return;
  playQueue = raw.songs.map(function(song) { return cloneSong(song); }).filter(Boolean);
  if (!playQueue.length) return;
  currentIdx = Math.max(0, Math.min(Number(raw.index) || 0, playQueue.length - 1));
  pendingPlaybackResumeAt = Math.max(0, Number(raw.time) || 0);
  restoredPlaybackSeconds = pendingPlaybackResumeAt;
  var song = playQueue[currentIdx];
  try {
    var hint = document.getElementById('hint');
    if (hint) hint.classList.add('hidden');
    var title = document.getElementById('thumb-title');
    var artist = document.getElementById('thumb-artist');
    if (title) title.textContent = song.name || '';
    if (artist) artist.textContent = song.artist || '';
    if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
    var thumb = document.getElementById('thumb-wrap');
    if (thumb) thumb.classList.add('visible');
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility();
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('restore-session');
    else if (typeof renderQueuePanel === 'function') renderQueuePanel();
    updatePlaybackProgressUi();
  } catch (e) {}
  if (typeof showToast === 'function') showToast('已恢复上次队列，点播放可从进度继续');
}
function setProgressVisual(percent) {
  percent = clampRange(percent || 0, 0, 100);
  var fill = document.getElementById('progress-fill');
  var thumb = document.getElementById('progress-thumb');
  if (fill) fill.style.width = percent + '%';
  if (thumb) thumb.style.left = percent + '%';
}
function updatePlaybackProgressUi() {
  var durationSec = getPlaybackDurationSeconds();
  var currentSec = getPlaybackCurrentSeconds();
  if (durationSec > 0 && currentSec > durationSec) currentSec = durationSec;
  setProgressVisual(durationSec > 0 ? (currentSec / durationSec * 100) : 0);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay) timeDisplay.textContent = formatProgramTime(currentSec) + ' / ' + (durationSec > 0 ? formatProgramTime(durationSec) : '0:00');
}
function bindPlaybackProgressEvents(audioEl) {
  if (!audioEl || audioEl._mineradioProgressBound) return;
  audioEl._mineradioProgressBound = true;
  ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'play', 'pause', 'emptied'].forEach(function(name){
    audioEl.addEventListener(name, updatePlaybackProgressUi);
  });
  audioEl.addEventListener('timeupdate', maybePrefetchNextTrackDuringPlayback);
  audioEl.addEventListener('timeupdate', schedulePlaybackSessionSave);
  audioEl.addEventListener('pause', writePlaybackSession);
  audioEl.addEventListener('seeked', writePlaybackSession);
  ['play', 'playing', 'pause', 'ended', 'emptied', 'abort', 'error'].forEach(function(name){
    audioEl.addEventListener(name, function(){ syncPlaybackStateFromAudioEvent(name); });
  });
  audioEl.addEventListener('error', function(){
    console.warn('[PlaybackAudio]', audioEl.error, audioEl.src);
    updatePlaybackProgressUi();
    if (mineradioUsesWebMediaBridge() && currentIdx >= 0 && !audioEl._mineradioRefreshAttempt) {
      audioEl._mineradioRefreshAttempt = true;
      refreshCurrentPlaybackStream({ resumeAt: audioEl.currentTime || 0, silent: true }).then(function(ok){
        if (!ok) showToast('音频加载失败，请确认 Bridge 扩展已启用后刷新页面');
      });
      return;
    }
    if (mineradioUsesWebMediaBridge()) showToast('音频加载失败，请确认 Bridge 扩展已启用后刷新页面');
  });
}
function emitProgressDragParticles(x, y) {
  var now = performance.now();
  if (now - progressDragState.lastParticleAt < 46) return;
  progressDragState.lastParticleAt = now;
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    dot.className = 'progress-drag-particle';
    var dx = (Math.random() - 0.5) * 34;
    var dy = -10 - Math.random() * 28;
    dot.style.setProperty('--px', x + 'px');
    dot.style.setProperty('--py', y + 'px');
    dot.style.setProperty('--dx', dx + 'px');
    dot.style.setProperty('--dy', dy + 'px');
    document.body.appendChild(dot);
    setTimeout((function(el){ return function(){ if (el && el.parentNode) el.parentNode.removeChild(el); }; })(dot), 700);
  }
}
function seekFromProgressPointer(e, emitParticles) {
  var durationSec = getPlaybackDurationSeconds();
  if (!audio || !durationSec) return;
  var bar = document.getElementById('progress-bar');
  var rect = bar.getBoundingClientRect();
  var ratio = clampRange((e.clientX - rect.left) / rect.width, 0, 1);
  audio.currentTime = ratio * durationSec;
  setProgressVisual(ratio * 100);
  syncBeatMapPlaybackCursor(audio.currentTime);
  if (emitParticles) emitProgressDragParticles(e.clientX, rect.top + rect.height / 2);
}
var progressBar = document.getElementById('progress-bar');
progressBar.addEventListener('pointerdown', function(e){
  if (!audio || !getPlaybackDurationSeconds()) return;
  progressDragState.active = true;
  progressBar.classList.add('is-dragging');
  try { progressBar.setPointerCapture(e.pointerId); } catch (err) {}
  seekFromProgressPointer(e, true);
});
progressBar.addEventListener('pointermove', function(e){
  if (!progressDragState.active) return;
  seekFromProgressPointer(e, true);
});
function endProgressDrag(e) {
  if (!progressDragState.active) return;
  progressDragState.active = false;
  progressBar.classList.remove('is-dragging');
  try { progressBar.releasePointerCapture(e.pointerId); } catch (err) {}
}
progressBar.addEventListener('pointerup', endProgressDrag);
progressBar.addEventListener('pointercancel', endProgressDrag);
progressBar.addEventListener('lostpointercapture', function(){ progressDragState.active = false; progressBar.classList.remove('is-dragging'); });
function tickPlaybackProgressUi() {
  if (mineradioUsesWebMediaBridge() && document.hidden && !progressDragState.active) return;
  if (!audio) { updatePlaybackProgressUi(); return; }
  updateListenStatsTick(false);
  updatePlaybackProgressUi();
  if (audio && isFinite(audio.currentTime)) updateLyricsHighlight();
}
setInterval(tickPlaybackProgressUi, 200);

// ============================================================
//  文件拖放
// ============================================================
document.getElementById('file-input').addEventListener('change', function(e){ handleFiles(e.target.files); e.target.value = ''; });
function handleFiles(files) {
  var audioFile = null, imgFile = null;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.type.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a)$/i.test(f.name)) audioFile = f;
    else if (f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(f.name)) imgFile = f;
  }
  if (audioFile) {
    finalizeListenSession(false);
    var url = URL.createObjectURL(audioFile);
    var localTitle = audioFile.name.replace(/\.[^.]+$/, '');
    trackSwitchToken++;
    var token = trackSwitchToken;
    var firstVisualPlay = !firstPlayDone;
    if (localBeatAnalysis.active) cancelLocalBeatAnalysis();
    closeGsapModal(document.getElementById('local-beat-modal'));
    cancelBeatAnalysisTimer();
    cancelDjBeatAnalysisTimer();
    beatMapToken++;
    djBeatMapToken++;
    setDjModeActive(false);
    currentBeatMap = null;
    resetDjBeatMapState();
    beatMapNextIdx = 0;
    resetAudioVisualState();
    resetBeatCameraSync(0);
    currentIdx = -1;
    currentLocalSong = hydrateCustomCover({
      type: 'local',
      name: localTitle,
      artist: '本地文件',
      localKey: [audioFile.name, audioFile.size || 0, audioFile.lastModified || 0].join(':'),
      localUrl: url,
      duration: 0
    });
    updateCustomCoverButton();
    document.getElementById('hint').classList.add('hidden');
    document.getElementById('thumb-title').textContent = localTitle;
    document.getElementById('thumb-artist').textContent = '本地文件';
    updateControlTrackInfo({ name: localTitle, artist: '本地文件' });
    document.getElementById('thumb-wrap').classList.add('visible');
    safeRenderQueuePanel('play-local-file');
    safeShelfRebuild('play-local-file', true);
    suppressShelfPreviewForPlaybackSwitch();
    if (firstVisualPlay) { firstPlayDone = true; tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 260); }
    if (!audio) { audio = new Audio(); configurePlaybackAudioElement(audio, url); }
    else audio.pause();
    bindPlaybackProgressEvents(audio);
    applyVolumeToAudio();
    audio.src = url;
    updatePlaybackProgressUi();
    lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;
    audio.onended = function(){ finalizeListenSession(true); playing = false; setPlayIcon(false); };
    audio.onloadedmetadata = function(){
      if (currentLocalSong && currentLocalSong.localUrl === url) {
        currentLocalSong.duration = audio && isFinite(audio.duration) ? audio.duration : 0;
        if (lyricSourceMode === 'custom') applyCustomLyricState(currentLocalSong, true);
      }
    };
    var localLyricLines = withLyricFallback([]);
    setOriginalLyricsState(localLyricLines, false, 'fallback');
    applyPreferredLyricsForCurrent(true);
    document.getElementById('trial-banner').classList.remove('show');
    audio.load();
    playAudio().then(function(ok){
      if (ok && currentLocalSong && currentLocalSong.localUrl === url) beginListenSession(currentLocalSong, null);
    });
    setTimeout(function(){
      if (currentLocalSong && currentLocalSong.localUrl === url) prepareLocalBeatAnalysis(currentLocalSong, url);
    }, 520);
    var localCover = getCustomCoverForSong(currentLocalSong);
    var localCoverOpts = { trackToken: token, deferHeavy: firstVisualPlay, delay: firstVisualPlay ? 60 : 0, timeout: firstVisualPlay ? 300 : 180 };
    if (localCover) applyCoverDataUrl(localCover, localCoverOpts);
    else if (!imgFile) loadCoverFromUrl('', localCoverOpts);
  }
  if (imgFile) {
    var uploadCoverOpts = audioFile
      ? { trackToken: trackSwitchToken, deferHeavy: !!firstVisualPlay, delay: firstVisualPlay ? 60 : 0, timeout: firstVisualPlay ? 300 : 180 }
      : null;
    loadCoverFromFile(imgFile, uploadCoverOpts);
  }
  if (!audioFile) updateCustomCoverButton();
}
var dropOv = document.getElementById('drop-overlay'), dragCount = 0;
document.addEventListener('dragenter', function(e){ e.preventDefault(); dragCount++; dropOv.classList.add('show'); });
document.addEventListener('dragleave', function(e){ e.preventDefault(); dragCount--; if (dragCount<=0){ dragCount=0; dropOv.classList.remove('show'); } });
document.addEventListener('dragover',  function(e){ e.preventDefault(); });
document.addEventListener('drop', function(e){
  e.preventDefault(); dragCount = 0; dropOv.classList.remove('show');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
// ============================================================
var presetMeta = [
  { name: 'emily专辑封面',  desc: '封面粒子 · 快速入场' },
  { name: '滚筒', desc: '隧道 · 沉浸感' },
  { name: '星球',  desc: '星球 · 雕塑感' },
  { name: '虚空', desc: '无粒子 · 自定义背景' },
  { name: '唱片', desc: '唱片 · 圆形封面' },
  { name: '星河', desc: '壁纸粒子 · 音乐律动' },
  { name: '安魂', desc: '骷髅·YUI7W', descHtml: '骷髅·<span class="pc-yui7w">YUI7W</span>' },
  { name: '音域地形', nameHtml: '音域地形 <span class="pc-name-en">Sonic-Topography</span>', desc: '作者 Ajin', descHtml: '作者 <span class="pc-author-ajin">Ajin</span>' },
];
var presetIcons = [
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 14c3-2 5-2 8 0s5 2 8 0M3 10c3-2 5-2 8 0s5 2 8 0M3 18c3-2 5-2 8 0s5 2 8 0"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><path d="M5 12a7 7 0 0 0 14 0"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7"/><path d="M8.8 8.8l6.4 6.4"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.4"/><path d="M16.5 5.2c2.1.9 3.4 2.4 4 4.5"/><path d="M18.8 3.2l1.5 4.8"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 15c2.2-4.4 4.4-4.4 6.6 0s4.4 4.4 6.6 0S20.6 10.6 23 15"/><path d="M3 9c2.2 2.2 4.4 2.2 6.6 0s4.4-2.2 6.6 0S20.6 11.2 23 9"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.2h4v6.2h4.2v3.8H14v7.6h-4v-7.6H5.8V9.4H10z"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M3 12c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 6c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><circle cx="18" cy="5" r="1.2" fill="currentColor"/></svg>',
];
var presetDisplayOrder = [0, 6, 7, 5, 4, 2, 1, 3];
var lyricColorPresets = [
  { name:'雾蓝', color:'#a9b8c8' },
  { name:'银蓝', color:'#9db8cf' },
  { name:'冰川', color:'#7ec8d8' },
  { name:'青绿', color:'#66d2b5' },
  { name:'松针', color:'#7fa894' },
  { name:'月白', color:'#d7d2c4' },
  { name:'岩金', color:'#c3ae7c' },
  { name:'琥珀', color:'#d9a45f' },
  { name:'暮粉', color:'#c78aa4' },
  { name:'玫红', color:'#d76a8d' },
  { name:'烟紫', color:'#9b83d3' },
  { name:'电紫', color:'#8d70ff' },
  { name:'靛蓝', color:'#5e78d8' },
  { name:'海蓝', color:'#3c9fe0' },
  { name:'霓青', color:'#28c5c3' },
  { name:'夜绿', color:'#245c49' },
  { name:'酒红', color:'#6d1f35' },
  { name:'墨黑', color:'#111318' },
];
var USER_FX_ARCHIVE_STORE_KEY = 'mineradio-user-fx-archives-v1';
var USER_FX_ARCHIVE_EXPORT_TYPE = 'mineradio-user-fx-archive';
var USER_FX_ARCHIVE_SCHEMA = 1;
function defaultUserFxArchiveName(index) {
  return '存档 ' + (index + 1);
}
function normalizeUserFxArchiveName(name, index) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) name = defaultUserFxArchiveName(index);
  return name.slice(0, 18);
}
function archiveNumber(raw, key, fallback, min, max) {
  var value = raw && raw[key] != null ? Number(raw[key]) : fallback;
  if (!isFinite(value)) value = fallback;
  return clampRange(value, min, max);
}
function archiveMode(raw, key, pattern, fallback) {
  var value = String(raw && raw[key] != null ? raw[key] : fallback);
  return pattern.test(value) ? value : fallback;
}
function normalizeFxArchiveSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var savedPreset = migrateVisualPresetIndex(raw.preset);
  if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) savedPreset = 5;
  var snapshot = {
    visualPresetSchema: VISUAL_PRESET_SCHEMA,
    preset: savedPreset,
    intensity: archiveNumber(raw, 'intensity', fxDefaults.intensity, 0.2, 1.6),
    cinemaShake: archiveNumber(raw, 'cinemaShake', fxDefaults.cinemaShake, 0, 1.8),
    depth: archiveNumber(raw, 'depth', fxDefaults.depth, 0.2, 1.8),
    coverResolution: normalizeCoverResolution(raw.coverResolution),
    point: archiveNumber(raw, 'point', fxDefaults.point, 0.5, 2.2),
    speed: archiveNumber(raw, 'speed', fxDefaults.speed, 0.2, 2.5),
    twist: archiveNumber(raw, 'twist', fxDefaults.twist, 0, 0.6),
    color: archiveNumber(raw, 'color', fxDefaults.color, 0.5, 2.0),
    scatter: archiveNumber(raw, 'scatter', fxDefaults.scatter, 0, 0.5),
    bgFade: archiveNumber(raw, 'bgFade', fxDefaults.bgFade, 0, 1.2),
    bloomStrength: archiveNumber(raw, 'bloomStrength', fxDefaults.bloomStrength, 0, 1.6),
    lyricGlowStrength: archiveNumber(raw, 'lyricGlowStrength', fxDefaults.lyricGlowStrength, 0, 0.85),
    lyricScale: archiveNumber(raw, 'lyricScale', fxDefaults.lyricScale, 0.35, 1.65),
    lyricOffsetX: archiveNumber(raw, 'lyricOffsetX', fxDefaults.lyricOffsetX, -2.0, 2.0),
    lyricOffsetY: archiveNumber(raw, 'lyricOffsetY', fxDefaults.lyricOffsetY, -1.2, 1.35),
    lyricOffsetZ: archiveNumber(raw, 'lyricOffsetZ', fxDefaults.lyricOffsetZ, -1.6, 1.6),
    lyricTiltX: archiveNumber(raw, 'lyricTiltX', fxDefaults.lyricTiltX, -42, 42),
    lyricTiltY: archiveNumber(raw, 'lyricTiltY', fxDefaults.lyricTiltY, -42, 42),
    lyricCameraLock: !!raw.lyricCameraLock,
    lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
    lyricColor: normalizeHexColor(raw.lyricColor || fxDefaults.lyricColor),
    lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
    lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || fxDefaults.lyricHighlightColor),
    lyricGlowLinked: raw.lyricGlowLinked !== false,
    lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || fxDefaults.lyricGlowColor),
    lyricFont: normalizeLyricFontKey(raw.lyricFont),
    lyricLetterSpacing: archiveNumber(raw, 'lyricLetterSpacing', fxDefaults.lyricLetterSpacing, -0.04, 0.18),
    lyricLineHeight: archiveNumber(raw, 'lyricLineHeight', fxDefaults.lyricLineHeight, 0.86, 1.35),
    lyricWeight: archiveNumber(raw, 'lyricWeight', fxDefaults.lyricWeight, 500, 900),
    visualTintMode: raw.visualTintMode === 'custom' ? 'custom' : 'auto',
    visualTintColor: normalizeHexColor(raw.visualTintColor || fxDefaults.visualTintColor),
    appTheme: normalizeAppThemeId(raw.appTheme || fxDefaults.appTheme),
    uiAccentColor: normalizeHexColor(raw.uiAccentColor || fxDefaults.uiAccentColor, fxDefaults.uiAccentColor),
    homeAccentMode: raw.homeAccentMode === 'custom' ? 'custom' : 'auto',
    homeAccentColor: normalizeHexColor(raw.homeAccentColor || fxDefaults.homeAccentColor, fxDefaults.homeAccentColor),
    homeIconColor: normalizeHexColor(raw.homeIconColor || fxDefaults.homeIconColor, fxDefaults.homeIconColor),
    visualIconColor: normalizeHexColor(raw.visualIconColor || fxDefaults.visualIconColor, fxDefaults.visualIconColor),
    backgroundColorMode: raw.backgroundColorMode === 'custom' || raw.backgroundColorCustom ? 'custom' : 'cover',
    backgroundColor: normalizeHexColor(raw.backgroundColor || fxDefaults.backgroundColor, fxDefaults.backgroundColor),
    backgroundOpacity: archiveNumber(raw, 'backgroundOpacity', fxDefaults.backgroundOpacity, 0, 1),
    controlGlassChromaticOffset: archiveNumber(raw, 'controlGlassChromaticOffset', fxDefaults.controlGlassChromaticOffset, 0, 140),
    backgroundColorCustom: raw.backgroundColorMode === 'custom' || !!raw.backgroundColorCustom,
    floatLayer: !!raw.floatLayer,
    cinema: raw.cinema !== false,
    edge: !!raw.edge,
    aiDepth: !!raw.aiDepth,
    bloom: !!raw.bloom,
    lyricGlow: raw.lyricGlow !== false,
    lyricGlowBeat: raw.lyricGlowBeat !== false,
    lyricGlowParticles: !!raw.lyricGlowParticles,
    desktopLyrics: !!raw.desktopLyrics,
    desktopLyricsSize: archiveNumber(raw, 'desktopLyricsSize', fxDefaults.desktopLyricsSize, 0.72, 1.55),
    desktopLyricsOpacity: archiveNumber(raw, 'desktopLyricsOpacity', fxDefaults.desktopLyricsOpacity, 0.28, 1),
    desktopLyricsY: archiveNumber(raw, 'desktopLyricsY', fxDefaults.desktopLyricsY, 0.08, 0.92),
    desktopLyricsClickThrough: raw.desktopLyricsClickThrough === true,
    desktopLyricsCinema: raw.desktopLyricsCinema !== false,
    desktopLyricsHighlight: raw.desktopLyricsHighlight === true,
    desktopLyricsFps: normalizeDesktopLyricsFps(Object.prototype.hasOwnProperty.call(raw, 'desktopLyricsFps') ? raw.desktopLyricsFps : fxDefaults.desktopLyricsFps),
    performanceBackground: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true),
    performanceQuality: normalizePerformanceQuality(raw.performanceQuality),
    liveBackgroundKeep: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true) === 'keep',
    particleLyrics: raw.particleLyrics !== false,
    backCover: !!raw.backCover,
    shelf: archiveMode(raw, 'shelf', /^(off|side|stage)$/, fxDefaults.shelf),
    shelfCameraMode: archiveMode(raw, 'shelfCameraMode', /^(dynamic|static)$/, fxDefaults.shelfCameraMode),
    shelfPresence: archiveMode(raw, 'shelfPresence', /^(auto|always)$/, fxDefaults.shelfPresence),
    shelfShowPodcasts: raw.shelfShowPodcasts !== false,
    shelfMergeCollections: raw.shelfMergeCollections === true,
    shelfSize: archiveNumber(raw, 'shelfSize', fxDefaults.shelfSize, 0.65, 1.45),
    shelfOffsetX: archiveNumber(raw, 'shelfOffsetX', fxDefaults.shelfOffsetX, -1.2, 1.2),
    shelfOffsetY: archiveNumber(raw, 'shelfOffsetY', fxDefaults.shelfOffsetY, -0.9, 0.9),
    shelfOffsetZ: archiveNumber(raw, 'shelfOffsetZ', fxDefaults.shelfOffsetZ, -0.9, 0.9),
    shelfAngleY: archiveNumber(raw, 'shelfAngleY', fxDefaults.shelfAngleY, -30, 30),
    shelfAngleYManual: raw.shelfAngleYManual === true,
    shelfOpacity: archiveNumber(raw, 'shelfOpacity', fxDefaults.shelfOpacity, 0.25, 1),
    shelfBgOpacity: archiveNumber(raw, 'shelfBgOpacity', fxDefaults.shelfBgOpacity, 0.25, 0.98),
    shelfAccentColor: normalizeHexColor(raw.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor),
    cam: archiveMode(raw, 'cam', /^(off|gesture)$/, fxDefaults.cam)
  };
  return typeof copyUnlistedFxFields === 'function' ? copyUnlistedFxFields(raw, snapshot) : snapshot;
}
function readUserFxArchives() {
  var raw = [];
  try {
    raw = JSON.parse(localStorage.getItem(USER_FX_ARCHIVE_STORE_KEY) || '[]') || [];
  } catch (e) {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  return raw.map(function(slot, index){
    slot = slot && typeof slot === 'object' ? slot : {};
    var snapshot = normalizeFxArchiveSnapshot(slot.snapshot);
    return {
      name: normalizeUserFxArchiveName(slot.name, index),
      createdAt: Number(slot.createdAt) || (snapshot ? (Number(slot.savedAt) || Date.now()) : 0),
      savedAt: snapshot ? (Number(slot.savedAt) || Date.now()) : 0,
      snapshot: snapshot
    };
  }).filter(function(slot){
    return !!(slot.snapshot || slot.savedAt || slot.createdAt);
  });
}
function saveUserFxArchives() {
  try {
    localStorage.setItem(USER_FX_ARCHIVE_STORE_KEY, JSON.stringify(userFxArchives));
  } catch (e) {
    showToast('用户存档保存失败，本地存储空间可能不足');
  }
}
function hasStoredUserFxArchives() {
  try {
    return localStorage.getItem(USER_FX_ARCHIVE_STORE_KEY) != null;
  } catch (e) {
    return true;
  }
}
function createPackagedDefaultUserFxArchiveSlot() {
  return {
    name: normalizeUserFxArchiveName(PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME, 0),
    createdAt: PACKAGED_DEFAULT_USER_FX_ARCHIVE_EXPORTED_AT,
    savedAt: PACKAGED_DEFAULT_USER_FX_ARCHIVE_SAVED_AT,
    snapshot: normalizeFxArchiveSnapshot(clonePackagedDefaultFxSnapshot())
  };
}
function formatUserArchiveTime(ts) {
  ts = Number(ts) || 0;
  if (!ts) return '空槽位';
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚保存';
  if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  var d = new Date(ts);
  function pad(v) { return String(v).padStart(2, '0'); }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function captureFxArchiveSnapshot() {
  return normalizeFxArchiveSnapshot(Object.assign({ visualPresetSchema: VISUAL_PRESET_SCHEMA }, fx));
}
function applySavedLyricPaletteState() {
  if (!stageLyrics) return;
  setStageLyricPalette(fx.lyricColorMode === 'custom'
    ? lyricPaletteFromHex(fx.lyricColor)
    : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
}
function applyFxArchiveSnapshot(snapshot) {
  var data = normalizeFxArchiveSnapshot(snapshot);
  if (!data) return false;
  var targetPreset = data.preset;
  Object.keys(data).forEach(function(key){
    if (key === 'visualPresetSchema' || key === 'preset') return;
    fx[key] = data[key];
  });
  normalizeDevelopmentLockedFxState();
  /* 存档属于 Mineradio 视觉：应用时同样自动退出 Folia 全屏歌词 */
  if (typeof releaseFoliaStageForMineradio === 'function') {
    releaseFoliaStageForMineradio({ silent: true });
  }
  setPreset(targetPreset, { silent: true, keepFolia: true, preserveCamera: false, skipTransition: false, noSave: true, commitPlaybackPreset: true });
  applyCoverParticleResolution(fx.coverResolution, { reload: true });
  if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer();
  setParticleLyricsSilently(fx.particleLyrics);
  if (fx.backCover) createBackCoverLayer(); else destroyBackCoverLayer();
  if (fx.aiDepth) {
    aiDepthFailUntil = 0;
    queueAIDepthForCurrentCover(true);
  }
  setShelfMode(fx.shelf);
  if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  setCamMode(fx.cam);
  applyAppThemeStructure(fx.appTheme);
  updateFxInputs();
  renderAppThemeGrid();
  applySavedLyricPaletteState();
  refreshCurrentLyricStyle();
  applyDesktopLyricsState(true);
  applyWallpaperModeState(true);
  updateRenderPowerClasses();
  applyRendererPowerMode();
  saveLyricLayout();
  return true;
}
var hadStoredUserFxArchives = hasStoredUserFxArchives();
var userFxArchives = readUserFxArchives();
if (!hadStoredUserFxArchives) {
  userFxArchives = [createPackagedDefaultUserFxArchiveSlot()];
  saveUserFxArchives();
}
var userFxArchiveEditing = -1;
function renderUserFxArchives() {
  var grid = document.getElementById('user-archive-grid');
  if (!grid) return;
  grid.innerHTML = userFxArchives.map(function(slot, index){
    var hasSave = !!slot.snapshot;
    var editing = userFxArchiveEditing === index;
    var nameHtml = editing
      ? '<input class="user-archive-input" id="user-archive-input-' + index + '" type="text" maxlength="18" value="' + escHtml(slot.name) + '" onkeydown="handleUserFxArchiveRenameKey(event,' + index + ')">'
      : '<div class="user-archive-name" title="' + escHtml(slot.name) + '">' + escHtml(slot.name) + '</div>';
    var actionsHtml = editing
      ? '<button type="button" onclick="commitUserFxArchiveRename(' + index + ')">确定</button>' +
        '<button type="button" onclick="cancelUserFxArchiveRename()">取消</button>'
      : '<button type="button" onclick="applyUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>应用</button>' +
        '<button type="button" onclick="saveUserFxArchive(' + index + ')">保存</button>' +
        '<button type="button" onclick="renameUserFxArchive(' + index + ')">命名</button>';
    return '<div class="user-archive-slot' + (hasSave ? ' has-save' : '') + '" data-slot="' + index + '">' +
      nameHtml +
      '<div class="user-archive-meta">' + formatUserArchiveTime(slot.savedAt) + '</div>' +
      '<div class="user-archive-actions">' +
        actionsHtml +
      '</div>' +
    '</div>';
  }).join('');
  if (userFxArchiveEditing >= 0) {
    setTimeout(function(){
      var input = document.getElementById('user-archive-input-' + userFxArchiveEditing);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }
}
function saveUserFxArchive(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  userFxArchives[index].snapshot = captureFxArchiveSnapshot();
  userFxArchives[index].savedAt = Date.now();
  userFxArchives[index].name = normalizeUserFxArchiveName(userFxArchives[index].name, index);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已保存到 ' + userFxArchives[index].name);
}
function applyUserFxArchive(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  var slot = userFxArchives[index];
  if (!slot || !slot.snapshot) {
    showToast('这个用户存档还是空的');
    return;
  }
  if (applyFxArchiveSnapshot(slot.snapshot)) {
    showToast('已应用 ' + slot.name);
  }
}
function renameUserFxArchive(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  userFxArchiveEditing = index;
  renderUserFxArchives();
}
function commitUserFxArchiveRename(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  var input = document.getElementById('user-archive-input-' + index);
  userFxArchives[index].name = normalizeUserFxArchiveName(input && input.value, index);
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已命名为 ' + userFxArchives[index].name);
}
function cancelUserFxArchiveRename() {
  userFxArchiveEditing = -1;
  renderUserFxArchives();
}
function handleUserFxArchiveRenameKey(e, index) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitUserFxArchiveRename(index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelUserFxArchiveRename();
  }
}

function defaultUserFxArchiveName(index) {
  return '用户存档 ' + (Number(index) + 1);
}
function normalizeUserFxArchiveName(name, index) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) name = defaultUserFxArchiveName(index);
  return name.slice(0, 28);
}
function userFxArchiveAt(index) {
  index = Number(index);
  if (!isFinite(index)) return null;
  index = Math.floor(index);
  return index >= 0 && index < userFxArchives.length ? userFxArchives[index] : null;
}
function renderUserFxArchives() {
  var grid = document.getElementById('user-archive-grid');
  if (!grid) return;
  var toolbar =
    '<div class="user-archive-toolbar">' +
      '<div class="user-archive-note">空白新建，保存当前视觉参数；支持拖拽 JSON 导入，也可以导出为文件备份。</div>' +
      '<div class="user-archive-tools">' +
        '<button class="fx-mini-btn ghost" type="button" onclick="createUserFxArchive()">新建</button>' +
        '<button class="fx-mini-btn ghost" type="button" onclick="importUserFxArchiveFromDialog()">导入</button>' +
      '</div>' +
    '</div>';
  var cards = userFxArchives.map(function(slot, index){
    var hasSave = !!slot.snapshot;
    var editing = userFxArchiveEditing === index;
    var nameHtml = editing
      ? '<input class="user-archive-input" id="user-archive-input-' + index + '" type="text" maxlength="28" value="' + escHtml(slot.name) + '" onkeydown="handleUserFxArchiveRenameKey(event,' + index + ')">'
      : '<div class="user-archive-name" title="' + escHtml(slot.name) + '">' + escHtml(slot.name) + '</div>';
    var actionsHtml = editing
      ? '<button type="button" onclick="commitUserFxArchiveRename(' + index + ')">确定</button>' +
        '<button type="button" onclick="cancelUserFxArchiveRename()">取消</button>'
      : '<button type="button" onclick="applyUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>应用</button>' +
        '<button type="button" onclick="saveUserFxArchive(' + index + ')">保存</button>' +
        '<button type="button" onclick="renameUserFxArchive(' + index + ')">命名</button>' +
        '<button type="button" onclick="exportUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>导出</button>' +
        '<button type="button" onclick="removeUserFxArchive(' + index + ')">删除</button>';
    return '<div class="user-archive-slot' + (hasSave ? ' has-save' : '') + '" data-slot="' + index + '">' +
      nameHtml +
      '<div class="user-archive-meta">' + (hasSave ? formatUserArchiveTime(slot.savedAt) : '空白存档，点击保存写入当前视觉') + '</div>' +
      '<div class="user-archive-actions">' + actionsHtml + '</div>' +
    '</div>';
  }).join('');
  var addCard = '<button class="user-archive-slot is-new" type="button" onclick="createUserFxArchive()"><strong>＋ 新建空白存档</strong><span class="user-archive-meta">可继续创建，不限制 4 个</span></button>';
  grid.innerHTML = toolbar + cards + addCard;
  bindUserFxArchiveDrop();
  if (userFxArchiveEditing >= 0) {
    setTimeout(function(){
      var input = document.getElementById('user-archive-input-' + userFxArchiveEditing);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }
}
function createUserFxArchive() {
  var index = userFxArchives.length;
  userFxArchives.push({
    name: normalizeUserFxArchiveName('', index),
    createdAt: Date.now(),
    savedAt: 0,
    snapshot: null
  });
  userFxArchiveEditing = index;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已新建空白用户存档');
}
function saveUserFxArchive(index) {
  var slot = userFxArchiveAt(index);
  if (!slot) return;
  slot.snapshot = captureFxArchiveSnapshot();
  slot.savedAt = Date.now();
  slot.createdAt = slot.createdAt || slot.savedAt;
  slot.name = normalizeUserFxArchiveName(slot.name, index);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已保存到 ' + slot.name);
}
function applyUserFxArchive(index) {
  var slot = userFxArchiveAt(index);
  if (!slot || !slot.snapshot) {
    showToast('这个用户存档还是空白');
    return;
  }
  if (applyFxArchiveSnapshot(slot.snapshot)) showToast('已应用 ' + slot.name);
}
function renameUserFxArchive(index) {
  if (!userFxArchiveAt(index)) return;
  userFxArchiveEditing = Math.floor(Number(index) || 0);
  renderUserFxArchives();
}
function commitUserFxArchiveRename(index) {
  var slot = userFxArchiveAt(index);
  if (!slot) return;
  var input = document.getElementById('user-archive-input-' + index);
  slot.name = normalizeUserFxArchiveName(input && input.value, index);
  slot.createdAt = slot.createdAt || Date.now();
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已命名为 ' + slot.name);
}
function cancelUserFxArchiveRename() {
  userFxArchiveEditing = -1;
  renderUserFxArchives();
}
function removeUserFxArchive(index) {
  if (!userFxArchiveAt(index)) return;
  userFxArchives.splice(index, 1);
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已删除用户存档');
}
function userFxArchiveExportPayload(slot) {
  return {
    type: USER_FX_ARCHIVE_EXPORT_TYPE,
    schema: USER_FX_ARCHIVE_SCHEMA,
    exportedAt: Date.now(),
    name: slot.name,
    savedAt: slot.savedAt,
    snapshot: slot.snapshot
  };
}
function safeArchiveFileName(name) {
  return String(name || 'Mineradio 用户存档').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 48) + '.json';
}
function exportUserFxArchive(index) {
  var slot = userFxArchiveAt(index);
  if (!slot || !slot.snapshot) {
    showToast('空白存档不能导出');
    return;
  }
  var payload = userFxArchiveExportPayload(slot);
  var text = JSON.stringify(payload, null, 2);
  var api = getDesktopWindowApi && getDesktopWindowApi();
  if (api && typeof api.exportJsonFile === 'function') {
    api.exportJsonFile({ defaultName: safeArchiveFileName(slot.name), text: text }).then(function(res){
      if (res && res.ok) showToast('用户存档已导出');
      else if (!res || !res.canceled) showToast('用户存档导出失败');
    }).catch(function(){ showToast('用户存档导出失败'); });
    return;
  }
  var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = safeArchiveFileName(slot.name);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}
function normalizeImportedFxArchivePayload(payload, fileName) {
  if (!payload || typeof payload !== 'object') return null;
  var snapshot = payload.snapshot ? normalizeFxArchiveSnapshot(payload.snapshot) : normalizeFxArchiveSnapshot(payload);
  if (!snapshot) return null;
  var baseName = String(fileName || '').split(/[\\/]/).pop().replace(/\.json$/i, '');
  return {
    name: normalizeUserFxArchiveName(payload.name || baseName, userFxArchives.length),
    createdAt: Date.now(),
    savedAt: Number(payload.savedAt) || Date.now(),
    snapshot: snapshot
  };
}
function importUserFxArchiveText(text, fileName) {
  var payload = null;
  try { payload = JSON.parse(String(text || '')); } catch (e) {}
  var slot = normalizeImportedFxArchivePayload(payload, fileName);
  if (!slot) {
    showToast('导入失败，文件不是有效的用户存档');
    return false;
  }
  userFxArchives.push(slot);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已导入 ' + slot.name);
  return true;
}
function importUserFxArchiveFromDialog() {
  var api = getDesktopWindowApi && getDesktopWindowApi();
  if (api && typeof api.importJsonFile === 'function') {
    api.importJsonFile().then(function(res){
      if (res && res.ok) importUserFxArchiveText(res.text, res.filePath || '用户存档.json');
      else if (!res || !res.canceled) showToast('导入失败');
    }).catch(function(){ showToast('导入失败'); });
    return;
  }
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function(){
    var file = input.files && input.files[0];
    if (file) readUserFxArchiveImportFile(file);
  };
  input.click();
}
function readUserFxArchiveImportFile(file) {
  if (!file || !/\.json$/i.test(file.name || '')) {
    showToast('请导入 JSON 用户存档');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e){ importUserFxArchiveText(e.target && e.target.result, file.name); };
  reader.onerror = function(){ showToast('导入失败'); };
  reader.readAsText(file, 'utf-8');
}
function bindUserFxArchiveDrop() {
  var grid = document.getElementById('user-archive-grid');
  if (!grid || grid._archiveDropBound) return;
  grid._archiveDropBound = true;
  grid.addEventListener('dragover', function(e){
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    grid.classList.add('dragover');
  });
  grid.addEventListener('dragleave', function(e){
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('dragover');
  });
  grid.addEventListener('drop', function(e){
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    grid.classList.remove('dragover');
    Array.prototype.forEach.call(e.dataTransfer.files, readUserFxArchiveImportFile);
  });
}

function buildLyricColorControls() {
  var grid = document.getElementById('lyric-color-grid');
  if (!grid) return;
  var html = '<button class="lyric-swatch auto" type="button" data-auto="1" onclick="setLyricColorAuto()" title="封面取色">AUTO</button>';
  html += lyricColorPresets.map(function(p, i){
    return '<button class="lyric-swatch" type="button" data-color="' + p.color + '" onclick="setLyricColorPreset(' + i + ')" title="' + escHtml(p.name) + '" style="--swatch:' + p.color + '"></button>';
  }).join('');
  grid.innerHTML = html;
}
function updateLyricColorControls() {
  var picker = document.getElementById('lyric-color-picker');
  var value = document.getElementById('lyric-color-value');
  var autoBtn = document.getElementById('lyric-auto-btn');
  var color = normalizeHexColor(fx.lyricColor);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.lyricColorMode === 'custom' ? color.toUpperCase() : '封面取色';
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricColorMode !== 'custom');
  document.querySelectorAll('.lyric-swatch').forEach(function(btn){
    var isAuto = btn.dataset.auto === '1';
    var isColor = normalizeHexColor(btn.dataset.color || '') === color;
    btn.classList.toggle('active', isAuto ? fx.lyricColorMode !== 'custom' : (fx.lyricColorMode === 'custom' && isColor));
  });
}
function updateLyricHighlightControls() {
  var picker = document.getElementById('lyric-highlight-picker');
  var value = document.getElementById('lyric-highlight-value');
  var autoBtn = document.getElementById('lyric-highlight-auto-btn');
  var color = normalizeHexColor(fx.lyricHighlightColor);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.lyricHighlightMode === 'custom' ? color.toUpperCase() : '跟随歌词';
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricHighlightMode !== 'custom');
}
function updateLyricGlowControls() {
  var row = document.getElementById('lyric-glow-row');
  var picker = document.getElementById('lyric-glow-picker');
  var value = document.getElementById('lyric-glow-value');
  var linkBtn = document.getElementById('lyric-glow-link-btn');
  var linked = fx.lyricGlowLinked !== false;
  var color = normalizeHexColor(fx.lyricGlowColor || '#9db8cf');
  if (picker) picker.value = color;
  if (row) row.classList.toggle('linked', linked);
  if (value) value.textContent = linked ? '跟随高亮' : color.toUpperCase();
  if (linkBtn) {
    linkBtn.classList.toggle('active', linked);
    linkBtn.textContent = linked ? '链接' : '独立';
    linkBtn.title = linked ? '点击后单独设置溢光颜色' : '点击后让溢光跟随高亮';
  }
}
function applyHomeAccentColor() {
  var color = normalizeHexColor(fx.homeAccentColor || '#00f5d4');
  var rgb = hexToRgb(color);
  document.documentElement.style.setProperty('--home-accent', color);
  document.documentElement.style.setProperty('--home-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
}
function updateHomeAccentControls() {
  applyHomeAccentColor();
  var color = normalizeHexColor(fx.homeAccentColor || '#00f5d4');
  var picker = document.getElementById('home-accent-picker');
  var value = document.getElementById('home-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = fx.homeAccentMode === 'custom' ? color.toUpperCase() : '背景取色';
}
function setHomeAccentColor(color, silent) {
  fx.homeAccentMode = 'custom';
  fx.homeAccentColor = normalizeHexColor(color || '#00f5d4');
  if (typeof homeDashboardResetHeroTheme === 'function') homeDashboardResetHeroTheme();
  updateHomeAccentControls();
  saveLyricLayout();
  if (!silent) showToast('Home 填充: ' + fx.homeAccentColor.toUpperCase());
}
function resetHomeAccentColor() {
  fx.homeAccentMode = 'auto';
  fx.homeAccentColor = normalizeHexColor(fxDefaults.homeAccentColor || '#00f5d4');
  if (typeof homeDashboardResetHeroTheme === 'function') homeDashboardResetHeroTheme();
  if (typeof homeDashboardRefreshHeroTheme === 'function') homeDashboardRefreshHeroTheme();
  updateHomeAccentControls();
  saveLyricLayout();
  showToast('Home 填充: 背景取色');
}
function applyIconAccentColors() {
  var homeColor = normalizeHexColor(fx.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  var homeRgb = hexToRgb(homeColor);
  var visualRgb = hexToRgb(visualColor);
  var root = document.documentElement;
  root.style.setProperty('--home-icon-color', homeColor);
  root.style.setProperty('--home-icon-rgb', homeRgb.r + ',' + homeRgb.g + ',' + homeRgb.b);
  root.style.setProperty('--visual-icon-color', visualColor);
  root.style.setProperty('--visual-icon-rgb', visualRgb.r + ',' + visualRgb.g + ',' + visualRgb.b);
}
function updateIconAccentControls() {
  applyIconAccentColors();
  var homeColor = normalizeHexColor(fx.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  var homePicker = document.getElementById('home-icon-picker');
  var homeValue = document.getElementById('home-icon-value');
  var visualPicker = document.getElementById('visual-icon-picker');
  var visualValue = document.getElementById('visual-icon-value');
  if (homePicker) homePicker.value = homeColor;
  if (homeValue) homeValue.textContent = homeColor.toUpperCase();
  if (visualPicker) visualPicker.value = visualColor;
  if (visualValue) visualValue.textContent = visualColor.toUpperCase();
}
function setHomeIconColor(color, silent) {
  fx.homeIconColor = normalizeHexColor(color || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  updateIconAccentControls();
  saveLyricLayout();
  if (!silent) showToast('主页图标: ' + fx.homeIconColor.toUpperCase());
}
function resetHomeIconColor() {
  setHomeIconColor(fxDefaults.homeIconColor || '#f4d28a');
}
function setVisualIconColor(color, silent) {
  fx.visualIconColor = normalizeHexColor(color || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  updateIconAccentControls();
  saveLyricLayout();
  if (!silent) showToast('视觉图标: ' + fx.visualIconColor.toUpperCase());
}
function resetVisualIconColor() {
  setVisualIconColor(fxDefaults.visualIconColor || '#7fd8ff');
}
function applyCustomBackground() {
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  var media = normalizeCustomBackgroundMedia(fx.backgroundMedia || fx.backgroundImage);
  var image = media && media.type === 'image' ? media.src : '';
  var hasVideo = !!(media && media.type === 'video');
  var opacity = clampRange(fx.backgroundOpacity == null ? 1 : Number(fx.backgroundOpacity), 0, 1);
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  var override = !!media || customColor || opacity < 1;
  var root = document.documentElement;
  var layer = document.getElementById('custom-bg');
  var video = document.getElementById('custom-bg-video');
  root.style.setProperty('--custom-bg-color', color);
  document.body.classList.toggle('custom-background-override', override);
  document.body.classList.toggle('custom-background-flat', override && !media);
  document.body.classList.toggle('custom-background-video', hasVideo);
  if (layer) {
    layer.style.setProperty('--custom-bg-image', image ? 'url("' + cssImageUrl(image) + '")' : 'none');
    layer.style.setProperty('--custom-bg-image-opacity', image ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-video-opacity', hasVideo ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-overlay-opacity', media ? '0.18' : '0');
  }
  var token = ++customBgApplyToken;
  if (!video) return;
  if (!hasVideo) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (customBgObjectUrl) { URL.revokeObjectURL(customBgObjectUrl); customBgObjectUrl = ''; }
    return;
  }
  function setVideoSrc(src) {
    if (token !== customBgApplyToken || !src) return;
    if (customBgObjectUrl && customBgObjectUrl !== src) { URL.revokeObjectURL(customBgObjectUrl); customBgObjectUrl = ''; }
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      video.load();
    }
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    var p = video.play();
    if (p && p.catch) p.catch(function(){});
  }
  if (media.src) {
    setVideoSrc(media.src);
  } else if (media.id) {
    getCustomBackgroundBlob(media.id).then(function(blob){
      if (token !== customBgApplyToken || !blob) return;
      if (customBgObjectUrl) URL.revokeObjectURL(customBgObjectUrl);
      customBgObjectUrl = URL.createObjectURL(blob);
      setVideoSrc(customBgObjectUrl);
    }).catch(function(err){ console.warn('background video load failed:', err); });
  }
}
function updateCustomBackgroundControls() {
  applyCustomBackground();
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  var picker = document.getElementById('bg-color-picker');
  var value = document.getElementById('bg-color-value');
  var imageValue = document.getElementById('bg-image-value');
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  if (picker) picker.value = color;
  if (value) value.textContent = customColor ? color.toUpperCase() : '\u5c01\u9762\u6e10\u53d8';
  if (picker && picker.closest) {
    var row = picker.closest('.lyric-color-row');
    if (row) row.classList.toggle('bg-cover-mode', !customColor);
  }
  setRange('fx-bgopacity', fx.backgroundOpacity == null ? 1 : fx.backgroundOpacity);
  if (imageValue) imageValue.textContent = customBackgroundMediaLabel(fx.backgroundMedia || fx.backgroundImage);
  applyBackgroundMediaHint();
}
function setCustomBackgroundColor(color, silent, customFlag) {
  fx.backgroundColor = normalizeHexColor(color || '#000000', '#000000');
  fx.backgroundColorMode = customFlag === false ? 'cover' : 'custom';
  fx.backgroundColorCustom = customFlag !== false;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('背景颜色: ' + fx.backgroundColor.toUpperCase());
}
function setCustomBackgroundCoverMode(silent) {
  fx.backgroundColorMode = 'cover';
  fx.backgroundColorCustom = false;
  fx.backgroundColor = normalizeHexColor(fx.backgroundColor || fxDefaults.backgroundColor || '#000000', '#000000');
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('\u80cc\u666f\u989c\u8272: \u5c01\u9762\u6e10\u53d8');
}
function resetCustomBackgroundColor() {
  setCustomBackgroundCoverMode(false);
}
function setCustomBackgroundOpacity(value, silent) {
  fx.backgroundOpacity = clampRange(Number(value), 0, 1);
  fx.backgroundColorMode = 'custom';
  fx.backgroundColorCustom = true;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('背景透明度: ' + Math.round(fx.backgroundOpacity * 100) + '%');
}
function setCustomBackgroundImage(src, silent) {
  var image = normalizeCustomBackgroundImage(src);
  fx.backgroundImage = image;
  fx.backgroundMedia = image ? { type: 'image', src: image } : null;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast(fx.backgroundImage ? '背景图片已应用' : '背景图片已清除');
}
function clearCustomBackgroundImage() {
  setCustomBackgroundImage('');
}
function setCustomBackgroundMedia(media, silent) {
  media = normalizeCustomBackgroundMedia(media);
  fx.backgroundMedia = media;
  fx.backgroundImage = media && media.type === 'image' ? media.src : '';
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast(media ? (media.type === 'video' ? '背景视频已应用' : '背景图片已应用') : '背景媒体已清除');
}
function readBackgroundImageFile(file) {
  if (!file || !/^image\//i.test(file.type || '')) {
    showToast('请选择图片文件');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var maxSide = 2200;
      var iw = img.naturalWidth || img.width || 1;
      var ih = img.naturalHeight || img.height || 1;
      var scale = Math.min(1, maxSide / Math.max(iw, ih));
      var w = Math.max(1, Math.round(iw * scale));
      var h = Math.max(1, Math.round(ih * scale));
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, w, h);
      var out = '';
      try { out = cv.toDataURL('image/webp', 0.84); } catch (err) {}
      if (!/^data:image\/webp/i.test(out)) {
        try { out = cv.toDataURL('image/jpeg', 0.86); } catch (err2) { out = String(e.target.result || ''); }
      }
      setCustomBackgroundImage(out);
    };
    img.onerror = function(){ showToast('背景图片读取失败'); };
    img.src = e.target.result;
  };
  reader.onerror = function(){ showToast('背景图片读取失败'); };
  reader.readAsDataURL(file);
}
function readBackgroundVideoFile(file) {
  if (!file || !/^video\//i.test(file.type || '')) {
    showToast('请选择视频文件');
    return;
  }
  var id = 'bg-video-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  putCustomBackgroundBlob(id, file, { name: file.name || '', mime: file.type || '', size: file.size || 0 }).then(function(){
    setCustomBackgroundMedia({ type: 'video', id: id, name: file.name || '', mime: file.type || '', size: file.size || 0 });
  }).catch(function(err){
    console.warn('background video store failed:', err);
    if ((file.size || 0) > 18 * 1024 * 1024) {
      showToast('视频较大，当前环境无法保存，请换小一点的视频');
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e){
      setCustomBackgroundMedia({ type: 'video', src: String(e.target.result || ''), name: file.name || '', mime: file.type || '', size: file.size || 0 });
    };
    reader.onerror = function(){ showToast('背景视频读取失败'); };
    reader.readAsDataURL(file);
  });
}
function readBackgroundMediaFile(file) {
  if (!file) return;
  if (/^image\//i.test(file.type || '')) readBackgroundImageFile(file);
  else if (/^video\//i.test(file.type || '')) readBackgroundVideoFile(file);
  else showToast('请选择图片或视频文件');
}
function applyUiAccentColor() {
  var color = normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4');
  var rgb = hexToRgb(color);
  var root = document.documentElement;
  root.style.setProperty('--fc-accent', color);
  root.style.setProperty('--fc-accent-hov', color);
  root.style.setProperty('--fc-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
  root.style.setProperty('--glass-border', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.30)');
  root.style.setProperty('--glass-shadow-focus', '0 24px 72px rgba(0,0,0,.34),0 0 0 1px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.13),0 0 42px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.075),inset 0 1px 0 rgba(255,255,255,.20)');
}
function normalizeAppThemeId(id) {
  if (window.MineradioThemes && typeof window.MineradioThemes.normalize === 'function') {
    return window.MineradioThemes.normalize(id);
  }
  return 'default';
}
function getAppThemeMeta(id) {
  if (window.MineradioThemes && typeof window.MineradioThemes.get === 'function') {
    return window.MineradioThemes.get(id);
  }
  return { id: 'default', name: '霓虹薄荷' };
}
function applyAppThemeStructure(id) {
  if (window.MineradioThemes && typeof window.MineradioThemes.applyStructure === 'function') {
    return window.MineradioThemes.applyStructure(id);
  }
}
function renderAppThemeGrid() {
  var grid = document.getElementById('app-theme-grid');
  if (!grid || !window.MineradioThemes || typeof window.MineradioThemes.list !== 'function') return;
  var active = normalizeAppThemeId(fx && fx.appTheme);
  grid.innerHTML = window.MineradioThemes.list().map(function(theme){
    var swatches = (theme.swatch || []).map(function(color){
      return '<span class="app-theme-swatch" style="background:' + escHtml(color) + '"></span>';
    }).join('');
    return '<button type="button" class="app-theme-card' + (theme.id === active ? ' active' : '') + '" data-app-theme="' + escHtml(theme.id) + '" role="option" aria-selected="' + (theme.id === active ? 'true' : 'false') + '" title="' + escHtml(theme.name) + '">' +
      '<span class="app-theme-check" aria-hidden="true"></span>' +
      '<span class="app-theme-swatches">' + swatches + '</span>' +
      '<span class="app-theme-copy"><span class="app-theme-name">' + escHtml(theme.name) + '</span><span class="app-theme-desc">' + escHtml(theme.desc || '') + '</span></span>' +
    '</button>';
  }).join('');
}
function setAppTheme(id, opts) {
  opts = opts || {};
  var themeId = normalizeAppThemeId(id);
  var theme = getAppThemeMeta(themeId);
  fx.appTheme = themeId;
  applyAppThemeStructure(themeId);
  if (opts.syncFx !== false && window.MineradioThemes && typeof window.MineradioThemes.getFxDefaults === 'function') {
    var defs = window.MineradioThemes.getFxDefaults(themeId);
    if (defs.uiAccentColor) fx.uiAccentColor = normalizeHexColor(defs.uiAccentColor, '#00f5d4');
    if (defs.homeAccentColor) fx.homeAccentColor = normalizeHexColor(defs.homeAccentColor, '#00f5d4');
    if (defs.homeIconColor) fx.homeIconColor = normalizeHexColor(defs.homeIconColor, '#f4d28a');
    if (defs.visualIconColor) fx.visualIconColor = normalizeHexColor(defs.visualIconColor, '#7fd8ff');
    if (defs.visualTintColor) fx.visualTintColor = normalizeHexColor(defs.visualTintColor, '#9db8cf');
    if (defs.shelfAccentColor) fx.shelfAccentColor = normalizeHexColor(defs.shelfAccentColor, fx.uiAccentColor);
    if (fx.visualTintMode !== 'custom') fx.visualTintMode = 'auto';
    updateUiAccentControls();
    updateHomeAccentControls();
    updateIconAccentControls();
    updateVisualTintControls();
    if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  }
  renderAppThemeGrid();
  if (!opts.skipSave) saveLyricLayout(opts.immediate ? { immediate: true } : undefined);
  if (!opts.silent) showToast('主题: ' + (theme.name || themeId));
}
function initAppThemeFromState() {
  if (!fx) return;
  fx.appTheme = normalizeAppThemeId(fx.appTheme || (window.MineradioThemes ? window.MineradioThemes.readStored() : 'default'));
  applyAppThemeStructure(fx.appTheme);
  renderAppThemeGrid();
}

function paintAiThemePreview(colors) {
  var box = document.getElementById('ai-theme-preview');
  if (!box || !colors) return;
  var labels = { background: '背景', accent: '高亮', secondary: '辅色', ink: '文字' };
  box.innerHTML = ['background', 'accent', 'secondary', 'ink'].map(function(key){
    var hex = normalizeHexColor(colors[key] || '#111', '#111').toUpperCase();
    return '<span class="ai-theme-swatch" title="' + escHtml(hex) + '"><i style="background:' + escHtml(hex) + '"></i><em>' + labels[key] + '</em></span>';
  }).join('');
  box.setAttribute('aria-hidden', 'false');
  var status = document.getElementById('ai-theme-status');
  if (status) status.textContent = colors.name ? ('已生成 · ' + colors.name) : '已应用到界面配色';
}

function toggleAiThemeImport(force) {
  var panel = document.getElementById('ai-theme-import');
  var btn = document.getElementById('ai-theme-import-toggle');
  if (!panel) return;
  var open = force == null ? panel.hidden : !!force;
  panel.hidden = !open;
  if (btn) {
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '收起粘贴' : '粘贴结果';
  }
  if (open) {
    var input = document.getElementById('ai-theme-json');
    if (input) setTimeout(function(){ input.focus(); }, 0);
  }
}

function applyGeneratedAiTheme(colors, label) {
  if (!colors) return;
  setUiAccentColor(colors.accent, true);
  setHomeAccentColor(colors.accent, true);
  if (typeof setHomeIconColor === 'function') setHomeIconColor(colors.secondary, true);
  if (typeof setVisualIconColor === 'function') setVisualIconColor(colors.ink, true);
  fx.visualTintMode = 'custom';
  fx.visualTintColor = normalizeHexColor(colors.secondary, '#9db8cf');
  updateVisualTintControls();
  if (typeof setShelfAccentColor === 'function') setShelfAccentColor(colors.accent, true);
  setCustomBackgroundColor(colors.background, true, true);
  fx.lyricColorMode = 'custom';
  fx.lyricColor = normalizeHexColor(colors.ink, '#e8ecef');
  fx.lyricHighlightMode = 'custom';
  fx.lyricHighlightColor = normalizeHexColor(colors.accent, '#00f5d4');
  if (typeof updateLyricColorControls === 'function') updateLyricColorControls();
  paintAiThemePreview(colors);
  saveLyricLayout();
  showToast(label || '已应用 AI 主题');
}

function themeColorsFromHex(accent) {
  accent = normalizeHexColor(accent, '#7ec8d8');
  var rgb = hexToRgb(accent);
  var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  var bg = hslToRgb(hsl.h, Math.min(0.45, hsl.s * 0.55), 0.07);
  var secondary = hslToRgb((hsl.h + 0.08) % 1, Math.max(0.28, hsl.s * 0.7), 0.62);
  var ink = hslToRgb(hsl.h, Math.max(0.08, hsl.s * 0.2), 0.92);
  return {
    background: rgbToHexColor(bg.r, bg.g, bg.b),
    accent: accent,
    secondary: rgbToHexColor(secondary.r, secondary.g, secondary.b),
    ink: rgbToHexColor(ink.r, ink.g, ink.b)
  };
}

function generateAiThemeFromCover() {
  var palette = (typeof stageLyrics !== 'undefined' && stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette)) || null;
  var seed = palette && (palette.primary || palette.highlight);
  if (seed) {
    applyGeneratedAiTheme(themeColorsFromHex(seed), '已按封面生成主题');
    return;
  }
  var song = (typeof playQueue !== 'undefined' && typeof currentIdx === 'number') ? playQueue[currentIdx] : null;
  var url = song && typeof resolveSongCoverUrl === 'function' ? resolveSongCoverUrl(song, 160) : '';
  if (!url) {
    showToast('先播放一首歌，才能从封面取色');
    return;
  }
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      var data = ctx.getImageData(0, 0, 16, 16).data;
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < data.length; i += 16) {
        var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        var score = hsl.s * (1 - Math.abs(hsl.l - 0.45));
        if (score > bestScore) {
          bestScore = score;
          best = rgbToHexColor(data[i], data[i + 1], data[i + 2]);
        }
      }
      applyGeneratedAiTheme(themeColorsFromHex(best || '#7ec8d8'), '已按封面生成主题');
    } catch (err) {
      showToast('封面取色失败，可以改用复制提示词');
    }
  };
  img.onerror = function() { showToast('封面读取失败，可以改用复制提示词'); };
  img.src = url;
}

function currentAiThemePrompt() {
  var song = (typeof playQueue !== 'undefined' && typeof currentIdx === 'number') ? playQueue[currentIdx] : null;
  var title = song && song.name ? song.name : '未在播放';
  var artist = song && song.artist ? song.artist : '';
  var lines = [];
  try {
    var source = (typeof lyricsLines !== 'undefined' && lyricsLines) || [];
    for (var i = 0; i < source.length && lines.length < 12; i++) {
      var text = source[i] && (source[i].text || source[i].line);
      if (text) lines.push(String(text));
    }
  } catch (e) {}
  return [
    '为这首歌设计一套深色界面主题，只返回 JSON。',
    '歌曲：' + title + (artist ? ' / ' + artist : ''),
    lines.length ? '歌词：\n' + lines.join('\n') : '暂无歌词，请按歌名想象。',
    '格式：{"name":"不超过10字","backgroundColor":"#000000","primaryColor":"#EEEEEE","accentColor":"#00F5D4","secondaryColor":"#9DB8CF"}',
    '颜色要适合深色播放器，accent 用于按钮高亮，primary 用于文字。'
  ].join('\n\n');
}

function copyAiThemePrompt() {
  var text = currentAiThemePrompt();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){ showToast('提示词已复制'); }, function(){ showToast('复制失败'); });
    return;
  }
  showToast('当前环境不能复制');
}

function parseAiThemePayload(raw) {
  var text = String(raw || '').trim();
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  var data = JSON.parse(text.slice(start, end + 1));
  var theme = data.dark || data.light || data;
  var accent = theme.accentColor || theme.accent || theme.primaryColor;
  var background = theme.backgroundColor || theme.background;
  var secondary = theme.secondaryColor || theme.secondary || accent;
  var ink = theme.primaryColor || theme.primary || '#e8ecef';
  if (!accent) return null;
  return {
    background: normalizeHexColor(background || '#08090b', '#08090b'),
    accent: normalizeHexColor(accent, '#00f5d4'),
    secondary: normalizeHexColor(secondary, accent),
    ink: normalizeHexColor(ink, '#e8ecef'),
    name: theme.name || data.name || ''
  };
}

function applyAiThemeJson() {
  var input = document.getElementById('ai-theme-json');
  try {
    var colors = parseAiThemePayload(input && input.value);
    if (!colors) {
      showToast('没有读到颜色 JSON');
      return;
    }
    applyGeneratedAiTheme(colors, colors.name ? ('已应用 ' + colors.name) : '已应用 AI 主题');
    toggleAiThemeImport(false);
  } catch (err) {
    showToast('JSON 无法解析');
  }
}

function bindAppThemeGrid() {
  var grid = document.getElementById('app-theme-grid');
  if (!grid || grid._themeBound) return;
  grid._themeBound = true;
  grid.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('[data-app-theme]') : null;
    if (!btn) return;
    setAppTheme(btn.getAttribute('data-app-theme'));
  });
}
function updateUiAccentControls() {
  applyUiAccentColor();
  var color = normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4');
  var picker = document.getElementById('ui-accent-picker');
  var value = document.getElementById('ui-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
function setUiAccentColor(color, silent) {
  fx.uiAccentColor = normalizeHexColor(color || '#00f5d4', '#00f5d4');
  updateUiAccentControls();
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  saveLyricLayout();
  if (!silent) showToast('界面高亮: ' + fx.uiAccentColor.toUpperCase());
}
function resetUiAccentColor() {
  setUiAccentColor(fxDefaults.uiAccentColor || '#00f5d4');
}
function updateVisualTintControls() {
  var picker = document.getElementById('visual-tint-picker');
  var value = document.getElementById('visual-tint-value');
  var autoBtn = document.getElementById('visual-tint-auto-btn');
  var color = normalizeHexColor(fx.visualTintColor || '#9db8cf');
  document.documentElement.style.setProperty('--visual-tint', color);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.visualTintMode === 'custom' ? color.toUpperCase() : '封面取色';
  if (autoBtn) autoBtn.classList.toggle('active', fx.visualTintMode !== 'custom');
}
function setVisualTintAuto() {
  fx.visualTintMode = 'auto';
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  showToast('视觉主色: 封面取色');
}
function resetVisualTintColor() {
  fx.visualTintMode = 'auto';
  fx.visualTintColor = normalizeHexColor(fxDefaults.visualTintColor || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  showToast('视觉主色已恢复默认');
}
function setVisualTintCustom(color, silent) {
  fx.visualTintMode = 'custom';
  fx.visualTintColor = normalizeHexColor(color || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  if (!silent) showToast('视觉主色: ' + fx.visualTintColor.toUpperCase());
}
var coverColorPickerState = { target: 'visualTint', canvas: null };
function currentCoverPickerCanvas() {
  if (coverPickerCanvas && coverPickerCanvas.getContext) return coverPickerCanvas;
  if (coverTex && coverTex.image && coverTex.image.getContext) return coverTex.image;
  return null;
}
function coverPickerSwatchColors() {
  var pal = stageLyrics.coverPalette || stageLyrics.palette || {};
  var list = [pal.primary, pal.secondary, pal.highlight, fx.visualTintColor, fx.uiAccentColor, fx.homeAccentColor]
    .map(function(c){ return normalizeHexColor(c || '', ''); })
    .filter(function(c){ return /^#[0-9a-f]{6}$/i.test(c); });
  var seen = {};
  return list.filter(function(c){
    if (seen[c]) return false;
    seen[c] = true;
    return true;
  }).slice(0, 5);
}
function setCoverPickerPreview(hex) {
  var preview = document.getElementById('cover-color-preview');
  if (preview) preview.style.setProperty('--picked', normalizeHexColor(hex || '#9db8cf'));
}
function renderCoverPickerSwatches() {
  var wrap = document.getElementById('cover-color-swatches');
  if (!wrap) return;
  var colors = coverPickerSwatchColors();
  wrap.innerHTML = colors.map(function(c){
    return '<button type="button" style="--c:' + c + '" title="' + c.toUpperCase() + '" onclick="applyCoverPickerColor(\'' + c + '\')"></button>';
  }).join('');
}
function openCoverColorPicker(target) {
  target = target || 'visualTint';
  var pop = document.getElementById('cover-color-pop');
  var art = document.getElementById('cover-color-art');
  var hint = document.getElementById('cover-color-hint');
  if (pop && pop.classList.contains('show') && coverColorPickerState.target === target) {
    closeCoverColorPicker();
    return;
  }
  var cv = currentCoverPickerCanvas();
  coverColorPickerState.target = target;
  coverColorPickerState.canvas = cv;
  if (!pop || !art) return;
  if (!cv) {
    setVisualTintAuto();
    closeCoverColorPicker();
    showToast('暂无封面，已切换为自动封面取色');
    return;
  }
  var imgSrc = '';
  try { imgSrc = cv.toDataURL('image/jpeg', 0.84); } catch (e) {}
  if (!imgSrc && currentCoverSource && currentCoverSource.src) imgSrc = currentCoverSource.src;
  art.style.backgroundImage = imgSrc ? 'url("' + cssImageUrl(imgSrc) + '")' : '';
  setCoverPickerPreview(fx.visualTintColor || (stageLyrics.coverPalette && stageLyrics.coverPalette.primary) || '#9db8cf');
  renderCoverPickerSwatches();
  if (hint) hint.textContent = '点击专辑封面任意位置取色，或使用下方推荐色。';
  pop.classList.add('show');
  placeFxFloatingPanel(pop, document.getElementById('visual-tint-auto-btn') || document.getElementById('visual-tint-picker') || art, { gap: 12, pad: 14 });
}
function closeCoverColorPicker() {
  var pop = document.getElementById('cover-color-pop');
  if (pop) pop.classList.remove('show');
  hideCoverColorLoupe();
}
function applyCoverPickerColor(hex) {
  hex = normalizeHexColor(hex || '#9db8cf');
  setCoverPickerPreview(hex);
  if (coverColorPickerState.target === 'visualTint') {
    setVisualTintCustom(hex, true);
    showToast('视觉主色: ' + hex.toUpperCase());
  }
  closeCoverColorPicker();
}
function moveCoverColorLoupe(e) {
  var cv = coverColorPickerState.canvas || currentCoverPickerCanvas();
  var loupe = document.getElementById('cover-color-loupe');
  var art = document.getElementById('cover-color-art');
  if (!cv || !loupe || !art) return;
  var rect = art.getBoundingClientRect();
  var x = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  var y = clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  var imgSrc = '';
  try { imgSrc = cv.toDataURL('image/jpeg', 0.84); } catch (err) {}
  if (imgSrc) {
    loupe.style.backgroundImage = 'url("' + cssImageUrl(imgSrc) + '")';
    loupe.style.backgroundSize = '680% 680%';
    loupe.style.backgroundPosition = (x * 100).toFixed(2) + '% ' + (y * 100).toFixed(2) + '%';
  }
  loupe.style.left = Math.min(window.innerWidth - 128, e.clientX + 18) + 'px';
  loupe.style.top = Math.min(window.innerHeight - 128, e.clientY + 18) + 'px';
  loupe.classList.add('show');
}
function hideCoverColorLoupe() {
  var loupe = document.getElementById('cover-color-loupe');
  if (loupe) loupe.classList.remove('show');
}
function pickCoverColorFromArt(e) {
  var cv = coverColorPickerState.canvas || currentCoverPickerCanvas();
  if (!cv || !cv.getContext) return;
  var rect = e.currentTarget.getBoundingClientRect();
  var x = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  var y = clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  var sx = Math.max(0, Math.min(cv.width - 1, Math.floor(x * cv.width)));
  var sy = Math.max(0, Math.min(cv.height - 1, Math.floor(y * cv.height)));
  try {
    var data = cv.getContext('2d').getImageData(sx, sy, 1, 1).data;
    applyCoverPickerColor(rgbToHexColor(data[0], data[1], data[2]));
  } catch (err) {
    showToast('封面取色不可用，已保留自动取色');
    setVisualTintAuto();
    closeCoverColorPicker();
  }
}
function updateLyricFontControls() {
  document.querySelectorAll('#lyric-font-grid button').forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.font === normalizeLyricFontKey(fx.lyricFont));
  });
}
function setLyricFont(key) {
  fx.lyricFont = normalizeLyricFontKey(key);
  updateLyricFontControls();
  refreshCurrentLyricStyle();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  showToast('歌词字体已切换');
}
function setLyricGlowLinked(linked, openPicker) {
  fx.lyricGlowLinked = linked !== false;
  if (!fx.lyricGlowLinked) fx.lyricGlowColor = normalizeHexColor(fx.lyricGlowColor || fx.lyricHighlightColor || '#9db8cf');
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricGlowControls();
  saveLyricLayout();
  if (openPicker) {
    setTimeout(function(){
      var picker = document.getElementById('lyric-glow-picker');
      if (picker) picker.click();
    }, 0);
  }
}
function toggleLyricGlowLink(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  setLyricGlowLinked(fx.lyricGlowLinked === false);
}
function handleLyricGlowRowClick(e) {
  if (fx.lyricGlowLinked !== false) {
    if (e && e.preventDefault) e.preventDefault();
    setLyricGlowLinked(false, true);
  }
}
function setLyricGlowCustom(color, silent) {
  fx.lyricGlowLinked = false;
  fx.lyricGlowColor = normalizeHexColor(color || '#9db8cf');
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricGlowControls();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  if (!silent) showToast('溢光颜色: ' + fx.lyricGlowColor.toUpperCase());
}
function setLyricColorAuto() {
  fx.lyricColorMode = 'auto';
  setStageLyricPalette(stageLyrics.coverPalette || stageLyrics.palette);
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  showToast('歌词颜色: 封面取色');
}
function setLyricColorCustom(color, silent) {
  fx.lyricColorMode = 'custom';
  fx.lyricColor = normalizeHexColor(color);
  setStageLyricPalette(lyricPaletteFromHex(fx.lyricColor));
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  if (!silent) showToast('歌词颜色: ' + fx.lyricColor.toUpperCase());
}
function setLyricColorPreset(i) {
  var p = lyricColorPresets[i];
  if (!p) return;
  setLyricColorCustom(p.color);
}
function setLyricHighlightAuto() {
  fx.lyricHighlightMode = 'auto';
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  showToast('高亮颜色: 跟随歌词');
}
function setLyricHighlightCustom(color, silent) {
  fx.lyricHighlightMode = 'custom';
  fx.lyricHighlightColor = normalizeHexColor(color);
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  pushDesktopLyricsState(true);
  if (!silent) showToast('高亮颜色: ' + fx.lyricHighlightColor.toUpperCase());
}

function buildPresetGrid() {
  var grid = document.getElementById('preset-grid');
  if (!grid || !Array.isArray(presetMeta) || !presetMeta.length) return;
  var seen = {};
  var order = (presetDisplayOrder || []).filter(function(id){
    var ok = id >= 0 && id < presetMeta.length && !seen[id];
    seen[id] = true;
    return ok;
  });
  presetMeta.forEach(function(_, id){
    if (!seen[id]) order.push(id);
  });
  grid.innerHTML = order.map(function(i){
    var p = presetMeta[i];
    var name = p.nameHtml || p.name;
    var desc = p.descHtml || p.desc;
    var card = '<div class="preset-card" data-preset="' + i + '" onclick="setPreset(' + i + ')">' +
      '<div class="pc-icon">' + presetIcons[i] + '</div>' +
      '<div class="pc-name">' + name + '</div>' +
      '<div class="pc-desc">' + desc + '</div>' +
    '</div>';
    return card;
  }).join('');
  refreshPresetGrid();
  if (window.MineradioFolia && typeof window.MineradioFolia.syncUi === 'function') window.MineradioFolia.syncUi();
}
function refreshPresetGrid() {
  document.querySelectorAll('.preset-card').forEach(function(el){
    el.classList.toggle('active', Number(el.dataset.preset) === fx.preset);
  });
}
function triggerPresetParticleTransition(fromPreset, toPreset) {
  presetTransition.active = true;
  presetTransition.start = uniforms.uTime.value;
  presetTransition.duration = toPreset === 5 ? 0.30 : 0.24;
  presetTransition.from = fromPreset;
  presetTransition.to = toPreset;
  var newVisual = toPreset >= 4;
  var wallpaperFlow = toPreset === 5;
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + (newVisual ? (wallpaperFlow ? 0.008 : 0.024) : 0.12));
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wallpaperFlow ? 0.05 : 0.15);
  camPunch = Math.max(camPunch, wallpaperFlow ? 0.04 : 0.12);
  for (var i = 0; i < 3; i++) {
    triggerRipple((Math.random() - 0.5) * 3.4, (Math.random() - 0.5) * 3.4, 0.58 + Math.random() * 0.32);
  }
  var card = document.querySelector('.preset-card[data-preset="' + toPreset + '"]');
  if (card) {
    card.classList.remove('switching');
    void card.offsetWidth;
    card.classList.add('switching');
    setTimeout(function(){ card.classList.remove('switching'); }, 760);
  }
}
function tickPresetTransition() {
  if (!presetTransition.active) return;
  var raw = (uniforms.uTime.value - presetTransition.start) / presetTransition.duration;
  var t = Math.max(0, Math.min(1, raw));
  var wave = Math.sin(t * Math.PI);
  var newVisual = presetTransition.to >= 4;
  var wallpaperFlow = presetTransition.to === 5;
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + wave * (newVisual ? (wallpaperFlow ? 0.008 : 0.026) : 0.16));
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wave * (wallpaperFlow ? 0.045 : (newVisual ? 0.12 : 0.15)));
  uniforms.uPointScale.value = fx.point * (1 + wave * (wallpaperFlow ? 0.016 : 0.048));
  if (raw >= 1) {
    presetTransition.active = false;
    syncFxUniforms();
  }
}
function ensureSonicTopography() {
  if (window.MineradioSonicTopography || document.getElementById('sonic-topography-script')) return;
  var script = document.createElement('script');
  script.id = 'sonic-topography-script';
  script.src = 'sonic-topography-preset.js';
  script.async = true;
  document.body.appendChild(script);
}
/* Folia 全屏歌词盖住 MR 画布：切到 Mineradio 预设/面板时自动退出 Folia 歌词，无需先点「关闭」。 */
function releaseFoliaStageForMineradio(opts) {
  opts = opts || {};
  try {
    var api = window.MineradioFolia;
    if (!api || typeof api.isEnabled !== 'function' || !api.isEnabled()) return false;
    if (typeof api.setMode === 'function') api.setMode('off', { silent: true });
    if (!opts.silent && typeof showToast === 'function') showToast('已切回 Mineradio 视觉');
    return true;
  } catch (_) {
    return false;
  }
}
window.releaseFoliaStageForMineradio = releaseFoliaStageForMineradio;

function setPreset(p, opts) {
  opts = opts || {};
  p = migrateVisualPresetIndex(p);
  p = Math.max(0, Math.min(presetMeta.length - 1, Number(p) || 0));
  var prev = fx.preset;
  var changed = prev !== p;
  var releasedFolia = false;
  /* 用户点选 MR 预设时自动让出舞台；静默恢复（启动/内部同步）不打断 Folia。 */
  if (!opts.silent && !opts.keepFolia) {
    releasedFolia = releaseFoliaStageForMineradio({ silent: true });
  }
  fx.preset = p;
  if (p === 7) ensureSonicTopography();
  if (changed && prev === SKULL_PRESET_INDEX && p !== SKULL_PRESET_INDEX) clearSkullPresetResidue();
  if (p === SKULL_PRESET_INDEX) loadSkullParticleAsset();
  if (changed && p === VOID_PRESET_INDEX) dismissPlaybackBeatAnalysis(true);
  else if (changed && prev === VOID_PRESET_INDEX && p !== VOID_PRESET_INDEX) resumePlaybackBeatAnalysisIfNeeded();
  uniforms.uPreset.value = p;
  refreshPresetGrid();
  if (changed && !opts.skipTransition) triggerPresetParticleTransition(prev, p);
  // 每个预设对应的相机基线 (改 userOrbit)
  if (changed && !opts.preserveCamera) {
    if (p === 1)      { orbit.userRadius = 6.2; orbit.userPhi = 0.03; orbit.userTheta = 0.0; orbit.baselineRadius = 6.2; orbit.baselinePhi = 0.03; }
    else if (p === 2) { orbit.userRadius = 7.0; orbit.userPhi = 0.15; orbit.userTheta = 0.0; orbit.baselineRadius = 7.0; orbit.baselinePhi = 0.15; }
    else if (p === 3) { orbit.userRadius = 8.0; orbit.userPhi = 0.05; orbit.userTheta = 0.0; orbit.baselineRadius = 8.0; orbit.baselinePhi = 0.05; }
    else if (p === 4) { orbit.userRadius = 6.5; orbit.userPhi = 0.04; orbit.userTheta = 0.0; orbit.baselineRadius = 6.5; orbit.baselinePhi = 0.04; }
    else if (p === 5) { orbit.userRadius = 9.4; orbit.userPhi = 0.34; orbit.userTheta = -0.52; orbit.baselineRadius = 9.4; orbit.baselinePhi = 0.34; }
    else if (p === 6) { orbit.userRadius = 7.4; orbit.userPhi = 0.10; orbit.userTheta = 0.18; orbit.baselineRadius = 7.4; orbit.baselinePhi = 0.10; }
    else if (p === 7) { orbit.userRadius = 8.6; orbit.userPhi = 0.22; orbit.userTheta = 0.0; orbit.baselineRadius = 8.6; orbit.baselinePhi = 0.22; }
    else              { orbit.userRadius = 6.6; orbit.userPhi = 0.08; orbit.userTheta = 0.0; orbit.baselineRadius = 6.6; orbit.baselinePhi = 0.08; }
    orbit.baselineTheta = p === 5 ? -0.52 : (p === 6 ? 0.18 : 0.0);
  }
  if (changed && !opts.silent) {
    showToast('视觉预设: ' + presetMeta[p].name + (releasedFolia ? ' · 已退出 Folia 歌词' : ''));
  } else if (!changed && releasedFolia && !opts.silent) {
    showToast('已切回 Mineradio 视觉: ' + presetMeta[p].name);
  }
  var shouldCommitPlaybackPreset = !!opts.commitPlaybackPreset || !opts.noSave;
  if (shouldCommitPlaybackPreset) {
    playbackVisualPreset = p;
    startupVisualPreviewActive = false;
  }
  if (!opts.noSave) {
    saveLyricLayout();
  }
  try {
    if (changed && window.MineradioSonicTopography && typeof MineradioSonicTopography.onPresetChange === 'function') {
      MineradioSonicTopography.onPresetChange(prev, p, {
        scene: typeof scene !== 'undefined' ? scene : null,
        fx: fx
      });
    }
  } catch (_) {}
  updateFxConsoleStatus();
}

function syncFxUniforms() {
  uniforms.uPreset.value = fx.preset;
  uniforms.uIntensity.value = fx.intensity;
  uniforms.uDepth.value = fx.depth;
  uniforms.uPointScale.value = fx.point;
  uniforms.uSpeed.value = fx.speed;
  uniforms.uTwist.value = fx.twist;
  uniforms.uColorBoost.value = fx.color;
  uniforms.uScatter.value = fx.scatter;
  uniforms.uCoverRes.value = normalizeCoverResolution(fx.coverResolution);
  uniforms.uBgFade.value = fx.bgFade;
  uniforms.uBloomStrength.value = fx.bloom ? fx.bloomStrength : 0;
  if (bloomParticles) bloomParticles.visible = fx.bloom && fx.bloomStrength > 0.01;
  uniforms.uEdgeEnabled.value = fx.edge ? 1 : 0;
  if (uniforms.uTintColor) uniforms.uTintColor.value.set(normalizeHexColor(fx.visualTintColor || '#9db8cf'));
  if (uniforms.uTintStrength) uniforms.uTintStrength.value = fx.visualTintMode === 'custom' ? 0.42 : 0;
  syncSkullParticleColors();
}
var homeWaveTrackState = { bars: 0, smooth: [] };
function ensureHomeWaveTrackBars() {
  var el = document.getElementById('home-wave-track');
  if (!el) return;
  var count = 24;
  if (homeWaveTrackState.bars === count && el.children.length === count) return;
  homeWaveTrackState.bars = count;
  homeWaveTrackState.smooth = new Array(count).fill(0);
  el.innerHTML = new Array(count + 1).join('<span></span>');
}
function updateHomeAudioVisual(dt) {
  if (!emptyHomeActive) return;
  var wave = document.getElementById('home-wave-track');
  if (!wave) return;
  var nowMs = performance.now();
  if (homeWaveTrackState.lastAt && nowMs - homeWaveTrackState.lastAt < 80) return;
  homeWaveTrackState.lastAt = nowMs;
  ensureHomeWaveTrackBars();
  var bars = wave.children;
  var nowT = uniforms && uniforms.uTime ? uniforms.uTime.value : performance.now() / 1000;
  for (var i = 0; i < bars.length; i++) {
    var ratio = bars.length > 1 ? i / (bars.length - 1) : 0;
    var bin = 0;
    if (frequencyData && frequencyData.length) {
      bin = (frequencyData[Math.min(frequencyData.length - 1, Math.floor(Math.pow(ratio, 1.2) * (frequencyData.length - 1)))] || 0) / 255;
    } else {
      bin = 0.16 + Math.sin(nowT * 1.4 + i * 0.34) * 0.06;
    }
    var target = clampRange(Math.max(bin, smoothBass * 0.35 + smoothMid * 0.18 + beatPulse * 0.24), 0.03, 1);
    var prev = homeWaveTrackState.smooth[i] || 0;
    prev += (target - prev) * (target > prev ? 0.34 : 0.12);
    homeWaveTrackState.smooth[i] = prev;
    bars[i].style.height = Math.max(4, prev * 18) + 'px';
    bars[i].style.opacity = String(clampRange(0.36 + prev * 0.68, 0.32, 1));
  }
}
function setRange(id, value) {
  var el = document.getElementById(id);
  if (!el) return;
  if (id === 'fx-lyricglow') value = Math.min(0.85, Math.max(0, value));
  if (id === 'fx-coverres') value = normalizeCoverResolution(value);
  if (id === 'fx-glassaberration') value = normalizeControlGlassChromaticOffset(value);
  el.value = value;
  var out = el.parentElement.querySelector('output');
  if (out) out.textContent = id === 'fx-coverres'
    ? coverParticleCountLabel(value)
    : (id === 'fx-lyricweight' || id === 'fx-glassaberration' || id === 'fx-lyrictiltx' || id === 'fx-lyrictilty' || id === 'fx-shelfangle' ? String(Math.round(Number(value) || 0)) : Number(value).toFixed(id === 'fx-lyricspacing' ? 3 : 2));
}
function hasDesktopFxChrome() {
  return !!(document.getElementById('t-desktopLyrics') || document.getElementById('t-wallpaperMode'));
}
function updateDevelopmentFxControls() {
  if (!hasDesktopFxChrome()) return;
  [
    ['desktopLyrics', 't-desktopLyrics', '全屏幕置顶歌词'],
    ['desktopLyricsClickThrough', 't-desktopLyricsClickThrough', '锁定后防误触；鼠标移到桌面歌词上按中键可锁定/解锁'],
    ['desktopLyricsCinema', 't-desktopLyricsCinema', '桌面歌词绑定鼓点电影震动，基础漂浮始终保留'],
    ['desktopLyricsHighlight', 't-desktopLyricsHighlight', '桌面歌词按播放进度高亮'],
    ['wallpaperMode', 't-wallpaperMode', '开发中，暂不可用']
  ].forEach(function(item){
    var locked = isDevelopmentLockedFx(item[0]);
    var el = document.getElementById(item[1]);
    if (!el) return;
    el.classList.toggle('dev-locked', locked);
    if (locked) {
      el.classList.remove('on');
      el.setAttribute('aria-disabled', 'true');
      el.title = '开发中，暂不可用';
    } else {
      el.removeAttribute('aria-disabled');
      el.title = item[2];
    }
  });
  [
    ['desktopLyrics', 'fx-desktoplyricssize'],
    ['desktopLyrics', 'fx-desktoplyricsopacity'],
    ['desktopLyrics', 'fx-desktoplyricsy'],
    ['wallpaperMode', 'fx-wallpaperopacity']
  ].forEach(function(item){
    var locked = isDevelopmentLockedFx(item[0]);
    var input = document.getElementById(item[1]);
    if (!input) return;
    input.disabled = locked;
    var row = input.closest && input.closest('.fx-slider');
    if (row) row.classList.toggle('dev-locked', locked);
  });
}
function updateDesktopLyricsFpsControls() {
  if (!document.getElementById('desktop-lyrics-fps-seg')) return;
  var fps = normalizeDesktopLyricsFps(fx.desktopLyricsFps);
  document.querySelectorAll('#desktop-lyrics-fps-seg [data-desktop-lyrics-fps]').forEach(function(btn){
    btn.classList.toggle('active', normalizeDesktopLyricsFps(btn.getAttribute('data-desktop-lyrics-fps')) === fps);
  });
}
function updatePerformanceControls() {
  fx.performanceBackground = normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true);
  fx.liveBackgroundKeep = fx.performanceBackground === 'keep';
  fx.performanceQuality = normalizePerformanceQuality(fx.performanceQuality);
  document.querySelectorAll('#performance-background-seg [data-performance-background]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-performance-background') === fx.performanceBackground);
  });
  document.querySelectorAll('#performance-quality-seg [data-performance-quality]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-performance-quality') === fx.performanceQuality);
  });
  var liveBackgroundKeepToggle = document.getElementById('t-liveBackgroundKeep');
  if (liveBackgroundKeepToggle) liveBackgroundKeepToggle.classList.toggle('on', fx.liveBackgroundKeep === true);
}
function setPerformanceBackgroundMode(mode, silent) {
  var next = normalizePerformanceBackgroundMode(mode, false);
  fx.performanceBackground = next;
  fx.liveBackgroundKeep = next === 'keep';
  updatePerformanceControls();
  saveLyricLayout();
  updateRenderPowerClasses();
  applyRendererPowerMode();
  if (next === 'keep') recoverVisualsAfterBackground('performance-background-keep');
  else if (next === 'release' && isDeepBackgroundMode()) trimRuntimeCaches('performance-release', true);
  if (!silent) {
    showToast(next === 'keep' ? '后台策略: 保持运行' : (next === 'release' ? '后台策略: 停止并释放' : '后台策略: 自动优化'));
  }
}
function setPerformanceQualityMode(mode, silent) {
  var next = normalizePerformanceQuality(mode);
  fx.performanceQuality = next;
  updatePerformanceControls();
  applyRendererPowerMode();
  saveLyricLayout();
  if (!silent) {
    var label = next === 'eco' ? '低' : (next === 'balanced' ? '中' : (next === 'ultra' ? '超高' : '高'));
    showToast('画质档位: ' + label);
  }
}
function updateFxInputs() {
  normalizeDevelopmentLockedFxState();
  applyShelfCameraDefaultAngle(false);
  setRange('fx-intensity', fx.intensity);
  setRange('fx-cineshake', fx.cinemaShake);
  setRange('fx-depth', fx.depth);
  setRange('fx-coverres', fx.coverResolution);
  setRange('fx-lyricglow', fx.lyricGlowStrength);
  setRange('fx-bgopacity', fx.backgroundOpacity == null ? 1 : fx.backgroundOpacity);
  setRange('fx-glassaberration', fx.controlGlassChromaticOffset);
  setRange('fx-desktoplyricssize', fx.desktopLyricsSize);
  setRange('fx-desktoplyricsopacity', fx.desktopLyricsOpacity);
  setRange('fx-desktoplyricsy', fx.desktopLyricsY);
  setRange('fx-wallpaperopacity', fx.wallpaperOpacity);
  setRange('fx-shelfsize', fx.shelfSize);
  setRange('fx-shelfx', fx.shelfOffsetX);
  setRange('fx-shelfy', fx.shelfOffsetY);
  setRange('fx-shelfz', fx.shelfOffsetZ);
  setRange('fx-shelfangle', fx.shelfAngleY);
  setRange('fx-shelfopacity', fx.shelfOpacity);
  setRange('fx-shelfbgalpha', fx.shelfBgOpacity);
  setRange('fx-lyricspacing', fx.lyricLetterSpacing);
  setRange('fx-lyriclineheight', fx.lyricLineHeight);
  setRange('fx-lyricweight', fx.lyricWeight);
  setRange('fx-lyricscale', fx.lyricScale);
  setRange('fx-lyricx', fx.lyricOffsetX);
  setRange('fx-lyricy', fx.lyricOffsetY);
  setRange('fx-lyricz', fx.lyricOffsetZ);
  setRange('fx-lyrictiltx', fx.lyricTiltX);
  setRange('fx-lyrictilty', fx.lyricTiltY);
  setRange('fx-point', fx.point);
  setRange('fx-speed', fx.speed);
  setRange('fx-twist', fx.twist);
  setRange('fx-color', fx.color);
  setRange('fx-bloom', fx.bloomStrength);
  setRange('fx-scatter', fx.scatter);
  setRange('fx-bgfade', fx.bgFade);
  updateLyricGlowControls();
  if (typeof window.syncLyricDiyControls === 'function') window.syncLyricDiyControls();
  // 同步开关
  document.getElementById('t-float').classList.toggle('on', fx.floatLayer);
  var floatToggle = document.getElementById('t-float');
  if (floatToggle) floatToggle.classList.toggle('on', fx.floatLayer);
  document.getElementById('t-cinema').classList.toggle('on', fx.cinema);
  var lyricGlowToggle = document.getElementById('t-lyricGlow');
  if (lyricGlowToggle) lyricGlowToggle.classList.toggle('on', fx.lyricGlow);
  var lyricGlowBeatToggle = document.getElementById('t-lyricGlowBeat');
  if (lyricGlowBeatToggle) lyricGlowBeatToggle.classList.toggle('on', fx.lyricGlowBeat);
  var lyricGlowParticlesToggle = document.getElementById('t-lyricGlowParticles');
  if (lyricGlowParticlesToggle) lyricGlowParticlesToggle.classList.toggle('on', fx.lyricGlowParticles);
  var lyricCameraLockToggle = document.getElementById('t-lyricCameraLock');
  if (lyricCameraLockToggle) lyricCameraLockToggle.classList.toggle('on', fx.lyricCameraLock);
  document.getElementById('t-bloom').classList.toggle('on', fx.bloom);
  document.getElementById('t-edge').classList.toggle('on', fx.edge);
  var desktopLyricsToggle = document.getElementById('t-desktopLyrics');
  if (desktopLyricsToggle) desktopLyricsToggle.classList.toggle('on', fx.desktopLyrics);
  var desktopLyricsClickToggle = document.getElementById('t-desktopLyricsClickThrough');
  if (desktopLyricsClickToggle) desktopLyricsClickToggle.classList.toggle('on', fx.desktopLyricsClickThrough !== false);
  var desktopLyricsCinemaToggle = document.getElementById('t-desktopLyricsCinema');
  if (desktopLyricsCinemaToggle) desktopLyricsCinemaToggle.classList.toggle('on', fx.desktopLyricsCinema !== false);
  var desktopLyricsHighlightToggle = document.getElementById('t-desktopLyricsHighlight');
  if (desktopLyricsHighlightToggle) desktopLyricsHighlightToggle.classList.toggle('on', fx.desktopLyricsHighlight === true);
  updateDesktopLyricsFpsControls();
  var wallpaperModeToggle = document.getElementById('t-wallpaperMode');
  if (wallpaperModeToggle) wallpaperModeToggle.classList.toggle('on', fx.wallpaperMode);
  var shelfPodcastsToggle = document.getElementById('t-shelfShowPodcasts');
  if (shelfPodcastsToggle) shelfPodcastsToggle.classList.toggle('on', fx.shelfShowPodcasts !== false);
  var shelfMergeToggle = document.getElementById('t-shelfMergeCollections');
  if (shelfMergeToggle) shelfMergeToggle.classList.toggle('on', fx.shelfMergeCollections === true);
  var liveBackgroundKeepToggle = document.getElementById('t-liveBackgroundKeep');
  if (liveBackgroundKeepToggle) liveBackgroundKeepToggle.classList.toggle('on', fx.liveBackgroundKeep === true);
  updatePerformanceControls();
  updateDevelopmentFxControls();
  var aiDepthToggle = document.getElementById('t-aidepth');
  if (aiDepthToggle) aiDepthToggle.classList.toggle('on', fx.aiDepth);
  // 三态
  document.querySelectorAll('#shelf-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.shelf === fx.shelf); });
  updateShelfControlUi();
  document.querySelectorAll('#cam-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.cam === fx.cam); });
  refreshPresetGrid();
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  updateLyricFontControls();
  updateUiAccentControls();
  updateHomeAccentControls();
  updateIconAccentControls();
  updateCustomBackgroundControls();
  updateVisualTintControls();
  applyControlGlassChromaticOffset();
  syncFxUniforms();
}
function animateFxResetButton(btn) {
  if (!btn || !window.gsap) return;
  window.gsap.fromTo(btn, { rotate: -120, scale: 0.88 }, { rotate: 0, scale: 1, duration: 0.48, ease: 'expo.out', overwrite: true });
  window.gsap.fromTo(btn, { boxShadow: '0 0 0 0 rgba(244,210,138,.38)' }, { boxShadow: '0 0 0 8px rgba(244,210,138,0)', duration: 0.55, ease: 'sine.out', overwrite: true });
}
function resetFxSliderValue(id, key, btn) {
  if (!Object.prototype.hasOwnProperty.call(fxDefaults, key)) return;
  if (key === 'shelfAngleY') {
    fx.shelfAngleYManual = false;
    fx.shelfAngleY = shelfDefaultAngleForCameraMode(fx.shelfCameraMode);
  } else {
    fx[key] = fxDefaults[key];
  }
  setRange(id, fx[key]);
  if (key === 'coverResolution') applyCoverParticleResolution(fx[key], { reload: true });
  if (key === 'controlGlassChromaticOffset') applyControlGlassChromaticOffset();
  syncFxUniforms();
  if (key === 'lyricLetterSpacing' || key === 'lyricLineHeight' || key === 'lyricWeight') refreshCurrentLyricStyle();
  saveLyricLayout();
  animateFxResetButton(btn);
  showToast('已恢复默认数值');
}
function ensureFxSliderResetButton(id, key) {
  var el = document.getElementById(id);
  if (!el || !el.parentElement || el.parentElement.querySelector('.fx-reset-one')) return;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fx-reset-one';
  btn.title = '恢复当前滑条默认值';
  btn.setAttribute('aria-label', '恢复当前滑条默认值');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  btn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    resetFxSliderValue(id, key, btn);
  });
  el.parentElement.appendChild(btn);
}
var FX_PANEL_TAB_STORE_KEY = 'mineradio-fx-panel-tab-v1';
var fxPanelTab = (function(){
  try {
    var saved = localStorage.getItem(FX_PANEL_TAB_STORE_KEY);
    if (/^(presets|appearance|lyrics|motion|advanced)$/.test(saved || '')) return saved;
  } catch (_) {}
  return 'presets';
})();
var FX_TAB_META = [
  { id: 'presets', label: '预设', hint: 'Mineradio 视觉预设或 Folia 歌词动画', icon: '◇' },
  { id: 'appearance', label: '外观', hint: '主题、AI 配色与背景', icon: '◐' },
  { id: 'lyrics', label: '歌词', hint: '行数、翻译与字体', icon: '〰' },
  { id: 'motion', label: '动态', hint: '律动、音域与镜头', icon: '⌁' },
  { id: 'advanced', label: '高级', hint: '性能与粒子细节', icon: '⚙' }
];
var PRESETS_SURFACE_STORE_KEY = 'mineradio-presets-surface-v1';
var presetsSurface = (function(){
  try {
    var saved = localStorage.getItem(PRESETS_SURFACE_STORE_KEY);
    if (saved === 'folia' || saved === 'mr') return saved;
  } catch (_) {}
  return 'mr';
})();
function setPresetsSurface(surface, opts) {
  opts = opts || {};
  var next = surface === 'folia' ? 'folia' : 'mr';
  var prevSurface = presetsSurface;
  presetsSurface = next;
  try { localStorage.setItem(PRESETS_SURFACE_STORE_KEY, presetsSurface); } catch (_) {}
  var mr = document.getElementById('mr-presets-surface');
  var folia = document.getElementById('folia-presets-surface');
  if (mr) mr.hidden = next !== 'mr';
  if (folia) folia.hidden = next !== 'folia';
  document.querySelectorAll('#presets-surface-seg [data-presets-surface]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-presets-surface') === next);
  });
  if (next === 'folia' && typeof window.MineradioFolia !== 'undefined' && window.MineradioFolia && typeof window.MineradioFolia.syncUi === 'function') {
    try { window.MineradioFolia.syncUi(); } catch (_) {}
  } else if (next === 'folia' && typeof window.__mineradioEnsureFoliaHost === 'function') {
    try { window.__mineradioEnsureFoliaHost(); } catch (_) {}
  }
  /* 切到 Mineradio 预设体系时自动关闭 Folia 全屏歌词，立即露出 MR 粒子效果 */
  if (next === 'mr' && prevSurface !== 'mr' && !opts.silent && !opts.keepFolia) {
    releaseFoliaStageForMineradio({ silent: false });
  }
  if (!opts.silent) updateFxConsoleStatus();
}
window.setPresetsSurface = setPresetsSurface;
function fxTabMeta(id) {
  for (var i = 0; i < FX_TAB_META.length; i++) if (FX_TAB_META[i].id === id) return FX_TAB_META[i];
  return FX_TAB_META[0];
}
function updateFxConsoleStatus() {
  var status = document.getElementById('fx-console-status');
  if (!status) return;
  var meta = fxTabMeta(fxPanelTab);
  var presetName = '';
  try {
    if (fxPanelTab === 'presets' && presetsSurface === 'folia') {
      var foliaApi = window.MineradioFolia;
      if (foliaApi && typeof foliaApi.getMode === 'function') {
        var modeId = foliaApi.getMode();
        var modes = foliaApi.modes || [];
        for (var mi = 0; mi < modes.length; mi++) {
          if (modes[mi].id === modeId) { presetName = modes[mi].label || modeId; break; }
        }
        if (!presetName) presetName = modeId === 'off' ? '关闭' : String(modeId || 'Folia');
      } else {
        presetName = 'Folia';
      }
    } else if (typeof presetMeta !== 'undefined' && presetMeta && fx && presetMeta[fx.preset]) {
      presetName = String(presetMeta[fx.preset].name || '').replace(/<[^>]+>/g, '');
    }
  } catch (_) {}
  status.textContent = meta.label + (presetName ? (' · ' + presetName) : (' · ' + meta.hint));
}
function setFxPanelTab(tab, opts) {
  opts = opts || {};
  var allowed = { presets:1, appearance:1, lyrics:1, motion:1, advanced:1 };
  var next = allowed[tab] ? tab : 'presets';
  var changed = next !== fxPanelTab;
  fxPanelTab = next;
  try { localStorage.setItem(FX_PANEL_TAB_STORE_KEY, fxPanelTab); } catch (_) {}
  var panel = document.getElementById('fx-panel');
  if (panel) panel.setAttribute('data-active-tab', fxPanelTab);
  document.querySelectorAll('#fx-panel-tabs [data-fx-tab]').forEach(function(btn){
    var on = btn.getAttribute('data-fx-tab') === fxPanelTab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#fx-panel .fx-tab-page').forEach(function(page){
    var on = page.getAttribute('data-fx-page') === fxPanelTab;
    page.classList.toggle('active', on);
    if (on && changed && !opts.silent) {
      page.classList.remove('fx-page-enter');
      void page.offsetWidth;
      page.classList.add('fx-page-enter');
    }
  });
  var title = document.getElementById('fx-page-title');
  var hint = document.getElementById('fx-page-hint');
  var meta = fxTabMeta(fxPanelTab);
  if (title) title.textContent = meta.label;
  if (hint) hint.textContent = meta.hint;
  updateFxConsoleStatus();
  repositionFxFloatingPanels();
}
function fxPanelInputId(node) {
  var input = node && node.querySelector ? node.querySelector('input[id]') : null;
  return input ? input.id : '';
}
function fxPanelTargetForNode(node, current) {
  if (!node) return current || 'presets';
  var id = node.id || '';
  var inputId = fxPanelInputId(node);
  if (id === 'preset-grid' || id === 'user-archive-grid' || id === 'folia-home-seg' || id === 'fx-home-style-label' || id === 'fx-mr-preset-label' || id === 'fx-presets-surface-label' || id === 'presets-surface-seg' || id === 'mr-presets-surface' || id === 'folia-presets-surface' || id === 'folia-mode-grid' || id === 'folia-bg-grid' || id === 'folia-bg-slot' || id === 'folia-tune-fold' || id === 'folia-stage-status' || id === 'folia-tuning-panel') return 'presets';
  if (id === 'fx-lyric-surface' || id === 'fx-lyric-fold' || id === 'fx-lyricbgadapt-row' || id === 'folia-page-lyric-note') return 'lyrics';
  if (id === 'fx-overlay-fold' || id === 'fx-stage-fold') return 'motion';
  if (id === 'fx-advanced' || node.classList.contains('fx-actions')) return 'advanced';
  if (/^fx-sonic/.test(id) || /^sonic-/.test(id) || /sonic/i.test(id)) return 'motion';
  if (node.classList.contains('folia-home-seg') || node.classList.contains('presets-surface-seg') || node.classList.contains('folia-mode-grid') || node.classList.contains('folia-bg-grid') || node.classList.contains('folia-bg-slot') || node.classList.contains('folia-preset-card')) return 'presets';
  if (node.classList.contains('lyric-color-row') || node.classList.contains('cover-color-pop') || node.classList.contains('color-lab-pop') || node.classList.contains('cover-color-loupe') || node.classList.contains('app-theme-grid') || node.classList.contains('ai-theme-card')) return 'appearance';
  if (inputId === 'fx-bgopacity' || inputId === 'fx-glassaberration') return 'appearance';
  if (inputId === 'fx-lyricglow' || inputId === 'fx-lyricbgadapt') return 'lyrics';
  if (/^fx-(intensity|depth|coverres|cineshake)$/.test(inputId)) return 'motion';
  if (/^fx-sonic/.test(inputId)) return 'motion';
  return current || 'presets';
}
function organizeFxPanel() {
  var panel = document.getElementById('fx-panel');
  if (!panel) return;
  if (panel._fxPanelOrganized) {
    setFxPanelTab(fxPanelTab, { silent: true });
    return;
  }
  panel.classList.add('fx-console');
  var head = panel.querySelector('.fx-head');
  var shell = document.createElement('div');
  shell.className = 'fx-console-shell';
  shell.id = 'fx-console-shell';

  var tabs = document.createElement('nav');
  tabs.className = 'fx-panel-tabs';
  tabs.id = 'fx-panel-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '控制台分页');
  FX_TAB_META.forEach(function(meta){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-fx-tab', meta.id);
    btn.innerHTML = '<span class="fx-tab-icon" aria-hidden="true">' + meta.icon + '</span><span class="fx-tab-label">' + meta.label + '</span>';
    btn.title = meta.hint;
    tabs.appendChild(btn);
  });

  var main = document.createElement('div');
  main.className = 'fx-console-main';
  var pageHead = document.createElement('div');
  pageHead.className = 'fx-page-head';
  pageHead.innerHTML = '<div><div class="fx-page-title" id="fx-page-title">预设</div><div class="fx-page-hint" id="fx-page-hint">Home 样式、视觉预设与存档</div></div>';
  var pagesWrap = document.createElement('div');
  pagesWrap.className = 'fx-console-pages';
  pagesWrap.id = 'fx-console-pages';
  main.appendChild(pageHead);
  main.appendChild(pagesWrap);

  shell.appendChild(tabs);
  shell.appendChild(main);
  if (head && head.nextSibling) panel.insertBefore(shell, head.nextSibling);
  else panel.appendChild(shell);

  var pages = {};
  FX_TAB_META.forEach(function(meta){
    var page = document.createElement('div');
    page.className = 'fx-tab-page';
    page.setAttribute('data-fx-page', meta.id);
    page.setAttribute('role', 'tabpanel');
    pagesWrap.appendChild(page);
    pages[meta.id] = page;
  });

  var actions = panel.querySelector('.fx-actions');
  var original = Array.prototype.slice.call(panel.children).filter(function(child){
    return child !== head && child !== shell && child !== actions && !child.classList.contains('fx-tab-page') && child.id !== 'fx-console-shell';
  });
  var current = 'presets';
  original.forEach(function(node, idx){
    var target;
    if (node.classList.contains('fx-section-label')) {
      target = fxPanelTargetForNode(original[idx + 1], current);
      current = target;
    } else {
      target = fxPanelTargetForNode(node, current);
      current = target;
    }
    (pages[target] || pages.presets).appendChild(node);
  });
  if (actions) panel.appendChild(actions);

  // Sweep orphans left outside the shell (avoids empty flex void + content stuck at bottom)
  Array.prototype.slice.call(panel.children).forEach(function(child){
    if (child === head || child === shell || child === actions) return;
    if (child.id === 'fx-console-shell') return;
    (pages.presets || pagesWrap).appendChild(child);
  });

  ['fx-lyric-fold','fx-overlay-fold','fx-stage-fold','fx-advanced','folia-tune-fold'].forEach(function(id){
    var fold = document.getElementById(id);
    if (fold) fold.classList.remove('open');
  });
  tabs.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('[data-fx-tab]') : null;
    if (!btn) return;
    setFxPanelTab(btn.getAttribute('data-fx-tab'));
  });
  panel._fxPanelOrganized = true;
  setPresetsSurface(presetsSurface, { silent: true });
  setFxPanelTab(fxPanelTab, { silent: true });
}

function fxControlBlock(id) {
  var el = document.getElementById(id);
  if (!el) return null;
  return el.closest('.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid,.fx-font-grid') || el;
}
function setFxSectionBefore(id, text) {
  var block = fxControlBlock(id);
  if (!block || !block.parentNode) return;
  var prev = block.previousElementSibling;
  if (!prev || !prev.classList || !prev.classList.contains('fx-section-label')) {
    prev = document.createElement('div');
    prev.className = 'fx-section-label';
    block.parentNode.insertBefore(prev, block);
  }
  prev.textContent = text;
}
function setFxSliderLabel(id, text) {
  var block = fxControlBlock(id);
  var label = block && block.querySelector ? block.querySelector('label') : null;
  if (label) label.textContent = text;
}
function setFxSectionBeforeNode(node, text) {
  if (!node || !node.parentNode) return;
  var prev = node.previousElementSibling;
  if (!prev || !prev.classList || !prev.classList.contains('fx-section-label')) {
    prev = document.createElement('div');
    prev.className = 'fx-section-label';
    node.parentNode.insertBefore(prev, node);
  }
  prev.textContent = text;
}
function moveToggleToGrid(toggleId, grid) {
  var node = document.getElementById(toggleId);
  if (!node || !grid || node.parentNode === grid) return;
  grid.appendChild(node);
}
function ensureLyricPrimaryControls() {
  var body = document.getElementById('fx-lyric-essentials') || document.querySelector('#fx-lyric-fold .fx-fold-body');
  if (!body) return;
  var grid = document.getElementById('fx-lyric-primary-controls');
  if (!grid) {
    var label = document.createElement('div');
    label.className = 'fx-section-label';
    label.id = 'fx-lyric-primary-label';
    label.textContent = '歌词开关';
    grid = document.createElement('div');
    grid.className = 'fx-toggle-grid lyric-primary-toggle-grid';
    grid.id = 'fx-lyric-primary-controls';
    body.insertBefore(grid, body.firstChild);
    body.insertBefore(label, grid);
  }
  [
    't-lyricCameraLock',
    't-lyricGlow',
    't-lyricGlowBeat',
    't-lyricGlowParticles'
  ].forEach(function(id){ moveToggleToGrid(id, grid); });
}
function applyBackgroundMediaHint() {
  var value = document.getElementById('bg-image-value');
  if (value && !value.dataset.mediaHint) {
    value.dataset.mediaHint = '1';
    value.title = '支持图片 JPG / PNG / WebP 与视频 MP4 / WebM / MOV 上传';
  }
  var label = value && value.closest ? value.closest('.fx-color-row-label') : null;
  if (label && !document.getElementById('bg-media-hint')) {
    var hint = document.createElement('small');
    hint.id = 'bg-media-hint';
    hint.textContent = '支持图片 / 视频上传';
    label.appendChild(hint);
  }
}
function relabelFxPanelControls() {
  var title = document.querySelector('#fx-panel .fx-title');
  if (title) title.textContent = '视觉控制台';
  ensureLyricPrimaryControls();
  applyBackgroundMediaHint();
  updateFxConsoleStatus();
  var overlayGrid = document.getElementById('t-cinema');
  overlayGrid = overlayGrid && overlayGrid.closest('.fx-toggle-grid');
  setFxSectionBeforeNode(overlayGrid, '镜头与叠加');
  setFxSectionBefore('folia-home-seg', 'Home 样式');
  setFxSectionBefore('preset-grid', '视觉预设');
  setFxSectionBefore('user-archive-grid', '用户存档');
  setFxSectionBefore('app-theme-grid', '界面主题');
  setFxSectionBefore('ui-accent-picker', '界面与背景');
  setFxSectionBefore('fx-intensity', '画面基础');
  setFxSectionBefore('fx-lyricglow', '歌词溢光强度');
  setFxSectionBefore('lyric-color-grid', '文字颜色');
  setFxSectionBefore('lyric-highlight-picker', '跟唱高亮');
  setFxSectionBefore('lyric-glow-row', '歌词溢光颜色');
  setFxSectionBefore('lyric-source-seg', '歌词来源');
  setFxSectionBefore('lyric-font-grid', '字体与字距');
  setFxSectionBefore('fx-lyricscale', '位置与角度');
  setFxSectionBefore('shelf-seg', '3D 歌单架');
  setFxSectionBefore('shelf-camera-seg', '歌单架镜头');
  setFxSectionBefore('shelf-presence-seg', '歌单架显示');
  setFxSectionBefore('shelf-accent-picker', '歌单架外观');
  setFxSectionBefore('fx-shelfsize', '歌单架参数');
  setFxSectionBefore('cam-seg', '摄像头交互');
  setFxSectionBefore('fx-point', '粒子高级参数');
  setFxSliderLabel('fx-intensity', '律动强度');
  setFxSliderLabel('fx-depth', '画面景深');
  setFxSliderLabel('fx-coverres', '封面清晰度');
  setFxSliderLabel('fx-cineshake', '电影镜头');
  setFxSliderLabel('fx-lyricglow', '溢光强度');
  setFxSliderLabel('fx-bgopacity', '背景透明度');
  setFxSliderLabel('fx-glassaberration', '玻璃色差');
  setFxSliderLabel('fx-lyricspacing', '字间距');
  setFxSliderLabel('fx-lyriclineheight', '行距');
  setFxSliderLabel('fx-lyricweight', '字重');
  setFxSliderLabel('fx-lyricscale', '歌词大小');
  setFxSliderLabel('fx-lyricx', '左右位置');
  setFxSliderLabel('fx-lyricy', '上下位置');
  setFxSliderLabel('fx-lyricz', '前后景深');
  setFxSliderLabel('fx-lyrictiltx', '上下旋转');
  setFxSliderLabel('fx-lyrictilty', '左右旋转');
  setFxSliderLabel('fx-shelfsize', '歌单架大小');
  setFxSliderLabel('fx-shelfx', '左右位置');
  setFxSliderLabel('fx-shelfy', '上下位置');
  setFxSliderLabel('fx-shelfz', '前后景深');
  setFxSliderLabel('fx-shelfangle', '侧向角度');
  setFxSliderLabel('fx-shelfopacity', '整体透明度');
  setFxSliderLabel('fx-shelfbgalpha', '背景透明度');
  setFxSliderLabel('fx-point', '粒子尺寸');
  setFxSliderLabel('fx-speed', '运动速度');
  setFxSliderLabel('fx-twist', '粒子扭曲');
  setFxSliderLabel('fx-color', '色彩张力');
  setFxSliderLabel('fx-bloom', '光晕强度');
  setFxSliderLabel('fx-scatter', '离散感');
  setFxSliderLabel('fx-bgfade', '背景压暗');
}

function saveHotkeySettings() {
  try { localStorage.setItem(HOTKEY_SETTINGS_STORE_KEY, JSON.stringify(hotkeySettings || getHotkeyDefaults())); } catch (e) {}
}
function hotkeyActionMeta(actionKey) {
  for (var i = 0; i < HOTKEY_ACTIONS.length; i++) {
    if (HOTKEY_ACTIONS[i].key === actionKey) return HOTKEY_ACTIONS[i];
  }
  return null;
}
function isModifierKeyCode(code) {
  return /^(ControlLeft|ControlRight|ShiftLeft|ShiftRight|AltLeft|AltRight|MetaLeft|MetaRight)$/i.test(String(code || ''));
}
function normalizeHotkeyEvent(e) {
  if (!e || isModifierKeyCode(e.code)) return '';
  var mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  var code = e.code || '';
  if (!code && e.key) code = String(e.key).length === 1 ? 'Key' + String(e.key).toUpperCase() : String(e.key);
  if (!code) return '';
  return mods.concat([code]).join('+');
}
function hotkeyDisplayPart(part) {
  if (part === 'Ctrl') return 'Ctrl';
  if (part === 'Alt') return 'Alt';
  if (part === 'Shift') return 'Shift';
  if (part === 'Meta') return 'Win';
  if (part === 'Space') return 'Space';
  if (part === 'ArrowLeft') return 'Left';
  if (part === 'ArrowRight') return 'Right';
  if (part === 'ArrowUp') return 'Up';
  if (part === 'ArrowDown') return 'Down';
  if (/^Key[A-Z]$/.test(part)) return part.slice(3);
  if (/^Digit[0-9]$/.test(part)) return part.slice(5);
  if (/^Numpad[0-9]$/.test(part)) return 'Num' + part.slice(6);
  return part.replace(/^Equal$/, '=').replace(/^Minus$/, '-');
}
function formatHotkey(hotkey) {
  hotkey = String(hotkey || '').trim();
  if (!hotkey) return '未设置';
  return hotkey.split('+').map(hotkeyDisplayPart).join(' + ');
}
function hotkeyToAccelerator(hotkey) {
  var parts = String(hotkey || '').split('+').filter(Boolean);
  if (!parts.length) return '';
  return parts.map(function(part){
    if (part === 'Ctrl') return 'Control';
    if (part === 'Alt') return 'Alt';
    if (part === 'Shift') return 'Shift';
    if (part === 'Meta') return 'Super';
    if (part === 'Space') return 'Space';
    if (part === 'ArrowLeft') return 'Left';
    if (part === 'ArrowRight') return 'Right';
    if (part === 'ArrowUp') return 'Up';
    if (part === 'ArrowDown') return 'Down';
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit[0-9]$/.test(part)) return part.slice(5);
    return part;
  }).join('+');
}
function hotkeyDuplicateMap(scope) {
  var map = {};
  var source = (hotkeySettings && hotkeySettings[scope]) || {};
  Object.keys(source).forEach(function(action){
    var key = String(source[action] || '').trim();
    if (!key) return;
    map[key] = (map[key] || 0) + 1;
  });
  return map;
}
function executeHotkeyAction(actionKey, source) {
  if (actionKey === 'togglePlay') return togglePlay();
  if (actionKey === 'prevTrack') return prevTrack();
  if (actionKey === 'nextTrack') return nextTrack();
  if (actionKey === 'volumeUp') return adjustVolumeByKeyboard(0.05);
  if (actionKey === 'volumeDown') return adjustVolumeByKeyboard(-0.05);
  if (actionKey === 'toggleFullscreen') return toggleFullscreen();
  if (actionKey === 'toggleDesktopLyrics') return toggleFx('desktopLyrics');
}
function handleConfiguredLocalHotkey(e) {
  if (!hotkeySettings || !hotkeySettings.local || isTypingTarget(e.target)) return false;
  if (hotkeyCaptureState || document.getElementById('hotkey-modal') && document.getElementById('hotkey-modal').classList.contains('show')) return false;
  if (freeCamera && freeCamera.active && /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) return false;
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return false;
  var duplicate = hotkeyDuplicateMap('local');
  for (var i = 0; i < HOTKEY_ACTIONS.length; i++) {
    var action = HOTKEY_ACTIONS[i];
    if (hotkeySettings.local[action.key] !== combo) continue;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !/^volume/.test(action.key)) return true;
    if (duplicate[combo] > 1) return true;
    executeHotkeyAction(action.key, 'local');
    return true;
  }
  return false;
}
function shouldSuppressDefaultConfiguredHotkey(e) {
  if (!hotkeySettings || !hotkeySettings.local) return false;
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return false;
  for (var i = 0; i < HOTKEY_ACTIONS.length; i++) {
    var action = HOTKEY_ACTIONS[i];
    if (action.local === combo && hotkeySettings.local[action.key] !== combo) return true;
  }
  return false;
}
function ensureHotkeySettingsButton() {
  var panel = document.getElementById('fx-panel');
  var head = panel && panel.querySelector('.fx-head');
  if (!head || document.getElementById('hotkey-settings-btn')) return;
  var actions = head.querySelector('.fx-head-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'fx-head-actions';
    head.appendChild(actions);
  }
  var btn = document.createElement('button');
  btn.id = 'hotkey-settings-btn';
  btn.type = 'button';
  btn.className = 'fx-mini-btn ghost fx-hotkey-btn';
  btn.textContent = '热键';
  btn.title = '热键设置';
  btn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openHotkeySettings(); });
  var pin = document.getElementById('fx-panel-pin-btn');
  if (pin && pin.parentNode === actions) actions.insertBefore(btn, pin);
  else actions.insertBefore(btn, actions.firstChild);
}
function ensureHotkeyModal() {
  var modal = document.getElementById('hotkey-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'hotkey-modal';
  modal.className = 'hotkey-modal';
  modal.innerHTML =
    '<div class="hotkey-dialog" role="dialog" aria-modal="true" aria-label="热键设置">' +
      '<div class="hotkey-head">' +
        '<div><div class="hotkey-title">热键设置</div><div class="hotkey-sub">局内热键只在 Mineradio 窗口内生效；全局热键会向系统注册，并检测是否被占用。</div></div>' +
        '<button class="hotkey-close" type="button" data-hotkey-close aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="hotkey-toolbar">' +
        '<div class="hotkey-tabs"><button type="button" data-hotkey-scope="local" class="active">局内热键</button><button type="button" data-hotkey-scope="global">全局热键</button></div>' +
        '<div class="hotkey-note">按 Backspace / Delete 可清空当前功能热键</div>' +
      '</div>' +
      '<div id="hotkey-local-section" class="hotkey-section active"></div>' +
      '<div id="hotkey-global-section" class="hotkey-section"></div>' +
      '<div class="hotkey-capture-tip" id="hotkey-capture-tip">正在录入组合键，按 Esc 取消。</div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.addEventListener('click', function(e){
    if (e.target === modal || e.target.closest('[data-hotkey-close]')) closeHotkeySettings();
    var scopeBtn = e.target.closest('[data-hotkey-scope]');
    if (scopeBtn) setHotkeyModalScope(scopeBtn.getAttribute('data-hotkey-scope'));
    var bindBtn = e.target.closest('[data-hotkey-bind]');
    if (bindBtn) startHotkeyCapture(bindBtn.getAttribute('data-hotkey-action'), bindBtn.getAttribute('data-hotkey-bind'));
    var resetBtn = e.target.closest('[data-hotkey-reset]');
    if (resetBtn) resetHotkeyBinding(resetBtn.getAttribute('data-hotkey-action'), resetBtn.getAttribute('data-hotkey-reset'));
  });
  return modal;
}
function hotkeyStatusMarkup(scope, actionKey, binding, duplicate) {
  if (!binding) return '<span class="hotkey-status">未设置</span>';
  if (duplicate && duplicate[binding] > 1) return '<span class="hotkey-status conflict"><span class="source-icon">!</span>Mineradio 内部重复</span>';
  if (scope === 'local') return '<span class="hotkey-status ok">可用</span>';
  var status = hotkeyGlobalStatus[actionKey];
  if (!status) return '<span class="hotkey-status">待检测</span>';
  if (status.ok) return '<span class="hotkey-status ok">可用</span>';
  var source = status.conflict && status.conflict.sourceName || '系统 / 其他软件';
  return '<span class="hotkey-status conflict"><span class="source-icon">!</span>' + escHtml(source) + '</span>';
}
function renderHotkeyScope(scope) {
  var wrap = document.getElementById(scope === 'global' ? 'hotkey-global-section' : 'hotkey-local-section');
  if (!wrap) return;
  var duplicate = hotkeyDuplicateMap(scope);
  var html = '';
  var groups = {};
  HOTKEY_ACTIONS.forEach(function(action){
    (groups[action.category] = groups[action.category] || []).push(action);
  });
  Object.keys(groups).forEach(function(category){
    html += '<div class="hotkey-group"><div class="hotkey-group-title">' + escHtml(category) + '</div>';
    groups[category].forEach(function(action){
      var binding = (hotkeySettings[scope] && hotkeySettings[scope][action.key]) || '';
      html += '<div class="hotkey-row">' +
        '<div class="hotkey-name">' + escHtml(action.label) + '</div>' +
        '<button class="hotkey-key' + (hotkeyCaptureState && hotkeyCaptureState.scope === scope && hotkeyCaptureState.action === action.key ? ' capturing' : '') + '" type="button" data-hotkey-bind="' + scope + '" data-hotkey-action="' + action.key + '">' + escHtml(hotkeyCaptureState && hotkeyCaptureState.scope === scope && hotkeyCaptureState.action === action.key ? '按下组合键...' : formatHotkey(binding)) + '</button>' +
        '<button class="hotkey-reset" type="button" data-hotkey-reset="' + scope + '" data-hotkey-action="' + action.key + '">默认</button>' +
        hotkeyStatusMarkup(scope, action.key, binding, duplicate) +
      '</div>';
    });
    html += '</div>';
  });
  if (scope === 'local' && HOTKEY_FIXED_SHORTCUTS.length) {
    var fixedGroups = {};
    HOTKEY_FIXED_SHORTCUTS.forEach(function(item){
      (fixedGroups[item.category] = fixedGroups[item.category] || []).push(item);
    });
    Object.keys(fixedGroups).forEach(function(category){
      html += '<div class="hotkey-group hotkey-group-fixed"><div class="hotkey-group-title">' + escHtml(category) + ' · 固定</div>';
      fixedGroups[category].forEach(function(item){
        html += '<div class="hotkey-row hotkey-row-fixed">' +
          '<div class="hotkey-name">' + escHtml(item.label) + '</div>' +
          '<div class="hotkey-key hotkey-key-fixed">' + escHtml(item.keys) + '</div>' +
          '<span class="hotkey-fixed-spacer"></span>' +
          '<span class="hotkey-status ok">内置</span>' +
        '</div>';
      });
      html += '</div>';
    });
  }
  wrap.innerHTML = html;
}
function renderHotkeySettings() {
  var modal = ensureHotkeyModal();
  var active = modal.getAttribute('data-scope') || 'local';
  modal.classList.toggle('capturing', !!hotkeyCaptureState);
  modal.querySelectorAll('[data-hotkey-scope]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-hotkey-scope') === active);
  });
  var local = document.getElementById('hotkey-local-section');
  var global = document.getElementById('hotkey-global-section');
  if (local) local.classList.toggle('active', active === 'local');
  if (global) global.classList.toggle('active', active === 'global');
  renderHotkeyScope('local');
  renderHotkeyScope('global');
}
function setHotkeyModalScope(scope) {
  var modal = ensureHotkeyModal();
  modal.setAttribute('data-scope', scope === 'global' ? 'global' : 'local');
  renderHotkeySettings();
}
function openHotkeySettings() {
  var modal = ensureHotkeyModal();
  modal.classList.add('show');
  modal.setAttribute('data-scope', modal.getAttribute('data-scope') || 'local');
  renderHotkeySettings();
  registerGlobalHotkeys();
}
function closeHotkeySettings() {
  hotkeyCaptureState = null;
  var modal = document.getElementById('hotkey-modal');
  if (modal) modal.classList.remove('show', 'capturing');
}
function startHotkeyCapture(action, scope) {
  hotkeyCaptureState = { action: action, scope: scope === 'global' ? 'global' : 'local' };
  var modal = ensureHotkeyModal();
  modal.setAttribute('data-scope', hotkeyCaptureState.scope);
  renderHotkeySettings();
}
function setHotkeyBinding(action, scope, value) {
  if (!hotkeySettings) hotkeySettings = getHotkeyDefaults();
  if (!hotkeySettings[scope]) hotkeySettings[scope] = {};
  hotkeySettings[scope][action] = value || '';
  saveHotkeySettings();
  renderHotkeySettings();
  if (scope === 'global') registerGlobalHotkeys();
}
function resetHotkeyBinding(action, scope) {
  var meta = hotkeyActionMeta(action);
  if (!meta) return;
  setHotkeyBinding(action, scope, scope === 'global' ? meta.global : meta.local);
}
function registerGlobalHotkeys() {
  var api = getDesktopWindowApi && getDesktopWindowApi();
  if (!api || typeof api.configureGlobalHotkeys !== 'function') {
    hotkeyGlobalStatus = {};
    renderHotkeySettings();
    return Promise.resolve();
  }
  var duplicate = hotkeyDuplicateMap('global');
  var bindings = [];
  HOTKEY_ACTIONS.forEach(function(action){
    var key = hotkeySettings.global && hotkeySettings.global[action.key];
    if (!key || duplicate[key] > 1) return;
    var accelerator = hotkeyToAccelerator(key);
    if (accelerator) bindings.push({ action: action.key, accelerator: accelerator });
  });
  return api.configureGlobalHotkeys(bindings).then(function(res){
    var next = {};
    (res && res.results || []).forEach(function(item){
      next[item.action] = item;
    });
    hotkeyGlobalStatus = next;
    renderHotkeySettings();
  }).catch(function(){
    hotkeyGlobalStatus = {};
    renderHotkeySettings();
  });
}
var globalHotkeyListenerBound = false;
function bindHotkeySettings() {
  ensureHotkeySettingsButton();
  ensureHotkeyModal();
  if (!globalHotkeyListenerBound) {
    var api = getDesktopWindowApi && getDesktopWindowApi();
    if (api && typeof api.onGlobalHotkey === 'function') {
      globalHotkeyListenerBound = true;
      api.onGlobalHotkey(function(payload){
        if (!payload || !payload.action) return;
        executeHotkeyAction(payload.action, 'global');
      });
    }
  }
  registerGlobalHotkeys();
}
document.addEventListener('keydown', function(e){
  var hotkeyModal = document.getElementById('hotkey-modal');
  if (!hotkeyCaptureState) {
    if (hotkeyModal && hotkeyModal.classList.contains('show') && e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeHotkeySettings();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    hotkeyCaptureState = null;
    renderHotkeySettings();
    return;
  }
  if (e.code === 'Backspace' || e.code === 'Delete') {
    var clearTarget = hotkeyCaptureState;
    hotkeyCaptureState = null;
    setHotkeyBinding(clearTarget.action, clearTarget.scope, '');
    return;
  }
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return;
  var target = hotkeyCaptureState;
  hotkeyCaptureState = null;
  setHotkeyBinding(target.action, target.scope, combo);
}, true);
function bindFxPanel() {
  liftFxFloatingPopups();
  organizeFxPanel();
  relabelFxPanelControls();
  initAppThemeFromState();
  bindAppThemeGrid();
  bindHotkeySettings();
  buildPresetGrid();
  renderUserFxArchives();
  buildLyricColorControls();
  var ids = [
    ['fx-intensity','intensity'],['fx-depth','depth'],['fx-coverres','coverResolution'],['fx-cineshake','cinemaShake'],['fx-lyricglow','lyricGlowStrength'],['fx-bgopacity','backgroundOpacity'],['fx-glassaberration','controlGlassChromaticOffset'],
    ['fx-shelfsize','shelfSize'],['fx-shelfx','shelfOffsetX'],['fx-shelfy','shelfOffsetY'],['fx-shelfz','shelfOffsetZ'],['fx-shelfangle','shelfAngleY'],['fx-shelfopacity','shelfOpacity'],['fx-shelfbgalpha','shelfBgOpacity'],
    ['fx-lyricspacing','lyricLetterSpacing'],['fx-lyriclineheight','lyricLineHeight'],['fx-lyricweight','lyricWeight'],
    ['fx-lyricscale','lyricScale'],['fx-lyricx','lyricOffsetX'],['fx-lyricy','lyricOffsetY'],['fx-lyricz','lyricOffsetZ'],['fx-lyrictiltx','lyricTiltX'],['fx-lyrictilty','lyricTiltY'],
    ['fx-point','point'],['fx-speed','speed'],['fx-twist','twist'],
    ['fx-color','color'],['fx-bloom','bloomStrength'],['fx-scatter','scatter'],['fx-bgfade','bgFade'],
  ];
  ids.forEach(function(pair){
    var el = document.getElementById(pair[0]);
    if (!el) return;
    ensureFxSliderResetButton(pair[0], pair[1]);
    el.addEventListener('input', function(){
      fx[pair[1]] = parseFloat(el.value);
      var out = el.parentElement.querySelector('output');
      if (pair[1] === 'coverResolution') {
        fx.coverResolution = normalizeCoverResolution(fx.coverResolution);
        applyCoverParticleResolution(fx.coverResolution, { reload: true });
      }
      if (pair[1] === 'lyricWeight') fx.lyricWeight = Math.round(clampRange(fx.lyricWeight, 500, 900) / 50) * 50;
      if (pair[1] === 'backgroundOpacity') {
        fx.backgroundOpacity = clampRange(fx.backgroundOpacity, 0, 1);
        fx.backgroundColorMode = 'custom';
        fx.backgroundColorCustom = true;
        updateCustomBackgroundControls();
      }
      if (pair[1] === 'controlGlassChromaticOffset') {
        fx.controlGlassChromaticOffset = normalizeControlGlassChromaticOffset(fx.controlGlassChromaticOffset);
        applyControlGlassChromaticOffset();
      }
      if (pair[1] === 'desktopLyricsSize') fx.desktopLyricsSize = clampRange(fx.desktopLyricsSize, 0.72, 1.55);
      if (pair[1] === 'desktopLyricsOpacity') fx.desktopLyricsOpacity = clampRange(fx.desktopLyricsOpacity, 0.28, 1);
      if (pair[1] === 'desktopLyricsY') fx.desktopLyricsY = clampRange(fx.desktopLyricsY, 0.08, 0.92);
      if (pair[1] === 'wallpaperOpacity') fx.wallpaperOpacity = clampRange(fx.wallpaperOpacity, 0.35, 1);
      if (pair[1] === 'shelfSize') fx.shelfSize = clampRange(fx.shelfSize, 0.65, 1.45);
      if (pair[1] === 'shelfOffsetX') fx.shelfOffsetX = clampRange(fx.shelfOffsetX, -1.2, 1.2);
      if (pair[1] === 'shelfOffsetY') fx.shelfOffsetY = clampRange(fx.shelfOffsetY, -0.9, 0.9);
      if (pair[1] === 'shelfOffsetZ') fx.shelfOffsetZ = clampRange(fx.shelfOffsetZ, -0.9, 0.9);
      if (pair[1] === 'shelfAngleY') {
        fx.shelfAngleYManual = true;
        fx.shelfAngleY = Math.round(clampRange(fx.shelfAngleY, -30, 30));
      }
      if (pair[1] === 'shelfOpacity') fx.shelfOpacity = clampRange(fx.shelfOpacity, 0.25, 1);
      if (pair[1] === 'shelfBgOpacity') fx.shelfBgOpacity = clampRange(fx.shelfBgOpacity, 0.25, 0.98);
      if (pair[1] === 'lyricTiltX' || pair[1] === 'lyricTiltY') fx[pair[1]] = Math.round(clampRange(fx[pair[1]], -42, 42));
      if (out) out.textContent = pair[1] === 'coverResolution'
        ? coverParticleCountLabel(fx.coverResolution)
        : (pair[1] === 'lyricWeight' || pair[1] === 'controlGlassChromaticOffset' || pair[1] === 'lyricTiltX' || pair[1] === 'lyricTiltY' || pair[1] === 'shelfAngleY' ? String(Math.round(fx[pair[1]])) : Number(el.value).toFixed(pair[1] === 'lyricLetterSpacing' ? 3 : 2));
      syncFxUniforms();
      if (/^shelf(Size|OffsetX|OffsetY|OffsetZ|AngleY|Opacity|BgOpacity)$/.test(pair[1]) && shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
      if (pair[1] === 'lyricLetterSpacing' || pair[1] === 'lyricLineHeight' || pair[1] === 'lyricWeight') refreshCurrentLyricStyle();
      if (pair[1] === 'lyricLetterSpacing' || pair[1] === 'lyricLineHeight' || pair[1] === 'lyricWeight' || pair[1] === 'lyricScale' || pair[1] === 'lyricGlowStrength') pushDesktopLyricsState(true);
      if (/^(desktopLyricsSize|desktopLyricsOpacity|desktopLyricsY)$/.test(pair[1])) pushDesktopLyricsState(true);
      if (pair[1] === 'wallpaperOpacity') pushWallpaperState(true);
      saveLyricLayout();
    });
  });
  var lyricPicker = document.getElementById('lyric-color-picker');
  if (lyricPicker) {
    lyricPicker.addEventListener('input', function(){ setLyricColorCustom(lyricPicker.value, true); });
    lyricPicker.addEventListener('change', function(){ showToast('歌词颜色: ' + normalizeHexColor(lyricPicker.value).toUpperCase()); });
  }
  var lyricHighlightPicker = document.getElementById('lyric-highlight-picker');
  if (lyricHighlightPicker) {
    lyricHighlightPicker.addEventListener('input', function(){ setLyricHighlightCustom(lyricHighlightPicker.value, true); });
    lyricHighlightPicker.addEventListener('change', function(){ showToast('高亮颜色: ' + normalizeHexColor(lyricHighlightPicker.value).toUpperCase()); });
  }
  var lyricGlowPicker = document.getElementById('lyric-glow-picker');
  if (lyricGlowPicker) {
    lyricGlowPicker.addEventListener('input', function(){ setLyricGlowCustom(lyricGlowPicker.value, true); });
    lyricGlowPicker.addEventListener('change', function(){ showToast('溢光颜色: ' + normalizeHexColor(lyricGlowPicker.value).toUpperCase()); });
  }
  var uiAccentPicker = document.getElementById('ui-accent-picker');
  if (uiAccentPicker) {
    uiAccentPicker.addEventListener('input', function(){ setUiAccentColor(uiAccentPicker.value, true); });
    uiAccentPicker.addEventListener('change', function(){ showToast('界面高亮: ' + normalizeHexColor(uiAccentPicker.value, '#00f5d4').toUpperCase()); });
  }
  var visualTintPicker = document.getElementById('visual-tint-picker');
  if (visualTintPicker) {
    visualTintPicker.addEventListener('input', function(){ setVisualTintCustom(visualTintPicker.value, true); });
    visualTintPicker.addEventListener('change', function(){ showToast('视觉主色: ' + normalizeHexColor(visualTintPicker.value).toUpperCase()); });
  }
  var homeAccentPicker = document.getElementById('home-accent-picker');
  if (homeAccentPicker) {
    homeAccentPicker.addEventListener('input', function(){ setHomeAccentColor(homeAccentPicker.value, true); });
    homeAccentPicker.addEventListener('change', function(){ showToast('Home 填充: ' + normalizeHexColor(homeAccentPicker.value).toUpperCase()); });
  }
  var homeIconPicker = document.getElementById('home-icon-picker');
  if (homeIconPicker) {
    homeIconPicker.addEventListener('input', function(){ setHomeIconColor(homeIconPicker.value, true); });
    homeIconPicker.addEventListener('change', function(){ showToast('主页图标: ' + normalizeHexColor(homeIconPicker.value, '#f4d28a').toUpperCase()); });
  }
  var visualIconPicker = document.getElementById('visual-icon-picker');
  if (visualIconPicker) {
    visualIconPicker.addEventListener('input', function(){ setVisualIconColor(visualIconPicker.value, true); });
    visualIconPicker.addEventListener('change', function(){ showToast('视觉图标: ' + normalizeHexColor(visualIconPicker.value, '#7fd8ff').toUpperCase()); });
  }
  var bgColorPicker = document.getElementById('bg-color-picker');
  if (bgColorPicker) {
    bgColorPicker.addEventListener('input', function(){ setCustomBackgroundColor(bgColorPicker.value, true); });
    bgColorPicker.addEventListener('change', function(){ showToast('背景颜色: ' + normalizeHexColor(bgColorPicker.value, '#000000').toUpperCase()); });
  }
  var shelfAccentPicker = document.getElementById('shelf-accent-picker');
  if (shelfAccentPicker) {
    shelfAccentPicker.addEventListener('input', function(){ setShelfAccentColor(shelfAccentPicker.value, true); });
    shelfAccentPicker.addEventListener('change', function(){ showToast('歌单架颜色: ' + shelfAccentHex().toUpperCase()); });
  }
  var bgImageInput = document.getElementById('background-image-input');
  if (bgImageInput) {
    bgImageInput.addEventListener('change', function(e){
      var file = e.target.files && e.target.files[0];
      if (file) readBackgroundMediaFile(file);
      e.target.value = '';
    });
  }
  ['ui-accent-picker','visual-tint-picker','home-accent-picker','home-icon-picker','visual-icon-picker','bg-color-picker','shelf-accent-picker','lyric-color-picker','lyric-highlight-picker','lyric-glow-picker'].forEach(function(id){
    bindColorLabPicker(document.getElementById(id));
  });
  bindColorLabRows();
  var sv = document.getElementById('color-lab-sv');
  if (sv && !sv._bound) {
    sv._bound = true;
    sv.addEventListener('pointerdown', function(e){
      e.preventDefault();
      colorLabState.dragging = true;
      sv.setPointerCapture && sv.setPointerCapture(e.pointerId);
      updateColorLabFromSv(e);
    });
    sv.addEventListener('pointermove', function(e){ if (colorLabState.dragging) updateColorLabFromSv(e); });
    sv.addEventListener('pointerup', function(){ colorLabState.dragging = false; });
    sv.addEventListener('pointercancel', function(){ colorLabState.dragging = false; });
  }
  var hue = document.getElementById('color-lab-hue');
  if (hue && !hue._bound) {
    hue._bound = true;
    hue.addEventListener('input', function(){
      colorLabState.h = clampRange(Number(hue.value) || 0, 0, 360) / 360;
      var hex = hsvToHex(colorLabState.h, colorLabState.s, colorLabState.v);
      syncColorLabUi(hex);
      applyColorLabValue(hex, true);
    });
  }
  var hexInput = document.getElementById('color-lab-hex');
  if (hexInput && !hexInput._bound) {
    hexInput._bound = true;
    hexInput.addEventListener('change', function(){
      var hex = normalizeHexColor(hexInput.value || '#000000', '#000000');
      syncColorLabUi(hex);
      applyColorLabValue(hex);
    });
  }
  var presets = document.getElementById('color-lab-presets');
  if (presets && !presets._bound) {
    presets._bound = true;
    presets.addEventListener('click', function(e){
      var btn = e.target && e.target.closest ? e.target.closest('[data-color]') : null;
      if (!btn) return;
      var hex = normalizeHexColor(btn.getAttribute('data-color') || '#000000', '#000000');
      syncColorLabUi(hex);
      applyColorLabValue(hex);
    });
  }
  if (!document._colorLabOutsideBound) {
    document._colorLabOutsideBound = true;
    document.addEventListener('mousedown', function(e){
      var pop = document.getElementById('color-lab-pop');
      if (!pop || !pop.classList.contains('show')) return;
      if (e.target && (e.target.closest('#color-lab-pop') || e.target.closest('.lyric-color-picker') || e.target.closest('.lyric-color-row'))) return;
      closeColorLab();
    }, true);
    document.addEventListener('mousedown', function(e){
      var pop = document.getElementById('cover-color-pop');
      if (!pop || !pop.classList.contains('show')) return;
      if (e.target && (e.target.closest('#cover-color-pop') || e.target.closest('#visual-tint-auto-btn'))) return;
      closeCoverColorPicker();
    }, true);
  }
  // 三态
  document.querySelectorAll('#shelf-seg button').forEach(function(b){
    b.addEventListener('click', function(){ setShelfMode(b.dataset.shelf); });
  });
  document.querySelectorAll('#shelf-camera-seg [data-shelf-camera]').forEach(function(b){
    b.addEventListener('click', function(){ setShelfCameraMode(b.getAttribute('data-shelf-camera')); });
  });
  document.querySelectorAll('#shelf-presence-seg [data-shelf-presence]').forEach(function(b){
    b.addEventListener('click', function(){ setShelfPresence(b.getAttribute('data-shelf-presence')); });
  });
  document.querySelectorAll('#cam-seg button').forEach(function(b){
    b.addEventListener('click', function(){ setCamMode(b.dataset.cam); });
  });
  if (document.getElementById('desktop-lyrics-fps-seg')) {
    document.querySelectorAll('#desktop-lyrics-fps-seg [data-desktop-lyrics-fps]').forEach(function(btn){
      btn.addEventListener('click', function(){
        fx.desktopLyricsFps = normalizeDesktopLyricsFps(btn.getAttribute('data-desktop-lyrics-fps'));
        updateDesktopLyricsFpsControls();
        saveLyricLayout();
        pushDesktopLyricsState(true);
        showToast(fx.desktopLyricsFps ? ('桌面歌词帧数 ' + fx.desktopLyricsFps) : '桌面歌词帧数无上限');
      });
    });
  }
  document.querySelectorAll('#performance-background-seg [data-performance-background]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setPerformanceBackgroundMode(btn.getAttribute('data-performance-background'));
    });
  });
  document.querySelectorAll('#performance-quality-seg [data-performance-quality]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setPerformanceQualityMode(btn.getAttribute('data-performance-quality'));
    });
  });
  updateFxInputs();
}
function toggleFx(key) {
  if (isDevelopmentLockedFx(key)) {
    normalizeDevelopmentLockedFxState();
    saveLyricLayout();
    updateFxInputs();
    applyDesktopLyricsState(true);
    applyWallpaperModeState(true);
    showToast('开发中，暂不可用');
    return;
  }
  fx[key] = !fx[key];
  var toggleId = 't-' + (key === 'floatLayer' ? 'float' : key === 'aiDepth' ? 'aidepth' : key);
  var toggle = document.getElementById(toggleId);
  if (toggle) toggle.classList.toggle('on', fx[key]);
  syncFxUniforms();
  if (key === 'lyricCameraLock' || key === 'lyricGlow' || key === 'lyricGlowBeat' || key === 'lyricGlowParticles' || key === 'bloom' || key === 'edge' || key === 'cinema' || key === 'desktopLyrics' || key === 'desktopLyricsClickThrough' || key === 'desktopLyricsCinema' || key === 'desktopLyricsHighlight' || key === 'wallpaperMode' || key === 'shelfShowPodcasts' || key === 'shelfMergeCollections' || key === 'liveBackgroundKeep') saveLyricLayout();
  if (key === 'floatLayer') { if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer(); }
  if (key === 'desktopLyrics') applyDesktopLyricsState(true);
  if (key === 'desktopLyricsClickThrough' || key === 'desktopLyricsCinema' || key === 'desktopLyricsHighlight') pushDesktopLyricsState(true);
  if (key === 'lyricGlow' || key === 'lyricGlowBeat' || key === 'lyricGlowParticles') pushDesktopLyricsState(true);
  if (key === 'wallpaperMode') applyWallpaperModeState(true);
  if (key === 'shelfShowPodcasts' || key === 'shelfMergeCollections') {
    if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
    if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  }
  if (key === 'liveBackgroundKeep') {
    fx.performanceBackground = fx.liveBackgroundKeep ? 'keep' : 'auto';
    updatePerformanceControls();
    saveLyricLayout();
    if (fx.liveBackgroundKeep && backgroundCacheTrimTimer) {
      clearTimeout(backgroundCacheTrimTimer);
      backgroundCacheTrimTimer = 0;
    }
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (fx.liveBackgroundKeep) recoverVisualsAfterBackground('live-background-keep');
  }
  if (key === 'lyricGlow') showToast(fx.lyricGlow ? '歌词溢光已开启' : '歌词溢光已关闭');
  if (key === 'lyricGlowBeat') showToast(fx.lyricGlowBeat ? '歌词溢光跟随鼓点' : '歌词溢光已脱离鼓点');
  if (key === 'lyricGlowParticles') showToast(fx.lyricGlowParticles ? '歌词光粒已开启' : '歌词光粒已关闭');
  if (key === 'desktopLyrics') showToast(fx.desktopLyrics ? '桌面歌词已开启' : '桌面歌词已关闭');
  if (key === 'desktopLyricsClickThrough') showToast(fx.desktopLyricsClickThrough !== false ? '桌面歌词已锁定' : '桌面歌词可移动');
  if (key === 'desktopLyricsCinema') showToast(fx.desktopLyricsCinema !== false ? '桌面歌词电影震动已开启' : '桌面歌词电影震动已关闭，基础漂浮保留');
  if (key === 'desktopLyricsHighlight') showToast(fx.desktopLyricsHighlight === true ? '桌面歌词高亮跟随已开启' : '桌面歌词高亮跟随已关闭');
  if (key === 'wallpaperMode') showToast(fx.wallpaperMode ? '壁纸模式已开启' : '壁纸模式已关闭');
  if (key === 'shelfShowPodcasts') showToast(fx.shelfShowPodcasts !== false ? '3D歌单架已显示播客歌单' : '3D歌单架已隐藏播客歌单');
  if (key === 'shelfMergeCollections') showToast(fx.shelfMergeCollections === true ? '我的歌单与收藏歌单已合并滚动' : '收藏歌单恢复滚到底切页');
  if (key === 'liveBackgroundKeep') showToast(fx.liveBackgroundKeep ? '直播后台保持已开启' : '直播后台保持已关闭');
  if (key === 'lyricCameraLock') showToast(fx.lyricCameraLock ? '歌词已绑定镜头' : '歌词已恢复自由漂浮');
  if (key === 'bloom') showToast(fx.bloom ? '溢光已开启' : '溢光已关闭');
  if (key === 'edge') showToast(fx.edge ? '已开启轮廓高亮' : '已关闭轮廓高亮');
  if (key === 'cinema') showToast(fx.cinema ? '已开启电影镜头' : '已关闭电影镜头');
  if (key === 'aiDepth') {
    if (fx.aiDepth) {
      aiDepthFailUntil = 0;
      queueAIDepthForCurrentCover(true);
    }
    showToast(fx.aiDepth ? '已开启后台 AI 立体增强' : '已关闭 AI 立体增强, 使用轻量弧面');
  }
}
function toggleFxPanel(force) {
  var el = document.getElementById('fx-panel');
  if (!el) return;
  if (!diyPlayerMode && force !== false) {
    showToast('开启 DIY 玩家模式后可打开视觉控制台');
    return;
  }
  var currentlyOpen = el.classList.contains('show') || el.classList.contains('peek') || el.classList.contains('pinned');
  if (peekTimers && peekTimers.fx) { clearTimeout(peekTimers.fx); peekTimers.fx = null; }
  if (force === false || (force == null && currentlyOpen && !fxPanelPinned)) {
    if (fxPanelPinned && force === false) {
      fxPanelPinned = false;
      saveBooleanPreference(FX_PANEL_PIN_STORE_KEY, false);
      applyFxPanelPinState();
    }
    el.classList.remove('show', 'peek');
    el.classList.toggle('closing', currentlyOpen);
    setTimeout(function(){ el.classList.remove('closing'); }, 280);
    var fab = document.getElementById('fx-fab');
    if (fab) fab.classList.remove('active');
    document.body.classList.remove('fx-console-open');
    return;
  }
  if (force == null && currentlyOpen && fxPanelPinned) {
    setFxPanelPinned(false);
    el.classList.remove('show', 'peek');
    document.body.classList.remove('fx-console-open');
    var fabOff = document.getElementById('fx-fab');
    if (fabOff) fabOff.classList.remove('active');
    return;
  }
  el.classList.remove('show', 'closing');
  document.body.classList.add('fx-console-open');
  updateFxConsoleStatus();
  setPeek(el, true, 'fx');
}
function resetFx() {
  var savedCam = fx.cam;
  var savedShelf = fx.shelf;
  var savedShelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  var savedShelfPresence = normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence);
  fx = Object.assign({}, fxDefaults, {
    cam: savedCam,
    shelf: savedShelf,
    shelfCameraMode: savedShelfCameraMode,
    shelfPresence: savedShelfPresence,
    shelfAngleY: shelfDefaultAngleForCameraMode(savedShelfCameraMode),
    shelfAngleYManual: false
  });
  applyCoverParticleResolution(fx.coverResolution, { reload: true });
  updateFxInputs();
  applyDesktopLyricsState(true);
  applyWallpaperModeState(true);
  updateRenderPowerClasses();
  applyRendererPowerMode();
  setStageLyricPalette(stageLyrics.coverPalette || stageLyrics.palette);
  setPreset(fx.preset, { silent: true, preserveCamera: true, skipTransition: true });
  if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer();
  if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  saveLyricLayout();
  showToast('已恢复默认参数');
}

function setShelfMode(m) {
  m = /^(off|side|stage)$/.test(String(m || '')) ? m : fxDefaults.shelf;
  fx.shelf = m;
  document.querySelectorAll('#shelf-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.shelf === m); });
  if (shelfManager) shelfManager.setMode(m);
  // 舞台模式: 顶部搜索、底部控件让位
  var searchArea = document.getElementById('search-area');
  var bottomBar = document.getElementById('bottom-bar');
  if (searchArea) searchArea.classList.toggle('stage-mode', m === 'stage');
  if (bottomBar) bottomBar.classList.toggle('stage-mode', m === 'stage');
  saveLyricLayout();
}

function updateShelfControlUi() {
  fx.shelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  fx.shelfPresence = normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence);
  document.querySelectorAll('#shelf-camera-seg [data-shelf-camera]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-shelf-camera') === fx.shelfCameraMode);
  });
  document.querySelectorAll('#shelf-presence-seg [data-shelf-presence]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-shelf-presence') === fx.shelfPresence);
  });
  var color = shelfAccentHex();
  var picker = document.getElementById('shelf-accent-picker');
  var value = document.getElementById('shelf-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
function refreshShelfVisuals(reason) {
  updateShelfControlUi();
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  if (shelfManager && shelfManager.rebuild && reason === 'mode') shelfManager.rebuild(true);
}
function setShelfCameraMode(mode) {
  fx.shelfCameraMode = normalizeShelfCameraMode(mode);
  applyShelfCameraDefaultAngle(true);
  setRange('fx-shelfangle', fx.shelfAngleY);
  updateShelfControlUi();
  if (fx.shelfCameraMode === 'static' && orbit && orbit.focus && /^shelf-/.test(String(orbit.focus.type || ''))) {
    setFocusZone(null, true);
  }
  saveLyricLayout();
  showToast(fx.shelfCameraMode === 'static' ? '3D歌单架: 静态镜头' : '3D歌单架: 动态镜头');
}
function setShelfPresence(mode) {
  fx.shelfPresence = normalizeShelfPresence(mode);
  updateShelfControlUi();
  if (shelfManager && shelfManager.setMode) shelfManager.setMode(fx.shelf);
  if (fx.shelfPresence === 'auto' && !shelfPinnedOpen) {
    shelfHoverCue.target = 0;
  }
  saveLyricLayout();
  showToast(fx.shelfPresence === 'always' ? '3D歌单架: 常驻' : '3D歌单架: 自动隐藏');
}
function setShelfAccentColor(color, silent) {
  fx.shelfAccentColor = normalizeHexColor(color || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor);
  refreshShelfVisuals('color');
  saveLyricLayout();
  if (!silent) showToast('歌单架颜色: ' + fx.shelfAccentColor.toUpperCase());
}
function resetShelfAccentColor() {
  setShelfAccentColor(fxDefaults.shelfAccentColor || '#f4d28a');
}

function syncControlsAutoHideButton() {
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', controlsAutoHide);
  if (!controlsAutoHide && controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
}

function setParticleLyricsSilently(on) {
  fx.particleLyrics = !!on;
  if (fx.particleLyrics) createLyricsParticles();
  else clearStageLyrics();
  lyricsVisible = fx.particleLyrics;
}

function updateImmersiveButton() {
  var btn = document.getElementById('immersive-btn');
  if (!btn) return;
  btn.classList.toggle('active', immersiveMode);
  btn.setAttribute('aria-pressed', immersiveMode ? 'true' : 'false');
  btn.title = immersiveMode ? '退出全沉浸式' : '全沉浸式';
  btn.setAttribute('aria-label', btn.title);
}

function closeImmersiveInterference() {
  closeMiniQueue();
  toggleFxPanel(false);
  closeUploadTip(false);
  closeLoginModal({ skipAccountReturn: true });
  closeUserModal();
  closeCollectModal();
  closeCoverCropModal();
  closeCustomLyricModal();
  closeTrackDetailModal();
  if (!localBeatAnalysis.active) closeLocalBeatModal();
  ['search-area', 'fx-panel', 'trial-banner', 'ai-depth-chip', 'beat-chip'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.classList.remove('peek', 'show', 'closing');
  });
  var fab = document.getElementById('fx-fab');
  if (fab) fab.classList.remove('active');
  document.body.classList.remove('login-guide-active');
  setFocusZone(null, true);
}

function setImmersiveMode(on) {
  on = !!on;
  if (immersiveMode === on) return;

  if (on) {
    immersiveState = {
      shelfMode: fx.shelf,
      shelfPinnedOpen: shelfPinnedOpen,
      lyrics: fx.particleLyrics,
      controlsAutoHide: controlsAutoHide,
      bottomVisible: !!(document.getElementById('bottom-bar') && document.getElementById('bottom-bar').classList.contains('visible'))
    };
    immersiveMode = true;
    document.body.classList.add('immersive-mode');
    var bottomBarEnter = document.getElementById('bottom-bar');
    if (bottomBarEnter) bottomBarEnter.classList.add('visible');
    closeImmersiveInterference();
    if (!fx.particleLyrics) setParticleLyricsSilently(true);
    controlsAutoHide = true;
    syncControlsAutoHideButton();
    updateImmersiveButton();
    syncCursorAutoHideMode();
    revealBottomControls(720);
    setTimeout(function(){
      if (immersiveMode && !controlsHovering) setControlsHidden(true);
    }, 980);
    return;
  }

  immersiveMode = false;
  document.body.classList.remove('immersive-mode');
  closeMiniQueue();
  if (immersiveState.shelfMode) setShelfMode(immersiveState.shelfMode);
  if (immersiveState.shelfMode === 'side' && immersiveState.shelfPinnedOpen) setShelfPinnedOpen(true, true);
  else setShelfPinnedOpen(false, true);
  if (immersiveState.lyrics === false) setParticleLyricsSilently(false);
  controlsAutoHide = immersiveState.controlsAutoHide !== false;
  syncControlsAutoHideButton();
  updateImmersiveButton();
  syncCursorAutoHideMode();
  var bottomBarExit = document.getElementById('bottom-bar');
  if (immersiveState.bottomVisible) revealBottomControls(900);
  else if (bottomBarExit) bottomBarExit.classList.remove('visible', 'soft-hidden');
  showToast('已退出全沉浸式');
}

function toggleImmersiveMode() {
  setImmersiveMode(!immersiveMode);
}

function setCamMode(m) {
  if (m === 'head') m = 'gesture'; // v8: 头部追踪已下线, 兼容旧设置
  fx.cam = m;
  document.querySelectorAll('#cam-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.cam === m); });
  if (m === 'off') stopGestureControl();
  else if (m === 'gesture') startGestureControl();
  saveLyricLayout();
}

// ============================================================
//  更新提示预览
// ============================================================
function formatUpdateBytes(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2).replace(/\.00$/, '') + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
function formatUpdateSpeed(bytesPerSecond) {
  bytesPerSecond = Number(bytesPerSecond) || 0;
  return bytesPerSecond > 0 ? (formatUpdateBytes(bytesPerSecond) + '/s') : '';
}
function updateProgressDetailText() {
  var parts = [];
  if (updatePreviewState.attempts > 1 && updatePreviewState.attempt > 0) {
    parts.push('线路 ' + updatePreviewState.attempt + '/' + updatePreviewState.attempts);
  }
  if (updatePreviewState.sourceLabel) parts.push(updatePreviewState.sourceLabel);
  if (updatePreviewState.received > 0) {
    parts.push(updatePreviewState.total > 0
      ? (formatUpdateBytes(updatePreviewState.received) + ' / ' + formatUpdateBytes(updatePreviewState.total))
      : ('已下载 ' + formatUpdateBytes(updatePreviewState.received)));
  }
  var speed = formatUpdateSpeed(updatePreviewState.speedBps);
  if (speed) parts.push(speed);
  if (updatePreviewState.etaSeconds > 0 && updatePreviewState.etaSeconds < 3600) parts.push('约 ' + updatePreviewState.etaSeconds + ' 秒');
  return parts.join(' · ');
}
function initUpdatePreview() {
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(true);
  checkLatestUpdate();
  setTimeout(startUpdateIconBreathing, 760);
}

function setUpdatePreviewVisible(visible) {
  updatePreviewState.visible = !!visible;
  var entry = document.getElementById('update-entry');
  if (!entry) return;
  entry.classList.toggle('available', updatePreviewState.visible);
  if (!updatePreviewState.visible && window.gsap) {
    window.gsap.killTweensOf(entry);
    window.gsap.set(entry, { autoAlpha: 0, y: 0, clearProps: 'boxShadow,filter,scale' });
    return;
  }
  if (updatePreviewState.visible && window.gsap) {
    window.gsap.fromTo(entry,
      { autoAlpha: 0, y: -6, scale: 0.92, filter: 'blur(6px)' },
      { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.62, delay: 0.18, ease: 'expo.out', overwrite: true }
    );
  }
}

async function checkLatestUpdate() {
  try {
    var data = await apiJson('/api/update/latest?t=' + Date.now());
    applyLatestUpdateInfo(data);
  } catch (e) {
    updatePreviewState.preview = true;
    updatePreviewState.updateAvailable = false;
    updatePreviewState.hero = '当前版本，更新检测已就绪。';
    renderUpdatePreviewPanel();
    setUpdatePreviewVisible(true);
  }
}

function applyLatestUpdateInfo(data) {
  data = data || {};
  var release = data.release || {};
  updatePreviewState.currentVersion = data.currentVersion || updatePreviewState.currentVersion;
  updatePreviewState.version = data.latestVersion || release.version || updatePreviewState.currentVersion;
  updatePreviewState.configured = !!data.configured;
  updatePreviewState.preview = !!data.preview;
  updatePreviewState.updateAvailable = !!data.updateAvailable;
  updatePreviewState.releaseUrl = release.htmlUrl || data.htmlUrl || '';
  updatePreviewState.downloadUrl = release.downloadUrl || data.downloadUrl || '';
  updatePreviewState.patchAvailable = !!(release.patchAvailable && release.patch && release.patch.downloadUrl);
  updatePreviewState.patchUrl = updatePreviewState.patchAvailable ? release.patch.downloadUrl : '';
  updatePreviewState.patchFallbackTried = false;
  updatePreviewState.hero = release.summary || (updatePreviewState.updateAvailable ? '发现新版本，建议更新。' : '当前版本，更新检测已就绪。');
  if (Array.isArray(release.notes) && release.notes.length) {
    updatePreviewState.notes = release.notes.slice(0, 4);
  }
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(updatePreviewState.updateAvailable || updatePreviewState.preview);
}

function startUpdateIconBreathing() {
  var entry = document.getElementById('update-entry');
  if (!entry || !window.gsap) return;
  var ring = entry.querySelector('.update-ring');
  window.gsap.killTweensOf(entry, 'y,boxShadow');
  window.gsap.set(entry, { autoAlpha: 1 });
  if (ring) window.gsap.killTweensOf(ring);
  window.gsap.to(entry, {
    y: -1.4,
    boxShadow: '0 16px 44px rgba(0,0,0,.32),0 0 24px rgba(244,210,138,.18),0 0 13px rgba(157,184,207,.06),inset 0 1px 0 rgba(255,255,255,.11)',
    duration: 2.6,
    repeat: -1,
    yoyo: true,
    ease: 'sine.inOut'
  });
  if (ring) {
    window.gsap.to(ring, {
      rotate: 18,
      duration: 3.8,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      transformOrigin: '50% 50%'
    });
  }
}

function renderUpdatePreviewPanel() {
  var version = document.getElementById('update-modal-version');
  var hero = document.getElementById('update-hero-main');
  var list = document.getElementById('update-list');
  if (version) version.textContent = 'v' + updatePreviewState.version;
  if (hero) hero.textContent = updatePreviewState.hero || '当前版本，更新检测已就绪。';
  if (list) {
    var notes = Array.isArray(updatePreviewState.notes) && updatePreviewState.notes.length ? updatePreviewState.notes : ['更新检测已就绪'];
    list.innerHTML = notes.map(function(text, i){
      return '<div class="update-item"><span class="update-item-dot" data-index="' + String(i + 1).padStart(2, '0') + '"></span><div class="update-item-text">' + escHtml(text) + '</div></div>';
    }).join('');
  }
  updateUpdatePreviewProgress(updatePreviewState.progress);
  syncUpdatePreviewStateClass();
}

function syncUpdatePreviewStateClass() {
  var entry = document.getElementById('update-entry');
  var modal = document.querySelector('#update-modal .update-modal');
  var isDownloading = updatePreviewState.status === 'downloading';
  var isReady = updatePreviewState.status === 'ready';
  var isError = updatePreviewState.status === 'error';
  var isOpening = updatePreviewState.status === 'opening';
  var isPatch = updatePreviewState.mode === 'patch';
  if (entry) {
    entry.classList.toggle('downloading', isDownloading || isOpening);
    entry.classList.toggle('ready', isReady);
  }
  if (modal) {
    modal.classList.toggle('ready', isReady);
    modal.classList.toggle('error', isError);
  }
  var label = document.getElementById('update-btn-label');
  var btn = document.getElementById('update-primary-btn');
  var canDownloadUpdate = updatePreviewState.configured && updatePreviewState.updateAvailable && updatePreviewState.downloadUrl;
  var canOpenRelease = updatePreviewState.configured && updatePreviewState.updateAvailable && !updatePreviewState.downloadUrl && updatePreviewState.releaseUrl;
  if (label) {
    if (isDownloading) label.textContent = (isPatch ? '快速补丁 ' : '正在下载 ') + Math.round(updatePreviewState.progress) + '%';
    else if (isOpening) label.textContent = '正在打开安装包';
    else if (isError && updatePreviewState.mode === 'patch' && updatePreviewState.downloadUrl) label.textContent = '下载完整安装包';
    else if (isError) label.textContent = updatePreviewState.mode === 'installer' ? '重试下载' : '重试更新';
    else if (isReady && isPatch && updatePreviewState.restartRequired) label.textContent = '重启生效';
    else if (isReady && isPatch) label.textContent = '补丁已应用';
    else if (isReady && updatePreviewState.installerOpened) label.textContent = '安装包已打开';
    else if (isReady && updatePreviewState.installerPath) label.textContent = updatePreviewState.cached ? '打开已下载安装包' : '打开安装包';
    else if (isReady) label.textContent = updatePreviewState.configured ? '打开安装包' : '预览完成';
    else label.textContent = updatePreviewState.patchAvailable ? '安装快速补丁' : ((canDownloadUpdate || canOpenRelease) ? '下载完整安装包' : '立即更新');
  }
  if (btn) btn.disabled = false;
  var foot = document.getElementById('update-footnote');
  if (foot) {
    if (isDownloading) foot.textContent = (updatePreviewState.message || (isPatch ? '正在下载快速补丁' : '正在下载完整安装包')) + (updateProgressDetailText() ? ' · ' + updateProgressDetailText() : '');
    else if (isError) foot.textContent = '下载失败：' + (updatePreviewState.errorReason || updatePreviewState.errorDetail || updatePreviewState.message || '请稍后重试') + (updatePreviewState.failedAttempts && updatePreviewState.failedAttempts.length ? ' · 已尝试 ' + updatePreviewState.failedAttempts.length + ' 条线路' : '');
    else if (isReady && isPatch) foot.textContent = updatePreviewState.restartRequired ? '快速补丁已应用，重启 Mineradio 后生效。' : '快速补丁已应用。';
    else if (isReady) foot.textContent = updatePreviewState.cached ? '已复用上次校验通过的安装包，不会重复下载。' : '安装包已准备好，点击按钮后再打开安装。';
    else if (updatePreviewState.patchAvailable) foot.textContent = '优先使用轻量补丁，只更新缺失或变更的资源文件；不适用时可下载完整安装包。';
    else foot.textContent = updatePreviewState.updateAvailable ? '没有可用快速补丁时会下载完整安装包。' : '当前版本已是最新。';
  }
}

function updateUpdatePreviewProgress(progress) {
  updatePreviewState.progress = clampRange(Number(progress) || 0, 0, 100);
  var fill = document.getElementById('update-btn-fill');
  if (fill) fill.style.width = updatePreviewState.progress + '%';
  var ring = document.getElementById('update-progress-ring');
  if (ring) {
    var circumference = 55.29;
    ring.style.strokeDashoffset = (circumference * (1 - updatePreviewState.progress / 100)).toFixed(2);
  }
  syncUpdatePreviewStateClass();
}

function openUpdatePanel() {
  var mask = document.getElementById('update-modal');
  var entry = document.getElementById('update-entry');
  if (!mask) return;
  renderUpdatePreviewPanel();
  if (entry && window.gsap) {
    window.gsap.fromTo(entry, { scale: 0.93 }, { scale: 1, duration: 0.42, ease: 'back.out(1.7)', overwrite: 'auto' });
  }
  openGsapModal(mask);
  updatePreviewState.open = true;
  animateUpdatePanelContents();
}

function closeUpdatePanel() {
  closeGsapModal(document.getElementById('update-modal'), function(){
    updatePreviewState.open = false;
  });
}

function animateUpdatePanelContents() {
  if (!window.gsap) return;
  var modal = document.querySelector('#update-modal .update-modal');
  if (!modal) return;
  var parts = [
    modal.querySelector('.update-kicker'),
    modal.querySelector('.update-version'),
    modal.querySelector('.update-hero')
  ].filter(Boolean);
  var items = Array.prototype.slice.call(modal.querySelectorAll('.update-item'));
  var actions = modal.querySelector('.update-actions');
  window.gsap.fromTo(parts,
    { autoAlpha: 0, x: -7, filter: 'blur(5px)' },
    { autoAlpha: 1, x: 0, filter: 'blur(0px)', duration: 0.50, ease: 'power3.out', stagger: 0.045, delay: 0.10, overwrite: true }
  );
  window.gsap.fromTo(items,
    { autoAlpha: 0, x: -8 },
    { autoAlpha: 1, x: 0, duration: 0.34, ease: 'power3.out', stagger: 0.055, delay: 0.25, overwrite: true }
  );
  if (actions) {
    window.gsap.fromTo(actions,
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, y: 0, duration: 0.36, ease: 'power3.out', delay: 0.42, overwrite: true }
    );
  }
}

async function startRealUpdateDownload() {
  if (updatePreviewState.status === 'downloading' || updatePreviewState.status === 'opening') return;
  if (updatePreviewState.status === 'ready' && updatePreviewState.installerPath) {
    openDownloadedUpdateInstaller(updatePreviewState.installerPath);
    return;
  }
  if (updatePreviewState.timer) clearInterval(updatePreviewState.timer);
  if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
  updatePreviewState.status = 'downloading';
  updatePreviewState.progress = 0;
  updatePreviewState.mode = 'installer';
  updatePreviewState.downloadJobId = '';
  updatePreviewState.installerPath = '';
  updatePreviewState.installerOpened = false;
  updatePreviewState.cached = false;
  updatePreviewState.received = 0;
  updatePreviewState.total = 0;
  updatePreviewState.speedBps = 0;
  updatePreviewState.etaSeconds = 0;
  updatePreviewState.sourceLabel = '';
  updatePreviewState.attempt = 0;
  updatePreviewState.attempts = 0;
  updatePreviewState.errorReason = '';
  updatePreviewState.errorDetail = '';
  updatePreviewState.failedAttempts = [];
  updatePreviewState.message = '正在下载完整安装包';
  updateUpdatePreviewProgress(0);
  try {
    var job = await apiJson('/api/update/download', { method: 'POST' });
    if (!job || job.ok === false || !job.id) throw new Error((job && job.error) || 'UPDATE_DOWNLOAD_START_FAILED');
    updatePreviewState.downloadJobId = job.id;
    applyUpdateDownloadJob(job);
    updatePreviewState.pollTimer = setInterval(function(){
      pollUpdateDownloadJob(job.id);
    }, 360);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || '更新下载启动失败';
    updatePreviewState.errorDetail = updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(0);
    showToast('更新下载启动失败：' + updatePreviewState.errorReason);
  }
}
async function startRealUpdatePatch() {
  if (updatePreviewState.status === 'downloading' || updatePreviewState.status === 'opening') return;
  if (updatePreviewState.status === 'ready' && updatePreviewState.mode === 'patch') {
    restartForAppliedPatch();
    return;
  }
  if (updatePreviewState.timer) clearInterval(updatePreviewState.timer);
  if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
  updatePreviewState.status = 'downloading';
  updatePreviewState.mode = 'patch';
  updatePreviewState.progress = 0;
  updatePreviewState.patchJobId = '';
  updatePreviewState.installerPath = '';
  updatePreviewState.installerOpened = false;
  updatePreviewState.cached = false;
  updatePreviewState.received = 0;
  updatePreviewState.total = 0;
  updatePreviewState.speedBps = 0;
  updatePreviewState.etaSeconds = 0;
  updatePreviewState.sourceLabel = '';
  updatePreviewState.attempt = 0;
  updatePreviewState.attempts = 0;
  updatePreviewState.errorReason = '';
  updatePreviewState.errorDetail = '';
  updatePreviewState.failedAttempts = [];
  updatePreviewState.patchFallbackTried = false;
  updatePreviewState.message = '正在下载快速补丁';
  updateUpdatePreviewProgress(0);
  try {
    var job = await apiJson('/api/update/patch', { method: 'POST' });
    if (!job || job.ok === false || !job.id) throw new Error((job && job.error) || 'UPDATE_PATCH_START_FAILED');
    updatePreviewState.patchJobId = job.id;
    applyUpdateDownloadJob(job);
    updatePreviewState.pollTimer = setInterval(function(){
      pollUpdatePatchJob(job.id);
    }, 320);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || '快速补丁不可用';
    updatePreviewState.errorDetail = updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(0);
    updatePreviewState.patchFallbackTried = true;
    showToast('快速补丁不可用，可手动下载完整安装包');
  }
}

async function pollUpdateDownloadJob(id) {
  if (!id) return;
  try {
    var job = await apiJson('/api/update/download/status?id=' + encodeURIComponent(id) + '&t=' + Date.now());
    applyUpdateDownloadJob(job);
  } catch (e) {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = '更新下载状态读取失败';
    updatePreviewState.errorDetail = (e && e.message) || updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(updatePreviewState.progress || 0);
    showToast('更新下载状态读取失败');
  }
}
async function pollUpdatePatchJob(id) {
  if (!id) return;
  try {
    var job = await apiJson('/api/update/patch/status?id=' + encodeURIComponent(id) + '&t=' + Date.now());
    applyUpdateDownloadJob(job);
  } catch (e) {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = '快速补丁状态读取失败';
    updatePreviewState.errorDetail = (e && e.message) || updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(updatePreviewState.progress || 0);
    showToast('快速补丁状态读取失败');
  }
}

function applyUpdateDownloadJob(job) {
  if (!job || job.ok === false || job.status === 'error') {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.mode = (job && job.mode) || updatePreviewState.mode || 'installer';
    updatePreviewState.received = Number(job && job.received || 0);
    updatePreviewState.total = Number(job && job.total || 0);
    updatePreviewState.speedBps = Number(job && job.speedBps || 0);
    updatePreviewState.etaSeconds = Number(job && job.etaSeconds || 0);
    updatePreviewState.sourceLabel = (job && job.sourceLabel) || updatePreviewState.sourceLabel || '';
    updatePreviewState.attempt = Number(job && job.attempt || 0);
    updatePreviewState.attempts = Number(job && job.attempts || 0);
    updatePreviewState.errorReason = (job && (job.errorReason || job.message || job.error)) || '请稍后重试';
    updatePreviewState.errorDetail = (job && job.errorDetail) || '';
    updatePreviewState.failedAttempts = Array.isArray(job && job.failedAttempts) ? job.failedAttempts : [];
    updatePreviewState.message = (job && job.message) || updatePreviewState.errorReason;
    updatePreviewState.status = 'error';
    updateUpdatePreviewProgress(job && job.progress || updatePreviewState.progress || 0);
    if (updatePreviewState.mode === 'patch' && updatePreviewState.downloadUrl && !updatePreviewState.patchFallbackTried) {
      updatePreviewState.patchFallbackTried = true;
      showToast('快速补丁失败，可手动下载完整安装包：' + updatePreviewState.errorReason);
      return;
    }
    showToast('更新下载失败：' + updatePreviewState.errorReason);
    return;
  }
  if (job.id) updatePreviewState.downloadJobId = job.id;
  updatePreviewState.mode = job.mode || updatePreviewState.mode || 'installer';
  if (updatePreviewState.mode === 'patch') updatePreviewState.patchJobId = job.id || updatePreviewState.patchJobId;
  updatePreviewState.received = Number(job.received || 0);
  updatePreviewState.total = Number(job.total || 0);
  updatePreviewState.speedBps = Number(job.speedBps || 0);
  updatePreviewState.etaSeconds = Number(job.etaSeconds || 0);
  updatePreviewState.sourceLabel = job.sourceLabel || '';
  updatePreviewState.attempt = Number(job.attempt || 0);
  updatePreviewState.attempts = Number(job.attempts || 0);
  updatePreviewState.errorReason = job.errorReason || '';
  updatePreviewState.errorDetail = job.errorDetail || '';
  updatePreviewState.failedAttempts = Array.isArray(job.failedAttempts) ? job.failedAttempts : [];
  updatePreviewState.message = job.message || '';
  updatePreviewState.restartRequired = !!job.restartRequired;
  updatePreviewState.cached = !!job.cached;
  if (job.status === 'downloading' || job.status === 'queued') {
    updatePreviewState.status = 'downloading';
    updateUpdatePreviewProgress(job.progress || 0);
    return;
  }
  if (job.status === 'ready') {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'ready';
    updatePreviewState.installerPath = job.filePath || '';
    updateUpdatePreviewProgress(100);
    pulseUpdateReady();
    if (updatePreviewState.mode === 'patch') {
      showToast(updatePreviewState.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用');
    } else if (updatePreviewState.installerPath) {
      showToast(updatePreviewState.cached ? '已复用上次下载的安装包' : '安装包已下载，点击按钮打开');
    }
  }
}
async function restartForAppliedPatch() {
  if (!updatePreviewState.restartRequired) return;
  try {
    if (window.desktopWindow && typeof window.desktopWindow.restartApp === 'function') {
      await window.desktopWindow.restartApp();
      return;
    }
  } catch (e) {}
  showToast('请手动重启 Mineradio 让补丁生效');
}

async function openDownloadedUpdateInstaller(filePath) {
  if (!filePath) return;
  if (updatePreviewState.installerOpened) return;
  updatePreviewState.status = 'opening';
  syncUpdatePreviewStateClass();
  try {
    if (window.desktopWindow && window.desktopWindow.openUpdateInstaller) {
      var result = await window.desktopWindow.openUpdateInstaller(filePath);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'OPEN_UPDATE_FAILED');
      updatePreviewState.installerOpened = true;
      updatePreviewState.status = 'ready';
      syncUpdatePreviewStateClass();
      showToast('安装包已打开');
      return;
    }
    throw new Error('DESKTOP_BRIDGE_MISSING');
  } catch (e) {
    updatePreviewState.status = 'ready';
    syncUpdatePreviewStateClass();
    if (updatePreviewState.releaseUrl) window.open(updatePreviewState.releaseUrl, '_blank');
    showToast('无法自动打开安装包，已尝试打开更新页面');
  }
}

function startUpdatePreviewDownload() {
  var releaseLink = updatePreviewState.downloadUrl || updatePreviewState.releaseUrl;
  if (updatePreviewState.status === 'ready' && updatePreviewState.mode === 'patch') {
    restartForAppliedPatch();
    return;
  }
  if (updatePreviewState.configured && updatePreviewState.updateAvailable) {
    if (updatePreviewState.patchAvailable && updatePreviewState.patchUrl && !updatePreviewState.patchFallbackTried) {
      startRealUpdatePatch();
    } else if (updatePreviewState.downloadUrl) {
      startRealUpdateDownload();
    } else if (releaseLink) {
      window.open(releaseLink, '_blank');
      showToast('已打开更新页面');
    } else {
      showToast('这个版本还没有可用下载链接');
    }
    return;
  }
  if (updatePreviewState.status === 'ready') {
    if (window.gsap) {
      var modal = document.querySelector('#update-modal .update-modal');
      if (modal) window.gsap.fromTo(modal, { boxShadow: '0 30px 100px rgba(0,0,0,.62),0 0 0 1px rgba(244,210,138,.16)' }, { boxShadow: '0 30px 100px rgba(0,0,0,.62),0 0 34px rgba(244,210,138,.18)', duration: 0.52, yoyo: true, repeat: 1, ease: 'sine.inOut' });
    }
    showToast('正式接入后将重启并安装新版');
    return;
  }
  if (updatePreviewState.status === 'downloading') return;
  if (updatePreviewState.timer) clearInterval(updatePreviewState.timer);
  updatePreviewState.status = 'downloading';
  updateUpdatePreviewProgress(0);
  var btn = document.getElementById('update-primary-btn');
  if (btn && window.gsap) window.gsap.fromTo(btn, { scale: 0.985 }, { scale: 1, duration: 0.34, ease: 'back.out(1.45)', overwrite: true });
  updatePreviewState.timer = setInterval(function(){
    var next = updatePreviewState.progress + 3.2 + Math.random() * 7.5;
    if (next >= 100) {
      clearInterval(updatePreviewState.timer);
      updatePreviewState.timer = null;
      updatePreviewState.status = 'ready';
      updateUpdatePreviewProgress(100);
      pulseUpdateReady();
    } else {
      updateUpdatePreviewProgress(next);
    }
  }, 260);
}

function pulseUpdateReady() {
  var entry = document.getElementById('update-entry');
  var btn = document.getElementById('update-primary-btn');
  if (!window.gsap) return;
  if (entry) {
    window.gsap.fromTo(entry,
      { scale: 0.96, filter: 'drop-shadow(0 0 0 rgba(244,210,138,0))' },
      { scale: 1.04, filter: 'drop-shadow(0 0 14px rgba(244,210,138,.28))', duration: 0.34, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: 'auto' }
    );
  }
  if (btn) {
    window.gsap.fromTo(btn,
      { boxShadow: '0 0 0 rgba(244,210,138,0), inset 0 1px 0 rgba(255,255,255,.09)' },
      { boxShadow: '0 0 24px rgba(244,210,138,.16), inset 0 1px 0 rgba(255,255,255,.11)', duration: 0.42, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: true }
    );
  }
}

// ============================================================
//  登录系统
// ============================================================
function isPhoneShellUi() {
  try {
    return !!(document.body && document.body.classList.contains('phone-shell'));
  } catch (_) {
    return false;
  }
}
function openGsapModal(mask) {
  if (!mask) return;
  var panel = mask.querySelector('.modal');
  var phone = isPhoneShellUi();
  mask.classList.add('show');
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (panel) window.gsap.killTweensOf(panel);
    window.gsap.set(mask, { display: 'flex', visibility: 'visible', autoAlpha: 1 });
    if (phone) {
      // 手机端零动画打开：任何 filter/transform/透明度插值在 Android 上都可能整块黑闪
      if (panel) {
        window.gsap.set(panel, { clearProps: 'filter,scale,x,y,transform,opacity,visibility' });
        window.gsap.set(panel, { autoAlpha: 1, x: 0, y: 0 });
      }
    } else {
      window.gsap.fromTo(mask,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.38, ease: 'power2.out', overwrite: true }
      );
      if (panel) {
        window.gsap.fromTo(panel,
          { autoAlpha: 0, y: 26, scale: 0.965, filter: 'blur(12px)' },
          { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.68, ease: 'expo.out', overwrite: true }
        );
      }
    }
  } else {
    mask.style.display = 'flex';
    mask.style.visibility = 'visible';
    mask.style.opacity = '1';
  }
}
function closeGsapModal(mask, afterClose) {
  if (!mask || !mask.classList.contains('show')) {
    if (afterClose) afterClose();
    return;
  }
  var panel = mask.querySelector('.modal');
  var phone = isPhoneShellUi();
  function finish() {
    mask.classList.remove('show');
    if (window.gsap) {
      window.gsap.set(mask, { clearProps: 'display,visibility,opacity' });
      if (panel) window.gsap.set(panel, { clearProps: 'opacity,visibility,transform,filter' });
    } else {
      mask.style.display = '';
      mask.style.visibility = '';
      mask.style.opacity = '';
    }
    if (afterClose) afterClose();
  }
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (phone) {
      if (panel) window.gsap.killTweensOf(panel);
      finish();
    } else {
      if (panel) {
        window.gsap.killTweensOf(panel);
        window.gsap.to(panel, { autoAlpha: 0, y: 18, scale: 0.976, filter: 'blur(8px)', duration: 0.28, ease: 'power2.in', overwrite: true });
      }
      window.gsap.to(mask, { autoAlpha: 0, duration: 0.34, ease: 'power2.inOut', overwrite: true, onComplete: finish });
    }
  } else {
    finish();
  }
}
function bindModalBackdropClose() {
  [
    ['track-detail-modal', closeTrackDetailModal],
    ['login-modal', closeLoginModal],
    ['user-modal', closeUserModal],
    ['custom-lyric-modal', closeCustomLyricModal],
    ['update-modal', closeUpdatePanel]
  ].forEach(function(pair){
    var mask = document.getElementById(pair[0]);
    var close = pair[1];
    if (!mask || mask.__backdropCloseBound) return;
    mask.__backdropCloseBound = true;
    mask.addEventListener('click', function(e){
      if (e.target === mask) close();
    });
  });
}
function onUserBtnClick() {
  if (hasAnyPlatformLogin()) showUserModal();
  else showLoginModal();
}
function platformMeta(provider) {
  if (provider === 'kg') return { key: 'kg', short: 'KG', label: '酷狗音乐', app: '酷狗音乐 App', dot: 'kg' };
  if (provider === 'qq') return { key: 'qq', short: 'QQ', label: 'QQ 音乐', app: 'QQ 音乐 App', dot: 'qq' };
  return { key: 'netease', short: 'NE', label: '网易云音乐', app: '网易云音乐 App', dot: 'netease' };
}
function platformStatus(provider) {
  provider = normalizeAuthProvider(provider);
  if (isAuthProviderRevoked(provider)) return authLoggedOutStatus(provider);
  if (provider === 'kg') return kgLoginStatus;
  return provider === 'qq' ? qqLoginStatus : loginStatus;
}
function providerVipType(provider, status) {
  status = status || platformStatus(provider) || {};
  return Number(status.vipType || status.vip_type || status.vip || status.isVip || status.is_vip || 0) || 0;
}
function providerVipLevel(provider, status) {
  status = status || platformStatus(provider) || {};
  if (provider === 'netease' && (status.isSvip || status.is_svip)) return 'svip';
  var raw = String(status.vipLevel || status.vip_level || '').toLowerCase();
  if (raw === 'svip' || raw === 'vip' || raw === 'none') return raw;
  var vip = providerVipType(provider, status);
  if (provider === 'kg') {
    if (status.isVip || status.is_vip) return 'vip';
    return vip > 0 ? 'vip' : 'none';
  }
  if (provider === 'netease') {
    if (status.isSvip || status.is_svip || vip >= 10) return 'svip';
    if (status.isVip || status.is_vip || vip > 0) return 'vip';
    return 'none';
  }
  return vip > 0 ? 'vip' : 'none';
}
function hasProviderVip(provider, status) {
  return providerVipLevel(provider, status) !== 'none';
}
function hasProviderSvip(provider, status) {
  return provider === 'netease' && providerVipLevel(provider, status) === 'svip';
}
function providerVipBadge(provider, status, idAttr) {
  if (!hasProviderVip(provider, status)) return '';
  var id = idAttr ? ' id="' + idAttr + '"' : '';
  var cls = 'top-account-vip' + (provider === 'qq' ? ' qq' : (provider === 'kg' ? ' kg' : ''));
  var level = providerVipLevel(provider, status);
  var label = provider === 'qq' ? 'QQ VIP' : (provider === 'kg'
    ? (status.vipLabel && status.vipLabel !== '无VIP' ? status.vipLabel : '酷狗 VIP')
    : (level === 'svip' ? 'SVIP' : 'VIP'));
  return '<span' + id + ' class="' + cls + '">' + label + '</span>';
}
function hasPlatformLogin(provider) {
  provider = normalizeAuthProvider(provider);
  if (isAuthProviderRevoked(provider)) return false;
  var st = platformStatus(provider);
  return !!(st && st.loggedIn);
}
function hasAnyPlatformLogin() {
  return hasPlatformLogin('netease') || hasPlatformLogin('qq') || hasPlatformLogin('kg');
}
function firstLoggedProvider() {
  if (hasPlatformLogin(activeAccountProvider)) return activeAccountProvider;
  if (hasPlatformLogin('netease')) return 'netease';
  if (hasPlatformLogin('qq')) return 'qq';
  if (hasPlatformLogin('kg')) return 'kg';
  return 'netease';
}
function resolveProviderAvatarUrl(provider, status) {
  status = status || platformStatus(provider) || {};
  var raw = normalizeAvatarUrl(
    status.avatar || status.headurl || status.headUrl || status.headImgUrl ||
    status.headimgurl || status.figureurl || status.avatarUrl || status.face || ''
  );
  if (!raw && provider === 'qq') raw = qqAvatarFromUin(status.userId || status.uin, 100);
  return raw;
}
function providerAvatarFallbackSrc(provider) {
  var meta = platformMeta(provider);
  var fill = provider === 'qq' ? '#bfd66b' : (provider === 'kg' ? '#00c4ff' : '#d95b67');
  var bg = provider === 'qq' ? '#11150b' : (provider === 'kg' ? '#071018' : '#180b0f');
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="' + bg + '"/><circle cx="48" cy="48" r="34" fill="' + fill + '" opacity=".16"/><text x="48" y="56" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="' + fill + '">' + meta.short + '</text></svg>';
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}
function providerAvatarSrc(provider, status) {
  status = status || platformStatus(provider) || {};
  var raw = resolveProviderAvatarUrl(provider, status);
  if (raw) {
    var src = avatarSrc(raw);
    if (src) return src;
  }
  return providerAvatarFallbackSrc(provider);
}
function providerAvatarImgAttrs(provider, status) {
  status = status || platformStatus(provider) || {};
  var raw = resolveProviderAvatarUrl(provider, status);
  var src = raw ? (avatarSrc(raw) || providerAvatarFallbackSrc(provider)) : providerAvatarFallbackSrc(provider);
  return 'src="' + escHtml(src) + '" alt="" referrerpolicy="no-referrer"' +
    ' data-avatar-provider="' + escHtml(provider || '') + '"' +
    ' data-avatar-uin="' + escHtml(String(status.userId || status.uin || '')) + '"' +
    ' data-avatar-raw="' + escHtml(raw || '') + '"' +
    ' data-avatar-retry="0" onerror="mineradioRetryAvatarImg(this)"';
}
function renderTopAccountPill(provider) {
  var st = platformStatus(provider);
  if (!st || !st.loggedIn) return '';
  var meta = platformMeta(provider);
  var displayName = (provider === 'qq' && st.preview) ? '待接入' : (st.nickname || meta.label);
  var vipTag = providerVipBadge(provider, st);
  return '<span class="top-account-pill">' +
    '<img ' + providerAvatarImgAttrs(provider, st) + '>' +
    '<span class="top-account-name">' + escHtml(displayName) + '</span>' +
    vipTag +
  '</span>';
}
async function refreshLoginStatus(force) {
  try {
    if (isAuthProviderRevoked('netease')) {
      await enforceAuthRevocationOnServer('netease');
      loginStatusChecked = true;
      loginStatusCheckFailed = false;
      loginStatus = authLoggedOutStatus('netease');
      userPlaylists = qqPlaylists.slice();
      myPodcastCollections = [];
      myPodcastItems = {};
      likedSongMap = {};
      updateLikeButtons();
      renderUserBtn();
      return loginStatus;
    }
    var info = await apiJson('/api/login/status?t=' + Date.now());
    if (info && info.loggedIn && info.pendingProfile) {
      var retry = await apiJson('/api/login/status?t=' + Date.now() + '&retry=1');
      if (retry && retry.loggedIn && !retry.pendingProfile) info = retry;
    }
    info = applyAuthRevocationToLoginInfo('netease', info);
    if (isAuthProviderRevoked('netease')) await enforceAuthRevocationOnServer('netease');
    loginStatusChecked = true;
    loginStatusCheckFailed = false;
    loginStatus = applyProviderLoginStatus('netease', info);
    if (loginStatus.loggedIn && !hasPlatformLogin(activeAccountProvider)) activeAccountProvider = 'netease';
    renderUserBtn();
    if (loginStatus.loggedIn) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
      syncLikeStatusForSongs(playQueue.concat(playlist || []));
    } else {
      userPlaylists = qqPlaylists.slice();
      myPodcastCollections = [];
      myPodcastItems = {};
      likedSongMap = {};
      updateLikeButtons();
    }
    return loginStatus;
  } catch (e) {
    console.warn(e);
    loginStatusChecked = true;
    loginStatusCheckFailed = true;
    renderUserBtn();
    return null;
  }
}
function normalizeQQLoginStatus(info) {
  if (isAuthProviderRevoked('qq')) return authLoggedOutStatus('qq');
  var fallback = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ 音乐', userId: '', avatar: '', vipType: 0, stale: false, playbackKeyReady: false };
  info = info || {};
  // sansenjian session payload: { isOk, session:{ uin, cookieObject } }
  if (info.session && typeof info.session === 'object') {
    var sess = info.session;
    var sessObj = sess.cookieObject || {};
    info = Object.assign({}, info, {
      loggedIn: info.isOk !== false && !!(info.loggedIn || sessObj.qm_keyst || sessObj.qqmusic_key || sess.cookie),
      uin: info.uin || sess.uin || sess.loginUin || sessObj.uin || '',
      userId: info.userId || String(sess.uin || sess.loginUin || sessObj.uin || '').replace(/\D/g, ''),
      nickname: info.nickname || sessObj.nick || sessObj.nickname || '',
      playbackKeyReady: !!(info.playbackKeyReady || sessObj.qm_keyst || sessObj.qqmusic_key),
    });
  }
  var userId = info.userId || info.uin || '';
  var avatar = normalizeAvatarUrl(
    (info.avatar || info.headurl || info.headUrl || info.headImgUrl || info.headimgurl || info.figureurl || info.avatarUrl || info.face) || ''
  );
  if (!avatar) avatar = qqAvatarFromUin(userId, 100);
  if (!info.loggedIn) return Object.assign({}, fallback, info, {
    provider: 'qq',
    loggedIn: false,
    nickname: info.nickname || fallback.nickname,
    userId: userId,
    avatar: avatar,
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    stale: !!info.stale
  });
  return Object.assign({}, fallback, info, {
    provider: 'qq',
    loggedIn: true,
    nickname: info.nickname || fallback.nickname,
    userId: userId,
    avatar: avatar,
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    playbackKeyReady: !!info.playbackKeyReady,
    stale: !!info.stale || !!(info.profileUnavailable && !(info.nickname && avatar))
  });
}
function kgAccountVipText(status) {
  status = status || kgLoginStatus || {};
  if (!status.loggedIn) return '';
  if (hasProviderVip('kg', status)) {
    var label = status.vipLabel && status.vipLabel !== '无VIP' ? status.vipLabel : 'VIP';
    return /酷狗|VIP|会员|音乐包/i.test(label) ? label : ('酷狗 ' + label);
  }
  return '';
}
async function refreshKGLoginStatus() {
  try {
    if (isAuthProviderRevoked('kg')) {
      await enforceAuthRevocationOnServer('kg');
      var prevLoggedKg = !!kgLoginStatus.loggedIn;
      kgLoginStatus = authLoggedOutStatus('kg');
      if (prevLoggedKg) userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'kg'; });
      if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
      renderUserBtn();
      updateLoginProviderUi();
      return kgLoginStatus;
    }
    var info = await apiJson('/api/kg/login/status?t=' + Date.now());
    info = applyAuthRevocationToLoginInfo('kg', info);
    if (isAuthProviderRevoked('kg')) await enforceAuthRevocationOnServer('kg');
    var prevLogged = !!kgLoginStatus.loggedIn;
    kgLoginStatus = applyProviderLoginStatus('kg', info);
    kgLoginStatus.isVip = !!(kgLoginStatus.isVip || kgLoginStatus.is_vip || Number(kgLoginStatus.vipType || kgLoginStatus.vip_type || 0) > 0);
    if (kgLoginStatus.loggedIn) {
      // Always sync via KuGouMusicApi /user/vip/detail after login.
      try {
        var vipDetail = await apiJson('/api/kg/user/vip/detail?t=' + Date.now());
        if (vipDetail && vipDetail.loggedIn !== false) {
          if (vipDetail.isVip || Number(vipDetail.vipType || 0) > 0) {
            kgLoginStatus.isVip = true;
            kgLoginStatus.vipType = vipDetail.vipType || kgLoginStatus.vipType || 6;
            kgLoginStatus.vipLevel = 'vip';
          }
          if (vipDetail.vipLabel) kgLoginStatus.vipLabel = vipDetail.vipLabel;
          if (vipDetail.expireTime) kgLoginStatus.expireTime = vipDetail.expireTime;
          if (vipDetail.hasVipToken != null) kgLoginStatus.hasVipToken = !!vipDetail.hasVipToken;
        }
      } catch (e) {
        console.warn('kg /user/vip/detail failed:', e);
      }
    }
    if (kgLoginStatus.isVip && (!kgLoginStatus.vipLabel || kgLoginStatus.vipLabel === '无VIP')) {
      kgLoginStatus.vipLabel = 'VIP';
    }
    if (!kgLoginStatus.loggedIn) {
      if (prevLogged) showToast('酷狗音乐登录已失效');
      else if (info && info.message) showToast(info.message);
      userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'kg'; });
      reindexUserPlaylistsGrouped();
      updateUserPlaylistProviderTabs();
      scheduleShelfRebuild('kg-logout', true);
    } else {
      if (!hasPlatformLogin('netease') && !hasPlatformLogin('qq')) {
        userPlaylistProviderTab = 'kg';
        saveUserPlaylistProviderTab();
      }
      refreshUserPlaylists(true);
    }
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    updateLoginProviderUi();
    return kgLoginStatus;
  } catch (e) {
    console.warn('KG login status failed:', e);
    kgLoginStatus = { provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false };
    renderUserBtn();
    updateLoginProviderUi();
    return kgLoginStatus;
  }
}
async function refreshQQLoginStatus() {
  try {
    if (isAuthProviderRevoked('qq')) {
      await enforceAuthRevocationOnServer('qq');
      var prevRevokedQq = !!qqLoginStatus.loggedIn;
      qqLoginStatus = authLoggedOutStatus('qq');
      if (prevRevokedQq || qqLoginWasLoggedIn) qqPlaylists = [];
      userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'qq'; });
      qqLoginWasLoggedIn = false;
      if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
      renderUserBtn();
      return qqLoginStatus;
    }
    var info = await apiJson('/api/qq/login/status?t=' + Date.now());
    info = applyAuthRevocationToLoginInfo('qq', info);
    if (isAuthProviderRevoked('qq')) await enforceAuthRevocationOnServer('qq');
    info = normalizeQQLoginStatus(info);
    if (isAuthProviderRevoked('qq')) info = authLoggedOutStatus('qq');
    var prevLogged = !!qqLoginStatus.loggedIn;
    qqLoginStatus = info;
    if (!qqLoginStatus.loggedIn) {
      if (prevLogged || qqLoginWasLoggedIn) showToast(qqLoginStatus.stale ? 'QQ 音乐登录已失效' : 'QQ 音乐已掉登录');
      qqPlaylists = [];
      userPlaylists = userPlaylists.filter(function(pl){ return pl.provider !== 'qq'; });
      homeDiscoverState.loaded = false;
    } else if (!userPlaylists.some(function(pl){ return pl && pl.provider === 'qq'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      loadHomeDiscover(true);
      refreshUserPlaylists(true);
    } else if (qqLoginStatus.stale) {
      showToast('QQ 音乐登录状态可能已失效');
    }
    qqLoginWasLoggedIn = !!qqLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return qqLoginStatus;
  } catch (e) {
    console.warn('QQ login status failed:', e);
    qqLoginStatus = normalizeQQLoginStatus(null);
    renderUserBtn();
    return qqLoginStatus;
  }
}
function startQQLoginStatusAutoRefresh() {
  if (qqLoginAutoRefreshTimer) clearInterval(qqLoginAutoRefreshTimer);
  qqLoginAutoRefreshTimer = setInterval(function(){
    refreshQQLoginStatus().catch(function(e){ console.warn('QQ login auto refresh failed:', e); });
  }, 45000);
}
function renderUserBtn() {
  var btn = document.getElementById('user-btn');
  if (!btn) return;
  btn.classList.remove('multi-account');
  if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
  if (dualAccountMode && hasAnyPlatformLogin()) {
    btn.classList.add('logged-in', 'multi-account');
    btn.classList.remove('logged-out');
    btn.title = '账号信息 · 多平台登录状态';
    btn.innerHTML = ['netease', 'qq', 'kg'].map(function(provider){
      return hasPlatformLogin(provider) ? renderTopAccountPill(provider) : '';
    }).join('');
  } else if (hasAnyPlatformLogin()) {
    var st = platformStatus(activeAccountProvider);
    var meta = platformMeta(activeAccountProvider);
    btn.classList.add('logged-in');
    btn.classList.remove('logged-out');
    btn.title = (st.nickname || meta.label) + ' · 账号信息';
    btn.innerHTML = '<img id="user-avatar" ' + providerAvatarImgAttrs(activeAccountProvider, st) + '>' +
                    '<span>' + escHtml(st.nickname || meta.label) + '</span>' +
                    providerVipBadge(activeAccountProvider, st, 'user-vip-tag');
  } else {
    btn.classList.remove('logged-in');
    btn.classList.add('logged-out');
    btn.title = '登录账号';
    btn.innerHTML = '<span class="login-word">登录</span>';
  }
  if (mineradioUsesWebMediaBridge() && hasAnyPlatformLogin()) {
    if (!bridgeExtensionWatchTimer) startBridgeExtensionWatch();
    else refreshBridgeExtensionWatch(false);
  }
  updatePlaybackQualityUi();
}
var MINERADIO_BRIDGE_EXTENSION_VERSION = '1.4.1';
// Bridge 扩展下载源（夸克网盘 / 百度网盘）。链接已自带 pwd，无需提取码。
var BRIDGE_CLOUD_DRIVES = [
  { key: 'quark', name: '夸克网盘', url: 'https://pan.quark.cn/s/c2816f3b700f', code: '' },
  { key: 'baidu', name: '百度网盘', url: 'https://pan.baidu.com/s/1UQGXRS3kBvSBR3W-Duh4rQ?pwd=1gur', code: '' }
];
var loginExtensionProbeTimer = null;
var bridgeExtensionWatchTimer = null;
var BRIDGE_INSTALL_NOTICE_DISMISS_KEY = 'mineradio-bridge-install-notice-dismissed-v1';
var bridgeExtensionNoticeDismissed = false;
var bridgeInstallNoticeDismissed = false;
var bridgeExtensionLastToastVersion = '';
try { bridgeInstallNoticeDismissed = localStorage.getItem(BRIDGE_INSTALL_NOTICE_DISMISS_KEY) === '1'; } catch (_) {}
function isBridgeExtensionReady() {
  var bridge = window.__mineradioWebBridge;
  return !!(bridge && bridge.isReady && bridge.isReady());
}
function dismissBridgeInstallNotice() {
  bridgeInstallNoticeDismissed = true;
  try { localStorage.setItem(BRIDGE_INSTALL_NOTICE_DISMISS_KEY, '1'); } catch (_) {}
  renderBridgeExtensionNotice(false, getBridgeInstalledVersion());
}
function getBridgeInstalledVersion() {
  var bridge = window.__mineradioWebBridge;
  return bridge && bridge.getVersion ? String(bridge.getVersion() || '') : '';
}
function dismissBridgeExtensionNotice() {
  var notice = document.getElementById('bridge-extension-notice');
  if (notice && notice.dataset.mode === 'missing') {
    dismissBridgeInstallNotice();
    return;
  }
  bridgeExtensionNoticeDismissed = true;
  renderBridgeExtensionNotice(false, getBridgeInstalledVersion());
}
// 官网多端提示：扩展就绪且已登录任意平台后只弹一次
var OFFICIAL_SITE_PROMPT_KEY = 'mineradio-official-site-prompted';
function maybeShowOfficialSiteNotice() {
  try {
    if (localStorage.getItem(OFFICIAL_SITE_PROMPT_KEY) === '1') return;
  } catch (_) {}
  if (!isBridgeExtensionReady() || !hasAnyPlatformLogin()) return;
  showOfficialSiteNotice();
}
function showOfficialSiteNotice() {
  var notice = document.getElementById('official-site-notice');
  if (!notice) return;
  notice.classList.add('show');
}
function dismissOfficialSiteNotice() {
  var notice = document.getElementById('official-site-notice');
  if (notice) notice.classList.remove('show');
  try { localStorage.setItem(OFFICIAL_SITE_PROMPT_KEY, '1'); } catch (_) {}
}
function openOfficialSiteFromNotice() {
  dismissOfficialSiteNotice();
  try { window.open('https://mineradio.cn', '_blank', 'noopener,noreferrer'); } catch (_) {}
}
function handleBridgeExtensionNoticePrimary() {
  var notice = document.getElementById('bridge-extension-notice');
  showLoginModal({ source: 'bridge-install-notice' });
}
function handleBridgeExtensionNoticeSecondary() {
  var notice = document.getElementById('bridge-extension-notice');
  if (notice && notice.dataset.mode === 'missing') {
    // missing 模式下"下载扩展包"改为打开官网 mineradio.cn
    try { window.open('https://mineradio.cn', '_blank', 'noopener,noreferrer'); } catch (_) {}
    return;
  }
  refreshBridgeExtensionWatch(true);
}
function renderBridgeExtensionNotice(outdated, installedVersion) {
  var notice = document.getElementById('bridge-extension-notice');
  var title = document.getElementById('bridge-extension-notice-title');
  var body = document.getElementById('bridge-extension-notice-body');
  var primary = document.getElementById('bridge-extension-notice-primary');
  var secondary = document.getElementById('bridge-extension-notice-secondary');
  var userBtn = document.getElementById('user-btn');
  if (!mineradioUsesWebMediaBridge() || !notice) return;
  var ready = isBridgeExtensionReady();
  installedVersion = installedVersion || getBridgeInstalledVersion();
  outdated = !!(ready && outdated && bridgeExtensionNeedsUpdate(installedVersion));
  var missing = !ready;
  var showMissing = missing && !bridgeInstallNoticeDismissed;
  var showOutdated = outdated && !bridgeExtensionNoticeDismissed;
  var mode = showMissing ? 'missing' : (showOutdated ? 'outdated' : '');
  notice.dataset.mode = mode;
  notice.classList.toggle('show', !!mode);
  notice.classList.toggle('missing', mode === 'missing');
  if (title) title.textContent = mode === 'missing' ? '请先安装 Bridge 扩展' : (mode === 'outdated' ? 'Bridge 扩展可更新' : 'Bridge 扩展');
  if (body) {
    if (mode === 'missing') {
      body.textContent = '网页版使用网易云、QQ 音乐、酷狗搜索/播放/登录，需先在登录页下载 Mineradio Bridge 扩展，并按安装指引完成安装。';
    } else if (mode === 'outdated') {
      body.textContent = '当前 Bridge v' + installedVersion + '，网页最新 v' + MINERADIO_BRIDGE_EXTENSION_VERSION + '。请下载解压后在 chrome://extensions 重新加载。';
    }
  }
  if (primary) primary.textContent = mode === 'missing' ? '前往登录页下载' : '下载新版';
  if (secondary) secondary.textContent = mode === 'missing' ? '打开官网' : '重新检测';
  if (userBtn) {
    userBtn.classList.toggle('bridge-update-hint', mode === 'outdated');
    userBtn.classList.toggle('bridge-install-hint', mode === 'missing');
  }
}
function maybeShowBridgeInstallNotice() {
  if (!mineradioUsesWebMediaBridge()) return;
  if (isBridgeExtensionReady()) return;
  renderBridgeExtensionNotice(false, '');
}
async function probeBridgeInstallNotice() {
  if (!mineradioUsesWebMediaBridge() || isBridgeExtensionReady()) return;
  var bridge = window.__mineradioWebBridge;
  if (bridge && typeof bridge.probe === 'function') {
    try { await bridge.probe({ timeoutMs: 5000, force: true }); } catch (_) {}
  }
  if (!isBridgeExtensionReady()) maybeShowBridgeInstallNotice();
}
function ensureBridgeInstallNoticeFlow() {
  if (!mineradioUsesWebMediaBridge() || isBridgeExtensionReady()) return;
  probeBridgeInstallNotice();
}
function scheduleBridgeInstallNoticeChecks() {
  scheduleWebStartupTask(ensureBridgeInstallNoticeFlow, 1200);
  scheduleWebStartupTask(ensureBridgeInstallNoticeFlow, 3200);
  scheduleWebStartupTask(ensureBridgeInstallNoticeFlow, 6200);
}
async function checkBridgeExtensionVersion(opts) {
  opts = opts || {};
  if (!mineradioUsesWebMediaBridge()) return { installed: '', outdated: false };
  var bridge = window.__mineradioWebBridge;
  if (!bridge) return { installed: '', outdated: false };
  try {
    if (typeof bridge.refreshVersion === 'function') await bridge.refreshVersion(opts.timeoutMs || 2500);
    else if (typeof bridge.probe === 'function') await bridge.probe({ timeoutMs: opts.timeoutMs || 2500, force: !!opts.force, refreshVersion: true });
  } catch (_) {}
  var installed = getBridgeInstalledVersion();
  var outdated = !!(installed && bridgeExtensionNeedsUpdate(installed));
  renderBridgeExtensionNotice(outdated, installed);
  renderLoginExtensionStatus(false);
  if (outdated && opts.toast && bridgeExtensionLastToastVersion !== installed) {
    bridgeExtensionLastToastVersion = installed;
    showToast('Bridge 扩展有新版本 v' + MINERADIO_BRIDGE_EXTENSION_VERSION);
  }
  return { installed: installed, outdated: outdated };
}
function stopBridgeExtensionWatch() {
  if (bridgeExtensionWatchTimer) {
    clearInterval(bridgeExtensionWatchTimer);
    bridgeExtensionWatchTimer = null;
  }
  document.removeEventListener('visibilitychange', onBridgeExtensionVisibility);
}
function onBridgeExtensionVisibility() {
  if (!document.hidden) {
    refreshBridgeExtensionWatch(false);
    if (!isBridgeExtensionReady() && !bridgeInstallNoticeDismissed) ensureBridgeInstallNoticeFlow();
  }
}
async function refreshBridgeExtensionWatch(manual) {
  if (!mineradioUsesWebMediaBridge()) return null;
  var bridge = window.__mineradioWebBridge;
  if (bridge && typeof bridge.probe === 'function') {
    try {
      await bridge.probe({ timeoutMs: manual ? 12000 : 4000, force: !!manual });
    } catch (_) {}
  }
  return checkBridgeExtensionVersion({ toast: !!manual, force: !!manual, timeoutMs: manual ? 3000 : 2500 });
}
function startBridgeExtensionWatch() {
  if (!mineradioUsesWebMediaBridge()) return;
  stopBridgeExtensionWatch();
  refreshBridgeExtensionWatch(false);
  bridgeExtensionWatchTimer = setInterval(function () {
    refreshBridgeExtensionWatch(false);
  }, 45000);
  document.addEventListener('visibilitychange', onBridgeExtensionVisibility);
}
function resolveBridgeExtensionDownloadUrl() {
  var versioned = 'downloads/Mineradio-Bridge-' + MINERADIO_BRIDGE_EXTENSION_VERSION + '.zip';
  var origin = String(window.location && window.location.origin || '');
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/$/, '') + '/' + versioned;
  return versioned;
}
function bridgeExtensionInstallGuideUrl() {
  return 'https://tcnqaj820g6y.feishu.cn/docx/C7Xjd3uvFokseqxBFqZc34eSnyd';
}
function compareBridgeExtensionVersion(a, b) {
  a = String(a || '0').replace(/^v/i, '').split('.').map(function(n){ return Number(n) || 0; });
  b = String(b || '0').replace(/^v/i, '').split('.').map(function(n){ return Number(n) || 0; });
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) {
    var av = a[i] || 0;
    var bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}
function bridgeExtensionNeedsUpdate(installedVersion) {
  if (!installedVersion) return false;
  return compareBridgeExtensionVersion(installedVersion, MINERADIO_BRIDGE_EXTENSION_VERSION) < 0;
}
function stopLoginExtensionProbe() {
  if (loginExtensionProbeTimer) {
    clearInterval(loginExtensionProbeTimer);
    loginExtensionProbeTimer = null;
  }
}
function renderLoginExtensionStatus(pinging) {
  var statusEl = document.getElementById('login-extension-status');
  var badge = document.getElementById('login-extension-badge');
  var versionEl = document.getElementById('login-extension-version');
  var panel = document.getElementById('login-extension-panel');
  var downloadBtn = document.getElementById('login-extension-download-btn');
  var bridge = window.__mineradioWebBridge;
  var ready = !!(bridge && bridge.isReady && bridge.isReady());
  var installedVersion = ready && bridge.getVersion ? bridge.getVersion() : '';
  var outdated = ready && bridgeExtensionNeedsUpdate(installedVersion);
  if (panel) {
    panel.classList.toggle('ready', ready && !outdated);
    panel.classList.toggle('outdated', ready && outdated);
  }
  if (versionEl) {
    versionEl.textContent = ready && installedVersion
      ? ('v' + installedVersion + (outdated ? ' → v' + MINERADIO_BRIDGE_EXTENSION_VERSION : ''))
      : ('v' + MINERADIO_BRIDGE_EXTENSION_VERSION);
  }
  if (statusEl) {
    statusEl.className = 'login-extension-status' + (ready ? (outdated ? ' outdated' : ' ready') : (!pinging ? ' missing' : ''));
    if (pinging) statusEl.textContent = '正在检测 Bridge 扩展…';
    else if (ready && outdated) statusEl.textContent = 'Bridge 已连接，但版本偏旧（v' + installedVersion + '），请更新到 v' + MINERADIO_BRIDGE_EXTENSION_VERSION;
    else if (ready) statusEl.textContent = 'Bridge 已连接 · v' + installedVersion;
    else statusEl.textContent = '尚未检测到 Bridge。请先点扩展图标 →「刷新状态」，再点这里重新检测';
  }
  if (badge) {
    badge.className = 'login-extension-badge' + (ready ? (outdated ? ' outdated' : ' ready') : (!pinging ? ' missing' : ''));
    badge.textContent = ready ? (outdated ? '需更新' : '已连接') : (pinging ? '检测中' : '未安装');
  }
  if (downloadBtn) {
    downloadBtn.textContent = outdated ? '下载新版 Bridge' : '下载 Bridge 扩展';
    downloadBtn.style.display = ready && !outdated ? 'none' : '';
  }
  renderBridgeExtensionNotice(outdated, installedVersion);
  if (ready && !outdated) maybeShowOfficialSiteNotice();
}
function startLoginExtensionProbe() {
  stopLoginExtensionProbe();
  var attempts = 0;
  loginExtensionProbeTimer = setInterval(function () {
    attempts++;
    var bridge = window.__mineradioWebBridge;
    if (bridge && typeof bridge.refreshVersion === 'function') {
      bridge.refreshVersion(1200).then(function () { renderLoginExtensionStatus(false); }).catch(function(){});
    } else if (bridge && typeof bridge.probe === 'function') {
      bridge.probe({ timeoutMs: 1200, force: attempts <= 2, refreshVersion: attempts > 2 }).then(function () {
        renderLoginExtensionStatus(false);
      }).catch(function(){});
    }
    var ready = bridge && bridge.isReady && bridge.isReady();
    renderLoginExtensionStatus(!ready && attempts < 10);
    if (ready || attempts >= 16) stopLoginExtensionProbe();
  }, 600);
}
function updateLoginExtensionPanel() {
  var panel = document.getElementById('login-extension-panel');
  var modal = document.querySelector('#login-modal .dual-login-modal');
  if (!panel) return;
  var webMode = mineradioUsesWebMediaBridge();
  panel.classList.toggle('show', webMode);
  if (modal) modal.classList.toggle('has-extension-panel', webMode);
  if (!webMode) {
    stopLoginExtensionProbe();
    if (modal) modal.classList.remove('has-extension-panel');
    return;
  }
  renderLoginExtensionStatus(false);
  renderBridgeCloudDrives();
  if (!window.__mineradioWebBridge || !window.__mineradioWebBridge.isReady || !window.__mineradioWebBridge.isReady()) startLoginExtensionProbe();
}
async function refreshLoginExtensionPanel() {
  if (!mineradioUsesWebMediaBridge()) return;
  renderLoginExtensionStatus(true);
  await refreshBridgeExtensionWatch(true);
  renderLoginExtensionStatus(false);
  if (!window.__mineradioWebBridge || !window.__mineradioWebBridge.isReady || !window.__mineradioWebBridge.isReady()) startLoginExtensionProbe();
  else stopLoginExtensionProbe();
}
function downloadMineradioBridgeExtension() {
  // 已改为网盘分发，打开首个网盘分享链接
  if (BRIDGE_CLOUD_DRIVES && BRIDGE_CLOUD_DRIVES.length) {
    try { window.open(BRIDGE_CLOUD_DRIVES[0].url, '_blank', 'noopener,noreferrer'); } catch (_) {}
    showToast('已打开 ' + BRIDGE_CLOUD_DRIVES[0].name + ' 分享页，请使用提取码下载');
    return;
  }
  var url = resolveBridgeExtensionDownloadUrl();
  try {
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Mineradio-Bridge-' + MINERADIO_BRIDGE_EXTENSION_VERSION + '.zip';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('已开始下载 Bridge 扩展，解压后在浏览器加载');
  } catch (_) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
function renderBridgeCloudDrives() {
  var container = document.getElementById('login-extension-drives');
  if (!container) return;
  var html = BRIDGE_CLOUD_DRIVES.map(function (drive) {
    var safeUrl = String(drive.url || '').replace(/"/g, '&quot;');
    var safeName = String(drive.name || '').replace(/"/g, '&quot;');
    var safeKey = String(drive.key || '').replace(/[^a-zA-Z0-9_-]/g, '');
    var initial = safeName.charAt(0);
    var code = String(drive.code || '').trim();
    var codeHtml = code
      ? ('<span class="bridge-drive-code">提取码 <b>' + code.replace(/"/g, '&quot;') + '</b></span>' +
         '<button class="modal-btn bridge-drive-copy" type="button" onclick="copyBridgeDriveCode(\'' + safeKey + '\')">复制提取码</button>')
      : '';
    return '' +
      '<div class="bridge-drive-card bridge-drive-' + safeKey + '">' +
        '<div class="bridge-drive-card-top">' +
          '<span class="bridge-drive-icon">' + initial + '</span>' +
          '<span class="bridge-drive-name">' + safeName + '</span>' +
        '</div>' +
        '<a class="modal-btn primary bridge-drive-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">下载扩展</a>' +
        codeHtml +
      '</div>';
  }).join('');
  container.innerHTML = html;
}
function copyBridgeDriveCode(key) {
  var drive = (BRIDGE_CLOUD_DRIVES || []).find(function (d) { return d.key === key; });
  if (!drive) return;
  var text = String(drive.code || '');
  var done = function () { showToast('已复制 ' + drive.name + ' 提取码：' + text); };
  var fail = function () {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (_) {
      showToast('请手动复制提取码：' + text);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else {
    fail();
  }
}
function openBridgeExtensionInstallGuide() {
  try { window.open(bridgeExtensionInstallGuideUrl(), '_blank', 'noopener,noreferrer'); } catch (_) {}
}
var loginSessionContext = { returnToAccount: false, source: '' };

async function showLoginModal(opts) {
  if (typeof opts === 'string') opts = { provider: opts };
  opts = opts || {};
  if (opts.provider) loginProvider = (opts.provider === 'qq' || opts.provider === 'kg') ? opts.provider : 'netease';
  beginExplicitProviderLogin(loginProvider);
  loginSessionContext.returnToAccount = !!opts.returnToAccount;
  loginSessionContext.source = String(opts.source || '');
  closeUserModal({ silent: true });
  var modal = document.getElementById('login-modal');
  openGsapModal(modal);
  updateLoginExtensionPanel();
  updateLoginProviderUi();
  refreshLoginExtensionPanel();
  await refreshLoginPanel();
}
function closeLoginModal(opts) {
  opts = opts || {};
  stopQrPoll();
  stopLoginExtensionProbe();
  if (opts.afterLogin && opts.clearRevoked !== false) {
    clearAuthProviderRevoked(opts.provider || activeAccountProvider);
    persistAccountPreferences();
  }
  var shouldOpenAccount = !opts.skipAccountReturn && hasAnyPlatformLogin() && (opts.afterLogin || loginSessionContext.returnToAccount);
  loginSessionContext.returnToAccount = false;
  loginSessionContext.source = '';
  closeGsapModal(document.getElementById('login-modal'));
  if (shouldOpenAccount) {
    updateUserModalUi();
    openGsapModal(document.getElementById('user-modal'));
  }
  if (opts.afterLogin) {
    setTimeout(maybeShowOfficialSiteNotice, 600);
  }
}
function finishLoginFlow(opts) {
  opts = opts || {};
  if (opts.provider) activeAccountProvider = normalizeAuthProvider(opts.provider);
  clearAuthProviderRevoked(activeAccountProvider);
  persistAccountPreferences();
  renderUserBtn();
  updateLoginProviderUi();
  var toastMsg = opts.toast || '';
  var delay = opts.delay != null ? opts.delay : 420;
  setTimeout(function () {
    closeLoginModal({ afterLogin: true, provider: activeAccountProvider });
    if (toastMsg) showToast(toastMsg);
  }, delay);
}
var DONATE_QR_CONFIG = {
  qr: 'icons/donate-qr.png'
};
function markDonateQrLoaded() {
  var shell = document.getElementById('donate-qr-shell');
  if (shell) shell.classList.add('has-image');
}
function markDonateQrFailed() {
  var shell = document.getElementById('donate-qr-shell');
  if (shell) shell.classList.remove('has-image');
}
window.markDonateQrLoaded = markDonateQrLoaded;
window.markDonateQrFailed = markDonateQrFailed;
function applyDonateQrSources() {
  var img = document.getElementById('donate-qr-img');
  if (img && DONATE_QR_CONFIG.qr) {
    img.src = DONATE_QR_CONFIG.qr + (DONATE_QR_CONFIG.qr.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now();
  }
}
function showDonateModal() {
  applyDonateQrSources();
  openGsapModal(document.getElementById('donate-modal'));
}
function closeDonateModal() {
  closeGsapModal(document.getElementById('donate-modal'));
}
function setLoginProvider(provider, silent) {
  loginProvider = (provider === 'qq' || provider === 'kg') ? provider : 'netease';
  if (!silent && document.getElementById('login-modal').classList.contains('show')) {
    beginExplicitProviderLogin(loginProvider);
  }
  updateLoginProviderUi();
  if (!silent && document.getElementById('login-modal').classList.contains('show')) refreshLoginPanel();
}
function providerOfficialLoginUrl(provider) {
  if (provider === 'qq') return 'https://y.qq.com/';
  if (provider === 'kg') return 'https://www.kugou.com/';
  return 'https://music.163.com/#/login';
}
function canUseDesktopProviderLogin(provider) {
  var api = window.desktopWindow;
  if (!api || !api.isDesktop) return false;
  if (provider === 'qq') return typeof api.openQQMusicLogin === 'function';
  if (provider === 'kg') return false;
  return typeof api.openNeteaseMusicLogin === 'function';
}
function openProviderOfficialPage(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
  try { window.open(providerOfficialLoginUrl(provider), '_blank', 'noopener,noreferrer'); } catch (_) {}
}
function currentLoginLoggedIn() {
  if (loginProvider === 'qq') return !!(qqLoginStatus && qqLoginStatus.loggedIn);
  if (loginProvider === 'kg') return !!(kgLoginStatus && kgLoginStatus.loggedIn);
  return !!(loginStatus && loginStatus.loggedIn);
}
function currentLoginHasQr() {
  if (loginProvider === 'qq') return !!qqQrSig;
  if (loginProvider === 'kg') return !!kgQrKey;
  return !!qrKey;
}
function setLoginQrHint(text, cls) {
  loginQrHint = text || '';
  loginQrHintClass = cls || '';
  var st = document.getElementById('qr-status');
  if (!st) return;
  if (loginQrHint) {
    st.textContent = loginQrHint;
    st.className = loginQrHintClass || '';
  }
}
function clearLoginQrHint() {
  loginQrHint = '';
  loginQrHintClass = '';
}
function updateLoginProviderUi() {
  var meta = platformMeta(loginProvider);
  var isQQ = loginProvider === 'qq';
  var isKG = loginProvider === 'kg';
  var isNE = !isQQ && !isKG;
  var loginModal = document.querySelector('.login-stage-modal');
  if (loginModal) loginModal.setAttribute('data-login-provider', loginProvider);
  var title = document.getElementById('login-modal-title');
  var desc = document.getElementById('login-modal-desc');
  var shell = document.getElementById('qr-shell');
  var qrImg = document.getElementById('qr-img');
  var st = document.getElementById('qr-status');
  var refreshBtn = document.getElementById('refresh-qr-btn');
  var officialBtn = document.getElementById('login-official-fallback-btn');
  var refreshStatusBtn = document.getElementById('login-refresh-status-btn');
  var qqPanel = document.getElementById('qq-cookie-panel');
  var kgPanel = document.getElementById('kg-cookie-panel');
  var qqCookieToggle = document.getElementById('qq-cookie-toggle-btn');
  var qqCard = document.getElementById('qq-web-login-card');
  var neteaseBtn = document.getElementById('login-provider-netease');
  var qqBtn = document.getElementById('login-provider-qq');
  var kgBtn = document.getElementById('login-provider-kg');
  var loginBusy = isQQ ? !!qqWebLoginBusy : (isNE ? !!neteaseWebLoginBusy : false);
  var loggedIn = currentLoginLoggedIn();
  var qqWebLogin = isQQ && !loggedIn;
  var hasQr = currentLoginHasQr();
  var preferQr = !loggedIn && !isQQ;
  var qrReady = preferQr && hasQr && !loginQrError;
  var qrLoading = preferQr && (loginQrBusy || (!hasQr && !loginQrError));
  if (neteaseBtn) {
    neteaseBtn.classList.toggle('active', isNE);
    neteaseBtn.setAttribute('aria-selected', isNE ? 'true' : 'false');
  }
  if (qqBtn) {
    qqBtn.classList.toggle('active', isQQ);
    qqBtn.setAttribute('aria-selected', isQQ ? 'true' : 'false');
  }
  if (kgBtn) {
    kgBtn.classList.toggle('active', isKG);
    kgBtn.setAttribute('aria-selected', isKG ? 'true' : 'false');
  }
  if (title) title.textContent = '登录' + meta.label;
  if (desc) {
    if (isKG) {
      desc.innerHTML = '用 <b>酷狗 App 扫码</b> 登录，可直接拿到安卓凭证。也可官网登录或手动导入 Cookie。';
    } else if (isQQ) {
      desc.innerHTML = '在 <b>y.qq.com 官方网页</b> 完成登录，然后回到此页点击「刷新登录状态」。也可手动导入 Cookie。';
    } else {
      desc.innerHTML = '用 <b>网易云 App 扫码</b> 登录。扫码失败时可改用官网登录。';
    }
  }
  if (shell) {
    shell.classList.toggle('qr-mode', preferQr && !loginQrError);
    shell.classList.toggle('qr-loading', !!qrLoading);
    shell.classList.toggle('web-login-preview', qqWebLogin || !!(preferQr && loginQrError));
    shell.classList.toggle('netease-preview', isNE);
    shell.classList.toggle('qq-preview', isQQ);
    shell.classList.toggle('kg-preview', isKG);
  }
  if (qrImg) {
    qrImg.style.display = (qrReady && !qqWebLogin && qrImg.getAttribute('src')) ? 'block' : 'none';
  }
  if (qqPanel) qqPanel.classList.toggle('show', isQQ && qqManualCookieOpen);
  if (kgPanel) kgPanel.classList.toggle('show', isKG && kgManualCookieOpen);
  if (qqCookieToggle) {
    qqCookieToggle.classList.toggle('show', isQQ || isKG);
    qqCookieToggle.textContent = (isQQ ? qqManualCookieOpen : kgManualCookieOpen) ? '收起导入' : '手动导入';
  }
  if (qqCard) {
    qqCard.style.display = (qqWebLogin || (preferQr && loginQrError)) ? '' : 'none';
    qqCard.disabled = loginBusy;
    var cardMark = qqCard.querySelector('b');
    var cardLabel = qqCard.querySelector('span');
    if (cardMark) cardMark.textContent = isKG ? 'KG' : (isQQ ? 'QQ' : 'NE');
    if (cardLabel) cardLabel.textContent = '打开官方登录';
  }
  if (st) {
    if (loggedIn) {
      st.className = 'preview';
      if (isKG) {
        var kgVip = kgAccountVipText(kgLoginStatus);
        st.textContent = '已登录酷狗 · ' + (kgLoginStatus.nickname || '') + (kgVip ? (' · ' + kgVip) : '');
        st.className = hasProviderVip('kg', kgLoginStatus) ? 'scan' : 'preview';
      } else if (isQQ) {
        st.textContent = '已登录 QQ 音乐 · ' + (qqLoginStatus.nickname || '') + (hasProviderVip('qq', qqLoginStatus) ? ' · QQ VIP' : '');
        if (hasProviderVip('qq', qqLoginStatus)) st.className = 'scan';
      } else {
        var neVip = providerVipLevel('netease', loginStatus);
        st.textContent = '已登录网易云 · ' + (loginStatus.nickname || '') + (neVip === 'svip' ? ' · SVIP' : (neVip === 'vip' ? ' · VIP' : ''));
        if (neVip !== 'none') st.className = 'scan';
      }
    } else if (qqWebLogin && qqWebLoginBusy) {
      st.textContent = '已打开 QQ 音乐官网，请完成登录…';
      st.className = 'preview';
    } else if (qqWebLogin && loginQrHint) {
      st.textContent = loginQrHint;
      st.className = loginQrHintClass || 'preview';
    } else if (qqWebLogin) {
      st.textContent = '点击下方按钮打开 QQ 音乐官网登录';
      st.className = 'preview';
    } else if (loginQrError) {
      st.textContent = loginQrError;
      st.className = 'fail';
    } else if (qrLoading) {
      st.textContent = isKG ? '正在生成酷狗扫码…' : (isQQ ? '正在生成 QQ 扫码…' : '正在生成网易云扫码…');
      st.className = 'preview';
    } else if (qrReady && loginQrHint) {
      // Preserve polling status ("已扫码/登录成功") — do not wipe with default tip
      st.textContent = loginQrHint;
      st.className = loginQrHintClass || '';
    } else if (qrReady) {
      st.textContent = isKG ? '请用酷狗 App 扫码登录' : (isQQ ? '请用手机 QQ 扫码登录' : '请用网易云 App 扫码登录');
      st.className = '';
    }
  }
  if (refreshBtn) {
    refreshBtn.disabled = loginBusy || loginQrBusy;
    if (qqWebLogin) {
      refreshBtn.style.display = 'none';
    } else {
      refreshBtn.style.display = '';
      if (!loggedIn) {
        refreshBtn.textContent = '刷新二维码';
        refreshBtn.onclick = isKG ? startKGQrLogin : startNeteaseQrLogin;
      } else {
        refreshBtn.textContent = '官网登录';
        refreshBtn.onclick = openProviderWebLogin;
      }
    }
  }
  if (officialBtn) {
    officialBtn.style.display = (loggedIn || qqWebLogin) ? 'none' : '';
    officialBtn.disabled = loginBusy;
  }
  if (refreshStatusBtn) {
    refreshStatusBtn.disabled = loginBusy;
    refreshStatusBtn.onclick = refreshProviderLoginStatus;
  }
}
async function refreshLoginPanel() {
  stopQrPoll();
  qrKey = null;
  kgQrKey = null;
  qqQrSig = null;
  qqQrToken = null;
  loginQrError = '';
  clearLoginQrHint();
  loginQrBusy = true;
  updateLoginProviderUi();
  try {
    if (loginProvider === 'qq') {
      stopQrPoll();
      qqQrSig = null;
      qqQrToken = null;
      loginQrError = '';
      loginQrBusy = false;
      await refreshQQLoginStatus();
      if (!qqLoginStatus.loggedIn) {
        setLoginQrHint('点击下方按钮打开 QQ 音乐官网，登录后点「刷新登录状态」', 'preview');
      } else {
        clearLoginQrHint();
      }
      updateLoginProviderUi();
      return;
    }
    if (loginProvider === 'kg') {
      await refreshKGLoginStatus();
      updateLoginProviderUi();
      if (!kgLoginStatus.loggedIn) await startKGQrLogin();
      else loginQrBusy = false;
      return;
    }
    await refreshLoginStatus(true);
    updateLoginProviderUi();
    if (!loginStatus.loggedIn) await startNeteaseQrLogin();
    else loginQrBusy = false;
  } finally {
    if (!loginQrBusy) updateLoginProviderUi();
  }
}
async function startNeteaseQrLogin() {
  beginExplicitProviderLogin('netease');
  var qrImg = document.getElementById('qr-img');
  stopQrPoll();
  qrKey = null;
  loginQrError = '';
  clearLoginQrHint();
  loginQrBusy = true;
  updateLoginProviderUi();
  try {
    var keyRes = await apiJson('/api/login/qr/key?t=' + Date.now());
    if (keyRes && keyRes.error) throw new Error(keyRes.error);
    var key = keyRes && (keyRes.unikey || keyRes.key);
    if (!key) throw new Error((keyRes && keyRes.message) || '网易云二维码生成失败');
    var createRes = await apiJson('/api/login/qr/create?key=' + encodeURIComponent(key) + '&t=' + Date.now());
    if (createRes && createRes.error) throw new Error(createRes.error);
    var qrimg = createRes && (createRes.qrimg || createRes.img || (createRes.data && (createRes.data.qrimg || createRes.data.img)));
    var qrUrl = createRes && (createRes.url || (createRes.data && createRes.data.url));
    qrKey = key;
    if (qrImg) {
      qrImg.src = qrimg || ('https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qrUrl || ''));
    }
    loginQrBusy = false;
    loginQrError = '';
    setLoginQrHint('请用网易云 App 扫码登录', '');
    updateLoginProviderUi();
    startQrPoll();
  } catch (e) {
    loginQrBusy = false;
    loginQrError = friendlyAuthBridgeError(e) || '网易云二维码生成失败';
    updateLoginProviderUi();
  }
}
async function startQQQrLogin() {
  beginExplicitProviderLogin('qq');
  var qrImg = document.getElementById('qr-img');
  stopQrPoll();
  qqQrSig = null;
  qqQrToken = null;
  loginQrError = '';
  clearLoginQrHint();
  loginQrBusy = true;
  updateLoginProviderUi();
  try {
    var createRes = await apiJson('/api/qq/login/qr/create?t=' + Date.now());
    if (createRes && createRes.error) throw new Error(createRes.error);
    var qrsig = createRes && createRes.qrsig;
    var ptqrtoken = createRes && createRes.ptqrtoken;
    var qrimg = createRes && (createRes.qrimg || createRes.img);
    if (!qrsig || !qrimg) throw new Error((createRes && (createRes.message || createRes.error)) || 'QQ 二维码生成失败（请确认 Bridge 已更新到 v1.3.28）');
    qqQrSig = qrsig;
    qqQrToken = ptqrtoken || '';
    if (qrImg) qrImg.src = qrimg;
    loginQrBusy = false;
    loginQrError = '';
    setLoginQrHint('请用手机 QQ 扫码登录', '');
    updateLoginProviderUi();
    startQrPoll();
  } catch (e) {
    loginQrBusy = false;
    loginQrError = friendlyAuthBridgeError(e) || 'QQ 二维码生成失败';
    updateLoginProviderUi();
  }
}
async function checkQQQr() {
  if (!qqQrSig) return;
  try {
    // Align with sansenjian POST /user/checkQQLoginQr
    var r = await apiJson('/api/qq/login/qr/check?t=' + Date.now(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrsig: qqQrSig, ptqrtoken: qqQrToken || '' }),
      timeoutMs: 25000,
    });
    if (r && r.error && !r.message && !r.isOk) {
      setLoginQrHint(String(r.error), 'fail');
      return;
    }
    // Doc success: { isOk:true, session:{cookie,uin,...} }
    if (r && (r.isOk === true || (r.loggedIn && r.session)) && (r.loggedIn || (r.session && r.session.cookie))) {
      clearAuthProviderRevoked('qq');
      setLoginQrHint('登录成功！', 'scan');
      stopQrPoll();
      qqLoginStatus = normalizeQQLoginStatus(r);
      activeAccountProvider = 'qq';
      renderUserBtn();
      setTimeout(async function(){
        try { await refreshQQLoginStatus(); } catch (_) {}
        closeLoginModal({ afterLogin: true, provider: 'qq' });
        showToast('欢迎 ' + (qqLoginStatus.nickname || 'QQ 音乐'));
      }, 800);
      return;
    }
    var code = Number(r && r.code);
    if ((r && r.refresh) || code === 65) {
      setLoginQrHint((r && r.message) || '二维码已过期，请刷新', 'fail');
      stopQrPoll();
      return;
    }
    if (code === 67 || (r && r.status === 'scanned')) {
      setLoginQrHint((r && r.message) || '已扫码，请在手机确认…', 'scan');
      return;
    }
    if (code === 66 || (r && r.status === 'wait') || (r && r.isOk === false)) {
      setLoginQrHint((r && r.message) || '请用手机 QQ 扫码', '');
      return;
    }
    if (code === 0 && r && r.loggedIn) {
      setLoginQrHint('登录成功！', 'scan');
      stopQrPoll();
      qqLoginStatus = normalizeQQLoginStatus(r);
      activeAccountProvider = 'qq';
      renderUserBtn();
      setTimeout(async function(){
        try { await refreshQQLoginStatus(); } catch (_) {}
        closeLoginModal({ afterLogin: true });
        showToast('欢迎 ' + (qqLoginStatus.nickname || 'QQ 音乐'));
      }, 800);
      return;
    }
    if (r && (r.message || r.error)) {
      setLoginQrHint(String(r.message || r.error), r.isOk === false ? 'fail' : 'preview');
      if (r.error && /p_skey|checkSig|授权|qm_keyst/i.test(String(r.error))) stopQrPoll();
    }
  } catch (e) {
    setLoginQrHint(friendlyAuthBridgeError(e) || 'QQ 扫码状态查询失败', 'fail');
  }
}
async function startKGQrLogin() {
  beginExplicitProviderLogin('kg');
  var qrImg = document.getElementById('qr-img');
  stopQrPoll();
  kgQrKey = null;
  loginQrError = '';
  clearLoginQrHint();
  loginQrBusy = true;
  updateLoginProviderUi();
  try {
    var keyRes = await apiJson('/api/kg/login/qr/key?t=' + Date.now());
    if (keyRes && keyRes.error) throw new Error(keyRes.error);
    var key = keyRes && (keyRes.unikey || keyRes.key);
    if (!key) throw new Error((keyRes && keyRes.message) || '酷狗二维码生成失败');
    var createRes = await apiJson('/api/kg/login/qr/create?key=' + encodeURIComponent(key) + '&t=' + Date.now());
    if (createRes && createRes.error) throw new Error(createRes.error);
    var qrimg = createRes && (createRes.qrimg || (createRes.data && createRes.data.qrimg));
    var qrUrl = createRes && (createRes.url || (createRes.data && createRes.data.url));
    kgQrKey = key;
    if (qrImg) {
      qrImg.src = qrimg || ('https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qrUrl || ''));
    }
    loginQrBusy = false;
    loginQrError = '';
    setLoginQrHint('请用酷狗 App 扫码登录', '');
    updateLoginProviderUi();
    startQrPoll();
  } catch (e) {
    loginQrBusy = false;
    loginQrError = friendlyAuthBridgeError(e) || '酷狗二维码生成失败';
    updateLoginProviderUi();
  }
}
async function checkKGQr() {
  if (!kgQrKey) return;
  try {
    var r = await apiJson('/api/kg/login/qr/check?key=' + encodeURIComponent(kgQrKey) + '&t=' + Date.now());
    var status = Number(r && (r.status != null ? r.status : r.code));
    if (status === 0) {
      setLoginQrHint('二维码已过期，请刷新', 'fail');
      stopQrPoll();
      return;
    }
    if (status === 1) {
      setLoginQrHint('请用酷狗 App 扫码', '');
      return;
    }
    if (status === 2) {
      setLoginQrHint('已扫码，请在手机确认…', 'scan');
      return;
    }
    if (status === 4 && r && r.loggedIn) {
      clearAuthProviderRevoked('kg');
      setLoginQrHint('登录成功！', 'scan');
      stopQrPoll();
      kgLoginStatus = r;
      activeAccountProvider = 'kg';
      renderUserBtn();
      refreshUserPlaylists(true);
      setTimeout(function() {
        closeLoginModal({ afterLogin: true, provider: 'kg' });
        var vipToast = kgAccountVipText(r);
        showToast('酷狗已登录: ' + (r.nickname || r.userId || '') + (vipToast ? (' · ' + vipToast) : ''));
      }, 420);
      return;
    }
    if (status === 4) {
      setLoginQrHint((r && r.message) || '扫码成功但未拿到凭证，请刷新二维码', 'fail');
      stopQrPoll();
    }
  } catch (e) {
    setLoginQrHint(friendlyAuthBridgeError(e) || '酷狗扫码状态查询失败', 'fail');
  }
}
async function refreshProviderLoginStatus() {
  var statusEl = document.getElementById('qr-status');
  if (statusEl) { statusEl.textContent = '正在同步登录状态…'; statusEl.className = 'preview'; }
  var useBrowserCookie = mineradioUsesWebMediaBridge();
  var provider = normalizeAuthProvider(loginProvider);
  var allowCookieImport = canAcceptProviderSession(provider);
  try {
    if (isAuthProviderRevoked(provider) && !allowCookieImport) {
      await enforceAuthRevocationOnServer(provider);
      var revokedHint = '已退出登录。请扫码，或先点「官网登录」完成登录后再刷新状态';
      if (provider === 'qq') setLoginQrHint(revokedHint, 'preview');
      else if (statusEl) { statusEl.textContent = revokedHint; statusEl.className = 'preview'; }
      updateLoginProviderUi();
      return;
    }
    if (loginProvider === 'kg') {
      if (useBrowserCookie && allowCookieImport) {
        try {
          var kgInfo = await apiJson('/api/kg/login/cookie?t=' + Date.now());
          if (kgInfo && kgInfo.loggedIn && canAcceptProviderSession('kg')) {
            clearAuthProviderRevoked('kg');
            kgLoginStatus = Object.assign({ provider: 'kg', loggedIn: false, nickname: '酷狗音乐', userId: '', avatar: '', vipType: 0, isVip: false, vipLabel: '无VIP' }, kgInfo);
            activeAccountProvider = 'kg';
            renderUserBtn();
            refreshUserPlaylists(true);
            updateLoginProviderUi();
            var kgCookieVip = kgAccountVipText(kgLoginStatus);
            if (statusEl) {
              statusEl.textContent = '酷狗会话已保存' + (kgCookieVip ? (' · ' + kgCookieVip) : '');
              statusEl.className = 'scan';
            }
            setTimeout(function(){
              closeLoginModal({ afterLogin: true, provider: 'kg' });
              showToast('酷狗已登录: ' + (kgLoginStatus.nickname || kgLoginStatus.userId || '') + (kgCookieVip ? (' · ' + kgCookieVip) : ''));
            }, 420);
            return;
          }
        } catch (e) {}
      }
      var kgSynced = await refreshKGLoginStatus();
      if (kgSynced && kgSynced.loggedIn && canAcceptProviderSession('kg')) {
        clearAuthProviderRevoked('kg');
        activeAccountProvider = 'kg';
        renderUserBtn();
        refreshUserPlaylists(true);
        updateLoginProviderUi();
        var kgVipToast = kgAccountVipText(kgSynced);
        if (statusEl) {
          statusEl.textContent = '酷狗会话已保存' + (kgVipToast ? (' · ' + kgVipToast) : '');
          statusEl.className = 'scan';
        }
        setTimeout(function(){
          closeLoginModal({ afterLogin: true, provider: 'kg' });
          showToast('酷狗已登录: ' + (kgSynced.nickname || kgSynced.userId || '') + (kgVipToast ? (' · ' + kgVipToast) : ''));
        }, 420);
        return;
      }
      if (statusEl) { statusEl.textContent = '尚未检测到酷狗登录，请先在官网完成登录'; statusEl.className = 'fail'; }
      updateLoginProviderUi();
      return;
    }
    if (loginProvider === 'qq') {
      if (useBrowserCookie && allowCookieImport) {
        var qqInfo = await apiJson('/api/qq/login/cookie?t=' + Date.now());
        if (qqInfo && qqInfo.loggedIn && canAcceptProviderSession('qq')) {
          clearAuthProviderRevoked('qq');
          qqLoginStatus = normalizeQQLoginStatus(qqInfo);
          activeAccountProvider = 'qq';
          qqManualCookieOpen = false;
          renderUserBtn();
          refreshUserPlaylists(true);
          setLoginQrHint('QQ 音乐会话已保存', 'scan');
          updateLoginProviderUi();
          setTimeout(function(){ closeLoginModal({ afterLogin: true, provider: 'qq' }); showToast('QQ 音乐已登录: ' + (qqLoginStatus.nickname || qqLoginStatus.userId || '')); }, 420);
          return;
        }
        setLoginQrHint((qqInfo && qqInfo.message) || '尚未检测到 QQ 登录 Cookie', 'fail');
      }
      var qqSynced = await refreshQQLoginStatus();
      if (qqSynced && qqSynced.loggedIn && canAcceptProviderSession('qq')) {
        clearAuthProviderRevoked('qq');
        activeAccountProvider = 'qq';
        renderUserBtn();
        refreshUserPlaylists(true);
        setLoginQrHint('QQ 音乐会话已保存', 'scan');
        updateLoginProviderUi();
        setTimeout(function(){ closeLoginModal({ afterLogin: true, provider: 'qq' }); showToast('QQ 音乐已登录: ' + (qqSynced.nickname || qqSynced.userId || '')); }, 420);
        return;
      }
      setLoginQrHint((qqSynced && qqSynced.message) || '尚未检测到 QQ 音乐登录。请点「官网登录」在 y.qq.com 扫码后再刷新', 'fail');
      updateLoginProviderUi();
      return;
    }
    if (useBrowserCookie && allowCookieImport) {
      var neInfo = await apiJson('/api/login/cookie?t=' + Date.now());
      if (neInfo && neInfo.loggedIn && canAcceptProviderSession('netease')) {
        clearAuthProviderRevoked('netease');
        loginStatus = neInfo;
        activeAccountProvider = 'netease';
        renderUserBtn();
        refreshUserPlaylists(true);
        loadHomeDiscover(true);
        updateLoginProviderUi();
        if (statusEl) { statusEl.textContent = '网易云会话已保存'; statusEl.className = 'scan'; }
        setTimeout(function(){ closeLoginModal({ afterLogin: true, provider: 'netease' }); showToast('网易云已登录: ' + (neInfo.nickname || neInfo.userId || '')); }, 420);
        return;
      }
    }
    var neSynced = await refreshLoginStatus(true);
    if (neSynced && neSynced.loggedIn && canAcceptProviderSession('netease')) {
      clearAuthProviderRevoked('netease');
      activeAccountProvider = 'netease';
      renderUserBtn();
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
      updateLoginProviderUi();
      if (statusEl) { statusEl.textContent = '网易云会话已保存'; statusEl.className = 'scan'; }
      setTimeout(function(){ closeLoginModal({ afterLogin: true, provider: 'netease' }); showToast('网易云已登录: ' + (neSynced.nickname || neSynced.userId || '')); }, 420);
      return;
    }
    if (statusEl) { statusEl.textContent = '尚未检测到网易云登录，请先在官网完成登录'; statusEl.className = 'fail'; }
    updateLoginProviderUi();
  } catch (e) {
    var failMsg = friendlyAuthBridgeError(e) || '登录状态同步失败';
    if (statusEl) { statusEl.textContent = failMsg; statusEl.className = 'fail'; }
    updateLoginProviderUi();
  }
}
async function refreshQr() {
  return refreshLoginPanel();
}
function startQrPoll() {
  if (qrPollTimer) clearInterval(qrPollTimer);
  // NetEase/QQ recommend >= 3s between checks
  qrPollTimer = setInterval(checkQr, 3000);
  setTimeout(checkQr, 400);
}
function stopQrPoll() { if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; } }
function toggleQQCookiePanel() {
  if (loginProvider === 'kg') kgManualCookieOpen = !kgManualCookieOpen;
  else qqManualCookieOpen = !qqManualCookieOpen;
  updateLoginProviderUi();
}
function openProviderWebLogin() {
  if (loginProvider === 'qq') return openQQWebLogin();
  if (loginProvider === 'kg') return openKugouWebLogin();
  return openNeteaseWebLogin();
}
async function openKugouWebLogin() {
  var statusEl = document.getElementById('qr-status');
  markAuthCookieImportIntent('kg');
  openProviderOfficialPage('kg');
  if (statusEl) { statusEl.textContent = '已打开酷狗官方登录页，完成登录后点击「刷新登录状态」'; statusEl.className = 'preview'; }
}
async function submitKGCookieLogin() {
  var input = document.getElementById('kg-cookie-input');
  var raw = input && input.value ? input.value.trim() : '';
  if (!raw) { showToast('请先粘贴酷狗 Cookie'); return; }
  var statusEl = document.getElementById('qr-status');
  try {
    if (statusEl) { statusEl.textContent = '正在保存酷狗 Cookie…'; statusEl.className = 'preview'; }
    var info = await apiJson('/api/kg/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: raw })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || '酷狗 Cookie 无效');
    clearAuthProviderRevoked('kg');
    kgLoginStatus = info;
    activeAccountProvider = 'kg';
    kgManualCookieOpen = false;
    renderUserBtn();
    refreshUserPlaylists(true);
    if (statusEl) { statusEl.textContent = '酷狗会话已保存'; statusEl.className = 'scan'; }
    setTimeout(function(){ closeLoginModal({ afterLogin: true }); showToast('酷狗已登录: ' + (info.nickname || info.userId || '')); }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = friendlyAuthBridgeError(e) || '酷狗 Cookie 保存失败'; statusEl.className = 'fail'; }
  }
}
async function openNeteaseWebLogin() {
  if (neteaseWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  markAuthCookieImportIntent('netease');
  var api = window.desktopWindow;
  if (api && api.isDesktop && typeof api.openNeteaseMusicLogin === 'function') {
    neteaseWebLoginBusy = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = '已打开网易云窗口，请在官方页面完成登录…'; statusEl.className = 'preview'; }
    try {
      var result = await api.openNeteaseMusicLogin();
      if (!result || !result.ok || !result.cookie) {
        throw new Error((result && (result.message || result.error)) || '网易云登录未完成');
      }
      if (statusEl) { statusEl.textContent = '正在同步网易云会话…'; statusEl.className = 'preview'; }
      var info = await apiJson('/api/login/cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: result.cookie })
      });
      if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || '网易云会话不可用');
      clearAuthProviderRevoked('netease');
      loginStatus = info;
      activeAccountProvider = 'netease';
      renderUserBtn();
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
      if (statusEl) { statusEl.textContent = '网易云会话已保存'; statusEl.className = 'scan'; }
      setTimeout(function(){
        closeLoginModal({ afterLogin: true });
        showToast('网易云已登录: ' + (info.nickname || info.userId || ''));
      }, 420);
    } catch (e) {
      if (statusEl) { statusEl.textContent = friendlyAuthBridgeError(e) || '网易云登录失败'; statusEl.className = 'fail'; }
    } finally {
      neteaseWebLoginBusy = false;
      updateLoginProviderUi();
    }
    return;
  }
  openProviderOfficialPage('netease');
  if (statusEl) { statusEl.textContent = '已打开网易云官方登录页，完成登录后点击「刷新登录状态」'; statusEl.className = 'preview'; }
}
async function openQQWebLogin() {
  if (qqWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  markAuthCookieImportIntent('qq');
  var api = window.desktopWindow;
  if (api && api.isDesktop && typeof api.openQQMusicLogin === 'function') {
    qqWebLoginBusy = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = '已打开 QQ 音乐窗口，请在官方页面完成登录…'; statusEl.className = 'preview'; }
    try {
      var result = await api.openQQMusicLogin();
      if (!result || !result.ok || !result.cookie) {
        throw new Error((result && (result.message || result.error)) || 'QQ 登录未完成');
      }
      if (statusEl) { statusEl.textContent = '正在同步 QQ 音乐会话…'; statusEl.className = 'preview'; }
      var info = await apiJson('/api/qq/login/cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: result.cookie })
      });
      if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'QQ 会话不可用');
      clearAuthProviderRevoked('qq');
      qqLoginStatus = normalizeQQLoginStatus(info);
      activeAccountProvider = 'qq';
      qqManualCookieOpen = false;
      renderUserBtn();
      refreshUserPlaylists(true);
      var qqPlaybackReady = !!qqLoginStatus.playbackKeyReady && !result.partial;
      if (statusEl) { statusEl.textContent = qqPlaybackReady ? 'QQ 音乐会话已保存' : 'QQ 账号已同步，播放授权不完整，部分歌曲会自动换源'; statusEl.className = 'scan'; }
      setTimeout(function(){
        closeLoginModal({ afterLogin: true });
        showToast((qqPlaybackReady ? 'QQ 音乐已登录: ' : 'QQ 账号已同步: ') + (qqLoginStatus.nickname || qqLoginStatus.userId || ''));
      }, 420);
    } catch (e) {
      if (statusEl) { statusEl.textContent = friendlyAuthBridgeError(e) || 'QQ 登录失败'; statusEl.className = 'fail'; }
    } finally {
      qqWebLoginBusy = false;
      updateLoginProviderUi();
    }
    return;
  }
  stopQrPoll();
  qqQrSig = null;
  qqQrToken = null;
  loginQrError = '';
  clearLoginQrHint();
  qqWebLoginBusy = true;
  updateLoginProviderUi();
  openProviderOfficialPage('qq');
  setLoginQrHint('已打开 y.qq.com，请完成登录后点「刷新登录状态」', 'preview');
  qqWebLoginBusy = false;
  updateLoginProviderUi();
}
async function submitQQCookieLogin() {
  if (qqCookieBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var cookie = input ? input.value.trim() : '';
  if (!cookie) {
    if (statusEl) { statusEl.textContent = '先粘贴 QQ 音乐 cookie'; statusEl.className = 'fail'; }
    return;
  }
  qqCookieBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = '正在保存 QQ 会话…'; statusEl.className = 'preview'; }
  try {
    var info = await apiJson('/api/qq/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'QQ 会话不可用');
    clearAuthProviderRevoked('qq');
    qqLoginStatus = normalizeQQLoginStatus(info);
    activeAccountProvider = 'qq';
    if (input) input.value = '';
    renderUserBtn();
    refreshUserPlaylists(true);
    var manualQQPlaybackReady = !!qqLoginStatus.playbackKeyReady;
    if (statusEl) { statusEl.textContent = manualQQPlaybackReady ? 'QQ 音乐会话已保存' : 'QQ 账号已同步，播放授权不完整，部分歌曲会自动换源'; statusEl.className = 'scan'; }
    setTimeout(function(){
      closeLoginModal({ afterLogin: true });
      showToast((manualQQPlaybackReady ? 'QQ 音乐已登录: ' : 'QQ 账号已同步: ') + (qqLoginStatus.nickname || qqLoginStatus.userId || ''));
    }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = friendlyAuthBridgeError(e) || 'QQ 会话保存失败'; statusEl.className = 'fail'; }
  } finally {
    qqCookieBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
  }
}
async function checkQr() {
  if (loginProvider === 'kg') return checkKGQr();
  if (loginProvider === 'qq') return;
  if (!qrKey) return;
  try {
    var r = await apiJson('/api/login/qr/check?key=' + encodeURIComponent(qrKey) + '&t=' + Date.now());
    if (r && r.error) { setLoginQrHint(String(r.error), 'fail'); return; }
    var code = Number(r && r.code);
    if (code === 800) { setLoginQrHint('二维码已过期, 请刷新', 'fail'); stopQrPoll(); }
    else if (code === 801) { setLoginQrHint('请在网易云 App 中扫码', ''); }
    else if (code === 802) { setLoginQrHint('已扫码, 请在手机确认…', 'scan'); }
    else if (code === 803 && (r.loggedIn || r.hasCookie)) {
      clearAuthProviderRevoked('netease');
      setLoginQrHint(r.pendingProfile ? '登录成功，正在同步账号资料…' : '登录成功！', 'scan');
      stopQrPoll();
      loginStatus = r.loggedIn ? r : Object.assign({}, r, { loggedIn: true, pendingProfile: true, nickname: r.nickname || '网易云用户' });
      activeAccountProvider = 'netease';
      renderUserBtn();
      setTimeout(async function(){
        var fresh = await refreshLoginStatus(true);
        if ((!fresh || !fresh.loggedIn) && !isAuthProviderRevoked('netease')) {
          loginStatus = Object.assign({}, loginStatus, { loggedIn: true, pendingProfile: true });
          renderUserBtn();
          fresh = loginStatus;
        }
        closeLoginModal({ afterLogin: true, provider: 'netease' });
        showToast('欢迎 ' + (fresh && fresh.nickname ? fresh.nickname : '网易云用户'));
      }, r.pendingProfile ? 1200 : 500);
    } else if (code === 803) {
      setLoginQrHint('扫码已确认，但没有拿到登录凭证，请刷新二维码重试', 'fail');
      stopQrPoll();
    } else if (code) {
      setLoginQrHint((r && r.message) || ('扫码状态: ' + code), 'preview');
    }
  } catch (e) {
    setLoginQrHint(friendlyAuthBridgeError(e) || '网易云扫码状态查询失败', 'fail');
  }
}
function updateUserModalUi() {
  if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
  var st = platformStatus(activeAccountProvider);
  var meta = platformMeta(activeAccountProvider);
  var accountModal = document.querySelector('.account-stage-modal');
  if (accountModal) accountModal.setAttribute('data-account-provider', activeAccountProvider);
  var chip = document.getElementById('account-provider-chip');
  var avatar = document.getElementById('user-modal-avatar');
  var name = document.getElementById('user-modal-name');
  var vipEl = document.getElementById('user-modal-vip');
  var uidChip = document.getElementById('account-uid-chip');
  var vipChip = document.getElementById('account-vip-chip');
  var summaryCount = document.getElementById('account-summary-count');
  var summaryMode = document.getElementById('account-summary-mode');
  var vipPill = document.getElementById('account-vip-pill');
  var hint = document.getElementById('account-hint');
  var logoutBtn = document.getElementById('account-logout-btn');
  var addNetease = document.getElementById('account-add-netease');
  var addQQ = document.getElementById('account-add-qq');
  var addKG = document.getElementById('account-add-kg');
  if (chip) {
    chip.className = 'account-provider-chip ' + activeAccountProvider;
    chip.innerHTML = '<span class="account-source-dot ' + meta.dot + '"></span><span>' + meta.label + '</span>';
  }
  if (avatar) applyAccountAvatar(avatar, activeAccountProvider, st);
  if (name) name.textContent = (st && st.nickname) || meta.label;
  var uidText = 'UID ' + ((st && st.userId) || '—');
  var vipLabel = '普通用户';
  var vipChipClass = 'account-meta-chip';
  if (activeAccountProvider === 'kg') {
    vipLabel = kgAccountVipText(st) || '酷狗账号';
    if (hasProviderVip('kg', st)) vipChipClass += ' vip kg';
  } else if (activeAccountProvider === 'netease') {
    var neVipLevel = providerVipLevel('netease', st);
    vipLabel = neVipLevel === 'svip' ? '网易云 SVIP' : (neVipLevel === 'vip' ? '网易云 VIP' : '普通用户');
    if (hasProviderVip('netease', st)) vipChipClass += ' vip';
  } else {
    vipLabel = hasProviderVip('qq', st) ? 'QQ VIP 会员' : 'QQ 音乐会话';
    if (hasProviderVip('qq', st)) vipChipClass += ' vip qq';
  }
  if (uidChip) uidChip.textContent = uidText;
  if (vipChip) {
    vipChip.textContent = vipLabel;
    vipChip.className = vipChipClass;
  }
  if (vipEl) vipEl.textContent = uidText + '  ·  ' + vipLabel;
  var loggedCount = loggedPlatformCount();
  if (summaryCount) summaryCount.textContent = '已登录 ' + loggedCount + ' / 3 个平台';
  if (summaryMode) {
    summaryMode.textContent = dualAccountMode
      ? '多平台并排展示'
      : (loggedCount >= 2 ? '可启用多平台展示' : '单账号视图');
  }
  if (vipPill) {
    var level = providerVipLevel(activeAccountProvider, st);
    if (hasProviderVip(activeAccountProvider, st)) {
      vipPill.hidden = false;
      vipPill.className = 'account-vip-pill' + (activeAccountProvider === 'qq' ? ' qq' : (activeAccountProvider === 'kg' ? ' kg' : ''));
      vipPill.textContent = activeAccountProvider === 'qq' ? 'QQ VIP' : (activeAccountProvider === 'kg'
        ? ((st && st.vipLabel && st.vipLabel !== '非VIP') ? st.vipLabel : '酷狗 VIP')
        : (level === 'svip' ? 'SVIP' : 'VIP'));
    } else {
      vipPill.hidden = true;
      vipPill.textContent = '';
    }
  }
  ['netease', 'qq', 'kg'].forEach(function (key) {
    var logged = hasPlatformLogin(key);
    var statusEl = document.querySelector('[data-account-status="' + key + '"]');
    var stateEl = document.querySelector('[data-account-state="' + key + '"]');
    var stKey = platformStatus(key);
    if (statusEl) statusEl.textContent = logged ? ((stKey && stKey.nickname) || '已登录') : '点击登录';
    if (stateEl) stateEl.classList.toggle('on', logged);
  });
  var dualState = document.querySelector('.account-platform-state.dual');
  if (dualState) dualState.classList.toggle('on', !!dualAccountMode);
  ['netease','qq','kg','both'].forEach(function(key){
    var btn = document.getElementById('user-provider-' + key);
    if (!btn) return;
    var active = key === 'both' ? dualAccountMode : (!dualAccountMode && activeAccountProvider === key);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (addNetease) {
    addNetease.classList.toggle('is-hidden', hasPlatformLogin('netease'));
    addNetease.style.display = hasPlatformLogin('netease') ? 'none' : '';
  }
  if (addQQ) {
    addQQ.classList.toggle('is-hidden', hasPlatformLogin('qq'));
    addQQ.style.display = hasPlatformLogin('qq') ? 'none' : '';
    addQQ.textContent = '补登 QQ 音乐';
  }
  if (addKG) {
    addKG.classList.toggle('is-hidden', hasPlatformLogin('kg'));
    addKG.style.display = hasPlatformLogin('kg') ? 'none' : '';
  }
  if (logoutBtn) logoutBtn.textContent = activeAccountProvider === 'qq' ? '退出 QQ 音乐' : (activeAccountProvider === 'kg' ? '退出酷狗音乐' : '退出网易云');
  if (hint) {
    var loggedCount = ['netease', 'qq', 'kg'].filter(hasPlatformLogin).length;
    if (dualAccountMode) hint.textContent = '右上角已并排展示已登录平台。再点平台卡片可切回单账号视图。';
    else if (loggedCount >= 2) hint.textContent = '已登录 ' + loggedCount + ' 个平台。点「多平台展示」可在右上角并排显示。';
    else hint.textContent = '切换平台可查看对应账号；未登录的平台会进入登录流程，完成后回到账号中心。';
  }
}
function showUserModal() {
  if (!hasAnyPlatformLogin()) return showLoginModal({ source: 'account-empty' });
  var refresh = Promise.resolve();
  if (hasPlatformLogin('kg')) refresh = refreshKGLoginStatus();
  else if (hasPlatformLogin('qq')) refresh = refreshQQLoginStatus();
  else if (hasPlatformLogin('netease')) refresh = refreshLoginStatus(true);
  if (mineradioUsesWebMediaBridge()) refresh = refresh.then(function(){ return refreshBridgeExtensionWatch(false); });
  refresh.finally(function(){
    updateUserModalUi();
    openGsapModal(document.getElementById('user-modal'));
  });
}
function closeUserModal(opts) {
  opts = opts || {};
  closeGsapModal(document.getElementById('user-modal'));
}
function openAccountThemePicker() {
  closeUserModal({ silent: true });
  if (typeof setFxPanelTab === 'function') setFxPanelTab('appearance');
  if (typeof toggleFxPanel === 'function') toggleFxPanel(true);
  else if (typeof setPeek === 'function') {
    var panel = document.getElementById('fx-panel');
    if (panel) setPeek(panel, true, 'fx');
  }
  showToast('已打开外观主题');
}
function setActiveAccountProvider(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
  if (!hasPlatformLogin(provider)) {
    openProviderLogin(provider);
    return;
  }
  activeAccountProvider = provider;
  dualAccountMode = false;
  persistAccountPreferences();
  renderUserBtn();
  updateUserModalUi();
}
function loggedPlatformCount() {
  return ['netease', 'qq', 'kg'].filter(hasPlatformLogin).length;
}
function enableDualAccountView() {
  if (loggedPlatformCount() < 2) {
    var missing = !hasPlatformLogin('netease') ? 'netease' : (!hasPlatformLogin('qq') ? 'qq' : 'kg');
    showToast('再登录一个平台后可启用多平台展示');
    openProviderLogin(missing);
    return;
  }
  dualAccountMode = true;
  persistAccountPreferences();
  renderUserBtn();
  updateUserModalUi();
  showToast('已启用多平台账号展示');
}
function requestDualLoginMode() {
  enableDualAccountView();
}
function openProviderLogin(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kg' ? 'kg' : 'netease');
  showLoginModal({ provider: provider, returnToAccount: hasAnyPlatformLogin(), source: 'account-add' });
}
async function logoutActiveAccount() {
  if (activeAccountProvider === 'kg') {
    await finalizeProviderLogout('kg', { toast: '已退出酷狗音乐' });
    return;
  }
  if (activeAccountProvider === 'qq') {
    await finalizeProviderLogout('qq', { toast: '已退出 QQ 音乐' });
    return;
  }
  await finalizeProviderLogout('netease', { toast: '已退出网易云' });
}
async function doLogout() {
  await finalizeProviderLogout('netease', { silent: true });
  showToast('已退出网易云');
}
var startupLoginGuideShown = false;
var loginGuideAnimating = false;
var loginGuideRaf = null;
function runLoginGuideParticles(done) {
  var canvas = document.getElementById('login-guide-canvas');
  // 手机端跳过全屏粒子引导，避免 canvas/合成层黑闪
  if (!canvas || reduceSplashMotion || isPhoneShellUi()) {
    if (done) setTimeout(done, 40);
    return;
  }
  if (loginGuideAnimating) {
    if (done) setTimeout(done, 720);
    return;
  }
  loginGuideAnimating = true;
  document.body.classList.add('login-guide-active');
  var ctx = canvas.getContext('2d');
  var dpr = Math.min(window.devicePixelRatio || 1, 1.8);
  var w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  var cx = w * 0.5;
  var cy = h * 0.5 - 10;
  var maxR = Math.max(w, h);
  var particles = [];
  for (var i = 0; i < 92; i++) {
    var ang = Math.random() * Math.PI * 2;
    var ring = maxR * (0.30 + Math.random() * 0.35);
    var arcBias = Math.random() < 0.42 ? Math.PI * 0.5 : 0;
    particles.push({
      sx: cx + Math.cos(ang + arcBias) * ring + (Math.random() - 0.5) * 80,
      sy: cy + Math.sin(ang) * ring * 0.72 + (Math.random() - 0.5) * 80,
      tx: cx + (Math.random() - 0.5) * 172,
      ty: cy + (Math.random() - 0.5) * 172,
      r: 0.8 + Math.random() * 1.9,
      delay: Math.random() * 0.22,
      hue: Math.random(),
      spin: Math.random() * Math.PI * 2
    });
  }
  var started = performance.now();
  var duration = 1050;
  if (loginGuideRaf) cancelAnimationFrame(loginGuideRaf);
  function draw(now) {
    var raw = Math.min(1, (now - started) / duration);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    var centerPulse = Math.sin(Math.PI * raw);
    var halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.28);
    halo.addColorStop(0, 'rgba(255,255,255,' + (0.060 * centerPulse) + ')');
    halo.addColorStop(0.55, 'rgba(255,255,255,' + (0.026 * centerPulse) + ')');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    for (var j = 0; j < particles.length; j++) {
      var p = particles[j];
      var lt = Math.max(0, Math.min(1, (raw - p.delay) / (1 - p.delay)));
      var e = 1 - Math.pow(1 - lt, 3);
      var wobble = Math.sin(lt * Math.PI * 2 + p.spin) * (1 - lt) * 18;
      var x = p.sx + (p.tx - p.sx) * e + Math.cos(p.spin) * wobble;
      var y = p.sy + (p.ty - p.sy) * e + Math.sin(p.spin) * wobble * 0.6;
      var alpha = Math.sin(Math.PI * lt) * (0.18 + p.hue * 0.18);
      if (alpha <= 0) continue;
      var warm = false;
      ctx.beginPath();
      ctx.arc(x, y, p.r * (0.75 + lt * 0.45), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.fill();
      if (lt > 0.08 && lt < 0.92) {
        var tx = p.sx + (p.tx - p.sx) * Math.max(0, e - 0.045);
        var ty = p.sy + (p.ty - p.sy) * Math.max(0, e - 0.045);
        ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * 0.20) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    if (raw < 1) {
      loginGuideRaf = requestAnimationFrame(draw);
    } else {
      function finish() {
        ctx.clearRect(0, 0, w, h);
        document.body.classList.remove('login-guide-active');
        loginGuideAnimating = false;
        loginGuideRaf = null;
        if (done) done();
      }
      if (window.gsap) {
        window.gsap.to(canvas, { opacity: 0, duration: 0.28, ease: 'power2.out', onComplete: function(){
          finish();
          window.gsap.set(canvas, { clearProps: 'opacity' });
        }});
      } else {
        finish();
      }
    }
  }
  loginGuideRaf = requestAnimationFrame(draw);
}
function maybeRunStartupLoginGuide(source) {
  if (startupLoginGuideShown || loginGuideAnimating) return;
  if (visualGuideActive) return;
  if (document.body.classList.contains('splash-active')) return;
  if (immersiveMode) return;
  if (!loginStatusChecked || loginStatusCheckFailed || loginStatus.loggedIn || playing) return;
  var loginModal = document.getElementById('login-modal');
  var userModal = document.getElementById('user-modal');
  if ((loginModal && loginModal.classList.contains('show')) || (userModal && userModal.classList.contains('show'))) return;
  startupLoginGuideShown = true;
  setTimeout(function(){
    if (loginStatus.loggedIn || playing || immersiveMode || document.body.classList.contains('splash-active')) return;
    runLoginGuideParticles(function(){ showLoginModal({ guided: true, source: source || 'startup' }); });
  }, source === 'splash' ? 6200 : 2600);
}
window.addEventListener('pagehide', function() { writePlaybackSession(); });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restorePlaybackSession);
} else {
  restorePlaybackSession();
}

