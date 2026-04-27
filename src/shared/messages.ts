/**
 * Message contracts flowing between the three extension worlds:
 *   inject.ts  (page world)  ──postMessage──▶  content.ts  ──chrome.runtime──▶  background
 *
 * The __source tag distinguishes our traffic from the page's own postMessages.
 */

export const MESSAGE_SOURCE = {
  INJECT: 'llm-visibility-inject',
  CONTENT: 'llm-visibility-content',
  BACKGROUND: 'llm-visibility-background',
} as const;

export interface RawSSEEvent {
  event: string;
  data: string;
  ts: number;
}

export type CaptureMessage =
  | {
      type: 'CAPTURE_STARTED';
      url: string;
      startedAt: string;
      /**
       * User's prompt extracted from the outbound POST body. Optional
       * because some ChatGPT endpoints (e.g. conversation reload without
       * a new message) won't carry one. May be truncated upstream.
       */
      userPrompt?: string;
    }
  | {
      type: 'CAPTURE_COMPLETE';
      url: string;
      capturedAt: string;
      events: RawSSEEvent[];
      userPrompt?: string;
    }
  | {
      // Result returned by the page-world automation after attempting to
      // type + submit a batch prompt. Flows the same path as captures
      // (inject → content → background) so we don't add a new channel.
      type: 'RUN_PROMPT_RESULT';
      ok: boolean;
      error?: string;
    };

/**
 * Page-world automation request. Background sends this to a chatgpt.com
 * tab to run a single batch prompt. Lives on its own channel because it
 * flows in the opposite direction of CaptureMessage.
 */
export type ControlMessage = {
  type: 'RUN_PROMPT';
  prompt: string;
  freshChat: boolean;
};

/** Status of one prompt within a batch run. */
export type BatchItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BatchItem {
  prompt: string;
  status: BatchItemStatus;
  /** Row id of the resulting capture, when status === 'done'. */
  capturedRowId?: string;
  error?: string;
}

export interface BatchState {
  id: string;
  tag?: string;
  freshChat: boolean;
  items: BatchItem[];
  cursor: number;
  startedAt: string;
  finishedAt?: string;
  cancelled: boolean;
}

/** Popup ↔ background messages for batch control. */
export type BatchRequest =
  | { type: 'BATCH_START'; prompts: string[]; tag?: string; freshChat: boolean }
  | { type: 'BATCH_CANCEL' }
  | { type: 'BATCH_QUERY' };

export type BatchResponse = { type: 'BATCH_STATE'; state: BatchState | null };

/** chrome.storage.session key where background mirrors the live batch state. */
export const BATCH_STATE_KEY = 'llmv:batchState';

export interface EnvelopedMessage<T = unknown> {
  __source: (typeof MESSAGE_SOURCE)[keyof typeof MESSAGE_SOURCE];
  payload: T;
}

export function envelope<T>(
  source: (typeof MESSAGE_SOURCE)[keyof typeof MESSAGE_SOURCE],
  payload: T,
): EnvelopedMessage<T> {
  return { __source: source, payload };
}

export function isEnvelope(value: unknown): value is EnvelopedMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__source' in value &&
    'payload' in value
  );
}
