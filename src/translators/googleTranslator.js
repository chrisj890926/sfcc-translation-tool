'use strict';

const https = require('https');
const { TranslationProvider } = require('./baseTranslator');
const logger = require('../utils/logger');

/**
 * GoogleTranslator — the default provider. Uses the free, unofficial Google
 * Translate endpoint (no API key). This is the original translation engine,
 * refactored behind the TranslationProvider interface.
 */

// SFCC uses hyphenated locales (ja-JP); Google wants short codes (ja).
const LANG_TO_TRANSLATE_CODE = {
  'de-DE': 'de',
  'fr-FR': 'fr',
  'it-IT': 'it',
  'nl-NL': 'nl',
  es: 'es',
  'id-ID': 'id',
  'ja-JP': 'ja',
  'ko-KR': 'ko',
  'pt-BR': 'pt',
  'th-TH': 'th',
  'vi-VN': 'vi',
  'zh-TW': 'zh-TW'
};

// Cap concurrent calls to the endpoint across the whole process.
const MAX_CONCURRENT_API_CALLS = 5;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.current -= 1;
    if (this.queue.length > 0) {
      this.current += 1;
      const next = this.queue.shift();
      next();
    }
  }
}

const API_SEMAPHORE = new Semaphore(MAX_CONCURRENT_API_CALLS);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          completed = true;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Translation request failed with status ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Invalid translation response: ${error.message}`));
          }
        });
      }
    );
    request.on('error', (error) => reject(error));
    request.setTimeout(15000, () => {
      if (!completed) {
        request.destroy(new Error('Translation request timeout after 15s'));
      }
    });
    request.end();
  });
}

function buildEndpoint(code, text) {
  return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
    code
  )}&dt=t&q=${encodeURIComponent(text)}`;
}

function joinTranslation(response, fallback) {
  return Array.isArray(response && response[0])
    ? response[0].map((part) => (Array.isArray(part) ? part[0] : '')).join('')
    : fallback;
}

class GoogleTranslator extends TranslationProvider {
  async _translateRawBatch(items, targetLocale) {
    const code = LANG_TO_TRANSLATE_CODE[targetLocale] || targetLocale;
    const entries = await Promise.all(
      items.map(async (item) => {
        const translated = await this._translateOne(item.text, code);
        return [item.id, translated];
      })
    );
    return Object.fromEntries(entries);
  }

  /** Translate one (already protected) string, with retry + sentence-split fallback. */
  async _translateOne(text, code) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await API_SEMAPHORE.acquire();
        let response;
        try {
          response = await httpGetJson(buildEndpoint(code, text));
        } finally {
          API_SEMAPHORE.release();
        }
        return joinTranslation(response, text);
      } catch (error) {
        if (attempt === 3) {
          logger.warn(`[Translation Failed] targetLang=${code}, text="${text.substring(0, 40)}...": ${error.message}`);
          // Long text: split into sentences and translate piecewise.
          if (text.length > 120) {
            const parts = text.split(/([.!?。！？]\s+)/).filter((part) => part !== '');
            if (parts.length > 1) {
              const translatedParts = [];
              for (const part of parts) {
                if (!part.trim()) {
                  translatedParts.push(part);
                  continue;
                }
                try {
                  await API_SEMAPHORE.acquire();
                  let partResponse;
                  try {
                    partResponse = await httpGetJson(buildEndpoint(code, part));
                  } finally {
                    API_SEMAPHORE.release();
                  }
                  translatedParts.push(joinTranslation(partResponse, part));
                } catch (partError) {
                  logger.warn(`[Sub-Translation Failed] targetLang=${code}: ${partError.message}`);
                  translatedParts.push(part);
                }
              }
              return translatedParts.join('');
            }
          }
          return text; // keep original on total failure
        }
        await delay(250 * attempt);
      }
    }
    return text;
  }
}

module.exports = { GoogleTranslator, LANG_TO_TRANSLATE_CODE };
