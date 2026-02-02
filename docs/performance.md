# Performance Analysis

## Baseline Measurements

Tested from local machine to `api.promptlycms.com` (D1 in Western Europe).

### Latency Breakdown

| Scenario | Latency | Notes |
|----------|---------|-------|
| No auth (401, no D1) | 100-170ms | Base Worker + network |
| Invalid auth (1 D1 query) | 165-210ms | + API key lookup |
| Full request (cache warm) | 170-250ms | + version query |
| Cold start + cache miss | 400-500ms | First request penalty |

### Component Analysis

```
Total Request: ~200ms
├── Network/TLS: ~60-100ms (client → edge)
├── Worker execution: ~20-40ms
├── KV lookup: ~5-10ms (when cached)
└── D1 query: ~50-70ms per query
```

## Current Request Flow

```
1. Parse request, extract auth     ~1ms
2. Hash API key (SHA-256)          ~1ms
3. KV lookup: apikey:{hash}        ~5-10ms
4. [MISS] D1: apikey JOIN member   ~50-70ms
5. KV lookup: prompt:{id}          ~5-10ms
6. [MISS] D1: SELECT prompt        ~50-70ms
7. D1: SELECT prompt_version       ~50-70ms (always, not cached)
8. JSON serialize response         ~1ms
```

**Best case (all cached):** Steps 3, 5, 7 = ~60-90ms Worker time
**Worst case (cold):** All steps = ~150-210ms Worker time

## Optimizations Enabled

### Smart Placement ✅

```jsonc
"placement": { "mode": "smart" }
```

- Places Worker closer to D1 (Western Europe)
- Takes ~15 minutes to optimize after deployment
- Reduces D1 round-trip latency

### Observability ✅

```jsonc
"observability": { "enabled": true }
```

- Enables Workers Logs for debugging
- Tracks cache hit/miss rates

## Potential Optimizations

### 1. Parallel Cache Lookups

**Current:** Sequential KV lookups
```typescript
const apiKey = await getFromCache('apikey:...');  // wait
const prompt = await getFromCache('prompt:...');   // then wait
```

**Optimized:** Parallel lookups
```typescript
const [apiKey, prompt] = await Promise.all([
  getFromCache('apikey:...'),
  getFromCache('prompt:...'),
]);
```

**Impact:** Save ~5-10ms on cache hits

### 2. Combined D1 Query

**Current:** Separate prompt + version queries (2 round trips)

**Optimized:** Single JOIN query
```sql
SELECT p.id, p.name, p.description, p.organization_id,
       v.major, v.minor, v.patch, v.system_message, v.user_message, v.config
FROM prompt p
JOIN prompt_version v ON p.id = v.prompt_id
WHERE p.id = ? AND p.deleted_at IS NULL AND v.published_at IS NOT NULL
ORDER BY v.major DESC, v.minor DESC, v.patch DESC
LIMIT 1
```

**Impact:** Save ~50-70ms on cache miss

### 3. Cache Prompt Versions

**Current:** Versions always fetched from D1

**Trade-off:**
- Pro: Save D1 query on every request
- Con: Stale versions for up to 60s after publish
- Con: Larger cache entries (system/user messages can be large)

**Recommendation:** Keep current approach unless latency is critical

### 4. D1 Read Replicas

Cloudflare D1 supports [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) for global distribution.

**Requirements:**
- Use D1 Sessions API
- Read-only queries automatically routed to nearest replica

**Impact:** Could reduce D1 latency significantly for users far from WEUR

## Benchmarks by Region

| Client Location | Expected Latency | Notes |
|-----------------|------------------|-------|
| Western Europe | 100-150ms | Closest to D1 |
| Eastern US | 150-250ms | Cross-Atlantic |
| Asia Pacific | 250-400ms | Longest route |

## Recommendations

### Quick Wins (No Code Changes)

1. ✅ **Smart Placement** - Already enabled
2. ✅ **Observability** - Already enabled
3. ⏳ **Monitor** - Wait for Smart Placement to optimize (~15min)

### Medium Effort

4. **Parallel cache lookups** - ~5-10ms improvement
5. **Combined D1 query** - ~50-70ms on cache miss

### Higher Effort

6. **D1 Read Replicas** - Requires Sessions API migration
7. **Edge caching versions** - Trade freshness for speed

## Monitoring

### Cache Hit Rate

Check Workers Logs for:
```json
{"event": "cache_hit", "key": "apikey:..."}
{"event": "cache_miss", "key": "prompt:..."}
```

Target: >90% cache hit rate for API keys, >80% for prompts

### P99 Latency

Use Cloudflare Analytics to track:
- P50 (median): Target <200ms
- P99: Target <500ms
- Error rate: Target <0.1%

## Sources

- [Cloudflare Workers CPU Performance](https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/)
- [Workers KV 3x Faster](https://blog.cloudflare.com/faster-workers-kv/)
- [Smart Placement Docs](https://developers.cloudflare.com/workers/configuration/smart-placement/)
- [D1 40-60% Faster (Jan 2025)](https://developers.cloudflare.com/changelog/2025-01-07-d1-faster-query/)
- [Eliminating Cold Starts](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)
