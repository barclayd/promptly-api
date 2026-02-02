# Promptly API - Dedicated Cloudflare Worker

A lightweight, high-performance API worker for serving prompts to 3rd party applications.

## Overview

This worker handles `GET /prompts/promptId` requests with:
- **Direct D1 queries** - No ORM overhead
- **KV caching** - 60-second TTL for API keys and prompt data
- **SHA-256 API key verification** - Compatible with Better Auth's storage format
- **~20KB bundle size** - Fast cold starts (<5ms)

## Endpoints

```
GET https://api.promptlycms.com/prompts/promptId&version=<optional-semver>
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "promptId": "xxx",
  "promptName": "My Prompt",
  "version": "1.0.0",
  "systemMessage": "...",
  "userMessage": "...",
  "config": {}
}
```

---

## Project Setup

### 1. Initialize Project

```bash
mkdir promptly-api && cd promptly-api
bun init -y
bun add -D wrangler typescript @cloudflare/workers-types
```

### 2. Create `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "promptly-api",
  "main": "./src/index.ts",
  "compatibility_date": "2025-10-08",
  "compatibility_flags": ["nodejs_compat_v2"],
  "observability": {
    "enabled": true
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "promptly",
      "database_id": "eadc5f7c-e195-4bd0-bcb1-8e4d2950606b"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CACHE",
      "id": "<RUN: bunx wrangler kv:namespace create PROMPTS_CACHE>",
      "preview_id": "<RUN: bunx wrangler kv:namespace create PROMPTS_CACHE --preview>"
    }
  ],
  "routes": [
    {
      "pattern": "api.promptlycms.com/*",
      "zone_name": "promptlycms.com"
    }
  ]
}
```

### 3. Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*"]
}
```

### 4. Create KV Namespace

```bash
bunx wrangler kv:namespace create "PROMPTS_CACHE"
bunx wrangler kv:namespace create "PROMPTS_CACHE" --preview
# Update wrangler.jsonc with the returned IDs
```

---

## Source Code

### File Structure

```
src/
  index.ts           # Worker entry point
  handler.ts         # Request handler
  verify-api-key.ts  # API key verification
  fetch-prompt.ts    # Prompt data fetching
  cache.ts           # KV cache helpers
  types.ts           # TypeScript interfaces
```

### `src/types.ts`

```typescript
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
}

export interface CachedApiKey {
  organizationId: string;
  permissions: Record<string, string[]>;
  expiresAt: number | null;
  enabled: boolean;
}

export interface CachedPrompt {
  id: string;
  name: string;
  organizationId: string;
}

export interface CachedVersion {
  systemMessage: string;
  userMessage: string;
  config: Record<string, unknown>;
  version: string;
}

export interface ApiKeyRow {
  id: string;
  permissions: string | null;
  metadata: string | null;
  enabled: number;
  expires_at: number | null;
}

export interface PromptRow {
  id: string;
  name: string;
  organization_id: string;
}

export interface VersionRow {
  system_message: string | null;
  user_message: string | null;
  config: string;
  major: number | null;
  minor: number | null;
  patch: number | null;
}
```

### `src/cache.ts`

```typescript
import type { Env } from './types';

const CACHE_TTL = 60; // seconds

export const logCacheEvent = (
  type: 'apikey' | 'prompt' | 'version',
  hit: boolean,
  key: string,
) => {
  console.log(
    JSON.stringify({
      event: 'cache',
      type,
      hit,
      key,
      timestamp: Date.now(),
    }),
  );
};

export const getFromCache = async <T>(
  cache: KVNamespace,
  key: string,
  type: 'apikey' | 'prompt' | 'version',
): Promise<T | null> => {
  const cached = await cache.get(key, 'json');
  logCacheEvent(type, cached !== null, key);
  return cached as T | null;
};

export const setInCache = async <T>(
  cache: KVNamespace,
  key: string,
  value: T,
): Promise<void> => {
  await cache.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
};
```

### `src/verify-api-key.ts`

