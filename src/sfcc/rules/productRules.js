'use strict';

/**
 * Rules for the Product XML (SFCC catalog) translator.
 *
 * Structure handled:
 *   <catalog>
 *     <product>
 *       <short-description>
 *       <page-attributes>
 *         <page-title>
 *         <page-description>
 *       <custom-attributes>
 *         <custom-attribute attribute-id="subtitle">
 */
module.exports = {
  // Source-language priority when picking the value to translate from.
  sourceLangPriority: ['x-default', 'default', 'en-US'],

  // Fallback target languages (the UI normally supplies the actual list).
  defaultTargetLanguages: ['ja-JP', 'ko-KR', 'de-DE', 'fr-FR'],

  // Simple <tag xml:lang="..."> elements that get translated.
  translatableTags: ['short-description', 'page-title', 'page-description'],

  // Of the above, these may contain HTML and must keep their tags.
  htmlTags: ['short-description'],

  // Translatable <custom-attribute> ids.
  // Phase 2: emit subtitle as CDATA:
  //   <custom-attribute attribute-id="subtitle" xml:lang="ja-JP"><![CDATA[...]]></custom-attribute>
  customAttributes: [{ id: 'subtitle', cdata: true }],

  // Phase 2: enforce that all <page-title> precede all <page-description>
  // within <page-attributes> (no interleaving).
  pageAttributeOrder: ['page-title', 'page-description']
};
