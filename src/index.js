'use strict';

/**
 * Public API / orchestration layer.
 *
 * Ties the translator providers and the two SFCC translators together and
 * exposes a small surface the server (and any CLI) can call.
 */

const { GoogleTranslator } = require('./translators/googleTranslator');
const { ClaudeTranslator } = require('./translators/claudeTranslator');
const { normalizeTerms, DEFAULT_PROTECTED_TERMS } = require('./translators/protectedTerms');
const { detectXmlType } = require('./sfcc/xmlTypeDetector');
const productXmlTranslator = require('./sfcc/productXmlTranslator');
const pageDesignerXmlTranslator = require('./sfcc/pageDesignerXmlTranslator');
const { mergeProductXml, mergeLibraryXml } = require('./utils/xmlUtils');

/**
 * Build a translation provider by name.
 * @param {string} name - 'google' (default) or 'claude'
 * @param {{ protectedTerms?: string[] }} options
 */
function createProvider(name, options = {}) {
  const provider = (name || process.env.TRANSLATION_PROVIDER || 'google').toLowerCase();
  if (provider === 'claude') {
    return new ClaudeTranslator(options);
  }
  return new GoogleTranslator(options);
}

/** Normalize a UI xmlFormat / mode value to 'product' | 'page-designer'. */
function normalizeMode(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'product' || v === 'product-section' || v === 'product-xml') {
    return 'product';
  }
  if (v === 'page-designer' || v === 'page-designer-xml' || v === 'library') {
    return 'page-designer';
  }
  return null;
}

/**
 * Translate one XML string.
 * @param {string} xml
 * @param {{ mode?: string, targetLanguages?: string[], provider: object }} options
 */
async function translate(xml, options = {}) {
  const mode = normalizeMode(options.mode) || detectXmlType(xml);
  const opts = {
    targetLanguages: options.targetLanguages,
    provider: options.provider,
    reporter: options.reporter,
    force: options.force
  };
  if (mode === 'product') {
    return productXmlTranslator.translateXml(xml, opts);
  }
  return pageDesignerXmlTranslator.translateXml(xml, opts);
}

module.exports = {
  createProvider,
  translate,
  normalizeMode,
  normalizeTerms,
  detectXmlType,
  mergeProductXml,
  mergeLibraryXml,
  DEFAULT_PROTECTED_TERMS
};
