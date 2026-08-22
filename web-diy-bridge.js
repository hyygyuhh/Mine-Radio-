/**
 * Web DIY bridge: sonic presets, lyric DIY controls, FX panel visibility.
 * Loaded after app.js + sonic-* presets. Does not replace Electron-only features.
 */
(function () {
  'use strict';

  var SONIC_TOPO_INDEX = 7;

  var SONIC_FX_DEFAULTS = {
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
    sonicGroundFloatingCount: 80
  };

  function ensureFxDefaults() {
    if (typeof fxDefaults !== 'object' || !fxDefaults) return;
    Object.keys(SONIC_FX_DEFAULTS).forEach(function (key) {
      if (fxDefaults[key] === undefined) fxDefaults[key] = SONIC_FX_DEFAULTS[key];
      if (typeof fx === 'object' && fx && fx[key] === undefined) fx[key] = SONIC_FX_DEFAULTS[key];
    });
  }

  function ensurePresetMeta() {
    if (typeof presetMeta === 'undefined' || !Array.isArray(presetMeta)) return;
    if (presetMeta.length < 8) {
      presetMeta.push({
        name: '音域地形',
        nameHtml: '音域地形 <span class="pc-name-en">Sonic-Topography</span>',
        desc: '作者 Ajin',
        descHtml: '作者 <span class="pc-author-ajin">Ajin</span>'
      });
    }
    if (typeof presetIcons !== 'undefined' && Array.isArray(presetIcons) && presetIcons.length < 8) {
      presetIcons.push(
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M3 12c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 6c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><circle cx="18" cy="5" r="1.2" fill="currentColor"/></svg>'
      );
    }
    if (typeof presetDisplayOrder !== 'undefined' && Array.isArray(presetDisplayOrder)) {
      var order = [0, 6, 7, 5, 4, 2, 1, 3];
      presetDisplayOrder.length = 0;
      order.forEach(function (i) { presetDisplayOrder.push(i); });
    }
  }

  function isSonicPreset(p) {
    return Number(p) === SONIC_TOPO_INDEX;
  }

  function syncSonicSectionVisibility() {
    var active = typeof fx !== 'undefined' && fx ? Number(fx.preset) : -1;
    var diy = document.body && document.body.classList.contains('diy-mode');
    var topo = diy && active === SONIC_TOPO_INDEX;
    var ids = {
      'fx-sonic-ground-section': topo,
      'fx-sonic-audio-section': topo,
      'fx-sonic-color-section': topo,
      'fx-sonic-floating-section': topo,
      'sonic-audio-toggle-grid': topo,
      'sonic-audio-monitor': topo,
      'sonic-floating-toggle-grid': topo
    };
    Object.keys(ids).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('fx-sonic-hidden', !ids[id]);
      if (!ids[id]) el.style.display = 'none';
      else el.style.display = '';
    });
    document.querySelectorAll('input[id^="fx-sonic"]').forEach(function (el) {
      var show = diy && topo;
      var row = el.closest('.fx-slider') || el;
      row.classList.toggle('fx-sonic-hidden', !show);
      row.style.display = show ? '' : 'none';
    });
    document.querySelectorAll('.lyric-color-row[id^="sonic-"]').forEach(function (el) {
      var show = diy && topo;
      el.classList.toggle('fx-sonic-hidden', !show);
      el.style.display = show ? '' : 'none';
    });
  }

  function syncLyricDiyControls() {
    if (typeof fx === 'undefined' || !fx) return;
    var modeSeg = document.getElementById('lyric-display-mode-seg');
    if (modeSeg) {
      modeSeg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === fx.lyricDisplayMode);
      });
    }
    var transSeg = document.getElementById('lyric-translation-mode-seg');
    if (transSeg) {
      transSeg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-translation') === fx.lyricTranslationMode);
      });
    }
    var motionSeg = document.getElementById('lyric-motion-style-seg');
    if (motionSeg) {
      motionSeg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-motion') === fx.lyricMotionStyle);
      });
    }
    var glitch = document.getElementById('lyric-glitch-controls');
    if (glitch) glitch.style.display = fx.lyricMotionStyle === 'glitch' ? '' : 'none';
    var bindBtn = document.getElementById('lyric-glitch-camera-bind');
    if (bindBtn) bindBtn.classList.toggle('active', !!fx.lyricGlitchCameraBind);
    var customLines = document.getElementById('fx-lyriccustomlines');
    if (customLines) {
      var row = customLines.closest('.fx-slider') || customLines;
      var showCustom = fx.lyricDisplayMode === 'custom';
      row.style.display = showCustom ? '' : 'none';
      row.classList.toggle('fx-diy-hidden', !showCustom);
      if (fx.lyricCustomLineCount != null) {
        customLines.value = fx.lyricCustomLineCount;
        var out = row.querySelector('output');
        if (out) out.textContent = String(fx.lyricCustomLineCount);
      }
    }
  }
  window.syncLyricDiyControls = syncLyricDiyControls;

  function refreshLyricStageNow() {
    try {
      if (typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.currentIdx >= 0 && typeof composeDiyLyricStageText === 'function') {
        var next = composeDiyLyricStageText(stageLyrics.currentIdx);
        if (next && next !== stageLyrics.currentText && typeof showStageLine === 'function') showStageLine(next);
        else if (typeof refreshCurrentLyricStyle === 'function') refreshCurrentLyricStyle();
      } else if (typeof refreshCurrentLyricStyle === 'function') {
        refreshCurrentLyricStyle();
      }
    } catch (_) {}
  }

  window.setLyricDisplayMode = function (mode) {
    ensureFxDefaults();
    if (!/^(single|dual|triple|cinema|custom)$/.test(String(mode || ''))) mode = 'cinema';
    fx.lyricDisplayMode = mode;
    syncLyricDiyControls();
    refreshLyricStageNow();
    if (typeof saveLyricLayout === 'function') saveLyricLayout();
    if (typeof showToast === 'function') {
      var labels = { single: '单行', dual: '双行', triple: '三行', cinema: '沉浸', custom: '自定' };
      showToast('歌词行数: ' + (labels[mode] || mode));
    }
  };

  window.setLyricTranslationMode = function (mode) {
    ensureFxDefaults();
    if (!/^(off|current|dual|multi)$/.test(String(mode || ''))) mode = 'multi';
    fx.lyricTranslationMode = mode;
    syncLyricDiyControls();
    refreshLyricStageNow();
    if (typeof saveLyricLayout === 'function') saveLyricLayout();
    if (typeof showToast === 'function') {
      var labels = { off: '关闭', current: '当前句', dual: '邻句', multi: '多行' };
      showToast('双语翻译: ' + (labels[mode] || mode));
    }
  };

  window.setLyricMotionStyle = function (style) {
    ensureFxDefaults();
    if (!/^(float|smooth|glass|shine|glitch)$/.test(String(style || ''))) style = 'float';
    fx.lyricMotionStyle = style;
    syncLyricDiyControls();
    if (typeof saveLyricLayout === 'function') saveLyricLayout();
    if (typeof showToast === 'function') {
      var labels = { float: '漂浮', smooth: '柔滑', glass: '玻璃', shine: '线光', glitch: '故障' };
      showToast('歌词动画: ' + (labels[style] || style));
    }
  };

  window.toggleLyricGlitchCameraBind = function () {
    ensureFxDefaults();
    fx.lyricGlitchCameraBind = !fx.lyricGlitchCameraBind;
    syncLyricDiyControls();
    if (typeof saveLyricLayout === 'function') saveLyricLayout();
  };

  window.resetSonicGroundColor = function (key) {
    ensureFxDefaults();
    if (!fxDefaults[key]) return;
    fx[key] = fxDefaults[key];
    fx.sonicGroundColorMode = 'custom';
    var map = {
      sonicGroundBaseColor: ['sonic-ground-base-picker', 'sonic-ground-base-value'],
      sonicGroundCoolColor: ['sonic-ground-cool-picker', 'sonic-ground-cool-value'],
      sonicGroundWarmColor: ['sonic-ground-warm-picker', 'sonic-ground-warm-value'],
      sonicGroundAccentColor: ['sonic-ground-accent-picker', 'sonic-ground-accent-value']
    };
    var ids = map[key];
    if (ids) {
      var picker = document.getElementById(ids[0]);
      var value = document.getElementById(ids[1]);
      if (picker) picker.value = fx[key];
      if (value) value.textContent = String(fx[key]).toUpperCase();
    }
    if (typeof saveLyricLayout === 'function') saveLyricLayout();
  };

  function bindSonicColorPickers() {
    var pairs = [
      ['sonic-ground-base-picker', 'sonicGroundBaseColor', 'sonic-ground-base-value'],
      ['sonic-ground-cool-picker', 'sonicGroundCoolColor', 'sonic-ground-cool-value'],
      ['sonic-ground-warm-picker', 'sonicGroundWarmColor', 'sonic-ground-warm-value'],
      ['sonic-ground-accent-picker', 'sonicGroundAccentColor', 'sonic-ground-accent-value']
    ];
    pairs.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el || el._sonicBound) return;
      el._sonicBound = true;
      el.addEventListener('input', function () {
        ensureFxDefaults();
        fx[pair[1]] = el.value;
        fx.sonicGroundColorMode = 'custom';
        var label = document.getElementById(pair[2]);
        if (label) label.textContent = String(el.value).toUpperCase();
        if (typeof saveLyricLayout === 'function') saveLyricLayout();
      });
    });
    var monitorToggle = document.getElementById('sonic-audio-monitor-toggle');
    if (monitorToggle && !monitorToggle._sonicBound) {
      monitorToggle._sonicBound = true;
      monitorToggle.addEventListener('click', function () {
        var panel = document.getElementById('sonic-audio-monitor-panel');
        if (panel) panel.classList.toggle('open');
      });
    }
  }

  function bindExtraSliders() {
    if (typeof bindFxPanel !== 'function') return;
    var extra = [
      ['fx-lyricbgadapt', 'lyricBackgroundAdapt'],
      ['fx-lyriccustomlines', 'lyricCustomLineCount'],
      ['fx-lyricglitchintensity', 'lyricGlitchIntensity'],
      ['fx-lyricglitchslice', 'lyricGlitchSlice'],
      ['fx-lyricglitchchroma', 'lyricGlitchChroma'],
      ['fx-lyricglitchrate', 'lyricGlitchRate'],
      ['fx-lyricglitchjitter', 'lyricGlitchJitter'],
      ['fx-lyriccontextopacity', 'lyricContextOpacity'],
      ['fx-lyriccontextspread', 'lyricContextSpread'],
      ['fx-lyrictranslationgap', 'lyricTranslationGap'],
      ['fx-lyricedgefade', 'lyricEdgeFade'],
      ['fx-lyricmotionsoftness', 'lyricMotionSoftness'],
      ['fx-sonicamp', 'sonicGroundAmplitude'],
      ['fx-sonicspeed', 'sonicGroundMotionSpeed'],
      ['fx-sonicdensity', 'sonicGroundDensity'],
      ['fx-sonicrange', 'sonicGroundRange'],
      ['fx-soniclower', 'sonicGroundLower'],
      ['fx-sonicdepth', 'sonicGroundDepth'],
      ['fx-sonicautorotate', 'sonicGroundAutoRotate'],
      ['fx-sonicaudiosensitivity', 'sonicAudioSensitivity'],
      ['fx-sonicaudiobandstart', 'sonicAudioBandStart'],
      ['fx-sonicaudiobandend', 'sonicAudioBandEnd'],
      ['fx-sonicaudiothreshold', 'sonicAudioThreshold'],
      ['fx-sonicaudiopulse', 'sonicAudioPulse'],
      ['fx-sonicsubbass', 'sonicGroundSubBass'],
      ['fx-sonicbass', 'sonicGroundBass'],
      ['fx-soniclowmid', 'sonicGroundLowMid'],
      ['fx-sonicmid', 'sonicGroundMid'],
      ['fx-sonichighmid', 'sonicGroundHighMid'],
      ['fx-sonicpresence', 'sonicGroundPresence'],
      ['fx-sonicbrilliance', 'sonicGroundBrilliance'],
      ['fx-sonicair', 'sonicGroundAir'],
      ['fx-sonicglow', 'sonicGroundGlow'],
      ['fx-sonicfloatcount', 'sonicGroundFloatingCount'],
      ['fx-sonicfloatintensity', 'sonicGroundFloatingIntensity'],
      ['fx-sonicfloatmin', 'sonicGroundFloatingMinSize'],
      ['fx-sonicfloatmax', 'sonicGroundFloatingMaxSize'],
      ['fx-sonicfloatspeed', 'sonicGroundFloatingSpeed']
    ];
    extra.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el || el._diyBound) return;
      el._diyBound = true;
      if (fx && fx[pair[1]] != null) el.value = fx[pair[1]];
      var out = el.parentElement && el.parentElement.querySelector('output');
      if (out) out.textContent = String(el.value);
      el.addEventListener('input', function () {
        fx[pair[1]] = parseFloat(el.value);
        if (out) out.textContent = String(el.value);
        if (/^lyric(Custom|Context|Edge|Motion|Glitch)/.test(pair[1]) || pair[1] === 'lyricCustomLineCount') {
          if (pair[1] === 'lyricCustomLineCount') refreshLyricStageNow();
        }
        if (typeof saveLyricLayout === 'function') saveLyricLayout();
      });
    });
  }

  function patchSetPreset() {
    if (typeof setPreset !== 'function' || setPreset._diyPatched) return;
    var base = setPreset;
    setPreset = function (p, opts) {
      var prev = typeof fx !== 'undefined' && fx ? fx.preset : 0;
      var result = base.apply(this, arguments);
      var next = typeof fx !== 'undefined' && fx ? fx.preset : p;
      try {
        if (window.MineradioSonicTopography && typeof MineradioSonicTopography.onPresetChange === 'function') {
          MineradioSonicTopography.onPresetChange(prev, next, { scene: typeof scene !== 'undefined' ? scene : null, fx: fx });
        }
      } catch (err) {
        console.warn('[WebDiySonicPreset]', err);
      }
      syncSonicSectionVisibility();
      if (typeof buildPresetGrid === 'function') buildPresetGrid();
      return result;
    };
    setPreset._diyPatched = true;
  }

  function patchDiyMode() {
    if (typeof applyDiyMode !== 'function' || applyDiyMode._diyPatched) return;
    var base = applyDiyMode;
    applyDiyMode = function () {
      var result = base.apply(this, arguments);
      syncSonicSectionVisibility();
      syncLyricDiyControls();
      return result;
    };
    applyDiyMode._diyPatched = true;
  }

  function patchToggleFx() {
    if (typeof toggleFx !== 'function' || toggleFx._diyPatched) return;
    var base = toggleFx;
    toggleFx = function (key) {
      var result = base.apply(this, arguments);
      if (/^sonic/.test(String(key || ''))) {
        syncSonicSectionVisibility();
        if (typeof saveLyricLayout === 'function') saveLyricLayout();
      }
      return result;
    };
    toggleFx._diyPatched = true;
  }

  function boot() {
    ensureFxDefaults();
    ensurePresetMeta();
    patchSetPreset();
    patchDiyMode();
    patchToggleFx();
    bindExtraSliders();
    bindSonicColorPickers();
    syncSonicSectionVisibility();
    syncLyricDiyControls();
    if (typeof buildPresetGrid === 'function') buildPresetGrid();
    if (typeof emptyHomeActive !== 'undefined' && emptyHomeActive && typeof renderHomeDashboard === 'function') {
      renderHomeDashboard();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
