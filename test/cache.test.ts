import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getFromCache, setInCache } from '../src/cache.ts';
import type { Env } from '../src/types.ts';

describe('cache helpers', () => {
	it('getFromCache returns null for missing keys', async () => {
		const result = await getFromCache<{ test: string }>(
			(env as unknown as Env).PROMPTS_CACHE,
			'nonexistent-key',
		);
		expect(result).toBeNull();
	});

	it('setInCache stores and retrieves values correctly', async () => {
		const kv = (env as unknown as Env).PROMPTS_CACHE;
		const testKey = `test-key-${Date.now()}`;
		const testValue = { foo: 'bar', num: 42 };

		await setInCache(kv, testKey, testValue);
		const result = await getFromCache<typeof testValue>(kv, testKey);

		expect(result).toEqual(testValue);
	});

	it('handles complex nested objects', async () => {
		const kv = (env as unknown as Env).PROMPTS_CACHE;
		const testKey = `complex-key-${Date.now()}`;
		const testValue = {
			organizationId: 'org-123',
			permissions: ['prompt:read', 'prompt:write'],
			enabled: true,
			metadata: {
				nested: {
					value: 'test',
				},
			},
		};

		await setInCache(kv, testKey, testValue);
		const result = await getFromCache<typeof testValue>(kv, testKey);

		expect(result).toEqual(testValue);
	});
});
