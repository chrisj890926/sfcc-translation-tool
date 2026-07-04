'use strict';

/**
 * Zero-dependency test runner for the Phase 2 business rules.
 * Uses a mock translation provider (no network) so tests are deterministic.
 *
 * Run: npm test
 */

const path = require('path');
const { TranslationProvider } = require('../src/translators/baseTranslator');
const productXml = require('../src/sfcc/productXmlTranslator');
const pageDesigner = require('../src/sfcc/pageDesignerXmlTranslator');
const { isWellFormedXml, decodeXmlEntities } = require('../src/utils/xmlUtils');

// ---- tiny assert harness ----
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

// Mock provider: prefixes text with the locale so we can assert it was touched,
// while still exercising the base protection + HTML handling.
class MockProvider extends TranslationProvider {
  async _translateRawBatch(items, locale) {
    const out = {};
    for (const it of items) out[it.id] = `[${locale}] ${it.text}`;
    return out;
  }
}

const LANGS = ['ja-JP', 'de-DE', 'fr-FR', 'ko-KR'];
const provider = () => new MockProvider({ protectedTerms: ['Cooler Master', 'OVP'] });

/** Extract the JSON object from a <data xml:lang="LANG"> block (decoding entities). */
function dataJson(xml, lang) {
  const re = new RegExp(`<data xml:lang="${lang}">([\\s\\S]*?)</data>`);
  const m = xml.match(re);
  if (!m) return null;
  return JSON.parse(decodeXmlEntities(m[1]));
}

