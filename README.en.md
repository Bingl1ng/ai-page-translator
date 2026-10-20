# AI Page Translator

A browser extension for Edge / Chrome (Manifest V3) that translates whole pages with DeepSeek. You need your own API key.

## What it does

Page text goes to the model in batches, so terms and tone stay consistent across paragraphs. Large pages translate concurrently; SPA navigation, dynamically loaded content and open Shadow DOM are followed automatically. You can restore the original text at any time.

Code blocks, inputs and iframes are left alone. In comments only the text is translated; author names and timestamps stay as they are. A bilingual mode keeps the original and puts the translation below each paragraph.

## Screenshots

| Before | After |
|---|---|
| ![Offer](screenshots/shot-offer.png) | ![Translated](screenshots/shot-done-light.png) |

| Dark mode | Bilingual |
|---|---|
| ![Dark](screenshots/shot-done-dark.png) | ![Bilingual](screenshots/shot-bilingual.png) |

| Popup | Settings |
|---|---|
| ![Popup](screenshots/shot-popup.png) | ![Settings](screenshots/shot-options.png) |

## Install

1. Download the latest zip from [Releases](../../releases) and unzip it.
2. Open `edge://extensions` (`chrome://extensions` in Chrome).
3. Turn on Developer mode, click "Load unpacked", and pick the unzipped folder (the one with `manifest.json`).
4. Click the extension icon → Settings and paste your DeepSeek API key.

You can turn Developer mode off afterwards. Turn it back on to load an updated version.

## Use

Open a foreign-language page. A bar appears at the top; click "Translate" and you can cancel at any time. When it finishes you can show the original, re-translate, or retry the parts that failed.

New content from in-site navigation is translated automatically. If you cancel or restore, the page stays put until you click Translate again.

## Settings

- **API key**: from the [DeepSeek platform](https://platform.deepseek.com); stored on this device.
- **Model**: `deepseek-v4-flash` by default.
- **Target language**: 11 options.
- **Display mode**: replace, or bilingual.
- **Sites**: auto-translate or never-translate per domain.

## Cost

Translation uses your own API quota and is billed per token. The popup shows this page, today and this month, using the official price and peak/off-peak rates.

## Privacy

The API key stays in local extension storage and is only sent to the API address you configure. Page text goes to that provider when you translate. There are no other network requests and no telemetry.

## Project layout

```
extension/   the loadable extension
screenshots/ README images
dist/        release zip
```

No build step.

## License

MIT. Part of the code was written with AI assistance.

Not an official DeepSeek product. Translations are generated; check the original for anything important.
