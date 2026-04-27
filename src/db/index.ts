/**
 * DB facade. Keeps callers away from Dexie table internals and centralises
 * the write path so metric computation can't drift between producers.
 */

import { computeMetrics, type CapturedConversation } from '../parse/schemas';
import type { BrandMention } from '../brands/matcher';
import { attributeAnswerTfidf } from '../attribution/tfidf';
import { db, type CaptureRow } from './schema';

export { db } from './schema';
export type { CaptureRow } from './schema';

/**
 * ChatGPT reuses the same conversation_id for every turn in a chat, so using
 * it as the PK silently overwrote follow-up turns. Compose with capturedAt
 * to give each turn its own row; conversation.id stays intact on the inner
 * payload for future per-chat grouping.
 */
function rowIdFor(conversation: CapturedConversation): string {
  return `${conversation.id}@${conversation.capturedAt}`;
}

export interface BatchInfo {
  id: string;
  tag?: string;
}

export async function saveCapture(
  conversation: CapturedConversation,
  brandMentions: BrandMention[] = [],
  batch?: BatchInfo,
): Promise<CaptureRow> {
  const m = computeMetrics(conversation);
  const attribution = attributeAnswerTfidf(conversation);
  const row: CaptureRow = {
    id: rowIdFor(conversation),
    capturedAt: conversation.capturedAt,
    url: conversation.url,
    rawEventCount: conversation.rawEventCount,
    conversation,
    metrics: {
      fanOutCount: conversation.searchQueries.length,
      primaryCount: m.primary,
      supportingCount: m.supporting,
      uniqueDomainCount: m.uniqueDomains,
      touchedSources: m.touchedSources,
      ghostCount: m.ghostCount,
      ghostRatio: m.ghostRatio,
    },
    brandMentions,
    detectedBrands: brandMentions.map((b) => b.brandId),
    attribution,
    batchTag: batch?.tag,
    batchId: batch?.id,
  };
  await db.captures.put(row);
  return row;
}

export function listRecentCaptures(limit = 50) {
  return db.captures.orderBy('capturedAt').reverse().limit(limit).toArray();
}

export function getCapture(id: string) {
  return db.captures.get(id);
}

export async function deleteCapture(id: string) {
  await db.captures.delete(id);
}

export async function clearAllCaptures() {
  await db.captures.clear();
}
