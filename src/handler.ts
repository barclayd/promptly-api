import { fetchPrompt } from './fetch-prompt.ts';
import type { Env, ErrorResponse, PromptResponse } from './types.ts';
import { verifyApiKey } from './verify-api-key.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Create an error response
 */
function errorResponse(error: string, code: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error, code }, status);
}

/**
 * Handle incoming requests
 */
export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
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

  // Parse route: GET /prompts/:promptId
  const match = url.pathname.match(/^\/prompts\/([^/]+)$/);
  if (!match) {
    return errorResponse('Not found', 'NOT_FOUND', 404);
  }

  const promptId = match[1];
  if (!promptId) {
    return errorResponse('Missing prompt ID', 'BAD_REQUEST', 400);
  }

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

  // Verify API key
  const keyResult = await verifyApiKey(env, apiKey, 'prompt:read');
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

  // Get optional version parameter
  const version = url.searchParams.get('version') ?? undefined;

  // Fetch the prompt
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

  return jsonResponse<PromptResponse>(promptResult);
}
