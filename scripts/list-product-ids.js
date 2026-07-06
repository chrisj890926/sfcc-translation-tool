'use strict';

/**
 * List every product id in an SFCC export and write them to a CSV (Excel-ready).
 * No Claude calls — pure local parsing.
 *
 *   <catalog> : every <product product-id="...">, classified as
 *               master / standard / variant, sorted masters+standalone first
 *               and variants last, with the owning master id for each variant.
 *   <library> : every page.productDetail <content content-id="..."> (product pages).
 *
 * Columns: product_id, kind, master_id, display_name
 *
 * Usage:
 *   node scripts/list-product-ids.js <input.xml> [output.csv]
 *
 * Example:
 *   node scripts/list-product-ids.js all_Product.xml
 *   -> all_Product.product-ids.csv
 */

const fs = require('fs');
const path = require('path');

const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function csv(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function displayName(block) {
  const m = block.match(/<display-name xml:lang="x-default">([\s\S]*?)<\/display-name>/);
  return m ? dec(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// master (owns variants) -> 0, standard (standalone) -> 1, variant -> 2
const RANK = { master: 0, standard: 1, variant: 2 };

function fromCatalog(xml) {
  const products = [];
  const re = /<product product-id="([^"]*)"[\s\S]*?<\/product>/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(xml)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    products.push({ id: m[1], block: m[0] });
  }

  // Map each variant SKU -> the master product that lists it in <variations>.
  const variantToMaster = new Map();
  for (const p of products) {
    if (!/<variations>/.test(p.block)) continue;
    const vr = /<variant\b[^>]*\bproduct-id="([^"]*)"/g;
    let v;
    while ((v = vr.exec(p.block)) !== null) {
      if (!variantToMaster.has(v[1])) variantToMaster.set(v[1], p.id);
    }
  }

  const rows = products.map((p) => {
    const isVariant = variantToMaster.has(p.id);
    const hasVariations = /<variations>/.test(p.block);
    const kind = isVariant ? 'variant' : hasVariations ? 'master' : 'standard';
    return {
      id: p.id,
      kind,
      masterId: isVariant ? variantToMaster.get(p.id) : '',
      name: displayName(p.block)
    };
  });

  // Masters + standalone on top, variants at the bottom (variants grouped by their master).
  rows.sort((a, b) => {
    if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] - RANK[b.kind];
    if (a.kind === 'variant' && a.masterId !== b.masterId) return a.masterId < b.masterId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

function fromLibrary(xml) {
  const rows = [];
  const seen = new Set();
  const re = /<content content-id="([^"]*)">([\s\S]*?)<\/content>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const typeMatch = m[2].match(/<type>([^<]+)<\/type>/);
    if (!typeMatch || typeMatch[1].trim() !== 'page.productDetail') continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    rows.push({ id: m[1], kind: 'page', masterId: '', name: displayName(m[0]) });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node scripts/list-product-ids.js <input.xml> [output.csv]');
    process.exit(1);
  }
  const abs = path.resolve(inputPath);
  const xml = fs.readFileSync(abs, 'utf8');

  let rows;
  if (/<catalog\b/.test(xml)) rows = fromCatalog(xml);
  else if (/<library\b/.test(xml)) rows = fromLibrary(xml);
  else {
    console.error('Input is neither a <catalog> nor a <library> export.');
    process.exit(1);
  }

  const outFile = outputPath
    ? path.resolve(outputPath)
    : path.join(path.dirname(abs), `${path.basename(abs).replace(/\.xml$/i, '')}.product-ids.csv`);

  const header = 'product_id,kind,master_id,display_name';
  const body = rows.map((r) => [csv(r.id), csv(r.kind), csv(r.masterId), csv(r.name)].join(',')).join('\r\n');
  // UTF-8 BOM so Excel opens CJK correctly.
  fs.writeFileSync(outFile, `﻿${header}\r\n${body}\r\n`, 'utf8');

  const counts = rows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
  const breakdown = Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(', ');
  console.log(`Wrote ${rows.length} rows (${breakdown}) -> ${path.relative(process.cwd(), outFile)}`);
}

main();
