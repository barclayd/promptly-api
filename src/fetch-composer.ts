import { getFromCache, L2_TTL, setInCache } from './cache.ts';
import { formatVersion, parseVersion } from './fetch-prompt.ts';
import { parseComposerContent } from './parse-composer-content.ts';
import type {
  CachedComposerAssembled,
  ComposerPublishedVersion,
  ComposerRecord,
  ComposerResponse,
  ComposerSegment,
  ComposerVersionPromptRecord,
  ComposerVersionRecord,
  Env,
} from './types.ts';

const LATEST_VERSION_TTL = L2_TTL;

type PromptWithVersion = {
  id: string;
  name: string;
  version_id: string;
  major: number | null;
  minor: number | null;
  patch: number | null;
  system_message: string | null;
  user_message: string | null;
  config: string;
};

/**
 * Resolve all unique prompts referenced in a composer version.
 * Uses D1 batch to resolve all prompts in a single round trip.
 * Returns a map of promptId → resolved prompt data, or an error.
 */
const resolvePrompts = async (
  env: Env,
  uniquePromptIds: string[],
  junctionMap: Map<string, string | null>,
  organizationId: string,
): Promise<
  | { ok: true; prompts: Map<string, PromptWithVersion> }
  | { ok: false; error: string }
> => {
  if (uniquePromptIds.length === 0) {
    return { ok: true, prompts: new Map() };
  }

  // Build batch queries: for each prompt, resolve based on junction pin
  const queries: D1PreparedStatement[] = [];
  const queryPromptIds: string[] = [];

  for (const promptId of uniquePromptIds) {
    const pinnedVersionId = junctionMap.get(promptId);

    if (pinnedVersionId) {
      // Pinned: fetch specific version
      queries.push(
        env.promptly
          .prepare(
            `SELECT p.id, p.name, pv.id AS version_id, pv.major, pv.minor, pv.patch,
                    pv.system_message, pv.user_message, pv.config
             FROM prompt p
             INNER JOIN prompt_version pv ON pv.prompt_id = p.id
             WHERE p.id = ? AND p.deleted_at IS NULL
               AND p.organization_id = ?
               AND pv.id = ? AND pv.published_at IS NOT NULL`,
          )
          .bind(promptId, organizationId, pinnedVersionId),
      );
    } else {
      // Auto-update or no pin: fetch latest published
      queries.push(
        env.promptly
          .prepare(
            `SELECT p.id, p.name, pv.id AS version_id, pv.major, pv.minor, pv.patch,
                    pv.system_message, pv.user_message, pv.config
             FROM prompt p
             INNER JOIN prompt_version pv ON pv.prompt_id = p.id
             WHERE p.id = ? AND p.deleted_at IS NULL
               AND p.organization_id = ?
               AND pv.published_at IS NOT NULL
             ORDER BY pv.major DESC, pv.minor DESC, pv.patch DESC
             LIMIT 1`,
          )
          .bind(promptId, organizationId),
      );
    }
    queryPromptIds.push(promptId);
  }

  const batchResults = await env.promptly.batch(queries);
  const prompts = new Map<string, PromptWithVersion>();

  for (let i = 0; i < batchResults.length; i++) {
    const result = batchResults[i] as D1Result;
    const promptId = queryPromptIds[i] as string;

    if (!result.results || result.results.length === 0) {
      // Look up prompt name for a helpful error message
      const promptRecord = await env.promptly
        .prepare(
          'SELECT name FROM prompt WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        )
        .bind(promptId, organizationId)
        .first<{ name: string }>();

      const error = promptRecord
        ? `Referenced prompt "${promptRecord.name}" (${promptId}) has no published version`
        : `Referenced prompt "${promptId}" not found or not accessible`;

      return { ok: false, error };
    }

    const row = result.results[0] as unknown as PromptWithVersion;
    prompts.set(promptId, row);
  }

  return { ok: true, prompts };
};

/**
 * Build the resolved segments array from parsed content and prompt data.
 */
const buildSegments = (
  parsedSegments: Array<
    { type: 'static'; content: string } | { type: 'prompt'; promptId: string }
  >,
  promptMap: Map<string, PromptWithVersion>,
): ComposerSegment[] => {
  return parsedSegments.map((segment) => {
    if (segment.type === 'static') {
      return segment;
    }

    const prompt = promptMap.get(segment.promptId);
    if (!prompt) {
      // Should not happen since resolvePrompts validates all prompts
      return {
        type: 'prompt' as const,
        promptId: segment.promptId,
        promptName: segment.promptId,
        version: 'unknown',
        systemMessage: null,
        userMessage: null,
        config: {},
      };
    }

    return {
      type: 'prompt' as const,
      promptId: prompt.id,
      promptName: prompt.name,
      version: formatVersion(prompt.major, prompt.minor, prompt.patch),
      systemMessage: prompt.system_message,
      userMessage: prompt.user_message,
      config: JSON.parse(prompt.config || '{}') as Record<string, unknown>,
    };
  });
};

/**
 * Fetch a single composer by ID with optional version
 */
export const fetchComposer = async (
  env: Env,
  composerId: string,
  organizationId: string,
  version?: string,
): Promise<ComposerResponse | { error: string; code: string }> => {
  // Parse version early to fail fast
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

  // Check cache
  const cacheKey = version
    ? `composer:${composerId}:${version}`
    : `composer:${composerId}:latest`;

  const cached = await getFromCache<CachedComposerAssembled>(
    env.PROMPTS_CACHE,
    cacheKey,
  );

  if (cached) {
    if (cached.organizationId !== organizationId) {
      return { error: 'Composer not found', code: 'NOT_FOUND' };
    }
    return {
      composerId: cached.composerId,
      composerName: cached.composerName,
      version: cached.version,
      config: cached.config,
      segments: cached.segments,
    };
  }

  // Fetch composer + version from D1
  const composer = await env.promptly
    .prepare(
      'SELECT id, organization_id, name, description FROM composer WHERE id = ? AND deleted_at IS NULL',
    )
    .bind(composerId)
    .first<ComposerRecord>();

  if (!composer) {
    return { error: 'Composer not found', code: 'NOT_FOUND' };
  }

  if (composer.organization_id !== organizationId) {
    return { error: 'Composer not found', code: 'NOT_FOUND' };
  }

  // Resolve composer version
  let composerVersion: ComposerVersionRecord | null = null;

  if (parsedVersion) {
    composerVersion = await env.promptly
      .prepare(
        `SELECT id, composer_id, major, minor, patch, content, config, published_at
         FROM composer_version
         WHERE composer_id = ? AND major = ? AND minor = ? AND patch = ? AND published_at IS NOT NULL`,
      )
      .bind(
        composerId,
        parsedVersion.major,
        parsedVersion.minor,
        parsedVersion.patch,
      )
      .first<ComposerVersionRecord>();
  } else {
    composerVersion = await env.promptly
      .prepare(
        `SELECT id, composer_id, major, minor, patch, content, config, published_at
         FROM composer_version
         WHERE composer_id = ? AND published_at IS NOT NULL
         ORDER BY major DESC, minor DESC, patch DESC
         LIMIT 1`,
      )
      .bind(composerId)
      .first<ComposerVersionRecord>();
  }

  if (!composerVersion) {
    return {
      error: version
        ? `Version ${version} not found`
        : 'No published version found',
      code: 'VERSION_NOT_FOUND',
    };
  }

  // Parse content into segments
  const content = composerVersion.content ?? '';
  const parsedSegments = parseComposerContent(content);

  // Get unique prompt IDs
  const uniquePromptIds = [
    ...new Set(
      parsedSegments
        .filter(
          (
            s,
          ): s is Extract<
            (typeof parsedSegments)[number],
            { type: 'prompt' }
          > => s.type === 'prompt',
        )
        .map((s) => s.promptId),
    ),
  ];

  // Fetch junction entries
  const junctionResult = await env.promptly
    .prepare(
      'SELECT prompt_id, prompt_version_id FROM composer_version_prompt WHERE composer_version_id = ?',
    )
    .bind(composerVersion.id)
    .all<ComposerVersionPromptRecord>();

  const junctionMap = new Map<string, string | null>();
  for (const row of junctionResult.results ?? []) {
    junctionMap.set(row.prompt_id, row.prompt_version_id);
  }

  // Resolve all prompts
  const resolveResult = await resolvePrompts(
    env,
    uniquePromptIds,
    junctionMap,
    organizationId,
  );

  if (!resolveResult.ok) {
    return { error: resolveResult.error, code: 'UNRESOLVED_PROMPT' };
  }

  const segments = buildSegments(parsedSegments, resolveResult.prompts);
  const versionStr = formatVersion(
    composerVersion.major,
    composerVersion.minor,
    composerVersion.patch,
  );
  const config = JSON.parse(composerVersion.config || '{}') as Record<
    string,
    unknown
  >;

  // Cache the assembled response
  const cacheValue: CachedComposerAssembled = {
    composerId: composer.id,
    composerName: composer.name,
    organizationId: composer.organization_id,
    version: versionStr,
    config,
    segments,
  };

  const kvTtl = version ? 0 : LATEST_VERSION_TTL;
  await setInCache(env.PROMPTS_CACHE, cacheKey, cacheValue, kvTtl);

  return {
    composerId: composer.id,
    composerName: composer.name,
    version: versionStr,
    config,
    segments,
  };
};

/**
 * Fetch all composers for an organization with their latest published versions
 */
export const fetchComposers = async (
  env: Env,
  organizationId: string,
  includeVersions = false,
): Promise<ComposerResponse[] | { error: string; code: string }> => {
  // Get all composers with their latest published version
  const composersResult = await env.promptly
    .prepare(
      `SELECT c.id, c.name,
              cv.id AS version_id, cv.major, cv.minor, cv.patch, cv.content, cv.config
       FROM composer c
       INNER JOIN composer_version cv ON cv.composer_id = c.id
       WHERE c.organization_id = ?
         AND c.deleted_at IS NULL
         AND cv.published_at IS NOT NULL
         AND cv.id = (
           SELECT cv2.id FROM composer_version cv2
           WHERE cv2.composer_id = c.id
             AND cv2.published_at IS NOT NULL
           ORDER BY cv2.major DESC, cv2.minor DESC, cv2.patch DESC
           LIMIT 1
         )`,
    )
    .bind(organizationId)
    .all();

  if (composersResult.results.length === 0) {
    return [];
  }

  // Collect all version IDs and parse segments per composer
  type ComposerRow = {
    id: string;
    name: string;
    version_id: string;
    major: number | null;
    minor: number | null;
    patch: number | null;
    content: string | null;
    config: string;
  };

  const rows = composersResult.results as unknown as ComposerRow[];
  const versionIds = rows.map((r) => r.version_id);

  // Batch query junction entries for all composer versions
  const junctionQueries = versionIds.map((vId) =>
    env.promptly
      .prepare(
        'SELECT prompt_id, prompt_version_id FROM composer_version_prompt WHERE composer_version_id = ?',
      )
      .bind(vId),
  );

  const junctionResults = await env.promptly.batch(junctionQueries);

  // Build a global map of all prompt IDs to their pinned versions
  // and per-composer junction maps
  const perComposerJunctions: Map<string, string | null>[] = [];
  const allPromptIds = new Set<string>();
  const globalJunctionMap = new Map<string, string | null>();

  for (let i = 0; i < junctionResults.length; i++) {
    const junctionMap = new Map<string, string | null>();
    const junctionBatch = junctionResults[i] as D1Result;
    const junctionRows =
      (junctionBatch.results as unknown as ComposerVersionPromptRecord[]) ?? [];

    for (const row of junctionRows) {
      junctionMap.set(row.prompt_id, row.prompt_version_id);
      allPromptIds.add(row.prompt_id);
      // For global resolution, prefer pinned version if available
      if (!globalJunctionMap.has(row.prompt_id)) {
        globalJunctionMap.set(row.prompt_id, row.prompt_version_id);
      }
    }
    perComposerJunctions.push(junctionMap);
  }

  // Also collect prompt IDs from HTML content (in case junction is out of sync)
  for (const row of rows) {
    const parsed = parseComposerContent(row.content ?? '');
    for (const segment of parsed) {
      if (segment.type === 'prompt') {
        allPromptIds.add(segment.promptId);
      }
    }
  }

  // Resolve all unique prompts across all composers in one batch
  const uniquePromptIds = [...allPromptIds];
  const resolveResult = await resolvePrompts(
    env,
    uniquePromptIds,
    globalJunctionMap,
    organizationId,
  );

  if (!resolveResult.ok) {
    return { error: resolveResult.error, code: 'UNRESOLVED_PROMPT' };
  }

  // Assemble responses
  const composers: ComposerResponse[] = rows.map((row) => {
    const parsedSegments = parseComposerContent(row.content ?? '');
    const segments = buildSegments(parsedSegments, resolveResult.prompts);

    return {
      composerId: row.id,
      composerName: row.name,
      version: formatVersion(row.major, row.minor, row.patch),
      config: JSON.parse(row.config || '{}') as Record<string, unknown>,
      segments,
    };
  });

  // Optionally include published version summaries
  if (includeVersions) {
    const versionsResult = await env.promptly
      .prepare(
        `SELECT cv.composer_id, cv.major, cv.minor, cv.patch
         FROM composer_version cv
         INNER JOIN composer c ON c.id = cv.composer_id
         WHERE c.organization_id = ?
           AND c.deleted_at IS NULL
           AND cv.published_at IS NOT NULL
         ORDER BY cv.composer_id, cv.major ASC, cv.minor ASC, cv.patch ASC`,
      )
      .bind(organizationId)
      .all();

    const versionsByComposer = new Map<string, ComposerPublishedVersion[]>();
    for (const row of versionsResult.results) {
      const cId = row.composer_id as string;
      if (!versionsByComposer.has(cId)) {
        versionsByComposer.set(cId, []);
      }
      versionsByComposer.get(cId)?.push({
        version: formatVersion(
          row.major as number | null,
          row.minor as number | null,
          row.patch as number | null,
        ),
      });
    }

    for (const composer of composers) {
      composer.publishedVersions =
        versionsByComposer.get(composer.composerId) ?? [];
    }
  }

  return composers;
};
