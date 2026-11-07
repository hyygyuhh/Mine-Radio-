export interface EmbeddedMetadataResult {
  title?: string;
  artist?: string;
  album?: string;
}

export interface HashedLocalCoverResult {
  hash: string;
}

export const initMetadataWorker = () => {
  throw new Error('Mine-Radio embed does not bundle local metadata parsing');
};

export const parseEmbeddedMetadataAsync = async () => null;

export const hashLocalCoverBlobAsync = async () => null;
