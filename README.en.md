# AI Page Translator (AI 页面翻译)

English | [中文](README.md)

> Translate entire web pages with AI — more natural than built-in machine translation.
> Powered by **DeepSeek**, requires your own DeepSeek API Key.

A browser extension (Manifest V3) for **Edge / Chrome**. Translations see full-page context so terminology stays consistent across paragraphs, and SPA dynamic content is translated in real time.

## Features

| Feature | Description |
|---|---|
| **Natural AI translation** | The whole page goes through an LLM for fluent, idiomatic output |
| **Full-page context** | Small pages translate in one pass; large pages analyze the translation "direction" first, keeping terms consistent across paragraphs |
| **Adaptive concurrency** | Large pages translate concurrently — measured **2–7× faster** |
| **Incremental translation** | New content from SPA navigation / dynamic loading / Shadow DOM / tab switches auto-translates |
| **Auto-retry on failure** | Transient API errors auto-retry; any remaining failures can be retried in one click |
| **Restore after restart** | Translated pages can be restored to the original text even after an extension update / reload |
| **Bilingual view** | Switch to a "bilingual" display mode — keeps the original text and shows the translation on a line below each paragraph, great for papers / language learning / checking the source. Default remains "replace" |
| **Entity / tooltip links preserved** | Links with tooltips or pointing to team / player / event pages are left untouched, so hover hints don't shift onto the wrong word |
| **Comment metadata untouched** | In comment sections only the sentence bodies are translated; author / time / date / flag / username labels stay in the original language |
| **Real-time progress** | Node-level progress bar in the banner + toolbar badge, cancellable anytime |
| **Usage statistics** | Tracks **today/month** real token usage, and computes **real cost** at the latest official price × peak/off-peak |
| **Multi-language** | 11 target languages supported |
| **Dark mode** | Banner / popup / options adapt to the system dark mode |
| **Per-site settings** | Set "always translate" / "never translate" per site, overriding the global setting |
| **Privacy-friendly** | API Key stays on your machine, only sent to the configured endpoint, no telemetry |

## Screenshots

| Translate offer | Translation done | Dark mode |
|---|---|---|
| ![Translate offer](screenshots/shot-offer.png) | ![Translation done](screenshots/shot-done-light.png) | ![Dark mode](screenshots/shot-done-dark.png) |

## Installation

**Option 1: Load the release package (recommended)**

1. Download `ai-page-translator-v1.7.3.zip` from [Releases](../../releases) and extract
2. Open `edge://extensions` (Chrome: `chrome://extensions`)
3. Turn on **"Developer mode"** (bottom-left in Edge)
4. Click **"Load unpacked"** and select the extracted `extension` folder
5. Click the extension icon → select this extension → choose **"Settings"** at the bottom of the panel → enter your DeepSeek API Key → **Test connection**

> You can turn **off** "Developer mode" after installation — the extension keeps working. Turn it back on only when you need to reload an updated version.

**Option 2: Clone for development**

```bash
git clone https://github.com/Bingl1ng/ai-page-translator
# No build step needed — the extension/ folder is directly loadable
```

## Configuration

- **API Key**: Get one at the [DeepSeek platform](https://platform.deepseek.com) (`sk-` prefix). Stored only in local `chrome.storage.local`.
- **Model**: Default `deepseek-v4-flash` (thinking mode auto-disabled — fast and stable). Can be changed to other DeepSeek models.
- **Target language**: Default Simplified Chinese; 11 languages supported.
- **Display mode**: `Replace` (default, translation replaces the page text) or `Bilingual` (keeps the original, translation below each paragraph).
- **Auto-translate**: Optionally auto-translate foreign pages (off by default).
- **Per-site settings**: e.g. "never translate" / "always translate" for a specific site.

## Privacy & Security

- **Key stays local**: stored only in the extension's local storage, sent only to the configured API endpoint (DeepSeek official by default). Open-source and unminified — you can audit the code.
- **Content**: translation sends page text to DeepSeek. **Do not use on pages containing sensitive or confidential content.**
- **No telemetry**: the extension uploads no usage data; the only outbound request is the translation API call.
- **Custom API endpoint**: defaults to DeepSeek official only. If you switch to another OpenAI-compatible endpoint, the extension requests access to that domain (browser confirmation prompt) — only use providers you trust.
- **Recommendation**: create a **dedicated API Key** for this extension (not your main account key) and set a spending limit — if it ever leaks, the damage is bounded and you can revoke it anytime.

## Cost

- Uses **your own DeepSeek API quota**, billed per token (DeepSeek is cheap, with **half-price off-peak hours** — peak is Mon–Fri 9:00–12:00 & 14:00–18:00; the rest of the time and weekends are discounted).
- Popup shows **today / this-month / this-page real cost (CNY)** computed from **latest official price × peak/off-peak**, separating input cache-hit / miss / output — a measured true value, not an estimate.
- Translating a full arXiv paper (~80k characters) costs a few cents (usually under ¥0.01 off-peak).

## Project Structure

```
extension/    The loadable extension itself (no build step)
  manifest.json
  content.js   Content script: collect / batch / incremental / banner
  background.js  Service Worker: DeepSeek API / usage stats / badge
  config.js    Shared config & utilities
  options.*    Settings page
  popup.*      Popup
  icons/       Icons
screenshots/   README screenshots
dist/          Release zip
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT License](LICENSE)

> Designed, decided, and accepted by the author; part of the code was developed with AI assistance.

## Disclaimer

This is an independent open-source project, **not an official DeepSeek product**. It uses DeepSeek's public API. Please comply with the [DeepSeek terms of service](https://platform.deepseek.com/terms) and the terms of the sites you translate. Translations are AI-generated — refer to the original text.
