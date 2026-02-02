import { getFromCache, setInCache } from './cache.ts';
import type {
  CachedPrompt,
  CachedVersion,
  Env,
  PromptRecord,
  PromptResponse,
  PromptVersionRecord,
} from './types.ts';

// TTL for "latest" version cache (seconds)
const LATEST_VERSION_TTL = 60;

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
 * Build the version query based on whether a specific version is requested
 */
const buildVersionQuery = (
  env: Env,
  promptId: string,
  parsedVersion?: { major: number; minor: number; patch: number },
): D1PreparedStatement => {
  if (parsedVersion) {
    return env.promptly
      .prepare(
        `SELECT id, prompt_id, major, minor, patch, system_message, user_message, config, published_at
        FROM prompt_version
        WHERE prompt_id = ? AND major = ? AND minor = ? AND patch = ? AND published_at IS NOT NULL`,
      )
      .bind(
        promptId,
        parsedVersion.major,
        parsedVersion.minor,
        parsedVersion.patch,
      );
  }
  return env.promptly
    .prepare(
      `SELECT id, prompt_id, major, minor, patch, system_message, user_message, config, published_at
      FROM prompt_version
      WHERE prompt_id = ? AND published_at IS NOT NULL
      ORDER BY major DESC, minor DESC, patch DESC
      LIMIT 1`,
    )
    .bind(promptId);
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
  // Parse version early to fail fast on invalid format
  let parsedVersion:
    | { major: number; minor: number; patch: number }
    | undefined;
  if (version) {
    const parsed = parseVersion(version);
    if (!parsed) {
      return {
        error: 'Invalid version format. Use semver (e.g., 1.0.0)',
        code: 'BAD_REQUEST',
      };
    }
    parsedVersion = parsed;
  }

  // Build cache keys
  const promptCacheKey = `prompt:${promptId}`;
  const versionCacheKey = version
    ? `version:${promptId}:${version}`
    : `version:${promptId}:latest`;

  // Check cache for prompt and version in parallel
  const [cachedPrompt, cachedVersion] = await Promise.all([
    getFromCache<CachedPrompt>(env.PROMPTS_CACHE, promptCacheKey),
    getFromCache<CachedVersion>(env.PROMPTS_CACHE, versionCacheKey),
  ]);

  let promptData: CachedPrompt;
  let versionData: CachedVersion | null;

  if (cachedPrompt && cachedVersion) {
    // Both cached - no D1 queries needed
    promptData = cachedPrompt;
    versionData = cachedVersion;
  } else if (cachedPrompt && !cachedVersion) {
    // Prompt cached, need version from D1
    promptData = cachedPrompt;
    const versionResult = await buildVersionQuery(
      env,
      promptId,
      parsedVersion,
    ).first<PromptVersionRecord>();

    if (versionResult) {
      versionData = {
        version: formatVersion(
          versionResult.major,
          versionResult.minor,
          versionResult.patch,
        ),
        systemMessage: versionResult.system_message,
        userMessage: versionResult.user_message,
        config: JSON.parse(versionResult.config) as Record<string, unknown>,
      };
      // Cache version: indefinitely for specific versions, 60s for latest
      const ttl = version ? 0 : LATEST_VERSION_TTL;
      await setInCache(env.PROMPTS_CACHE, versionCacheKey, versionData, ttl);
    } else {
      versionData = null;
    }
  } else {
    // Need both from D1 - fetch in parallel
    const [promptResult, versionResult] = await Promise.all([
      env.promptly
        .prepare(
          'SELECT id, organization_id, name, description FROM prompt WHERE id = ? AND deleted_at IS NULL',
        )
        .bind(promptId)
        .first<PromptRecord>(),
      buildVersionQuery(
        env,
        promptId,
        parsedVersion,
      ).first<PromptVersionRecord>(),
    ]);

    if (!promptResult) {
      return { error: 'Prompt not found', code: 'NOT_FOUND' };
    }

    promptData = {
      id: promptResult.id,
      organizationId: promptResult.organization_id,
      name: promptResult.name,
      description: promptResult.description,
    };

    // Build version data before caching
    if (versionResult) {
      versionData = {
        version: formatVersion(
          versionResult.major,
          versionResult.minor,
          versionResult.patch,
        ),
        systemMessage: versionResult.system_message,
        userMessage: versionResult.user_message,
        config: JSON.parse(versionResult.config) as Record<string, unknown>,
      };
      // Cache both in parallel
      const ttl = version ? 0 : LATEST_VERSION_TTL;
      await Promise.all([
        setInCache(env.PROMPTS_CACHE, promptCacheKey, promptData),
        setInCache(env.PROMPTS_CACHE, versionCacheKey, versionData, ttl),
      ]);
    } else {
      versionData = null;
      // Still cache prompt
      await setInCache(env.PROMPTS_CACHE, promptCacheKey, promptData);
    }
  }

  // Verify organization match
  if (promptData.organizationId !== organizationId) {
    return { error: 'Prompt not found', code: 'NOT_FOUND' };
  }

  if (!versionData) {
    return {
      error: version
        ? `Version ${version} not found`
        : 'No published version found',
      code: 'VERSION_NOT_FOUND',
    };
  }

  return {
    promptId: promptData.id,
    promptName: promptData.name,
    version: versionData.version,
    systemMessage: versionData.systemMessage,
    userMessage: versionData.userMessage,
    config: versionData.config,
  };
};
