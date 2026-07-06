'use strict';

/**
 * Rules for the Page Designer XML (SFCC library) translator.
 *
 * Structure handled:
 *   <library library-id="...">
 *     <content content-id="...">
 *       <type>component.xxx</type>
 *       <data xml:lang="x-default">JSON...</data>
 */
module.exports = {
  // The <data> we translate from.
  sourceLang: 'x-default',

  // Fallback target languages (the UI normally supplies the actual list).
  defaultTargetLanguages: ['ja-JP', 'ko-KR', 'de-DE', 'fr-FR'],

  // JSON keys whose string values are natural language and may be translated.
  translatableKeys: [
    'title',
    'title_xl',
    'title_l',
    'title_m',
    'title_s',
    'displayName',
    'headline',
    'description',
    'subtitle',
    'pretitle',
    'label',
    'cta',
    'buttonText',
    'primaryButtonTitle',
    'secondaryButtonTitle',
    'html_content',
    'richText',
    'bodyMarkup'
  ],

  // Of the above, these contain HTML and are translated tag-aware.
  htmlKeys: ['html_content', 'richText', 'description', 'bodyMarkup'],

  // Keys that must never be translated (ids, urls, models, skus, ...).
  // Documented here for phase 2; the translator uses the translatable whitelist
  // above, so these are already left untouched.
  nonTranslatableKeys: [
    'url',
    'productId',
    'product_id',
    'content-id',
    'folder-id',
    'attribute-id',
    'model',
    'sku',
    'fileUrl',
    'id'
  ],

  // Component types that are pure layout — skipped entirely.
  skipTypes: [
    'component.commerce_layouts.cmblock2col',
    'component.commerce_layouts.cmblock1col',
    'component.commerce_layouts.cmblock3col',
    'component.commerce_layouts.mobileGrid1r1c',
    'component.commerce_layouts.cmBoxLayout',
    'component.commerce_assets.photoTile',
    'component.commerce_assets.cmContactForm',
    'component.commerce_layouts.cmCustomGrid',
    'component.commerce_assets.cmGridCard',
    'component.commerce_layouts.cmblockcolumnslider'
  ],

  // Special component types with bespoke handling.
  components: {
    cmRepeater: 'component.commerce_assets.cmRepeater',
    cmDownloadFiles: 'component.commerce_assets.cmDownloadFiles'
  },

  // Phase 2: cmDownloadFiles auto-title per language.
  downloadTitleByLang: {
    'ja-JP': 'ダウンロード',
    'de-DE': 'Downloads',
    'fr-FR': 'Téléchargements',
    'ko-KR': '다운로드',
    'it-IT': 'Download',
    'nl-NL': 'Downloads',
    es: 'Descargas',
    'id-ID': 'Unduhan',
    'pt-BR': 'Downloads',
    'th-TH': 'ดาวน์โหลด',
    'vi-VN': 'Tải xuống',
    'zh-TW': '下載'
  }
};
