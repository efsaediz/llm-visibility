/**
 * Three-pass attribution. Each sentence in the assistant's answer is matched
 * to a citation by trying, in order:
 *
 *   1. Inline citation overlap. ChatGPT's content_references stream pins
 *      [start, end] character spans of the answer to specific URLs — ground
 *      truth, no guessing. If a sentence's character span overlaps any
 *      inline reference whose URL is also in the citation pool, attribute
 *      with confidence 1.0.
 *
 *   2. Quote substring match. If the sentence carries text in quotes (≥8
 *      chars) and that text appears verbatim in any citation's title or
 *      snippet, attribute to that citation with confidence 1.0.
 *
 *   3. TF-IDF with domain-name boost. The legacy lexical fallback for
 *      sentences neither marked inline nor carrying a verbatim quote.
 *      Tokens that match the citation's second-level domain name (e.g.
 *      "anthropic" for anthropic.com) get a 1.5× weight in the hit mass —
 *      domain-name agreement is a high-value lexical signal that pure
 *      TF-IDF undervalues.
 *
 * Why this stack: pass 1 alone moves attribution from "guessed" to "ground
 * truth" for the sentences ChatGPT itself sourced. Pass 2 catches the
 * paraphrase-resistant case (a direct quotation). Pass 3 stays as the
 * fallback so paraphrased sentences still get an answer when possible.
 *
 * Research note on semantic embeddings inside an MV3 extension:
 *   Transformers.js + a small model (all-MiniLM-L6-v2) is impractical in
 *   the service worker itself — no DOM, WASM-only, ~25 MB bundle, 1–3 s
 *   cold-wake latency, and MV3 CSP blocks remote weight fetches. Feasible
 *   routes: (a) an offscreen document, (b) a page-world runner in
 *   inject.ts, or (c) a cloud embedding API. Three-pass lexical clears
 *   ~80% of the value of going semantic for ~5% of the cost.
 */

import type {
  CapturedConversation,
  Citation,
  InlineCitation,
} from '../parse/schemas';
import {
  normalizeTokens,
  splitSentences,
  type AttributionResult,
  type SentenceAttribution,
} from './attribute';

/** Minimum weighted overlap to attribute via TF-IDF (pass 3). */
const MIN_TFIDF_SCORE = 0.22;
const MIN_SENTENCE_TOKENS = 3;
/** Hit-mass multiplier when a sentence token matches a domain-name token. */
const DOMAIN_TOKEN_BOOST = 1.5;
/** Minimum quoted-substring length for the quote-match pass. */
const MIN_QUOTE_LEN = 8;

interface CitationData {
  url: string;
  domain: string;
  tokens: Set<string>;
  /** Subset of tokens that appear in the second-level domain. */
  domainTokens: Set<string>;
  /** Lowercased haystack for substring quote matching. */
  haystackLower: string;
}

/**
 * SLD tokens for boost matching. "blog.anthropic.com" → {"anthropic"};
 * "stack-overflow.com" → {"stack","overflow"}. Tokens shorter than 3 chars
 * are dropped because they collide with too many ordinary words.
 */
function domainNameTokens(domain: string): Set<string> {
  const parts = domain.toLowerCase().split('.');
  const sld = parts.length >= 2 ? parts[parts.length - 2] : domain;
  return new Set(sld.split(/[-_]/).filter((t) => t.length >= 3));
}

function buildCitationData(citations: Citation[]): CitationData[] {
  return citations.map((c) => {
    const haystack = [c.title ?? '', c.snippet ?? '', c.domain]
      .filter(Boolean)
      .join(' ');
    return {
      url: c.url,
      domain: c.domain,
      tokens: new Set(normalizeTokens(haystack)),
      domainTokens: domainNameTokens(c.domain),
      haystackLower: haystack.toLowerCase(),
    };
  });
}

function computeIdf(citationData: CitationData[]): Map<string, number> {
  const n = citationData.length;
  const df = new Map<string, number>();
  for (const { tokens } of citationData) {
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + n / (1 + count)));
  }
  return idf;
}

function tfidfScoreWithBoost(
  sentenceTokens: string[],
  citation: CitationData,
  idf: Map<string, number>,
  fallbackIdf: number,
): number {
  if (sentenceTokens.length === 0) return 0;
  const seen = new Set<string>();
  let totalMass = 0;
  let hitMass = 0;
  for (const t of sentenceTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    const w = idf.get(t) ?? fallbackIdf;
    totalMass += w;
    if (citation.tokens.has(t)) {
      const boost = citation.domainTokens.has(t) ? DOMAIN_TOKEN_BOOST : 1;
      hitMass += w * boost;
    }
  }
  if (totalMass === 0) return 0;
  // Boost can push raw score above 1; clamp so threshold semantics stay sane.
  return Math.min(1, hitMass / totalMass);
}

/**
 * Locate each sentence's [start, end) character span in the source text by
 * scanning forward from the previous match. Returns [-1,-1] when a sentence
 * can't be re-located (e.g. text was reflowed); the caller skips inline
 * matching for those.
 */
