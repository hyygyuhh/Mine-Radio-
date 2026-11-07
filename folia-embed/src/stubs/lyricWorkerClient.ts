export const toWorkerLyricProcessingOptions = (options: unknown) => options;

export const initLyricsWorker = () => {
  throw new Error('Mine-Radio embed does not bundle the Folia lyric parser worker');
};

export const parseLyricsAsync = async () => {
  throw new Error('Mine-Radio embed does not bundle the Folia lyric parser worker');
};