(async () => {
  // ============================================================
  console.log('\nProduct XML — subtitle (custom-attribute + CDATA)');
  // ============================================================
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31" catalog-id="cm">
  <product product-id="V550">
    <custom-attributes>
      <custom-attribute attribute-id="subtitle" xml:lang="x-default">Reliable &amp; quiet</custom-attribute>
      <custom-attribute attribute-id="brand">Cooler Master</custom-attribute>
    </custom-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: LANGS, provider: provider() });

    for (const lang of LANGS) {
      const re = new RegExp(
        `<custom-attribute attribute-id="subtitle" xml:lang="${lang}"><!\\[CDATA\\[\\[${lang}\\] Reliable & quiet\\]\\]></custom-attribute>`
      );
      ok(`subtitle ${lang} emitted as CDATA + translated`, re.test(out), 'missing/incorrect CDATA tag');
    }
    ok('subtitle output is well-formed XML', isWellFormedXml(out));
    ok('non-translatable custom-attribute untouched', out.includes('<custom-attribute attribute-id="brand">Cooler Master</custom-attribute>'));
    ok('& handled inside CDATA (raw, not entity)', out.includes('Reliable & quiet]]>'));
  }

  // subtitle: skip if target exists, skip if source empty
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog catalog-id="cm">
  <product product-id="P1">
    <custom-attributes>
      <custom-attribute attribute-id="subtitle" xml:lang="x-default">Hello</custom-attribute>
      <custom-attribute attribute-id="subtitle" xml:lang="ja-JP"><![CDATA[既存]]></custom-attribute>
    </custom-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: ['ja-JP', 'de-DE'], provider: provider() });
    const jaCount = (out.match(/attribute-id="subtitle" xml:lang="ja-JP"/g) || []).length;
    ok('subtitle skips existing target locale (no overwrite/dup)', jaCount === 1, `ja-JP count=${jaCount}`);
    ok('subtitle keeps existing translation content', out.includes('<![CDATA[既存]]>'));
    ok('subtitle still adds missing locale (de-DE)', /attribute-id="subtitle" xml:lang="de-DE"/.test(out));
  }
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog catalog-id="cm">
  <product product-id="P2">
    <custom-attributes>
      <custom-attribute attribute-id="subtitle" xml:lang="x-default">   </custom-attribute>
    </custom-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: ['ja-JP'], provider: provider() });
    ok('subtitle skips empty source', !/attribute-id="subtitle" xml:lang="ja-JP"/.test(out));
  }

  // ============================================================
  console.log('\nProduct XML — page-attributes ordering (never interleave)');
  // ============================================================
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog catalog-id="cm">
  <product product-id="P3">
    <page-attributes>
      <page-title xml:lang="x-default">Title</page-title>
      <page-description xml:lang="x-default">Desc</page-description>
    </page-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: LANGS, provider: provider() });
    const inner = out.match(/<page-attributes>([\s\S]*?)<\/page-attributes>/)[1];
    const seq = (inner.match(/<page-(title|description)\b/g) || []).map((s) => s.includes('title') ? 'T' : 'D').join('');
    // All titles (1 source + 4 langs) then all descriptions (1 + 4).
    ok('all page-title precede all page-description', /^T+D+$/.test(seq), `sequence=${seq}`);
    ok('correct counts (5 titles, 5 descriptions)', seq === 'TTTTTDDDDD', `sequence=${seq}`);
    ok('page-attributes output well-formed', isWellFormedXml(out));
  }
  // ordering guaranteed even when a stray translation sits after the description
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog catalog-id="cm">
  <product product-id="P4">
    <page-attributes>
      <page-title xml:lang="x-default">T</page-title>
      <page-description xml:lang="x-default">D</page-description>
      <page-title xml:lang="fr-FR">Titre</page-title>
    </page-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: ['fr-FR'], provider: provider() });
    const inner = out.match(/<page-attributes>([\s\S]*?)<\/page-attributes>/)[1];
    const seq = (inner.match(/<page-(title|description)\b/g) || []).map((s) => s.includes('title') ? 'T' : 'D').join('');
    ok('stray title reordered before descriptions', /^T+D+$/.test(seq), `sequence=${seq}`);
  }

  // ============================================================
  console.log('\nProduct XML — fallback overwrite (create / overwrite / preserve)');
  // ============================================================
  {
    // One product exercising all three outcomes across all four fields:
    //   ja-JP short-desc       : English fallback (differs from x-default) -> overwrite
    //   de-DE short-desc       : genuine German                            -> preserve
    //   ja-JP page-title       : identical to x-default                    -> overwrite
    //   ko-KR page-title       : genuine Korean                            -> preserve
    //   fr-FR page-description : English fallback (differs)                -> overwrite
    //   ja-JP page-description : genuine Japanese                          -> preserve
    //   ko-KR subtitle         : identical to x-default                    -> overwrite (CDATA)
    //   fr-FR subtitle         : genuine French                            -> preserve
    // Target locales absent for a field (e.g. fr-FR/ko-KR short-desc) are created.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31" catalog-id="cm">
  <product product-id="FB1">
    <short-description xml:lang="x-default">&lt;p&gt;Active PFC Design&lt;/p&gt;</short-description>
    <short-description xml:lang="ja-JP">&lt;p&gt;Old English blurb about the design&lt;/p&gt;</short-description>
    <short-description xml:lang="de-DE">&lt;p&gt;Aktives PFC-Design für höchste Zuverlässigkeit und Effizienz&lt;/p&gt;</short-description>
    <page-attributes>
      <page-title xml:lang="x-default">Entry Level PSU</page-title>
      <page-title xml:lang="ja-JP">Entry Level PSU</page-title>
      <page-title xml:lang="ko-KR">엔트리 레벨 PSU</page-title>
      <page-description xml:lang="x-default">A dependable choice for entry level users.</page-description>
      <page-description xml:lang="fr-FR">The unit that was never localized here.</page-description>
      <page-description xml:lang="ja-JP">信頼できる選択肢です。</page-description>
    </page-attributes>
    <custom-attributes>
      <custom-attribute attribute-id="subtitle" xml:lang="x-default">Quiet Power</custom-attribute>
      <custom-attribute attribute-id="subtitle" xml:lang="ko-KR">Quiet Power</custom-attribute>
      <custom-attribute attribute-id="subtitle" xml:lang="fr-FR"><![CDATA[Alimentation silencieuse et fiable]]></custom-attribute>
    </custom-attributes>
  </product>
</catalog>`;
    const out = await productXml.translateXml(xml, { targetLanguages: LANGS, provider: provider() });

    // Inner content of the (single) <tag ...xml:lang="lang"> element.
    const content = (tag, lang, extra = '') => {
      const a = extra ? `${extra} ` : '';
      const m = out.match(new RegExp(`<${tag} ${a}xml:lang="${lang}">([\\s\\S]*?)</${tag}>`));
      return m ? m[1] : null;
    };
    const tagCount = (tag, lang, extra = '') => {
      const a = extra ? `${extra} ` : '';
      return (out.match(new RegExp(`<${tag} ${a}xml:lang="${lang}"`, 'g')) || []).length;
    };

    // (1) English fallback that differs from x-default -> overwritten with a translation of x-default.
    ok('short-description ja-JP English fallback overwritten',
      content('short-description', 'ja-JP') === '&lt;p&gt;[ja-JP] Active PFC Design&lt;/p&gt;',
      content('short-description', 'ja-JP'));
    ok('page-description fr-FR English fallback overwritten',
      content('page-description', 'fr-FR') === '[fr-FR] A dependable choice for entry level users.',
      content('page-description', 'fr-FR'));

    // (2) Value identical to x-default -> overwritten with a translation.
    ok('page-title ja-JP (identical to x-default) overwritten',
      content('page-title', 'ja-JP') === '[ja-JP] Entry Level PSU',
      content('page-title', 'ja-JP'));
    ok('subtitle ko-KR (identical to x-default) overwritten as CDATA',
      content('custom-attribute', 'ko-KR', 'attribute-id="subtitle"') === '<![CDATA[[ko-KR] Quiet Power]]>',
      content('custom-attribute', 'ko-KR', 'attribute-id="subtitle"'));

    // (3) Genuine localized content -> preserved untouched (no [locale] prefix from the mock).
    ok('short-description de-DE genuine German preserved',
      content('short-description', 'de-DE') === '&lt;p&gt;Aktives PFC-Design für höchste Zuverlässigkeit und Effizienz&lt;/p&gt;',
      content('short-description', 'de-DE'));
    ok('page-title ko-KR genuine Korean preserved',
      content('page-title', 'ko-KR') === '엔트리 레벨 PSU', content('page-title', 'ko-KR'));
    ok('page-description ja-JP genuine Japanese preserved',
      content('page-description', 'ja-JP') === '信頼できる選択肢です。', content('page-description', 'ja-JP'));
    ok('subtitle fr-FR genuine French preserved',
      content('custom-attribute', 'fr-FR', 'attribute-id="subtitle"') === '<![CDATA[Alimentation silencieuse et fiable]]>',
      content('custom-attribute', 'fr-FR', 'attribute-id="subtitle"'));
    ok('preserved values never carry the mock [locale] prefix',
      !/\[de-DE\]/.test(content('short-description', 'de-DE') || '') &&
      !/\[ko-KR\]/.test(content('page-title', 'ko-KR') || '') &&
      !/\[ja-JP\]/.test(content('page-description', 'ja-JP') || '') &&
      !/\[fr-FR\]/.test(content('custom-attribute', 'fr-FR', 'attribute-id="subtitle"') || ''));

    // (4)+(5) All four fields, exactly one tag per target locale (overwrite in place, no duplicates).
    let noDup = true;
    const dupDetail = [];
    for (const lang of LANGS) {
      for (const tag of ['short-description', 'page-title', 'page-description']) {
        const c = tagCount(tag, lang);
        if (c !== 1) { noDup = false; dupDetail.push(`${tag} ${lang}=${c}`); }
      }
      const cs = tagCount('custom-attribute', lang, 'attribute-id="subtitle"');
      if (cs !== 1) { noDup = false; dupDetail.push(`subtitle ${lang}=${cs}`); }
    }
    ok('exactly one tag per target locale for all four fields (no duplicates)', noDup, dupDetail.join(', '));

    // Missing target locales are still created + translated (unchanged behavior).
    ok('missing locale still created & translated',
      content('short-description', 'fr-FR') === '&lt;p&gt;[fr-FR] Active PFC Design&lt;/p&gt;',
      content('short-description', 'fr-FR'));

    ok('fallback-overwrite output well-formed XML', isWellFormedXml(out));
  }

  // ============================================================
  console.log('\nPage Designer XML — cmDownloadFiles');
  // ============================================================
  {
    const filesValue = JSON.stringify([
      { displayName: 'Product Sheet', value: 'https://cm.example/dl/abc?a=1&b=2' },
      { displayName: 'Manual', value: 'https://cm.example/dl/def' }
    ]);
    const dataObj = { files_to_download: { value: filesValue } }; // no title -> auto-generate
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<library library-id="cm-global">
  <content content-id="dl1">
    <type>component.commerce_assets.cmDownloadFiles</type>
    <data xml:lang="x-default">${JSON.stringify(dataObj)}</data>
  </content>
</library>`;
    const out = await pageDesigner.translateXml(xml, { targetLanguages: LANGS, provider: provider() });

    ok('output well-formed XML', isWellFormedXml(out));

    const expectTitle = { 'ja-JP': 'ダウンロード', 'de-DE': 'Downloads', 'fr-FR': 'Téléchargements', 'ko-KR': '다운로드' };
    for (const lang of LANGS) {
      const obj = dataJson(out, lang);
      ok(`${lang}: generated localized title`, obj && obj.title === expectTitle[lang], obj ? `title=${obj.title}` : 'no data');

      // files_to_download.value is a JSON string and must re-parse.
      let items = null;
      try { items = JSON.parse(obj.files_to_download.value); } catch (e) { /* items stays null */ }
      ok(`${lang}: files_to_download.value is valid JSON`, Array.isArray(items) && items.length === 2);

      if (Array.isArray(items)) {
        ok(`${lang}: displayName translated`, items[0].displayName === `[${lang}] Product Sheet`);
        ok(`${lang}: URL (with &) preserved exactly`, items[0].value === 'https://cm.example/dl/abc?a=1&b=2');
        ok(`${lang}: 2nd URL preserved`, items[1].value === 'https://cm.example/dl/def');
      }
    }
  }

  // cmDownloadFiles WITH an existing x-default title -> translate it, do not overwrite with auto title
  {
    const dataObj = { title: 'Downloads Center', files_to_download: { value: JSON.stringify([{ displayName: 'Spec', value: 'https://x/y' }]) } };
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<library library-id="cm">
  <content content-id="dl2">
    <type>component.commerce_assets.cmDownloadFiles</type>
    <data xml:lang="x-default">${JSON.stringify(dataObj)}</data>
  </content>
</library>`;
    const out = await pageDesigner.translateXml(xml, { targetLanguages: ['ja-JP'], provider: provider() });
    const obj = dataJson(out, 'ja-JP');
    ok('existing x-default title is translated (not replaced by auto title)', obj && obj.title === '[ja-JP] Downloads Center', obj ? `title=${obj.title}` : 'no data');
  }

  // ============================================================
  console.log('\nJSON validation & double-encoding');
  // ============================================================
  {
    // Field containing &amp; must be single-encoded (no &amp;amp;) after clone.
    const dataObj = { title: 'Support & Care', body: 'x' };
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<library library-id="cm">
  <content content-id="e1">
    <type>component.commerce_assets.cmHero</type>
    <data xml:lang="x-default">${JSON.stringify(dataObj).replace(/&/g, '&amp;')}</data>
  </content>
</library>`;
    const out = await pageDesigner.translateXml(xml, { targetLanguages: ['ja-JP'], provider: provider() });
    ok('no double-encoded &amp;amp; in output', !out.includes('&amp;amp;'));
    const obj = dataJson(out, 'ja-JP');
    ok('title round-trips with a single & after decode', obj && obj.title === '[ja-JP] Support & Care', obj ? `title=${obj.title}` : 'no data');
    ok('output well-formed XML', isWellFormedXml(out));
  }

  // isWellFormedXml sanity
  {
    ok('isWellFormedXml: valid doc', isWellFormedXml('<a><b>hi</b><c/></a>'));
    ok('isWellFormedXml: mismatched tag -> false', !isWellFormedXml('<a><b></a>'));
    ok('isWellFormedXml: stray angle bracket -> false', !isWellFormedXml('<a>1 < 2</a>'));
    ok('isWellFormedXml: CDATA with < tolerated', isWellFormedXml('<a><![CDATA[1 < 2 & 3]]></a>'));
  }

  // ============================================================
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST RUN ERROR:', e);
  process.exit(1);
});
