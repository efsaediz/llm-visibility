/**
 * Brand/entity list persistence.
 *
 * Kept in `chrome.storage.sync` rather than Dexie so it auto-syncs across
 * the user's signed-in browser profiles and survives extension reinstalls.
 * The payload is a flat array of Brand objects (~100 bytes each) — well
 * inside the 100KB sync quota even with hundreds of entries.
 */

export interface Brand {
  /** Stable slug derived from the canonical name (e.g. "anthropic"). */
  id: string;
  /** Display name (e.g. "Anthropic"). */
  name: string;
  /**
   * Alternate spellings and close variants the matcher should treat as
   * the same entity — e.g. ["Claude", "Claude AI", "anthropic.com"].
   */
  aliases: string[];
  /** ISO timestamp of creation. */
  createdAt: string;
}

const KEY = 'llmv_brands';

// Unicode combining-diacritic range. Kept as a named constant so editors
// never get a chance to silently mangle the characters inside a regex
// literal (which has happened before in this codebase).
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

export async function getBrands(): Promise<Brand[]> {
  const { [KEY]: brands } = await chrome.storage.sync.get(KEY);
  return Array.isArray(brands) ? (brands as Brand[]) : [];
}

export async function saveBrand(brand: Brand): Promise<void> {
  const brands = await getBrands();
  const idx = brands.findIndex((b) => b.id === brand.id);
  if (idx >= 0) brands[idx] = brand;
  else brands.push(brand);
  await chrome.storage.sync.set({ [KEY]: brands });
}

export async function deleteBrand(id: string): Promise<void> {
  const brands = await getBrands();
  await chrome.storage.sync.set({
    [KEY]: brands.filter((b) => b.id !== id),
  });
}

/** Slugify a freeform brand name into a stable id. */
export function brandIdFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/** Subscribe to brand list changes from any context (popup/options/bg). */
export function onBrandsChanged(cb: (brands: Brand[]) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync' || !(KEY in changes)) return;
    const next = changes[KEY].newValue;
    cb(Array.isArray(next) ? (next as Brand[]) : []);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
