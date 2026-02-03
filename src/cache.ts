import { memoryCache } from './memory-cache.ts';
import type { Env } from './types.ts';

const L1_TTL = 300; // 5 minutes for in-memory cache
const L2_TTL = 300; // 5 minutes for KV cache (default)

/**
 * Retrieve a value from tiered cache (L1 in-memory, L2 KV)
 */
export const getFromCache = async <T>(
  kv: Env['PROMPTS_CACHE'],
  key: string,
): Promise<T | null> => {
  // L1: In-memory cache
  const l1 = memoryCache.get<T>(key);
  if (l1 !== null) {
    console.log(JSON.stringify({ event: 'cache_hit', key, layer: 'L1' }));
    return l1;
  }

  // L2: KV cache
  const l2 = (await kv.get(key, 'json')) as T | null;
  if (l2 !== null) {
    console.log(JSON.stringify({ event: 'cache_hit', key, layer: 'L2' }));
    // Promote to L1
    memoryCache.set(key, l2, L1_TTL);
    return l2;
  }

  console.log(JSON.stringify({ event: 'cache_miss', key }));
  return null;
};

/**
 * Store a value in tiered cache
 * @param kv - KV namespace
 * @param key - Cache key
 * @param value - Value to cache
 * @param kvTtl - KV TTL in seconds. 0 = infinite, undefined = skip KV write (L1 only)
 */
export const setInCache = async <T>(
  kv: Env['PROMPTS_CACHE'],
  key: string,
  value: T,
  kvTtl?: number,
): Promise<void> => {
  // Always write to L1
  memoryCache.set(key, value, L1_TTL);

  // Only write to L2 (KV) if kvTtl is provided
  if (kvTtl !== undefined) {
    const options = kvTtl > 0 ? { expirationTtl: kvTtl } : undefined;
    await kv.put(key, JSON.stringify(value), options);
    console.log(
      JSON.stringify({
        event: 'cache_set',
        key,
        layer: 'L1+L2',
        kvTtl: kvTtl || 'infinite',
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        event: 'cache_set',
        key,
        layer: 'L1',
      }),
    );
  }
};

// Export default TTL for use by callers
export { L2_TTL };
