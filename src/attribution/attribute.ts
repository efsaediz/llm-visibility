/**
 * Shared types and tokenization helpers for the attribution engine.
 *
 * Live attribution is now in tfidf.ts and runs three passes per sentence:
 *   1. inline-citation overlap (ground truth from ChatGPT's content_references)
 *   2. exact-quote substring match against citation snippets
 *   3. TF-IDF with domain-name boost (the lexical fallback)
 *
 * This module owns the SentenceAttribution / AttributionResult types and the
 * primitives every pass shares: token normalisation and sentence splitting.
 */

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

// Small multilingual stopword list. Tuned for EN + TR (the two languages
// we see in captures). Keep short — removing too much noise is worse than
// leaving some in, since overlap is normalised by sentence length.
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'can', 'but', 'not', 'you',
  'your', 'our', 'its', 'their', 'them', 'they', 'these', 'those', 'who',
  'what', 'when', 'where', 'why', 'how', 'than', 'then', 'also', 'into',
  'over', 'under', 'about', 'such', 'some', 'any', 'all', 'each', 'most',
  // Turkish
  've', 'ile', 'bir', 'bu', 'şu', 'ama', 'için', 'fakat', 'ancak', 'gibi',
  'kadar', 'her', 'hiç', 'çok', 'daha', 'sonra', 'önce', 'şimdi', 'veya',
  'veya', 'ya', 'eğer', 'ise', 'olan', 'olarak', 'yani', 'belki', 'hem',
  'göre', 'diye', 'dolayı', 'rağmen',
]);

/** Which pass produced an attribution. null = sentence was unsourced. */
export type AttributedVia = 'inline' | 'quote' | 'tfidf' | null;

export interface SentenceAttribution {
  /** 0-based index into the sentence list. */
  index: number;
  sentence: string;
  /** Confidence score [0,1] with the best-matching citation. */
  score: number;
  /** Citation URL that attributed this sentence; null = unsourced. */
  citationUrl: string | null;
  /** Domain of that citation (convenience for UI badges). */
  citationDomain: string | null;
  /** True when no citation cleared the threshold. */
  unsourced: boolean;
  /** How the attribution was decided. Lets the UI rank confidence. */
  attributedVia: AttributedVia;
}

export interface AttributionResult {
  sentences: SentenceAttribution[];
  /** Sentences that found no source above threshold. */
  unsourcedCount: number;
  /** unsourced / total (0 if no sentences). */
  unsourcedRatio: number;
  /** Citations that attributed at least one sentence, by URL. */
  usedCitationUrls: string[];
}

export function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * A piece is "real prose" — not a stand-alone markdown decoration that
 * splitSentences would otherwise hand to attribution as a useless sentence.
 */
function isMarkdownNoise(s: string): boolean {
  // Pure horizontal rule (---, ***, ___, ===) of any length.
  if (/^[\s]*[-*_=]{3,}[\s]*$/.test(s)) return true;
  // Standalone markdown emphasis/header/list scaffolding with no real text.
  if (/^[\s#>*+\-_=]+$/.test(s)) return true;
  // Single emoji or punctuation glyph left behind by a marker strip.
  if (/^[\p{P}\p{S}]+$/u.test(s)) return true;
  return false;
}

/**
 * Best-effort sentence splitter. Breaks on `.!?` + whitespace, on double
 * newlines, and on single newlines followed by list/heading markers.
 * Drops markdown-only fragments (horizontal rules, bare list bullets, lone
 * emphasis runs) — they were inflating unsourced ratios with noise.
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const normalised = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  const out: string[] = [];
  const paragraphs = normalised.split(/\n\n+/);
  for (const para of paragraphs) {
    const cleaned = para.replace(/\n+/g, ' ').trim();
    if (!cleaned || isMarkdownNoise(cleaned)) continue;
    // Split on end-of-sentence punctuation followed by whitespace + capital-
    // ish char. Unicode \p{Lu} catches non-ASCII uppercase.
    const pieces = cleaned.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/gu);
    for (const piece of pieces) {
      const t = piece.trim();
      if (!t || isMarkdownNoise(t)) continue;
      out.push(t);
    }
  }
  return out;
}

