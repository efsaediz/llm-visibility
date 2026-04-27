/**
 * CSV export.
 *
 * Two formats:
 *   - Wide (`capturesToCsv`): one row per capture, nested arrays flattened
 *     to counts and summary strings. Fits Excel/Sheets drag-and-drop.
 *   - Long (`captureCitationsToCsv`): one row per citation, repeating
 *     capture metadata on each row. Pivot-friendly for domain analysis.
 *
 * RFC 4180 escaping throughout, CRLF line endings so Excel doesn't
 * collapse Windows-saved files onto one line.
 */

import type { CaptureRow } from '../db/schema';

const CRLF = '\r\n';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const headerLine = header.map(escapeCell).join(',');
  const body = rows.map((r) => r.map(escapeCell).join(',')).join(CRLF);
  return headerLine + CRLF + body + (rows.length > 0 ? CRLF : '');
}

function topPrimaryDomain(row: CaptureRow): string {
  const first = row.conversation.citations.find((c) => c.isPrimary);
  return first?.domain ?? '';
}

const WIDE_HEADER = [
  'id',
  'capturedAt',
  'url',
  'userPrompt',
  'fanOutCount',
  'primaryCount',
  'supportingCount',
  'uniqueDomainCount',
  'touchedSources',
  'ghostCount',
  'ghostRatio',
  'unsourcedRatio',
  'sentenceCount',
  'detectedBrandCount',
  'detectedBrands',
  'topPrimaryDomain',
  'answerTextLength',
  'rawEventCount',
];

export function capturesToCsv(rows: CaptureRow[]): string {
  const body = rows.map((r) => [
    r.id,
    r.capturedAt,
    r.url,
    r.conversation.userPrompt ?? '',
    r.metrics.fanOutCount,
    r.metrics.primaryCount,
    r.metrics.supportingCount,
    r.metrics.uniqueDomainCount,
    r.metrics.touchedSources,
    r.metrics.ghostCount,
    r.metrics.ghostRatio.toFixed(4),
    r.attribution.unsourcedRatio.toFixed(4),
    r.attribution.sentences.length,
    r.detectedBrands.length,
    r.detectedBrands.join(';'),
    topPrimaryDomain(r),
    (r.conversation.answerText ?? '').length,
    r.rawEventCount,
  ]);
  return toCsv(WIDE_HEADER, body);
}

const LONG_HEADER = [
  'captureId',
  'capturedAt',
  'userPrompt',
  'citationUrl',
  'citationDomain',
  'citationTitle',
  'isPrimary',
  'citationSnippet',
  'citationPosition',
];

export function captureCitationsToCsv(rows: CaptureRow[]): string {
  const body: unknown[][] = [];
  for (const r of rows) {
    for (const c of r.conversation.citations) {
      body.push([
        r.id,
        r.capturedAt,
        r.conversation.userPrompt ?? '',
        c.url,
        c.domain,
        c.title ?? '',
        c.isPrimary ? 'true' : 'false',
        c.snippet ?? '',
        c.position,
      ]);
    }
  }
  return toCsv(LONG_HEADER, body);
}

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCaptureCsv(
  rows: CaptureRow[],
  filename = `llmv-captures-${todayStamp()}.csv`,
): void {
  triggerDownload(capturesToCsv(rows), filename);
}

export function downloadCitationsCsv(
  rows: CaptureRow[],
  filename = `llmv-citations-${todayStamp()}.csv`,
): void {
  triggerDownload(captureCitationsToCsv(rows), filename);
}
