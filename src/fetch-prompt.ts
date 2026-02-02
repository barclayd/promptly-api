import { getFromCache, setInCache } from './cache.ts';
import type {
	CachedPrompt,
	Env,
	PromptRecord,
	PromptResponse,
	PromptVersionRecord,
} from './types.ts';

/**
 * Fetch a prompt by ID with optional version
 */
export async function fetchPrompt(
	env: Env,
	promptId: string,
	organizationId: string,
	version?: string,
): Promise<PromptResponse | { error: string; code: string }> {
	const cacheKey = `prompt:${promptId}`;

	// Check cache for prompt metadata
	let cachedPrompt = await getFromCache<CachedPrompt>(env.PROMPTS_CACHE, cacheKey);

	if (!cachedPrompt) {
		// Query D1 for prompt
		const promptResult = await env.DB.prepare(
			'SELECT id, organization_id, name, description FROM prompt WHERE id = ?',
		)
			.bind(promptId)
			.first<PromptRecord>();

		if (!promptResult) {
			return { error: 'Prompt not found', code: 'NOT_FOUND' };
		}

		cachedPrompt = {
			id: promptResult.id,
			organizationId: promptResult.organization_id,
			name: promptResult.name,
			description: promptResult.description,
		};

		await setInCache(env.PROMPTS_CACHE, cacheKey, cachedPrompt);
	}

	// Verify organization match
	if (cachedPrompt.organizationId !== organizationId) {
		return { error: 'Prompt not found', code: 'NOT_FOUND' };
	}

	// Fetch the version
	let versionResult: PromptVersionRecord | null;

	if (version) {
		// Fetch specific version
		versionResult = await env.DB.prepare(
			'SELECT id, prompt_id, version, content, published FROM prompt_version WHERE prompt_id = ? AND version = ? AND published = 1',
		)
			.bind(promptId, version)
			.first<PromptVersionRecord>();
	} else {
		// Fetch latest published version (ordered by semver parts)
		versionResult = await env.DB.prepare(`
			SELECT id, prompt_id, version, content, published
			FROM prompt_version
			WHERE prompt_id = ? AND published = 1
			ORDER BY
				CAST(SUBSTR(version, 1, INSTR(version, '.') - 1) AS INTEGER) DESC,
				CAST(SUBSTR(SUBSTR(version, INSTR(version, '.') + 1), 1, INSTR(SUBSTR(version, INSTR(version, '.') + 1), '.') - 1) AS INTEGER) DESC,
				CAST(SUBSTR(version, INSTR(version, '.', INSTR(version, '.') + 1) + 1) AS INTEGER) DESC
			LIMIT 1
		`)
			.bind(promptId)
			.first<PromptVersionRecord>();
	}

	if (!versionResult) {
		return {
			error: version ? `Version ${version} not found` : 'No published version found',
			code: 'VERSION_NOT_FOUND',
		};
	}

	return {
		id: cachedPrompt.id,
		name: cachedPrompt.name,
		description: cachedPrompt.description,
		version: versionResult.version,
		content: versionResult.content,
	};
}
