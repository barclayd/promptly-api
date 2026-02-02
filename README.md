# Promptly API

> **Fetch your prompts at the edge.** A blazing-fast Cloudflare Worker that serves prompts from [promptlycms.com](https://promptlycms.com) with sub-200ms latency worldwide.

```
┌─────────────┐     ┌─────────────────┐     ┌──────────┐
│  Your App   │────▶│  Promptly API   │────▶│    D1    │
│  (Lambda,   │     │  (CF Workers)   │     │ Database │
│   Vercel,   │◀────│  + KV Cache     │◀────│          │
│   etc.)     │     └─────────────────┘     └──────────┘
└─────────────┘           ~150ms
```

## Quick Start

```bash
# Fetch a prompt
curl https://api.promptlycms.com/prompts/YOUR_PROMPT_ID \
  -H "Authorization: Bearer promptly_xxxxx"
```

<details>
<summary><b>Example Response</b></summary>

```json
{
  "promptId": "abc123",
  "promptName": "Customer Support Agent",
  "version": "2.1.0",
  "systemMessage": "You are a helpful customer support agent...",
  "userMessage": "Customer query: ${query}",
  "config": {
    "model": "claude-sonnet-4-20250514",
    "temperature": 0.7,
    "schema": [
      { "name": "query", "type": "string" }
    ]
  }
}
```

</details>

## Usage

### Fetch Latest Version

```typescript
const response = await fetch(
  'https://api.promptlycms.com/prompts/YOUR_PROMPT_ID',
  { headers: { Authorization: `Bearer ${PROMPTLY_API_KEY}` } }
);

const prompt = await response.json();
// Use prompt.systemMessage, prompt.userMessage, prompt.config
```

### Fetch Specific Version

Pin to a specific version for production stability:

```typescript
const response = await fetch(
  'https://api.promptlycms.com/prompts/YOUR_PROMPT_ID?version=2.1.0',
  { headers: { Authorization: `Bearer ${PROMPTLY_API_KEY}` } }
);
```

### Use with Claude

```typescript
import Anthropic from '@anthropic-ai/sdk';

const prompt = await fetchPrompt('my-prompt-id');

const message = await anthropic.messages.create({
  model: prompt.config.model,
  max_tokens: 1024,
  system: prompt.systemMessage,
  messages: [
    { role: 'user', content: interpolate(prompt.userMessage, variables) }
  ]
});
```

## API Reference

### `GET /prompts/:promptId`

| Parameter | Type | Description |
|-----------|------|-------------|
| `promptId` | path | The prompt ID from your Promptly dashboard |
| `version` | query | Optional. Semver version (e.g., `1.0.0`). Defaults to latest published. |

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <your-api-key>` |

### Response

```typescript
type PromptResponse = {
  promptId: string;
  promptName: string;
  version: string;          // e.g., "2.1.0"
  systemMessage: string | null;
  userMessage: string | null;
  config: {
    model?: string;
    temperature?: number;
    schema?: Array<{
      name: string;
      type: string;
    }>;
    // ... other config fields
  };
};
```

### Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `BAD_REQUEST` | Invalid version format |
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 401 | `DISABLED` | API key has been disabled |
| 401 | `EXPIRED` | API key has expired |
| 403 | `FORBIDDEN` | API key lacks `prompt:read` permission |
| 404 | `NOT_FOUND` | Prompt doesn't exist or belongs to another org |
| 404 | `VERSION_NOT_FOUND` | Specified version not published |
| 405 | `METHOD_NOT_ALLOWED` | Only GET requests allowed |

## Performance

```
┌────────────────────────────────────────────────────────┐
│ Warm Request (cache hit)                               │
├────────────────────────────────────────────────────────┤
│ ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 140-180ms        │
│ └─ Worker: 1-11ms  Network: ~130ms                     │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ Cold Request (cache miss)                              │
├────────────────────────────────────────────────────────┤
│ ████████████████████░░░░░░░░░░░░░░░░ 400-600ms        │
│ └─ D1 queries + cache population                       │
└────────────────────────────────────────────────────────┘
```

**Caching Strategy:**
- API keys, prompt metadata, "latest" pointer: 60s TTL
- Specific versions (e.g., `?version=1.0.0`): cached indefinitely

**Pro tip:** Pin to a specific version in production for maximum cache hits.

## Client Libraries

### TypeScript/JavaScript

```typescript
class PromptlyClient {
  constructor(private apiKey: string) {}

  async getPrompt(promptId: string, version?: string) {
    const url = new URL(`https://api.promptlycms.com/prompts/${promptId}`);
    if (version) url.searchParams.set('version', version);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(`${error.code}: ${error.message}`);
    }

    return res.json();
  }
}

