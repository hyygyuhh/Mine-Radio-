(function (global) {
  'use strict';

  var STORE_KEY = 'mineradio-listening-pet-v1';
  var SKIN_KEY = 'mineradio-listening-pet-skin-v1';
  var AFFECTION_KEY = 'mineradio-listening-pet-affection-v1';
  var BEAT_FLASH_MS = 150;
  var TRACK_FLASH_MS = 480;
  var REACT_MS = 900;
  var BUBBLE_MS = 2200;
  var BEAT_THRESHOLD = 0.4;

  var LINES = {
    pet: ['摸摸头～', '好舒服！', '再摸一下！', '哼哼～', '爱你哟'],
    dance: ['跟我摇！', '鼓点来了！', '嗨起来～', '这拍子真带劲'],
    track: ['换歌啦！', '下一首走起', '耳朵准备好～'],
    idle: ['困困的…', '先歇会儿', '等你开歌'],
    tip: ['点我互动', '我会沿进度爬', '双击看亲密度'],
    skin: ['换装完成！', '新伙伴报到', '喜欢这只吗？']
  };

  var enabled = true;
  var skinId = 'clawd';
  var visualState = 'idle';
  var affection = 0;
  var el = null;
  var hostEl = null;
  var bubbleEl = null;
  var toggleEl = null;
  var skinSeg = null;
  var lastTrackKey = '';
  var lastBeat = 0;
  var lastProgress = 0;
  var faceDir = 1;
  var beatUntil = 0;
  var trackUntil = 0;
  var reactUntil = 0;
  var bubbleUntil = 0;
  var stateClass = 'is-idle';
  var moodClass = 'mood-chill';
  var ready = false;
  var clickCount = 0;
  var lastClickAt = 0;
  var sheetImg = null;
  var sheetFrame = 0;
  var sheetLastMs = 0;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)] || '';
  }

  function readEnabled() {
    try {
      if (typeof readBooleanPreference === 'function') return readBooleanPreference(STORE_KEY, true);
      var raw = localStorage.getItem(STORE_KEY);
      if (raw === null || raw === '') return true;
      return raw === '1' || raw === 'true';
    } catch (_) {
      return true;
    }
  }

  function writeEnabled(on) {
    try {
      if (typeof saveBooleanPreference === 'function') saveBooleanPreference(STORE_KEY, !!on);
      else localStorage.setItem(STORE_KEY, on ? '1' : '0');
    } catch (_) {}
  }

  function readSkinId() {
    try {
      var id = localStorage.getItem(SKIN_KEY) || 'clawd';
      var skins = global.MineradioListeningPetSkins;
      if (skins && skins.has && skins.has(id)) return id;
    } catch (_) {}
    return 'clawd';
  }

  function writeSkinId(id) {
    try { localStorage.setItem(SKIN_KEY, String(id || 'clawd')); } catch (_) {}
  }

  function readAffection() {
    try {
      var n = Number(localStorage.getItem(AFFECTION_KEY));
      return isFinite(n) ? Math.max(0, Math.min(999, Math.floor(n))) : 0;
    } catch (_) {
      return 0;
    }
  }

  function writeAffection(n) {
    affection = Math.max(0, Math.min(999, Math.floor(n)));
    try { localStorage.setItem(AFFECTION_KEY, String(affection)); } catch (_) {}
  }

  function bumpAffection(delta) {
    writeAffection(affection + (delta || 1));
  }

  function currentTrackKey() {
    try {
      if (typeof currentIdx === 'number' && currentIdx >= 0 && Array.isArray(playQueue) && playQueue[currentIdx]) {
        var song = playQueue[currentIdx];
        return String(song.id || song.mid || song.hash || song.name || currentIdx);
      }
    } catch (_) {}
    return '';
  }

  function currentTrackLabel() {
    try {
      if (typeof currentIdx === 'number' && currentIdx >= 0 && Array.isArray(playQueue) && playQueue[currentIdx]) {
        var song = playQueue[currentIdx];
        var name = song.name || '未知歌曲';
        var artist = song.artist || '';
        return artist ? (name + ' · ' + artist) : name;
      }
    } catch (_) {}
    return '';
  }

  function syncToggleUi() {
    if (!toggleEl) toggleEl = document.getElementById('t-listeningPet');
    if (toggleEl) toggleEl.classList.toggle('active', !!enabled);
  }

  function syncSkinSeg() {
    if (!skinSeg) skinSeg = document.getElementById('listening-pet-skin-seg');
    if (!skinSeg) return;
    var buttons = skinSeg.querySelectorAll('[data-pet-skin]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-pet-skin') === skinId);
    }
  }

  function applyMountVisibility() {
    if (!el) return;
    if (!enabled) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      return;
    }
    el.hidden = false;
    el.removeAttribute('aria-hidden');
  }

  function bindSheetImg() {
    sheetImg = hostEl ? hostEl.querySelector('.pet-sheet-img') : null;
    sheetFrame = 0;
    sheetLastMs = 0;
    var skins = global.MineradioListeningPetSkins;
    if (sheetImg && skins && skins.paintSheetFrame) skins.paintSheetFrame(sheetImg, 0);
  }

  function tickSheetWalk(t, crawling) {
    var skins = global.MineradioListeningPetSkins;
    if (!sheetImg || !skins || !skins.paintSheetFrame) return;
    var skin = skins.get(skinId);
    var mode = crawling ? 'walk' : 'idle';
    /* Fox/rabbit have idle strips; others keep walk strip but freeze / slow-fidget */
    if (skins.applySheetMode && skin && skin.kind === 'sheet') {
      var switched = skins.applySheetMode(sheetImg, skin, mode);
      if (switched) {
        sheetFrame = 0;
        sheetLastMs = t;
      }
    }
    var hasIdleStrip = !!(skin && skin.idleSrc);
    /* Always animate sheet skins: walk while playing; idle strip or slow 2-frame fidget when paused */
    var ms = Number(sheetImg.getAttribute('data-ps-ms')) || 120;
    var frames = Number(sheetImg.getAttribute('data-ps-frames')) || 3;
    if (!crawling && !hasIdleStrip) {
      ms = Math.max(ms * 2.2, 260);
      frames = Math.min(frames, 2);
    }
    if (!sheetLastMs) sheetLastMs = t;
    if (t - sheetLastMs >= ms) {
      var steps = Math.max(1, Math.floor((t - sheetLastMs) / ms));
      sheetLastMs += steps * ms;
      sheetFrame = (sheetFrame + steps) % frames;
      skins.paintSheetFrame(sheetImg, sheetFrame);
    }
  }

  function paintHost(state) {
    var skins = global.MineradioListeningPetSkins;
    if (!skins || !hostEl) return;
    var skin = skins.get(skinId);
    visualState = state || 'idle';
    if (skin && skin.kind === 'sheet') {
      /* Keep the same DOM so JS walk frames are not reset every mood flip */
      if (!sheetImg || !hostEl.contains(sheetImg)) {
        hostEl.innerHTML = skins.renderHtml(skin);
        bindSheetImg();
      }
    } else if (skin && skin.kind === 'img') {
      var src = skin.idleSrc;
      if (visualState === 'move' && skin.moveSrc) src = skin.moveSrc;
      if (visualState === 'react' && skin.reactSrc) src = skin.reactSrc;
      hostEl.innerHTML = '<img class="pet-asset pet-asset-img" src="' + src + '" width="' + (skin.size || 64) + '" height="' + (skin.size || 64) + '" alt="" draggable="false">';
      sheetImg = null;
    } else {
      hostEl.innerHTML = skins.renderHtml(skin);
      bindSheetImg();
    }
    if (el) {
      el.classList.toggle('skin-sheet', !!(skin && skin.kind === 'sheet'));
      el.classList.toggle('skin-img', !!(skin && skin.kind === 'img'));
      el.classList.remove('skin-legacy');
      el.style.setProperty('--pet-face-base', skin && skin.mirror ? '-1' : '1');
    }
  }

  function renderSkin(id, opts) {
    opts = opts || {};
    var skins = global.MineradioListeningPetSkins;
    var skin = skins ? skins.get(id) : null;
    if (!skin || !hostEl) return;
    skinId = skin.id;
    writeSkinId(skinId);
    sheetImg = null;
    hostEl.innerHTML = '';
    paintHost(visualState === 'move' ? 'move' : 'idle');
    if (el) {
      el.setAttribute('data-pet-skin', skinId);
      el.setAttribute('aria-label', '听歌宠物 ' + skin.name);
      el.title = skin.name + ' · 点我互动，沿进度爬行';
    }
    syncSkinSeg();
    if (!opts.silent) {
      showBubble(pick(LINES.skin) + ' ' + skin.name, 1800);
      bumpAffection(1);
    }
  }

  function setSkin(id, opts) {
    renderSkin(id, opts || {});
  }

  function setMood(next) {
    if (!el || moodClass === next) return;
    el.classList.remove('mood-chill', 'mood-hype');
    el.classList.add(next);
    moodClass = next;
  }

  function setStateClass(next) {
    if (!el) return;
    var prev = stateClass;
    if (prev === next) return;
    el.classList.remove('is-idle', 'is-listening', 'is-beat', 'is-track', 'is-react', 'is-crawl');
    el.classList.add(next);
    if (next === 'is-listening' || next === 'is-beat' || next === 'is-react') el.classList.add('is-crawl');
    stateClass = next;

    var want = 'idle';
    if (next === 'is-react') want = 'react';
    else if (next === 'is-listening' || next === 'is-beat' || next === 'is-track') want = 'move';
    if (want !== visualState) paintHost(want);
  }

  function showBubble(text, ms) {
    if (!bubbleEl) return;
    text = String(text || '').trim();
    if (!text) return;
    bubbleEl.textContent = text;
    bubbleEl.hidden = false;
    bubbleUntil = nowMs() + (ms || BUBBLE_MS);
  }

  function hideBubbleIfExpired(t) {
    if (!bubbleEl || bubbleEl.hidden) return;
    if (t >= bubbleUntil) bubbleEl.hidden = true;
  }

  function triggerReact(kind) {
    reactUntil = nowMs() + REACT_MS;
    paintHost('react');
    setStateClass('is-react');
    bumpAffection(1);
    if (kind === 'dance') showBubble(pick(LINES.dance));
    else if (kind === 'track') showBubble(pick(LINES.track));
    else if (kind === 'idle') showBubble(pick(LINES.idle));
    else showBubble(pick(LINES.pet));
  }

  function handleTap(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    var t = nowMs();
    try {
      if (typeof revealBottomControls === 'function') revealBottomControls(2600);
    } catch (_) {}

    if (t - lastClickAt < 320) clickCount += 1;
    else clickCount = 1;
    lastClickAt = t;

    if (clickCount >= 2) {
      clickCount = 0;
      showBubble('亲密度 Lv.' + Math.min(99, 1 + Math.floor(affection / 8)), 2600);
      triggerReact('pet');
      if (typeof showToast === 'function') showToast('亲密度 ' + affection);
      return;
    }

    var playingNow = false;
    try { playingNow = !!(typeof audio !== 'undefined' && audio && !audio.paused); } catch (_) {}
    if (playingNow) triggerReact('dance');
    else triggerReact('pet');

    var label = currentTrackLabel();
    if (label && affection > 0 && affection % 5 === 0 && typeof showToast === 'function') {
      showToast(label);
    }
  }

  function setEnabled(on, opts) {
    opts = opts || {};
    enabled = !!on;
    writeEnabled(enabled);
    syncToggleUi();
    applyMountVisibility();
    if (!opts.silent && typeof showToast === 'function') {
      showToast(enabled ? '听歌宠物已开启' : '听歌宠物已关闭');
    }
  }

  function toggleEnabled() {
    setEnabled(!enabled);
  }

  function applyProgress(progress, playing) {
    progress = Math.max(0, Math.min(1, Number(progress) || 0));
    if (progress > lastProgress + 0.002) faceDir = 1;
    else if (progress < lastProgress - 0.002) faceDir = -1;
    lastProgress = progress;
    if (!el) return;
    el.style.setProperty('--pet-progress', String(progress));
    el.style.setProperty('--pet-face', String(faceDir));
    el.classList.toggle('is-moving', !!(playing && progress > 0 && progress < 0.999));
  }

  function tick(motion) {
    if (!ready || !enabled || !el || el.hidden) return;
    motion = motion || {};
    var beat = Number(motion.beat) || 0;
    var bass = Number(motion.bass) || 0;
    var playing = !!motion.playing;
    var progress = Number(motion.progress);
    if (!isFinite(progress)) {
      progress = 0;
      try {
        if (typeof audio !== 'undefined' && audio && audio.duration > 0) {
          progress = audio.currentTime / audio.duration;
        }
      } catch (_) {}
    }
    var t = nowMs();

    el.style.setProperty('--pet-beat', String(Math.max(0, Math.min(1.4, beat))));
    el.style.setProperty('--pet-bass', String(Math.max(0, Math.min(1.2, bass))));
    applyProgress(progress, playing);

    var energy = Math.max(beat, bass);
    if (playing && energy > 0.55) setMood('mood-hype');
    else setMood('mood-chill');

    var trackKey = currentTrackKey();
    if (trackKey && trackKey !== lastTrackKey) {
      lastTrackKey = trackKey;
      trackUntil = t + TRACK_FLASH_MS;
      showBubble(pick(LINES.track), 1600);
    }

    if (playing && beat > BEAT_THRESHOLD && beat > lastBeat + 0.07) {
      beatUntil = t + BEAT_FLASH_MS;
    }
    lastBeat = beat;
    hideBubbleIfExpired(t);

    if (t < reactUntil) setStateClass('is-react');
    else if (t < trackUntil) setStateClass('is-track');
    else if (t < beatUntil) setStateClass('is-beat');
    else if (playing && trackKey) setStateClass('is-listening');
    else setStateClass('is-idle');

    /* Walk / idle strips for sheet skins; clawd uses SVG swap via paintHost */
    tickSheetWalk(t, !!playing);
  }

  function notifyTrackChange() {
    lastTrackKey = '';
    trackUntil = nowMs() + TRACK_FLASH_MS;
    if (el && enabled) {
      setStateClass('is-track');
      showBubble(pick(LINES.track), 1600);
    }
  }

  function buildSkinSeg() {
    skinSeg = document.getElementById('listening-pet-skin-seg');
    if (!skinSeg) return;
    var skins = global.MineradioListeningPetSkins;
    if (!skins) return;
    skinSeg.innerHTML = '';
    skins.list.forEach(function (skin) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pet-skin', skin.id);
      btn.textContent = skin.name;
      btn.title = skin.tag || skin.name;
      btn.addEventListener('click', function () {
        setSkin(skin.id);
      });
      skinSeg.appendChild(btn);
    });
    syncSkinSeg();
  }

  function init() {
    el = document.getElementById('listening-pet');
    hostEl = el ? el.querySelector('.pet-skin-host') : null;
    bubbleEl = el ? el.querySelector('.pet-bubble') : null;
    toggleEl = document.getElementById('t-listeningPet');
    if (!el || !hostEl) return;
    enabled = readEnabled();
    affection = readAffection();
    skinId = readSkinId();
    syncToggleUi();
    buildSkinSeg();
    renderSkin(skinId, { silent: true });
    applyMountVisibility();
    el.addEventListener('click', handleTap);
    ready = true;
    if (enabled) {
      setTimeout(function () {
        if (enabled && el && !el.hidden) showBubble(pick(LINES.tip), 2400);
      }, 1600);
    }
  }

  global.MineradioListeningPet = {
    init: init,
    tick: tick,
    setEnabled: setEnabled,
    setSkin: setSkin,
    getSkin: function () { return skinId; },
    isEnabled: function () { return !!enabled; },
    getAffection: function () { return affection; },
    notifyTrackChange: notifyTrackChange,
    toggle: toggleEnabled
  };

  global.toggleListeningPet = function () { toggleEnabled(); };
  global.setListeningPetSkin = function (id) { setSkin(id); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
