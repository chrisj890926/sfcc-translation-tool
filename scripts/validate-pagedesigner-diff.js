'use strict';

/**
 * Pre-import diff validation for a reduced/translated SFCC Page Designer library.
 *
 * Compares the ORIGINAL full library against a TRANSLATED reduced library and
 * classifies the result as one of:
 *   SAFE TO IMPORT     — only target-locale <data> regenerated, everything else intact
 *   NOT SAFE TO IMPORT — a real structural / translation violation (e.g. broken URL,
 *                        dropped content-links, non-target locale changed)
 *   BASELINE MISMATCH  — the original library is NOT the same export the translated
 *                        file was derived from, so the diff can't be trusted
 *
 * No Claude API calls — pure local comparison. Read-only; changes nothing.
 *
 * Usage:
 *   node scripts/validate-pagedesigner-diff.js <original.xml> <translated.xml> \
 *     --product-ids id1,id2 --locales de-DE,fr-FR,ja-JP,ko-KR
 */

const fs = require('fs');
const { indexContentBlocks, childLinks } = require('../src/sfcc/pageExtractor');

const VERDICT = { SAFE: 'SAFE', NOT_SAFE: 'NOT_SAFE', BASELINE_MISMATCH: 'BASELINE_MISMATCH' };
const EXIT = { SAFE: 0, NOT_SAFE: 1, BASELINE_MISMATCH: 3 };
// If at least this fraction of the expected subtree is missing from the translated
// file (with no clearer signal), treat it as a baseline mismatch rather than NOT SAFE.
const MISSING_RATIO_MISMATCH = 0.2;

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function contentBlock(xml, id) {
  const m = xml.match(new RegExp('<content content-id="' + rx(id) + '">[\\s\\S]*?</content>'));
  return m ? m[0] : null;
}
function allContentIds(xml) {
  return [...xml.matchAll(/<content content-id="([^"]*)">/g)].map((m) => m[1]);
}
function typeOf(block) {
  return ((block.match(/<type>([^<]+)<\/type>/) || [])[1] || '').trim();
}
function dataByLang(block) {
  const o = {};
  const re = /<data xml:lang="([^"]*)">([\s\S]*?)<\/data>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    o[m[1]] = o[m[1]] === undefined ? m[2] : ` DUP ${m[2]}`;
  }
  return o;
}
function remainder(block) {
  return block.replace(/<data xml:lang="[^"]*">[\s\S]*?<\/data>/g, '').replace(/\s+/g, '');
}
function expectedSubtree(index, roots) {
  const inc = new Set();
  const seen = new Set();
  const missingSeeds = [];
  const q = [];
  for (const r of roots) {
    if (index.has(r)) q.push(r);
    else missingSeeds.push(r);
  }
  while (q.length) {
    const id = q.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const e = index.get(id);
    if (!e) continue;
    inc.add(id);
    for (const c of childLinks(e.block)) if (!seen.has(c)) q.push(c);
  }
  return { inc, missingSeeds };
}

/**
 * Core validation. Pure — takes strings, returns a structured result.
 * @returns {{verdict, summary, baselineReasons, violations, changedByBlock}}
 */
