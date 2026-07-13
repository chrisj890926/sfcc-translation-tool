'use strict';

/**
 * Translation coverage / missing-translation checker (no Claude calls).
 *
 * Scans a Product catalog (<catalog>) or Page Designer library (<library>) and
 * reports, per target locale, which translatable fields are:
 *   MISSING       - has an x-default value but no value for that locale
 *   UNTRANSLATED  - value exists but equals x-default (copied English), or is
 *                   pure ASCII where a non-Latin locale (ja/ko/zh/th) is expected
 *
 * Output: console summary + a CSV of every gap + a comma-joined list of the
 * product ids that have at least one gap (paste into the app's Product IDs to
 * re-translate only those). Pure local; zero tokens.
 *
 * Usage:
 *   node scripts/check-translation-coverage.js <input.xml> --locales de-DE,fr-FR,ja-JP,ko-KR,zh-TW
 */

const fs = require('fs');
const path = require('path');
const productRules = require('../src/sfcc/rules/productRules');
const pdRules = require('../src/sfcc/rules/pageDesignerRules');

const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CJK = /[぀-ヿ㐀-鿿가-힣฀-๿]/; // ja/zh/ko/th scripts
const NONLATIN = new Set(['ja', 'ko', 'zh', 'th']);

// Script ranges for wrong-language detection.
const SCRIPT = {
  kana: /[぀-ゟ゠-ヿ]/, // hiragana/katakana (Japanese-specific)
  hangul: /[가-힣ᄀ-ᇿ]/, // Korean
  thai: /[฀-๿]/,
  han: /[㐀-䶿一-鿿]/ // CJK ideographs (zh / ja-kanji)
};
// Latin-script locale signals (diacritics + common function words) for spotting
// the wrong Latin language sitting in a locale field (e.g. French in de-DE).
const LATIN = {
  de: { re: /[äöüß]/i, w: ['und', 'der', 'die', 'das', 'für', 'mit', 'ist', 'sich', 'nicht', 'auch', 'werden', 'eine', 'zum', 'zur'] },
  fr: { re: /[àâçéèêëîïôûùœ]/i, w: ['le', 'la', 'les', 'des', 'une', 'pour', 'avec', 'est', 'vous', 'votre', 'nos', 'notre', 'et', 'aux', 'sur'] },
  es: { re: /[áéíóúñ¿¡]/i, w: ['el', 'la', 'los', 'las', 'una', 'para', 'con', 'es', 'su', 'por', 'como', 'más', 'del', 'que'] },
  it: { re: /[àèéìòù]/i, w: ['il', 'la', 'gli', 'una', 'per', 'con', 'sono', 'del', 'della', 'che', 'più', 'nel', 'dei'] },
  nl: { re: /[ëï]/i, w: ['de', 'het', 'een', 'voor', 'met', 'van', 'is', 'die', 'dat', 'niet', 'zijn', 'wordt', 'kan'] },
  pt: { re: /[ãõáâàéêíóôúç]/i, w: ['o', 'os', 'as', 'uma', 'para', 'com', 'são', 'do', 'da', 'em', 'que', 'mais', 'seu'] },
  vi: { re: /[ăâđêôơưàáảãạằắ]/i, w: ['của', 'và', 'các', 'cho', 'với', 'được', 'là', 'trong', 'một', 'này'] }
};
const LATIN_BASES = new Set(Object.keys(LATIN).concat(['id']));

function latinScore(text, lang) {
  const sig = LATIN[lang];
  if (!sig) return 0;
  let s = sig.re.test(text) ? 1 : 0;
  const words = (text.toLowerCase().match(/[a-zà-ÿ]+/gi) || []);
  const set = new Set(sig.w);
  for (const w of words) if (set.has(w)) s += 1;
  return s;
}

/** Return a note if `text` looks like a DIFFERENT language than `lang`, else null. */
function wrongLang(text, lang) {
  const v = String(text || '');
  if (v.trim() === '') return null;
  const base = String(lang).toLowerCase().split(/[-_]/)[0];

  // High-confidence: script mismatch.
  if (LATIN_BASES.has(base)) {
    if (SCRIPT.hangul.test(v)) return 'contains Korean';
    if (SCRIPT.kana.test(v)) return 'contains Japanese';
    if (SCRIPT.thai.test(v)) return 'contains Thai';
    if (SCRIPT.han.test(v)) return 'contains Chinese/Japanese';
  } else if (base === 'ja') {
    if (SCRIPT.hangul.test(v)) return 'looks Korean';
    if (SCRIPT.thai.test(v)) return 'contains Thai';
  } else if (base === 'ko') {
    if (SCRIPT.kana.test(v)) return 'looks Japanese';
    if (SCRIPT.thai.test(v)) return 'contains Thai';
  } else if (base === 'zh') {
    if (SCRIPT.kana.test(v)) return 'looks Japanese';
    if (SCRIPT.hangul.test(v)) return 'looks Korean';
    if (SCRIPT.thai.test(v)) return 'contains Thai';
  } else if (base === 'th') {
    if (SCRIPT.hangul.test(v)) return 'looks Korean';
    if (SCRIPT.kana.test(v)) return 'looks Japanese';
  }

  // Best-effort: Latin language mismatch (e.g. French text in de-DE).
  if (LATIN[base]) {
    const own = latinScore(v, base);
    let best = null;
    let bestScore = 0;
    for (const other of Object.keys(LATIN)) {
      if (other === base) continue;
      const sc = latinScore(v, other);
      if (sc > bestScore) { bestScore = sc; best = other; }
    }
    // Conservative: another language clearly present, own language absent.
    if (best && bestScore >= 2 && own === 0) return `likely ${best}`;
  }
  return null;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--locales') opt.locales = (argv[++i] || '').split(/[\s,]+/).filter(Boolean);
    else if (argv[i] === '--product-ids') opt.productIds = (argv[++i] || '').split(/[\s,]+/).filter(Boolean);
    else if (argv[i] === '--missing-only') opt.missingOnly = true;
    else pos.push(argv[i]);
  }
  return { inputPath: pos[0], outputPath: pos[1], locales: opt.locales || [], productIds: opt.productIds || null, missingOnly: !!opt.missingOnly };
}

