/**
 * Background-side batch orchestrator.
 *
 * Owns the state machine for one running batch: walks through prompts in
 * sequence, dispatches each to a chatgpt.com tab via the page-world
 * automation, waits for the existing capture pipeline to fire CAPTURE_COMPLETE,
 * and tags the resulting row with batch metadata.
 *
 * State is mirrored to chrome.storage.session so the popup can render live
 * progress even after it gets closed and reopened mid-run.
 */

import {
  BATCH_STATE_KEY,
  envelope,
  MESSAGE_SOURCE,
  type BatchItem,
  type BatchState,
  type ControlMessage,
} from '../shared/messages';

const TAG = '[llm-visibility/batch]';

/** How long we'll wait for one prompt's CAPTURE_COMPLETE before giving up. */
const CAPTURE_TIMEOUT_MS = 90_000;
/** Cooldown between prompts to dodge ChatGPT rate-limit signals. */
const INTER_PROMPT_DELAY_MS = 8_000;

let state: BatchState | null = null;
let captureWaiter: ((rowId: string) => void) | null = null;

export function getBatchState(): BatchState | null {
  return state;
}

/**
 * Called by background's persist() right after a row is saved. If a batch
 * is active and waiting for a capture, this resolves the per-prompt promise
 * and lets the orchestrator advance.
 */
export function notifyCaptureSaved(rowId: string): void {
  if (!state || state.cancelled || state.finishedAt) return;
  if (captureWaiter) {
    const resolve = captureWaiter;
    captureWaiter = null;
    resolve(rowId);
  }
}

/**
 * Cancel the active batch. The currently-running prompt is allowed to finish
 * (or time out) but no further prompts are dispatched.
 */
export function cancelBatch(): BatchState | null {
  if (state && !state.finishedAt) {
    state.cancelled = true;
    void persistState();
  }
  return state;
}

export async function startBatch(opts: {
  prompts: string[];
  tag?: string;
  freshChat: boolean;
}): Promise<BatchState> {
  if (state && !state.finishedAt && !state.cancelled) {
    throw new Error('A batch is already running.');
  }

  const tabId = await ensureChatGptTab();

  const id = makeBatchId();
  state = {
    id,
    tag: opts.tag,
    freshChat: opts.freshChat,
    items: opts.prompts.map((p) => ({ prompt: p, status: 'pending' })),
    cursor: 0,
    startedAt: new Date().toISOString(),
    cancelled: false,
  };
  await persistState();

  // Run asynchronously so the caller's BATCH_START response returns
  // immediately. The popup polls state through chrome.storage.session.
  void runLoop(tabId).catch((err) => {
    console.error(TAG, 'run loop crashed', err);
  });

  return state;
}

async function runLoop(tabId: number) {
  if (!state) return;
  for (let i = 0; i < state.items.length; i++) {
    if (state.cancelled) break;
    state.cursor = i;
    state.items[i].status = 'running';
    await persistState();

    // Arm the capture waiter BEFORE dispatching. ChatGPT can finish a short
    // answer faster than the await chain back to runLoop, and if waiter
    // setup happens after dispatch the CAPTURE_COMPLETE notification has
    // nowhere to land — the prompt then hangs the full 90s timeout.
    const { promise: capturePromise, disarm } = armCaptureWaiter(
      CAPTURE_TIMEOUT_MS,
    );

    const sendOk = await dispatchPrompt(tabId, state.items[i].prompt, state.freshChat);
    if (!sendOk.ok) {
      // Dispatch failed — no capture coming for this prompt, release the waiter.
      disarm();
      state.items[i].status = 'failed';
      state.items[i].error = sendOk.error ?? 'dispatch failed';
      await persistState();
      // Keep going — one bad prompt shouldn't kill the rest.
      await sleep(INTER_PROMPT_DELAY_MS);
      continue;
    }

    const rowId = await capturePromise;
    if (state.cancelled) break;
    if (rowId) {
      state.items[i].status = 'done';
      state.items[i].capturedRowId = rowId;
    } else {
      state.items[i].status = 'failed';
      state.items[i].error = 'capture timeout';
    }
    await persistState();

    if (i < state.items.length - 1 && !state.cancelled) {
      await sleep(INTER_PROMPT_DELAY_MS);
    }
  }
  state.finishedAt = new Date().toISOString();
  await persistState();
}

