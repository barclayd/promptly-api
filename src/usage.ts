import { memoryCache } from './memory-cache.ts';
import type {
  CachedUsage,
  Env,
  SubscriptionRecord,
  UsageStatus,
} from './types.ts';

const FREE_LIMIT = 5000;
const PRO_LIMIT = 50000;
const USAGE_CACHE_TTL = 60; // seconds - shorter for better accuracy
const PLAN_CACHE_TTL = 300; // seconds - plan changes are rare

/**
 * Get the current period string (YYYY-MM) in UTC
 */
const getCurrentPeriod = (): string => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

/**
 * Get the ISO 8601 timestamp for the start of the next month (UTC)
 */
const getNextMonthReset = (): string => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // Next month start - Date handles year rollover automatically
  return new Date(Date.UTC(year, month + 1, 1)).toISOString();
};

/**
 * Get the unix timestamp (seconds) for the start of the next month (UTC)
 */
const getNextMonthResetUnix = (): number => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Math.floor(new Date(Date.UTC(year, month + 1, 1)).getTime() / 1000);
};

/**
 * Look up the plan limit for an organization
 */
const getPlanLimit = async (
  env: Env,
  organizationId: string,
): Promise<number> => {
  const cacheKey = `plan:${organizationId}`;

  // Check L1 cache
  const cached = memoryCache.get<number>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Query D1 for subscription
  const subscription = await env.promptly
    .prepare(
      'SELECT plan, status FROM subscription WHERE organization_id = ? LIMIT 1',
    )
    .bind(organizationId)
    .first<SubscriptionRecord>();

  let limit = FREE_LIMIT;

  if (
    subscription &&
    subscription.plan === 'pro' &&
    (subscription.status === 'active' || subscription.status === 'trialing')
  ) {
    limit = PRO_LIMIT;
  }

  // Cache in L1 only
  memoryCache.set(cacheKey, limit, PLAN_CACHE_TTL);

  return limit;
};

/**
 * Check if an organization has remaining API usage for the current month
 */
export const checkUsageLimit = async (
  env: Env,
  organizationId: string,
): Promise<UsageStatus> => {
  const period = getCurrentPeriod();
  const cacheKey = `usage:${organizationId}:${period}`;

  // Check L1 cache
  const cached = memoryCache.get<CachedUsage>(cacheKey);
  if (cached) {
    const remaining = Math.max(0, cached.limit - cached.count);
    return {
      allowed: cached.count < cached.limit,
      limit: cached.limit,
      used: cached.count,
      remaining,
      resetAt: getNextMonthReset(),
    };
  }

  // Cache miss - query D1 for count and plan limit in parallel
  const [usageResult, limit] = await Promise.all([
    env.promptly
      .prepare(
        'SELECT count FROM api_usage WHERE organization_id = ? AND period = ?',
      )
      .bind(organizationId, period)
      .first<{ count: number }>(),
    getPlanLimit(env, organizationId),
  ]);

  const count = usageResult?.count ?? 0;

  // Cache in L1 only (no KV writes)
  memoryCache.set(cacheKey, { count, limit, period }, USAGE_CACHE_TTL);

  const remaining = Math.max(0, limit - count);
  return {
    allowed: count < limit,
    limit,
    used: count,
    remaining,
    resetAt: getNextMonthReset(),
  };
};

/**
 * Increment usage counter for an organization (fire-and-forget via ctx.waitUntil)
 */
export const incrementUsage = async (
  env: Env,
  organizationId: string,
): Promise<void> => {
  try {
    const period = getCurrentPeriod();
    const now = Date.now();

    // Atomic upsert - handles concurrent writes safely
    await env.promptly
      .prepare(
        `INSERT INTO api_usage (organization_id, period, count, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(organization_id, period)
        DO UPDATE SET count = count + 1, updated_at = ?`,
      )
      .bind(organizationId, period, now, now, now)
      .run();

    // Optimistically update L1 cache
    const cacheKey = `usage:${organizationId}:${period}`;
    const cached = memoryCache.get<CachedUsage>(cacheKey);
    if (cached) {
      memoryCache.set(
        cacheKey,
        { ...cached, count: cached.count + 1 },
        USAGE_CACHE_TTL,
      );
    }

    console.log(
      JSON.stringify({ event: 'usage_increment', organizationId, period }),
    );
  } catch (error) {
    // Non-critical - log but don't throw
    console.error(
      JSON.stringify({
        event: 'usage_increment_error',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};

// Export for use in handler response headers
export { getNextMonthResetUnix };
