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

Beyond translation, the tool can:

- **Reduce a full export** to just the products you ask for, before translating —
  so a multi-MB catalog / library becomes a few KB (and a few cents instead of tens
  of dollars).
- **Run translation as a background job** with live progress (phase, per-item
  counts, token usage, estimated cost, ETA).
- **Validate the result before import** with a local, zero-token diff tool that
  reports **SAFE / NOT SAFE / BASELINE MISMATCH**.

---

## Architecture

```
src/
  index.js                 # orchestration: provider factory + mode routing + merge
  server.js                # HTTP server (static UI + job API)
  jobs/
    jobStore.js            # in-memory jobs: phase, counts, tokens, cost, progress
    runner.js              # job pipeline: read -> reduce -> scan -> translate -> validate
  translators/
    baseTranslator.js      # TranslationProvider interface (cache, protection, HTML-aware)
    googleTranslator.js    # default provider (free Google endpoint, no key)
    claudeTranslator.js    # Anthropic Claude provider (opt-in; reports token usage)
    protectedTerms.js      # do-not-translate terms + placeholder masking
  sfcc/
    productXmlTranslator.js
    pageDesignerXmlTranslator.js
    catalogExtractor.js    # reduce a <catalog> to requested products
    pageExtractor.js       # reduce a <library> to requested product subtrees
    xmlTypeDetector.js     # <catalog> -> product, <library> -> page-designer
    rules/
      productRules.js
      pageDesignerRules.js
  utils/
    xmlUtils.js            # entities, indent, attrs, merge, escapeRegExp
    jsonUtils.js           # deepClone, safe parse
    progress.js            # NULL_REPORTER (no-op; translators stay behavior-identical)
    logger.js
scripts/
  extract-page.js               # CLI: reduce a library for one product + cost report
  validate-product-diff.js      # CLI: pre-import diff check for Product catalogs
  validate-pagedesigner-diff.js # CLI: pre-import diff check for Page Designer libraries
public/                    # UI (index.html, app.js, style.css)
start.sh                   # one-command launcher (Claude provider, reads .anthropic-key)
```

**Flow:** browser reads files → `POST /api/translate` `{ xmlContents, mode,
targetLanguages, protectedTerms, provider, productIds }` → server creates a
**background job** and returns `{ jobId }` → the runner optionally **reduces** the
export to the requested products, then translates only that → the browser polls
`GET /api/jobs/:jobId` for progress and downloads the result from
`GET /api/jobs/:jobId/result`.

---

## Run locally

```bash
npm install        # optional: pulls @anthropic-ai/sdk for the Claude provider
npm start          # -> http://localhost:3000  (Google provider by default)
```

Or use the launcher (Claude provider, reads the key from `.anthropic-key`, port 3100):

```bash
./start.sh                 # -> http://localhost:3100
PORT=4000 ./start.sh       # override the port
```

The default **Google** provider needs no dependencies or keys, so `node src/server.js`
works even without `npm install`.

Environment variables:

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `3000` (`start.sh` uses `3100`) |
| `TRANSLATION_PROVIDER` | `google` or `claude` | `google` (`start.sh` uses `claude`) |
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

## Reducing a full export (Product IDs)

You can upload a **whole** catalog / library and let the server extract only the
products you want, before translating. In the UI, fill **Product IDs** (comma or
whitespace separated), e.g.:

```
elite130, gx-iii-gold-850, masterliquid-pro-120-non-sleeve
```

- **Product XML** — keeps only the requested `<product>` blocks (plus the variant
  products of any requested master). The `<catalog>` header, namespaces, categories,
  category-assignments and every kept product's full structure are preserved verbatim.
- **Page Designer XML** — keeps each requested `page.productDetail` block and every
  `<content>` it references recursively via `<content-link>` (specs, downloads,
  banners, tiles, rich text, popups, …). The `<library>` wrapper is preserved.

**Leave Product IDs blank to translate the uploaded file as-is** (the whole export).
Extraction runs locally and costs **no tokens** — only the reduced result is sent to
the translator.

CLI equivalent (Page Designer, with a size + cost report):

```bash
node scripts/extract-page.js original.library.xml elite130
# -> original.library.reduced.xml
```

---

## Background jobs & progress

`POST /api/translate` returns immediately with `{ jobId }`; translation runs in the
background. Poll for status:

```
GET /api/jobs/:jobId          -> live status JSON
GET /api/jobs/:jobId/result   -> merged translated XML (once completed)
```

