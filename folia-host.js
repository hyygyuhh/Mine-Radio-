(function (global) {
  'use strict';

  // Full-screen Folia lyric stage host for Mine-Radio.
  // Folia runs in an iframe covering the viewport (like Folia's own player),
  // not as a tweak to the existing Three.js page lyrics.

  var HOST_SOURCE = 'mineradio-host';
  var EMBED_SOURCE = 'folia-embed';
  var STORE_KEY = 'mineradio-folia-stage-v1';

  var FOLIA_MODES = [
    { id: 'off', label: '关闭', desc: '使用页面歌词' },
    { id: 'classic', label: '流光', desc: '逐字呼吸与漂浮' },
    { id: 'cadenza', label: '心象', desc: '大字沉浸主唱' },
    { id: 'partita', label: '云阶', desc: '语义错位阶梯' },
    { id: 'tilt', label: '倾诉', desc: '斜切分行对白' },
    { id: 'fume', label: '浮名', desc: '几何雾面舞台' },
    { id: 'cappella', label: '群唱', desc: '表情与合唱感' },
    { id: 'claddagh', label: '回环', desc: '椭圆轨道歌词' },
    { id: 'monet', label: '莫奈', desc: '肖像与频谱' },
    { id: 'diorama', label: '镜台', desc: '点云与灵魂光' },
    { id: 'lumiere', label: '绘光', desc: '光束雾场绘影' },
    { id: 'sonnet', label: '商籁', desc: '镜头与装饰字' },
    { id: 'tempera', label: '凝彩', desc: '色块与字形动势' },
    { id: 'pendolo', label: '时计', desc: '钟摆弧线歌词' },
    { id: 'still', label: '静止', desc: '静帧字幕' }
  ];

  var FOLIA_BACKGROUNDS = ['common', 'monet', 'nomand', 'latent', 'sora', 'url'];
  var FOLIA_BG_META = {
    common: { label: '通用', desc: '封面色与几何' },
    monet: { label: '莫奈', desc: '油画景深' },
    nomand: { label: '漫游', desc: '流动漫游面' },
    latent: { label: '隐现', desc: '淡入隐层' },
    sora: { label: '空', desc: '极简空场' },
    url: { label: '自定义', desc: '地址或本地导入' }
  };

  var FOLIA_TUNING_DEFAULTS = {
    classic: { enableWordRotation: true, breathingFloatMultiplier: 1, useLegacyLayout: false, wordSpacing: 0.7 },
    cadenza: { fontScale: 1.12, widthRatio: 0.72, motionAmount: 1, glowIntensity: 1, beamIntensity: 0 },
    partita: { showGuideLines: true, useSemanticLayout: true, staggerMin: 20, staggerMax: 100 },
    tilt: { splitProbability: 0.75, tiltStyleProbability: 0.35, colorScheme: 'default' },
    fume: { hidePrintSymbols: false, disableGeometricBackground: true, backgroundObjectOpacity: 0.5, textHoldRatio: 1, cameraTrackingMode: 'smooth', cameraSpeed: 1, glowIntensity: 1, heroScale: 1 },
    cappella: { showEmoMessages: true, emojiPackSource: 'builtin', avatarSource: 'cover' },
    claddagh: { focusScaleRatio: 0.65, radiusScale: 1, ellipseTiltDeg: 45, showAxisLine: true, letterSpacingOffset: 0 },
    monet: { keywordColoringEnabled: true, showDescription: true, showAudioVisualization: true, audioStyle: 'bar', fontScale: 1.2, portraitSource: 'cover', portraitOffsetX: 0, portraitStyle: 'square', showPortraitDragHanger: true },
    diorama: { cameraSpeed: 1, motionAmount: 1, audioReactivity: 1, geometryVisibility: { enabled: true, mode: 'clouds', strands: true, blobs: true, ribbons: true, rings: true }, particleDensity: 576, particleScale: 1, particleGlowEnabled: true, particleGlowIntensity: 0.65, showParticles: true, backgroundParticleCircumference: 28, backgroundParticleRadial: 2, glowEnabled: true, glowIntensity: 1, soulEnabled: true, soulIntensity: 1, soulActiveEnabled: false, gradientEnabled: false, gradientIntensity: 1, keywordColoringEnabled: true },
    lumiere: { lightIntensity: 1, audioResponse: 1, fogDensity: 1, darkField: 0.75, moteAmount: 1, bloom: 1, textBloom: 1, unlitOpacity: 0.22, windowNeighbors: 2, decay: 1, echo: 1, fogOctaves: 5, lineArt: true, frontBokeh: true, trails: true, hideTrails: false, seamlessTransitions: true, overlayFrame: true, textOnly: false, keywordColors: true, themeIcons: true, themeColorMix: 0.3, renderQuality: 'full' },
    sonnet: { cameraIntensity: 1, typographyMotion: 1, mgDensity: 1, showOnlyText: false, showGuide: true, showBackgroundMg: true, showFixedGeo: true, showGiantDecorativeText: true, showBackgroundDecor: true, enableTransitions: true, outerFrameMode: 'full', textureResolution: 1.5, postProcessEnabled: false, postProcessGrain: 0.2, postProcessContrast: 0, postProcessRgbShift: 0, postProcessHalftone: 0, postProcessVignette: 0.85, postProcessLensDistortion: 0.3, postProcessLensDispersion: 0.6 },
    tempera: { cameraIntensity: 1, glyphMotion: 1, wholeLineLyrics: false, glyphSettleStretch: 0.5, colorMode: 'duo', showBlocks: true, showDecor: true, showCornerMarks: true, textInversion: true, enableTransitions: true, textureResolution: 1.5, postProcessEnabled: true, postProcessGrain: 0.2, postProcessContrast: 0, postProcessRgbShift: 0, postProcessVignette: 0.85, postProcessLensDistortion: 0.3, layerImages: [], layerImageDepth: 'back', layerImageFrequency: 0.6 },
    pendolo: { arcRadius: 0.42, arcAngleDeg: 100, wheelCenterX: 0, wheelCenterY: 0.5, tickSnappiness: 2, activeScale: 1.25, showGearDecor: 'subtle', showCenterGradient: true, showCoverOnWatchFace: false, enableLineGlow: false }
  };

  function rangeField(key, label, min, max, step) {
    return { key: key, label: label, type: 'range', min: min, max: max, step: step };
  }
  function boolField(key, label) {
    return { key: key, label: label, type: 'bool' };
  }
  function choiceField(key, label, options) {
    return { key: key, label: label, type: 'choice', options: options };
  }

  var FOLIA_TUNING_FIELDS = {
    classic: [
      boolField('enableWordRotation', '逐字旋转'),
      choiceField('useLegacyLayout', '排版', [{ v: false, l: '自适应' }, { v: true, l: '旧版' }]),
      rangeField('breathingFloatMultiplier', '呼吸浮动', 0, 2, 0.05),
      rangeField('wordSpacing', '单词间距', 0, 2, 0.05)
    ],
    cadenza: [
      rangeField('fontScale', '字号', 0.6, 1.8, 0.02),
      rangeField('widthRatio', '宽度', 0.4, 1, 0.02),
      rangeField('motionAmount', '动势', 0, 2, 0.05),
      rangeField('glowIntensity', '辉光', 0, 2, 0.05),
      rangeField('beamIntensity', '光束', 0, 2, 0.05)
    ],
    partita: [
      boolField('showGuideLines', '引导线'),
      boolField('useSemanticLayout', '语义排列'),
      rangeField('staggerMin', '错位最小', 0, 180, 1),
      rangeField('staggerMax', '错位最大', 0, 180, 1)
    ],
    tilt: [
      rangeField('splitProbability', '分行概率', 0, 1, 0.01),
      rangeField('tiltStyleProbability', '斜体强调', 0, 1, 0.01),
      choiceField('colorScheme', '配色', [
        { v: 'default', l: '双色1' }, { v: 'swap', l: '双色2' },
        { v: 'accentAll', l: '单色1' }, { v: 'primaryAll', l: '单色2' }
      ])
    ],
    fume: [
      boolField('hidePrintSymbols', '隐藏打印方块'),
      boolField('disableGeometricBackground', '关闭几何背景'),
      choiceField('cameraTrackingMode', '追焦', [{ v: 'smooth', l: '平滑' }, { v: 'stepped', l: '定格' }]),
      rangeField('backgroundObjectOpacity', '背景物体', 0, 1, 0.01),
      rangeField('textHoldRatio', '文字停留', 0.2, 2, 0.05),
      rangeField('cameraSpeed', '镜头速度', 0.2, 2.5, 0.05),
      rangeField('glowIntensity', '辉光', 0, 2, 0.05),
      rangeField('heroScale', '大标题', 0.5, 2, 0.05)
    ],
    cappella: [
      boolField('showEmoMessages', '显示表情包'),
      choiceField('avatarSource', '头像', [
        { v: 'cover', l: '封面' }, { v: 'builtin', l: '内置' }, { v: 'color', l: '色块' }
      ]),
      choiceField('emojiPackSource', '表情来源', [{ v: 'builtin', l: '内置' }, { v: 'custom', l: '自定义' }])
    ],
    claddagh: [
      boolField('showAxisLine', '中间轴线'),
      rangeField('focusScaleRatio', '主歌词放大', 0, 1.5, 0.01),
      rangeField('radiusScale', '轨道半径', 0.5, 1.5, 0.01),
      rangeField('ellipseTiltDeg', '轨道倾斜', 0, 60, 1),
      rangeField('letterSpacingOffset', '字符间距', -0.2, 0.4, 0.01)
    ],
    monet: [
      boolField('keywordColoringEnabled', '关键字着色'),
      boolField('showDescription', '描述'),
      boolField('showAudioVisualization', '音频可视化'),
      choiceField('audioStyle', '音频样式', [{ v: 'bar', l: '柱' }, { v: 'line', l: '线' }]),
      choiceField('portraitSource', '肖像', [{ v: 'cover', l: '封面' }, { v: 'custom', l: '自定义' }]),
      choiceField('portraitStyle', '肖像形状', [{ v: 'square', l: '方' }, { v: 'rectangular', l: '长' }]),
      rangeField('fontScale', '字号', 0.6, 1.8, 0.02)
    ],
    diorama: [
      boolField('showParticles', '点云'),
      boolField('glowEnabled', '辉光跟唱'),
      boolField('soulEnabled', '灵魂出窍'),
      boolField('soulActiveEnabled', '当前字出窍'),
      boolField('gradientEnabled', '渐变跟唱'),
      boolField('keywordColoringEnabled', '关键字着色'),
      rangeField('cameraSpeed', '镜头速度', 0, 2, 0.05),
      rangeField('motionAmount', '运动幅度', 0, 2, 0.05),
      rangeField('audioReactivity', '音频响应', 0, 2, 0.05),
      rangeField('glowIntensity', '辉光强度', 0, 2, 0.05),
      rangeField('soulIntensity', '出窍强度', 0, 2, 0.05),
      rangeField('gradientIntensity', '渐变强度', 0, 2, 0.05)
    ],
    lumiere: [
      choiceField('renderQuality', '画质', [
        { v: 'full', l: '全分辨率' }, { v: 'balanced', l: '均衡' }, { v: 'low', l: '省电' }
      ]),
      choiceField('windowNeighbors', '邻行', [{ v: 1, l: '上一行' }, { v: 2, l: '上下行' }]),
      boolField('lineArt', '线稿'),
      boolField('frontBokeh', '前景散景'),
      boolField('overlayFrame', '画框'),
      boolField('textOnly', '仅歌词'),
      boolField('keywordColors', '关键字着色'),
      boolField('themeIcons', '主题图标'),
      boolField('trails', '轨迹换位'),
      boolField('hideTrails', '隐藏轨迹线'),
      boolField('seamlessTransitions', '轨迹过渡'),
      rangeField('lightIntensity', '光强', 0.3, 2, 0.05),
      rangeField('audioResponse', '随音乐变亮', 0, 2, 0.05),
      rangeField('bloom', '图形辉光', 0, 2, 0.05),
      rangeField('textBloom', '文字辉光', 0, 2, 0.05),
      rangeField('darkField', '暗场', 0, 1, 0.01),
      rangeField('fogDensity', '烟雾', 0, 2, 0.05),
      rangeField('fogOctaves', '烟雾细节', 2, 6, 1),
      rangeField('moteAmount', '浮尘', 0, 2, 0.05),
      rangeField('unlitOpacity', '未唱字', 0.05, 0.6, 0.01),
      rangeField('decay', '崩解', 0, 2, 0.05),
      rangeField('echo', '背景歌词', 0, 2, 0.05),
      rangeField('themeColorMix', '主题色占比', 0, 1, 0.01)
    ],
    sonnet: [
      choiceField('outerFrameMode', '外层边框', [
        { v: 'none', l: '隐藏' }, { v: 'frame', l: '框架' }, { v: 'full', l: '完整' }
      ]),
      boolField('showOnlyText', '仅文字'),
      boolField('showGuide', '轨迹线'),
      boolField('showBackgroundMg', '主场景'),
      boolField('showFixedGeo', '文字浮标'),
      boolField('showGiantDecorativeText', '巨型装饰字'),
      boolField('showBackgroundDecor', '背景装饰'),
      boolField('enableTransitions', '场景转场'),
      boolField('postProcessEnabled', '后处理'),
      rangeField('cameraIntensity', '镜头运动', 0, 2, 0.05),
      rangeField('typographyMotion', '文字动势', 0, 2, 0.05),
      rangeField('mgDensity', '短线密度', 0, 2, 0.05),
      rangeField('textureResolution', '纹理分辨率', 1, 2, 0.1),
      rangeField('postProcessGrain', '胶片颗粒', 0, 1, 0.01),
      rangeField('postProcessContrast', '对比度', 0, 1, 0.01),
      rangeField('postProcessRgbShift', 'RGB 色差', 0, 1, 0.01),
      rangeField('postProcessHalftone', '半调网点', 0, 1, 0.01),
      rangeField('postProcessVignette', '暗角', 0, 2, 0.05),
      rangeField('postProcessLensDistortion', '透镜扭曲', 0, 2, 0.05),
      rangeField('postProcessLensDispersion', '透镜色散', 0, 1, 0.01)
    ],
    tempera: [
      choiceField('colorMode', '色彩', [
        { v: 'duo', l: '主题双色' }, { v: 'mono', l: '黑白灰' }, { v: 'gradient', l: '封面渐变' }
      ]),
      boolField('wholeLineLyrics', '整句显示'),
      boolField('showBlocks', '色块场景'),
      boolField('showDecor', '装饰元素'),
      boolField('showCornerMarks', '边角线框'),
      boolField('textInversion', '文字反色'),
      boolField('enableTransitions', '场景转场'),
      boolField('postProcessEnabled', '后处理'),
      choiceField('layerImageDepth', '图片图层', [{ v: 'back', l: '歌词之后' }, { v: 'front', l: '歌词之前' }]),
      rangeField('layerImageFrequency', '图片出现频率', 0, 1, 0.01),
      rangeField('cameraIntensity', '镜头运动', 0, 2, 0.05),
      rangeField('glyphMotion', '逐字动势', 0, 2, 0.05),
      rangeField('glyphSettleStretch', '入场时序', 0, 1, 0.01),
      rangeField('textureResolution', '纹理分辨率', 1, 2, 0.1),
      rangeField('postProcessGrain', '胶片颗粒', 0, 1, 0.01),
      rangeField('postProcessContrast', '对比度', 0, 1, 0.01),
      rangeField('postProcessRgbShift', 'RGB 色差', 0, 1, 0.01),
      rangeField('postProcessVignette', '暗角', 0, 2, 0.05),
      rangeField('postProcessLensDistortion', '透镜扭曲', 0, 2, 0.05)
    ],
    pendolo: [
      choiceField('showGearDecor', '齿轮饰线', [
        { v: 'none', l: '无' }, { v: 'subtle', l: '半透明' }, { v: 'full', l: '完整' }
      ]),
      boolField('showCenterGradient', '中央渐变'),
      boolField('showCoverOnWatchFace', '表盘封面'),
      boolField('enableLineGlow', '线条发光'),
      rangeField('wheelCenterX', '水平位置', 0, 1, 0.01),
      rangeField('wheelCenterY', '垂直位置', 0, 1, 0.01),
      rangeField('arcRadius', '轮盘半径', 0.2, 0.8, 0.01),
      rangeField('arcAngleDeg', '弧度角度', 40, 180, 1),
      rangeField('tickSnappiness', '擒纵力度', 0.2, 4, 0.05),
      rangeField('activeScale', '聚焦缩放', 1, 1.8, 0.01)
    ]
  };

  var state = {
    enabled: false,
    mode: 'classic',
    background: 'common',
    backgroundUrl: '',
    backgroundFromImport: false,
    bgCommon: {
      useCoverColorBg: true,
      opacity: 0.75,
      disableGeometricBackground: false,
      disableVignette: false
    },
    homeStyle: 'mr',
    wallOpen: false,
    tunings: {},
    assets: { avatars: [], emojis: [], tempera: [], backgrounds: [] },
    ready: false,
    lastLinesSig: '',
    raf: 0,
    importDisplayUrl: '',
    importDisplayKey: ''
  };

  function readStore() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
      if (raw.mode && FOLIA_MODES.some(function (m) { return m.id === raw.mode; })) state.mode = raw.mode;
      state.enabled = raw.enabled === true && state.mode !== 'off';
      if (FOLIA_BACKGROUNDS.indexOf(raw.background) >= 0) state.background = raw.background;
      if (typeof raw.backgroundUrl === 'string' && raw.backgroundUrl.indexOf('data:') !== 0) {
        state.backgroundUrl = raw.backgroundUrl;
      }
      state.backgroundFromImport = raw.backgroundFromImport === true;
      if (raw.bgCommon && typeof raw.bgCommon === 'object') {
        state.bgCommon = Object.assign({}, state.bgCommon, raw.bgCommon);
      }
      // Folia 封面流体层上还有主题色遮罩；透明度=1 时封面色完全被盖住
      if (state.bgCommon.useCoverColorBg && Number(state.bgCommon.opacity) >= 0.98) {
        state.bgCommon.opacity = 0.75;
      }
      if (raw.homeStyle === 'wall' || raw.homeStyle === 'mr') state.homeStyle = raw.homeStyle;
      if (raw.tunings && typeof raw.tunings === 'object') state.tunings = raw.tunings;
    } catch (_) {}
  }

  function writeStore() {
    try {
      var url = String(state.backgroundUrl || '');
      var fromImport = !!state.backgroundFromImport || url.indexOf('data:') === 0;
      localStorage.setItem(STORE_KEY, JSON.stringify({
        enabled: !!state.enabled,
        mode: state.mode,
        background: state.background,
        backgroundUrl: fromImport ? '' : url,
        backgroundFromImport: fromImport,
        bgCommon: state.bgCommon,
        homeStyle: state.homeStyle,
        tunings: state.tunings
      }));
    } catch (_) {}
  }

  function withEmbedFlag(url) {
    try {
      var parsed = new URL(url, window.location.href);
      if (parsed.searchParams.get('mineradio') !== '1') parsed.searchParams.set('mineradio', '1');
      return parsed.href;
    } catch (_) {
      return String(url || '');
    }
  }

  function defaultEmbedUrl() {
    var url = '';
    try {
      url = localStorage.getItem('mineradio-folia-embed-url') || '';
    } catch (_) {}
    if (!url) {
      try {
        url = new URL('vendor/folia/mineradio-embed.html', window.location.href).href;
      } catch (_) {
        url = 'vendor/folia/mineradio-embed.html';
      }
    }
    // Folia skips its main-app video layer only when this flag is present.
    return withEmbedFlag(url);
  }

  function stageEl() {
    return document.getElementById('folia-stage');
  }

  function frameEl() {
    return document.getElementById('folia-stage-frame');
  }

  function post(type, payload) {
    var frame = frameEl();
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(Object.assign({ source: HOST_SOURCE, type: type }, payload || {}), '*');
    } catch (_) {}
  }

  function ensureFrame() {
    var stage = stageEl();
    var frame = frameEl();
    if (!stage) return null;
    // Give the iframe a laid-out box before assigning src; some browsers stall loads while display:none.
    stage.classList.add('show');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'folia-stage-frame';
      frame.title = 'Folia lyric stage';
      frame.allow = 'autoplay';
      frame.setAttribute('aria-hidden', 'true');
      stage.appendChild(frame);
    }
    var url = defaultEmbedUrl();
    if (frame.getAttribute('data-src') !== url) {
      frame.setAttribute('data-src', url);
      state.ready = false;
      frame.onload = function () { post('FOLIA_PING'); };
      frame.src = url;
    }
    return frame;
  }

  function setStageVisible(on) {
    var stage = stageEl();
    if (!stage) return;
    var live = !!on && !!state.ready;
    stage.classList.toggle('show', !!on);
    stage.setAttribute('aria-hidden', on ? 'false' : 'true');
    document.documentElement.classList.toggle('folia-stage-active', !!on);
    document.documentElement.classList.toggle('folia-stage-live', live);
    document.body.classList.toggle('folia-stage-active', !!on);
    document.body.classList.toggle('folia-stage-live', live);
  }

  function collectWallItems() {
    var songs = [];
    try {
      if (Array.isArray(playQueue) && playQueue.length) songs = playQueue;
      else if (Array.isArray(playlist) && playlist.length) songs = playlist;
    } catch (_) {}
    var playing = -1;
    try { if (typeof currentIdx === 'number') playing = currentIdx; } catch (_) {}
    var out = [];
    for (var i = 0; i < songs.length && out.length < 160; i++) {
      var song = songs[i];
      if (!song) continue;
      var cover = '';
      try {
        if (typeof resolveSongCoverUrl === 'function') cover = resolveSongCoverUrl(song, 300) || '';
        else cover = song.cover || song.pic || (song.al && song.al.picUrl) || '';
      } catch (_) {}
      var key = song.id || song.mid || song.hash || song.name || i;
      out.push({
        id: i + ':' + key,
        index: i,
        name: String(song.name || song.title || '未命名'),
        coverUrl: cover || undefined,
        description: String(song.artist || ''),
        current: i === playing,
        type: 'song'
      });
    }
    return out;
  }

  function pushHome(force) {
    if (!state.ready) return;
    var showing = state.homeStyle === 'wall' && state.wallOpen;
    var items = showing ? collectWallItems() : [];
    var playing = -1;
    try { if (typeof currentIdx === 'number') playing = currentIdx; } catch (_) {}
    var sig = (showing ? 'wall' : 'mr') + ':' + playing + ':' + items.length + ':' + (items[0] && items[0].id || '');
    if (!force && sig === state.lastHomeSig) return;
    state.lastHomeSig = sig;
    post('FOLIA_SET_HOME', { home: showing ? 'wall' : 'mr', items: items });
  }

  function applyWallVisibility() {
    var showing = state.homeStyle === 'wall' && state.wallOpen;
    document.body.classList.toggle('folia-home-wall', showing);
    if (showing || state.enabled) {
      ensureFrame();
      setStageVisible(true);
      startTick();
    } else if (!state.enabled) {
      setStageVisible(false);
      stopTick();
    }
    if (state.ready) pushPlaybackSnapshot();
    else if (showing || state.enabled) post('FOLIA_PING');
  }

  function pushPlaybackSnapshot() {
    if (!state.ready) return;
    if (state.homeStyle === 'wall' && state.wallOpen) {
      ensureFrame();
      setStageVisible(true);
      pushHome(true);
      return;
    }
    pushHome(true);
    if (!state.enabled) return;
    post('FOLIA_SET_MODE', { mode: state.mode });
    pushLines(true);
    pushMeta();
    pushAssets();
    var t = 0;
    try {
      if (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) t = audio.currentTime;
    } catch (_) {}
    post('FOLIA_SET_TIME', { seconds: t });
  }

  function hidePageLyrics(on) {
    try {
      if (typeof stageLyrics === 'undefined' || !stageLyrics) return;
      var items = [];
      if (stageLyrics.current) items.push(stageLyrics.current);
      (stageLyrics.outgoing || []).forEach(function (item) { items.push(item); });
      items.forEach(function (item) {
        if (item && item.mesh) item.mesh.visible = !on;
      });
      if (stageLyrics.group) stageLyrics.group.visible = !on;
    } catch (_) {}
  }

  function syncLyricSurface() {
    var on = !!state.enabled;
    document.body.classList.toggle('folia-lyrics-on', on);
    var surface = document.getElementById('fx-lyric-surface');
    if (surface) surface.classList.toggle('folia-lyrics-on', on);
    var note = document.getElementById('folia-page-lyric-note');
    if (note) note.hidden = !on;
    var tune = document.getElementById('folia-tune-fold');
    if (tune) tune.hidden = !on;
    var bg = document.getElementById('folia-bg-slot');
    if (bg) bg.hidden = false;
  }

  function ensureFoliaPresetGrids() {
    var modeGrid = document.getElementById('folia-mode-grid');
    if (modeGrid && !modeGrid.dataset.built) {
      modeGrid.dataset.built = '1';
      modeGrid.innerHTML = FOLIA_MODES.map(function (mode) {
        return '<button type="button" class="preset-card folia-preset-card" data-folia-mode="' + mode.id + '" onclick="setFoliaLyricMode(\'' + mode.id + '\')">' +
          '<div class="pc-name">' + mode.label + '</div>' +
          '<div class="pc-desc">' + (mode.desc || '') + '</div>' +
        '</button>';
      }).join('');
    }
    var bgGrid = document.getElementById('folia-bg-grid');
    if (bgGrid && !bgGrid.dataset.built) {
      bgGrid.dataset.built = '1';
      bgGrid.innerHTML = FOLIA_BACKGROUNDS.map(function (id) {
        var meta = FOLIA_BG_META[id] || { label: id, desc: '' };
        return '<button type="button" class="preset-card folia-preset-card" data-folia-bg="' + id + '" onclick="setFoliaBackground(\'' + id + '\')">' +
          '<div class="pc-name">' + meta.label + '</div>' +
          '<div class="pc-desc">' + (meta.desc || '') + '</div>' +
        '</button>';
      }).join('');
    }
  }

  function mrLinesToFolia(lines) {
    lines = Array.isArray(lines) ? lines : [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var text = String(line.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      var start = Number(line.t) || 0;
      var next = lines[i + 1];
      var nextStart = next && next.t > start ? Number(next.t) : null;
      var duration = Number(line.duration);
      if (!(duration > 0)) duration = nextStart != null ? Math.max(0.45, nextStart - start) : 4.8;
      duration = Math.min(12, Math.max(0.45, duration));
      var end = Math.min(nextStart == null ? Infinity : nextStart, start + duration);
      var words = [];
      if (Array.isArray(line.words) && line.words.length) {
        for (var w = 0; w < line.words.length; w++) {
          var word = line.words[w];
          if (!word || !String(word.text || '').trim()) continue;
          var ws = Number(word.t) || start;
          var wd = Math.max(0.06, Number(word.d) || 0.24);
          words.push({ text: String(word.text), startTime: ws, endTime: ws + wd });
        }
      }
      if (!words.length) {
        // Line-only: invent even word timing so Folia modes still animate.
        var chars = text.split('');
        var step = Math.max(0.08, (end - start) * 0.9 / Math.max(1, chars.length));
        var cursor = start;
        for (var c = 0; c < chars.length; c++) {
          words.push({ text: chars[c], startTime: cursor, endTime: cursor + step });
          cursor += step;
        }
        if (words.length) words[words.length - 1].endTime = end;
      }
      var row = {
        fullText: text,
        startTime: start,
        endTime: end,
        words: words,
        translation: line.trans ? String(line.trans) : undefined
      };
      if (line.roma || line.romanization) row.romanization = String(line.roma || line.romanization);
      out.push(row);
    }
    return out;
  }

  function linesSignature(lines) {
    if (!lines || !lines.length) return '0';
    return String(lines.length) + ':' + (lines[0] && lines[0].text || '') + ':' + (lines[lines.length - 1] && lines[lines.length - 1].text || '');
  }

  function pushLines(force) {
    if (!state.enabled || !state.ready) return;
    var raw = (typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)) ? lyricsLines : [];
    var sig = linesSignature(raw);
    if (!force && sig === state.lastLinesSig) return;
    state.lastLinesSig = sig;
    post('FOLIA_SET_LINES', { lines: mrLinesToFolia(raw) });
  }

  function subtitleModeFromFx() {
    try {
      if (typeof fx !== 'undefined' && fx && fx.lyricTranslationMode === 'off') return 'none';
    } catch (_) {}
    return 'translation';
  }

  var coverDataCache = { key: '', url: '' };

  function canvasToCoverDataUrl(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return '';
    try {
      var w = canvas.width;
      var h = canvas.height;
      var max = 512;
      if (w > max || h > max) {
        var scale = max / Math.max(w, h);
        var out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(w * scale));
        out.height = Math.max(1, Math.round(h * scale));
        out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.86);
      }
      return canvas.toDataURL('image/jpeg', 0.86);
    } catch (_) {
      return '';
    }
  }

  function resolveFoliaCoverUrl(song) {
    try {
      if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) {
        var local = String(currentCoverSource.src || '');
        if (/^(data:|blob:)/i.test(local)) return local;
      }
    } catch (_) {}
    try {
      if (typeof coverTex !== 'undefined' && coverTex && coverTex.image) {
        var img = coverTex.image;
        var key = '';
        try {
          key = (song && (song.id || song.songmid || song.name) || '') + ':' + (img.width || 0) + 'x' + (img.height || 0);
        } catch (_) {}
        if (img && img.tagName === 'CANVAS') {
          if (coverDataCache.key === key && coverDataCache.url) return coverDataCache.url;
          var dataUrl = canvasToCoverDataUrl(img);
          if (dataUrl) {
            coverDataCache = { key: key, url: dataUrl };
            return dataUrl;
          }
        }
        if (img && img.src && /^(data:|blob:)/i.test(img.src)) return img.src;
      }
    } catch (_) {}
    try {
      if (song && typeof resolveSongCoverUrl === 'function') return resolveSongCoverUrl(song, 500) || '';
      if (song) return song.cover || song.pic || (song.al && song.al.picUrl) || '';
    } catch (_) {}
    return '';
  }

  function pushMeta() {
    if (!state.ready) return;
    if (!state.enabled && !(state.homeStyle === 'wall' && state.wallOpen)) return;
    var song = (typeof playQueue !== 'undefined' && typeof currentIdx === 'number' && playQueue[currentIdx]) || null;
    var cover = resolveFoliaCoverUrl(song);
    var title = song && (song.name || song.title) || '';
    var artist = '';
    if (song) {
      if (typeof song.artist === 'string') artist = song.artist;
      else if (Array.isArray(song.ar)) artist = song.ar.map(function (a) { return a && a.name; }).filter(Boolean).join(' / ');
      else if (song.artists) artist = String(song.artists);
    }
    var fontScale = 1;
    try {
      if (typeof fx !== 'undefined' && fx && fx.lyricScale) fontScale = Math.max(0.7, Math.min(1.45, Number(fx.lyricScale) || 1));
    } catch (_) {}
    post('FOLIA_SET_META', {
      payload: {
        coverUrl: cover || null,
        songTitle: title || null,
        songArtist: artist || null,
        songAlbum: (song && (song.album || song.al && song.al.name)) || null,
        paused: !(typeof playing !== 'undefined' && playing),
        visible: !(state.homeStyle === 'wall' && state.wallOpen),
        lyricsFontScale: fontScale,
        visualizerOpacity: 1,
        background: backgroundPayload(),
        subtitleContentMode: subtitleModeFromFx()
      }
    });

    var theme = {
      name: 'Mineradio',
      backgroundColor: '#05060a',
      primaryColor: '#f4f7fb',
      accentColor: '#7ec8d8',
      secondaryColor: '#9db8cf',
      fontStyle: 'sans',
      fontWeight: 700,
      animationIntensity: 'normal'
    };
    try {
      if (typeof fx !== 'undefined' && fx) {
        if (fx.lyricColor) theme.primaryColor = fx.lyricColor;
        if (fx.lyricHighlightColor) theme.accentColor = fx.lyricHighlightColor;
        // 开启封面取色时不要用死黑主题底把流体层盖死
        if (!state.bgCommon.useCoverColorBg && fx.backgroundColor) theme.backgroundColor = fx.backgroundColor;
        else if (fx.visualTint) theme.accentColor = fx.visualTint;
        if (fx.lyricWeight) theme.fontWeight = Math.round(fx.lyricWeight);
        var font = String(fx.lyricFont || '');
        if (/mono/.test(font)) theme.fontStyle = 'mono';
        else if (/serif|song|kai|editorial|humanist|gothic/.test(font)) theme.fontStyle = 'serif';
        else theme.fontStyle = 'sans';
        var intensity = Number(fx.intensity);
        if (intensity < 0.55) theme.animationIntensity = 'calm';
        else if (intensity > 1.15) theme.animationIntensity = 'chaotic';
        else theme.animationIntensity = 'normal';
      }
    } catch (_) {}
    post('FOLIA_SET_THEME', { theme: theme });
    pushTuning();
  }

  function revokeImportDisplayUrl() {
    if (state.importDisplayUrl && state.importDisplayUrl.indexOf('blob:') === 0) {
      try { URL.revokeObjectURL(state.importDisplayUrl); } catch (_) {}
    }
    state.importDisplayUrl = '';
    state.importDisplayKey = '';
  }

  function importedBackgroundItem() {
    var list = state.assets && state.assets.backgrounds;
    return list && list[0] ? list[0] : null;
  }

  function ensureImportDisplayUrl(dataUrl) {
    var src = String(dataUrl || '');
    if (!src) return '';
    var key = (importedBackgroundItem() && importedBackgroundItem().id) || src.slice(0, 64);
    if (state.importDisplayUrl && state.importDisplayKey === key) return state.importDisplayUrl;
    revokeImportDisplayUrl();
    var safe = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}' +
      'img{width:100%;height:100%;object-fit:cover;display:block;background:#000}</style></head>' +
      '<body><img alt="" src="' + safe + '"></body></html>';
    state.importDisplayUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    state.importDisplayKey = key;
    return state.importDisplayUrl;
  }

  function activeBackgroundUrl() {
    if (state.backgroundFromImport) {
      var item = importedBackgroundItem();
      if (item && item.dataUrl) return ensureImportDisplayUrl(item.dataUrl);
    }
    return String(state.backgroundUrl || '').trim();
  }

  function backgroundPayload() {
    var payload = {
      mode: state.background || 'common',
      common: {
        useCoverColorBg: !!state.bgCommon.useCoverColorBg,
        opacity: Math.max(0.15, Math.min(1, Number(state.bgCommon.opacity) || 1)),
        disableGeometricBackground: !!state.bgCommon.disableGeometricBackground,
        disableVignette: !!state.bgCommon.disableVignette
      }
    };
    var url = activeBackgroundUrl();
    if (payload.mode === 'url' && url) {
      var item = importedBackgroundItem();
      payload.url = {
        selectedId: 'mineradio',
        items: [{ id: 'mineradio', url: url, note: item && item.name ? item.name : '' }]
      };
    }
    return payload;
  }

  function pushTuning() {
    if (!state.ready) return;
    post('FOLIA_SET_TUNING', { tunings: state.tunings || {} });
  }

  var ASSET_DB = 'mineradio-folia-assets';
  var ASSET_LIMITS = { avatars: 12, emojis: 24, tempera: 16, backgrounds: 1 };
  var ASSET_BYTES = { avatars: 3 * 1024 * 1024, emojis: 2 * 1024 * 1024, tempera: 4 * 1024 * 1024, backgrounds: 8 * 1024 * 1024 };

  function openAssetDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(ASSET_DB, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('packs')) req.result.createObjectStore('packs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function loadAssets() {
    return openAssetDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('packs', 'readonly').objectStore('packs').get('packs');
        req.onsuccess = function () {
          var saved = req.result || {};
          resolve({
            avatars: Array.isArray(saved.avatars) ? saved.avatars : [],
            emojis: Array.isArray(saved.emojis) ? saved.emojis : [],
            tempera: Array.isArray(saved.tempera) ? saved.tempera : [],
            backgrounds: Array.isArray(saved.backgrounds) ? saved.backgrounds : []
          });
        };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () {
      return { avatars: [], emojis: [], tempera: [], backgrounds: [] };
    });
  }

  function saveAssets() {
    return openAssetDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('packs', 'readwrite');
        tx.objectStore('packs').put(state.assets, 'packs');
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }

  function pushAssets() {
    if (!state.ready) return;
    function pack(list) {
      return (list || []).filter(function (item) { return item && item.dataUrl; }).map(function (item) {
        return { id: item.id, name: item.name || '', url: item.dataUrl };
      });
    }
    post('FOLIA_SET_ASSETS', {
      avatars: pack(state.assets.avatars),
      emojis: pack(state.assets.emojis),
      tempera: pack(state.assets.tempera)
    });
  }

  function syncTemperaImages() {
    var next = currentTuning('tempera');
    next.layerImages = (state.assets.tempera || []).map(function (img) {
      return {
        id: img.id,
        name: img.name || '',
        align: img.align || 'free',
        verticalAlign: img.verticalAlign || 'bottom',
        scale: img.scale == null ? 0.7 : Number(img.scale),
        opacity: img.opacity == null ? 1 : Number(img.opacity)
      };
    });
    state.tunings.tempera = next;
    writeStore();
    pushTuning();
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function addAssetFiles(kind, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var limit = ASSET_LIMITS[kind] || 8;
    var maxBytes = ASSET_BYTES[kind] || ASSET_BYTES.tempera;
    var room = Math.max(0, limit - (state.assets[kind] || []).length);
    var accepted = [];
    var skipped = 0;
    files.forEach(function (file) {
      if (!file || !/^image\//.test(file.type || '')) { skipped += 1; return; }
      if (file.size > maxBytes || accepted.length >= room) { skipped += 1; return; }
      accepted.push(file);
    });
    if (!accepted.length) {
      if (typeof showToast === 'function') showToast(room ? '没有可用的图片' : '已达到数量上限');
      return;
    }
    Promise.all(accepted.map(readImageFile)).then(function (urls) {
      urls.forEach(function (url, index) {
        var file = accepted[index];
        var item = {
          id: Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2, 6),
          name: file.name || 'image',
          dataUrl: url
        };
        if (kind === 'tempera') {
          item.align = 'free';
          item.verticalAlign = 'bottom';
          item.scale = 0.7;
          item.opacity = 1;
        }
        state.assets[kind].push(item);
      });
      saveAssets();
      if (kind === 'tempera') syncTemperaImages();
      pushAssets();
      renderTuningPanel();
      if (typeof showToast === 'function') showToast('已添加 ' + urls.length + ' 张' + (skipped ? '，跳过 ' + skipped + ' 张' : ''));
    }).catch(function () {
      if (typeof showToast === 'function') showToast('图片读取失败');
    });
  }

  function removeAsset(kind, id) {
    state.assets[kind] = (state.assets[kind] || []).filter(function (item) { return item.id !== id; });
    saveAssets();
    if (kind === 'tempera') syncTemperaImages();
    pushAssets();
    renderTuningPanel();
  }

  function clearAssets(kind) {
    state.assets[kind] = [];
    saveAssets();
    if (kind === 'tempera') syncTemperaImages();
    pushAssets();
    renderTuningPanel();
  }

  function patchTemperaAsset(id, key, value) {
    var item = (state.assets.tempera || []).filter(function (img) { return img.id === id; })[0];
    if (!item) return;
    item[key] = value;
    saveAssets();
    syncTemperaImages();
  }

  function escAttr(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function assetButtons(kind, uploadLabel) {
    return '<div class="folia-asset-actions">' +
      '<label class="fx-mini-btn ghost folia-file-btn">' + uploadLabel +
      '<input type="file" accept="image/*" multiple onchange="setFoliaAssetFiles(\'' + kind + '\', this.files); this.value=\'\'">' +
      '</label>' +
      '<button type="button" class="fx-mini-btn ghost" onclick="clearFoliaAssets(\'' + kind + '\')">清空</button>' +
      '</div>';
  }

  function assetListHtml(kind) {
    var list = state.assets[kind] || [];
    if (!list.length) return '<div class="folia-asset-empty">还没有图片</div>';
    return list.map(function (item) {
      var row = '<div class="folia-asset-row"><img alt="" src="' + escAttr(item.dataUrl) + '"><span>' + escAttr(item.name) + '</span>';
      if (kind === 'tempera') {
        row += '<select onchange="setFoliaTemperaAsset(\'' + item.id + '\',\'align\',this.value)">' +
          ['free', 'left', 'center', 'right'].map(function (v) {
            var labels = { free: '不限', left: '偏左', center: '居中', right: '偏右' };
            return '<option value="' + v + '"' + (item.align === v ? ' selected' : '') + '>' + labels[v] + '</option>';
          }).join('') + '</select>';
        row += '<select onchange="setFoliaTemperaAsset(\'' + item.id + '\',\'verticalAlign\',this.value)">' +
          ['free', 'top', 'center', 'bottom'].map(function (v) {
            var labels = { free: '纵向随机', top: '顶部', center: '中部', bottom: '底部' };
            var current = item.verticalAlign || 'bottom';
            return '<option value="' + v + '"' + (current === v ? ' selected' : '') + '>' + labels[v] + '</option>';
          }).join('') + '</select>';
        row += '<label>大小<input type="range" min="0.2" max="1.4" step="0.01" value="' + (item.scale == null ? 0.7 : item.scale) + '" oninput="setFoliaTemperaAsset(\'' + item.id + '\',\'scale\',Number(this.value))"></label>';
        row += '<label>透明度<input type="range" min="0.05" max="1" step="0.01" value="' + (item.opacity == null ? 1 : item.opacity) + '" oninput="setFoliaTemperaAsset(\'' + item.id + '\',\'opacity\',Number(this.value))"></label>';
      }
      row += '<button type="button" onclick="removeFoliaAsset(\'' + kind + '\',\'' + item.id + '\')">移除</button></div>';
      return row;
    }).join('');
  }

  function assetPanelHtml() {
    if (state.mode === 'cappella') {
      return '<div class="folia-asset-block"><div class="fx-section-label">自定义头像</div>' +
        assetButtons('avatars', '上传头像') + assetListHtml('avatars') +
        '<div class="fx-section-label">自定义表情包</div>' +
        assetButtons('emojis', '上传表情') + assetListHtml('emojis') +
        '<div class="folia-asset-note">头像来源选「自定义」、表情来源选「自定义」后才会用到这些图片。</div></div>';
    }
    if (state.mode === 'tempera') {
      return '<div class="folia-asset-block"><div class="fx-section-label">画布图片</div>' +
        assetButtons('tempera', '添加图片') + assetListHtml('tempera') +
        '<div class="folia-asset-note">每个分镜会从图片池里按出现频率抽一张。最多 16 张。</div></div>';
    }
    return '';
  }

  function currentTuning(mode) {
    var base = FOLIA_TUNING_DEFAULTS[mode] || {};
    var saved = (state.tunings && state.tunings[mode]) || {};
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });
    Object.keys(saved).forEach(function (key) { out[key] = saved[key]; });
    return out;
  }

  function renderTuningPanel() {
    var panel = document.getElementById('folia-tuning-panel');
    if (!panel) return;
    var fields = FOLIA_TUNING_FIELDS[state.mode];
    if (!state.enabled || !fields) {
      panel.innerHTML = state.enabled ? '' : '';
      return;
    }
    var values = currentTuning(state.mode);
    var html = '';
    fields.forEach(function (field) {
      var value = values[field.key];
      if (field.type === 'bool') {
        html += '<button type="button" class="fx-mini-btn ghost' + (value ? ' active' : '') + '" onclick="setFoliaTuning(\'' + state.mode + '\',\'' + field.key + '\',' + (!value) + ')">' + field.label + '</button> ';
      } else if (field.type === 'choice') {
        html += '<div class="fx-section-label">' + field.label + '</div><div class="fx-seg folia-tune-seg">';
        field.options.forEach(function (opt) {
          var encoded = typeof opt.v === 'string' ? '\'' + opt.v + '\'' : String(opt.v);
          var active = String(value) === String(opt.v);
          html += '<button type="button" class="' + (active ? 'active' : '') + '" onclick="setFoliaTuning(\'' + state.mode + '\',\'' + field.key + '\',' + encoded + ')">' + opt.l + '</button>';
        });
        html += '</div>';
      } else {
        html += '<div class="fx-slider"><label>' + field.label + '</label><input type="range" min="' + field.min + '" max="' + field.max + '" step="' + field.step + '" value="' + value + '" oninput="setFoliaTuning(\'' + state.mode + '\',\'' + field.key + '\',Number(this.value),true)"><output>' + value + '</output></div>';
      }
    });
    html += assetPanelHtml();
    panel.innerHTML = html;
  }

  function setBackground(mode, opts) {
    opts = opts || {};
    if (FOLIA_BACKGROUNDS.indexOf(mode) < 0) mode = 'common';
    state.background = mode;
    writeStore();
    syncUi();
    if (state.enabled && state.ready) pushMeta();
    if (!opts.silent && typeof showToast === 'function') {
      var meta = FOLIA_BG_META[mode] || { label: mode };
      showToast('Folia 背景: ' + meta.label);
    }
  }

  function setBackgroundUrl(url) {
    state.backgroundUrl = String(url || '').trim();
    state.background = 'url';
    state.backgroundFromImport = false;
    revokeImportDisplayUrl();
    writeStore();
    syncUi();
    if (state.enabled && state.ready) pushMeta();
  }

  function importBackgroundFiles(fileList) {
    var file = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && /^image\//.test(f.type || '');
    })[0];
    if (!file) {
      if (typeof showToast === 'function') showToast('请选择图片文件');
      return;
    }
    if (file.size > ASSET_BYTES.backgrounds) {
      if (typeof showToast === 'function') showToast('图片过大，请控制在 8MB 以内');
      return;
    }
    readImageFile(file).then(function (dataUrl) {
      state.assets.backgrounds = [{
        id: Date.now().toString(36) + '-bg',
        name: file.name || 'background',
        dataUrl: dataUrl
      }];
      state.background = 'url';
      state.backgroundFromImport = true;
      state.backgroundUrl = '';
      saveAssets();
      writeStore();
      syncUi();
      if (state.enabled && state.ready) pushMeta();
      if (typeof showToast === 'function') showToast('已导入 Folia 背景图');
    }).catch(function () {
      if (typeof showToast === 'function') showToast('背景图读取失败');
    });
  }

  function clearBackgroundImport() {
    state.assets.backgrounds = [];
    state.backgroundFromImport = false;
    revokeImportDisplayUrl();
    if (!state.backgroundUrl) state.backgroundUrl = '';
    saveAssets();
    writeStore();
    syncUi();
    if (state.enabled && state.ready) pushMeta();
    if (typeof showToast === 'function') showToast('已清除导入的背景');
  }

  function setTuning(mode, key, value, fromSlider) {
    if (!FOLIA_TUNING_DEFAULTS[mode]) return;
    var next = currentTuning(mode);
    next[key] = value;
    state.tunings[mode] = next;
    writeStore();
    pushTuning();
    if (!fromSlider) renderTuningPanel();
    else {
      var output = document.querySelector('#folia-tuning-panel input[oninput*="' + key + '"]');
      if (output && output.nextElementSibling) output.nextElementSibling.textContent = value;
    }
  }

  function setBgCommon(key, value) {
    if (!Object.prototype.hasOwnProperty.call(state.bgCommon, key)) return;
    if (key === 'opacity') {
      state.bgCommon.opacity = Math.max(0.15, Math.min(1, Number(value) || 0.75));
    } else if (key === 'useCoverColorBg') {
      state.bgCommon.useCoverColorBg = !!value;
      if (state.bgCommon.useCoverColorBg && Number(state.bgCommon.opacity) >= 0.95) {
        state.bgCommon.opacity = 0.75;
      } else if (!state.bgCommon.useCoverColorBg && Number(state.bgCommon.opacity) <= 0.8) {
        state.bgCommon.opacity = 1;
      }
    } else {
      state.bgCommon[key] = value;
    }
    writeStore();
    syncUi();
    if (state.ready) pushMeta();
  }

  function suppressMineradioEmptyHome() {
    try {
      if (typeof homeForcedOpen !== 'undefined') homeForcedOpen = false;
      if (typeof homeSuppressed !== 'undefined') homeSuppressed = true;
      if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
      if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
    } catch (_) {}
  }

  function setHomeStyle(style, opts) {
    opts = opts || {};
    state.homeStyle = style === 'wall' ? 'wall' : 'mr';
    state.wallOpen = state.homeStyle === 'wall';
    if (state.homeStyle === 'wall') suppressMineradioEmptyHome();
    writeStore();
    applyWallVisibility();
    syncUi();
    if (!opts.silent && typeof showToast === 'function') {
      showToast(state.homeStyle === 'wall' ? 'Home 已切换为 Folia 海报墙' : 'Home 已切回 Mineradio');
    }
  }

  function setWallOpen(open, opts) {
    opts = opts || {};
    if (state.homeStyle !== 'wall') return false;
    var next = !!open;
    if (next) suppressMineradioEmptyHome();
    if (state.wallOpen === next) {
      applyWallVisibility();
      syncUi();
      return true;
    }
    state.wallOpen = next;
    applyWallVisibility();
    syncUi();
    if (!opts.silent && typeof showToast === 'function') {
      showToast(state.wallOpen ? '已打开 Folia 海报墙' : '已关闭 Folia 海报墙');
    }
    return true;
  }

  function toggleWall(opts) {
    if (state.homeStyle !== 'wall') return false;
    return setWallOpen(!state.wallOpen, opts);
  }

  function openWallSong(index) {
    index = Number(index);
    if (!isFinite(index) || index < 0) return;
    state.wallOpen = false;
    applyWallVisibility();
    if (typeof playQueueAt === 'function') playQueueAt(index);
  }

  function tick() {
    if (!state.enabled && !(state.homeStyle === 'wall' && state.wallOpen)) {
      state.raf = 0;
      return;
    }
    if (state.enabled) hidePageLyrics(true);
    if (state.ready && state.enabled && !(state.homeStyle === 'wall' && state.wallOpen)) {
      var t = 0;
      try {
        if (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime)) t = audio.currentTime;
      } catch (_) {}
      post('FOLIA_SET_TIME', { seconds: t });

      var power = 0;
      var bands = { bass: 0, mid: 0, treble: 0 };
      var spectrum = [];
      try {
        if (typeof bass === 'number') bands.bass = Math.max(0, Math.min(1, bass));
        if (typeof mid === 'number') bands.mid = Math.max(0, Math.min(1, mid));
        if (typeof treble === 'number') bands.treble = Math.max(0, Math.min(1, treble));
        if (typeof audioEnergy === 'number') power = Math.max(0, Math.min(1, audioEnergy));
        else power = (bands.bass + bands.mid + bands.treble) / 3;
        if (typeof frequencyData !== 'undefined' && frequencyData && frequencyData.length) {
          var step = Math.max(1, Math.floor(frequencyData.length / 64));
          for (var i = 0; i < frequencyData.length; i += step) spectrum.push(frequencyData[i] | 0);
        }
      } catch (_) {}
      post('FOLIA_SET_AUDIO', { power: power, bands: bands, spectrum: spectrum });
      pushLines(false);
    } else if (state.ready && state.homeStyle === 'wall' && state.wallOpen) {
      pushHome(false);
    }
    state.raf = requestAnimationFrame(tick);
  }

  function startTick() {
    if (state.raf) return;
    if (!state.enabled && !(state.homeStyle === 'wall' && state.wallOpen)) return;
    state.raf = requestAnimationFrame(tick);
  }

  function stopTick() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function applyMode(mode, opts) {
    opts = opts || {};
    mode = String(mode || 'off');
    if (!FOLIA_MODES.some(function (m) { return m.id === mode; })) mode = 'off';
    state.mode = mode;
    state.enabled = mode !== 'off';
    writeStore();
    syncUi();

    if (!state.enabled) {
      setStageVisible(false);
      stopTick();
      syncLyricSurface();
      hidePageLyrics(false);
      post('FOLIA_SET_MODE', { mode: 'off' });
      post('FOLIA_SET_META', { payload: { visible: false } });
      if (!opts.silent && typeof showToast === 'function') showToast('已关闭 Folia 全屏歌词');
      if (!opts.silent && typeof global.setPresetsSurface === 'function') {
        try { global.setPresetsSurface('folia'); } catch (_) {}
      }
      return;
    }

    syncLyricSurface();
    hidePageLyrics(true);
    ensureFrame();
    setStageVisible(true);
    startTick();
    try {
      if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
      if (typeof wakeBottomHandle === 'function') wakeBottomHandle(1800);
    } catch (_) {}
    if (state.ready) {
      pushPlaybackSnapshot();
    } else {
      post('FOLIA_PING');
    }
    if (!opts.silent && typeof showToast === 'function') {
      var label = FOLIA_MODES.find(function (m) { return m.id === mode; });
      showToast('Folia 全屏歌词: ' + ((label && label.label) || mode));
    }
    if (!opts.silent && typeof global.setPresetsSurface === 'function') {
      try { global.setPresetsSurface('folia'); } catch (_) {}
    }
  }

  function syncUi() {
    ensureFoliaPresetGrids();
    var modeButtons = document.querySelectorAll('[data-folia-mode]');
    for (var i = 0; i < modeButtons.length; i++) {
      modeButtons[i].classList.toggle('active', modeButtons[i].getAttribute('data-folia-mode') === state.mode);
    }
    var status = document.getElementById('folia-stage-status');
    if (status) {
      if (state.homeStyle === 'wall' && state.wallOpen) status.textContent = state.ready ? '海报墙已连接' : '等待 Folia 海报墙…';
      else if (!state.enabled) status.textContent = '关闭 · 使用页面歌词';
      else if (!state.ready) status.textContent = '等待 Folia 嵌入端… 若持续失败请重新打包 vendor/folia';
      else {
        var modeMeta = FOLIA_MODES.find(function (m) { return m.id === state.mode; });
        status.textContent = '全屏舞台 · ' + ((modeMeta && modeMeta.label) || state.mode);
      }
    }
    var homeButtons = document.querySelectorAll('[data-folia-home]');
    for (var h = 0; h < homeButtons.length; h++) {
      homeButtons[h].classList.toggle('active', homeButtons[h].getAttribute('data-folia-home') === state.homeStyle);
    }
    var bgButtons = document.querySelectorAll('[data-folia-bg]');
    for (var b = 0; b < bgButtons.length; b++) {
      bgButtons[b].classList.toggle('active', bgButtons[b].getAttribute('data-folia-bg') === state.background);
    }
    var urlRow = document.getElementById('folia-bg-url-row');
    var urlInput = document.getElementById('folia-bg-url');
    if (urlRow) urlRow.classList.toggle('show', state.background === 'url');
    if (urlInput && document.activeElement !== urlInput) {
      urlInput.value = state.backgroundFromImport ? '' : (state.backgroundUrl || '');
      urlInput.placeholder = state.backgroundFromImport ? '已使用本地导入（也可改填网址）' : 'https://';
    }
    var importItem = importedBackgroundItem();
    var importPreview = document.getElementById('folia-bg-import-preview');
    var importThumb = document.getElementById('folia-bg-import-thumb');
    var importName = document.getElementById('folia-bg-import-name');
    var importClear = document.getElementById('folia-bg-import-clear');
    var hasImport = !!(state.backgroundFromImport && importItem && importItem.dataUrl);
    if (importPreview) importPreview.hidden = !hasImport;
    if (importThumb) importThumb.src = hasImport ? importItem.dataUrl : '';
    if (importName) importName.textContent = hasImport ? (importItem.name || '已导入') : '';
    if (importClear) importClear.hidden = !hasImport;
    var commonRow = document.getElementById('folia-bg-common-row');
    if (commonRow) commonRow.hidden = state.background !== 'common';
    var coverBtn = document.getElementById('folia-bg-cover');
    if (coverBtn) coverBtn.classList.toggle('active', !!state.bgCommon.useCoverColorBg);
    var geoBtn = document.getElementById('folia-bg-geo');
    if (geoBtn) geoBtn.classList.toggle('active', !!state.bgCommon.disableGeometricBackground);
    var vigBtn = document.getElementById('folia-bg-vignette');
    if (vigBtn) vigBtn.classList.toggle('active', !!state.bgCommon.disableVignette);
    var opacityInput = document.getElementById('folia-bg-opacity');
    if (opacityInput && document.activeElement !== opacityInput) {
      opacityInput.value = String(state.bgCommon.opacity);
      if (opacityInput.nextElementSibling) opacityInput.nextElementSibling.textContent = Number(state.bgCommon.opacity).toFixed(2);
    }
    syncLyricSurface();
    renderTuningPanel();
  }

  function onMessage(event) {
    var data = event.data;
    if (!data || data.source !== EMBED_SOURCE) return;
    if (data.type === 'FOLIA_READY') {
      state.ready = true;
      if (state.enabled || (state.homeStyle === 'wall' && state.wallOpen)) {
        pushPlaybackSnapshot();
        setStageVisible(true);
      }
      syncUi();
    }
    if (data.type === 'FOLIA_WALL_OPEN') {
      openWallSong(data.index);
    }
  }

  function init() {
    readStore();
    window.addEventListener('message', onMessage);
    if (!stageEl()) {
      var stage = document.createElement('div');
      stage.id = 'folia-stage';
      stage.className = 'folia-stage';
      stage.setAttribute('aria-hidden', 'true');
      document.body.appendChild(stage);
    }
    syncUi();
    loadAssets().then(function (packs) {
      state.assets = packs;
      if (state.backgroundFromImport && packs.backgrounds && packs.backgrounds[0] && packs.backgrounds[0].dataUrl) {
        state.background = 'url';
        state.backgroundUrl = '';
      } else if (state.backgroundFromImport) {
        state.backgroundFromImport = false;
      }
      if (packs.tempera && packs.tempera.length) syncTemperaImages();
      syncUi();
      pushAssets();
      if (state.enabled || (state.homeStyle === 'wall' && state.wallOpen)) pushMeta();
    });
    if (state.enabled) {
      hidePageLyrics(true);
      ensureFrame();
      setStageVisible(true);
      startTick();
      post('FOLIA_PING');
    }
  }

  global.MineradioFolia = {
    modes: FOLIA_MODES,
    isEnabled: function () { return !!state.enabled; },
    getMode: function () { return state.mode; },
    setMode: function (mode, opts) { applyMode(mode, opts); },
    setBackground: function (mode, opts) { setBackground(mode, opts); },
    setBackgroundUrl: function (url) { setBackgroundUrl(url); },
    importBackground: function (files) { importBackgroundFiles(files); },
    clearBackgroundImport: function () { clearBackgroundImport(); },
    setBgCommon: function (key, value) { setBgCommon(key, value); },
    setHomeStyle: function (style, opts) { setHomeStyle(style, opts); },
    homeStyle: function () { return state.homeStyle; },
    isWallOpen: function () { return !!(state.homeStyle === 'wall' && state.wallOpen); },
    setWallOpen: function (open, opts) { return setWallOpen(open, opts); },
    toggleWall: function (opts) { return toggleWall(opts); },
    setTuning: function (mode, key, value, fromSlider) { setTuning(mode, key, value, fromSlider); },
    setEmbedUrl: function (url) {
      try { localStorage.setItem('mineradio-folia-embed-url', String(url || '')); } catch (_) {}
      state.ready = false;
      var frame = frameEl();
      if (frame) {
        frame.removeAttribute('data-src');
      }
      if (state.enabled || state.homeStyle === 'wall') ensureFrame();
    },
    refresh: function () {
      pushHome(true);
      pushLines(true);
      pushMeta();
      pushAssets();
      syncUi();
    },
    syncUi: syncUi
  };

  global.setFoliaLyricMode = function (mode) {
    applyMode(mode);
  };
  global.setFoliaBackground = function (mode) {
    setBackground(mode);
  };
  global.setFoliaBackgroundUrl = function (url) {
    setBackgroundUrl(url);
  };
  global.importFoliaBackground = function (files) {
    importBackgroundFiles(files);
  };
  global.clearFoliaBackgroundImport = function () {
    clearBackgroundImport();
  };
  global.setFoliaBgCommon = function (key, value) {
    setBgCommon(key, value);
  };
  global.setFoliaHomeStyle = function (style) {
    setHomeStyle(style);
  };
  global.setFoliaTuning = function (mode, key, value, fromSlider) {
    setTuning(mode, key, value, fromSlider);
  };
  global.setFoliaAssetFiles = function (kind, files) { addAssetFiles(kind, files); };
  global.removeFoliaAsset = function (kind, id) { removeAsset(kind, id); };
  global.clearFoliaAssets = function (kind) { clearAssets(kind); };
  global.setFoliaTemperaAsset = function (id, key, value) { patchTemperaAsset(id, key, value); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
