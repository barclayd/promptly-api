/**
 * Parses Tiptap HTML content containing <span data-prompt-ref data-prompt-id="..."> elements.
 * Works in Cloudflare Workers (no DOM APIs) — uses regex on deterministic renderHTML output.
 *
 * Ported from ../promptly/app/lib/composer-content-parser.ts
 */

const PROMPT_REF_TAG_REGEX =
  /<span[^>]*\sdata-prompt-ref(?:="[^"]*")?[^>]*\sdata-prompt-id="([a-zA-Z0-9_-]+)"[^>]*><\/span>/g;

const PROMPT_REF_TAG_ALT_REGEX =
  /<span[^>]*\sdata-prompt-id="([a-zA-Z0-9_-]+)"[^>]*\sdata-prompt-ref(?:="[^"]*")?[^>]*><\/span>/g;

export type ParsedSegment =
  | { type: 'static'; content: string }
  | { type: 'prompt'; promptId: string };

export const parseComposerContent = (content: string): ParsedSegment[] => {
  const segments: ParsedSegment[] = [];
  let lastIndex = 0;

  const matches: Array<{ index: number; length: number; promptId: string }> =
    [];

  for (const match of content.matchAll(PROMPT_REF_TAG_REGEX)) {
    matches.push({
      index: match.index,
      length: match[0].length,
      promptId: match[1] as string,
    });
  }

  for (const match of content.matchAll(PROMPT_REF_TAG_ALT_REGEX)) {
    if (!matches.some((m) => m.index === match.index)) {
      matches.push({
        index: match.index,
        length: match[0].length,
        promptId: match[1] as string,
      });
    }
  }

  matches.sort((a, b) => a.index - b.index);

  for (const match of matches) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'static',
        content: content.slice(lastIndex, match.index),
      });
    }

    segments.push({ type: 'prompt', promptId: match.promptId });
    lastIndex = match.index + match.length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'static', content: content.slice(lastIndex) });
  }

  return segments;
};
