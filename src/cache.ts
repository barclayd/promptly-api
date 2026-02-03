import type { Env } from './types.ts';

const CACHE_TTL = 60 * 5; // 300 seconds

/**
 * Retrieve a value from KV cache
 */
export const getFromCache = async <T>(
  kv: Env['PROMPTS_CACHE'],
  key: string,
): Promise<T | null> => {
  const value = await kv.get(key, 'json');
  if (value !== null) {
    console.log(JSON.stringify({ event: 'cache_hit', key }));
  } else {
    console.log(JSON.stringify({ event: 'cache_miss', key }));
  }
  return value as T | null;
};

/**
 * Store a value in KV cache with optional TTL
 * If ttl is not provided, uses default 60s
 * If ttl is 0, caches indefinitely (no expiration)
 */
export const setInCache = async <T>(
  kv: Env['PROMPTS_CACHE'],
  key: string,
  value: T,
  ttl?: number,
): Promise<void> => {
  const effectiveTtl = ttl ?? CACHE_TTL;
  const options =
    effectiveTtl > 0 ? { expirationTtl: effectiveTtl } : undefined;
  await kv.put(key, JSON.stringify(value), options);
  console.log(
    JSON.stringify({
      event: 'cache_set',
      key,
      ttl: effectiveTtl || 'infinite',
    }),
  );
};
