import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  brandIdFromName,
  deleteBrand,
  getBrands,
  onBrandsChanged,
  saveBrand,
  type Brand,
} from '../brands/storage';
import { clearAllCaptures, db } from '../db';

function parseAliases(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function App() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [name, setName] = useState('');
  const [aliasesRaw, setAliasesRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void getBrands().then(setBrands);
    return onBrandsChanged(setBrands);
  }, []);

  const sortedBrands = useMemo(
    () =>
      [...brands].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [brands],
  );

  function resetForm() {
    setName('');
    setAliasesRaw('');
    setEditingId(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError('Brand adı en az 2 karakter olmalı.');
      return;
    }
    const id = editingId ?? brandIdFromName(trimmedName);
    if (!id) {
      setError('Bu isimden stabil bir id üretilemedi. Latin harflerle dene.');
      return;
    }
    if (!editingId && brands.some((b) => b.id === id)) {
      setError(`"${trimmedName}" zaten listede var.`);
      return;
    }

    const existing = brands.find((b) => b.id === id);
    const brand: Brand = {
      id,
      name: trimmedName,
      aliases: parseAliases(aliasesRaw),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await saveBrand(brand);
    resetForm();
  }

  function startEdit(brand: Brand) {
    setEditingId(brand.id);
    setName(brand.name);
    setAliasesRaw(brand.aliases.join(', '));
    setError(null);
  }

  async function handleDelete(id: string) {
    if (!confirm('Bu brand silinsin mi? Eski capture kayıtları etkilenmez.')) return;
    await deleteBrand(id);
    if (editingId === id) resetForm();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500 text-white font-bold">
          LV
        </div>
        <div>
          <h1 className="text-xl font-semibold">LLM Visibility · Settings</h1>
          <p className="text-sm text-slate-600">
            Brand listesi. Her capture'da ChatGPT'nin yanıtı ve arka plandaki
            kaynakları bu isimler için taranır.
          </p>
        </div>
      </header>

      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
          {editingId ? 'Brand düzenle' : 'Yeni brand ekle'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Brand adı
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Anthropic"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Alias'lar{' '}
              <span className="font-normal text-slate-500">
                (virgül veya satır başı ile ayır)
              </span>
            </label>
            <textarea
              value={aliasesRaw}
              onChange={(e) => setAliasesRaw(e.target.value)}
              placeholder="Claude, Claude AI, anthropic.com"
              rows={3}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Büyük/küçük harf ve aksan farkları otomatik normalize edilir.
              "Nike", "nıke", "nike.com" hepsi aynı eşleşmeyi üretir.
            </p>
          </div>
          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
            >
              {editingId ? 'Güncelle' : 'Ekle'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
              >
                İptal
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Kayıtlı brand'ler ({brands.length})
          </h2>
        </div>
        {sortedBrands.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            Henüz brand yok. Yukarıdaki formla ilk brand'ini ekle.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {sortedBrands.map((brand) => (
              <li key={brand.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">
                      {brand.name}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {brand.id}
                    </span>
                  </div>
                  {brand.aliases.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {brand.aliases.map((a) => (
                        <span
                          key={a}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(brand)}
                    className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                  >
                    Düzenle
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(brand.id)}
                    className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                  >
                    Sil
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DataManagementSection />

      <footer className="mt-6 text-center text-[11px] text-slate-400">
        Brand listesi Chrome Sync üzerinden oturumun açık olduğu tüm
        tarayıcılara gider. Yerel capture verisi (IndexedDB) sync edilmez.
      </footer>
    </main>
  );
}

function DataManagementSection() {
  const captureCount = useLiveQuery(() => db.captures.count(), [], 0);
  const [busy, setBusy] = useState(false);

  async function handleClearAll() {
    const n = captureCount ?? 0;
    if (n === 0) return;
    const ok = confirm(
      `${n} capture silinsin mi? Bu işlem geri alınamaz. Brand listesi etkilenmez.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await clearAllCaptures();
    } finally {
      setBusy(false);
    }
  }

  const n = captureCount ?? 0;
  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
        Veri yönetimi
      </h2>
      <div className="flex items-start justify-between gap-4">
        <div className="text-sm text-slate-700">
          <div>
            <strong>{n}</strong> capture saklı.
          </div>
          <div className="mt-1 text-[12px] text-slate-500">
            Tüm yakalanmış sohbet kayıtlarını ve metriklerini sil. Brand
            listesini, Options ayarlarını veya extension'ı etkilemez.
          </div>
        </div>
        <button
          type="button"
          onClick={handleClearAll}
          disabled={busy || n === 0}
          className="shrink-0 rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Siliniyor…' : `Tüm capture'ları sil (${n})`}
        </button>
      </div>
    </section>
  );
}
