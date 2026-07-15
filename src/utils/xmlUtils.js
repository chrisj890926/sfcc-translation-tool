'use strict';

/**
 * XML / string helpers. This project deliberately manipulates the raw XML with
 * regex + string ops (no XML parser) so that original formatting, namespaces,
 * CDATA and HTML entities are preserved byte-for-byte outside the translated
 * values.
 */

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeHtmlEntities(input) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Exact inverse of encodeHtmlEntities (only & < >). JSON-safe — unlike the full
 * decodeHtmlEntities it does NOT touch &quot; / &#39;, so it can be applied to a
 * raw <data> JSON string before JSON.parse without breaking string quoting.
 */
function decodeXmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function indentBlock(block, spaces) {
  return block
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n');
}

/** Parse an attribute string (the bit inside a tag after the tag name). */
function parseAttributes(attrStr) {
  const attrs = {};
  const regex = /([a-zA-Z0-9:-]+)\s*=\s*(['"])([\s\S]*?)\2/g;
  let match;
  while ((match = regex.exec(attrStr)) !== null) {
    attrs[match[1]] = match[3];
  }
  return attrs;
}

/** Rebuild an attribute string, appending xml:lang last (mirrors legacy output). */
function buildAttrStr(lang, otherAttrs) {
  let str = '';
  for (const [key, val] of Object.entries(otherAttrs)) {
    str += ` ${key}="${val}"`;
  }
  str += ` xml:lang="${lang}"`;
  return str;
}

/**
 * Merge multiple Product Section (<catalog>) XML strings into one.
 * Keeps the declaration, <catalog> wrapper and <header> from the first file,
 * then collects every <product> block from all files.
 */
function mergeProductXml(xmlStrings) {
  if (!xmlStrings || xmlStrings.length === 0) {
    throw new Error('No XML content to merge.');
  }
  if (xmlStrings.length === 1) {
    return xmlStrings[0];
  }

  const first = xmlStrings[0];
  const xmlDeclMatch = first.match(/<\?xml[^?]*\?>/);
  const xmlDecl = xmlDeclMatch ? xmlDeclMatch[0] : '<?xml version="1.0" encoding="UTF-8"?>';

  const catalogOpenMatch = first.match(/<catalog\b[^>]*>/);
  if (!catalogOpenMatch) {
    throw new Error('Could not find <catalog> root element in the first file.');
  }
  const catalogOpen = catalogOpenMatch[0];

  const headerMatch = first.match(/<header>[\s\S]*?<\/header>/);
  const headerBlock = headerMatch ? headerMatch[0] : '';

  const allProducts = [];
  for (const xml of xmlStrings) {
    const productRegex = /(\s*<product\b[\s\S]*?<\/product>)/g;
    let match;
    while ((match = productRegex.exec(xml)) !== null) {
      allProducts.push(match[1]);
    }
  }

  if (allProducts.length === 0) {
    throw new Error('No <product> elements found in any of the uploaded files.');
  }

  const indent = '    ';
  let merged = `${xmlDecl}\n${catalogOpen}\n`;
  if (headerBlock) {
    merged += `${indent}${headerBlock}\n`;
  }
  merged += '\n';
  merged += allProducts.join('\n\n');
  merged += '\n\n</catalog>\n';
  return merged;
}

/**
 * Merge multiple Page Designer (<library>) XML strings into one.
 * Keeps the declaration and <library> wrapper from the first file,
 * then collects every <content> block from all files.
 */
function mergeLibraryXml(xmlStrings) {
  if (!xmlStrings || xmlStrings.length === 0) {
    throw new Error('No XML content to merge.');
  }
  if (xmlStrings.length === 1) {
    return xmlStrings[0];
  }

  const first = xmlStrings[0];
  const xmlDeclMatch = first.match(/<\?xml[^?]*\?>/);
  const xmlDecl = xmlDeclMatch ? xmlDeclMatch[0] : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  const libraryOpenMatch = first.match(/<library\b[^>]*>/);
  if (!libraryOpenMatch) {
    throw new Error('Could not find <library> root element in the first file.');
  }
  const libraryOpen = libraryOpenMatch[0];

  const allContents = [];
  for (const xml of xmlStrings) {
    const contentRegex = /(\s*<content\b[\s\S]*?<\/content>)/g;
    let match;
    while ((match = contentRegex.exec(xml)) !== null) {
      allContents.push(match[1]);
    }
  }

  if (allContents.length === 0) {
    throw new Error('No <content> elements found in any of the uploaded files.');
  }

  let merged = `${xmlDecl}\n${libraryOpen}\n`;
  merged += allContents.join('\n');
  merged += '\n</library>\n';
  return merged;
}

/** Strip a surrounding CDATA wrapper, returning the inner text. No-op if absent. */
function stripCData(input) {
  if (typeof input !== 'string') {
    return input;
  }
  const match = input.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return match ? match[1] : input;
}

/** Wrap text in a CDATA section (escaping any accidental "]]>" terminator). */
function wrapCData(input) {
  const safe = String(input == null ? '' : input).replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/**
 * Best-effort XML well-formedness check (no external parser).
 * Tolerates the XML declaration, comments, CDATA, DOCTYPE, namespaces and
 * self-closing tags. Used as a safety net: if a translated document fails this
 * check the caller keeps the original content.
 */
function isWellFormedXml(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    return false;
  }
  let s = xml
    .replace(/<\?[\s\S]*?\?>/g, ' ') // declarations / processing instructions
    .replace(/<!--[\s\S]*?-->/g, ' ') // comments
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ') // CDATA
    .replace(/<!DOCTYPE[\s\S]*?>/gi, ' '); // doctype

  const tagRe = /<(\/?)([a-zA-Z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  let match;
  while ((match = tagRe.exec(s)) !== null) {
    const isClose = match[1] === '/';
    const name = match[2];
    const rest = match[3] || '';
    const selfClose = /\/\s*$/.test(rest);
    if (isClose) {
      if (stack.pop() !== name) {
        return false;
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length !== 0) {
    return false;
  }
  // Any raw angle bracket left outside a tag means the markup is malformed.
  const withoutTags = s.replace(tagRe, ' ');
  return withoutTags.indexOf('<') === -1 && withoutTags.indexOf('>') === -1;
}

/**
 * Keep only x-default and the given target locales; remove every other
 * localized element — any `<tag ... xml:lang="...">...</tag>` whose lang is not
 * kept (data, display-name, visibility-mode, short-description, subtitle, ...).
 *
 * Why: the translators preserve the input's existing locales and only
 * (re)generate the selected ones. A source export normally ships every locale
 * pre-filled with the English fallback, so a single-locale run would still
 * carry 11 other locales — many of them English — into the download. Importing
 * that file with MERGE then overwrites those other locales in the target (e.g.
 * a Korean import reverts Japanese to English). Stripping to x-default + the
 * selected locales makes a per-locale export touch only that locale on import.
 */
function stripUnselectedLocales(xml, keepLangs) {
  const keep = new Set(['x-default', ...(keepLangs || [])]);
  // Matches a localized element and its optional leading indentation, so a
  // dropped element leaves no blank line behind. Bodies never nest the same tag
  // (JSON data / plain text), so the non-greedy backreference close is safe.
  const elemRe = /(?:\n[ \t]*)?<([A-Za-z0-9:_-]+)\b[^>]*\bxml:lang="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g;
  return xml.replace(elemRe, (full, tag, lang) => (keep.has(lang) ? full : ''));
}

module.exports = {
  escapeRegExp,
  decodeHtmlEntities,
  encodeHtmlEntities,
  decodeXmlEntities,
  indentBlock,
  parseAttributes,
  buildAttrStr,
  stripCData,
  wrapCData,
  isWellFormedXml,
  stripUnselectedLocales,
  mergeProductXml,
  mergeLibraryXml
};