async function dispatchPrompt(
  tabId: number,
  prompt: string,
  freshChat: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const message: ControlMessage = { type: 'RUN_PROMPT', prompt, freshChat };

  const trySend = async () => {
    const reply = await chrome.tabs.sendMessage(
      tabId,
      envelope(MESSAGE_SOURCE.BACKGROUND, message),
    );
    // The content-script ack is just `{ok: true}`. The actual run result
    // (RUN_PROMPT_RESULT) flows back via the capture pipeline.
    if (!reply || reply.ok === false) throw new Error('content script not ready');
  };

  try {
    await trySend();
    return { ok: true };
  } catch (firstErr) {
    // Bail fast if the tab is gone — happens when the user closes the
    // chatgpt.com tab mid-batch. Otherwise chrome.tabs.reload silently fails
    // and we burn 30s waiting for an onUpdated event that will never fire.
    if (!(await tabExists(tabId))) {
      return { ok: false, error: 'chatgpt.com tab was closed' };
    }
    // Most common cause: the user's chatgpt.com tab still hosts a stale
    // content script from before the last extension reload. Reload the
    // tab once to inject the current build, then retry. Don't loop — if
    // it still fails after reload the page is genuinely broken.
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 30_000);
      // Brief settle so document_start scripts finish wiring listeners.
      await sleep(400);
      await trySend();
      return { ok: true };
    } catch (retryErr) {
      return {
        ok: false,
        error: `${errorMessage(firstErr)} → reload retry: ${errorMessage(retryErr)}`,
      };
    }
  }
}

/**
 * Pre-arm the capture waiter and return a promise + disarm handle. Caller
 * must dispatch the prompt AFTER calling this so a fast CAPTURE_COMPLETE
 * (short answer, instant SSE) doesn't fall on a null waiter and time out.
 */
function armCaptureWaiter(timeoutMs: number): {
  promise: Promise<string | null>;
  disarm: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveOuter!: (val: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    resolveOuter = resolve;
    captureWaiter = (rowId: string) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      captureWaiter = null;
      resolve(rowId);
    };
    timeoutId = setTimeout(() => {
      captureWaiter = null;
      resolve(null);
    }, timeoutMs);
  });
  const disarm = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    captureWaiter = null;
    resolveOuter(null);
  };
  return { promise, disarm };
}

async function ensureChatGptTab(): Promise<number> {
  // Prefer the active chatgpt.com tab in the focused window so we drive the
  // conversation the user is currently looking at — picking tabs[0] from a
  // browser with multiple ChatGPT tabs open frequently lands on the wrong
  // one (different conversation or logged out).
  const activeTabs = await chrome.tabs.query({
    url: 'https://chatgpt.com/*',
    active: true,
    lastFocusedWindow: true,
  });
  if (activeTabs.length > 0 && activeTabs[0].id != null) {
    return activeTabs[0].id;
  }
  // Fall back to any chatgpt.com tab; bring it forward.
  const allTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  if (allTabs.length > 0 && allTabs[0].id != null) {
    await chrome.tabs.update(allTabs[0].id, { active: true });
    if (allTabs[0].windowId != null) {
      await chrome.windows.update(allTabs[0].windowId, { focused: true });
    }
    return allTabs[0].id;
  }
  // No chatgpt.com tab open — create one.
  const created = await chrome.tabs.create({
    url: 'https://chatgpt.com/',
    active: true,
  });
  if (created.id == null) throw new Error('Failed to open chatgpt.com tab');
  // Wait for the tab to finish loading so the content script is ready.
  await waitForTabComplete(created.id, 30_000);
  return created.id;
}

/**
 * Returns true if the tab still exists. The orchestrator caches a tabId at
 * batch start; if the user closes that tab mid-run, chrome.tabs.get throws.
 * We use this to fail dispatches fast instead of hanging on a reload that
 * targets a dead tab.
 */
async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (
      changedId: number,
      info: chrome.tabs.TabChangeInfo,
    ) => {
      if (changedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdate);
        if (timer) clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
    timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
  });
}

async function persistState() {
  try {
    await chrome.storage.session.set({ [BATCH_STATE_KEY]: state });
  } catch (err) {
    console.warn(TAG, 'persistState failed', err);
  }
}

function makeBatchId(): string {
  // `crypto.randomUUID` is available in MV3 service workers.
  return (globalThis.crypto?.randomUUID?.() ??
    `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export for type imports elsewhere without pulling in implementation.
export type { BatchItem, BatchState };
