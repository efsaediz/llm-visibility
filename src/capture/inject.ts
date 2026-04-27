/**
 * Injected into ChatGPT's page world at document_start.
 *
 * Monkey-patches `window.fetch` so we can observe Server-Sent Event streams
 * without interfering with ChatGPT's own consumption of them. We clone each
 * matching response, parse the SSE frames, and forward them to the content
 * script via window.postMessage (page world cannot use chrome.runtime).
 *
 * Day 1 scope: HTTP SSE only. WebSocket handoff (thinking mode) is v2.
 */

import { SSEParser } from './sse-parser';
import {
  envelope,
  isEnvelope,
  MESSAGE_SOURCE,
  type CaptureMessage,
  type ControlMessage,
  type RawSSEEvent,
} from '../shared/messages';
import { runPromptInPage } from '../batch/page-runner';

const TAG = '[llm-visibility/inject]';

const CONVERSATION_URL_PATTERN =
  /\/backend-(api|anon)\/(f\/|fc\/)?conversation(\/|$|\?)/;

/**
 * Stream reads fail with these when the user stops generation, closes the
 * tab, or the network blips. Not bugs — don't pollute the Errors panel.
 */
const isExpectedStreamEnd = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /network error|aborted|The user aborted|BodyStreamBuffer was aborted/i.test(
    msg,
  );
};

function send(payload: CaptureMessage) {
  window.postMessage(envelope(MESSAGE_SOURCE.INJECT, payload), '*');
}

const originalFetch = window.fetch.bind(window);

window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>) {
  // Pull the user prompt from the OUTBOUND body before the request leaves.
  // Must happen pre-await because fetch consumes request streams. Parsing
  // is best-effort — if it fails we just won't have a prompt for this row.
  let userPrompt: string | undefined;
  try {
    const url = extractUrl(args[0]);
    if (CONVERSATION_URL_PATTERN.test(url)) {
      userPrompt = await extractUserPrompt(args);
    }
  } catch (err) {
    console.debug(TAG, 'prompt extract error', err);
  }

  const response = await originalFetch(...args);

  try {
    const url = extractUrl(args[0]);
    const contentType = response.headers.get('content-type') ?? '';

    const isConversationSSE =
      contentType.includes('text/event-stream') &&
      CONVERSATION_URL_PATTERN.test(url);

    if (isConversationSSE) {
      const cloned = response.clone();
      captureStream(url, cloned, userPrompt).catch((err) => {
        if (isExpectedStreamEnd(err)) return;
        console.debug(TAG, 'capture error', err);
      });
    }
  } catch (err) {
    console.debug(TAG, 'fetch wrap error', err);
  }

  return response;
};

/**
 * ChatGPT's POST body puts the just-typed message in `messages[last]` with
 * `author.role === 'user'` and `content.parts[]`. We read the body via
 * either the init.body (string/FormData/etc) or a Request clone.
 */
async function extractUserPrompt(
  args: Parameters<typeof fetch>,
): Promise<string | undefined> {
  const [input, init] = args;
  let bodyText: string | null = null;

  if (init?.body && typeof init.body === 'string') {
    bodyText = init.body;
  } else if (input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      return undefined;
    }
  }

  if (!bodyText) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') return undefined;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;

  // Walk backwards — the newest user turn is the one we want. Earlier
  // messages in the array are history echoes from branched conversations.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const author = (m as { author?: { role?: unknown } }).author;
    if (author?.role !== 'user') continue;
    const content = (m as { content?: { parts?: unknown } }).content;
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter((p): p is string => typeof p === 'string')
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function extractUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

async function captureStream(
  url: string,
  response: Response,
  userPrompt?: string,
): Promise<void> {
  if (!response.body) return;

  const startedAt = new Date().toISOString();
  send({ type: 'CAPTURE_STARTED', url, startedAt, userPrompt });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const events: RawSSEEvent[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const evt of parser.feed(chunk)) {
        events.push({ ...evt, ts: Date.now() });
      }
    }
    const tail = parser.flush();
    if (tail) events.push({ ...tail, ts: Date.now() });
  } catch (err) {
    if (!isExpectedStreamEnd(err)) {
      console.debug(TAG, 'stream read error', err);
    }
  }

  send({
    type: 'CAPTURE_COMPLETE',
    url,
    capturedAt: new Date().toISOString(),
    events,
    userPrompt,
  });
}

// Batch-control listener. Background sends RUN_PROMPT through content.ts;
// content.ts forwards to the page world via window.postMessage with the
// CONTENT source tag. We type the prompt + submit and post the outcome back
// through the same channel as captures (INJECT source) so background sees
// it on its existing onMessage handler.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isEnvelope(data)) return;
  if (data.__source !== MESSAGE_SOURCE.CONTENT) return;
  const payload = data.payload as ControlMessage | undefined;
  if (!payload || payload.type !== 'RUN_PROMPT') return;

  void runPromptInPage(payload.prompt, payload.freshChat).then((res) => {
    send({ type: 'RUN_PROMPT_RESULT', ok: res.ok, error: res.error });
  });
});

console.info(TAG, 'injected', { pattern: CONVERSATION_URL_PATTERN.source });