// Usage
const client = new PromptlyClient(process.env.PROMPTLY_API_KEY);
const prompt = await client.getPrompt('my-prompt-id', '2.1.0');
```

### Python

```python
import httpx

class PromptlyClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.promptlycms.com"

    def get_prompt(self, prompt_id: str, version: str = None) -> dict:
        url = f"{self.base_url}/prompts/{prompt_id}"
        params = {"version": version} if version else {}

        response = httpx.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {self.api_key}"}
        )
        response.raise_for_status()
        return response.json()

# Usage
client = PromptlyClient(os.environ["PROMPTLY_API_KEY"])
prompt = client.get_prompt("my-prompt-id", "2.1.0")
```

### AWS Lambda (with connection reuse)

```typescript
import https from 'https';

// Create agent OUTSIDE handler for connection reuse
const agent = new https.Agent({ keepAlive: true });

export const handler = async (event) => {
  // Enable globally (recommended)
  process.env.AWS_NODEJS_CONNECTION_REUSE_ENABLED = '1';

  const response = await fetch(
    `https://api.promptlycms.com/prompts/${event.promptId}`,
    { headers: { Authorization: `Bearer ${process.env.PROMPTLY_API_KEY}` } }
  );

  return response.json();
};
```

## Development

```bash
# Install dependencies
bun install

# Start local dev server
bun run dev

# Run checks (types + lint + tests)
bun run check

# Deploy to Cloudflare
bun run deploy
```

### Environment Setup

```bash
# .env (for testing)
TEST_PROMPT_API_KEY=promptly_xxxxx
TEST_PROMPT_ID=your-test-prompt-id  # Optional
```

### Architecture

```
src/
├── index.ts           # Worker entry point
├── handler.ts         # Request routing + CORS
├── verify-api-key.ts  # Auth (SHA-256 hash verification)
├── fetch-prompt.ts    # Prompt fetching + caching
├── cache.ts           # KV cache helpers
└── types.ts           # TypeScript types

test/
└── smoke.test.ts      # Production smoke tests
```

## FAQ

<details>
<summary><b>Why is my first request slow?</b></summary>

First requests to a new edge location (or with a new API key) will be slower (~400-600ms) because the cache is cold. Subsequent requests from the same location will be fast (~150ms).

Cloudflare KV is eventually consistent - cache populated in London won't be immediately available in Tokyo.

</details>

<details>
<summary><b>Should I pin to a specific version?</b></summary>

**In production: Yes.** Specific versions are cached indefinitely, giving you:
- Maximum cache hits
- Predictable prompt content
- No surprises when someone edits the prompt

**In development: No.** Use the latest version to always get fresh changes.

</details>

<details>
<summary><b>How do I invalidate the cache?</b></summary>

You don't need to. Cache entries have appropriate TTLs:
- "Latest" version: 60s (changes propagate within a minute)
- Specific versions: indefinite (content can't change once published)

</details>

<details>
<summary><b>What's the rate limit?</b></summary>

Currently no rate limiting. The API is designed to handle high throughput via edge caching. If you're seeing issues, reach out.

</details>

## License

MIT

---

<p align="center">
  Built with Cloudflare Workers, D1, and KV<br>
  <a href="https://promptlycms.com">promptlycms.com</a>
</p>
