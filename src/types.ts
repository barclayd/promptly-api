/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
	promptly: D1Database;
	PROMPTS_CACHE: KVNamespace;
}

/**
 * API key record from D1 database
 */
export interface ApiKeyRecord {
	id: string;
	hashed_key: string;
	organization_id: string;
	permissions: string; // JSON array of permissions
	enabled: boolean;
	expires_at: string | null;
	created_at: string;
}

/**
 * Cached API key data
 */
export interface CachedApiKey {
	organizationId: string;
	permissions: string[];
	enabled: boolean;
	expiresAt: string | null;
}

/**
 * API key verification result
 */
export type ApiKeyResult =
	| { valid: true; organizationId: string; permissions: string[] }
	| { valid: false; code: 'INVALID_KEY' | 'DISABLED' | 'EXPIRED' | 'FORBIDDEN' };

/**
 * Prompt record from D1 database
 */
export interface PromptRecord {
	id: string;
	organization_id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * Prompt version record from D1 database
 */
export interface PromptVersionRecord {
	id: string;
	prompt_id: string;
	version: string; // semver string
	content: string;
	published: boolean;
	created_at: string;
}

/**
 * Cached prompt data
 */
export interface CachedPrompt {
	id: string;
	organizationId: string;
	name: string;
	description: string | null;
}

/**
 * API response for a prompt
 */
export interface PromptResponse {
	id: string;
	name: string;
	description: string | null;
	version: string;
	content: string;
}

/**
 * Error response
 */
export interface ErrorResponse {
	error: string;
	code: string;
}
