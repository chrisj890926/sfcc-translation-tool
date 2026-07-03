'use strict';

const { protect, restore } = require('./protectedTerms');
const { decodeHtmlEntities } = require('../utils/xmlUtils');

/**
 * TranslationProvider — the common interface every translator implements.
 *
 * The core principle of this project: the translation API only ever sees the
 * *value* to translate, never the surrounding XML/JSON. Subclasses implement
 * `_translateRawBatch(items, targetLocale)` which receives already-protected
 * text and returns a map of { id: translatedText }. This base class handles
 * caching, protected-term masking/restoring, and HTML-aware translation.
 *
 * Subclasses must implement:
 *   async _translateRawBatch(items, targetLocale) -> { [id]: string }
 *     items: [{ id, text, context }]  (text is placeholder-protected)
 */
class TranslationProvider {
  constructor(options = {}) {
    this.protectedTerms = options.protectedTerms || [];
    this.cache = new Map(); // key: `${locale}::${sourceText}` -> translation
  }

  // eslint-disable-next-line no-unused-vars
  async _translateRawBatch(items, targetLocale) {
    throw new Error('TranslationProvider._translateRawBatch must be implemented by a subclass.');
  }

  /**
   * Translate a batch of items. Empty/whitespace text passes through unchanged.
   * items: [{ id, text, context? }]
   * returns: { [id]: translatedText }
   */
  async translateBatch(items, targetLocale) {
    const result = {};
    const pending = [];

    for (const item of items) {
      if (typeof item.text !== 'string' || item.text.trim() === '') {
        result[item.id] = item.text;
        continue;
      }
      const cacheKey = `${targetLocale}::${item.text}`;
      if (this.cache.has(cacheKey)) {
        result[item.id] = this.cache.get(cacheKey);
        continue;
      }
      pending.push(item);
    }

    if (pending.length > 0) {
      const protectedItems = pending.map((item) => {
        const { text, tokenMap } = protect(item.text, this.protectedTerms);
        return { id: item.id, text, context: item.context, _tokenMap: tokenMap, _orig: item.text };
      });

      let raw = {};
      try {
        raw = (await this._translateRawBatch(protectedItems, targetLocale)) || {};
      } catch (error) {
        // On failure, keep originals (do not break the source text).
        raw = {};
      }

      for (const pItem of protectedItems) {
        const translatedProtected = raw[pItem.id] != null ? raw[pItem.id] : pItem.text;
        const restored = restore(translatedProtected, pItem._tokenMap);
        const finalText = restored != null && restored !== '' ? restored : pItem._orig;
        this.cache.set(`${targetLocale}::${pItem._orig}`, finalText);
        result[pItem.id] = finalText;
      }
    }

    return result;
  }

  /** Convenience: translate a single string. */
  async translateText(text, targetLocale) {
    if (typeof text !== 'string' || text.trim() === '') {
      return text;
    }
    const map = await this.translateBatch([{ id: '_', text }], targetLocale);
    return map._ != null ? map._ : text;
  }

  /**
   * Translate HTML while preserving tags: only the text nodes between tags are
   * translated. Returns raw (decoded) HTML — the caller is responsible for any
   * XML entity encoding when writing back.
   */
  async translateHtmlContent(encodedHtml, targetLocale) {
    if (typeof encodedHtml !== 'string' || encodedHtml.trim() === '') {
      return encodedHtml;
    }
    const decoded = decodeHtmlEntities(encodedHtml);
    const chunks = decoded.split(/(<[^>]+>)/g);
    const out = [];
    for (const chunk of chunks) {
      if (chunk.startsWith('<') && chunk.endsWith('>')) {
        out.push(chunk);
        continue;
      }
      if (chunk.trim() === '') {
        out.push(chunk);
        continue;
      }
      out.push(await this.translateText(chunk, targetLocale));
    }
    return out.join('');
  }
}

module.exports = { TranslationProvider };
