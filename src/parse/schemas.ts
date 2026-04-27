/**
 * Domain model schemas. We use Zod at the *output* boundary of extraction
 * so downstream consumers (storage, UI) always receive a validated shape,
 * even when ChatGPT's upstream SSE format drifts.
 */

import { z } from 'zod';

export const CitationSchema = z.object({
  url: z.string(),
  domain: z.string(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  position: z.number().int().nonnegative(),
  /**
   * `true` = rendered as the headline link for its group in the ChatGPT UI.
   * `false` = hidden under "supporting_websites". Ghost-citation analysis
   * (Day 8) leans on this distinction.
   */
  isPrimary: z.boolean(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const SearchQuerySchema = z.object({
  query: z.string(),
  kind: z.enum(['text', 'image']),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * Ground-truth attribution emitted by ChatGPT itself: a [start, end] character
 * span into answerText that ChatGPT linked to one or more citation URLs. We
 * capture these from `content_references` payloads in the SSE stream and use
 * them in the attribution engine as a high-confidence signal that supersedes
 * lexical TF-IDF guessing.
 */
export const InlineCitationSchema = z.object({
  startIdx: z.number().int().nonnegative(),
  endIdx: z.number().int().nonnegative(),
  urls: z.array(z.string()),
});
export type InlineCitation = z.infer<typeof InlineCitationSchema>;

export const CapturedConversationSchema = z.object({
  id: z.string(),
  url: z.string(),
  capturedAt: z.string(),
  rawEventCount: z.number().int().nonnegative(),
  searchQueries: z.array(SearchQuerySchema),
  citations: z.array(CitationSchema),
  safeUrls: z.array(z.string()),
  /**
   * Final assistant answer text (concatenated parts). Used by the
   * attribution engine to link sentences back to their source citations.
   * Empty string when capture pre-dates answer extraction.
   */
  answerText: z.string().default(''),
  /**
   * The user's original prompt extracted from the outbound POST body.
   * Empty when the request didn't carry one (conversation reloads, or
   * capture predates prompt extraction).
   */
  userPrompt: z.string().default(''),
  /**
   * Inline citation spans emitted by ChatGPT — ground-truth source links for
   * specific [start, end] character ranges of the answer. Empty for captures
   * predating inline-citation extraction.
   */
  inlineCitations: z.array(InlineCitationSchema).default([]),
});
export type CapturedConversation = z.infer<typeof CapturedConversationSchema>;

/** Derived metrics — computed once at persistence time, cached on the row. */
export function computeMetrics(c: CapturedConversation) {
  const primary = c.citations.filter((x) => x.isPrimary).length;
  const supporting = c.citations.length - primary;
  const uniqueDomains = new Set(c.citations.map((x) => x.domain)).size;
  // Ghost ratio: how much of ChatGPT's source pool stayed hidden from the
  // user. We count all URLs touched (citations + safe_urls) vs. the primary
  // ones that actually surfaced in the visible answer.
  const citedSet = new Set(c.citations.map((x) => x.url));
  const touched = new Set<string>(citedSet);
  for (const u of c.safeUrls) touched.add(u);
  const ghostCount = Math.max(0, touched.size - primary);
  const ghostRatio = touched.size > 0 ? ghostCount / touched.size : 0;
  return {
    primary,
    supporting,
    uniqueDomains,
    touchedSources: touched.size,
    ghostCount,
    ghostRatio,
  };
}
