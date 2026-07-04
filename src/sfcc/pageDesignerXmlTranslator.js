'use strict';

const { deepClone, tryParse } = require('../utils/jsonUtils');
const { encodeHtmlEntities, decodeXmlEntities, isWellFormedXml, escapeRegExp } = require('../utils/xmlUtils');
const logger = require('../utils/logger');
const { NULL_REPORTER } = require('../utils/progress');
const rules = require('./rules/pageDesignerRules');

/**
 * Page Designer XML (SFCC <library>) translator.
 *
 * For each <content> block it reads the x-default <data> JSON, clones it per
 * target language, translates whitelisted values, and appends a new
 * <data xml:lang="..."> per language. The XML shell, namespaces and untouched
 * fields are preserved verbatim.
 */

const TRANSLATABLE = new Set(rules.translatableKeys);
const HTML_KEYS = new Set(rules.htmlKeys);

function normalizeType(typeValue) {
  return String(typeValue || '').trim().toLowerCase();
}

/** Human-readable label for a <content> block: "type (content-id)". */
function componentLabel(openTag, typeValue) {
  const m = /content-id="([^"]*)"/.exec(openTag || '');
  const id = m ? m[1] : '';
  const type = typeValue || 'content';
  return id ? `${type} (${id})` : type;
}

const SKIP_TYPES = new Set(rules.skipTypes.map(normalizeType));
const CMREPEATER_TYPE = normalizeType(rules.components.cmRepeater);
const CMDOWNLOADFILES_TYPE = normalizeType(rules.components.cmDownloadFiles);

async function translateFieldsRecursively(sourceNode, targetNode, targetLocale, provider) {
  if (!sourceNode || typeof sourceNode !== 'object') {
    return;
  }

  if (Array.isArray(sourceNode)) {
    for (let i = 0; i < sourceNode.length; i += 1) {
      await translateFieldsRecursively(sourceNode[i], targetNode[i], targetLocale, provider);
    }
    return;
  }

  for (const [key, sourceValue] of Object.entries(sourceNode)) {
    if (TRANSLATABLE.has(key) && typeof sourceValue === 'string' && sourceValue.trim() !== '') {
      if (HTML_KEYS.has(key)) {
        targetNode[key] = await provider.translateHtmlContent(sourceValue, targetLocale);
      } else {
        targetNode[key] = await provider.translateText(sourceValue, targetLocale);
      }
      continue;
    }
    if (sourceValue && typeof sourceValue === 'object' && targetNode[key]) {
      await translateFieldsRecursively(sourceValue, targetNode[key], targetLocale, provider);
    }
  }
}

/** cmRepeater specs.value is a JSON-stringified array; translate each displayName. */
async function translateSpecsArray(jsonArrayString, targetLocale, provider) {
  if (typeof jsonArrayString !== 'string' || !jsonArrayString.trim().startsWith('[')) {
    return jsonArrayString;
  }
  const parsed = tryParse(jsonArrayString);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return jsonArrayString;
  }
  const specsArray = parsed.value;
  for (const spec of specsArray) {
    if (spec && typeof spec.displayName === 'string' && spec.displayName.trim() !== '') {
      spec.displayName = await provider.translateText(spec.displayName, targetLocale);
    }
    // value (model/spec numbers) intentionally left untranslated.
  }
  return JSON.stringify(specsArray);
}

/**
 * cmDownloadFiles files_to_download.value is a JSON string (a single object or
 * an array of { displayName, value }). Translate only displayName; value is a
 * URL and must be left untouched. The result is re-serialized and validated as
 * JSON — on any failure the original string is kept.
 */
