# Promptly API Worker

Cloudflare Worker API for serving prompts from promptlycms.com.

## Quick Commands

```bash
bun run dev        # Start local dev server
bun run test       # Run tests against production API
bun run lint       # Check code style
bun run types      # Type check
bun run check      # Run all checks (types + lint + test)
bun run deploy     # Deploy to Cloudflare
```

## Testing

Tests run against the live API at `api.promptlycms.com` to verify deployments.

**Setup:** Add to `.env`:
```bash
TEST_PROMPT_API_KEY=promptly_your_api_key_here
TEST_PROMPT_ID=your_prompt_id_here  # Optional, enables more tests
```

**What's tested:**
- Authentication (missing header, invalid key, valid key)
- CORS headers (preflight, response headers)
- Routing (404 for unknown routes, 405 for wrong methods)
- Prompt fetching (structure validation, version fetching, error codes)
- Rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)

**Manual testing with curl:**
```bash
source .env
curl "https://api.promptlycms.com/prompts/$TEST_PROMPT_ID" \
  -H "Authorization: Bearer $TEST_PROMPT_API_KEY"
```

## Project Structure

```
src/
  index.ts           # Worker entry point
  handler.ts         # Request routing + CORS + rate limiting
  verify-api-key.ts  # API key validation (SHA-256 + base64url)
  fetch-prompt.ts    # Prompt fetching logic
  usage.ts           # Usage tracking + rate limit enforcement
  cache.ts           # Tiered cache helpers (L1 + L2)
  memory-cache.ts    # In-memory cache with TTL
  types.ts           # TypeScript interfaces

test/
  smoke.test.ts      # Production smoke tests
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Database**: D1 (SQLite) - shared with promptlycms.com
- **Cache**: Tiered - L1 in-memory (5min) + L2 KV Namespace (5min/infinite)
- **Auth**: Better Auth API Key plugin (SHA-256 hashed keys)
- **Rate Limiting**: Monthly usage caps per org (Free: 5K, Pro: 50K)

## Caching

**Tiered Cache Architecture:**
```
Request → L1 (In-Memory) → L2 (KV) → D1
              free          1K writes/day   5M reads/day
