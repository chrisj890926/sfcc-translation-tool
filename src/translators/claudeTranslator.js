'use strict';

const { TranslationProvider } = require('./baseTranslator');
const logger = require('../utils/logger');

/**
 * ClaudeTranslator — translates values via the Anthropic Claude API using the
 * official @anthropic-ai/sdk. Opt in with TRANSLATION_PROVIDER=claude (and set
 * ANTHROPIC_API_KEY). The SDK is loaded lazily so the app still runs with the
 * Google provider even when @anthropic-ai/sdk is not installed.
 *
 * Batching (Phase 3):
 * The base translator calls _translateRawBatch once per (text, locale) as the
 * SFCC translators walk each field. Those calls arrive concurrently — the same
 * source text for several target locales at once. This provider coalesces them
 * into a short time window and issues a single request per window that carries
 * MULTIPLE texts, each with its set of target locales, and gets back structured
 * JSON keyed by id -> locale -> translation. This collapses ~N calls (N = target
 * languages) into one and packs many texts per request.
 */
class ClaudeTranslator extends TranslationProvider {
  constructor(options = {}) {
    super(options);
    this.model = options.model || process.env.CLAUDE_MODEL || 'claude-opus-4-8';
    // Coalescing knobs (overridable for tests).
    this.flushMs = options.flushMs != null ? options.flushMs : 20;
    this.maxBatchTexts = options.maxBatchTexts || 40; // max distinct texts per request
    this.maxBatchChars = options.maxBatchChars || 8000; // source-char budget per request
    this._client = null;
    this._queue = []; // { text, locale, done(translated) }
    this._timer = null;
  }

  _getClient() {
    if (this._client) return this._client;
    let Anthropic;
    try {
      // eslint-disable-next-line global-require
      Anthropic = require('@anthropic-ai/sdk');
    } catch (error) {
      throw new Error(
        'Claude provider requires the "@anthropic-ai/sdk" package. Run `npm install @anthropic-ai/sdk`.'
      );
    }
    // Reads ANTHROPIC_API_KEY from the environment.
    this._client = new Anthropic();
    return this._client;
  }

  /**
   * Called by the base translator with already protected items for ONE locale.
   * Instead of issuing an API request here, we enqueue each item and let the
   * coalescing flush batch it with other concurrent requests.
   */
  async _translateRawBatch(items, targetLocale) {
    const result = {};
    await Promise.all(
      items.map(
        (item) =>
          new Promise((resolve) => {
            if (typeof item.text !== 'string' || item.text.trim() === '') {
              result[item.id] = item.text;
              return resolve();
            }
            this._queue.push({
              text: item.text,
              locale: targetLocale,
              done: (translated) => {
                result[item.id] = translated;
                resolve();
              }
            });
            this._scheduleFlush();
          })
      )
    );
    return result;
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush().catch((error) => logger.warn(`[Claude] flush error: ${error.message}`));
    }, this.flushMs);
  }

  async _flush() {
    if (this._queue.length === 0) return;
    const batch = this._queue.splice(0, this._queue.length);

    // Group entries by source text -> { id, text, locales, entries }.
    const byText = new Map();
    for (const entry of batch) {
      let group = byText.get(entry.text);
      if (!group) {
        group = { id: `t${byText.size}`, text: entry.text, locales: new Set(), entries: [] };
        byText.set(entry.text, group);
      }
      group.locales.add(entry.locale);
      group.entries.push(entry);
    }
    const groups = [...byText.values()];

    // Chunk groups to bound request/response size.
    const chunks = [];
    let current = [];
    let currentChars = 0;
    for (const group of groups) {
      const groupChars = group.text.length * group.locales.size;
      if (current.length > 0 && (current.length >= this.maxBatchTexts || currentChars + groupChars > this.maxBatchChars)) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(group);
      currentChars += groupChars;
    }
    if (current.length > 0) chunks.push(current);

    await Promise.all(
      chunks.map(async (chunk) => {
        let map = {};
        try {
          map = await this._requestBatch(chunk);
        } catch (error) {
          logger.warn(`[Claude Translation Failed] ${error.message}`);
          map = {};
        }
        for (const group of chunk) {
          const perLocale = (map && map[group.id]) || {};
          for (const entry of group.entries) {
            const translated = perLocale[entry.locale];
            // On any miss, keep the original (protected) text — never break content.
            entry.done(translated != null ? translated : entry.text);
          }
        }
      })
    );
  }

  /**
   * One API request for a chunk of groups.
   * @param {Array<{id,text,locales:Set}>} chunk
   * @returns {Promise<Object>} { [id]: { [locale]: translation } }
   */
  async _requestBatch(chunk) {
    const client = this._getClient();
    const payload = chunk.map((group) => ({
      id: group.id,
      text: group.text,
      locales: [...group.locales]
    }));

    const system = SYSTEM_PROMPT;
    const user = [
      'Translate each item\'s "text" into every locale listed in its "locales".',
      'Return ONLY a JSON object of the exact shape:',
      '{"<id>": {"<locale>": "<translation>", ...}, ...}',
      'One entry per id, one key per requested locale. No prose, no markdown, no code fences.',
      '',
      'ITEMS:',
      JSON.stringify(payload)
    ].join('\n');

    // Budget output tokens by total source size across locales (chunk is bounded).
    const srcChars = chunk.reduce((sum, g) => sum + g.text.length * g.locales.size, 0);
    const maxTokens = Math.min(16000, Math.max(1024, Math.ceil(srcChars * 2)));

    const resp = await client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    });
    // Report token usage to an attached job (if any). Purely observational —
    // does not affect the request or the translation output.
    if (this.reporter && resp && resp.usage) {
      const u = resp.usage;
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this.reporter.addUsage(inTok, u.output_tokens || 0);
    }
    const text = (resp.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return this._parseJson(text) || {};
  }

  _parseJson(str) {
    try {
      return JSON.parse(str);
    } catch (error) {
      const match = str.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (innerError) {
          return null;
        }
      }
      return null;
    }
  }
}

