/**
 * Content script — runs in the isolated world on chatgpt.com.
 *
 * Bridge between inject.ts (page world, no chrome APIs) and the background
 * service worker. We listen for window.postMessage with our source tag and
 * forward the payload through chrome.runtime.
 */

import { isEnvelope, envelope, MESSAGE_SOURCE } from '../shared/messages';

const TAG = '[llm-visibility/content]';

const isContextInvalidated = (err: unknown) =>
  /Extension context invalidated/i.test(String(err));

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isEnvelope(data)) return;
  if (data.__source !== MESSAGE_SOURCE.INJECT) return;

  // After an extension reload this page still holds the old content script.
  // `chrome.runtime` may be missing entirely, or `sendMessage` may throw
  // synchronously, or the returned promise may reject. Handle all three.
  if (!chrome.runtime?.id) return;

  try {
    const result = chrome.runtime.sendMessage(
      envelope(MESSAGE_SOURCE.CONTENT, data.payload),
    );
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        if (!isContextInvalidated(err)) {
          console.warn(TAG, 'sendMessage error', err);
        }
      });
    }
  } catch (err) {
    if (!isContextInvalidated(err)) {
      console.warn(TAG, 'forward error', err);
    }
  }
});

// Reverse direction: background → page-world. Used by the batch orchestrator
// to drive RUN_PROMPT into the existing inject.ts automation listener. The
// inject side filters by source tag so we re-envelope as CONTENT here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isEnvelope(message) && message.__source === MESSAGE_SOURCE.BACKGROUND) {
    window.postMessage(envelope(MESSAGE_SOURCE.CONTENT, message.payload), '*');
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

console.info(TAG, 'ready');
