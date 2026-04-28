# LLM Visibility

> **Capture conversations on AI chat interfaces, track which sources they cite,
> and tie every answer sentence back to the citation that produced it.**
> Local-only, free, MIT-licensed. Not affiliated with OpenAI or any other AI vendor.

LLM Visibility is a Chrome extension that turns AI chat sessions into structured
research data. It records every fan-out search query, every citation surfaced,
every "ghost" source the model touched but never cited, and uses that data to
answer questions that matter for SEO / GEO / brand-visibility research:

- Which domains does the model actually surface for my topic?
- Are my brand mentions cited as primary sources, or buried as supporting?
- For a given answer, which sentence came from which citation — and which were
  unsourced (potential hallucinations or model-prior content)?
- How does this change across prompts, over time, across competitors?

Currently supports **chatgpt.com**. Other LLM chat surfaces (Claude.ai,
Perplexity, Gemini) are on the roadmap but not yet implemented.

---

## Features

- **Passive capture** — every chat session you have is recorded automatically;
  no manual save, no copy-paste
- **Fan-out query extraction** — see the actual search terms the model used
  behind the scenes, not just your prompt
- **Citation pool** — primary citations (cited in answer) and supporting
  citations are extracted distinctly
- **Ghost detection** — domains the model touched (saw, considered, included
  in retrieval) but never cited get flagged as ghosts; high ghost ratio is a
  visibility-loss signal
- **Three-pass source attribution**:
  1. **Inline citation parsing** — when the model itself emitted a citation
     marker for a span, we trust it (ground truth, score 1.0)
  2. **Quote substring match** — sentences with verbatim quotes get matched
     to the citation that contains the quote
  3. **Boosted TF-IDF** — lexical fallback with domain-name token boost so
     "Anthropic" in a sentence weights `anthropic.com` higher
- **Brand tracking** — define a brand list, every capture is auto-scanned;
  per-brand timeline drilldown shows which captures mentioned it and how
- **Domain leaderboard** — visibility rate, ghost share, last-seen, click into
  any domain to see the timeline of captures that surfaced it
- **History** — search across prompt / answer / domain / brand, group by chat
  to compare turns within one session, export filtered set as CSV
- **Batch runs** — paste a list of prompts, the extension drives ChatGPT
  through them sequentially in fresh chats, captures every result, tags the
  whole set with one label

---

## Install (current — pre-Web Store)

The extension is not on the Chrome Web Store yet. Install it from source:

1. Download or clone this repo
2. `npm install && npm run build`
3. Open `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**, pick the `dist/` folder

You should see a green **LV** icon in the Chrome toolbar. Pin it for easy
access.

> A pre-built `dist/` zip is attached to each tagged release on the
> [Releases page](https://github.com/efsaediz/llm-visibility/releases) —
> non-developers can use that without running `npm install`.

---

## Quick start

1. Click the **LV** icon to open the popup.
2. (Optional) Click ⚙ to open Options and add brand names you want tracked.
3. Open chatgpt.com and ask a question that triggers a search (anything
   topical / current).
4. After the answer finishes, open the popup. The **Latest** tab shows the
   capture: prompt, ghost ratio, fan-out queries, citations, sentence-level
   attribution.

If a capture says **💭 no-search**, ChatGPT answered from model weights with
no retrieval — there are no citations to attribute. That's a real signal,
not a bug.

---

## Batch runs

The **Batch** tab lets you queue a list of prompts and have the extension run
them sequentially against ChatGPT in fresh conversations. Useful for visibility
audits — paste 10–20 variations of a question and see how citations shift.

1. Switch to the **Batch** tab.
2. Paste prompts, one per line.
3. Optionally tag the run with a label (e.g. `q4-audit`).
4. Click **Başlat**.

The extension opens / focuses a chatgpt.com tab and walks through the prompts
with an 8-second cooldown between each (to avoid rate-limit triggers). Captures
land in History tagged with your label.

---

## Privacy

All capture data lives **locally** in the browser's IndexedDB. Brand list lives
in `chrome.storage.sync` (so it follows you across devices via Google sync,
if you have that enabled). Nothing is sent to any external server. See
[PRIVACY.md](./PRIVACY.md) for the full policy.

---

## Development

```bash
npm install
npm run dev    # Vite dev server with HMR
npm run build  # Production build into dist/
```

After `npm run build`, reload the extension in `chrome://extensions` for
your changes to take effect.

### Project layout

```
src/
├── capture/       SSE interception (inject.ts in MAIN world + content.ts bridge)
├── parse/         Zod schemas + extractor that turns raw SSE into structured data
├── attribution/   Three-pass sentence-to-source attribution engine
├── brands/        Brand list storage and per-capture matcher
├── analytics/     Domain leaderboard, brand rollup, per-entity timelines
├── batch/         Page-world prompt automation + background orchestrator
├── db/            Dexie schema and write-path facade
├── background/    Service worker
├── popup/         React UI (Latest, History, Batch, Brands, Domains tabs)
├── options/       Brand management page
└── shared/        Cross-world message contracts
```

### Contributing

Issues and PRs welcome. The codebase is intentionally small and well-commented;
see CLAUDE.md (if present) or the comments at the top of each file for design
notes.

---

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

LLM Visibility is an independent open-source project. It is not affiliated
with, endorsed by, or sponsored by OpenAI, Anthropic, Google, or any other
AI vendor. ChatGPT is a trademark of OpenAI; this extension only observes
content the user has access to in their own browser session.
