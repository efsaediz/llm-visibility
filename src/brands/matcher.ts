/**
 * Brand mention detection.
 *
 * Input: (a) a searchable representation of a capture — the queries
 * ChatGPT ran, plus everything it cited (titles, domains, snippets,
 * safe URLs). (b) the user's brand list.
 *
 * Output: per brand, how many times any of its aliases surfaced, and
 * whether the hit came from a primary citation, a supporting one, or
 * just the query/safe-url pool (ghost territory).
 *
 * Normalisation strips case, diacritics, and punctuation so "Nike", "nıke",
 * and "nike.com" all collapse to the same matcher input. Matching uses
 * word boundaries so "apple" doesn't match "pineapple".
 */

import type { CapturedConversation } from '../parse/schemas';
import type { Brand } from './storage';

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/** Case-fold + strip accents + collapse non-word chars to single space. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BrandMention {
  brandId: string;
  brandName: string;
  /** Total hits across every surface we checked. */
  totalHits: number;
  /** Hits that appeared in a citation marked isPrimary=true. */
  primaryHits: number;
  /** Hits in supporting-only citations (UI-hidden sources). */
  supportingHits: number;
  /** Hits that only showed up in queries or safe URLs (not cited at all). */
  ghostHits: number;
}

/**
 * Pre-compile one regex per brand covering all its aliases. Reused across
 * every capture; cheaper than rebuilding on every call.
 */
function buildBrandMatchers(
  brands: Brand[],
): Array<{ brand: Brand; regex: RegExp }> {
  return brands
    .map((brand) => {
      const terms = [brand.name, ...brand.aliases]
        .map(normalizeForMatch)
        .filter((t) => t.length >= 2);
      if (terms.length === 0) return null;
      const pattern = terms.map(escapeRegex).join('|');
      return { brand, regex: new RegExp(`\\b(?:${pattern})\\b`, 'g') };
    })
    .filter((x): x is { brand: Brand; regex: RegExp } => x !== null);
}

function countMatches(haystack: string, regex: RegExp): number {
  if (!haystack) return 0;
  regex.lastIndex = 0;
  return haystack.match(regex)?.length ?? 0;
}

export function detectBrandsInCapture(
  capture: CapturedConversation,
  brands: Brand[],
): BrandMention[] {
  if (brands.length === 0) return [];
  const matchers = buildBrandMatchers(brands);
  if (matchers.length === 0) return [];

  // Three disjoint text pools so we can attribute hits by visibility tier.
  const primaryText = normalizeForMatch(
    capture.citations
      .filter((c) => c.isPrimary)
      .map((c) => `${c.title ?? ''} ${c.domain} ${c.url} ${c.snippet ?? ''}`)
      .join(' '),
  );
  const supportingText = normalizeForMatch(
    capture.citations
      .filter((c) => !c.isPrimary)
      .map((c) => `${c.title ?? ''} ${c.domain} ${c.url} ${c.snippet ?? ''}`)
      .join(' '),
  );
  const ghostText = normalizeForMatch(
    [
      ...capture.searchQueries.map((q) => q.query),
      ...capture.safeUrls,
    ].join(' '),
  );

  const mentions: BrandMention[] = [];
  for (const { brand, regex } of matchers) {
    const primaryHits = countMatches(primaryText, regex);
    const supportingHits = countMatches(supportingText, regex);
    const ghostHits = countMatches(ghostText, regex);
    const total = primaryHits + supportingHits + ghostHits;
    if (total > 0) {
      mentions.push({
        brandId: brand.id,
        brandName: brand.name,
        totalHits: total,
        primaryHits,
        supportingHits,
        ghostHits,
      });
    }
  }
  return mentions.sort((a, b) => b.totalHits - a.totalHits);
}
