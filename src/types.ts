/**
 * Cloudflare Worker environment bindings
 */
export type Env = {
  promptly: D1Database;
  PROMPTS_CACHE: KVNamespace;
};

/**
 * API key with organization lookup result from D1 database
 */
export type ApiKeyWithOrgRecord = {
  id: string;
  key: string;
  user_id: string;
  permissions: string | null; // JSON array of permissions
  enabled: number; // 0 or 1
  expires_at: number | null; // unix timestamp ms
  organization_id: string; // from member table join
};

/**
 * Permissions format from Better Auth: {"resource": ["action1", "action2"]}
 */
export type PermissionsObject = Record<string, string[]>;

/**
 * Cached API key data
 */
export type CachedApiKey = {
  organizationId: string;
  permissions: PermissionsObject;
  enabled: boolean;
  expiresAt: number | null;
};

/**
 * API key verification result
 */
export type ApiKeyResult =
  | { valid: true; organizationId: string; permissions: PermissionsObject }
  | {
      valid: false;
      code: 'INVALID_KEY' | 'DISABLED' | 'EXPIRED' | 'FORBIDDEN';
    };

/**
 * Prompt record from D1 database
 */
export type PromptRecord = {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  deleted_at: number | null;
};

/**
 * Prompt version record from D1 database
 */
export type PromptVersionRecord = {
  id: string;
  prompt_id: string;
  major: number | null;
  minor: number | null;
  patch: number | null;
  system_message: string | null;
  user_message: string | null;
  config: string;
  published_at: number | null;
};

/**
 * Cached prompt data
 */
export type CachedPrompt = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
};

/**
 * Cached version data
 */
export type CachedVersion = {
  version: string;
  systemMessage: string | null;
  userMessage: string | null;
  config: Record<string, unknown>;
};

/**
 * API response for a prompt
 */
export type PromptResponse = {
  promptId: string;
  promptName: string;
  version: string;
  systemMessage: string | null;
  userMessage: string | null;
  config: Record<string, unknown>;
};

/**
 * Error response
 */
export type ErrorResponse = {
  error: string;
  code: string;
};