async function translateDownloadFilesValue(jsonString, targetLocale, provider) {
  if (typeof jsonString !== 'string' || jsonString.trim() === '') {
    return jsonString;
  }
  const parsed = tryParse(jsonString);
  if (!parsed.ok) {
    logger.warn('[Validation] cmDownloadFiles files_to_download.value is not valid JSON — keeping original.');
    return jsonString;
  }

  const translateItem = async (item) => {
    if (item && typeof item.displayName === 'string' && item.displayName.trim() !== '') {
      item.displayName = await provider.translateText(item.displayName, targetLocale);
    }
    // value is a URL — never modified.
  };

  const data = parsed.value;
  if (Array.isArray(data)) {
    for (const item of data) {
      await translateItem(item);
    }
  } else if (data && typeof data === 'object') {
    await translateItem(data);
  }

  const out = JSON.stringify(data);
  if (!tryParse(out).ok) {
    logger.warn('[Validation] cmDownloadFiles value failed to re-serialize — keeping original.');
    return jsonString;
  }
  return out;
}

function formatDataTag(lang, obj) {
  const jsonText = JSON.stringify(obj, null, 2);
  // Validation: the object we just serialized must re-parse.
  if (!tryParse(jsonText).ok) {
    logger.warn(`[Validation] Skipped ${lang} data — produced JSON does not re-parse.`);
    return null;
  }
  const xmlSafeJsonText = encodeHtmlEntities(jsonText);
  return `<data xml:lang="${lang}">${xmlSafeJsonText}</data>`;
}

/**
 * Translate a Page Designer XML string.
 * @param {string} xml
 * @param {{ targetLanguages?: string[], provider: object }} options
 * @returns {Promise<string>}
 */
