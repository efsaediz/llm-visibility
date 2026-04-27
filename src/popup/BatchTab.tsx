/**
 * Batch tab — paste a list of prompts, fire them at chatgpt.com one by one,
 * watch each capture roll in tagged with the batch label.
 *
 * Live state lives in the background orchestrator; we mirror it via
 * chrome.storage.session and render off that. The popup can close mid-run
 * without affecting the batch — when it reopens we hydrate from session.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BATCH_STATE_KEY,
  type BatchRequest,
  type BatchState,
} from '../shared/messages';

function useBatchState(): BatchState | null {
  const [state, setState] = useState<BatchState | null>(null);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.session.get(BATCH_STATE_KEY).then((res) => {
      if (cancelled) return;
      setState((res?.[BATCH_STATE_KEY] as BatchState | null) ?? null);
    });
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== 'session') return;
      if (BATCH_STATE_KEY in changes) {
        setState((changes[BATCH_STATE_KEY].newValue as BatchState | null) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return state;
}

async function send(req: BatchRequest): Promise<{ state: BatchState | null; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (reply) => {
      const err = chrome.runtime.lastError?.message;
      resolve({
        state: (reply?.state as BatchState | null) ?? null,
        error: err ?? reply?.error,
      });
    });
  });
}

function parsePrompts(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function BatchTab() {
  const state = useBatchState();
  const [draft, setDraft] = useState('');
  const [tag, setTag] = useState('');
  const [freshChat, setFreshChat] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isRunning =
    !!state && !state.cancelled && !state.finishedAt;
  const isFinishedOrCancelled =
    !!state && (!!state.finishedAt || state.cancelled);

  const prompts = useMemo(() => parsePrompts(draft), [draft]);

  async function onStart() {
    setError(null);
    if (prompts.length === 0) {
      setError('En az bir prompt girmelisin.');
      return;
    }
    if (prompts.length > 50) {
      setError('Tek seferde 50 prompt sınırı var; daha küçük gruplara böl.');
      return;
    }
    const reply = await send({
      type: 'BATCH_START',
      prompts,
      tag: tag.trim() || undefined,
      freshChat,
    });
    if (reply.error) setError(reply.error);
  }

  async function onCancel() {
    await send({ type: 'BATCH_CANCEL' });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-[11px] text-slate-700">
        <div className="font-semibold text-emerald-800">Batch run</div>
        <div className="mt-1 leading-snug">
          Her satıra bir prompt yaz. Extension chatgpt.com sekmesini açıp her
          prompt'u sırayla çalıştırır, sonuçlar History'ye etiketli düşer.
        </div>
      </div>

      {state && (
        <BatchProgressCard
          state={state}
          onCancel={onCancel}
          running={isRunning}
        />
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          Promptlar ({prompts.length})
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'Türkiye en iyi yazılım ajansları\nAnthropic son model\n...'}
          rows={6}
          disabled={isRunning}
          className="w-full rounded border border-slate-200 px-2 py-1 font-mono text-[11px] focus:border-emerald-400 focus:outline-none disabled:bg-slate-50"
        />

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Etiket (opsiyonel)
            </label>
            <input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="örn. yazlik-elbise"
              disabled={isRunning}
              className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-emerald-400 focus:outline-none disabled:bg-slate-50"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-700">
              <input
                type="checkbox"
                checked={freshChat}
                onChange={(e) => setFreshChat(e.target.checked)}
                disabled={isRunning}
                className="h-3 w-3"
              />
              Her promptta yeni sohbet
            </label>
          </div>
        </div>

        {error && (
          <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
            {error}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={isRunning || prompts.length === 0}
            className="flex-1 rounded bg-emerald-500 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? 'Çalışıyor…' : `Başlat (${prompts.length})`}
          </button>
          {isRunning && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
            >
              İptal
            </button>
          )}
          {isFinishedOrCancelled && (
            <button
              type="button"
              onClick={() => {
                void chrome.storage.session.remove(BATCH_STATE_KEY);
              }}
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
            >
              Temizle
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BatchProgressCard({
  state,
  onCancel,
  running,
}: {
  state: BatchState;
  onCancel: () => void;
  running: boolean;
}) {
  const total = state.items.length;
  const done = state.items.filter((i) => i.status === 'done').length;
  const failed = state.items.filter((i) => i.status === 'failed').length;
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
  const headerClass = state.cancelled
    ? 'text-rose-700'
    : state.finishedAt
      ? 'text-emerald-700'
      : 'text-slate-800';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-xs font-semibold ${headerClass}`}>
            {state.cancelled
              ? 'İptal edildi'
              : state.finishedAt
                ? 'Tamamlandı'
                : `Çalışıyor — ${state.cursor + 1}/${total}`}
          </div>
          <div className="text-[10px] text-slate-500">
            {state.tag ? `${state.tag} · ` : ''}
            {done} done · {failed} failed · {total - done - failed} pending
          </div>
        </div>
        {running && (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-100"
          >
            İptal
          </button>
        )}
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-200">
        <div
          className={`h-full transition-all ${
            state.cancelled ? 'bg-rose-400' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {state.items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-1.5 text-[11px]"
            title={item.error}
          >
            <StatusDot status={item.status} />
            <span
              className={`flex-1 line-clamp-1 ${
                item.status === 'failed' ? 'text-rose-700' : 'text-slate-700'
              }`}
            >
              {item.prompt}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusDot({ status }: { status: BatchState['items'][number]['status'] }) {
  const cls =
    status === 'done'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-rose-500'
        : status === 'running'
          ? 'bg-amber-400 animate-pulse'
          : 'bg-slate-300';
  return <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}