Status fields: `status`, `progress`, `currentPhase`, `currentComponent`,
`currentLocale`, `translatedCount`, `skippedCount`, `failedCount`, `inputTokens`,
`outputTokens`, `estimatedCost`, `elapsedSeconds`, `provider`, `model`, and
`extraction` (when a library/catalog was reduced).

Phases:
`Reading XML → Reducing Library/Catalog → Scanning Components/Products →
Preparing Translation → Translating → Writing XML → Validating XML → Completed`.

The UI mirrors these phases with a progress bar and stat tiles. Progress
instrumentation is **observation-only** — it never changes translation output.

---

## Choosing a mode (UI)

Step 1 of the form is **Select Translation Mode**:

- **Product XML** → `<catalog>` product files
- **Page Designer XML** → `<library>` content files

The frontend sends `mode: "product" | "page-designer"` to the backend, which routes
to the matching translator. If `mode` is omitted, the server auto-detects from the
root element.

---

## Product XML — supported fields

Source language: `x-default`.

| Field | Notes |
|-------|-------|
| `short-description` | may contain HTML — tags preserved |
| `page-title` | inside `<page-attributes>` |
| `page-description` | inside `<page-attributes>` |
| `custom-attribute attribute-id="subtitle"` | emitted as CDATA |

Rules: the full `<product>` block is preserved (images, custom-attributes,
store-attributes, flags, variations, category assignments) and only the four fields
above are edited. A **missing** target locale is created; a target locale that holds
an **English fallback** (empty, identical to `x-default`, or not actually localized)
is overwritten with a translation; a **genuine** existing localization is left
untouched. Empty source values are skipped. Language codes are hyphenated
(`ja-JP`, `ko-KR`, `de-DE`, `fr-FR`).

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
  localized `title` and translates `files_to_download` `displayName`s (URLs untouched).

Rules: `x-default` is the source. The **entire `<content>` block is preserved** —
`<type>`, `<config>`, `<content-links>`, `<folder-links>`,
`<content-object-assignments>`, `<display-name>` and any non-target `<data>` — and
only the target-locale `<data>` is regenerated from `x-default`. JSON structure and
HTML entities are preserved.

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

## Pre-import validation

Before a Catalog / Library **MERGE** import, compare the original full export against
the translated file. Both tools are **local-only, zero-token, read-only** and exit
`0` (SAFE), `1` (NOT SAFE) or `3` (BASELINE MISMATCH).

```bash
# Product catalog
node scripts/validate-product-diff.js original.catalog.xml translated.xml \
  --product-ids id1,id2 --locales de-DE,fr-FR,ja-JP,ko-KR

# Page Designer library
node scripts/validate-pagedesigner-diff.js original.library.xml translated.xml \
  --product-ids id1,id2 --locales de-DE,fr-FR,ja-JP,ko-KR
```

They verify: only the requested products are present, only the target locales of the
allowed fields changed, `x-default` and non-target locales are untouched, product /
content structure (images, custom-attrs, variations, content-links, …) is unchanged,
URLs and spec values are preserved, and there are no duplicate locale tags.

Three outcomes:

- **SAFE TO IMPORT** — only intended changes.
- **NOT SAFE TO IMPORT** — a real violation (e.g. changed URL, dropped content-links,
  a non-target locale was modified).
- **BASELINE MISMATCH** — the original export provided is **not** the same one the
  translated file was derived from (e.g. `x-default` differs before translation, or
  translated content-ids don't exist in the original), so the diff can't be trusted.
  Re-run with the exact export used for extraction/translation.

---

## Multi-file upload — limitations

Multiple files can be uploaded in one batch, but note the current behavior and its
constraints:

- **Same XML type only.** The mode selector applies to the whole batch. Do **not**
  mix Product XML and Page Designer XML in a single upload.
- **Same `catalog-id` / `library-id`.** On merge, the XML declaration and the
  `<catalog>` / `<library>` wrapper are taken from the **first** file.
- **Output is a single merged XML file** (`merged-translated.xml` /
  `merged-xdefault-cloned.xml`). Duplicate `content-id` / `product-id` across files
  are not de-duplicated.
- **Large batches may hit timeouts or rate limits.** On any translation failure the
  original text is kept.

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

## Tests & runtime safety

```bash
npm test   # core translator rules + validator tests
```

Runtime safety: after translating, each generated `<data>` JSON is re-parsed and the
whole document is checked for well-formedness; a block that fails is skipped rather
than corrupting output, and on any translation failure the **original text is kept**
— the source is never broken.
