/**
 * Transforms raw SSE events from ChatGPT's conversation API into our
 * structured CapturedConversation domain model.
 *
 * Strategy: walk every JSON payload recursively, pattern-match on
 * recognizable shapes. Lenient on the way in, strict on the way out
 * (final output is validated via Zod in schemas.ts).
 *
 * Recognized shapes (derived from observed ChatGPT SSE traffic):
 *   - Plain: `{ conversation_id, search_query, image_search_query,
 *              type: 'search_result_group', safe_urls }`
 *   - JSON-patch envelopes: `{ o: 'patch', v: [ { p, o, v }, ... ] }`
 *     or top-level `{ p, o, v }`. We detect search data by inspecting
 *     the `p` path (e.g. `/message/metadata/search_result_groups/...`).
 *
 * We ignore `[DONE]` and anything we can't JSON-parse (keep-alive pings etc.).
 */

import type { RawSSEEvent } from '../shared/messages';
import {
  CapturedConversationSchema,
  type CapturedConversation,
  type Citation,
  type InlineCitation,
  type SearchQuery,
} from './schemas';

export function extractConversation(
  url: string,
  capturedAt: string,
  events: RawSSEEvent[],
  userPrompt: string = '',
): CapturedConversation {
  let id = '';
  const searchQueries: SearchQuery[] = [];
  const seenQueries = new Set<string>();
  const citations: Citation[] = [];
  const citationKeys = new Set<string>();
  const safeUrls = new Set<string>();
  const inlineCitations: InlineCitation[] = [];
  const inlineKeys = new Set<string>();
  // Two independent channels reconstruct the assistant answer:
  //   (a) full message objects whose content.parts[0] holds the latest text
  //   (b) JSON-patch append ops that stream chunks into /content/parts/N
  // At the end we pick whichever reconstruction is longer — (a) wins on the
  // final "replace" event, (b) wins when only deltas came through.
  let fullAnswerText = '';
  const patchChunks: string[] = [];

  const addQuery = (query: string, kind: SearchQuery['kind']) => {
    const q = query.trim();
    if (!q) return;
    const key = `${kind}:${q}`;
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    searchQueries.push({ query: q, kind });
  };

  for (const evt of events) {
    if (!evt.data || evt.data === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      continue;
    }

    const maybeId = findConversationId(parsed);
    if (maybeId && !id) id = maybeId;

    const collectQueryFromNode = (node: Record<string, unknown>) => {
      // Array form: { search_query: ["..." | { q|query }, ...] }
      const sqList = Array.isArray(node.search_query)
        ? node.search_query
        : Array.isArray(node.search_queries)
          ? node.search_queries
          : null;
      if (sqList) {
        for (const sq of sqList) {
          if (typeof sq === 'string') {
            addQuery(sq, 'text');
          } else if (isObject(sq)) {
            const q =
              typeof sq.q === 'string'
                ? sq.q
                : typeof sq.query === 'string'
                  ? sq.query
                  : null;
            if (q) addQuery(q, 'text');
          }
        }
      }
      if (typeof node.image_search_query === 'string') {
        addQuery(node.image_search_query, 'image');
      }
      // Bare query object pushed via patch: { q: "...", ...} without wrapper.
      if (typeof node.q === 'string' && !node.type && !node.url) {
        addQuery(node.q, 'text');
      }
    };

    const collectCitationEntry = (entry: unknown, isPrimary = true) => {
      if (!isObject(entry)) return;
      const entryUrl =
        typeof entry.url === 'string'
          ? entry.url
          : typeof entry.link === 'string'
            ? entry.link
            : null;
      if (entryUrl && !citationKeys.has(entryUrl)) {
        citationKeys.add(entryUrl);
        citations.push({
          url: entryUrl,
          domain: safeDomain(entryUrl),
          title: typeof entry.title === 'string' ? entry.title : undefined,
          snippet:
            typeof entry.snippet === 'string'
              ? entry.snippet
              : typeof entry.text === 'string'
                ? entry.text
                : undefined,
          position: citations.length,
          isPrimary,
        });
      }
      // ChatGPT groups multiple search results under one "primary" entry and
      // tucks the rest under `supporting_websites`. The rest are real sources
      // too — just de-emphasised in the UI. Marked isPrimary=false so ghost
      // detection can weigh them differently.
      if (Array.isArray(entry.supporting_websites)) {
        for (const sw of entry.supporting_websites) collectCitationEntry(sw, false);
      }
    };

    /**
     * Inline citation collector. ChatGPT emits content_references entries
     * with start_idx/end_idx character offsets into the assistant text plus
     * one or more URLs (directly, or nested under items[]/refs[]). These are
     * ground-truth attribution — we record them so the attribution engine
     * can short-circuit TF-IDF for sentences ChatGPT itself sourced.
     */
    const collectInline = (node: Record<string, unknown>) => {
      const startIdx = node.start_idx;
      const endIdx = node.end_idx;
      if (typeof startIdx !== 'number' || typeof endIdx !== 'number') return;
      if (startIdx < 0 || endIdx <= startIdx) return;

      const urls: string[] = [];
      if (typeof node.url === 'string') urls.push(node.url);
      if (Array.isArray(node.items)) {
        for (const item of node.items) {
          if (isObject(item) && typeof item.url === 'string') urls.push(item.url);
        }
      }
      if (Array.isArray(node.refs)) {
        for (const ref of node.refs) {
          if (isObject(ref) && typeof ref.url === 'string') urls.push(ref.url);
        }
      }
      if (urls.length === 0) return;

      // Dedupe across patch deltas — same span often arrives multiple times
      // as ChatGPT streams initial + refinement events.
      const sortedUrls = [...new Set(urls)].sort();
      const key = `${startIdx}-${endIdx}-${sortedUrls.join(',')}`;
      if (inlineKeys.has(key)) return;
      inlineKeys.add(key);
      inlineCitations.push({ startIdx, endIdx, urls: sortedUrls });
    };

    const collectCitationGroup = (group: unknown) => {
      if (!isObject(group)) return;
      const entries = Array.isArray(group.entries)
        ? group.entries
        : Array.isArray(group.results)
          ? group.results
          : Array.isArray(group.items)
            ? group.items
            : Array.isArray(group.refs)
              ? group.refs
              : null;
      if (entries) {
        for (const entry of entries) collectCitationEntry(entry);
      }
    };

    walk(parsed, (node) => {
      collectQueryFromNode(node);
      collectInline(node);

      // Full assistant message object: grab the concatenated parts as the
      // current best-known answer text. We keep the longest seen so edits
      // or re-renders that truncate don't erase earlier content.
      if (
        isObject(node.author) &&
        (node.author as { role?: unknown }).role === 'assistant' &&
        isObject(node.content) &&
        (node.content as { content_type?: unknown }).content_type === 'text' &&
        Array.isArray((node.content as { parts?: unknown }).parts)
      ) {
        const parts = (node.content as { parts: unknown[] }).parts;
        const text = parts.filter((p): p is string => typeof p === 'string').join('');
        if (text.length > fullAnswerText.length) fullAnswerText = text;
      }

      // JSON-patch streaming chunk: append ops into /content/parts/N.
      if (
        typeof node.p === 'string' &&
        node.o === 'append' &&
        /\/content\/parts\/\d+/.test(node.p) &&
        typeof node.v === 'string'
      ) {
        patchChunks.push(node.v);
      }

      // Tool-call queries. ChatGPT shifts the recipient/content_type gating
      // every couple of weeks (recipient="web"/"browser"/"tool", content_type
      // sometimes "code", sometimes "tether_browsing_display", sometimes
      // missing entirely on the streaming patch). Don't gate — apply the
      // patterns to any node with a text string. The patterns themselves
      // are specific enough to avoid false positives.
      if (typeof node.text === 'string') {
        for (const q of extractToolCallQueries(node.text)) {
          addQuery(q.query, q.kind);
        }
      }
      // Some streams surface queries as a bare array on a node, e.g.
      // `{queries: ["...", "..."]}` inside a search_progress payload.
      if (Array.isArray(node.queries)) {
        for (const q of node.queries) {
          if (typeof q === 'string') addQuery(q, 'text');
          else if (isObject(q) && typeof q.q === 'string') addQuery(q.q, 'text');
          else if (isObject(q) && typeof q.query === 'string')
            addQuery(q.query, 'text');
        }
      }

      if (node.type === 'search_result_group') {
        collectCitationGroup(node);
      }

      if (Array.isArray(node.safe_urls)) {
        for (const u of node.safe_urls) {
          if (typeof u === 'string') safeUrls.add(u);
        }
      }

      // JSON-patch op: decide what `v` represents based on the path `p`.
      if (typeof node.p === 'string' && 'v' in node) {
        const path = node.p;
        const value = node.v;

        if (/search_result_groups?/.test(path)) {
          // value may be a single group, an array of groups, or an array
          // of entries depending on whether the op targets the array itself
          // or a specific group's entries.
          if (Array.isArray(value)) {
            for (const item of value) {
              if (isObject(item) && (item.entries || item.results || item.items || item.refs)) {
                collectCitationGroup(item);
              } else {
                collectCitationEntry(item);
              }
            }
          } else {
            collectCitationGroup(value);
          }
        }

        // Match the obvious `.../search_queries` shape AND the looser variants
        // ChatGPT uses for streaming tool-call args (e.g. `/.../queries`,
        // `/.../search_progress/queries`, `/.../tool_calls/0/arguments/query`).
        if (
          /search_quer(?:y|ies)|(?:^|\/)querie?s\b|search_progress|tool_calls\/.+\/(?:arguments|args)/.test(
            path,
          )
        ) {
          if (Array.isArray(value)) {
            for (const item of value) {
              if (typeof item === 'string') addQuery(item, 'text');
              else if (isObject(item)) collectQueryFromNode(item);
            }
          } else if (typeof value === 'string') {
            addQuery(value, 'text');
          } else if (isObject(value)) {
            collectQueryFromNode(value);
          }
        }

        if (/safe_urls?/.test(path)) {
          if (Array.isArray(value)) {
            for (const u of value) {
              if (typeof u === 'string') safeUrls.add(u);
            }
          } else if (typeof value === 'string') {
            safeUrls.add(value);
          }
        }

        if (/citations?|content_references/.test(path)) {
          if (Array.isArray(value)) {
            for (const item of value) collectCitationEntry(item);
          } else {
            collectCitationEntry(value);
          }
        }
      }
    });
  }

  const patchedText = patchChunks.join('');
  const rawAnswer =
    fullAnswerText.length >= patchedText.length ? fullAnswerText : patchedText;
  const answerText = cleanAnswerText(rawAnswer);

  const conversation: CapturedConversation = {
    id: id || `unknown_${Date.now()}`,
    url,
    capturedAt,
    rawEventCount: events.length,
    searchQueries,
    citations,
    safeUrls: Array.from(safeUrls),
    answerText,
    userPrompt,
    inlineCitations,
  };

  return CapturedConversationSchema.parse(conversation);
}