async function translateXml(xml, options = {}) {
  const provider = options.provider;
  if (!provider) {
    throw new Error('pageDesignerXmlTranslator.translateXml requires options.provider');
  }
  const report = options.reporter || NULL_REPORTER;
  const cloneLangs =
    options.targetLanguages && options.targetLanguages.length > 0
      ? options.targetLanguages
      : rules.defaultTargetLanguages;

  const xmlDeclarationMatch = xml.match(/<\?xml[^>]*\?>/);
  const libraryOpenTagMatch = xml.match(/<library\b[^>]*>/);
  if (!libraryOpenTagMatch) {
    throw new Error('Cannot find <library ...> root element in source XML.');
  }

  const xmlDeclaration = xmlDeclarationMatch ? `${xmlDeclarationMatch[0]}\n` : '';
  const libraryOpenTag = libraryOpenTagMatch[0];

  const contentBlocks = xml.match(/<content\b[\s\S]*?<\/content>/g) || [];
  const resultContentBlocks = [];

  let skippedByType = 0;
  let skippedWithoutXDefault = 0;

  for (const block of contentBlocks) {
    const openTagMatch = block.match(/^<content\b[^>]*>/);
    const typeMatch = block.match(/<type>([\s\S]*?)<\/type>/);
    const xDefaultDataMatch = block.match(
      new RegExp(`<data\\b[^>]*xml:lang="${rules.sourceLang}"[^>]*>[\\s\\S]*?</data>`)
    );

    if (!openTagMatch || !typeMatch) {
      continue;
    }

    const typeValue = typeMatch[1].trim();
    report.setComponent(componentLabel(openTagMatch[0], typeValue));
    if (SKIP_TYPES.has(normalizeType(typeValue))) {
      skippedByType += 1;
      report.addSkipped(1);
      report.tickUnit();
      continue;
    }
    if (!xDefaultDataMatch) {
      skippedWithoutXDefault += 1;
      report.addSkipped(1);
      report.tickUnit();
      continue;
    }

    const openTag = openTagMatch[0];
    const xDefaultDataTag = xDefaultDataMatch[0];
    const xDefaultJsonMatch = xDefaultDataTag.match(/<data\b[^>]*>([\s\S]*?)<\/data>/);
    if (!xDefaultJsonMatch) {
      skippedWithoutXDefault += 1;
      report.addSkipped(1);
      report.tickUnit();
      continue;
    }

    // Decode the exact inverse of the write-time encoding (& < >) so the
    // in-memory JSON holds real characters; formatDataTag re-encodes once. This
    // prevents double-encoding (e.g. & -> &amp;amp;) for non-HTML fields and URLs.
    const parsedXDefault = tryParse(decodeXmlEntities(xDefaultJsonMatch[1]));
    if (!parsedXDefault.ok) {
      // Keep the original content block verbatim rather than dropping it.
      logger.warn(`[Validation] Invalid JSON in x-default data for type '${typeValue}' — keeping original block.`);
      resultContentBlocks.push(`    ${block}`);
      report.addSkipped(1);
      report.tickUnit();
      continue;
    }
    const xDefaultObj = parsedXDefault.value;

    const langResults = await Promise.all(
      cloneLangs.map(async (lang) => {
        report.setLocale(lang);
        const langObj = deepClone(xDefaultObj);
        await translateFieldsRecursively(xDefaultObj, langObj, lang, provider);

        if (
          normalizeType(typeValue) === CMREPEATER_TYPE &&
          langObj.specs &&
          typeof langObj.specs.value === 'string'
        ) {
          langObj.specs.value = await translateSpecsArray(langObj.specs.value, lang, provider);
        }

        if (normalizeType(typeValue) === CMDOWNLOADFILES_TYPE) {
          // Auto-generate a localized title when x-default has none.
          const hasTitle = typeof xDefaultObj.title === 'string' && xDefaultObj.title.trim() !== '';
          if (!hasTitle && rules.downloadTitleByLang[lang]) {
            langObj.title = rules.downloadTitleByLang[lang];
          }
          // Translate displayName inside files_to_download.value (URLs untouched).
          if (langObj.files_to_download && typeof langObj.files_to_download.value === 'string') {
            langObj.files_to_download.value = await translateDownloadFilesValue(
              langObj.files_to_download.value,
              lang,
              provider
            );
          }
        }

        return formatDataTag(lang, langObj);
      })
    );

    const newDataTags = [];
    for (const tag of langResults) {
      if (tag) newDataTags.push(tag);
    }
    report.addTranslated(newDataTags.length);
    report.addFailed(langResults.length - newDataTags.length);
    report.tickUnit();

    // Preserve the ENTIRE original <content> block — display-name, config,
    // visibility-mode, content-links, folder-links, content-object-assignments
    // and any non-target-language <data>. We only regenerate the target-language
    // <data> tags from x-default: drop existing ones for those locales, then
    // insert the fresh translations right after the x-default <data> tag.
    let blockOut = block;
    for (const lang of cloneLangs) {
      const existingRe = new RegExp(
        `\\n[ \\t]*<data\\b[^>]*xml:lang="${escapeRegExp(lang)}"[^>]*>[\\s\\S]*?</data>`,
        'g'
      );
      blockOut = blockOut.replace(existingRe, '');
    }
    if (newDataTags.length > 0) {
      const inserted = newDataTags.map((tag) => `        ${tag}`).join('\n');
      // Replacement passed as a function so any `$` in the JSON is treated literally.
      blockOut = blockOut.replace(xDefaultDataTag, () => `${xDefaultDataTag}\n${inserted}`);
    }
    // Restore the block's original 4-space indentation under <library>.
    resultContentBlocks.push(`    ${blockOut}`);
  }

  const outputXml = [
    `${xmlDeclaration}${libraryOpenTag}`.trimEnd(),
    ...resultContentBlocks,
    '</library>',
    ''
  ].join('\n');

  // Validation: never emit broken XML — fall back to the original on failure.
  if (!isWellFormedXml(outputXml)) {
    logger.warn('[PageDesigner][Validation] Output XML is not well-formed — keeping original content.');
    return xml;
  }

  logger.info(
    `[PageDesigner] blocks=${contentBlocks.length} exported=${resultContentBlocks.length} ` +
      `skippedByType=${skippedByType} skippedNoXDefault=${skippedWithoutXDefault} langs=${cloneLangs.join(',')}`
  );

  return outputXml;
}

module.exports = { translateXml };
