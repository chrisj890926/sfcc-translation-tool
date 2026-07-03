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

function checkTagExists(productBlock, tagName, lang, otherAttrs) {
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
      if (allMatch) return true;
    }
  }
  return false;
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

async function processProductBlock(productBlock, cloneLangs, provider) {
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
      continue; // skip empty source
    }

    const otherAttrs = parseAttributes(attrStr);
    delete otherAttrs['xml:lang'];

    const langResults = await Promise.all(
      cloneLangs.map(async (lang) => {
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

    const newTagsToInsert = [];
    for (const { lang, translatedContent } of langResults) {
      // Do not overwrite an existing non-empty target translation.
      if (checkTagExists(productBlock, tagName, lang, otherAttrs)) {
        continue;
      }
      const newAttrStr = buildAttrStr(lang, otherAttrs);
      newTagsToInsert.push(`<${tagName}${newAttrStr}>${translatedContent}</${tagName}>`);
    }

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
    resultXml += xml.slice(lastIdx, matchInfo.index);
    resultXml += await processProductBlock(matchInfo.fullMatch, cloneLangs, provider);
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