```typescript
import { getFromCache, setInCache } from './cache';
import type { ApiKeyRow, CachedApiKey, Env } from './types';

// Hash API key using SHA-256 (same algorithm as Better Auth)
export const hashApiKey = async (key: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

export interface VerifyResult {
  valid: boolean;
  organizationId?: string;
  error?: string;
  code?: string;
}

export const verifyApiKey = async (
  apiKey: string,
  env: Env,
): Promise<VerifyResult> => {
  const hashedKey = await hashApiKey(apiKey);
  const cacheKey = `apikey:${hashedKey}`;

  // Check cache first
  const cached = await getFromCache<CachedApiKey>(env.CACHE, cacheKey, 'apikey');
  if (cached) {
    // Validate cached key
    if (!cached.enabled) {
      return { valid: false, error: 'API key is disabled', code: 'DISABLED' };
    }
    if (cached.expiresAt && cached.expiresAt < Date.now()) {
      return { valid: false, error: 'API key has expired', code: 'EXPIRED' };
    }
    if (!cached.permissions?.prompt?.includes('read')) {
      return { valid: false, error: 'API key lacks prompt:read permission', code: 'FORBIDDEN' };
    }
    return { valid: true, organizationId: cached.organizationId };
  }

  // Query D1 directly
  const row = await env.DB.prepare(
    'SELECT id, permissions, metadata, enabled, expires_at FROM apikey WHERE key = ?',
  )
    .bind(hashedKey)
    .first<ApiKeyRow>();

  if (!row) {
    return { valid: false, error: 'Invalid API key', code: 'INVALID_KEY' };
  }

  // Parse permissions and metadata
  let permissions: Record<string, string[]> = {};
  let organizationId: string | undefined;

  try {
    if (row.permissions) {
      permissions = JSON.parse(row.permissions);
    }
  } catch {
    // Invalid permissions JSON
  }

  try {
    if (row.metadata) {
      const metadata = JSON.parse(row.metadata);
      organizationId = metadata.organizationId;
    }
  } catch {
    // Invalid metadata JSON
  }

  // Validate
  if (!row.enabled) {
    return { valid: false, error: 'API key is disabled', code: 'DISABLED' };
  }
  if (row.expires_at && row.expires_at < Date.now()) {
    return { valid: false, error: 'API key has expired', code: 'EXPIRED' };
  }
  if (!permissions.prompt?.includes('read')) {
    return { valid: false, error: 'API key lacks prompt:read permission', code: 'FORBIDDEN' };
  }
  if (!organizationId) {
    return { valid: false, error: 'API key is not associated with an organization', code: 'NO_ORG' };
  }

  // Cache the validated key
  await setInCache<CachedApiKey>(env.CACHE, cacheKey, {
    organizationId,
    permissions,
    expiresAt: row.expires_at,
    enabled: Boolean(row.enabled),
  });

  return { valid: true, organizationId };
};
```

### `src/fetch-prompt.ts`

```typescript
import { getFromCache, setInCache } from './cache';
import type { CachedPrompt, CachedVersion, Env, PromptRow, VersionRow } from './types';

export interface FetchPromptResult {
  success: boolean;
  data?: {
    promptId: string;
    promptName: string;
    version: string;
    systemMessage: string;
    userMessage: string;
    config: Record<string, unknown>;
  };
  error?: string;
  status?: number;
}

export const fetchPrompt = async (
  promptId: string,
  version: string | null,
  organizationId: string,
  env: Env,
): Promise<FetchPromptResult> => {
  // Fetch prompt metadata
  const promptCacheKey = `prompt:${promptId}`;
  let prompt = await getFromCache<CachedPrompt>(env.CACHE, promptCacheKey, 'prompt');

  if (!prompt) {
    const row = await env.DB.prepare(
      'SELECT id, name, organization_id FROM prompt WHERE id = ?',
    )
      .bind(promptId)
      .first<PromptRow>();

    if (!row) {
      return { success: false, error: 'Prompt not found', status: 404 };
    }

    prompt = {
      id: row.id,
      name: row.name,
      organizationId: row.organization_id,
    };

    await setInCache(env.CACHE, promptCacheKey, prompt);
  }

  // Verify organization access
  if (prompt.organizationId !== organizationId) {
    return {
      success: false,
      error: 'Access denied: API key does not have access to this prompt',
      status: 403,
    };
  }

  // Fetch version data
  const versionCacheKey = version
    ? `version:${promptId}:${version}`
    : `version:${promptId}:latest`;

  let versionData = await getFromCache<CachedVersion>(env.CACHE, versionCacheKey, 'version');

  if (!versionData) {
    let row: VersionRow | null;

    if (version) {
      const [major, minor, patch] = version.split('.').map(Number);
      row = await env.DB.prepare(
        'SELECT system_message, user_message, config, major, minor, patch FROM prompt_version WHERE prompt_id = ? AND major = ? AND minor = ? AND patch = ?',
      )
        .bind(promptId, major, minor, patch)
        .first<VersionRow>();
    } else {
      // Get latest: published versions first (ordered by semver), then drafts
      row = await env.DB.prepare(
        'SELECT system_message, user_message, config, major, minor, patch FROM prompt_version WHERE prompt_id = ? ORDER BY (published_at IS NULL), major DESC, minor DESC, patch DESC LIMIT 1',
      )
        .bind(promptId)
        .first<VersionRow>();
    }

    if (!row) {
      return { success: false, error: 'Version not found', status: 404 };
    }

    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config || '{}');
    } catch {
      // Keep empty object
    }

    const versionString =
      row.major !== null
        ? `${row.major}.${row.minor}.${row.patch}`
        : 'draft';

    versionData = {
      systemMessage: row.system_message ?? '',
      userMessage: row.user_message ?? '',
      config,
      version: versionString,
    };

    await setInCache(env.CACHE, versionCacheKey, versionData);
  }

  return {
    success: true,
    data: {
      promptId: prompt.id,
      promptName: prompt.name,
      version: versionData.version,
      systemMessage: versionData.systemMessage,
      userMessage: versionData.userMessage,
      config: versionData.config,
    },
  };
};
```

