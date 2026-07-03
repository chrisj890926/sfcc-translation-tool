'use strict';

/**
 * JSON helpers shared across the SFCC translators.
 */

function deepClone(input) {
  return JSON.parse(JSON.stringify(input));
}

/**
 * Parse JSON without throwing. Returns { ok, value }.
 * Used for validation (Page Designer <data> JSON, files_to_download.value, etc.).
 */
function tryParse(str) {
  if (typeof str !== 'string') {
    return { ok: false, value: null };
  }
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

module.exports = { deepClone, tryParse };