```

L1 absorbs repeated requests within the same Worker isolate, dramatically reducing KV writes to stay within the free tier (1000 writes/day).

**What's cached:**
- API keys (`apikey:{hash}`) - org ID, permissions, enabled, expiry
- Prompts (`prompt:{id}`) - id, name, description, org ID
- Versions (`version:{id}:{version}`) - version data, messages, config
- Usage counts (`usage:{orgId}:{period}`) - L1 only, 60s TTL
- Plan limits (`plan:{orgId}`) - L1 only, 5 min TTL

**TTL Strategy:**

| Data | L1 (In-Memory) | L2 (KV) |
|------|----------------|---------|
| API keys | 5 min | 5 min |
| Prompts | 5 min | 5 min |
| Version (specific) | 5 min | Indefinite |
| Version (latest) | 5 min | 5 min |
| Usage counts | 60s | N/A (L1 only) |
| Plan limits | 5 min | N/A (L1 only) |

- L1 always uses 5 min TTL (isolates recycle anyway)
- L2 uses 5 min for mutable data, indefinite for immutable (specific published versions can't change)

**Why separate prompt and version cache entries?**

Prompt metadata (name, orgId) and version content (messages, config) have different mutability:
- Prompt name *can* change → needs TTL to propagate updates
- Version content *can't* change once published → safe to cache indefinitely

If combined into one entry, we'd have to choose:
- 5 min TTL: loses the "cache forever" benefit for immutable version content
- Indefinite: prompt name changes would never propagate for specific version requests

Separate entries let us apply the right TTL to each. The tradeoff is 2 cache lookups per request instead of 1.

## Rate Limiting

Monthly API call limits per organization based on subscription plan:

| Plan | Monthly Limit |
|------|--------------|
| Free (no subscription) | 5,000 |
| Pro | 50,000 |

**How it works:**
1. After API key verification, `checkUsageLimit()` checks L1 cache (60s TTL) or D1 for current month's count
2. If limit exceeded → 429 response with `Retry-After` header and upgrade URL
3. On success → `ctx.waitUntil(incrementUsage())` fires D1 atomic upsert (fire-and-forget, no latency impact)
4. All successful responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers

**Usage tracking uses D1 only (no KV writes):**
- Atomic `INSERT ... ON CONFLICT UPDATE SET count = count + 1` handles concurrency
- D1 has 100K writes/day free tier (vs KV's 1K)
- L1 cache absorbs repeated checks within 60s window
- Plan limits cached in L1 with 5 min TTL (plan changes are rare)

**429 Response:**
```json
{
  "error": "Monthly API limit reached (5000/5000 calls). Upgrade to Pro for 50,000 calls/month.",
  "code": "USAGE_LIMIT_EXCEEDED",
  "usage": { "limit": 5000, "used": 5000, "remaining": 0, "resetAt": "2026-03-01T00:00:00.000Z" },
  "upgradeUrl": "https://app.promptlycms.com/settings?tab=billing"
}
```

**Check usage data:**
```bash
bunx wrangler d1 execute promptly --remote --command "SELECT * FROM api_usage ORDER BY updated_at DESC LIMIT 5;"
```

## API Endpoint

```
GET /prompts/:promptId?version=<optional-semver>
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "promptId": "...",
  "promptName": "...",
  "version": "1.0.0",
  "systemMessage": "...",
  "userMessage": "...",
  "config": { "model": "...", "temperature": 0.7, ... }
}
```

## Database Schema (from promptlycms.com)

**apikey** (Better Auth):
- `key` - SHA-256 hash (base64url, no padding)
- `user_id` → joined with `member` table to get `organization_id`
- `permissions` - JSON object: `{"prompt": ["read"]}`
- `enabled` - INTEGER (0/1)
- `expires_at` - INTEGER (unix ms) or NULL

**prompt**:
- `id`, `name`, `description`, `organization_id`
- `deleted_at` - soft delete (NULL = active)

**api_usage**:
- `organization_id` TEXT, `period` TEXT (`YYYY-MM`) - composite PK
- `count` INTEGER - atomic counter via upsert
- `created_at`, `updated_at` - INTEGER (unix ms)

**subscription**:
- `organization_id` - org-level billing
- `plan` - "free", "pro"
- `status` - "active", "trialing", "canceled", etc.

**prompt_version**:
- `major`, `minor`, `patch` - semver as integers
- `system_message`, `user_message` - prompt content
- `config` - JSON (model, temperature, schema, etc.)
- `published_at` - INTEGER (NULL = draft)

## Key Conventions

1. Use `.ts` file extensions in imports
2. Cache keys: `apikey:{hash}`, `prompt:{id}`, `version:{id}:{version|latest}`
3. API keys are SHA-256 hashed and stored as base64url
4. Permissions format: `{"resource": ["action1", "action2"]}`
5. Versions are stored as separate major/minor/patch integers
6. Usage cache keys: `usage:{orgId}:{YYYY-MM}`, `plan:{orgId}`
7. Usage tracking is fire-and-forget via `ctx.waitUntil()` - never blocks responses

## Code Style

- **No inline if statements** - always use braces and newlines
- **Types over interfaces** - use `type` unless extending is needed
- **Arrow functions** - use `const fn = () => {}` over `function fn() {}`
- **Tests require deployment** - smoke tests run against production API

---

## Learnings

### Better Auth API Key Storage

Better Auth stores API keys hashed, not in plaintext:
- Hash algorithm: SHA-256
- Encoding: base64url without padding
- The `key` column contains the hash, not the raw key
- `start` column shows the visible prefix (e.g., "promptly_XKCh")
- `prefix` column stores just the prefix (e.g., "promptly_")

```typescript
// Hash an API key to match Better Auth storage
async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

### Better Auth Permissions Format

Permissions are stored as nested JSON objects, NOT flat arrays:
```json
// Actual format (Better Auth)
{"prompt": ["read", "write"], "user": ["read"]}

// NOT this format
["prompt:read", "prompt:write", "user:read"]
```

To check permissions:
```typescript
function hasPermission(permissions: Record<string, string[]>, required: string): boolean {
  const [resource, action] = required.split(':');
  return permissions[resource]?.includes(action) ?? false;
}
```

### Organization ID Lookup

API keys belong to users, not organizations. To get the org:
```sql
SELECT a.*, m.organization_id
FROM apikey a
INNER JOIN member m ON a.user_id = m.user_id
WHERE a.key = ?
```

### Semver Storage