### `src/handler.ts`

```typescript
import { fetchPrompt } from './fetch-prompt';
import type { Env } from './types';
import { verifyApiKey } from './verify-api-key';

const jsonResponse = (data: unknown, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
};

export const handleRequest = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Only handle /prompts/get
  if (url.pathname !== '/prompts/get') {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Extract params
  const promptId = url.searchParams.get('promptId');
  const version = url.searchParams.get('version');

  if (!promptId) {
    return jsonResponse({ error: 'Missing promptId parameter' }, 400);
  }

  // Extract Bearer token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const apiKey = authHeader.slice(7);

  // Verify API key
  const verifyResult = await verifyApiKey(apiKey, env);
  if (!verifyResult.valid) {
    return jsonResponse(
      { error: verifyResult.error, code: verifyResult.code },
      verifyResult.code === 'FORBIDDEN' ? 403 : 401,
    );
  }

  // Fetch prompt
  const result = await fetchPrompt(promptId, version, verifyResult.organizationId!, env);

  if (!result.success) {
    return jsonResponse({ error: result.error }, result.status);
  }

  return jsonResponse(result.data);
};
```

### `src/index.ts`

```typescript
import { handleRequest } from './handler';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('Unhandled error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },
};
```

---

## Database Schema Reference

The worker queries the existing Promptly D1 database. Here's the relevant schema:

### `apikey` table
```sql
CREATE TABLE apikey (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,           -- SHA-256 hashed API key
  permissions TEXT,            -- JSON: {"prompt": ["read"]}
  metadata TEXT,               -- JSON: {"organizationId": "xxx"}
  enabled INTEGER DEFAULT 1,
  expires_at INTEGER,
  -- other fields omitted
);
CREATE INDEX idx_apikey_key ON apikey(key);
```

### `prompt` table
```sql
CREATE TABLE prompt (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  deleted_at INTEGER,          -- Soft delete
  -- other fields omitted
);
```

### `prompt_version` table
```sql
CREATE TABLE prompt_version (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  major INTEGER,               -- NULL for drafts
  minor INTEGER,
  patch INTEGER,
  system_message TEXT,
  user_message TEXT,
  config TEXT DEFAULT '{}',
  published_at INTEGER,        -- NULL for drafts
  -- other fields omitted
);
```

---

## Deployment

### Deploy to Production

```bash
bunx wrangler deploy
```

### Local Development

```bash
bunx wrangler dev
# Test: curl "http://localhost:8787/prompts/get?promptId=XXX" -H "Authorization: Bearer promptly_xxx"
```

---

## DNS Setup

After deploying, add DNS record in Cloudflare:

1. Go to Cloudflare Dashboard → DNS
2. Add AAAA record: `api` → `100::` (proxied)
3. The worker route pattern `api.promptlycms.com/*` will handle requests

---

## Testing

### Manual Test

```bash
# Replace with a real API key and promptId from the Promptly database
curl "https://api.promptlycms.com/prompts/get?promptId=JPxlUpstuhXB5OwOtKPpj" \
  -H "Authorization: Bearer promptly_xxxx"
```

### Performance Test

```bash
wrk -t4 -c100 -d30s \
  -H "Authorization: Bearer promptly_xxxx" \
  "https://api.promptlycms.com/prompts/get?promptId=JPxlUpstuhXB5OwOtKPpj"
```

---

## Cache Invalidation (Main App Changes)

In the main Promptly app, add cache invalidation when prompts are modified:

1. Add KV namespace binding to main `wrangler.jsonc`:
```jsonc
"kv_namespaces": [
  {
    "binding": "PROMPTS_CACHE",
    "id": "<SAME_KV_NAMESPACE_ID>"
  }
]
```

2. Add invalidation calls to:
- `prompts.update.ts` → delete `prompt:{id}`
- `prompts.publish.ts` → delete `version:{id}:latest`, `version:{id}:{semver}`
- `prompts.delete.ts` → delete `prompt:{id}`, all version keys
- `settings.delete-api-key.ts` → delete `apikey:{hashedKey}`

Example invalidation helper:
```typescript
export const invalidatePromptCache = async (
  cache: KVNamespace,
  promptId: string,
) => {
  await cache.delete(`prompt:${promptId}`);
  await cache.delete(`version:${promptId}:latest`);
  // Note: Specific version keys expire naturally (60s TTL)
};
```

---

## Monitoring

Check Cloudflare dashboard for:
- **CPU time** - Should be <5ms
- **Worker Logs** - Filter by `event: "cache"` to see hit rates
- **Error rates** - Should drop to near zero

Filter logs for cache metrics:
```
event: "cache" AND type: "apikey"
```
