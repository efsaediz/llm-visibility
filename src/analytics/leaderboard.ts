/**
 * Domain leaderboard aggregation.
 *
 * Walks every stored capture and buckets citations by domain so the popup
 * can show which domains ChatGPT actually surfaces vs. which ones it keeps
 * touching but never promotes to primary. This is the flipside of per-
 * capture ghost analysis — same signal, aggregated across the user's
 * entire history to reveal systematic ghosting.
 *
 * Runs in-memory over the captures table. At ~tens of captures this is
 * instant; if we ever cross thousands we'll move to indexed aggregation.
 */

import type { CaptureRow } from '../db';

export interface DomainStat {
  domain: string;
  /** Captures where this domain appeared as a primary citation. */
  primaryCount: number;
  /** Captures where this domain was only a supporting citation. */
  supportingCount: number;
  /**
   * Captures where this domain was only reached via safe_urls — touched
   * by ChatGPT but never cited in the visible answer. Pure ghost territory.
   */
  ghostCount: number;
  /** Unique captures that surfaced this domain in any pool. */
  totalCaptures: number;
  /** primaryCount / totalCaptures. Higher = more reliably surfaced. */
  visibilityRate: number;
  /** Most recent ISO timestamp where this domain appeared. */
  lastSeenAt: string;
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function buildDomainLeaderboard(rows: CaptureRow[]): DomainStat[] {
  const stats = new Map<string, DomainStat>();

  const touch = (domain: string, capturedAt: string): DomainStat => {
    let s = stats.get(domain);
    if (!s) {
      s = {
        domain,
        primaryCount: 0,
        supportingCount: 0,
        ghostCount: 0,
        totalCaptures: 0,
        visibilityRate: 0,
        lastSeenAt: capturedAt,
      };
      stats.set(domain, s);
    }
    if (capturedAt > s.lastSeenAt) s.lastSeenAt = capturedAt;
    return s;
  };

  for (const row of rows) {
    // Per-capture tier: once a domain is seen as primary in a capture we
    // don't also count it as supporting/ghost for the same capture. This
    // keeps the leaderboard counts interpretable ("primaryCount captures").
    const primaryDomains = new Set<string>();
    const supportingDomains = new Set<string>();
    const allDomains = new Set<string>();

    for (const c of row.conversation.citations) {
      if (!c.domain) continue;
      allDomains.add(c.domain);
      if (c.isPrimary) primaryDomains.add(c.domain);
      else supportingDomains.add(c.domain);
    }
    for (const url of row.conversation.safeUrls) {
      const d = domainFromUrl(url);
      if (d) allDomains.add(d);
    }

    for (const domain of allDomains) {
      const s = touch(domain, row.capturedAt);
      s.totalCaptures += 1;
      if (primaryDomains.has(domain)) s.primaryCount += 1;
      else if (supportingDomains.has(domain)) s.supportingCount += 1;
      else s.ghostCount += 1;
    }
  }

  for (const s of stats.values()) {
    s.visibilityRate = s.totalCaptures > 0 ? s.primaryCount / s.totalCaptures : 0;
  }

  return Array.from(stats.values()).sort((a, b) => {
    if (b.totalCaptures !== a.totalCaptures) return b.totalCaptures - a.totalCaptures;
    return b.primaryCount - a.primaryCount;
  });
}

export interface DomainCaptureHit {
  captureId: string;
  capturedAt: string;
  userPrompt: string;
  /**
   * How the domain appeared in this capture. Primary wins over supporting,
   * supporting wins over ghost — mirrors the leaderboard bucketing rule.
   */
  tier: 'primary' | 'supporting' | 'ghost';
  /** Every URL for this domain in this capture, primary-first. */
  urls: string[];
  /** Citation titles for this domain in this capture (omitting ghost URLs). */
  titles: string[];
}

/**
 * Per-capture timeline for a single domain. Powers the leaderboard drilldown —
 * answers "when did this domain surface, and with what tier, across history?".
 * Newest first so the modal reads top-down.
 */
export function getDomainTimeline(
  rows: CaptureRow[],
  domain: string,
): DomainCaptureHit[] {
  const out: DomainCaptureHit[] = [];
  for (const row of rows) {
    const primaryUrls: string[] = [];
    const supportingUrls: string[] = [];
    const titles: string[] = [];
    for (const c of row.conversation.citations) {
      if (c.domain !== domain) continue;
      if (c.isPrimary) primaryUrls.push(c.url);
      else supportingUrls.push(c.url);
      if (c.title) titles.push(c.title);
    }
    let ghostUrls: string[] = [];
    if (primaryUrls.length === 0 && supportingUrls.length === 0) {
      for (const u of row.conversation.safeUrls) {
        if (domainFromUrl(u) === domain) ghostUrls.push(u);
      }
    }
    const hasAny =
      primaryUrls.length + supportingUrls.length + ghostUrls.length > 0;
    if (!hasAny) continue;
    const tier: 'primary' | 'supporting' | 'ghost' =
      primaryUrls.length > 0
        ? 'primary'
        : supportingUrls.length > 0
          ? 'supporting'
          : 'ghost';
    out.push({
      captureId: row.id,
      capturedAt: row.capturedAt,
      userPrompt: row.conversation.userPrompt ?? '',
      tier,
      urls: [...primaryUrls, ...supportingUrls, ...ghostUrls],
      titles,
    });
  }
  return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

export interface BrandRollup {
  brandId: string;
  brandName: string;
  /** Total hits across all captures, all tiers. */
  totalHits: number;
  primaryHits: number;
  supportingHits: number;
  ghostHits: number;
  /** Captures where this brand was detected at all. */
  captureCount: number;
  lastSeenAt: string;
}

export interface BrandCaptureHit {
  captureId: string;
  capturedAt: string;
  userPrompt: string;
  totalHits: number;
  primaryHits: number;
  supportingHits: number;
  ghostHits: number;
}

/**
 * Per-capture timeline for a single brand. Mirror of getDomainTimeline so the
 * Brands tab gets the same drilldown affordance — answers "in which captures
 * did this brand surface, and how strongly?".
 */
export function getBrandTimeline(
  rows: CaptureRow[],
  brandId: string,
): BrandCaptureHit[] {
  const out: BrandCaptureHit[] = [];
  for (const row of rows) {
    const mention = row.brandMentions?.find((m) => m.brandId === brandId);
    if (!mention) continue;
    out.push({
      captureId: row.id,
      capturedAt: row.capturedAt,
      userPrompt: row.conversation.userPrompt ?? '',
      totalHits: mention.totalHits,
      primaryHits: mention.primaryHits,
      supportingHits: mention.supportingHits,
      ghostHits: mention.ghostHits,
    });
  }
  return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

/** Aggregate brand mentions across every capture for the Brands popup tab. */
export function buildBrandRollup(rows: CaptureRow[]): BrandRollup[] {
  const rollup = new Map<string, BrandRollup>();

  for (const row of rows) {
    for (const m of row.brandMentions ?? []) {
      let r = rollup.get(m.brandId);
      if (!r) {
        r = {
          brandId: m.brandId,
          brandName: m.brandName,
          totalHits: 0,
          primaryHits: 0,
          supportingHits: 0,
          ghostHits: 0,
          captureCount: 0,
          lastSeenAt: row.capturedAt,
        };
        rollup.set(m.brandId, r);
      }
      r.totalHits += m.totalHits;
      r.primaryHits += m.primaryHits;
      r.supportingHits += m.supportingHits;
      r.ghostHits += m.ghostHits;
      r.captureCount += 1;
      if (row.capturedAt > r.lastSeenAt) r.lastSeenAt = row.capturedAt;
    }
  }

  return Array.from(rollup.values()).sort((a, b) => b.totalHits - a.totalHits);
}
