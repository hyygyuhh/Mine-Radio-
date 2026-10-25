/* Listening-pet skins: vendored open assets + crawl configs.
   See licenses/ListeningPet-NOTICE.txt for attribution. */
(function (global) {
  'use strict';

  var SKINS = {
    clawd: {
      id: 'clawd',
      name: '像素爪爪',
      tag: 'Clawd Pets · MIT',
      kind: 'img',
      idleSrc: 'assets/pets/clawd-happy.svg',
      moveSrc: 'assets/pets/clawd-dancing.svg',
      reactSrc: 'assets/pets/clawd-love.svg',
      size: 64
    },
    panda: {
      id: 'panda',
      name: '爬行熊猫',
      tag: 'OGA Panda · CC-BY-SA',
      kind: 'sheet',
      src: 'assets/pets/panda-crawl.png',
      frameW: 32,
      frameH: 32,
      frames: 3,
      scale: 2,
      frameMs: 110,
      pixelated: true,
      crawl: true
    },
    cat: {
      id: 'cat',
      name: '橘猫',
      tag: 'LPC Cats · CC-BY',
      kind: 'sheet',
      src: 'assets/pets/cat-walk.png',
      frameW: 32,
      frameH: 32,
      frames: 3,
      scale: 2,
      frameMs: 110,
      pixelated: true,
      crawl: true
    },
    dog: {
      id: 'dog',
      name: '金毛',
      tag: 'LPC Dogs · CC-BY',
      kind: 'sheet',
      src: 'assets/pets/dog-walk.png',
      frameW: 32,
      frameH: 32,
      frames: 3,
      scale: 2,
      frameMs: 110,
      pixelated: true,
      crawl: true
    },
    fox: {
      id: 'fox',
      name: '赤狐',
      tag: 'ScratchIO Fox · CC0',
      kind: 'sheet',
      src: 'assets/pets/fox-walk.png',
      idleSrc: 'assets/pets/fox-idle.png',
      frameW: 64,
      frameH: 36,
      frames: 8,
      idleFrames: 6,
      scale: 1.5,
      frameMs: 85,
      idleFrameMs: 180,
      mirror: true,
      pixelated: true,
      crawl: true
    },
    rabbit: {
      id: 'rabbit',
      name: '褐兔',
      tag: 'ScratchIO Rabbit · CC0',
      kind: 'sheet',
      src: 'assets/pets/rabbit-run.png',
      idleSrc: 'assets/pets/rabbit-idle.png',
      frameW: 32,
      frameH: 26,
      frames: 6,
      idleFrames: 10,
      scale: 2,
      frameMs: 85,
      idleFrameMs: 160,
      mirror: true,
      pixelated: true,
      crawl: true
    }
  };

  var ORDER = ['clawd', 'panda', 'cat', 'dog', 'fox', 'rabbit'];

  function sheetMetrics(skin, mode) {
    var scale = skin.scale || 1;
    var fw = skin.frameW;
    var fh = skin.frameH;
    var wantIdle = (mode === 'idle') && skin.idleSrc;
    var frames = wantIdle ? (skin.idleFrames || skin.frames || 3) : (skin.frames || 3);
    var src = wantIdle ? skin.idleSrc : skin.src;
    var frameMs = wantIdle ? (skin.idleFrameMs || 160) : (skin.frameMs || 120);
    return {
      src: src,
      frames: frames,
      frameMs: frameMs,
      mode: wantIdle ? 'idle' : 'walk',
      vw: Math.round(fw * scale),
      vh: Math.round(fh * scale),
      imgW: Math.round(fw * frames * scale),
      imgH: Math.round(fh * scale),
      step: Math.round(fw * scale)
    };
  }

  function renderHtml(skin, mode) {
    if (!skin) skin = SKINS.clawd;
    if (skin.kind === 'sheet') {
      var m = sheetMetrics(skin, mode || 'idle');
      var cls = 'pet-asset pet-sheet-view' + (skin.pixelated === false ? '' : ' is-pixel') +
        ' pet-sheet-' + skin.id;
      return '<span class="' + cls + '" style="width:' + m.vw + 'px;height:' + m.vh + 'px">' +
        '<img class="pet-sheet-img" src="' + m.src + '" alt="" draggable="false"' +
        ' data-ps-step="' + m.step + '"' +
        ' data-ps-frames="' + m.frames + '"' +
        ' data-ps-ms="' + m.frameMs + '"' +
        ' data-ps-mode="' + m.mode + '"' +
        ' style="width:' + m.imgW + 'px;height:' + m.imgH + 'px;transform:translate(0,0)">' +
        '</span>';
    }
    var src = skin.idleSrc;
    var size = skin.size || 64;
    return '<img class="pet-asset pet-asset-img" src="' + src + '" width="' + size + '" height="' + size + '" alt="" draggable="false">';
  }

  /* Returns true when strip/src switched (caller should reset frame clock). */
  function applySheetMode(img, skin, mode) {
    if (!img || !skin || skin.kind !== 'sheet') return false;
    var m = sheetMetrics(skin, mode === 'walk' || mode === 'move' ? 'walk' : 'idle');
    var cur = img.getAttribute('data-ps-mode') || '';
    if (cur === m.mode && img.getAttribute('src') === m.src) {
      img.setAttribute('data-ps-ms', String(m.frameMs));
      img.setAttribute('data-ps-frames', String(m.frames));
      return false;
    }
    img.src = m.src;
    img.style.width = m.imgW + 'px';
    img.style.height = m.imgH + 'px';
    img.setAttribute('data-ps-step', String(m.step));
    img.setAttribute('data-ps-frames', String(m.frames));
    img.setAttribute('data-ps-ms', String(m.frameMs));
    img.setAttribute('data-ps-mode', m.mode);
    paintSheetFrame(img, 0);
    return true;
  }

  function paintSheetFrame(img, frameIndex) {
    if (!img || !img.getAttribute) return;
    var step = Number(img.getAttribute('data-ps-step')) || 0;
    var frames = Number(img.getAttribute('data-ps-frames')) || 1;
    var i = ((frameIndex % frames) + frames) % frames;
    img.style.transform = 'translate(' + (-i * step) + 'px,0)';
    img.setAttribute('data-ps-frame', String(i));
  }

  global.MineradioListeningPetSkins = {
    list: ORDER.map(function (id) { return SKINS[id]; }),
    get: function (id) { return SKINS[id] || SKINS.clawd; },
    has: function (id) { return !!SKINS[id]; },
    ids: ORDER.slice(),
    renderHtml: renderHtml,
    paintSheetFrame: paintSheetFrame,
    applySheetMode: applySheetMode
  };
})(window);
