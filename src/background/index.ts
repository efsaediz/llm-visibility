/**
 * Background service worker.
 *
 * Receives capture envelopes from content scripts, runs the extractor,
 * persists the result to Dexie, and logs a compact summary. The debug
 * dumps that calibrated the extractor during Day 2 are gone — turn them
 * back on by flipping `DEBUG` below if extractor behaviour ever drifts.
 */

import {
  isEnvelope,
  MESSAGE_SOURCE,
  type BatchRequest,
  type CaptureMessage,
} from '../shared/messages';
import { extractConversation } from '../parse/extractors';
import { saveCapture } from '../db';
import { getBrands } from '../brands/storage';
import { detectBrandsInCapture } from '../brands/matcher';
import {
  cancelBatch,
  getBatchState,
  notifyCaptureSaved,
  startBatch,
} from '../batch/orchestrator';

const TAG = '[llm-visibility/bg]';
const DEBUG = false;

chrome.runtime.onInstalled.addListener((details) => {
  console.info(TAG, 'installed', details.reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isEnvelope(message) && message.__source === MESSAGE_SOURCE.CONTENT) {
    handleCapture(message.payload as CaptureMessage);
    sendResponse({ ok: true });
    return false;
  }
  // Popup-side batch control. Plain (non-enveloped) messages so the popup
  // doesn't have to know about the source-tag ceremony.
  if (
    message &&
    typeof (message as { type?: unknown }).type === 'string' &&
    typeof (message as { type: string }).type.startsWith === 'function' &&
    (message as { type: string }).type.startsWith('BATCH_')
  ) {
    handleBatchRequest(message as BatchRequest)
      .then((state) => sendResponse({ type: 'BATCH_STATE', state }))
      .catch((err: unknown) =>
        sendResponse({
          type: 'BATCH_STATE',
          state: getBatchState(),
          error: errorMessage(err),
        }),
      );
    return true; // keep the channel open for the async sendResponse above
  }
  return false;
});

async function handleBatchRequest(req: BatchRequest) {
  switch (req.type) {
    case 'BATCH_START':
      return startBatch({
        prompts: req.prompts,
        tag: req.tag,
        freshChat: req.freshChat,
      });
    case 'BATCH_CANCEL':
      return cancelBatch();
    case 'BATCH_QUERY':
      return getBatchState();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function handleCapture(msg: CaptureMessage) {
  switch (msg.type) {
    case 'CAPTURE_STARTED':
      if (DEBUG) console.info(TAG, 'capture started', { url: msg.url });
      break;

    case 'CAPTURE_COMPLETE': {
      void persist(msg);
      break;
    }

    case 'RUN_PROMPT_RESULT':
      // The batch orchestrator doesn't actually wait on this — it waits on
      // the next CAPTURE_COMPLETE. We just log so failures are diagnosable.
      if (!msg.ok) console.warn(TAG, 'run_prompt failed', msg.error);
      else if (DEBUG) console.info(TAG, 'run_prompt ok');
      break;
  }
}

async function persist(msg: CaptureMessage & { type: 'CAPTURE_COMPLETE' }) {
  try {
    const conversation = extractConversation(
      msg.url,
      msg.capturedAt,
      msg.events,
      msg.userPrompt,
    );
    // Brand detection runs inline with the write so list views can filter
    // by brand without a second pass. Empty brand list → empty mentions,
    // so this is effectively free for users who haven't set any up yet.
    const brands = await getBrands();
    const mentions = detectBrandsInCapture(conversation, brands);

    // If a batch is running, tag the row so the popup can filter / colour
    // captures by their batch origin and the orchestrator can advance.
    const batch = getBatchState();
    const batchInfo =
      batch && !batch.cancelled && !batch.finishedAt
        ? { id: batch.id, tag: batch.tag }
        : undefined;

    const row = await saveCapture(conversation, mentions, batchInfo);
    if (batchInfo) notifyCaptureSaved(row.id);

    console.info(TAG, 'saved capture', {
      id: row.id,
      rawEvents: row.rawEventCount,
      fanOuts: row.metrics.fanOutCount,
      primary: row.metrics.primaryCount,
      supporting: row.metrics.supportingCount,
      domains: row.metrics.uniqueDomainCount,
      ghostRatio: `${(row.metrics.ghostRatio * 100).toFixed(0)}%`,
      brands: row.detectedBrands.length,
      sentences: row.attribution.sentences.length,
      unsourced: `${(row.attribution.unsourcedRatio * 100).toFixed(0)}%`,
      batch: batchInfo?.tag ?? batchInfo?.id,
    });
    if (DEBUG) console.debug(TAG, 'full row', row);
  } catch (err) {
    console.error(TAG, 'extraction/persist failed', err, {
      url: msg.url,
      eventCount: msg.events.length,
    });
  }
}