const SYSTEM_PROMPT = [
  'You are the official Cooler Master localization engine. You translate e-commerce',
  'content (Salesforce Commerce Cloud product and Page Designer data) into the',
  'requested locales with the accuracy and brand voice of a professional in-house',
  'localization team.',
  '',
  'Absolute rules — follow every one:',
  '- Output ONLY a JSON object. No explanation, no markdown, no code fences, no trailing text.',
  '- Preserve every placeholder token EXACTLY as-is (e.g. __TERM_0__, __TERM_1__). Never translate,',
  '  reorder, renumber, split, merge or add spaces inside placeholders.',
  '- Preserve all HTML tags and attributes exactly (e.g. <p>, <br>, <strong>, <a href="...">).',
  '  Translate only the human-readable text between tags.',
  '- Preserve HTML entities exactly (e.g. &lt; &gt; &amp; &quot;).',
  '- Preserve any CDATA content structure; translate only the readable text inside it.',
  '- Never modify URLs, file paths, email addresses, product model names, SKUs, product ids,',
  '  or technical abbreviations/standards (e.g. ATX, PCIe, SATA, PSU, 80 PLUS, RTX, MTBF).',
  '- Keep numbers, units and measurements unchanged (e.g. 120mm, 12 V DC, 0.3 A, 250-1370 rpm).',
  '- Translate only genuine natural-language text. If a value has nothing to translate, return it unchanged.',
  '- Produce fluent, native, brand-appropriate translations — not literal word-for-word output.',
  '',
  'Domain glossary — Cooler Master makes PC hardware (cases, coolers, power supplies,',
  'peripherals). Several English terms are ambiguous out of context; ALWAYS use the',
  'PC-hardware meaning, never the generic/retail meaning:',
  '- "Clearance" (incl. labels like "Clearance - PSU", "Clearance - CPU Cooler",',
  '  "Clearance - GFX/GPU/Graphics Card"): the maximum internal space / size limit a case',
  '  allows for that component — e.g. max PSU length, max CPU-cooler height, max graphics-card',
  '  length. It is a compatibility/spec dimension. It is NEVER a price reduction, "clearance',
  '  sale", stock clear-out, 出清, 清倉, or 特價.',
  '- "Graphic(s) Card Support" / "GPU Support": the graphics card that is supported / compatible',
  '  (or bundled). Translate as "supported/compatible graphics card", NOT as a physical GPU',
  '  support bracket / anti-sag holder / 顯卡支架 — unless the surrounding text is clearly about a',
  '  bracket accessory.',
  '- When a term is a known PC-hardware spec, prefer the established hardware term in the target',
  '  language (case, radiator, heatsink, fan, cooler, form factor, clearance, bracket).'
].join('\n');

module.exports = { ClaudeTranslator };
