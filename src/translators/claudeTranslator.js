'use strict';

const { TranslationProvider } = require('./baseTranslator');
const logger = require('../utils/logger');

/**
 * ClaudeTranslator — translates values via the Anthropic Claude API using the
 * official @anthropic-ai/sdk. Not the default provider; opt in with
 * TRANSLATION_PROVIDER=claude (and set ANTHROPIC_API_KEY).
 *
 * The SDK is loaded lazily so the app still runs with the Google provider even
 * when @anthropic-ai/sdk is not installed.
 *
 * NOTE (phase 1): this provider is scaffolded and wired but not yet exercised
 * end-to-end. Phase 2 hardens the prompt, batching and validation.
 */
class ClaudeTranslator extends TranslationProvider {
  constructor(options = {}) {
    super(options);
    this.model = options.model || process.env.CLAUDE_MODEL || 'claude-opus-4-8';
    this._client = null;
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

  async _translateRawBatch(items, targetLocale) {
    const client = this._getClient();
    const payload = items.map((item) => ({
      id: item.id,
      text: item.text,
      context: item.context || ''
    }));

    const system = [
      `You are a professional localization engine translating Salesforce Commerce Cloud e-commerce content into ${targetLocale}.`,
      'Rules:',
      '- Return ONLY a JSON object mapping each item id to its translated string. No explanation, no markdown, no code fences.',
      '- Preserve every placeholder token exactly as-is (e.g. __TERM_0__). Never translate, reorder, split or alter placeholders.',
      '- Preserve all HTML tags and HTML entities exactly.',
      '- Do NOT translate product model names, technical abbreviations, SKUs, product ids or URLs.',
      '- Translate only natural-language text.'
    ].join('\n');

    const user = [
      `Translate the "text" of each item into ${targetLocale}.`,
      'Return a JSON object of the form {"<id>":"<translation>"} with one entry per item.',
      '',
      JSON.stringify(payload)
    ].join('\n');

    let responseText = '';
    try {
      const resp = await client.messages.create({
        model: this.model,
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: user }]
      });
      responseText = (resp.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    } catch (error) {
      logger.warn(`[Claude Translation Failed] targetLang=${targetLocale}: ${error.message}`);
      return {};
    }

    const parsed = this._parseJson(responseText);
    const out = {};
    for (const item of items) {
      out[item.id] = parsed && parsed[item.id] != null ? parsed[item.id] : item.text;
    }
    return out;
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

module.exports = { ClaudeTranslator };
