'use strict';

/**
 * Tests for scripts/validate-pagedesigner-diff.js (baseline-mismatch aware).
 *
 * Builds tiny synthetic libraries, runs them through the real extractor +
 * Page Designer translator (mock provider, no network), then asserts the
 * validator's three verdicts: SAFE / BASELINE_MISMATCH / NOT_SAFE.
 *
 * Run: node test/validate-pagedesigner.test.js   (also part of `npm test`)
 */

const { TranslationProvider } = require('../src/translators/baseTranslator');
const pageDesigner = require('../src/sfcc/pageDesignerXmlTranslator');
const { extractReducedLibrary } = require('../src/sfcc/pageExtractor');
const { validate, VERDICT } = require('../scripts/validate-pagedesigner-diff');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const LANGS = ['ja-JP', 'ko-KR', 'de-DE', 'fr-FR'];

class MockProvider extends TranslationProvider {
  async _translateRawBatch(items, locale) {
    const out = {};
    for (const it of items) out[it.id] = `[${locale}] ${it.text}`;
    return out;
  }
}

/** Build a small coolermaster-global library. Options let us make a divergent baseline. */
function buildLibrary({ sizeValue = 'Mini ITX', downloadUrl = 'https://cm.example/dl/abc', downloadsId = 'p1-downloads' } = {}) {
  const specsData = JSON.stringify({ specs: { value: JSON.stringify([{ displayName: 'Size', value: sizeValue }]) } });
  const dlData = JSON.stringify({ files_to_download: { value: JSON.stringify([{ displayName: 'Manual', value: downloadUrl }]) } });
  return `<?xml version="1.0" encoding="UTF-8"?>
<library xmlns="http://www.demandware.com/xml/impex/library/2006-10-31" library-id="coolermaster-global">
    <content content-id="p1">
        <display-name xml:lang="x-default">p1</display-name>
        <type>page.productDetail</type>
        <config>{ "visibility" : [ ] }</config>
        <data xml:lang="x-default">{ "product" : null }</data>
        <content-links>
            <content-link content-id="p1-specs" type="page.productDetail.main"><position>0.0</position></content-link>
            <content-link content-id="${downloadsId}" type="page.productDetail.main"><position>1.0</position></content-link>
        </content-links>
        <content-object-assignments>
            <content-object-assignment object-id="p1" object-type="product"/>
        </content-object-assignments>
    </content>
    <content content-id="p1-specs">
        <type>component.commerce_assets.cmRepeater</type>
        <data xml:lang="x-default">${specsData}</data>
    </content>
    <content content-id="${downloadsId}">
        <type>component.commerce_assets.cmDownloadFiles</type>
        <data xml:lang="x-default">${dlData}</data>
    </content>
    <content content-id="unrelated-blog-post">
        <type>component.commerce_assets.editorialRichText</type>
        <data xml:lang="x-default">{ "richText" : "&lt;p&gt;Unrelated&lt;/p&gt;" }</data>
    </content>
</library>
`;
}

(async () => {
  const provider = () => new MockProvider({ protectedTerms: [] });
  const original = buildLibrary();
  const reduced = extractReducedLibrary(original, ['p1']).xml;
  const translated = await pageDesigner.translateXml(reduced, { targetLanguages: LANGS, provider: provider() });

  // ============================================================
  console.log('\nvalidate-pagedesigner — valid baseline');
  // ============================================================
  {
    const r = validate({ originalXml: original, translatedXml: translated, productIds: ['p1'], locales: LANGS });
    ok('valid baseline -> SAFE', r.verdict === VERDICT.SAFE, `verdict=${r.verdict} violations=${JSON.stringify(r.violations)}`);
    ok('no x-default mismatches', r.summary.xDefaultMismatchCount === 0, `count=${r.summary.xDefaultMismatchCount}`);
    ok('matched 3 blocks (p1 + specs + downloads)', r.summary.matchedContentCount === 3, `matched=${r.summary.matchedContentCount}`);
    ok('unrelated content not included', r.summary.unexpectedContentCount === 0);
  }

  // ============================================================
  console.log('\nvalidate-pagedesigner — wrong baseline');
  // ============================================================
  {
    // (a) x-default content differs before translation (spec value changed in the baseline).
    const wrongByContent = buildLibrary({ sizeValue: 'Micro ATX' });
    const r1 = validate({ originalXml: wrongByContent, translatedXml: translated, productIds: ['p1'], locales: LANGS });
    ok('x-default differs -> BASELINE_MISMATCH', r1.verdict === VERDICT.BASELINE_MISMATCH, `verdict=${r1.verdict}`);
    ok('x-default mismatch counted', r1.summary.xDefaultMismatchCount >= 1, `count=${r1.summary.xDefaultMismatchCount}`);
    ok('reason mentions x-default', r1.baselineReasons.some((x) => /x-default differs/.test(x)));

    // (b) a child content-id was renamed in the baseline (translated id not in original).
    const wrongById = buildLibrary({ downloadsId: 'p1-files' });
    const r2 = validate({ originalXml: wrongById, translatedXml: translated, productIds: ['p1'], locales: LANGS });
    ok('renamed child -> BASELINE_MISMATCH', r2.verdict === VERDICT.BASELINE_MISMATCH, `verdict=${r2.verdict}`);
    ok('translated-not-in-original counted', r2.summary.translatedNotInOriginalCount >= 1, `count=${r2.summary.translatedNotInOriginalCount}`);
    ok('reason mentions library may not match', r2.baselineReasons.some((x) => /may not match/.test(x)));
  }

  // ============================================================
  console.log('\nvalidate-pagedesigner — real breakage (correct baseline)');
  // ============================================================
  {
    // (a) content-links dropped from the page block -> structural violation.
    const brokenLinks = translated.replace(/<content-links>[\s\S]*?<\/content-links>/, '');
    const r1 = validate({ originalXml: original, translatedXml: brokenLinks, productIds: ['p1'], locales: LANGS });
    ok('dropped content-links -> NOT_SAFE', r1.verdict === VERDICT.NOT_SAFE, `verdict=${r1.verdict}`);
    ok('violation mentions structure/content-links', r1.violations.some((v) => /structure/.test(v)));

    // (b) a target-locale download URL changed -> URL violation (x-default left intact).
    const url = 'https://cm.example/dl/abc';
    const at = translated.lastIndexOf(url); // last occurrence is a target-locale <data>, not x-default
    const brokenUrl = translated.slice(0, at) + 'https://evil.example/x' + translated.slice(at + url.length);
    const r2 = validate({ originalXml: original, translatedXml: brokenUrl, productIds: ['p1'], locales: LANGS });
    ok('changed URL -> NOT_SAFE', r2.verdict === VERDICT.NOT_SAFE, `verdict=${r2.verdict}`);
    ok('violation mentions URL', r2.violations.some((v) => /URL/.test(v)));
    ok('URL breakage is NOT misclassified as baseline mismatch', r2.summary.xDefaultMismatchCount === 0);
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST RUN ERROR:', e);
  process.exit(1);
});
