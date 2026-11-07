export const PLAYLIST_ADD_BATCH = 50;

const unavailable = () => Promise.resolve(null);

export const omni = new Proxy({}, {
  get: () => unavailable,
});

export type OmniService = typeof omni;
