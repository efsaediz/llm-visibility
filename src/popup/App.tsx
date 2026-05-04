import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteCapture, type CaptureRow } from '../db';
import {
  buildBrandRollup,
  buildDomainLeaderboard,
  getBrandTimeline,
  getDomainTimeline,
  type BrandRollup,
  type DomainStat,
} from '../analytics/leaderboard';
import { downloadCaptureCsv, downloadCitationsCsv } from '../export/csv';
import { BatchTab } from './BatchTab';

type Tab = 'latest' | 'history' | 'batch' | 'brands' | 'leaderboard';

// Same React app renders as the 360×520 action popup AND as a full-viewport
// tab. `?view=tab` flips the layout switch — wider container, taller list
// areas, multi-column grids where they fit. Everything else is shared.
const IS_TAB_VIEW = new URLSearchParams(window.location.search).get('view') === 'tab';

function openInTab() {
  const url = chrome.runtime.getURL('src/popup/index.html') + '?view=tab';
  chrome.tabs.create({ url });
}

function openTab(url: string) {
  chrome.tabs.create({ url });
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function GhostBadge({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const tone =
    pct >= 40
      ? 'bg-rose-100 text-rose-700 border-rose-200'
      : pct >= 20
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-emerald-100 text-emerald-700 border-emerald-200';
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      title="Touched sources that stayed out of the primary citation list"
    >
      👻 {pct}%
    </span>
  );
}

function downloadJSON(row: CaptureRow) {
  const blob = new Blob([JSON.stringify(row, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `llmv-${row.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function UnsourcedBadge({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const tone =
    pct >= 50
      ? 'bg-rose-100 text-rose-700 border-rose-200'
      : pct >= 25
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      title="Hiçbir citation'a yüksek skorla bağlanamayan cümle oranı"
    >
      ❓ {pct}% unsourced
    </span>
  );
}

function NoSearchBadge() {
  return (
    <span
      className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
      title="ChatGPT bu yanıt için arama yapmadı; tüm içerik model ağırlıklarından"
    >
      💭 no-search
    </span>
  );
}

function AttributionList({ row }: { row: CaptureRow }) {
  const { attribution, conversation } = row;
  const hasCitations = conversation.citations.length > 0;

  if (attribution.sentences.length === 0) {
    return (
      <div className="text-[11px] text-slate-500">
        {conversation.answerText
          ? 'Yanıttan cümle çıkarılamadı.'
          : 'Bu capture answerText içermiyor (eski kayıt).'}
      </div>
    );
  }

  // No-search yanıt: model bu soruya kendi prior'undan cevap vermiş.
  // Attribution yerine ham cümleleri "model-only" etiketiyle göstermek
  // hem doğru hem de ürünün temel içgörüsü — "kaynak kullanılmadı" sinyali
  // cümle-cümle kırmızıya boyamaktan daha değerli.
  if (!hasCitations) {
    return (
      <div className="space-y-1.5">
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          Bu yanıt için ChatGPT <strong>hiç arama yapmadı</strong>. Cümleler
          model ağırlıklarından geldi — harici kaynak yok.
        </div>
        <ul className="space-y-1.5">
          {attribution.sentences.map((s) => (
            <li
              key={s.index}
              className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] leading-snug text-slate-700"
            >
              <div>{s.sentence}</div>
              <div className="mt-1">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                  model-only
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {attribution.sentences.map((s) => (
        <li
          key={s.index}
          className={`rounded border px-2 py-1.5 text-[11px] leading-snug ${
            s.unsourced
              ? 'border-rose-200 bg-rose-50/60 text-slate-800'
              : 'border-slate-200 bg-slate-50 text-slate-800'
          }`}
        >
          <div>{s.sentence}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px]">
            {s.unsourced ? (
              <span className="rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700">
                unsourced
              </span>
            ) : (
              <>
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">
                  {s.citationDomain}
                </span>
                <ViaBadge via={s.attributedVia} score={s.score} />
                {s.citationUrl && (
                  <button
                    type="button"
                    onClick={() => openTab(s.citationUrl as string)}
                    className="text-emerald-700 hover:underline"
                  >
                    open
                  </button>
                )}
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ViaBadge({
  via,
  score,
}: {
  via: 'inline' | 'quote' | 'tfidf' | null;
  score: number;
}) {
  if (via === 'inline') {
    return (
      <span
        className="rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800"
        title="ChatGPT'nin kendi inline citation marker'ı — ground truth"
      >
        ✓ inline
      </span>
    );
  }
  if (via === 'quote') {
    return (
      <span
        className="rounded border border-sky-300 bg-sky-100 px-1.5 py-0.5 font-medium text-sky-800"
        title="Cümledeki tırnak içi metin citation snippet'inde birebir geçiyor"
      >
        ❝ quote
      </span>
    );
  }
  if (via === 'tfidf') {
    return (
      <span className="text-slate-500" title="Lexical TF-IDF eşleşmesi">
        match {Math.round(score * 100)}%
      </span>
    );
  }
  return null;
}

function LatestView({ row }: { row: CaptureRow | undefined }) {
  if (!row) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
        Henüz capture yok. Aşağıdaki butondan ChatGPT'yi aç, bir soru sor —
        cevap tamamlandığında burada görünür.
      </div>
    );
  }
  const m = row.metrics;
  const primaryCitations = row.conversation.citations.filter((c) => c.isPrimary);
  const prompt = row.conversation.userPrompt;
  return (
    <div className="space-y-3">
      {prompt && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5 shadow-sm">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
            Prompt
          </div>
          <div className="whitespace-pre-wrap text-[11px] leading-snug text-slate-800">
            {prompt.length > 300 ? prompt.slice(0, 300) + '…' : prompt}
          </div>
        </div>
      )}
      <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-[11px] text-slate-500">
              {row.id}
            </div>
            <div className="text-[11px] text-slate-400">
              {fmtTime(row.capturedAt)}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {row.conversation.citations.length === 0 ? (
              <NoSearchBadge />
            ) : (
              <>
                <GhostBadge ratio={m.ghostRatio} />
                {row.attribution.sentences.length > 0 && (
                  <UnsourcedBadge ratio={row.attribution.unsourcedRatio} />
                )}
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <Stat label="Queries" value={m.fanOutCount} />
          <Stat label="Primary" value={m.primaryCount} />
          <Stat label="Supp." value={m.supportingCount} />
          <Stat label="Domains" value={m.uniqueDomainCount} />
        </div>

        <button
          type="button"
          onClick={() => downloadJSON(row)}
          className="mt-3 w-full rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        >
          Export JSON
        </button>
      </div>

      {row.attribution.sentences.length > 0 && (
        <Section
          title={
            row.conversation.citations.length === 0
              ? `Answer (${row.attribution.sentences.length} cümle · model-only)`
              : `Attribution (${
                  row.attribution.sentences.length -
                  row.attribution.unsourcedCount
                }/${row.attribution.sentences.length} sourced)`
          }
        >
          <AttributionList row={row} />
        </Section>
      )}

      {row.conversation.searchQueries.length > 0 && (
        <Section title="Fan-out queries">
          <ul className="space-y-1">
            {row.conversation.searchQueries.map((q, i) => (
              <li
                key={`${q.kind}-${i}`}
                className="flex items-start gap-2 text-[11px]"
              >
                <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1 text-[9px] uppercase text-slate-500">
                  {q.kind}
                </span>
                <span className="text-slate-700">{q.query}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {primaryCitations.length > 0 && (
        <Section title={`Primary citations (${primaryCitations.length})`}>
          <ul className="space-y-1">
            {primaryCitations.slice(0, 10).map((c) => (
              <li key={c.url} className="truncate text-[11px]">
                <a
                  href={c.url}
                  onClick={(e) => {
                    e.preventDefault();
                    openTab(c.url);
                  }}
                  className="text-emerald-700 hover:underline"
                  title={c.title ?? c.url}
                >
                  {c.domain}
                </a>
                {c.title && (
                  <span className="ml-2 text-slate-500">· {c.title}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-slate-50 py-1">
      <div className="text-sm font-semibold text-slate-800">{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        {title}
      </div>
      {children}
    </div>
  );
}

function BrandsView({
  rollup,
  totalCaptures,
  onOpen,
}: {
  rollup: BrandRollup[];
  totalCaptures: number;
  onOpen: (b: BrandRollup) => void;
}) {
  if (rollup.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
          Henüz brand tanımlı değil ya da mevcut capture'larda eşleşme yok.
          Options sayfasından brand ekle — yeni capture'lar otomatik taranır.
        </div>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="w-full rounded bg-emerald-500 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-600"
        >
          Brand listesini aç
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-slate-500">
          {rollup.length} brand · {totalCaptures} capture içinde
        </div>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
        >
          Manage
        </button>
      </div>
      {rollup.map((b) => {
        const ghostPct =
          b.totalHits > 0 ? Math.round((b.ghostHits / b.totalHits) * 100) : 0;
        return (
          <button
            key={b.brandId}
            type="button"
            onClick={() => onOpen(b)}
            className="w-full rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-sm hover:border-emerald-300 hover:bg-emerald-50/40"
            title="Bu brand'in timeline'ını aç"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-slate-900">
                  {b.brandName}
                </div>
                <div className="text-[10px] text-slate-500">
                  {b.captureCount} capture · {b.totalHits} hit · son{' '}
                  {fmtTime(b.lastSeenAt)}
                </div>
              </div>
              {ghostPct > 0 && (
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                    ghostPct >= 40
                      ? 'border-rose-200 bg-rose-100 text-rose-700'
                      : ghostPct >= 20
                        ? 'border-amber-200 bg-amber-100 text-amber-700'
                        : 'border-slate-200 bg-slate-100 text-slate-700'
                  }`}
                  title="Hit'lerin kaçı cite edilmediği surface'lerden geldi"
                >
                  👻 {ghostPct}%
                </span>
              )}
            </div>
            <div className="flex gap-3 text-[10px] text-slate-600">
              <span className="text-emerald-700">⭐ {b.primaryHits} primary</span>
              <span>+ {b.supportingHits} supp.</span>
              <span className="text-slate-500">
                👻 {b.ghostHits} ghost
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

type DomainMode = 'all-time' | 'by-chat';

function DomainModeToggle({
  mode,
  onChange,
}: {
  mode: DomainMode;
  onChange: (m: DomainMode) => void;
}) {
  return (
    <div className="mb-2 flex gap-1 rounded-lg bg-slate-200 p-1">
      <button
        type="button"
        onClick={() => onChange('all-time')}
        className={`flex-1 rounded px-3 py-1 text-[11px] font-medium ${
          mode === 'all-time' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
        }`}
      >
        All-time
      </button>
      <button
        type="button"
        onClick={() => onChange('by-chat')}
        className={`flex-1 rounded px-3 py-1 text-[11px] font-medium ${
          mode === 'by-chat' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
        }`}
      >
        By chat
      </button>
    </div>
  );
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function ByChatDomainsView({ rows }: { rows: CaptureRow[] | undefined }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
        Capture yok.
      </div>
    );
  }
  // Sort captures newest first so the most recent chat is at the top.
  const ordered = [...rows].sort((a, b) =>
    a.capturedAt < b.capturedAt ? 1 : -1,
  );
  return (
    <div className="space-y-2">
      {ordered.map((row) => {
        const primary = new Set<string>();
        const supporting = new Set<string>();
        for (const c of row.conversation.citations) {
          if (!c.domain) continue;
          if (c.isPrimary) primary.add(c.domain);
          else supporting.add(c.domain);
        }
        const ghost = new Set<string>();
        for (const u of row.conversation.safeUrls) {
          const d = domainFromUrl(u);
          if (!d) continue;
          if (!primary.has(d) && !supporting.has(d)) ghost.add(d);
        }
        const total = primary.size + supporting.size + ghost.size;
        const noSearch = total === 0;
        return (
          <div
            key={row.id}
            className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-slate-800">
                  {fmtTime(row.capturedAt)}
                </div>
                <div className="truncate font-mono text-[9px] text-slate-400">
                  {row.id}
                </div>
              </div>
              {noSearch ? (
                <NoSearchBadge />
              ) : (
                <GhostBadge ratio={row.metrics.ghostRatio} />
              )}
            </div>
            {noSearch ? (
              <div className="text-[10px] italic text-slate-500">
                Bu sohbette arama yok.
              </div>
            ) : (
              <div className="space-y-1.5">
                {primary.size > 0 && (
                  <DomainGroup
                    label="Primary"
                    tone="emerald"
                    domains={[...primary]}
                  />
                )}
                {supporting.size > 0 && (
                  <DomainGroup
                    label="Supporting"
                    tone="slate"
                    domains={[...supporting]}
                  />
                )}
                {ghost.size > 0 && (
                  <DomainGroup
                    label="Ghost"
                    tone="rose"
                    domains={[...ghost]}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DomainGroup({
  label,
  tone,
  domains,
}: {
  label: string;
  tone: 'emerald' | 'slate' | 'rose';
  domains: string[];
}) {
  const toneClasses: Record<typeof tone, string> = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return (
    <div>
      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        {label} ({domains.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {domains.map((d) => (
          <span
            key={d}
            className={`rounded border px-1.5 py-0.5 text-[10px] ${toneClasses[tone]}`}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}

function AllTimeLeaderboardView({
  stats,
  onOpen,
}: {
  stats: DomainStat[];
  onOpen: (d: DomainStat) => void;
}) {
  if (stats.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
        Capture yok. ChatGPT'de birkaç soru sorduktan sonra domain'ler burada
        birikmeye başlar.
      </div>
    );
  }
  const top = stats.slice(0, 25);
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-slate-500">
        Top {top.length} · {stats.length} toplam domain
      </div>
      {top.map((d) => {
        const visPct = Math.round(d.visibilityRate * 100);
        const isGhost = d.primaryCount === 0 && d.ghostCount > 0;
        return (
          <button
            key={d.domain}
            type="button"
            onClick={() => onOpen(d)}
            className="w-full rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-sm hover:border-emerald-300 hover:bg-emerald-50/40"
            title="Bu domain'in timeline'ını aç"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-slate-900">
                  {d.domain}
                </div>
                <div className="text-[10px] text-slate-500">
                  {d.totalCaptures} capture · visibility {visPct}%
                </div>
              </div>
              {isGhost ? (
                <span
                  className="shrink-0 rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700"
                  title="Bu domain touched oldu ama hiç primary çıkmadı"
                >
                  pure ghost
                </span>
              ) : (
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                    visPct >= 60
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : visPct >= 30
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  {visPct}%
                </span>
              )}
            </div>
            <div className="mt-1.5 flex gap-3 text-[10px] text-slate-600">
              <span className="text-emerald-700">⭐ {d.primaryCount}</span>
              <span>+ {d.supportingCount}</span>
              <span className="text-slate-500">👻 {d.ghostCount}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function LeaderboardView({
  stats,
  rows,
  onOpenDomain,
}: {
  stats: DomainStat[];
  rows: CaptureRow[] | undefined;
  onOpenDomain: (d: DomainStat) => void;
}) {
  const [mode, setMode] = useState<DomainMode>('all-time');
  return (
    <div>
      <DomainModeToggle mode={mode} onChange={setMode} />
      {mode === 'all-time' ? (
        <AllTimeLeaderboardView stats={stats} onOpen={onOpenDomain} />
      ) : (
        <ByChatDomainsView rows={rows} />
      )}
    </div>
  );
}

function matchesQuery(row: CaptureRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (row.id.toLowerCase().includes(needle)) return true;
  if ((row.conversation.userPrompt ?? '').toLowerCase().includes(needle))
    return true;
  if ((row.conversation.answerText ?? '').toLowerCase().includes(needle))
    return true;
  for (const c of row.conversation.citations) {
    if (c.domain.toLowerCase().includes(needle)) return true;
    if ((c.title ?? '').toLowerCase().includes(needle)) return true;
  }
  for (const b of row.brandMentions) {
    if (b.brandName.toLowerCase().includes(needle)) return true;
  }
  if ((row.batchTag ?? '').toLowerCase().includes(needle)) return true;
  return false;
}

type HistoryMode = 'time' | 'chat';

interface ChatGroup {
  chatId: string;
  /** Turns in oldest→newest order so reading direction matches conversation flow. */
  turns: CaptureRow[];
  latestAt: string;
}

function groupByChat(rows: CaptureRow[]): ChatGroup[] {
  const map = new Map<string, CaptureRow[]>();
  for (const r of rows) {
    const cid = r.conversation.id || '(no-id)';
    const arr = map.get(cid) ?? [];
    arr.push(r);
    map.set(cid, arr);
  }
  const groups: ChatGroup[] = [];
  for (const [chatId, items] of map) {
    const sorted = [...items].sort((a, b) =>
      a.capturedAt < b.capturedAt ? -1 : 1,
    );
    groups.push({
      chatId,
      turns: sorted,
      latestAt: sorted[sorted.length - 1].capturedAt,
    });
  }
  return groups.sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));
}

function HistoryView({
  rows,
  onOpen,
}: {
  rows: CaptureRow[] | undefined;
  onOpen: (row: CaptureRow) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<HistoryMode>('time');

  const filtered = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : -1,
    );
    return sorted.filter((r) => matchesQuery(r, query));
  }, [rows, query]);

  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
        Geçmiş boş. ChatGPT'de soru sordukça burası dolacak.
      </div>
    );
  }

  const chatGroups = mode === 'chat' ? groupByChat(filtered) : [];

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Prompt / domain / brand ara…"
          className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-emerald-400 focus:outline-none"
        />
        <div className="mt-1.5 flex gap-1 rounded bg-slate-100 p-0.5">
          <button
            type="button"
            onClick={() => setMode('time')}
            className={`flex-1 rounded px-2 py-0.5 text-[10px] font-medium ${
              mode === 'time'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600'
            }`}
          >
            Zaman
          </button>
          <button
            type="button"
            onClick={() => setMode('chat')}
            className={`flex-1 rounded px-2 py-0.5 text-[10px] font-medium ${
              mode === 'chat'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600'
            }`}
          >
            Sohbet
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="text-[10px] text-slate-500">
            {mode === 'chat'
              ? `${chatGroups.length} sohbet · ${filtered.length}/${rows.length} capture`
              : `${filtered.length} / ${rows.length} capture`}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => downloadCaptureCsv(filtered)}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
              title="Wide CSV — one row per capture"
            >
              CSV ⬇
            </button>
            <button
              type="button"
              onClick={() => downloadCitationsCsv(filtered)}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
              title="Long CSV — one row per citation"
            >
              Citations ⬇
            </button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-[11px] text-slate-500">
          Eşleşme yok.
        </div>
      ) : mode === 'time' ? (
        filtered.map((row) => (
          <CaptureCard key={row.id} row={row} onOpen={onOpen} />
        ))
      ) : (
        chatGroups.map((g) => (
          <ChatGroupCard key={g.chatId} group={g} onOpen={onOpen} />
        ))
      )}
    </div>
  );
}

function CaptureCard({
  row,
  onOpen,
}: {
  row: CaptureRow;
  onOpen: (row: CaptureRow) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className="w-full rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-sm hover:border-emerald-300 hover:bg-emerald-50/40"
      title="Detayları aç"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {row.conversation.userPrompt && (
            <div className="mb-0.5 line-clamp-2 text-[11px] font-medium text-slate-800">
              {row.conversation.userPrompt}
            </div>
          )}
          <div className="truncate font-mono text-[9px] text-slate-400">
            {row.id}
          </div>
          <div className="text-[10px] text-slate-400">
            {fmtTime(row.capturedAt)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {row.conversation.citations.length === 0 ? (
            <NoSearchBadge />
          ) : (
            <>
              <GhostBadge ratio={row.metrics.ghostRatio} />
              {row.attribution.sentences.length > 0 && (
                <UnsourcedBadge ratio={row.attribution.unsourcedRatio} />
              )}
            </>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-600">
        <span>🔍 {row.metrics.fanOutCount}</span>
        <span>⭐ {row.metrics.primaryCount}</span>
        <span>+ {row.metrics.supportingCount}</span>
        <span>🌐 {row.metrics.uniqueDomainCount}</span>
        {row.detectedBrands.length > 0 && (
          <span className="text-emerald-700">
            🏷 {row.detectedBrands.length}
          </span>
        )}
        {row.batchTag && (
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-medium text-indigo-700">
            ⚙ {row.batchTag}
          </span>
        )}
      </div>
    </button>
  );
}

function ChatGroupCard({
  group,
  onOpen,
}: {
  group: ChatGroup;
  onOpen: (row: CaptureRow) => void;
}) {
  const first = group.turns[0];
  const last = group.turns[group.turns.length - 1];
  const firstPrompt = first.conversation.userPrompt;
  return (
    <div className="rounded-lg border border-slate-300 bg-slate-50/60 p-2 shadow-sm">
      <div className="mb-1.5 px-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate font-mono text-[9px] text-slate-400">
            {group.chatId}
          </div>
          <div className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[9px] font-medium text-slate-700">
            {group.turns.length} turn
          </div>
        </div>
        <div className="mt-0.5 text-[10px] text-slate-500">
          {fmtTime(first.capturedAt)}
          {group.turns.length > 1 && ` → ${fmtTime(last.capturedAt)}`}
        </div>
        {firstPrompt && (
          <div className="mt-1 line-clamp-1 text-[11px] italic text-slate-600">
            {firstPrompt}
          </div>
        )}
      </div>
      <div className="space-y-1">
        {group.turns.map((row, i) => {
          const prev = i > 0 ? group.turns[i - 1] : null;
          const isRegen =
            prev !== null &&
            prev.conversation.userPrompt === row.conversation.userPrompt &&
            !!row.conversation.userPrompt;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpen(row)}
              className="w-full rounded border border-slate-200 bg-white p-2 text-left hover:border-emerald-300 hover:bg-emerald-50/40"
              title="Detayları aç"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="font-medium">Turn {i + 1}</span>
                    <span>·</span>
                    <span>{fmtTime(row.capturedAt)}</span>
                    {isRegen && (
                      <span
                        className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-800"
                        title="Aynı prompt'la yeniden üretilmiş"
                      >
                        regen
                      </span>
                    )}
                  </div>
                  {row.conversation.userPrompt && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-800">
                      {row.conversation.userPrompt}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {row.conversation.citations.length === 0 ? (
                    <NoSearchBadge />
                  ) : (
                    <GhostBadge ratio={row.metrics.ghostRatio} />
                  )}
                </div>
              </div>
              <div className="mt-1 flex gap-3 text-[10px] text-slate-600">
                <span>🔍 {row.metrics.fanOutCount}</span>
                <span>⭐ {row.metrics.primaryCount}</span>
                <span>+ {row.metrics.supportingCount}</span>
                <span>🌐 {row.metrics.uniqueDomainCount}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CaptureDetailModal({
  row,
  onClose,
}: {
  row: CaptureRow | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  if (!row) return null;
  const { conversation, attribution, brandMentions } = row;
  const primaryCitations = conversation.citations.filter((c) => c.isPrimary);
  const supportingCitations = conversation.citations.filter((c) => !c.isPrimary);

  async function handleDelete() {
    if (!row) return;
    if (!confirm('Bu capture silinsin mi? Geri alınamaz.')) return;
    await deleteCapture(row.id);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-2"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-[10px] text-slate-400">
              {row.id}
            </div>
            <div className="text-[10px] text-slate-500">
              {fmtTime(row.capturedAt)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => downloadJSON(row)}
              className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
            >
              JSON ⬇
            </button>
            <button
              type="button"
              onClick={() => openTab(row.url)}
              className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
            >
              Sohbeti aç ↗
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-100"
              title="Bu capture'ı sil"
            >
              Sil
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
              title="ESC"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 text-[12px]">
          {conversation.userPrompt && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                Prompt
              </div>
              <div className="whitespace-pre-wrap rounded border border-emerald-200 bg-emerald-50/60 p-2 text-[12px] text-slate-800">
                {conversation.userPrompt}
              </div>
            </section>
          )}

          {conversation.answerText && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Yanıt
              </div>
              <div className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 leading-relaxed text-slate-800">
                {conversation.answerText}
              </div>
            </section>
          )}

          {conversation.searchQueries.length > 0 && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Fan-out queries ({conversation.searchQueries.length})
              </div>
              <ul className="space-y-1">
                {conversation.searchQueries.map((q, i) => (
                  <li key={`${q.kind}-${i}`} className="flex gap-2 text-[11px]">
                    <span className="shrink-0 rounded bg-slate-100 px-1 text-[9px] uppercase text-slate-500">
                      {q.kind}
                    </span>
                    <span>{q.query}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {brandMentions.length > 0 && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Brand eşleşmeleri
              </div>
              <ul className="space-y-1">
                {brandMentions.map((b) => (
                  <li key={b.brandId} className="text-[11px]">
                    <span className="font-semibold text-slate-800">
                      {b.brandName}
                    </span>
                    <span className="ml-2 text-slate-600">
                      {b.totalHits} hit ·
                      <span className="ml-1 text-emerald-700">
                        ⭐ {b.primaryHits}
                      </span>
                      <span className="ml-1">+ {b.supportingHits}</span>
                      <span className="ml-1 text-slate-500">
                        👻 {b.ghostHits}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {primaryCitations.length > 0 && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Primary citations ({primaryCitations.length})
              </div>
              <ul className="space-y-1">
                {primaryCitations.map((c) => (
                  <li key={c.url} className="text-[11px]">
                    <button
                      type="button"
                      onClick={() => openTab(c.url)}
                      className="text-emerald-700 hover:underline"
                    >
                      {c.domain}
                    </button>
                    {c.title && (
                      <span className="ml-2 text-slate-600">· {c.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {supportingCitations.length > 0 && (
            <section className="mb-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Supporting ({supportingCitations.length})
              </div>
              <ul className="space-y-0.5">
                {supportingCitations.slice(0, 30).map((c) => (
                  <li key={c.url} className="text-[11px] text-slate-600">
                    <button
                      type="button"
                      onClick={() => openTab(c.url)}
                      className="hover:underline"
                    >
                      {c.domain}
                    </button>
                    {c.title && <span className="ml-2">· {c.title}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {attribution.sentences.length > 0 && (
            <section>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Attribution ({attribution.sentences.length - attribution.unsourcedCount}/{attribution.sentences.length} sourced)
              </div>
              <AttributionList row={row} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: 'primary' | 'supporting' | 'ghost' }) {
  if (tier === 'primary') {
    return (
      <span className="shrink-0 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
        ⭐ primary
      </span>
    );
  }
  if (tier === 'supporting') {
    return (
      <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
        + supporting
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
      👻 ghost
    </span>
  );
}

function DomainDetailModal({
  domain,
  rows,
  onClose,
  onOpenCapture,
}: {
  domain: DomainStat | null;
  rows: CaptureRow[] | undefined;
  onClose: () => void;
  onOpenCapture: (row: CaptureRow) => void;
}) {
  useEffect(() => {
    if (!domain) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [domain, onClose]);

  const timeline = useMemo(() => {
    if (!domain || !rows) return [];
    return getDomainTimeline(rows, domain.domain);
  }, [domain, rows]);

  if (!domain) return null;

  const visPct = Math.round(domain.visibilityRate * 100);
  const rowsById = new Map(rows?.map((r) => [r.id, r]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-2"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">
              {domain.domain}
            </div>
            <div className="text-[10px] text-slate-500">
              {domain.totalCaptures} capture · visibility {visPct}% · son{' '}
              {fmtTime(domain.lastSeenAt)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => openTab(`https://${domain.domain}`)}
              className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
            >
              Siteyi aç ↗
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
              title="ESC"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="border-b border-slate-100 px-4 py-2">
          <div className="flex gap-4 text-[11px] text-slate-600">
            <span className="text-emerald-700">⭐ {domain.primaryCount} primary</span>
            <span>+ {domain.supportingCount} supporting</span>
            <span className="text-rose-700">👻 {domain.ghostCount} ghost</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {timeline.length === 0 ? (
            <div className="text-[11px] text-slate-500">
              Bu domain için timeline bulunamadı.
            </div>
          ) : (
            <ul className="space-y-2">
              {timeline.map((hit) => {
                const row = rowsById.get(hit.captureId);
                const titleShown = hit.titles[0];
                return (
                  <li
                    key={hit.captureId}
                    className="rounded border border-slate-200 bg-white p-2.5 shadow-sm"
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-slate-500">
                          {fmtTime(hit.capturedAt)}
                        </div>
                        {hit.userPrompt && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-800">
                            {hit.userPrompt}
                          </div>
                        )}
                        {titleShown && (
                          <div className="mt-0.5 line-clamp-1 text-[10px] italic text-slate-500">
                            “{titleShown}”
                          </div>
                        )}
                      </div>
                      <TierBadge tier={hit.tier} />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] text-slate-500">
                        {hit.urls.length} URL
                        {hit.urls.length > 1 ? 's' : ''}
                      </div>
                      <div className="flex gap-1">
                        {hit.urls.slice(0, 1).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => openTab(u)}
                            className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
                          >
                            Link aç ↗
                          </button>
                        ))}
                        {row && (
                          <button
                            type="button"
                            onClick={() => onOpenCapture(row)}
                            className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100"
                          >
                            Capture aç →
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function BrandDetailModal({
  brand,
  rows,
  onClose,
  onOpenCapture,
}: {
  brand: BrandRollup | null;
  rows: CaptureRow[] | undefined;
  onClose: () => void;
  onOpenCapture: (row: CaptureRow) => void;
}) {
  useEffect(() => {
    if (!brand) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brand, onClose]);

  const timeline = useMemo(() => {
    if (!brand || !rows) return [];
    return getBrandTimeline(rows, brand.brandId);
  }, [brand, rows]);

  if (!brand) return null;

  const ghostPct =
    brand.totalHits > 0
      ? Math.round((brand.ghostHits / brand.totalHits) * 100)
      : 0;
  const rowsById = new Map(rows?.map((r) => [r.id, r]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-2"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">
              {brand.brandName}
            </div>
            <div className="text-[10px] text-slate-500">
              {brand.captureCount} capture · {brand.totalHits} hit · son{' '}
              {fmtTime(brand.lastSeenAt)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-100"
            title="ESC"
          >
            ✕
          </button>
        </header>

        <div className="border-b border-slate-100 px-4 py-2">
          <div className="flex gap-4 text-[11px] text-slate-600">
            <span className="text-emerald-700">⭐ {brand.primaryHits} primary</span>
            <span>+ {brand.supportingHits} supporting</span>
            <span className="text-rose-700">👻 {brand.ghostHits} ghost</span>
            {ghostPct > 0 && (
              <span className="ml-auto text-slate-500">
                ghost oranı {ghostPct}%
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {timeline.length === 0 ? (
            <div className="text-[11px] text-slate-500">
              Bu brand için timeline bulunamadı.
            </div>
          ) : (
            <ul className="space-y-2">
              {timeline.map((hit) => {
                const row = rowsById.get(hit.captureId);
                const dominantTier: 'primary' | 'supporting' | 'ghost' =
                  hit.primaryHits > 0
                    ? 'primary'
                    : hit.supportingHits > 0
                      ? 'supporting'
                      : 'ghost';
                return (
                  <li
                    key={hit.captureId}
                    className="rounded border border-slate-200 bg-white p-2.5 shadow-sm"
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-slate-500">
                          {fmtTime(hit.capturedAt)}
                        </div>
                        {hit.userPrompt && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-800">
                            {hit.userPrompt}
                          </div>
                        )}
                      </div>
                      <TierBadge tier={dominantTier} />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex gap-3 text-[10px] text-slate-600">
                        <span>{hit.totalHits} hit</span>
                        <span className="text-emerald-700">
                          ⭐ {hit.primaryHits}
                        </span>
                        <span>+ {hit.supportingHits}</span>
                        <span className="text-slate-500">
                          👻 {hit.ghostHits}
                        </span>
                      </div>
                      {row && (
                        <button
                          type="button"
                          onClick={() => onOpenCapture(row)}
                          className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100"
                        >
                          Capture aç →
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('latest');
  const [selectedRow, setSelectedRow] = useState<CaptureRow | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<DomainStat | null>(null);
  const [selectedBrand, setSelectedBrand] = useState<BrandRollup | null>(null);

  // Latest pulls the most recent 20; History + rollups use the full set so
  // search, CSV export, and the leaderboard aren't truncated by the 20-row cap.
  const rows = useLiveQuery(
    () => db.captures.orderBy('capturedAt').reverse().limit(20).toArray(),
    [],
  );
  const allRows = useLiveQuery(() => db.captures.toArray(), []);

  const latest = useMemo(() => rows?.[0], [rows]);
  const leaderboard = useMemo(
    () => buildDomainLeaderboard(allRows ?? []),
    [allRows],
  );
  const brandRollup = useMemo(
    () => buildBrandRollup(allRows ?? []),
    [allRows],
  );

  return (
    <main
      className={
        IS_TAB_VIEW
          ? 'mx-auto flex min-h-screen w-full max-w-5xl flex-col bg-slate-50 p-6'
          : 'flex h-[520px] w-[360px] flex-col bg-slate-50 p-3'
      }
    >
      <header className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white font-bold text-sm">
          LV
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold leading-tight">LLM Visibility</h1>
          <p className="text-[10px] text-slate-500">ChatGPT capture</p>
        </div>
        {!IS_TAB_VIEW && (
          <button
            type="button"
            onClick={openInTab}
            className="rounded border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
            title="Tam ekran tab'da aç"
          >
            ↗
          </button>
        )}
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="rounded border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
          title="Brand ayarları"
        >
          ⚙
        </button>
        <button
          type="button"
          onClick={() => openTab('https://chatgpt.com')}
          className="rounded bg-emerald-500 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-600"
        >
          Open ChatGPT
        </button>
      </header>

      <nav className="mb-3 grid grid-cols-5 gap-1 rounded-lg bg-slate-200 p-1">
        <TabButton active={tab === 'latest'} onClick={() => setTab('latest')}>
          Latest
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabButton>
        <TabButton active={tab === 'batch'} onClick={() => setTab('batch')}>
          Batch
        </TabButton>
        <TabButton active={tab === 'brands'} onClick={() => setTab('brands')}>
          Brands
        </TabButton>
        <TabButton
          active={tab === 'leaderboard'}
          onClick={() => setTab('leaderboard')}
        >
          Domains
        </TabButton>
      </nav>

      <div
        className={
          IS_TAB_VIEW
            ? 'flex-1'
            : 'flex-1 overflow-y-auto'
        }
      >
        {tab === 'latest' && <LatestView row={latest} />}
        {tab === 'history' && (
          <HistoryView rows={allRows} onOpen={setSelectedRow} />
        )}
        {tab === 'batch' && <BatchTab />}
        {tab === 'brands' && (
          <BrandsView
            rollup={brandRollup}
            totalCaptures={allRows?.length ?? 0}
            onOpen={setSelectedBrand}
          />
        )}
        {tab === 'leaderboard' && (
          <LeaderboardView
            stats={leaderboard}
            rows={allRows}
            onOpenDomain={setSelectedDomain}
          />
        )}
      </div>

      <footer className="mt-2 text-[9px] text-slate-400">
        v0.2.3 · Header + paren-aware splitter
      </footer>

      <CaptureDetailModal
        row={selectedRow}
        onClose={() => setSelectedRow(null)}
      />
      <DomainDetailModal
        domain={selectedDomain}
        rows={allRows}
        onClose={() => setSelectedDomain(null)}
        onOpenCapture={(row) => {
          setSelectedDomain(null);
          setSelectedRow(row);
        }}
      />
      <BrandDetailModal
        brand={selectedBrand}
        rows={allRows}
        onClose={() => setSelectedBrand(null)}
        onOpenCapture={(row) => {
          setSelectedBrand(null);
          setSelectedRow(row);
        }}
      />
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-white text-slate-900 shadow-sm'
          : 'text-slate-600 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}
