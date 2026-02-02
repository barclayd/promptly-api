# Caching Strategy

## Overview

The Promptly API uses Cloudflare KV as a caching layer between the API and D1 database. This reduces database load and improves response times for frequently accessed data.

## What's Cached

### 1. API Keys (`apikey:{hash}`)

**Cached data:**
```typescript
{
  organizationId: string;
  permissions: { [resource: string]: string[] };
  enabled: boolean;
  expiresAt: number | null;
}
```

**Why cache API keys?**
- Every request requires authentication
- API key validation involves a JOIN query (apikey → member)
- The same key is used repeatedly by the same client
- Key data rarely changes (permissions, enabled status)

### 2. Prompts (`prompt:{id}`)

**Cached data:**
```typescript
{
  id: string;
  organizationId: string;
  name: string;
  description: string;
}
```

**Why cache prompts?**
- Prompt metadata (name, description) rarely changes
- Organization ID check happens on every request
- Reduces D1 queries for popular prompts

## What's NOT Cached

### Prompt Versions

Versions are always fetched fresh from D1. Reasons:

1. **Freshness matters** - When a user publishes a new version, they expect it to be immediately available
2. **Version queries are specific** - Either fetching latest or a specific semver, both are simple indexed queries
3. **Content is large** - System/user messages and config would bloat the cache

## Cache Keys

| Data | Key Pattern | Example |
|------|-------------|---------|
| API Key | `apikey:{sha256-base64url}` | `apikey:abc123...` |
| Prompt | `prompt:{id}` | `prompt:JPxlUpstuhXB5OwOtKPpj` |

## TTL Strategy

All cache entries use a **60-second TTL**.

### Why 60 Seconds?

| Consideration | How 60s Addresses It |
|---------------|---------------------|
| **Change propagation** | Updates visible within 1 minute without explicit invalidation |
| **Burst traffic** | Handles spikes without hammering D1 |
| **Simplicity** | No invalidation logic, no cache busting endpoints |
| **Stale data risk** | Worst case: 60s of stale data, acceptable for most use cases |

### Alternative Approaches Considered

**Longer TTL (5-15 minutes):**
- Pro: Better cache hit rate
- Con: Changes take too long to propagate
- Con: Would need explicit invalidation from CMS

**Shorter TTL (10-30 seconds):**
- Pro: Faster change propagation
- Con: More D1 queries under load
- Con: Diminishing returns on cache benefits

**No TTL (manual invalidation):**
- Pro: Always fresh after explicit invalidation
- Con: Requires CMS to call invalidation endpoint
- Con: Complex coordination between systems
- Con: Risk of stale data if invalidation fails

## Request Flow

### Cache Hit
```
Request
  → Extract API key
  → Hash key (SHA-256)
  → Check KV: apikey:{hash}
  → HIT: Use cached permissions/org
  → Check KV: prompt:{id}
  → HIT: Use cached metadata
  → Query D1: prompt_version (always fresh)
  → Return response
```

### Cache Miss
```
Request
  → Extract API key
  → Hash key (SHA-256)
  → Check KV: apikey:{hash}
  → MISS: Query D1 (apikey JOIN member)
  → Cache result (60s TTL)
  → Check KV: prompt:{id}
  → MISS: Query D1 (prompt)
  → Cache result (60s TTL)
  → Query D1: prompt_version (always fresh)
  → Return response
```

## Observability

Cache operations are logged as JSON for Workers Logs:

```json
{"event": "cache_hit", "key": "apikey:abc123..."}
{"event": "cache_miss", "key": "prompt:JPxlUpstuhXB5OwOtKPpj"}
{"event": "cache_set", "key": "prompt:JPxlUpstuhXB5OwOtKPpj", "ttl": 60}
```

## Trade-offs

### Accepted Trade-offs

1. **Stale reads possible** - A disabled API key may work for up to 60s after being disabled
2. **No immediate invalidation** - CMS changes take up to 60s to reflect
3. **Memory usage** - KV stores redundant data across edge locations

### Mitigations

1. **Critical operations** - If immediate API key revocation is needed, consider a deny-list approach
2. **User expectations** - Document that changes may take up to 1 minute to propagate
3. **Monitoring** - Track cache hit rates to ensure strategy is effective

## Future Considerations

If requirements change, consider:

- **Cache invalidation endpoint** - CMS calls API to bust specific cache keys
- **Tiered TTL** - Shorter TTL for API keys (security), longer for prompts (stability)
- **Cache warming** - Pre-populate cache for high-traffic prompts
- **Conditional caching** - Only cache prompts with high request rates
