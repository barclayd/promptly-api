import type { Env } from './types.ts';

const CACHE_TTL = 60; // 60 seconds

/**
 * Retrieve a value from KV cache
 */
export async function getFromCache<T>(kv: Env['PROMPTS_CACHE'], key: string): Promise<T | null> {
	const value = await kv.get(key, 'json');
	if (value !== null) {
		console.log(JSON.stringify({ event: 'cache_hit', key }));
	} else {
		console.log(JSON.stringify({ event: 'cache_miss', key }));
	}
	return value as T | null;
}

/**
 * Store a value in KV cache with TTL
 */
export async function setInCache<T>(
	kv: Env['PROMPTS_CACHE'],
	key: string,
	value: T,
): Promise<void> {
	await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
	console.log(JSON.stringify({ event: 'cache_set', key, ttl: CACHE_TTL }));
}
