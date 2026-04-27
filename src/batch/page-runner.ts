/**
 * Page-world automation for batch prompt runs.
 *
 * Lives in inject.ts's MAIN-world context so it can drive ChatGPT's React-
 * controlled inputs the same way a real user would. Background sends a
 * RUN_PROMPT control message; we type the text into the prompt box, fire
 * submit, and resolve. The streaming response is captured by the existing
 * fetch monkey-patch — we don't reinvent that path here.
 *
 * Robustness budget:
 *   - Multiple selectors per element so a UI tweak doesn't kill the whole
 *     pipeline. `findPromptInput` and `findSubmitButton` each fall through
 *     several candidates.
 *   - Best-effort fresh chat: try clicking the sidebar's New-chat button,
 *     fall back to history.pushState. ChatGPT's Next.js router picks up
 *     the popstate dispatch in practice.
 *   - All async waits gated by a deadline so a missing element fails fast
 *     rather than hanging the whole batch.
 */

const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 150;
const FRESH_CHAT_SETTLE_MS = 600;
const POST_SET_VALUE_SETTLE_MS = 80;

export interface RunPromptOutcome {
  ok: boolean;
  error?: string;
}

export async function runPromptInPage(
  text: string,
  freshChat: boolean,
): Promise<RunPromptOutcome> {
  try {
    if (freshChat) await tryStartFreshChat();

    const input = await waitForPromptInput(READY_TIMEOUT_MS);
    if (!input) return { ok: false, error: 'prompt input not found' };

    setPromptValue(input, text);
    await sleep(POST_SET_VALUE_SETTLE_MS);

    if (!(await submitPrompt(input))) {
      return { ok: false, error: 'submit failed' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function waitForPromptInput(
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = findPromptInput();
    if (el) return el;
    await sleep(READY_POLL_MS);
  }
  return null;
}

function findPromptInput(): HTMLElement | null {
  // Newer ChatGPT — contenteditable div with a known id.
  const ce = document.querySelector(
    'div#prompt-textarea[contenteditable="true"]',
  ) as HTMLElement | null;
  if (ce) return ce;
  // Looser fallback — first contenteditable inside any form.
  const ceFallback = document.querySelector(
    'form div[contenteditable="true"]',
  ) as HTMLElement | null;
  if (ceFallback) return ceFallback;
  // Older textarea variant.
  const ta = document.querySelector(
    'textarea#prompt-textarea, textarea[name="prompt-textarea"], form textarea',
  ) as HTMLTextAreaElement | null;
  return ta;
}

function setPromptValue(el: HTMLElement, value: string) {
  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement
  ) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement | HTMLTextAreaElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // Contenteditable — execCommand still fires the right input events for
  // React's handlers in practice, even though it's officially deprecated.
  el.focus();
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(el);
    sel.deleteFromDocument();
  }
  document.execCommand('insertText', false, value);
}

async function submitPrompt(input: HTMLElement): Promise<boolean> {
  const btn = findSubmitButton();
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  // Fallback: synthesize Enter on the input. ChatGPT's onKeyDown intercepts
  // unmodified Enter to submit; native textarea behaviour would be a newline.
  input.focus();
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(enter);
  // Heuristic: assume it worked. We rely on the capture pipeline timeout to
  // catch silent failures.
  return true;
}

function findSubmitButton(): HTMLButtonElement | null {
  const candidates: Array<HTMLButtonElement | null> = [
    document.querySelector(
      'button[data-testid="send-button"]',
    ) as HTMLButtonElement | null,
    document.querySelector(
      'button[data-testid="composer-send-button"]',
    ) as HTMLButtonElement | null,
    document.querySelector(
      'form button[aria-label*="Send" i]',
    ) as HTMLButtonElement | null,
    document.querySelector(
      'form button[type="submit"]',
    ) as HTMLButtonElement | null,
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return null;
}

async function tryStartFreshChat(): Promise<void> {
  // Prefer the sidebar's New-chat link — preserves session state better than
  // a hard navigation and works on every recent ChatGPT layout we've seen.
  const sidebarLinks = Array.from(
    document.querySelectorAll('a[href="/"]'),
  ) as HTMLElement[];
  const newChat = sidebarLinks.find((l) =>
    l.closest('nav, aside, header, [role="navigation"]') !== null,
  );
  if (newChat) {
    newChat.click();
    await sleep(FRESH_CHAT_SETTLE_MS);
    return;
  }
  // Fallback: SPA navigation. ChatGPT's router listens for popstate.
  if (window.location.pathname !== '/') {
    history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(FRESH_CHAT_SETTLE_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
