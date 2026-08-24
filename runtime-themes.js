/**
 * App-wide UI themes (structure + default accent palette).
 * Loaded before app.js; boot() applies saved theme to reduce flash.
 */
(function (global) {
  'use strict';

  var APP_THEME_STORE_KEY = 'mineradio-app-theme-v1';
  var THEME_IDS = ['default', 'midnight', 'ember', 'violet', 'aurora', 'rose'];

  function themeEntry(id, name, desc, swatch, structure, fx, metaColor) {
    return {
      id: id,
      name: name,
      desc: desc || '',
      swatch: swatch || [],
      metaColor: metaColor || structure['--fc-bg'],
      structure: structure,
      fx: fx || {}
    };
  }

  var THEMES = {
    default: themeEntry(
      'default',
      '霓虹薄荷',
      '默认',
      ['#08090B', '#00F5D4', '#F4D28A'],
      {
        '--fc-bg': '#08090B',
        '--fc-paper': '#0E1014',
        '--fc-ink': '#E8ECEF',
        '--fc-ink-2': '#D2D7DC',
        '--fc-muted': '#8A9099',
        '--fc-hair': '#1A1D22',
        '--fc-hair-2': '#262A31',
        '--chill-ink': '#030608',
        '--chill-deep': '#061116',
        '--champagne': '#f4d28a',
        '--champagne-deep': '#9a6f2c'
      },
      {
        uiAccentColor: '#00F5D4',
        homeAccentColor: '#00F5D4',
        homeIconColor: '#F4D28A',
        visualIconColor: '#7FD8FF',
        visualTintColor: '#9DB8CF',
        shelfAccentColor: '#00F5D4'
      },
      '#08090B'
    ),
    midnight: themeEntry(
      'midnight',
      '午夜蓝',
      '冷蓝深邃',
      ['#05070D', '#5B8CFF', '#A8C4FF'],
      {
        '--fc-bg': '#05070D',
        '--fc-paper': '#0A1018',
        '--fc-ink': '#E6EDF8',
        '--fc-ink-2': '#C7D4EA',
        '--fc-muted': '#7F8DA6',
        '--fc-hair': '#141C2A',
        '--fc-hair-2': '#1F2A3D',
        '--chill-ink': '#02040A',
        '--chill-deep': '#07101E',
        '--champagne': '#A8C4FF',
        '--champagne-deep': '#3D5F9A'
      },
      {
        uiAccentColor: '#5B8CFF',
        homeAccentColor: '#5B8CFF',
        homeIconColor: '#A8C4FF',
        visualIconColor: '#8EB6FF',
        visualTintColor: '#8FAFE8',
        shelfAccentColor: '#5B8CFF'
      },
      '#05070D'
    ),
    ember: themeEntry(
      'ember',
      '暖焰金',
      '琥珀暮色',
      ['#100A06', '#F0A23A', '#FFD98E'],
      {
        '--fc-bg': '#100A06',
        '--fc-paper': '#17100B',
        '--fc-ink': '#F8EFE4',
        '--fc-ink-2': '#E7D4BE',
        '--fc-muted': '#A38B72',
        '--fc-hair': '#24180F',
        '--fc-hair-2': '#352518',
        '--chill-ink': '#0A0604',
        '--chill-deep': '#160E08',
        '--champagne': '#FFD98E',
        '--champagne-deep': '#9A6A24'
      },
      {
        uiAccentColor: '#F0A23A',
        homeAccentColor: '#F0A23A',
        homeIconColor: '#FFD98E',
        visualIconColor: '#FFC46B',
        visualTintColor: '#D9A56E',
        shelfAccentColor: '#F0A23A'
      },
      '#100A06'
    ),
    violet: themeEntry(
      'violet',
      '紫雾',
      '霓虹紫夜',
      ['#0A0710', '#B57CFF', '#E4C7FF'],
      {
        '--fc-bg': '#0A0710',
        '--fc-paper': '#120D18',
        '--fc-ink': '#F1E9FA',
        '--fc-ink-2': '#D8C7EE',
        '--fc-muted': '#9A88B0',
        '--fc-hair': '#1C1426',
        '--fc-hair-2': '#2A1D38',
        '--chill-ink': '#06040A',
        '--chill-deep': '#110A18',
        '--champagne': '#E4C7FF',
        '--champagne-deep': '#6E4A9A'
      },
      {
        uiAccentColor: '#B57CFF',
        homeAccentColor: '#B57CFF',
        homeIconColor: '#E4C7FF',
        visualIconColor: '#C99BFF',
        visualTintColor: '#BFA0DE',
        shelfAccentColor: '#B57CFF'
      },
      '#0A0710'
    ),
    aurora: themeEntry(
      'aurora',
      '极光青',
      '冰蓝薄荷',
      ['#041014', '#3BE8C5', '#9CFFE8'],
      {
        '--fc-bg': '#041014',
        '--fc-paper': '#08181D',
        '--fc-ink': '#E7FAF6',
        '--fc-ink-2': '#C8EEE6',
        '--fc-muted': '#7EA8A0',
        '--fc-hair': '#102428',
        '--fc-hair-2': '#18343A',
        '--chill-ink': '#020A0C',
        '--chill-deep': '#06161A',
        '--champagne': '#9CFFE8',
        '--champagne-deep': '#2A8A74'
      },
      {
        uiAccentColor: '#3BE8C5',
        homeAccentColor: '#3BE8C5',
        homeIconColor: '#9CFFE8',
        visualIconColor: '#6BF0DC',
        visualTintColor: '#7FD8CF',
        shelfAccentColor: '#3BE8C5'
      },
      '#041014'
    ),
    rose: themeEntry(
      'rose',
      '玫瑰绯',
      '绯红柔光',
      ['#10080B', '#FF6B8F', '#FFC2D0'],
      {
        '--fc-bg': '#10080B',
        '--fc-paper': '#181015',
        '--fc-ink': '#FCEFF2',
        '--fc-ink-2': '#EACBD4',
        '--fc-muted': '#A98690',
        '--fc-hair': '#24141A',
        '--fc-hair-2': '#351F28',
        '--chill-ink': '#0A0507',
        '--chill-deep': '#160A10',
        '--champagne': '#FFC2D0',
        '--champagne-deep': '#9A4A5E'
      },
      {
        uiAccentColor: '#FF6B8F',
        homeAccentColor: '#FF6B8F',
        homeIconColor: '#FFC2D0',
        visualIconColor: '#FF9AB2',
        visualTintColor: '#E39AAE',
        shelfAccentColor: '#FF6B8F'
      },
      '#10080B'
    )
  };

  function normalizeAppThemeId(id) {
    id = String(id || '').trim();
    return THEME_IDS.indexOf(id) >= 0 ? id : 'default';
  }

  function getAppTheme(id) {
    return THEMES[normalizeAppThemeId(id)];
  }

  function readStoredAppThemeId() {
    try {
      return normalizeAppThemeId(localStorage.getItem(APP_THEME_STORE_KEY));
    } catch (e) {
      return 'default';
    }
  }

  function writeStoredAppThemeId(id) {
    try { localStorage.setItem(APP_THEME_STORE_KEY, normalizeAppThemeId(id)); } catch (e) {}
  }

  function applyAppThemeStructure(id) {
    var theme = getAppTheme(id);
    var root = document.documentElement;
    root.setAttribute('data-app-theme', theme.id);
    Object.keys(theme.structure).forEach(function (key) {
      root.style.setProperty(key, theme.structure[key]);
    });
    writeStoredAppThemeId(theme.id);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.metaColor);
    return theme;
  }

  function listAppThemes() {
    return THEME_IDS.map(function (id) { return THEMES[id]; });
  }

  function bootAppTheme() {
    applyAppThemeStructure(readStoredAppThemeId());
  }

  global.MineradioThemes = {
    STORE_KEY: APP_THEME_STORE_KEY,
    IDS: THEME_IDS,
    normalize: normalizeAppThemeId,
    get: getAppTheme,
    list: listAppThemes,
    readStored: readStoredAppThemeId,
    applyStructure: applyAppThemeStructure,
    getFxDefaults: function (id) {
      var theme = getAppTheme(id);
      return Object.assign({}, theme.fx);
    },
    boot: bootAppTheme
  };

  bootAppTheme();
})(typeof window !== 'undefined' ? window : global);
