'use strict';

const {
  parseAttributes,
  buildAttrStr,
  encodeHtmlEntities,
  stripCData,
  wrapCData,
  isWellFormedXml
} = require('../utils/xmlUtils');
const logger = require('../utils/logger');
const { NULL_REPORTER } = require('../utils/progress');
const rules = require('./rules/productRules');

/**
 * Product XML (SFCC <catalog>) translator.
 *
 * For each <product> it finds the x-default value of each translatable tag,
 * translates it per target language, and either updates an existing
 * xml:lang="<lang>" tag or inserts a new one. All other markup
 * (custom-attributes, ids, etc.) is left exactly as-is.
 */

const TRANSLATABLE_TAGS = new Set(rules.translatableTags);
const HTML_TAGS = new Set(rules.htmlTags);
// Translatable <custom-attribute attribute-id="..."> configs, keyed by id.
const CUSTOM_ATTR_MAP = new Map((rules.customAttributes || []).map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// English-fallback detection.
//
// A real SFCC catalog export ships EVERY configured locale, but locales that
// were never translated in Business Manager are pre-filled with the English
// fallback text. The old rule ("skip any locale that already exists") therefore
// preserved that English forever. Instead we decide per locale whether the
// existing value is an untranslated fallback (overwrite it) or a genuine
// localization (leave it alone).
// ---------------------------------------------------------------------------

// Scripts whose presence proves a value is genuinely localized (non-Latin locales).
const SCRIPT_RANGES = {
  ja: /[぀-ヿ㐀-䶿一-鿿]/, // Hiragana, Katakana, CJK
  ko: /[가-힣ᄀ-ᇿ㄰-㆏]/, // Hangul
  zh: /[㐀-䶿一-鿿]/ // CJK
};

// Strong English function words — used to spot English text in a Latin-script slot.
const EN_WORDS = new Set([
  'the', 'and', 'for', 'with', 'is', 'are', 'of', 'to', 'this', 'that',
  'these', 'those', 'from', 'your', 'you', 'will', 'can', 'has', 'have',
  'our', 'we', 'its', 'an', 'a'
]);

// Per-locale signals (diacritics + common function words) that mark real localization.
const LOCALE_SIGNALS = {
  de: {
    re: /[äöüß]/i,
    words: new Set(['und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einer', 'für', 'mit', 'ist', 'sind', 'nicht', 'auch', 'bei', 'zur', 'zum', 'von', 'im', 'als', 'sich', 'wird', 'werden', 'kann', 'jahre', 'sicher', 'zuverlässig', 'wahl', 'netzteil'])
  },
  fr: {
    re: /[àâçéèêëîïôûùüÿœæ]/i,
    words: new Set(['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'pour', 'avec', 'est', 'sont', 'dans', 'sur', 'par', 'que', 'qui', 'ce', 'cette', 'aux', 'au', 'plus', 'fiable', 'choix', 'garantie'])
  },
  es: {
    re: /[áéíóúñü¿¡]/i,
    words: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'del', 'de', 'y', 'o', 'para', 'con', 'es', 'son', 'en', 'por', 'que', 'se', 'su', 'más', 'opción', 'fuente', 'confiable'])
  },
  it: {
    re: /[àèéìíîòóùú]/i,
    words: new Set(['il', 'lo', 'la', 'gli', 'le', 'un', 'uno', 'una', 'del', 'della', 'di', 'e', 'o', 'per', 'con', 'è', 'sono', 'in', 'che', 'si', 'più', 'scelta'])
  },
  nl: {
    re: /[ëïéèü]/i,
    words: new Set(['de', 'het', 'een', 'en', 'of', 'voor', 'met', 'is', 'van', 'op', 'die', 'dat', 'niet', 'ook', 'zijn', 'wordt', 'kan', 'keuze'])
  },
  pt: {
    re: /[ãõáâàéêíóôúç]/i,
    words: new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'do', 'da', 'de', 'e', 'ou', 'para', 'com', 'é', 'são', 'em', 'que', 'se', 'mais', 'opção', 'fonte'])
  }
};

