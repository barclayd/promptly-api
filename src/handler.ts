import { fetchComposer, fetchComposers } from './fetch-composer.ts';
import { fetchPrompt, fetchPrompts } from './fetch-prompt.ts';
import type {
  ComposerResponse,
  Env,
  ErrorResponse,
  PromptResponse,
  RateLimitResponse,
  UsageStatus,
} from './types.ts';
import {
  checkUsageLimit,
  getNextMonthResetUnix,
  incrementUsage,
} from './usage.ts';
import { verifyApiKey } from './verify-api-key.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * Create a JSON response with CORS headers and optional extra headers
 */
const jsonResponse = <T>(
  data: T,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
};

/**
 * Create an error response
 */
const errorResponse = (
  error: string,
  code: string,
  status: number,
): Response => {
  return jsonResponse<ErrorResponse>({ error, code }, status);
};

/**
 * Build rate limit headers from usage status (undefined for unlimited plans)
 */
const rateLimitHeaders = (
  usage: UsageStatus,
): Record<string, string> | undefined => {
  if (usage.limit === null) {
    return undefined;
  }

  return {
    'X-RateLimit-Limit': String(usage.limit),
    'X-RateLimit-Remaining': String(usage.remaining ?? 0),
    'X-RateLimit-Reset': String(getNextMonthResetUnix()),
  };
};

/**
 * Handle incoming requests
 */
export const handleRequest = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // Only allow GET requests
  if (request.method !== 'GET') {
    return errorResponse('Method not allowed', 'METHOD_NOT_ALLOWED', 405);
  }

  // Parse routes
  const promptSingleMatch = url.pathname.match(/^\/prompts\/([^/]+)$/);
  const promptListMatch = url.pathname === '/prompts';
  const composerSingleMatch = url.pathname.match(/^\/composers\/([^/]+)$/);
  const composerListMatch = url.pathname === '/composers';

  if (
    !promptSingleMatch &&
    !promptListMatch &&
    !composerSingleMatch &&
    !composerListMatch
  ) {
    return errorResponse('Not found', 'NOT_FOUND', 404);
  }

  const isComposerRoute = composerSingleMatch || composerListMatch;

  // Extract and validate Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Missing Authorization header', 'UNAUTHORIZED', 401);
  }

  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch?.[1]) {
    return errorResponse(
      'Invalid Authorization header format',
      'UNAUTHORIZED',
      401,
    );
  }

  const apiKey = bearerMatch[1];

  // Verify API key with route-specific permission
  const requiredPermission = isComposerRoute ? 'composer:read' : 'prompt:read';
  const keyResult = await verifyApiKey(env, apiKey, requiredPermission);

  if (!keyResult.valid) {
    const statusMap = {
      INVALID_KEY: 401,
      DISABLED: 401,
      EXPIRED: 401,
      FORBIDDEN: 403,
    } as const;

    const messageMap = {
      INVALID_KEY: 'Invalid API key',
      DISABLED: 'API key is disabled',
      EXPIRED: 'API key has expired',
      FORBIDDEN: 'Insufficient permissions',
    } as const;

    return errorResponse(
      messageMap[keyResult.code],
      keyResult.code,
      statusMap[keyResult.code],
    );
  }

  // Check usage limits
  const usageStatus = await checkUsageLimit(env, keyResult.organizationId);

  if (!usageStatus.allowed && usageStatus.limit !== null) {
    const resetUnix = getNextMonthResetUnix();
    const retryAfter = Math.max(0, resetUnix - Math.floor(Date.now() / 1000));

    const upgradeMessage =
      usageStatus.plan === 'free'
        ? 'Upgrade to Pro for 50,000 calls/month.'
        : 'Upgrade to Enterprise for unlimited API calls.';

    return jsonResponse<RateLimitResponse>(
      {
        error: `Monthly API limit reached (${usageStatus.used}/${usageStatus.limit} calls). ${upgradeMessage}`,
        code: 'USAGE_LIMIT_EXCEEDED',
        usage: {
          limit: usageStatus.limit,
          used: usageStatus.used,
          remaining: 0,
          resetAt: usageStatus.resetAt,
        },
        upgradeUrl: 'https://app.promptlycms.com/settings?tab=billing',
      },
      429,
      {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(usageStatus.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetUnix),
      },
    );
  }

  // List all prompts
  if (promptListMatch) {
    const includeVersions = url.searchParams.get('include_versions') === 'true';
    const prompts = await fetchPrompts(
      env,
      keyResult.organizationId,
      includeVersions,
    );
    ctx.waitUntil(incrementUsage(env, keyResult.organizationId));
    return jsonResponse<PromptResponse[]>(
      prompts,
      200,
      rateLimitHeaders(usageStatus),
    );
  }

  // Single prompt
  if (promptSingleMatch) {
    const promptId = promptSingleMatch[1] as string;
    const version = url.searchParams.get('version') ?? undefined;

    const promptResult = await fetchPrompt(
      env,
      promptId,
      keyResult.organizationId,
      version,
    );

    if ('error' in promptResult) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        VERSION_NOT_FOUND: 404,
        BAD_REQUEST: 400,
      };
      const status = statusMap[promptResult.code] ?? 500;
      return errorResponse(promptResult.error, promptResult.code, status);
    }

    ctx.waitUntil(incrementUsage(env, keyResult.organizationId));
    return jsonResponse<PromptResponse>(
      promptResult,
      200,
      rateLimitHeaders(usageStatus),
    );
  }

  // List all composers
  if (composerListMatch) {
    const includeVersions = url.searchParams.get('include_versions') === 'true';
    const result = await fetchComposers(
      env,
      keyResult.organizationId,
      includeVersions,
    );

    if ('error' in result) {
      return errorResponse(result.error, result.code, 422);
    }

    ctx.waitUntil(incrementUsage(env, keyResult.organizationId));
    return jsonResponse<ComposerResponse[]>(
      result,
      200,
      rateLimitHeaders(usageStatus),
    );
  }

  // Single composer
  const composerId = composerSingleMatch?.[1] as string;
  const version = url.searchParams.get('version') ?? undefined;

  const composerResult = await fetchComposer(
    env,
    composerId,
    keyResult.organizationId,
    version,
  );

  if ('error' in composerResult) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      VERSION_NOT_FOUND: 404,
      BAD_REQUEST: 400,
      UNRESOLVED_PROMPT: 422,
    };
    const status = statusMap[composerResult.code] ?? 500;
    return errorResponse(composerResult.error, composerResult.code, status);
  }

  ctx.waitUntil(incrementUsage(env, keyResult.organizationId));
  return jsonResponse<ComposerResponse>(
    composerResult,
    200,
    rateLimitHeaders(usageStatus),
  );
};