function validate({ originalXml, translatedXml, productIds, locales, originalPath = '', translatedPath = '' }) {
  const target = new Set(locales);
  const index = indexContentBlocks(originalXml);
  const originalIds = new Set(index.keys());
  const { inc: expected, missingSeeds } = expectedSubtree(index, productIds);

  const translatedIds = allContentIds(translatedXml);
  const translatedSet = new Set(translatedIds);

  const matched = [...expected].filter((id) => translatedSet.has(id));
  const missing = [...expected].filter((id) => !translatedSet.has(id));
  const unexpected = translatedIds.filter((id) => !expected.has(id));
  const translatedNotInOriginal = translatedIds.filter((id) => !originalIds.has(id));

  // x-default divergence over content-ids present in BOTH files. The translator
  // never touches x-default, so any difference means a different source export.
  let xDefaultMismatchCount = 0;
  const xDefaultMismatchIds = [];
  for (const id of translatedIds) {
    if (!originalIds.has(id)) continue;
    const s = dataByLang(index.get(id).block)['x-default'];
    const o = dataByLang(contentBlock(translatedXml, id))['x-default'];
    if (s !== undefined && o !== undefined && s !== o) {
      xDefaultMismatchCount += 1;
      xDefaultMismatchIds.push(id);
    }
  }

  // ---- Real violations (only trusted when the baseline matches) ----
  const violations = [];
  const changedByBlock = {};
  for (const id of matched) {
    const src = index.get(id).block;
    const out = contentBlock(translatedXml, id);
    const s = dataByLang(src);
    const o = dataByLang(out);
    changedByBlock[id] = [];

    for (const [lang, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.includes(' DUP ')) violations.push(`duplicate <data> for ${id} locale ${lang}`);
      try {
        JSON.parse(dec(typeof v === 'string' ? v.replace(/^ DUP /, '') : v));
      } catch (e) {
        violations.push(`invalid <data> JSON for ${id} locale ${lang}`);
      }
    }

    for (const lang of new Set([...Object.keys(s), ...Object.keys(o)])) {
      if (lang === 'x-default') continue; // handled by baseline check
      if (target.has(lang)) {
        if (o[lang] === undefined) violations.push(`target locale ${lang} <data> removed for ${id}`);
        else if (s[lang] !== o[lang]) changedByBlock[id].push(lang);
      } else if (s[lang] !== o[lang]) {
        violations.push(`non-target locale ${lang} <data> changed for ${id}`);
      }
    }

    if (remainder(src) !== remainder(out)) violations.push(`structure changed outside <data> for ${id} (e.g. content-links / config / display-name)`);

    // URL + spec-value preservation inside translated JSON vs x-default
    let xd = null;
    try {
      xd = JSON.parse(dec(s['x-default']));
    } catch (e) { /* ignore */ }
    if (xd) {
      const t = typeOf(src);
      if (t === 'component.commerce_assets.cmDownloadFiles' && xd.files_to_download) {
        let xdUrls = [];
        try {
          xdUrls = JSON.parse(xd.files_to_download.value).map((i) => i.value);
        } catch (e) { /* ignore */ }
        for (const lang of target) {
          if (!o[lang]) continue;
          try {
            JSON.parse(JSON.parse(dec(o[lang])).files_to_download.value).forEach((it, i) => {
              if (xdUrls[i] !== undefined && it.value !== xdUrls[i]) violations.push(`cmDownloadFiles URL changed for ${id} (${lang})`);
            });
          } catch (e) {
            violations.push(`cmDownloadFiles value not valid JSON for ${id} (${lang})`);
          }
        }
      }
      if (t === 'component.commerce_assets.cmRepeater' && xd.specs) {
        let xdVals = [];
        try {
          xdVals = JSON.parse(xd.specs.value).map((i) => i.value);
        } catch (e) { /* ignore */ }
        for (const lang of target) {
          if (!o[lang]) continue;
          try {
            JSON.parse(JSON.parse(dec(o[lang])).specs.value).forEach((it, i) => {
              if (xdVals[i] !== undefined && it.value !== xdVals[i]) violations.push(`cmRepeater spec value changed for ${id} (${lang})`);
            });
          } catch (e) {
            violations.push(`cmRepeater value not valid JSON for ${id} (${lang})`);
          }
        }
      }
    }
  }
  // Small numbers of missing/unexpected on a matching baseline are real problems.
  const missingRatio = expected.size ? missing.length / expected.size : 0;
  if (missing.length > 0 && missingRatio < MISSING_RATIO_MISMATCH) violations.push(`${missing.length} expected subtree block(s) missing from translated file`);
  if (unexpected.length > 0 && translatedNotInOriginal.length === 0) violations.push(`${unexpected.length} translated block(s) are outside the requested product subtrees`);

  // ---- Baseline-mismatch signals (take precedence over violations) ----
  const baselineReasons = [];
  if (productIds.length > 0 && missingSeeds.length === productIds.length) {
    baselineReasons.push('Original library may not match the translated file baseline. (None of the requested product ids exist in the original library.)');
  }
  if (xDefaultMismatchCount > 0) {
    baselineReasons.push(
      `Baseline mismatch suspected: x-default differs before translation (${xDefaultMismatchCount} block(s): ` +
        `${xDefaultMismatchIds.slice(0, 5).join(', ')}${xDefaultMismatchIds.length > 5 ? ` …(+${xDefaultMismatchIds.length - 5})` : ''}).`
    );
  }
  if (translatedNotInOriginal.length > 0) {
    baselineReasons.push(
      `Original library may not match the translated file baseline. (${translatedNotInOriginal.length} translated content-id(s) do not exist in the original library: ` +
        `${translatedNotInOriginal.slice(0, 5).join(', ')}${translatedNotInOriginal.length > 5 ? ` …(+${translatedNotInOriginal.length - 5})` : ''}.)`
    );
  }
  if (missing.length > 0 && missingRatio >= MISSING_RATIO_MISMATCH) {
    baselineReasons.push(
      `Original library may not match the translated file baseline. (${missing.length}/${expected.size} expected subtree blocks are missing from the translated file.)`
    );
  }

  let verdict;
  if (baselineReasons.length > 0) verdict = VERDICT.BASELINE_MISMATCH;
  else if (violations.length > 0) verdict = VERDICT.NOT_SAFE;
  else verdict = VERDICT.SAFE;

  return {
    verdict,
    summary: {
      originalPath,
      translatedPath,
      productIds,
      locales: [...target],
      matchedContentCount: matched.length,
      missingContentCount: missing.length,
      xDefaultMismatchCount,
      unexpectedContentCount: unexpected.length,
      translatedNotInOriginalCount: translatedNotInOriginal.length
    },
    baselineReasons,
    violations: [...new Set(violations)],
    changedByBlock
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--product-ids') opt.productIds = (argv[++i] || '').split(/[\s,]+/).filter(Boolean);
    else if (argv[i] === '--locales') opt.locales = (argv[++i] || '').split(/[\s,]+/).filter(Boolean);
    else pos.push(argv[i]);
  }
  return { originalPath: pos[0], translatedPath: pos[1], productIds: opt.productIds || [], locales: opt.locales || [] };
}