/** Reduce a tag's raw inner value to comparable plain text (no CDATA/HTML/entities). */
function toPlainText(raw) {
  if (typeof raw !== 'string') return '';
  let t = stripCData(raw);
  t = t.replace(/<[^>]+>/g, ' '); // drop HTML tags
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * True if `text` reads as a genuine localization for `lang`:
 * non-Latin locales must contain their script; Latin locales must show
 * language-specific diacritics or function words (and not read as English).
 */
function looksLocalized(text, lang) {
  const base = String(lang).toLowerCase().split(/[-_]/)[0];

  const script = SCRIPT_RANGES[base];
  if (script) {
    return script.test(text);
  }

  const sig = LOCALE_SIGNALS[base];
  const words = (text.toLowerCase().match(/[a-zà-ÿœæ]+/gi) || []);
  if (sig) {
    if (sig.re.test(text)) return true; // locale-specific diacritics present
    let loc = 0;
    let en = 0;
    for (const w of words) {
      if (sig.words.has(w)) loc += 1;
      if (EN_WORDS.has(w)) en += 1;
    }
    if (loc > 0 && loc >= en) return true; // clearly the target language
    if (en > loc) return false; // clearly English
  }

  // Unknown Latin locale, or no decisive signal: treat non-ASCII (diacritics)
  // as localized and pure-ASCII text as an English fallback.
  return /[^\x00-\x7f]/.test(text);
}

/**
 * Decide whether an EXISTING target-locale value is an untranslated English
 * fallback that should be overwritten.
 *   - empty                                    -> overwrite (needs content)
 *   - identical (case-insensitive) to x-default -> overwrite (mirrored fallback)
 *   - does not read as a genuine localization   -> overwrite (English fallback)
 *   - otherwise                                 -> preserve (real translation)
 */
function isEnglishFallback(existingRaw, srcRaw, lang) {
  const existing = toPlainText(existingRaw);
  if (existing === '') return true;
  const src = toPlainText(srcRaw);
  if (existing.toLowerCase() === src.toLowerCase()) return true;
  return !looksLocalized(existing, lang);
}

/**
 * Guarantee that within each <page-attributes> block every <page-title> is
 * serialized before every <page-description> (never interleaved). Only blocks
 * that contain solely page-title / page-description elements are reordered, so
 * other children (page-keywords, page-url, ...) are never moved.
 */
function reorderPageAttributes(xml) {
  const pageAttrRe = /(<page-attributes\b[^>]*>)([\s\S]*?)(<\/page-attributes>)/g;
  return xml.replace(pageAttrRe, (full, open, inner, close) => {
    const elemRe = /(\s*)(<page-(title|description)\b[\s\S]*?<\/page-\3>)/g;
    const items = [];
    let m;
    while ((m = elemRe.exec(inner)) !== null) {
      items.push({ ws: m[1], el: m[2], type: m[3] });
    }
    const titles = items.filter((i) => i.type === 'title');
    const descriptions = items.filter((i) => i.type === 'description');
    if (titles.length === 0 || descriptions.length === 0) {
      return full; // nothing that could interleave
    }
    // Skip if the block holds anything other than titles/descriptions + whitespace.
    if (inner.replace(elemRe, '').trim() !== '') {
      return full;
    }
    const last = items[items.length - 1];
    const lastEnd = inner.lastIndexOf(last.el) + last.el.length;
    const trailing = inner.slice(lastEnd);
    const body = [...titles, ...descriptions].map((i) => i.ws + i.el).join('');
    return `${open}${body}${trailing}${close}`;
  });
}

/**
 * Return the raw inner content of an existing <tag xml:lang="lang"> that also
 * matches every attribute in otherAttrs, or null if no such tag exists.
 */
function findExistingTagContent(productBlock, tagName, lang, otherAttrs) {
  const tagRegex = new RegExp(`<${tagName}(\\s+[^>]*?)>([\\s\\S]*?)</${tagName}>`, 'g');
  let match;
  while ((match = tagRegex.exec(productBlock)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs['xml:lang'] === lang) {
      let allMatch = true;
      for (const [k, v] of Object.entries(otherAttrs)) {
        if (attrs[k] !== v) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return match[2];
    }
  }
  return null;
}

function updateTagContent(productBlock, tagName, lang, otherAttrs, newContent) {
  const tagRegex = new RegExp(`<${tagName}(\\s+[^>]*?)>([\\s\\S]*?)</${tagName}>`, 'g');
  return productBlock.replace(tagRegex, (fullMatch, attrStr) => {
    const attrs = parseAttributes(attrStr);
    if (attrs['xml:lang'] === lang) {
      let allMatch = true;
      for (const [k, v] of Object.entries(otherAttrs)) {
        if (attrs[k] !== v) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return `<${tagName}${attrStr}>${newContent}</${tagName}>`;
      }
    }
    return fullMatch;
  });
}

async function processProductBlock(productBlock, cloneLangs, provider, report = NULL_REPORTER) {
  const xDefaultRegex = /<([a-zA-Z0-9:-]+)(\s+[^>]*?xml:lang=["']x-default["'][^>]*?)>([\s\S]*?)<\/([a-zA-Z0-9:-]+)>/g;

  let match;
  const xDefaultTags = [];
  while ((match = xDefaultRegex.exec(productBlock)) !== null) {
    const tagName = match[1];
    if (tagName !== match[4]) continue;

    const attrs = parseAttributes(match[2]);
    let entry = null;
    if (TRANSLATABLE_TAGS.has(tagName)) {
      entry = { html: HTML_TAGS.has(tagName), cdata: false };
    } else if (tagName === 'custom-attribute' && CUSTOM_ATTR_MAP.has(attrs['attribute-id'])) {
      const cfg = CUSTOM_ATTR_MAP.get(attrs['attribute-id']);
      // custom-attributes are translated HTML-aware; CDATA output keeps markup raw.
      entry = { html: true, cdata: !!cfg.cdata };
    }
    if (!entry) continue;

    xDefaultTags.push({
      fullMatch: match[0],
      tagName,
      attrStr: match[2],
      content: match[3],
      html: entry.html,
      cdata: entry.cdata
    });
  }

  // Process last-to-first so earlier match indices stay valid as we splice.
  for (let i = xDefaultTags.length - 1; i >= 0; i -= 1) {
    const { tagName, attrStr, content, fullMatch, html, cdata } = xDefaultTags[i];

    // CDATA output (e.g. subtitle) may wrap the source; translate the inner text.
    const srcText = cdata ? stripCData(content) : content;
    if (typeof srcText !== 'string' || srcText.trim() === '') {
      report.addSkipped(1); // empty source
      continue; // skip empty source
    }

    const otherAttrs = parseAttributes(attrStr);
    delete otherAttrs['xml:lang'];

    // Classify each target locale:
    //   - missing            -> create a new translated tag
    //   - English fallback    -> overwrite the existing tag with a translation
    //   - genuine translation -> preserve (never translated, never overwritten)
    const langsToCreate = [];
    const langsToOverwrite = [];
    for (const lang of cloneLangs) {
      const existing = findExistingTagContent(productBlock, tagName, lang, otherAttrs);
      if (existing === null) {
        langsToCreate.push(lang);
      } else if (isEnglishFallback(existing, srcText, lang)) {
        langsToOverwrite.push(lang);
      }
    }

    const langsToTranslate = [...langsToCreate, ...langsToOverwrite];
    // Locales that already hold a genuine translation are preserved (skipped).
    report.addSkipped(cloneLangs.length - langsToTranslate.length);
    if (langsToTranslate.length === 0) {
      continue;
    }

    const langResults = await Promise.all(
      langsToTranslate.map(async (lang) => {
        report.setLocale(lang);
        let translatedContent;
        if (html) {
          const rawContent = await provider.translateHtmlContent(srcText, lang);
          translatedContent = cdata ? wrapCData(rawContent) : encodeHtmlEntities(rawContent);
        } else {
          translatedContent = await provider.translateText(srcText, lang);
        }
        return { lang, translatedContent };
      })
    );
    const translatedByLang = new Map(langResults.map(({ lang, translatedContent }) => [lang, translatedContent]));
    report.addTranslated(langsToTranslate.length);

    // Overwrite existing English-fallback tags in place (never x-default, which
    // is not a target locale). This changes only the tag's content, so the
    // x-default insertion anchor below stays valid.
    for (const lang of langsToOverwrite) {
      productBlock = updateTagContent(productBlock, tagName, lang, otherAttrs, translatedByLang.get(lang));
    }

    const newTagsToInsert = langsToCreate.map(
      (lang) => `<${tagName}${buildAttrStr(lang, otherAttrs)}>${translatedByLang.get(lang)}</${tagName}>`
    );

    if (newTagsToInsert.length > 0) {
      const tagIndex = productBlock.lastIndexOf(fullMatch);
      if (tagIndex !== -1) {
        let indent = '';
        let j = tagIndex - 1;
        while (j >= 0 && (productBlock[j] === ' ' || productBlock[j] === '\t')) {
          indent = productBlock[j] + indent;
          j -= 1;
        }
        if (j >= 0 && productBlock[j] === '\n') {
          indent = `\n${indent}`;
        } else {
          indent = '';
        }
        const separator = indent || '\n';
        const insertionString = newTagsToInsert.map((t) => separator + t).join('');
        const insertPos = tagIndex + fullMatch.length;
        productBlock = productBlock.slice(0, insertPos) + insertionString + productBlock.slice(insertPos);
      }
    }
  }

  return productBlock;
}

/**
 * Translate a Product XML string.
 * @param {string} xml
 * @param {{ targetLanguages?: string[], provider: object }} options
 * @returns {Promise<string>}
 */
async function translateXml(xml, options = {}) {
  const provider = options.provider;
  if (!provider) {
    throw new Error('productXmlTranslator.translateXml requires options.provider');
  }
  const report = options.reporter || NULL_REPORTER;
  const cloneLangs =
    options.targetLanguages && options.targetLanguages.length > 0
      ? options.targetLanguages
      : rules.defaultTargetLanguages;

  const productRegex = /<product\b[\s\S]*?<\/product>/g;
  const productMatches = [];
  let match;
  while ((match = productRegex.exec(xml)) !== null) {
    productMatches.push({ fullMatch: match[0], index: match.index });
  }

  let lastIdx = 0;
  let resultXml = '';
  for (const matchInfo of productMatches) {
    const idMatch = /<product\b[^>]*\bproduct-id="([^"]*)"/.exec(matchInfo.fullMatch);
    report.setComponent(idMatch ? `product (${idMatch[1]})` : 'product');
    resultXml += xml.slice(lastIdx, matchInfo.index);
    resultXml += await processProductBlock(matchInfo.fullMatch, cloneLangs, provider, report);
    report.tickUnit();
    lastIdx = matchInfo.index + matchInfo.fullMatch.length;
  }
  resultXml += xml.slice(lastIdx);

  // Guarantee page-title precedes page-description within page-attributes.
  resultXml = reorderPageAttributes(resultXml);

  // Validation: never emit broken XML — fall back to the original on failure.
  if (!isWellFormedXml(resultXml)) {
    logger.warn('[Product][Validation] Output XML is not well-formed — keeping original content.');
    return xml;
  }

  logger.info(`[Product] products=${productMatches.length} langs=${cloneLangs.join(',')}`);
  return resultXml;
}

module.exports = { translateXml };
