import { getFromCache, setInCache } from './cache.ts';
import type {
  CachedPrompt,
  Env,
  PromptRecord,
  PromptResponse,
  PromptVersionRecord,
} from './types.ts';

/**
 * Format semver from major/minor/patch columns
 */
const formatVersion = (
  major: number | null,
  minor: number | null,
  patch: number | null,
): string => {
  if (major === null) {
    return 'draft';
  }
  return `${major}.${minor ?? 0}.${patch ?? 0}`;
};

/**
 * Parse semver string into components
 */
const parseVersion = (
  version: string,
): { major: number; minor: number; patch: number } | null => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  const [, majorStr, minorStr, patchStr] = match;
  if (!majorStr || !minorStr || !patchStr) {
    return null;
  }
  return {
    major: Number.parseInt(majorStr, 10),
    minor: Number.parseInt(minorStr, 10),
    patch: Number.parseInt(patchStr, 10),
  };
};

/**
 * Fetch a prompt by ID with optional version
 */
export const fetchPrompt = async (
  env: Env,
  promptId: string,
  organizationId: string,
  version?: string,
): Promise<PromptResponse | { error: string; code: string }> => {
  const cacheKey = `prompt:${promptId}`;

  // Check cache for prompt metadata
  let cachedPrompt = await getFromCache<CachedPrompt>(
    env.PROMPTS_CACHE,
    cacheKey,
  );

  if (!cachedPrompt) {
    // Query D1 for prompt (exclude soft-deleted)
    const promptResult = await env.promptly
      .prepare(
        'SELECT id, organization_id, name, description FROM prompt WHERE id = ? AND deleted_at IS NULL',
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
    // Parse the requested version
    const parsed = parseVersion(version);
    if (!parsed) {
      return {
        error: 'Invalid version format. Use semver (e.g., 1.0.0)',
        code: 'BAD_REQUEST',
      };
    }

    // Fetch specific version (must be published)
    versionResult = await env.promptly
      .prepare(
        `SELECT id, prompt_id, major, minor, patch, system_message, user_message, config, published_at
				FROM prompt_version
				WHERE prompt_id = ? AND major = ? AND minor = ? AND patch = ? AND published_at IS NOT NULL`,
      )
      .bind(promptId, parsed.major, parsed.minor, parsed.patch)
      .first<PromptVersionRecord>();
  } else {
    // Fetch latest published version (ordered by semver)
    versionResult = await env.promptly
      .prepare(
        `SELECT id, prompt_id, major, minor, patch, system_message, user_message, config, published_at
				FROM prompt_version
				WHERE prompt_id = ? AND published_at IS NOT NULL
				ORDER BY major DESC, minor DESC, patch DESC
				LIMIT 1`,
      )
      .bind(promptId)
      .first<PromptVersionRecord>();
  }

  if (!versionResult) {
    return {
      error: version
        ? `Version ${version} not found`
        : 'No published version found',
      code: 'VERSION_NOT_FOUND',
    };
  }

  return {
    id: cachedPrompt.id,
    name: cachedPrompt.name,
    description: cachedPrompt.description,
    version: formatVersion(
      versionResult.major,
      versionResult.minor,
      versionResult.patch,
    ),
    systemMessage: versionResult.system_message,
    userMessage: versionResult.user_message,
    config: JSON.parse(versionResult.config) as Record<string, unknown>,
  };
};
