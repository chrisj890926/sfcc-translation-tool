'use strict';

const { escapeRegExp } = require('../utils/xmlUtils');

/**
 * Terms that must never be translated. Product model names, technical
 * abbreviations, standards and brand names. These are protected with
 * placeholders (OVP -> __TERM_1__) before translation and restored afterwards.
 *
 * Users can add more via the UI ("Protected Terms") or the PROTECTED_TERMS env var.
 */
const DEFAULT_PROTECTED_TERMS = [
  // Standards / spec abbreviations (longest first is handled at protect() time)
  'ErP 2014 Lot 3',
  '80 PLUS Platinum',
  '80 PLUS Gold',
  '80 PLUS',
  '12V-2x6',
  '12VHPWR',
  'PFC',
  'MTBF',
  'OVP',
  'OPP',
  'SCP',
  'UVP',
  'OTP',
  'OCP',
  'ATX',
  'PCIe',
  'PCI-E',
  'SATA',
  'EPS',
  'FDB',
  'STCM',
  'PSU',
  'RTX',
  // Brand
  'Cooler Master',
  // Example product models (extend as needed)
  'V550 Gold',
  'Elite 334U',
  'Devastator 3 Plus'
];

/**
 * Normalize a protected-terms input into an array.
 * Accepts an array, a comma-separated string, or falsy (-> defaults + env).
 */
function normalizeTerms(input) {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof input === 'string' && input.trim() !== '') {
    return input.split(',').map((t) => t.trim()).filter(Boolean);
  }
  const envTerms = (process.env.PROTECTED_TERMS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_PROTECTED_TERMS, ...envTerms])];
}

/**
 * Replace protected content (emails, URLs, then protected terms) with
 * placeholders so the translation API leaves them untouched.
 * Returns { text, tokenMap } — feed tokenMap into restore().
 */
function protect(text, terms = []) {
  if (typeof text !== 'string' || text === '') {
    return { text, tokenMap: [] };
  }

  let result = text;
  const tokenMap = [];
  let counter = 0;

  const mask = (regex) => {
    result = result.replace(regex, (match) => {
      if (!match) return match;
      const token = `__TERM_${counter}__`;
      tokenMap.push({ token, value: match });
      counter += 1;
      return token;
    });
  };

  // Order matters: emails and URLs first, then terms longest-first so that
  // "80 PLUS Gold" wins over "80 PLUS".
  mask(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g);
  mask(/https?:\/\/[^\s"'<>]+/g);

  const sortedTerms = [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const term of sortedTerms) {
    mask(new RegExp(escapeRegExp(term), 'g'));
  }

  return { text: result, tokenMap };
}

/** Restore placeholders produced by protect(). */
function restore(text, tokenMap = []) {
  if (typeof text !== 'string') {
    return text;
  }
  let out = text;
  // Restore in reverse insertion order.
  for (let i = tokenMap.length - 1; i >= 0; i -= 1) {
    const { token, value } = tokenMap[i];
    out = out.split(token).join(value);
  }
  return out;
}

module.exports = {
  DEFAULT_PROTECTED_TERMS,
  normalizeTerms,
  protect,
  restore
};