function main() {
  const { originalPath, translatedPath, productIds, locales } = parseArgs(process.argv.slice(2));
  if (!originalPath || !translatedPath || productIds.length === 0 || locales.length === 0) {
    console.error(
      'Usage: node scripts/validate-pagedesigner-diff.js <original.xml> <translated.xml> --product-ids id1,id2 --locales de-DE,fr-FR,ja-JP,ko-KR'
    );
    process.exit(2);
  }
  const r = validate({
    originalXml: fs.readFileSync(originalPath, 'utf8'),
    translatedXml: fs.readFileSync(translatedPath, 'utf8'),
    productIds,
    locales,
    originalPath,
    translatedPath
  });
  const s = r.summary;

  console.log('\n=== Page Designer Pre-import Diff Validation ===');
  console.log(`Original library     : ${s.originalPath}`);
  console.log(`Translated file      : ${s.translatedPath}`);
  console.log(`Requested product ids: ${s.productIds.join(', ')}`);
  console.log(`Target locales       : ${s.locales.join(', ')}`);
  console.log('\n--- Summary ---');
  console.log(`  matched content blocks : ${s.matchedContentCount}`);
  console.log(`  missing content blocks : ${s.missingContentCount}`);
  console.log(`  x-default mismatches   : ${s.xDefaultMismatchCount}`);
  console.log(`  translated-not-in-orig : ${s.translatedNotInOriginalCount}`);
  console.log(`  unexpected blocks      : ${s.unexpectedContentCount}`);

  if (r.verdict === VERDICT.BASELINE_MISMATCH) {
    console.log('\n--- Baseline mismatch signals ---');
    for (const reason of r.baselineReasons) console.log(`  ⚠️  ${reason}`);
    console.log('\n  → The original library provided is not the same export the translated file');
    console.log('    was derived from, so a trustworthy diff is not possible. Re-run using the');
    console.log('    exact full library export that was used for extraction/translation.');
    console.log('\n========================================');
    console.log('  ⚠️  BASELINE MISMATCH — cannot validate');
    console.log('========================================\n');
    process.exit(EXIT.BASELINE_MISMATCH);
  }

  if (r.verdict === VERDICT.NOT_SAFE) {
    console.log('\n--- Violations ---');
    for (const v of r.violations) console.log(`  ✗ ${v}`);
    console.log('\n========================================');
    console.log(`  ❌ NOT SAFE TO IMPORT — ${r.violations.length} issue(s)`);
    console.log('========================================\n');
    process.exit(EXIT.NOT_SAFE);
  }

  const changedIds = Object.keys(r.changedByBlock).filter((id) => r.changedByBlock[id].length);
  console.log('\n--- What changed (intended) ---');
  console.log(`  ${changedIds.length} of ${s.matchedContentCount} blocks had target-locale <data> regenerated.`);
  console.log('\n========================================');
  console.log('  ✅ SAFE TO IMPORT');
  console.log('========================================\n');
  process.exit(EXIT.SAFE);
}

module.exports = { validate, VERDICT, EXIT };

if (require.main === module) main();
