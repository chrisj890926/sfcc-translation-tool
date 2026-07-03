'use strict';

/**
 * Detect which SFCC XML format a string is, so the backend can pick a translator
 * when the caller doesn't send an explicit mode.
 *
 * Returns 'product' for <catalog> documents, 'page-designer' for <library>.
 * Defaults to 'page-designer'.
 */
function detectXmlType(xml) {
  if (typeof xml !== 'string') {
    return 'page-designer';
  }
  if (/<catalog\b/.test(xml)) {
    return 'product';
  }
  if (/<library\b/.test(xml)) {
    return 'page-designer';
  }
  // Heuristic fallback: a <product> block without a catalog wrapper.
  if (/<product\b/.test(xml) && !/<content\b/.test(xml)) {
    return 'product';
  }
  return 'page-designer';
}

module.exports = { detectXmlType };
