/** Bounded concurrency queue for Bridge API handlers. */

const DEFAULT_CONCURRENCY = 3;
/* No hard queue cap — large playlists enqueue many track/cover jobs; only concurrency is limited */
const DEFAULT_JOB_TIMEOUT_MS = 25000;

function pathPriority(path) {
  path = String(path || '');
  // Playback first
  if (
    path === '/api/song/url' ||
    path === '/api/qq/song/url' ||
    path === '/api/kg/song/url' ||
    path === '/api/audio'
  ) {
    return 4;
  }
  // Search / lyrics / login — user-facing, must not starve behind covers
  if (
    path === '/api/search' ||
    path === '/api/qq/search' ||
    path === '/api/kg/search' ||
    path === '/api/lyric' ||
    path === '/api/qq/lyric' ||
    path === '/api/kg/lyric' ||
    path.indexOf('/api/login/') === 0 ||
    path.indexOf('/api/qq/login/') === 0 ||
    path.indexOf('/api/kg/login/') === 0
  ) {
    return 3;
  }
  /* Search/artist thumbs need covers promptly; keep below search/playback but above bulk */
  if (path === '/api/cover') {
    return 2;
  }
  return 1;
}

export function createRequestQueue(options) {
  options = options || {};
  const concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY);
  const jobTimeoutMs = Math.max(3000, Number(options.jobTimeoutMs) || DEFAULT_JOB_TIMEOUT_MS);
  let active = 0;
  const waiters = [];

  function runWithTimeout(fn) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('BRIDGE_JOB_TIMEOUT'));
      }, jobTimeoutMs);
      Promise.resolve()
        .then(fn)
        .then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function pump() {
    while (active < concurrency && waiters.length) {
      const next = waiters.shift();
      active += 1;
      runWithTimeout(next.fn)
        .then(next.resolve, next.reject)
        .finally(function () {
          active -= 1;
          pump();
        });
    }
  }

  function enqueue(fn, meta) {
    meta = meta || {};
    const priority = meta.priority != null ? Number(meta.priority) : pathPriority(meta.path);
    return new Promise(function (resolve, reject) {
      const item = {
        fn: fn,
        resolve: resolve,
        reject: reject,
        priority: priority,
        path: String(meta.path || ''),
        enqueuedAt: Date.now(),
      };
      let inserted = false;
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].priority < item.priority) {
          waiters.splice(i, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) waiters.push(item);
      pump();
    });
  }

  function stats() {
    return {
      active: active,
      queued: waiters.length,
      concurrency: concurrency,
      maxQueue: null,
      jobTimeoutMs: jobTimeoutMs,
    };
  }

  return {
    enqueue: enqueue,
    stats: stats,
    pathPriority: pathPriority,
  };
}