function norm(raw) {
  if (raw == null) return '';
  let t = String(raw).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  t = dec(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/** classify one field value for a locale against x-default. */
function classify(xdefaultRaw, valueRaw, lang) {
  const xd = norm(xdefaultRaw);
  if (xd === '') return null; // nothing to translate
  if (valueRaw == null) return 'MISSING';
  const v = norm(valueRaw);
  if (v === '') return 'MISSING';
  if (v.toLowerCase() === xd.toLowerCase()) return 'UNTRANSLATED';
  const base = String(lang).toLowerCase().split(/[-_]/)[0];
  if (NONLATIN.has(base) && !CJK.test(v)) return 'UNTRANSLATED';
  return 'OK';
}

// ---- Product catalog ----
function fieldByLang(block, tag) {
  const o = {};
  const re = new RegExp(`<${tag}(\\s+[^>]*?)>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(block)) !== null) {
    const lang = (m[1].match(/xml:lang="([^"]*)"/) || [])[1];
    if (lang) o[lang] = m[2];
  }
  return o;
}
function subtitleByLang(block) {
  const o = {};
  const re = /<custom-attribute attribute-id="subtitle"([^>]*)>([\s\S]*?)<\/custom-attribute>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const lang = (m[1].match(/xml:lang="([^"]*)"/) || [])[1];
    if (lang) o[lang] = m[2];
  }
  return o;
}
function scanCatalog(xml, locales, filterIds, missingOnly) {
  const gaps = [];
  const re = /<product product-id="([^"]*)"[\s\S]*?<\/product>/g;
  let m;
  const fields = [...productRules.translatableTags, 'subtitle'];
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    if (filterIds && !filterIds.has(id)) continue;
    const block = m[0];
    // Product name (first x-default display-name, before <variations>). Used to
    // skip fields that merely repeat the product name — those aren't real copy
    // and are commonly left untranslated on purpose (model/brand names).
    const nameMatch = block.match(/<display-name xml:lang="x-default">([\s\S]*?)<\/display-name>/);
    const productName = nameMatch ? norm(nameMatch[1]).toLowerCase() : '';
    const maps = {};
    for (const tag of productRules.translatableTags) maps[tag] = fieldByLang(block, tag);
    maps.subtitle = subtitleByLang(block);
    for (const field of fields) {
      const xd = maps[field]['x-default'];
      const xdNorm = norm(xd);
      if (xdNorm === '') continue;
      if (productName && xdNorm.toLowerCase() === productName) continue; // field is just the product name — not real copy
      for (const lang of locales) {
        let status = classify(xd, maps[field][lang], lang);
        let detail = '';
        if (status === 'OK') {
          const wl = wrongLang(norm(maps[field][lang]), lang);
          if (wl) { status = 'WRONG_LANG'; detail = wl; }
        }
        if (!status || status === 'OK') continue;
        if (missingOnly && status !== 'MISSING') continue;
        gaps.push({ id, kind: 'product', field: detail ? `${field} (${detail})` : field, locale: lang, status, sample: xdNorm.slice(0, 50) });
      }
    }
  }
  return gaps;
}

// ---- Page Designer library ----
const PD_KEYS = new Set(pdRules.translatableKeys);
function collectTranslatable(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectTranslatable(x, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (PD_KEYS.has(k) && v.trim() !== '') out.push(v);
        const t = v.trim();
        if (t.startsWith('[') || t.startsWith('{')) {
          try { collectTranslatable(JSON.parse(t), out); } catch (e) { /* ignore */ }
        }
      } else if (v && typeof v === 'object') collectTranslatable(v, out);
    }
  }
  return out;
}
function scanLibrary(xml, locales, missingOnly) {
  const gaps = [];
  const re = /<content content-id="([^"]*)">([\s\S]*?)<\/content>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    const block = m[0];
    const xdMatch = block.match(/<data xml:lang="x-default">([\s\S]*?)<\/data>/);
    if (!xdMatch) continue;
    let xdObj;
    try { xdObj = JSON.parse(dec(xdMatch[1])); } catch (e) { continue; }
    const xdVals = collectTranslatable(xdObj, []);
    if (xdVals.length === 0) continue; // nothing translatable
    for (const lang of locales) {
      const lm = block.match(new RegExp(`<data xml:lang="${rx(lang)}">([\\s\\S]*?)</data>`));
      if (!lm) { gaps.push({ id, kind: 'content', field: '(whole block)', locale: lang, status: 'MISSING', sample: norm(JSON.stringify(xdVals[0])).slice(0, 50) }); continue; }
      let lObj;
      try { lObj = JSON.parse(dec(lm[1])); } catch (e) { gaps.push({ id, kind: 'content', field: '(data)', locale: lang, status: 'INVALID_JSON', sample: '' }); continue; }
      const lVals = collectTranslatable(lObj, []);
      let untr = 0;
      let wrong = 0;
      for (let i = 0; i < xdVals.length; i += 1) {
        const s = classify(xdVals[i], lVals[i], lang);
        if (s === 'UNTRANSLATED' || s === 'MISSING') untr += 1;
        else if (s === 'OK' && wrongLang(norm(lVals[i]), lang)) wrong += 1;
      }
      if (untr > 0 && !missingOnly) gaps.push({ id, kind: 'content', field: `${untr}/${xdVals.length} fields`, locale: lang, status: 'UNTRANSLATED', sample: norm(JSON.stringify(xdVals[0])).slice(0, 50) });
      if (wrong > 0 && !missingOnly) gaps.push({ id, kind: 'content', field: `${wrong}/${xdVals.length} fields wrong-lang`, locale: lang, status: 'WRONG_LANG', sample: norm(JSON.stringify(xdVals[0])).slice(0, 50) });
    }
  }
  return gaps;
}

function main() {
  const { inputPath, outputPath, locales, productIds, missingOnly } = parseArgs(process.argv.slice(2));
  if (!inputPath || locales.length === 0) {
    console.error('Usage: node scripts/check-translation-coverage.js <input.xml> --locales de-DE,fr-FR,ja-JP,ko-KR,zh-TW [--product-ids a,b] [--missing-only]');
    process.exit(1);
  }
  const abs = path.resolve(inputPath);
  const xml = fs.readFileSync(abs, 'utf8');
  const filterIds = productIds ? new Set(productIds) : null;

  let gaps;
  let mode;
  if (/<catalog\b/.test(xml)) { mode = 'catalog'; gaps = scanCatalog(xml, locales, filterIds, missingOnly); }
  else if (/<library\b/.test(xml)) { mode = 'library'; gaps = scanLibrary(xml, locales, missingOnly); }
  else { console.error('Input is neither <catalog> nor <library>.'); process.exit(1); }
  if (missingOnly) console.log('(--missing-only: showing only MISSING, hiding UNTRANSLATED)');

  // Summary
  const perLocale = {};
  const idsWithGaps = new Set();
  for (const g of gaps) {
    perLocale[g.locale] = perLocale[g.locale] || { MISSING: 0, UNTRANSLATED: 0, WRONG_LANG: 0, INVALID_JSON: 0 };
    perLocale[g.locale][g.status] = (perLocale[g.locale][g.status] || 0) + 1;
    idsWithGaps.add(g.id);
  }
  console.log(`\n=== Translation coverage (${mode}) ===`);
  console.log(`Locales checked : ${locales.join(', ')}`);
  console.log(`Total gaps      : ${gaps.length}`);
  console.log(`Items with gaps : ${idsWithGaps.size}`);
  console.log('\nPer locale:');
  for (const lang of locales) {
    const c = perLocale[lang] || { MISSING: 0, UNTRANSLATED: 0, WRONG_LANG: 0 };
    console.log(`  ${lang.padEnd(8)} missing: ${c.MISSING || 0}   untranslated: ${c.UNTRANSLATED || 0}   wrong-lang: ${c.WRONG_LANG || 0}`);
  }

  // CSV
  const outFile = outputPath
    ? path.resolve(outputPath)
    : path.join(path.dirname(abs), `${path.basename(abs).replace(/\.xml$/i, '')}.coverage-gaps.csv`);
  const header = 'id,kind,field,locale,status,x_default_sample';
  const rows = gaps.map((g) => [g.id, g.kind, g.field, g.locale, g.status, `"${g.sample.replace(/"/g, '""')}"`].join(','));
  fs.writeFileSync(outFile, `﻿${header}\r\n${rows.join('\r\n')}\r\n`, 'utf8');
  console.log(`\nGap detail CSV  : ${path.relative(process.cwd(), outFile)}`);

  // ids to re-translate (pure comma-joined, paste-safe into the app's Product IDs)
  const idsFile = outFile.replace(/\.csv$/, '.ids.txt');
  fs.writeFileSync(idsFile, [...idsWithGaps].join(', ') + '\n', 'utf8');
  console.log(`IDs to re-translate (${idsWithGaps.size}): ${path.relative(process.cwd(), idsFile)}`);
}

main();
