/**
 * fetchComposers must resolve each composer's prompt refs with that
 * composer's own pin. Regression: a single global pin map let the first
 * composer's pin leak into every other composer sharing the prompt.
 */
import { expect, test } from 'bun:test';
import { fetchComposers } from '../src/fetch-composer.ts';
import type { Env, PromptSegment } from '../src/types.ts';

const ORG = 'org-1';
const ref = '<span data-prompt-ref data-prompt-id="P"></span>';
const promptVersions = [
  { id: 'v1', major: 1, user_message: 'old' },
  { id: 'v2', major: 2, user_message: 'new' },
].map((v) => ({
  ...v,
  version_id: v.id,
  name: 'Shared',
  minor: 0,
  patch: 0,
  system_message: null,
  config: '{}',
}));
const pins: Record<string, string | null> = { xv: 'v1', yv: null };

// Minimal D1 fake that answers the queries fetchComposers issues.
const query = (sql: string, args: unknown[]): unknown[] => {
  if (sql.includes('FROM composer c')) {
    return ['x', 'y'].map((id) => ({
      id,
      name: id,
      version_id: `${id}v`,
      major: 1,
      minor: 0,
      patch: 0,
      content: ref,
      config: '{}',
    }));
  }
  if (sql.includes('FROM composer_version_prompt')) {
    return [{ prompt_id: 'P', prompt_version_id: pins[args[0] as string] }];
  }
  if (sql.includes('pv.id = ?')) {
    return promptVersions
      .filter((v) => v.id === args[2])
      .map((v) => ({ ...v, id: 'P' }));
  }
  return [{ ...promptVersions[1], id: 'P' }]; // latest published
};

const statement = (sql: string, args: unknown[] = []) => ({
  bind: (...next: unknown[]) => statement(sql, next),
  all: async () => ({ results: query(sql, args) }),
  first: async () => query(sql, args)[0] ?? null,
  sql,
  args,
});

const env = {
  promptly: {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: ReturnType<typeof statement>[]) =>
      stmts.map((s) => ({ results: query(s.sql, s.args) })),
  },
} as unknown as Env;

test('resolves shared prompts per composer pin', async () => {
  const composers = await fetchComposers(env, ORG);
  if (!Array.isArray(composers)) throw new Error(composers.error);

  const promptOf = (id: string) =>
    composers
      .find((c) => c.composerId === id)
      ?.segments.find((s): s is PromptSegment => s.type === 'prompt');

  expect(promptOf('x')).toMatchObject({ version: '1.0.0', pinned: true });
  expect(promptOf('x')?.userMessage).toBe('old');
  expect(promptOf('y')).toMatchObject({ version: '2.0.0', pinned: false });
  expect(promptOf('y')?.userMessage).toBe('new');
});