Versions are stored as separate integer columns, not strings:
- `major`, `minor`, `patch` - all INTEGER, nullable (NULL = draft)
- Order by: `ORDER BY major DESC, minor DESC, patch DESC`
- Format for response: `${major}.${minor}.${patch}`

### Published vs Draft

- No `published` boolean column
- Use `published_at IS NOT NULL` to check if published
- `published_at` is INTEGER (unix timestamp ms)

### Soft Deletes

Prompts use soft delete pattern:
- `deleted_at` column (INTEGER, unix timestamp ms)
- Filter with `WHERE deleted_at IS NULL`

### Testing Strategy

Production smoke tests are more valuable than unit tests with mocked Workers:
- Test the real deployed code and bindings
- Verify actual D1 schema works
- Catch configuration issues

Uses `bun test` (built-in runner) - no need for vitest or extra config.
Bun automatically loads `.env` files.

### KV Namespace Setup

- Only need production KV namespace (`bunx wrangler kv namespace create PROMPTS_CACHE`)
- NO preview namespace needed - wrangler simulates KV locally in-memory
- Don't use `--preview` flag unless you want remote staging storage

**Inspect cache entries:**
```bash
# List all keys for a prompt
bunx wrangler kv key list --binding=PROMPTS_CACHE --remote | jq '.[] | select(.name | contains("PROMPT_ID"))'

# Get a specific cache entry
bunx wrangler kv key get --binding=PROMPTS_CACHE "version:PROMPT_ID:1.0.0" --remote
```
Keys with `expiration` field have a TTL; keys without it are cached indefinitely.

### Logging in Workers

