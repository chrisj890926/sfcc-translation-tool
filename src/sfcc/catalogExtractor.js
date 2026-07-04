'use strict';

/**
 * Reduced Product Catalog extraction (no Claude calls).
 *
 * Given a full SFCC catalog XML (<catalog>) and one or more product ids, build a
 * smaller, valid catalog that contains ONLY the requested <product> blocks (plus
 * the variant products of any requested master). Everything that is not a
 * <product> — the XML declaration, the <catalog> element with its namespaces and
 * catalog-id, <header>, <category> definitions, <category-assignment>s,
 * relationships, product-option definitions, etc. — is preserved verbatim, so the
 * result stays fully compatible with SFCC Catalog Import in MERGE mode.
 *
 * Only unrelated <product> nodes are removed. Each kept <product> keeps its full
 * structure: attributes, variants, custom-attributes, images, and everything else
 * inside the block.
 */

/**
 * @param {string} xml full catalog XML
 * @param {string[]} productIds product-ids to keep
 * @returns {{ xml: string, stats: object }}
 */
function extractReducedCatalog(xml, productIds) {
  if (!/<catalog\b[^>]*>/.test(xml)) {
    throw new Error('Cannot find <catalog> root element for extraction.');
  }
  const requested = [...new Set(productIds.map((s) => String(s).trim()).filter(Boolean))];

  // Index every top-level <product> block (products never nest).
  const prodRe = /<product\b[^>]*\bproduct-id="([^"]*)"[\s\S]*?<\/product>/g;
  const products = [];
  const byId = new Map();
  let m;
  while ((m = prodRe.exec(xml)) !== null) {
    const entry = { id: m[1], start: m.index, end: m.index + m[0].length, text: m[0] };
    products.push(entry);
    if (!byId.has(m[1])) byId.set(m[1], entry);
  }
  const originalCount = products.length;

  // Seed kept set with requested ids that exist; note the ones that don't.
  const kept = new Set();
  const missingSeeds = [];
  for (const id of requested) {
    if (byId.has(id)) kept.add(id);
    else missingSeeds.push(id);
  }

  // Pull in variant products referenced by any requested master's <variant product-id="...">.
  const variantsAdded = [];
  for (const id of [...kept]) {
    const vr = /<variant\b[^>]*\bproduct-id="([^"]*)"/g;
    let vm;
    while ((vm = vr.exec(byId.get(id).text)) !== null) {
      if (byId.has(vm[1]) && !kept.has(vm[1])) {
        kept.add(vm[1]);
        variantsAdded.push(vm[1]);
      }
    }
  }

  if (kept.size === 0) {
    throw new Error(
      `None of the product ids [${requested.join(', ')}] were found as <product> nodes in the catalog.`
    );
  }

  // Rebuild: keep everything, drop only the non-kept <product> blocks. For a
  // dropped product, also drop the whitespace-only gap that preceded it so we
  // don't leave large runs of blank lines; any real content between products
  // (categories, assignments, ...) is preserved.
  let out = '';
  let cursor = 0;
  for (const p of products) {
    const between = xml.slice(cursor, p.start);
    if (kept.has(p.id)) {
      out += between + p.text;
    } else if (/\S/.test(between)) {
      out += between; // preserve non-product content that sat before this product
    }
    cursor = p.end;
  }
  out += xml.slice(cursor);
  out = out.replace(/\n{3,}/g, '\n\n'); // tidy blank-line runs left by removals

  const stats = {
    originalCount,
    reducedCount: kept.size,
    keptIds: [...kept],
    requested,
    variantsAdded,
    missingSeeds
  };
  return { xml: out, stats };
}

module.exports = { extractReducedCatalog };
