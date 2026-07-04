# SFCC XML Translator

A web UI + Node.js service that translates **Salesforce Commerce Cloud (SFCC)** XML
into multiple languages. It never asks an LLM to rewrite the whole file — it
**parses the XML, extracts only the values that need translating, translates those
values, and writes them back**, preserving the original XML structure, namespaces,
CDATA, JSON and HTML entities.

Two independent translators:

| Mode | Handles | Root element |
|------|---------|--------------|
| **Product XML** | SFCC Catalog products | `<catalog>` |
| **Page Designer XML** | SFCC Library / Page Designer content | `<library>` |

Default target languages: `ja-JP`, `ko-KR`, `de-DE`, `fr-FR`.

---

## Architecture

```
src/
  index.js                 # orchestration: provider factory + mode routing + merge
  server.js                # HTTP server (static UI + POST /api/translate)
  translators/
    baseTranslator.js      # TranslationProvider interface (cache, protection, HTML-aware)
    googleTranslator.js    # default provider (free Google endpoint, no key)
    claudeTranslator.js    # Anthropic Claude provider (opt-in)
    protectedTerms.js      # do-not-translate terms + placeholder masking
  sfcc/
    productXmlTranslator.js
    pageDesignerXmlTranslator.js
    xmlTypeDetector.js     # <catalog> -> product, <library> -> page-designer
    rules/
      productRules.js
      pageDesignerRules.js
  utils/
    xmlUtils.js            # entities, indent, attrs, merge
    jsonUtils.js           # deepClone, safe parse
    logger.js
public/                    # UI (index.html, app.js, style.css)
```

**Flow:** browser reads files → `POST /api/translate` `{ xmlContents, mode, targetLanguages, protectedTerms, provider }` → server picks a translator by `mode` → the translator extracts values and calls the provider (`translateText` / `translateHtmlContent`) → values written back → multiple files merged into one.

---

## Run locally

```bash
npm install        # optional: pulls @anthropic-ai/sdk for the Claude provider
npm start          # -> http://localhost:3000
```

The default **Google** provider needs no dependencies or keys, so `node src/server.js`
works even without `npm install`.

Environment variables:

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `3000` |
| `TRANSLATION_PROVIDER` | `google` or `claude` | `google` |
| `PROTECTED_TERMS` | extra comma-separated do-not-translate terms | — |
| `ANTHROPIC_API_KEY` | required when `TRANSLATION_PROVIDER=claude` | — |
| `CLAUDE_MODEL` | Claude model id | `claude-opus-4-8` |
| `LOG_LEVEL` | `error`/`warn`/`info`/`debug` | `info` |

### Using the Claude provider

```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
export TRANSLATION_PROVIDER=claude
npm start
```

The Claude prompt requires JSON-only output and instructs the model to preserve
placeholders, HTML tags, product models, technical abbreviations and URLs.

---

## Choosing a mode (UI)

Step 1 of the form is **Select Translation Mode**:

- **Product XML** → `<catalog>` product files
- **Page Designer XML** → `<library>` content files

The frontend sends `mode: "product" | "page-designer"` to the backend, which routes
to the matching translator. If `mode` is omitted, the server auto-detects from the
root element.

---

## Multi-file upload — limitations

Multiple files can be uploaded in one batch, but note the current behavior and its
constraints:

- **Same XML type only.** The mode selector applies to the whole batch. Do **not**
  mix Product XML and Page Designer XML in a single upload — the wrong-type files
  will fail or produce incorrect output.
- **Same `catalog-id` / `library-id`.** Files should belong to the same catalog
  (Product) or library (Page Designer). On merge, the XML declaration and the
  `<catalog>` / `<library>` wrapper are taken from the **first** file, so mixing
  different catalogs/libraries mis-attributes the merged content.
- **Output is a single merged XML file.** All `<product>` (Product) or `<content>`
  (Page Designer) blocks from every file are combined into one document
  (`merged-translated.xml` / `merged-xdefault-cloned.xml`). Per-file output is not
  produced; duplicate `content-id` / `product-id` across files are not de-duplicated.
- **Large batches may hit timeouts or translation rate limits.** The batch is
  processed within a single request and translation uses the free Google endpoint
  (capped concurrency). Many or large files can exceed request/proxy timeouts or
  trigger rate limiting (more likely on shared hosting such as Railway). On any
  translation failure the original text is kept.

For independent per-file results, or to mix types, upload files one batch at a time.

---

## Product XML — supported fields

Source language priority: `x-default`, then `default` / `en-US`.

| Field | Notes |
|-------|-------|
| `short-description` | may contain HTML — tags preserved |
| `page-title` | inside `<page-attributes>` |
| `page-description` | inside `<page-attributes>` |
| `custom-attribute attribute-id="subtitle"` | emitted as CDATA *(phase 2)* |

Rules: existing target-language values are **not overwritten**; empty source values
are skipped; language codes are hyphenated (`ja-JP`, `ko-KR`, `de-DE`, `fr-FR`).

---

## Page Designer XML — supported fields

Source: the `x-default` `<data>` JSON of each `<content>` block. Translatable JSON keys:

`title`, `title_xl`, `title_l`, `title_m`, `title_s`, `displayName`, `headline`,
`description`, `subtitle`, `pretitle`, `label`, `cta`, `buttonText`,
`primaryButtonTitle`, `secondaryButtonTitle`, `html_content`, `richText`, `bodyMarkup`.

Never translated: JSON keys, URLs, product ids, `content-id`, `folder-id`,
`attribute-id`, `model`, `sku`, `fileUrl`, and spec/numeric values.

Special components:

- **cmRepeater** (`component.commerce_assets.cmRepeater`) — translates each
  `specs.value` item's `displayName`; leaves `value` (models/specs/URLs) untouched.
- **cmDownloadFiles** (`component.commerce_assets.cmDownloadFiles`) — auto-adds a
  localized `title` and translates `files_to_download` `displayName`s *(phase 2)*.

Rules: `x-default` is the source; existing per-language `<data>` is not overwritten;
empty source values are skipped; JSON structure and HTML entities are preserved.

---

## Protected Terms

Terms that must never be translated are masked with placeholders
(`OVP` → `__TERM_1__`) before translation and restored afterward. Built-in list
includes: `PFC`, `MTBF`, `ErP 2014 Lot 3`, `OVP`, `OPP`, `SCP`, `UVP`, `OTP`, `OCP`,
`80 PLUS` / `80 PLUS Gold` / `80 PLUS Platinum`, `ATX`, `PCIe`, `PCI-E`, `SATA`,
`EPS`, `FDB`, `STCM`, `PSU`, `RTX`, `12V-2x6`, `12VHPWR`, `Cooler Master`, and
example product models (`V550 Gold`, `Elite 334U`, `Devastator 3 Plus`).

Emails and URLs are auto-protected too. Add more via the UI field or `PROTECTED_TERMS`.

---

## Deploy to Railway

No Railway config file is needed — Railway auto-detects the Node app:

1. Push this repo to your GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → select the repo.
3. Railway runs `npm install` then `npm start` (`node src/server.js`) and injects
   `PORT`, which `src/server.js` reads.
4. (Optional) Set `TRANSLATION_PROVIDER`, `ANTHROPIC_API_KEY`, `PROTECTED_TERMS`
   under **Variables**.

---

## Validation

After translating, each generated `<data>` JSON is re-parsed; a block that fails to
re-serialize is skipped with a `console.warn` rather than corrupting output. On any
translation failure the **original text is kept** — the source is never broken.
Phase 2 adds full XML re-parse validation and `files_to_download.value` JSON checks.
