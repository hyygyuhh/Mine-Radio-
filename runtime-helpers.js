/**
 * Shared runtime utilities (debounce, scheduling).
 * Loaded before app.js; keeps hot paths out of the main bundle surface.
 */
(function (global) {
  'use strict';

  function debounce(fn, wait) {
    var timer = null;
    function debounced() {
      var ctx = this;
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(ctx, args);
      }, wait);
    }
    debounced.flush = function () {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      fn();
    };
    debounced.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    debounced.pending = function () {
      return !!timer;
    };
    return debounced;
  }

  global.MineradioRuntime = global.MineradioRuntime || {};
  global.MineradioRuntime.debounce = debounce;
})(typeof window !== 'undefined' ? window : global);
