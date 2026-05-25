export interface PlatformAdapter {
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  lifecycle: {
    onBackground(cb: () => void): () => void;
    onForeground(cb: () => void): () => void;
  };
}

export interface PlatformMetadata {
  platform?: string;
  os?: string;
  sdkVersion?: string;
}
