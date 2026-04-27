/**
 * Dexie (IndexedDB) schema for LLM Visibility.
 *
 * v1 — single-table layout. A capture row stores the full structured
 * conversation plus denormalised metrics for fast list rendering.
 * We'll split citations/queries into their own tables in v2 once we
 * start doing cross-conversation analytics (domain leaderboard, brand
 * tracking) and need indexed queries over them.
 */

import Dexie, { type Table } from 'dexie';
import type { CapturedConversation } from '../parse/schemas';
import type { BrandMention } from '../brands/matcher';
import type { AttributionResult } from '../attribution/attribute';

export interface CaptureRow {
  /** ChatGPT conversation id (primary key). */
  id: string;
  /** ISO timestamp the capture was received. Indexed for recency sort. */
  capturedAt: string;
  /** Source ChatGPT conversation URL. */
  url: string;
  rawEventCount: number;
  conversation: CapturedConversation;
  // Denormalised metrics — computed at write time so list views don't
  // have to re-walk every conversation on every render.
  metrics: {
    fanOutCount: number;
    primaryCount: number;
    supportingCount: number;
    uniqueDomainCount: number;
    touchedSources: number;
    ghostCount: number;
    ghostRatio: number;
  };
  /** Brand hits detected at write time, keyed by brand id. */
  brandMentions: BrandMention[];
  /** Brand ids that matched — stored flat for multi-entry indexed lookup. */
  detectedBrands: string[];
  /**
   * Per-sentence source attribution, computed at write time so list views
   * don't redo token scoring on every render. Old rows (pre-v3) stay with
   * an empty sentences list and unsourcedRatio 0 — we don't retro-score
   * them because old captures predate answerText extraction.
   */
  attribution: AttributionResult;
  /** User-supplied label for the batch run that produced this row. */
  batchTag?: string;
  /** Stable id of the batch run (one UUID per Run click). */
  batchId?: string;
}

export class LlmVisibilityDB extends Dexie {
  captures!: Table<CaptureRow, string>;

  constructor() {
    super('llm-visibility');
    this.version(1).stores({
      captures: 'id, capturedAt',
    });
    // v2: add multi-entry index on detectedBrands so the popup can list
    // every capture that mentioned brand X without scanning the whole table.
    this.version(2)
      .stores({
        captures: 'id, capturedAt, *detectedBrands',
      })
      .upgrade((tx) =>
        tx
          .table<CaptureRow>('captures')
          .toCollection()
          .modify((row) => {
            if (!row.brandMentions) row.brandMentions = [];
            if (!row.detectedBrands) row.detectedBrands = [];
          }),
      );
    // v3: add attribution. Same stores key — no new index needed because
    // attribution is only read via the row itself. Old rows get an empty
    // AttributionResult; re-running the attributor on stale captures would
    // need answerText which they don't have.
    this.version(3)
      .stores({
        captures: 'id, capturedAt, *detectedBrands',
      })
      .upgrade((tx) =>
        tx
          .table<CaptureRow>('captures')
          .toCollection()
          .modify((row) => {
            if (!row.attribution) {
              row.attribution = {
                sentences: [],
                unsourcedCount: 0,
                unsourcedRatio: 0,
                usedCitationUrls: [],
              };
            }
          }),
      );
  }
}

export const db = new LlmVisibilityDB();
