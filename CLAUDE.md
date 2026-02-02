# Promptly API Worker

Cloudflare Worker API for serving prompts from promptlycms.com.

## Quick Commands

```bash
bun run dev       # Start local dev server
bun run test      # Run tests
bun run lint      # Check code style
bun run types     # Type check
bun run check     # Run all checks (types + lint + test)
bun run deploy    # Deploy to Cloudflare
```

## Project Structure

```
src/
  index.ts           # Worker entry point
  handler.ts         # Request routing + CORS
  verify-api-key.ts  # API key validation
  fetch-prompt.ts    # Prompt fetching logic
  cache.ts           # KV cache helpers
  types.ts           # TypeScript interfaces

test/
  *.test.ts          # Vitest tests
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Database**: D1 (SQLite)
- **Cache**: KV Namespace (60s TTL)
- **Bundler**: Wrangler (esbuild under the hood)

## API Endpoint

```
GET /prompts/:promptId?version=<optional-semver>
Authorization: Bearer <api_key>
```

## Database Tables

- `apikey` - API keys with hashed_key, organization_id, permissions
- `prompt` - Prompts with organization_id, name, description
- `prompt_version` - Versions with semver, content, published flag

## Key Conventions

1. Use `.ts` file extensions in imports
2. Cache keys: `apikey:{hash}`, `prompt:{id}`
3. Permissions are JSON arrays: `["prompt:read", "prompt:write"]`
4. API keys are SHA-256 hashed before storage/lookup

## Setup Requirements

After cloning, create KV namespaces:
```bash
bunx wrangler kv:namespace create PROMPTS_CACHE
bunx wrangler kv:namespace create PROMPTS_CACHE --preview
```
Then update `wrangler.jsonc` with the returned IDs.
