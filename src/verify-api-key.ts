import { getFromCache, L2_TTL, setInCache } from './cache.ts';
import type {
  ApiKeyResult,
  ApiKeyWithOrgRecord,
  CachedApiKey,
  Env,
  PermissionsObject,
} from './types.ts';

/**
 * Hash an API key using SHA-256 and encode as base64url (no padding)
 * This matches Better Auth's API key storage format
 */
const hashApiKey = async (apiKey: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to base64url without padding
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Check if permissions object grants a specific permission
 * Permission format: "resource:action" (e.g., "prompt:read")
 */
const hasPermission = (
  permissions: PermissionsObject,
  requiredPermission: string,
): boolean => {
  const [resource, action] = requiredPermission.split(':');
  if (!resource || !action) {
    return false;
  }

  const resourcePermissions = permissions[resource];
  if (!resourcePermissions) {
    return false;
  }

  return resourcePermissions.includes(action);
};

/**
 * Verify an API key and check permissions
 */
export const verifyApiKey = async (
  env: Env,
  apiKey: string,
  requiredPermission: string,
): Promise<ApiKeyResult> => {
  const hashedKey = await hashApiKey(apiKey);
  const cacheKey = `apikey:${hashedKey}`;

  // Check cache first
  let cachedData = await getFromCache<CachedApiKey>(
    env.PROMPTS_CACHE,
    cacheKey,
  );

  if (!cachedData) {
    // Query D1 database - join apikey with member to get organization_id
    const result = await env.promptly
      .prepare(
        `SELECT a.id, a.key, a.user_id, a.permissions, a.enabled, a.expires_at, m.organization_id
				FROM apikey a
				INNER JOIN member m ON a.user_id = m.user_id
				WHERE a.key = ?
				LIMIT 1`,
      )
      .bind(hashedKey)
      .first<ApiKeyWithOrgRecord>();

    if (!result) {
      return { valid: false, code: 'INVALID_KEY' };
    }

    // Parse permissions - Better Auth stores as {"resource": ["action1", "action2"]}
    const permissionsObj: PermissionsObject = result.permissions
      ? (JSON.parse(result.permissions) as PermissionsObject)
      : {};

    // Cache the key data
    cachedData = {
      organizationId: result.organization_id,
      permissions: permissionsObj,
      enabled: result.enabled === 1,
      expiresAt: result.expires_at,
    };

    await setInCache(env.PROMPTS_CACHE, cacheKey, cachedData, L2_TTL);
  }

  // Validate the key
  if (!cachedData.enabled) {
    return { valid: false, code: 'DISABLED' };
  }

  if (cachedData.expiresAt && cachedData.expiresAt < Date.now()) {
    return { valid: false, code: 'EXPIRED' };
  }

  if (!hasPermission(cachedData.permissions, requiredPermission)) {
    return { valid: false, code: 'FORBIDDEN' };
  }

  return {
    valid: true,
    organizationId: cachedData.organizationId,
    permissions: cachedData.permissions,
  };
};