function findConversationId(node: unknown): string | null {
  if (!isObject(node)) return null;
  if (typeof node.conversation_id === 'string') return node.conversation_id;
  if (isObject(node.v)) return findConversationId(node.v);
  return null;
}

function walk(
  node: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  if (isObject(node)) {
    visit(node);
    for (const key of Object.keys(node)) {
      walk(node[key], visit);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Strip ChatGPT's inline marker payloads from raw answer text.
 *
 * ChatGPT streams citation markers, product widgets, and other UI hints
 * inline within the answer text. They render as compact pills in the UI
 * but bleed into our captured text as raw bytes — typically wrapped in
 * Private Use Area characters (around U+E200) or in [tag]...[/tag] form.
 *
 * Without this cleanup, payloads like
 *   [products]{"selections":[["turn0product2","..."], ...]}[/products]
 * end up as monolithic "sentences" that drown attribution metrics
 * (~86% unsourced on a recent capture). After cleanup the surviving
 * sentences are real prose and TF-IDF / inline matching get a fair shot.
 *
 * Note: content_references already arrived through their own SSE path with
 * explicit start/end indices into the *raw* text, so by stripping markers
 * here we shift those indices off-by-N. This is acceptable because (a)
 * content_references rarely fire on most captures we see, (b) the cleanup
 * win on TF-IDF accuracy is much larger than the small inline-match loss.
 * If inline-match accuracy starts mattering more we'll keep both raw and
 * cleaned text on the row.
 */
function cleanAnswerText(raw: string): string {
  if (!raw) return '';
  let text = raw;
  // ChatGPT's inline markers use three Private Use Area characters per
  // marker — OPEN tagname SEP payload CLOSE — anywhere in the BMP PUA range
  // (U+E000–U+F8FF). The earlier non-greedy two-PUA pattern only ate
  // OPEN..SEP and left the (often huge JSON) payload in the visible text;
  // that's what produced 100%-unsourced captures full of "entity[...]"
  // blobs. Match all three PUA chars with non-PUA content between them.
  text = text.replace(
    /[-][^-]*[-][^-]*[-]/g,
    '',
  );
  // Two-PUA fallback for markers without an internal separator (rarer).
  text = text.replace(/[-][^-]*[-]/g, '');
  // Lone PUA leftovers.
  text = text.replace(/[-]/g, '');
  // [tag]...[/tag] widget payloads. Covers the bracket-form variants we've
  // observed: citations, products, explore_more, business entities, and the
  // various search-context marker tags.
  text = text.replace(
    /\[(cite|products|explore_more|video|audio|image|news_search|video_search|search|browser|nav|entity|entity_metadata|business)\][\s\S]*?\[\/\1\]/g,
    '',
  );
  // Stray turnNsearchM / turnNproductM / turnNbusinessM references that
  // escape their wrappers (sometimes ChatGPT emits the inner ID without
  // brackets, especially in product/place callouts).
  text = text.replace(
    /\bturn\d+(?:search|product|news|image|video|view|business|sports|finance|map|local)\d+\b/g,
    '',
  );
  // Collapse the whitespace that the strips leave behind.
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Pull search/image_search calls out of a free-form text block.
 *
 * ChatGPT's tool-call surface format drifts. Observed variants:
 *   - search("query")               classic
 *   - search('query')               single-quoted
 *   - search(query="...")           kwarg form
 *   - web_search("...")             namespaced fn name
 *   - news_search("...")            another variant
 *   - browser.search("...")         dot-namespaced
 *   - image_search("...")           image variant
 *
 * We try each pattern in turn. The negative-lookbehind on the plain-search
 * pattern keeps `image_search` from matching it twice (once as text, once
 * as image).
 */
function extractToolCallQueries(
  text: string,
): Array<{ query: string; kind: 'text' | 'image' }> {
  const out: Array<{ query: string; kind: 'text' | 'image' }> = [];

  const patterns: Array<{ kind: 'text' | 'image'; re: RegExp }> = [
    // Image search variants. Run first so the plain pattern doesn't double-match.
    {
      kind: 'image',
      re: /\b(?:image_search|images?\.search)\s*\(\s*(?:query\s*=\s*)?(["'])((?:\\.|(?!\1).)+?)\1/g,
    },
    // Plain text search. Allow optional namespace prefix (web., browser., tool.).
    // Lookbehind blocks `image_search`, `news_search` (handled separately) etc.
    {
      kind: 'text',
      re: /(?<![A-Za-z_])(?:web|browser|browse|tool)?\.?(?:web_search|news_search|search)\s*\(\s*(?:query\s*=\s*)?(["'])((?:\\.|(?!\1).)+?)\1/g,
    },
  ];

  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let query = m[2];
      try {
        // Use JSON.parse to undo \", \\, \n etc. Wrap in actual double quotes
        // regardless of original quote style — JSON only knows double-quoted.
        query = JSON.parse(`"${query.replace(/"/g, '\\"')}"`);
      } catch {
        // keep raw
      }
      const trimmed = query.trim();
      if (trimmed) out.push({ query: trimmed, kind });
    }
  }

  return out;
}