function findSentenceSpans(
  text: string,
  sentences: string[],
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const s of sentences) {
    const idx = text.indexOf(s, cursor);
    if (idx < 0) {
      spans.push([-1, -1]);
    } else {
      spans.push([idx, idx + s.length]);
      cursor = idx + s.length;
    }
  }
  return spans;
}

/**
 * Pull quoted substrings (≥MIN_QUOTE_LEN chars) out of a sentence. Handles
 * straight ASCII and curly Unicode quotes. Lowercased + whitespace-collapsed
 * for substring matching against citation snippets.
 */
const QUOTE_PATTERN =
  /"([^"]{8,}?)"|'([^']{8,}?)'|"([^"]{8,}?)"|'([^']{8,}?)'/g;
function extractQuotes(sentence: string): string[] {
  const out: string[] = [];
  QUOTE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTE_PATTERN.exec(sentence)) !== null) {
    const captured = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!captured) continue;
    const norm = captured.replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm.length >= MIN_QUOTE_LEN) out.push(norm);
  }
  return out;
}

function findInlineMatch(
  sStart: number,
  sEnd: number,
  inlineCitations: InlineCitation[],
  byUrl: Map<string, Citation>,
): Citation | null {
  for (const inline of inlineCitations) {
    if (inline.startIdx >= sEnd || inline.endIdx <= sStart) continue;
    for (const url of inline.urls) {
      const cit = byUrl.get(url);
      if (cit) return cit;
    }
  }
  return null;
}

function findQuoteMatch(
  sentence: string,
  citationData: CitationData[],
): CitationData | null {
  const quotes = extractQuotes(sentence);
  if (quotes.length === 0) return null;
  for (const q of quotes) {
    const haystackQuote = q.replace(/\s+/g, ' ');
    for (const c of citationData) {
      const compact = c.haystackLower.replace(/\s+/g, ' ');
      if (compact.includes(haystackQuote)) return c;
    }
  }
  return null;
}

export function attributeAnswerTfidf(
  conversation: CapturedConversation,
): AttributionResult {
  const sentences = splitSentences(conversation.answerText);
  const spans = findSentenceSpans(conversation.answerText, sentences);

  if (sentences.length === 0 || conversation.citations.length === 0) {
    return {
      sentences: sentences.map((sentence, index) => ({
        index,
        sentence,
        score: 0,
        citationUrl: null,
        citationDomain: null,
        unsourced: true,
        attributedVia: null,
      })),
      unsourcedCount: sentences.length,
      unsourcedRatio: sentences.length > 0 ? 1 : 0,
      usedCitationUrls: [],
    };
  }

  const citationData = buildCitationData(conversation.citations);
  const byUrl = new Map(conversation.citations.map((c) => [c.url, c]));
  const idf = computeIdf(citationData);
  const fallbackIdf = Math.log(1 + 1 / 1);
  const used = new Set<string>();

  const results: SentenceAttribution[] = sentences.map((sentence, index) => {
    const [sStart, sEnd] = spans[index];

    // Pass 1: inline citation overlap (ground truth).
    if (sStart >= 0) {
      const inlineHit = findInlineMatch(
        sStart,
        sEnd,
        conversation.inlineCitations,
        byUrl,
      );
      if (inlineHit) {
        used.add(inlineHit.url);
        return {
          index,
          sentence,
          score: 1,
          citationUrl: inlineHit.url,
          citationDomain: inlineHit.domain,
          unsourced: false,
          attributedVia: 'inline',
        };
      }
    }

    // Pass 2: quoted substring exact match.
    const quoteHit = findQuoteMatch(sentence, citationData);
    if (quoteHit) {
      used.add(quoteHit.url);
      return {
        index,
        sentence,
        score: 1,
        citationUrl: quoteHit.url,
        citationDomain: quoteHit.domain,
        unsourced: false,
        attributedVia: 'quote',
      };
    }

    // Pass 3: TF-IDF with domain-name boost.
    const tokens = normalizeTokens(sentence);
    if (tokens.length < MIN_SENTENCE_TOKENS) {
      return {
        index,
        sentence,
        score: 0,
        citationUrl: null,
        citationDomain: null,
        unsourced: true,
        attributedVia: null,
      };
    }
    let bestUrl: string | null = null;
    let bestDomain: string | null = null;
    let bestScore = 0;
    for (const c of citationData) {
      const score = tfidfScoreWithBoost(tokens, c, idf, fallbackIdf);
      if (score > bestScore) {
        bestScore = score;
        bestUrl = c.url;
        bestDomain = c.domain;
      }
    }
    if (bestUrl && bestScore >= MIN_TFIDF_SCORE) {
      used.add(bestUrl);
      return {
        index,
        sentence,
        score: bestScore,
        citationUrl: bestUrl,
        citationDomain: bestDomain,
        unsourced: false,
        attributedVia: 'tfidf',
      };
    }
    return {
      index,
      sentence,
      score: bestScore,
      citationUrl: null,
      citationDomain: null,
      unsourced: true,
      attributedVia: null,
    };
  });

  const unsourcedCount = results.filter((r) => r.unsourced).length;
  return {
    sentences: results,
    unsourcedCount,
    unsourcedRatio: results.length > 0 ? unsourcedCount / results.length : 0,
    usedCitationUrls: Array.from(used),
  };
}
