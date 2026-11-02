// Anonymous Bridge heartbeat: install UUID + version only.
// Same installId counts once per UTC day on the server.

export const STATS_BASE_URL = 'https://mineradio.art';
export const HEARTBEAT_ALARM = 'mineradio-bridge-heartbeat';
export const HEARTBEAT_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const INSTALL_ID_KEY = 'bridgeInstallId';
const OPT_OUT_KEY = 'bridgeHeartbeatOptOut';
const LAST_AT_KEY = 'bridgeLastHeartbeatAt';
const STATS_CACHE_KEY = 'bridgeStatsCacheV1';

let installIdPromise = null;
let heartbeatPromise = null;

function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (crypto.getRandomValues || (() => {}))(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (bag) => resolve(bag || {}));
    } catch (_) {
      resolve({});
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

export async function getHeartbeatSettings() {
  const bag = await storageGet([INSTALL_ID_KEY, OPT_OUT_KEY, LAST_AT_KEY]);
  return {
    installId: bag[INSTALL_ID_KEY] || '',
    optOut: !!bag[OPT_OUT_KEY],
    lastHeartbeatAt: Number(bag[LAST_AT_KEY] || 0) || 0,
  };
}

export async function setHeartbeatOptOut(optOut) {
  await storageSet({ [OPT_OUT_KEY]: !!optOut });
}

async function ensureInstallId(existing) {
  if (existing) return existing;
  if (installIdPromise) return installIdPromise;
  installIdPromise = (async () => {
    const again = await storageGet([INSTALL_ID_KEY]);
    if (again[INSTALL_ID_KEY]) return again[INSTALL_ID_KEY];
    const id = uuid();
    await storageSet({ [INSTALL_ID_KEY]: id });
    return id;
  })().finally(() => {
    installIdPromise = null;
  });
  return installIdPromise;
}

function getVersion() {
  try {
    return chrome.runtime.getManifest().version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

export async function maybeSendHeartbeat(opts = {}) {
  if (heartbeatPromise) return heartbeatPromise;
  heartbeatPromise = (async () => {
    const force = !!opts.force;
    const settings = await getHeartbeatSettings();
    if (settings.optOut) return { ok: false, skipped: 'opt-out' };
    const now = Date.now();
    if (!force && settings.lastHeartbeatAt && now - settings.lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
      return { ok: true, skipped: 'fresh' };
    }

    const installId = await ensureInstallId(settings.installId);
    const version = getVersion();
    const base = String(STATS_BASE_URL || '').replace(/\/+$/, '');
    if (!base || /REPLACE|example\.com/i.test(base)) {
      return { ok: false, skipped: 'no-endpoint' };
    }

    try {
      const resp = await fetch(`${base}/bridge/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: installId, v: version }),
        cache: 'no-store',
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${text.slice(0, 80)}`);
      }
      await storageSet({ [LAST_AT_KEY]: now });
      return { ok: true };
    } catch (err) {
      console.warn('[Mineradio Bridge] heartbeat failed', err);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  })().finally(() => {
    heartbeatPromise = null;
  });
  return heartbeatPromise;
}

export async function fetchPublicStats() {
  const base = String(STATS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  const cached = await storageGet([STATS_CACHE_KEY]);
  const hit = cached[STATS_CACHE_KEY];
  if (hit && hit.at && hit.data && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

  try {
    const resp = await fetch(`${base}/bridge/stats`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    await storageSet({ [STATS_CACHE_KEY]: { at: Date.now(), data } });
    return data;
  } catch (err) {
    console.warn('[Mineradio Bridge] stats fetch failed', err);
    return hit && hit.data ? hit.data : null;
  }
}

export function scheduleHeartbeatAlarm() {
  if (!chrome.alarms) return;
  try {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 24 * 60 });
  } catch (_) {}
}

export function bindHeartbeatAlarm() {
  if (!chrome.alarms || !chrome.alarms.onAlarm) return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== HEARTBEAT_ALARM) return;
    maybeSendHeartbeat({ force: false }).catch(() => {});
  });
}
