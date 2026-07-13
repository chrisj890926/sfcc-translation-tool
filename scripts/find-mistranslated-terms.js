'use strict';

/**
 * Find products whose translation likely got an ambiguous term WRONG
 * (zero Claude calls — pure local scan). Two concerns:
 *
 *   clearance  : English field mentions "clearance" (a case size/space spec)
 *                but the target-locale value contains a retail "sale" word
 *                (出清 / clearance sale / Ausverkauf / solde ...).
 *   gpu-support: English field mentions "graphic(s) card support" but the
 *                target contains a physical "bracket/holder/stand" word.
 *
 * These are HEURISTIC candidates to review, not proof — a field can legitimately
 * mention a sale. The English-term co-occurrence is what makes it suspicious.
 *
 * Usage:
 *   node scripts/find-mistranslated-terms.js <catalog.xml> [--locales de-DE,ja-JP,...]
 * Output: console summary + <input>.mistranslated.csv + comma-joined ids file.
 */

const fs = require('fs');
const path = require('path');
const pdRules = require('../src/sfcc/rules/pageDesignerRules');

const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#13;/g, '').replace(/&amp;/g, '&');
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (raw) => {
  if (raw == null) return '';
  let t = String(raw).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  t = dec(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
};

const TRANSLATABLE_TAGS = ['short-description', 'page-title', 'page-description'];
const ALL_LOCALES = ['de-DE', 'es', 'fr-FR', 'it-IT', 'id-ID', 'ja-JP', 'ko-KR', 'nl-NL', 'pt-BR', 'th-TH', 'vi-VN', 'zh-TW'];

// Retail "sale/clearance-sale" words per locale base. Presence when English says
// "clearance" strongly implies the spec term was mistranslated as a sale.
const SALE = {
  zh: /出清|清倉|清仓|特賣|特卖|促銷|促销|拍賣|拍卖|特價|特价|降價|降价|折扣/,
  ja: /セール|特価|値下げ|バーゲン|在庫処分/,
  ko: /세일|할인|특가|재고\s*정리/,
  de: /Ausverkauf|Räumung|Sonderangebot|Rabatt|Schlussverkauf|reduziert/i,
  fr: /solde|liquidation|promotion|rabais|déstockage/i,
  es: /liquidación|rebaja|oferta|descuento|\bsaldo/i,
  it: /liquidazione|saldo|svendita|sconto|offerta/i,
  pt: /liquidação|promoção|desconto|\bsaldo/i,
  nl: /uitverkoop|opruiming|korting|aanbieding/i,
  vi: /giảm giá|thanh lý|khuyến mãi|xả hàng/i,
  id: /\bobral\b|diskon|cuci gudang|\bpromo\b/i,
  th: /ลดราคา|ล้างสต็อก|โปรโมชั่น/
};
// "physical bracket / holder / anti-sag stand" words — wrong for "GPU support" spec.
const BRACKET = {
  zh: /支架|支撐架|支撑架|支撐座|防下垂/,
  ja: /ブラケット|支え(る)?|スタンド|垂れ防止|支持金具/,
  ko: /브래킷|받침|거치대|지지대/,
  de: /Halterung|Halter|Stütze/i,
  fr: /support de fixation|équerre|béquille/i,
  es: /soporte de fijación|abrazadera|ménsula/i,
  it: /staffa|supporto di fissaggio|reggi/i,
  pt: /suporte de fixação|braçadeira/i,
  nl: /beugel|steun/i,
  vi: /giá đỡ|khung đỡ|thanh chống/i,
  id: /braket|penyangga|dudukan/i,
  th: /ขายึด|ตัวยึด|ขาตั้ง/
};

const base = (l) => String(l).toLowerCase().split(/[-_]/)[0];
const EN_CLEARANCE = /clearance/i;
const EN_GPU_SUPPORT = /graphics?\s+card\s+support/i;

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

// Flag one (english, translated) value pair. Pushes to hits when suspicious.
function checkPair(en, val, lang, id, field, hits) {
  if (!en || !val) return;
  if (val.toLowerCase() === en.toLowerCase()) return; // untranslated — handled by coverage tool
  const hasClear = EN_CLEARANCE.test(en);
  const hasGpu = EN_GPU_SUPPORT.test(en);
  if (!hasClear && !hasGpu) return;
  const b = base(lang);
  if (hasClear && SALE[b] && SALE[b].test(val)) hits.push({ id, field, locale: lang, issue: 'clearance→sale', sample: val.slice(0, 80) });
  if (hasGpu && BRACKET[b] && BRACKET[b].test(val)) hits.push({ id, field, locale: lang, issue: 'gpu-support→bracket', sample: val.slice(0, 80) });
}

// ---- Page Designer library: collect translatable values in document order ----
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

function scanCatalog(xml, locales, hits) {
  const re = /<product product-id="([^"]*)"[\s\S]*?<\/product>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    const block = m[0];
    const maps = {};
    for (const tag of TRANSLATABLE_TAGS) maps[tag] = fieldByLang(block, tag);
    maps.subtitle = subtitleByLang(block);
    for (const field of Object.keys(maps)) {
      const en = norm(maps[field]['x-default']);
      if (!en || (!EN_CLEARANCE.test(en) && !EN_GPU_SUPPORT.test(en))) continue;
      for (const lang of locales) checkPair(en, norm(maps[field][lang]), lang, id, field, hits);
    }
  }
}

