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
  handler.ts         # Request routing + CORS
  verify-api-key.ts  # API key validation (SHA-256 + base64url)
  fetch-prompt.ts    # Prompt fetching logic
  cache.ts           # KV cache helpers
  types.ts           # TypeScript interfaces

test/
  smoke.test.ts      # Production smoke tests
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Database**: D1 (SQLite) - shared with promptlycms.com
- **Cache**: KV Namespace (60s TTL)
- **Auth**: Better Auth API Key plugin (SHA-256 hashed keys)

## Caching

**What's cached:**
- API keys (`apikey:{hash}`) - org ID, permissions, enabled, expiry (60s TTL)
- Prompts (`prompt:{id}`) - id, name, description, org ID (60s TTL)
- Versions (`version:{id}:{version}`) - version data, messages, config
  - Specific versions (e.g., `1.0.0`): **indefinite** (published versions can't be edited)
  - Latest (`version:{id}:latest`): 60s TTL

**Why separate prompt and version cache entries?**

Prompt metadata (name, orgId) and version content (messages, config) have different mutability:
- Prompt name *can* change → needs 60s TTL to propagate updates
- Version content *can't* change once published → safe to cache indefinitely

If combined into one entry, we'd have to choose:
- 60s TTL: loses the "cache forever" benefit for immutable version content
- Indefinite: prompt name changes would never propagate for specific version requests

Separate entries let us apply the right TTL to each. The tradeoff is 2 KV lookups per request instead of 1.

**TTL Strategy:**
- 60s for mutable data (API keys, prompt metadata, "latest" version pointer)
- Indefinite for immutable data (specific published versions)

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
- Current size: ~8KB / ~2.6KB gzipped (well under 1MB limit)

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
