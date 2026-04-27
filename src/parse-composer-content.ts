/**
 * Parses Tiptap HTML content containing <span data-prompt-ref data-prompt-id="..."> elements
 * and <div data-html-block>...</div> blocks. Works in Cloudflare Workers (no DOM APIs) — uses
 * regex on deterministic renderHTML output.
 *
 * Ported from ../promptly/app/lib/composer-content-parser.ts
 */

const PROMPT_REF_TAG_REGEX =
  /<span[^>]*\sdata-prompt-ref(?:="[^"]*")?[^>]*\sdata-prompt-id="([a-zA-Z0-9_-]+)"[^>]*><\/span>/g;

const PROMPT_REF_TAG_ALT_REGEX =
  /<span[^>]*\sdata-prompt-id="([a-zA-Z0-9_-]+)"[^>]*\sdata-prompt-ref(?:="[^"]*")?[^>]*><\/span>/g;

const HTML_BLOCK_OPEN_REGEX =
  /<div\b[^>]*\sdata-html-block(?:="[^"]*")?[^>]*>/gi;

export type ParsedSegment =
  | { type: 'static'; content: string }
  | { type: 'prompt'; promptId: string }
  | { type: 'html_block'; html: string };

// Scans the document for <div data-html-block ...> ... </div> ranges,
// tracking <div> nesting depth and skipping HTML comments so MSO
// conditional comments containing </div> strings don't break matching.
const findHtmlBlockRanges = (
  content: string,
): Array<{ start: number; end: number; html: string }> => {
  const ranges: Array<{ start: number; end: number; html: string }> = [];
  HTML_BLOCK_OPEN_REGEX.lastIndex = 0;
  let openMatch: RegExpExecArray | null = HTML_BLOCK_OPEN_REGEX.exec(content);

  while (openMatch !== null) {
    const blockStart = openMatch.index;
    const innerStart = blockStart + openMatch[0].length;
    let i = innerStart;
    let depth = 1;
    let matched = false;

    while (i < content.length) {
      if (content.startsWith('<!--', i)) {
        const commentEnd = content.indexOf('-->', i + 4);
        if (commentEnd === -1) break;
        i = commentEnd + 3;
        continue;
      }

      if (content[i] !== '<') {
        i++;
        continue;
      }

      const lower3 = content.slice(i, i + 5).toLowerCase();
      if (lower3.startsWith('<div') && /[\s/>]/.test(content[i + 4] ?? '')) {
        const tagClose = content.indexOf('>', i);
        if (tagClose === -1) break;
        const isSelfClosing = content[tagClose - 1] === '/';
        if (!isSelfClosing) depth++;
        i = tagClose + 1;
        continue;
      }

      if (lower3.startsWith('</div')) {
        const tagClose = content.indexOf('>', i);
        if (tagClose === -1) break;
        depth--;
        if (depth === 0) {
          ranges.push({
            start: blockStart,
            end: tagClose + 1,
            html: content.slice(innerStart, i),
          });
          HTML_BLOCK_OPEN_REGEX.lastIndex = tagClose + 1;
          matched = true;
          break;
        }
        i = tagClose + 1;
        continue;
      }

      i++;
    }

    if (!matched) {
      // Bail on this open tag — advance regex past it so we don't loop.
      HTML_BLOCK_OPEN_REGEX.lastIndex = innerStart;
    }
    openMatch = HTML_BLOCK_OPEN_REGEX.exec(content);
  }

  return ranges;
};

const splitOnPromptRefs = (content: string): ParsedSegment[] => {
  const segments: ParsedSegment[] = [];
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

  let lastIndex = 0;
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

export const parseComposerContent = (content: string): ParsedSegment[] => {
  const htmlRanges = findHtmlBlockRanges(content);
  if (htmlRanges.length === 0) {
    return splitOnPromptRefs(content);
  }

  const segments: ParsedSegment[] = [];
  let cursor = 0;
  for (const range of htmlRanges) {
    if (range.start > cursor) {
      segments.push(...splitOnPromptRefs(content.slice(cursor, range.start)));
    }
    segments.push({ type: 'html_block', html: range.html });
    cursor = range.end;
  }

  if (cursor < content.length) {
    segments.push(...splitOnPromptRefs(content.slice(cursor)));
  }

  return segments;
};
