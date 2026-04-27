/**
 * Unit tests for parse-composer-content.ts.
 *
 * The extension stores HTML payloads in a `data-raw-html` attribute on
 * the wrapper div. The payload goes through two layers of encoding before
 * it reaches the regex parser:
 *   1. The extension pre-encodes `<` → `&lt;` and `>` → `&gt;`
 *      (so the serialised attribute value contains no raw angle
 *       brackets, which would break the regex's `[^>]*` matcher).
 *   2. The browser's HTML serializer encodes `&` → `&amp;` and `"` → `&quot;`.
 *
 * These tests round-trip realistic payloads — including chips inside
 * attribute values (the original bug case) — and verify the legacy
 * inner-content format still parses correctly.
 */
import { expect, test } from 'bun:test';
import { parseComposerContent } from '../src/parse-composer-content';

// Mirrors the encoding pipeline performed by the extension + browser
// when a TipTap html_block node is serialised to HTML.
const serializeHtmlBlock = (raw: string): string => {
  const inner = raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const browserEncoded = inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<div data-html-block="" data-raw-html="${browserEncoded}"></div>`;
};

test('parses new data-raw-html attribute format', () => {
  const inner =
    '<a href="https://example.com">Hi <span data-variable-ref="" data-field-id="x" data-field-path="user.name"></span></a>';
  const html = `<p>before</p>${serializeHtmlBlock(inner)}<p>after</p>`;

  const segments = parseComposerContent(html);
  const htmlBlock = segments.find((s) => s.type === 'html_block');
  expect(htmlBlock).toBeDefined();
  if (htmlBlock?.type === 'html_block') {
    expect(htmlBlock.html).toBe(inner);
  }
});

test('round-trips chip inside href via data-raw-html', () => {
  // Exact corruption case from the bug report: a variable chip placed
  // inside an HTML attribute value. This previously broke because
  // dom.innerHTML = raw re-parsed the markup and the browser couldn't
  // handle a child element nested inside an attribute. Storing the
  // payload as a string attribute side-steps DOM tree construction.
  const inner =
    '<a href="<span data-variable-ref="" data-field-id="f1" data-field-path="continueQuoteURL"></span>">Continue</a>';
  const html = serializeHtmlBlock(inner);

  const segments = parseComposerContent(html);
  expect(segments).toHaveLength(1);
  expect(segments[0]?.type).toBe('html_block');
  if (segments[0]?.type === 'html_block') {
    expect(segments[0].html).toBe(inner);
  }
});

test('falls back to inner-content scanner for legacy blocks', () => {
  const inner =
    '<a href="https://example.com">Hi <span data-variable-ref="" data-field-id="x" data-field-path="user.name"></span></a>';
  const html = `<p>pre</p><div data-html-block>${inner}</div><p>post</p>`;

  const segments = parseComposerContent(html);
  const htmlBlock = segments.find((s) => s.type === 'html_block');
  expect(htmlBlock).toBeDefined();
  if (htmlBlock?.type === 'html_block') {
    expect(htmlBlock.html).toBe(inner);
  }
});

test('legacy depth-tracking handles nested divs and MSO comments', () => {
  const inner =
    '<!--[if mso]><div>conditional</div><![endif]--><div>nested</div>';
  const html = `<div data-html-block>${inner}</div>`;

  const segments = parseComposerContent(html);
  expect(segments).toHaveLength(1);
  if (segments[0]?.type === 'html_block') {
    expect(segments[0].html).toBe(inner);
  }
});

test('handles multiple html blocks in the same document', () => {
  const innerA = '<a href="a">A</a>';
  const innerB = '<a href="b">B</a>';
  const html = `${serializeHtmlBlock(innerA)}<p>middle</p>${serializeHtmlBlock(innerB)}`;

  const segments = parseComposerContent(html);
  const blocks = segments.filter((s) => s.type === 'html_block');
  expect(blocks).toHaveLength(2);
  if (blocks[0]?.type === 'html_block' && blocks[1]?.type === 'html_block') {
    expect(blocks[0].html).toBe(innerA);
    expect(blocks[1].html).toBe(innerB);
  }
});

test('preserves ampersands and entity-like text in payload', () => {
  // Real-world: a URL with HTML-escaped ampersand in query params.
  // The two-layer encode/decode preserves `&amp;` text byte-exactly.
  const inner = '<a href="https://x?a=1&amp;b=2">link</a>';
  const html = serializeHtmlBlock(inner);

  const segments = parseComposerContent(html);
  if (segments[0]?.type === 'html_block') {
    expect(segments[0].html).toBe(inner);
  }
});