- `console.log` with JSON is optimal for Cloudflare Workers
- Pino adds overhead without benefits (its async features don't apply in Workers)
- Workers Logs captures console output automatically
- Structure logs as JSON for easy parsing: `console.log(JSON.stringify({event, key}))`

### Bundle Size

- Wrangler handles bundling/minification automatically via esbuild
- No separate build step needed
- Check size with: `bunx wrangler deploy --dry-run --outdir=dist`
- Current size: ~12KB / ~3.3KB gzipped (well under 1MB limit)

### D1 Queries

- Use `--remote` flag with wrangler d1 to query production
- SELECT queries don't modify data (check `"changes": 0` in output)
- Boolean columns are INTEGER (0/1) in SQLite
- Timestamps are INTEGER (unix ms), not strings

### Biome Configuration

- Schema version must match installed biome version
- `organizeImports` moved to `assist.actions.source.organizeImports` in v2.x
- `files.ignore` replaced with `files.includes` patterns
- Exclude `.claude/` directory from linting with specific includes

### TypeScript Native Preview

- Use `@typescript/native-preview` for fast type checking
- Provides `tsgo` binary
- Much faster than standard `tsc`

### KV Cache Behavior

- KV is **per-edge-location** - cache populated in London won't be immediately available in Dublin
- First request to any new edge location will always be a cache miss
- KV is eventually consistent - writes propagate to edges on-demand
- This means "cold" requests from new locations will be slower (~500ms vs ~150ms)

### Cache Write Timing

- Always `await` cache writes - fire-and-forget can cause misses
- Without await, the response may return before the write completes
- Subsequent requests may miss cache if the write wasn't finished

```typescript
// Wrong - may not complete before response
setInCache(kv, key, value);

// Correct - ensures write completes
await setInCache(kv, key, value);
```

### Performance Expectations

After optimization, typical latencies:
- **Warm request (all cache hits)**: ~140-180ms total
  - Worker processing: 1-11ms
  - Network overhead: ~130ms (TLS handshake + round trip)
- **Cold request (cache misses)**: ~400-600ms total
  - Includes D1 queries + cache writes

The ~130ms network overhead is unavoidable - it's TLS handshake + round trip latency. This is normal for HTTPS APIs.

### Client Connection Reuse

For clients calling from AWS Lambda, enable keep-alive to reduce TLS overhead:
```typescript
// Set environment variable
AWS_NODEJS_CONNECTION_REUSE_ENABLED=1

// Or create agent outside handler
const agent = new https.Agent({ keepAlive: true });
```

### KV Free Tier Limits

Cloudflare KV free tier has strict limits:
- **1,000 writes/day** (puts, deletes)
- **100,000 reads/day**

With short TTLs (60s), each cache expiry triggers new writes. At steady traffic, this exhausts the write limit quickly.

**Solution: Tiered Caching (L1 In-Memory + L2 KV)**

```typescript
// memory-cache.ts - Simple in-memory cache using Worker global scope
const cache = new Map<string, { data: unknown; expiresAt: number }>();

export const memoryCache = {
  get<T>(key: string): T | null {
    const entry = cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data as T;
  },
  set<T>(key: string, data: T, ttlSeconds: number): void {
    cache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};
```

**Why this works:**
- Worker isolates persist across multiple requests before recycling
- L1 catches repeated requests (same key within TTL)
- L2 (KV) only written on L1 miss + L2 miss
- If isolates handle ~50-100 requests, L1 reduces KV writes by 50-100x

**Key insight:** No max entries limit needed. Workers recycle isolates periodically, and TTL-based expiry handles cleanup. Memory pressure is unlikely given typical prompt sizes (~10KB each).

### Tiered Cache Implementation Pattern

```typescript
// cache.ts
export const getFromCache = async <T>(kv: KVNamespace, key: string): Promise<T | null> => {
  // L1 first
  const l1 = memoryCache.get<T>(key);
  if (l1 !== null) return l1;

  // L2 fallback
  const l2 = await kv.get(key, 'json') as T | null;
  if (l2 !== null) {
    memoryCache.set(key, l2, L1_TTL); // Promote to L1
  }
  return l2;
};

export const setInCache = async <T>(
  kv: KVNamespace,
  key: string,
  value: T,
  kvTtl?: number, // undefined = L1 only, 0 = infinite, >0 = TTL
): Promise<void> => {
  memoryCache.set(key, value, L1_TTL); // Always L1

  if (kvTtl !== undefined) { // Only write L2 if TTL specified
    const options = kvTtl > 0 ? { expirationTtl: kvTtl } : undefined;
    await kv.put(key, JSON.stringify(value), options);
  }
};
```

**API design:**
- `kvTtl: undefined` → L1 only (no KV write)
- `kvTtl: 0` → L1 + L2 infinite
- `kvTtl: 300` → L1 + L2 with 5 min TTL

This lets callers control whether to write to KV at all, useful for data that changes frequently.

### Local Development with Shared D1

The promptly-api worker shares a D1 database with the promptly app. For local development, use `--persist-to` to point at the promptly app's local D1 state:

```bash
bunx wrangler dev --persist-to /path/to/promptly/.wrangler/state
```

This avoids needing to maintain separate migrations or seed data in the API project. The path must point to the `state` directory (not `state/v3`).

**Running smoke tests locally:**
```bash
API_URL=http://localhost:8787 TEST_PROMPT_ID=<local-prompt-id> bun test
```

Note: The `TEST_PROMPT_ID` in `.env` is for production. Local D1 has different prompt IDs — query with:
```bash
cd ../promptly && bunx wrangler d1 execute promptly --local --command "SELECT id, name, organization_id FROM prompt WHERE deleted_at IS NULL;"
```

**API key matching:** The production `TEST_PROMPT_API_KEY` won't match local DB hashes unless you insert a matching entry. Hash the raw key and insert it:
```bash
# Hash the key
printf '%s' "$TEST_PROMPT_API_KEY" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='

# Insert into local DB with correct user_id for the org that owns the test prompt
cd ../promptly && bunx wrangler d1 execute promptly --local --command "INSERT INTO apikey (...) VALUES (...);"
```

**Important:** `source .env` does NOT reliably export vars for subshells. Use:
```bash
export $(grep -v '^#' .env | xargs)
```

### Testing Rate Limits Locally

To test rate limiting end-to-end, manipulate the `api_usage` table directly:

```bash
# Set usage near limit
cd ../promptly && bunx wrangler d1 execute promptly --local --command \
  "UPDATE api_usage SET count = 4999 WHERE organization_id = '<ORG_ID>' AND period = '2026-02';"
```

**L1 cache TTL (60s) matters:** After changing `api_usage` in D1, wait 60+ seconds before making a request. The worker's in-memory cache (`usage:{orgId}:{period}`) has a 60s TTL — requests within that window will use stale cached data.

**Test scenarios:**
1. Normal request → 200 with `X-RateLimit-*` headers
2. Verify `api_usage` row created with `count >= 1`
3. Set `count = limit - 1` → 200 with `X-RateLimit-Remaining: 1`
4. Set `count = limit` → 429 with `USAGE_LIMIT_EXCEEDED`
5. Clean up: `DELETE FROM api_usage WHERE ...`
