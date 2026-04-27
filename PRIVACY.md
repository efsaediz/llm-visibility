# Privacy Policy

_Last updated: 2026-04-27_

LLM Visibility is a Chrome extension that helps users analyze their own
conversations with AI chat services. This document explains exactly what data
it touches and where that data lives.

## TL;DR

- **No telemetry, no analytics, no tracking, no servers.**
- Everything happens locally in your browser.
- Uninstalling the extension removes all stored data.

## What the extension reads

When you use chatgpt.com, the extension passively observes the **streaming
response** that the page itself receives. From that stream it extracts:

- Your prompt text
- The AI's reply text
- The fan-out search queries the model issued
- The citation URLs, titles, and snippets the model surfaced
- Internal "safe URL" lists (sources the model considered)

It does **not** observe traffic on any other website. The host permission is
limited to `https://chatgpt.com/*`.

## What the extension stores

Two storage areas are used:

1. **IndexedDB (Dexie database, key `llm-visibility`)** — stores every
   capture. Lives **only on your local machine**. Not synced. Not transmitted.

2. **`chrome.storage.sync`** — stores your brand list (the names you want
   tracked). If you have Google Chrome sync enabled, this list is synced
   between your own browsers via Google's sync infrastructure, the same way
   bookmarks and passwords are. The extension itself never sends this data
   anywhere; the sync is between your browsers, not to a third-party server.

## What the extension does NOT do

- ❌ Send any captured data to a server
- ❌ Use analytics, telemetry, error reporting, or crash reporting
- ❌ Use cookies or third-party scripts
- ❌ Read traffic on any site other than chatgpt.com
- ❌ Access your AI account credentials, password, or login session token
  (it observes the response stream only — the same data your browser is
  already showing on the page)
- ❌ Run when you are not on chatgpt.com

## Batch mode

The "Batch" feature drives prompt input on chatgpt.com programmatically — it
types your prompts into the page's input box and clicks submit, the same way
you would manually. The captured responses follow the same local-only rules
as manually-entered prompts.

## Deleting your data

- **Delete a single capture** — open it from History, click the red **Sil**
  button in the modal header
- **Delete every capture** — open the extension's Options page, scroll to
  *Veri yönetimi*, click *Tüm capture'ları sil*
- **Delete everything including the extension** — uninstall via
  `chrome://extensions`. All IndexedDB data tied to the extension is removed
  by Chrome automatically.

## Third-party sources

LLM Visibility is open source. You can audit every line of code at
[the project repository](https://github.com/) (link added once published).
The extension contains no minified third-party SDKs that "phone home". The
only runtime dependencies are React, Dexie (IndexedDB wrapper), Zod (runtime
type validation), and dexie-react-hooks — all standard, all open source.

## Contact

For privacy questions or to report a concern, please open an issue on the
project's GitHub repository.

## Changes

This policy may be updated as the extension gains new capabilities. Material
changes (e.g. introducing optional cloud sync) will be announced in the
extension's release notes and at the top of this file.