function scanLibrary(xml, locales, hits) {
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
    if (xdVals.length === 0) continue;
    // Only bother if some x-default value carries an ambiguous term.
    const interesting = xdVals.some((v) => EN_CLEARANCE.test(v) || EN_GPU_SUPPORT.test(v));
    if (!interesting) continue;
    for (const lang of locales) {
      const lm = block.match(new RegExp(`<data xml:lang="${rx(lang)}">([\\s\\S]*?)</data>`));
      if (!lm) continue;
      let lObj;
      try { lObj = JSON.parse(dec(lm[1])); } catch (e) { continue; }
      const lVals = collectTranslatable(lObj, []);
      for (let i = 0; i < xdVals.length; i += 1) {
        const en = String(xdVals[i]);
        if (!EN_CLEARANCE.test(en) && !EN_GPU_SUPPORT.test(en)) continue;
        checkPair(en, lVals[i] != null ? String(lVals[i]) : '', lang, id, '(pd-data)', hits);
      }
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const inputPath = argv.find((a) => !a.startsWith('--'));
  let locales = ALL_LOCALES;
  const li = argv.indexOf('--locales');
  if (li !== -1 && argv[li + 1]) locales = argv[li + 1].split(/[\s,]+/).filter(Boolean);
  if (!inputPath) {
    console.error('Usage: node scripts/find-mistranslated-terms.js <catalog|library.xml> [--locales de-DE,ja-JP]');
    process.exit(1);
  }
  const abs = path.resolve(inputPath);
  const xml = fs.readFileSync(abs, 'utf8');

  const hits = [];
  let mode;
  if (/<catalog\b/.test(xml)) { mode = 'catalog'; scanCatalog(xml, locales, hits); }
  else if (/<library\b/.test(xml)) { mode = 'library'; scanLibrary(xml, locales, hits); }
  else { console.error('Input is neither <catalog> nor <library>.'); process.exit(1); }

  const ids = new Set(hits.map((h) => h.id));
  console.log(`\n=== Suspected mistranslated terms — ${mode} (review candidates) ===`);
  console.log(`Locales checked : ${locales.join(', ')}`);
  console.log(`Suspicious hits : ${hits.length}`);
  console.log(`Products        : ${ids.size}`);
  const byIssue = {};
  for (const h of hits) byIssue[h.issue] = (byIssue[h.issue] || 0) + 1;
  for (const k of Object.keys(byIssue)) console.log(`  ${k}: ${byIssue[k]}`);
  console.log('\nSamples:');
  for (const h of hits.slice(0, 20)) console.log(`  ${h.id} | ${h.field} | ${h.locale} | ${h.issue}\n      ${h.sample}`);

  const outCsv = path.join(path.dirname(abs), `${path.basename(abs).replace(/\.xml$/i, '')}.mistranslated.csv`);
  const header = 'id,field,locale,issue,sample';
  const rows = hits.map((h) => [h.id, h.field, h.locale, h.issue, `"${h.sample.replace(/"/g, '""')}"`].join(','));
  fs.writeFileSync(outCsv, `﻿${header}\r\n${rows.join('\r\n')}\r\n`, 'utf8');
  console.log(`\nCSV        : ${path.relative(process.cwd(), outCsv)}`);
  const idsFile = outCsv.replace(/\.csv$/, '.ids.txt');
  fs.writeFileSync(idsFile, [...ids].join(', ') + '\n', 'utf8');
  console.log(`IDs (${ids.size})   : ${path.relative(process.cwd(), idsFile)}`);
}

main();
