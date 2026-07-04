'use strict';

/**
 * Reduced Page Designer extraction CLI (no Claude calls).
 *
 * Usage:
 *   node scripts/extract-page.js <libraryXml> <productId> [outputXml] [--langs N]
 *
 * Example:
 *   node scripts/extract-page.js original-xml/elite130.xml elite130
 *
 * The extraction itself lives in src/sfcc/pageExtractor.js (shared with the
 * web UI). This CLI adds a size + Claude-cost report on top.
 */

const fs = require('fs');
const path = require('path');
const { decodeXmlEntities, isWellFormedXml } = require('../src/utils/xmlUtils');
const { indexContentBlocks, extractReducedLibrary } = require('../src/sfcc/pageExtractor');
const rules = require('../src/sfcc/rules/pageDesignerRules');

const TRANSLATABLE = new Set(rules.translatableKeys);
const SKIP_TYPES = new Set(rules.skipTypes.map((t) => t.trim().toLowerCase()));
const PRICE_IN = 5; // Claude Opus 4.8 USD / 1M tokens
const PRICE_OUT = 25;

function parseArgs(argv) {
  const positional = [];
  let langs = rules.defaultTargetLanguages.length;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--langs') {
      langs = parseInt(argv[i + 1], 10) || langs;
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { libraryPath: positional[0], productId: positional[1], outPath: positional[2], langs };
}

function sumTranslatable(node) {
  let total = 0;
  if (Array.isArray(node)) {
    for (const item of node) total += sumTranslatable(item);
    return total;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (TRANSLATABLE.has(key) && value.trim() !== '') total += value.length;
        const t = value.trim();
        if (t.startsWith('[') || t.startsWith('{')) {
          try {
            total += sumTranslatable(JSON.parse(t));
          } catch (e) {
            /* not nested JSON */
          }
        }
      } else if (value && typeof value === 'object') {
        total += sumTranslatable(value);
      }
    }
  }
  return total;
}

function blockTranslatableChars(entry) {
  if (SKIP_TYPES.has((entry.type || '').toLowerCase())) return 0;
  const m = entry.block.match(/<data\b[^>]*xml:lang="x-default"[^>]*>([\s\S]*?)<\/data>/);
  if (!m) return 0;
  try {
    return sumTranslatable(JSON.parse(decodeXmlEntities(m[1])));
  } catch (e) {
    return 0;
  }
}

function estimateCostUsd(chars, langs) {
  const srcTokens = Math.ceil(chars / 4);
  return ((srcTokens * langs) / 1e6) * PRICE_IN + ((srcTokens * langs) / 1e6) * PRICE_OUT;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const { libraryPath, productId, outPath, langs } = parseArgs(process.argv.slice(2));
  if (!libraryPath || !productId) {
    console.error('Usage: node scripts/extract-page.js <libraryXml> <productId> [outputXml] [--langs N]');
    process.exit(1);
  }

  const absLib = path.resolve(libraryPath);
  const xml = fs.readFileSync(absLib, 'utf8');
  const originalSize = Buffer.byteLength(xml, 'utf8');

  let reduced;
  let stats;
  try {
    ({ xml: reduced, stats } = extractReducedLibrary(xml, [productId]));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const reducedSize = Buffer.byteLength(reduced, 'utf8');

  const outFile = outPath ? path.resolve(outPath) : path.join(path.dirname(absLib), `${productId}.reduced.xml`);
  fs.writeFileSync(outFile, reduced, 'utf8');

  // Cost estimate over full index vs included blocks.
  const index = indexContentBlocks(xml);
  let charsBefore = 0;
  for (const entry of index.values()) charsBefore += blockTranslatableChars(entry);
  let charsAfter = 0;
  for (const id of stats.includedIds) charsAfter += blockTranslatableChars(index.get(id));
  const usdBefore = estimateCostUsd(charsBefore, langs);
  const usdAfter = estimateCostUsd(charsAfter, langs);

  console.log('\n=== Reduced Page Designer Extraction ===');
  console.log(`Product id            : ${productId}`);
  console.log(`Source library        : ${libraryPath}`);
  console.log(`Output                : ${path.relative(process.cwd(), outFile)}`);
  console.log(`Well-formed XML       : ${isWellFormedXml(reduced)}`);
  console.log('');
  console.log(`Original file size    : ${fmtBytes(originalSize)}`);
  console.log(`Reduced file size     : ${fmtBytes(reducedSize)}`);
  console.log(`Size reduction        : ${(100 - (reducedSize / originalSize) * 100).toFixed(3)}% smaller`);
  console.log('');
  console.log(`Original content count: ${stats.originalContentCount}`);
  console.log(`Reduced content count : ${stats.reducedContentCount}`);
  if (stats.missingRefs.length) console.log(`Referenced but missing: ${stats.missingRefs.join(', ')}`);
  console.log('');
  console.log('Included content-ids  :');
  for (const e of stats.includedIds) console.log(`  - ${e}`);
  console.log('');
  console.log('Included component types:');
  for (const t of stats.includedTypes) console.log(`  - ${t}`);
  console.log('');
  console.log(`Estimated Claude cost (Opus 4.8, ${langs} target languages, rough):`);
  console.log(`  BEFORE (full library): ~${charsBefore.toLocaleString()} chars -> $${usdBefore.toFixed(2)}`);
  console.log(`  AFTER  (reduced page): ~${charsAfter.toLocaleString()} chars -> $${usdAfter.toFixed(4)}`);
  const factor = usdAfter > 0 ? usdBefore / usdAfter : Infinity;
  console.log(`  Cost reduction        : ~${Number.isFinite(factor) ? `${factor.toFixed(0)}x cheaper` : 'n/a'}`);
  console.log('\nNote: token/cost figures are a rough estimate; the ratio is the reliable signal.\n');
}

main();
