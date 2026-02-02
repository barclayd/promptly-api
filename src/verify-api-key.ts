import { getFromCache, setInCache } from './cache.ts';
import type { ApiKeyRecord, ApiKeyResult, CachedApiKey, Env } from './types.ts';

/**
 * Hash an API key using SHA-256
 */
export async function hashApiKey(apiKey: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(apiKey);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an API key and check permissions
 */
export async function verifyApiKey(
	env: Env,
	apiKey: string,
	requiredPermission: string,
): Promise<ApiKeyResult> {
	const hashedKey = await hashApiKey(apiKey);
	const cacheKey = `apikey:${hashedKey}`;

	// Check cache first
	let cachedData = await getFromCache<CachedApiKey>(env.PROMPTS_CACHE, cacheKey);

	if (!cachedData) {
		// Query D1 database
		const result = await env.DB.prepare(
			'SELECT id, hashed_key, organization_id, permissions, enabled, expires_at FROM apikey WHERE hashed_key = ?',
		)
			.bind(hashedKey)
			.first<ApiKeyRecord>();

		if (!result) {
			return { valid: false, code: 'INVALID_KEY' };
		}

		// Parse and cache the key data
		cachedData = {
			organizationId: result.organization_id,
			permissions: JSON.parse(result.permissions) as string[],
			enabled: result.enabled,
			expiresAt: result.expires_at,
		};

		await setInCache(env.PROMPTS_CACHE, cacheKey, cachedData);
	}

	// Validate the key
	if (!cachedData.enabled) {
		return { valid: false, code: 'DISABLED' };
	}

	if (cachedData.expiresAt && new Date(cachedData.expiresAt) < new Date()) {
		return { valid: false, code: 'EXPIRED' };
	}

	if (!cachedData.permissions.includes(requiredPermission)) {
		return { valid: false, code: 'FORBIDDEN' };
	}

	return {
		valid: true,
		organizationId: cachedData.organizationId,
		permissions: cachedData.permissions,
	};
}
