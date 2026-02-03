type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

export const memoryCache = {
  get<T>(key: string): T | null {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data as T;
  },

  set<T>(key: string, data: T, ttlSeconds: number): void {
    cache.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
};
