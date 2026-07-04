'use strict';

/**
 * Reduced Page Designer extraction (no Claude calls).
 *
 * Given a full SFCC library XML and one or more product ids, build a small,
 * valid library XML containing only each product's page.productDetail block and
 * the <content> blocks it references (recursively, via <content-link>). This
 * lets the translator run on a few KB instead of the full multi-MB export.
 */

/** Index every content block in the library, keyed by content-id (original text + type preserved). */
function indexContentBlocks(xml) {
  const index = new Map();
  const re = /([ \t]*)<content\b[^>]*\bcontent-id="([^"]*)"[^>]*>[\s\S]*?<\/content>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = m[2];
    if (index.has(id)) continue;
    const block = m[0];
    const typeMatch = block.match(/<type>([\s\S]*?)<\/type>/);
    index.set(id, { id, block, type: typeMatch ? typeMatch[1].trim() : '' });
  }
  return index;
}

/** All content-ids referenced by <content-link> inside a block. */
function childLinks(block) {
  const ids = [];
  const re = /<content-link\b[^>]*\bcontent-id="([^"]*)"/g;
  let m;
  while ((m = re.exec(block)) !== null) ids.push(m[1]);
  return ids;
}

/** BFS from a set of root ids, following content-links, collecting blocks. */
function collect(index, rootIds) {
  const included = [];
  const seenIncluded = new Set();
  const seen = new Set();
  const missingRefs = [];
  const missingSeeds = [];
  const queue = [];

  for (const id of rootIds) {
    if (index.has(id)) queue.push(id);
    else missingSeeds.push(id);
  }

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = index.get(id);
    if (!entry) {
      missingRefs.push(id);
      continue;
    }
    if (!seenIncluded.has(id)) {
      included.push(entry);
      seenIncluded.add(id);
    }
    for (const childId of childLinks(entry.block)) {
      if (!seen.has(childId)) queue.push(childId);
    }
  }
  return { included, missingRefs, missingSeeds };
}

/**
 * Extract a reduced library XML for the given product ids.
 * @param {string} xml full library XML
 * @param {string[]} productIds seed content-ids (usually product page ids)
 * @returns {{ xml: string, stats: object }}
 */
function extractReducedLibrary(xml, productIds) {
  const libOpenMatch = xml.match(/<library\b[^>]*>/);
  if (!libOpenMatch) {
    throw new Error('Cannot find <library> root element for extraction.');
  }
  const declMatch = xml.match(/<\?xml[^>]*\?>/);
  const decl = declMatch ? declMatch[0] : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const libOpen = libOpenMatch[0];

  const index = indexContentBlocks(xml);
  const originalContentCount = index.size;

  const { included, missingRefs, missingSeeds } = collect(index, productIds);

  if (included.length === 0) {
    throw new Error(
      `None of the product ids [${productIds.join(', ')}] were found as <content> blocks in the library.`
    );
  }

  const reducedXml = `${decl}\n${libOpen}\n${included.map((e) => `    ${e.block}`).join('\n')}\n</library>\n`;

  const stats = {
    originalContentCount,
    reducedContentCount: included.length,
    includedIds: included.map((e) => e.id),
    includedTypes: [...new Set(included.map((e) => e.type).filter(Boolean))].sort(),
    missingSeeds,
    missingRefs
  };

  return { xml: reducedXml, stats };
}

module.exports = { indexContentBlocks, childLinks, extractReducedLibrary };
