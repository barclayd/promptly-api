import { memoryCache } from './memory-cache.ts';
import type {
  CachedUsage,
  Env,
  PlanInfo,
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
 * Get the current date string (YYYY-MM-DD) in UTC
 */
const getCurrentDate = (): string => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
 * Look up the plan info for an organization
 */
const getPlanInfo = async (
  env: Env,
  organizationId: string,
): Promise<PlanInfo> => {
  const cacheKey = `plan:${organizationId}`;

  // Check L1 cache
  const cached = memoryCache.get<PlanInfo>(cacheKey);
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

  let planInfo: PlanInfo = { plan: 'free', limit: FREE_LIMIT };

  if (
    subscription &&
    (subscription.status === 'active' || subscription.status === 'trialing')
  ) {
    if (subscription.plan === 'enterprise') {
      planInfo = { plan: 'enterprise', limit: null };
    } else if (subscription.plan === 'pro') {
      planInfo = { plan: 'pro', limit: PRO_LIMIT };
    }
  }

  // Cache in L1 only
  memoryCache.set(cacheKey, planInfo, PLAN_CACHE_TTL);

  return planInfo;
};

/**
 * Build UsageStatus from count and plan info
 */
const buildUsageStatus = (count: number, planInfo: PlanInfo): UsageStatus => {
  if (planInfo.limit === null) {
    return {
      allowed: true,
      plan: planInfo.plan,
      limit: null,
      used: count,
      remaining: null,
      resetAt: getNextMonthReset(),
    };
  }

  const remaining = Math.max(0, planInfo.limit - count);
  return {
    allowed: count < planInfo.limit,
    plan: planInfo.plan,
    limit: planInfo.limit,
    used: count,
    remaining,
    resetAt: getNextMonthReset(),
  };
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

  // Check L1 cache for usage count
  const cached = memoryCache.get<CachedUsage>(cacheKey);
  if (cached) {
    const planInfo = await getPlanInfo(env, organizationId);
    return buildUsageStatus(cached.count, planInfo);
  }

  // Cache miss - query D1 for count and plan info in parallel
  const [usageResult, planInfo] = await Promise.all([
    env.promptly
      .prepare(
        'SELECT count FROM api_usage WHERE organization_id = ? AND period = ?',
      )
      .bind(organizationId, period)
      .first<{ count: number }>(),
    getPlanInfo(env, organizationId),
  ]);

  const count = usageResult?.count ?? 0;

  // Cache usage count in L1 only (no KV writes)
  memoryCache.set(cacheKey, { count, period }, USAGE_CACHE_TTL);

  return buildUsageStatus(count, planInfo);
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
    const dailyPeriod = getCurrentDate();
    const now = Date.now();

    const UPSERT_USAGE_SQL = `INSERT INTO api_usage (organization_id, period, count, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(organization_id, period)
      DO UPDATE SET count = count + 1, updated_at = ?`;

    // Batch both upserts into a single D1 round trip
    await env.promptly.batch([
      env.promptly
        .prepare(UPSERT_USAGE_SQL)
        .bind(organizationId, period, now, now, now),
      env.promptly
        .prepare(UPSERT_USAGE_SQL)
        .bind(organizationId, dailyPeriod, now, now, now),
    ]);

    // Optimistically update L1 cache (monthly only - daily is write-only)
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
      JSON.stringify({
        event: 'usage_increment',
        organizationId,
        period,
        dailyPeriod,
      }),
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
