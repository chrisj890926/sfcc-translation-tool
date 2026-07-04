'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./index');
const logger = require('./utils/logger');
const { createJob, getJob, toStatus } = require('./jobs/jobStore');
const { runJob } = require('./jobs/runner');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Cost safety guard: without Product IDs the whole file is translated. Block
// uploads that look like a full catalog / library (many products / content
// blocks) so nobody accidentally translates the entire export.
const MAX_PRODUCTS_WITHOUT_IDS = 50;
const MAX_CONTENT_WITHOUT_IDS = 200;
const COST_GUARD_MESSAGE =
  'Product IDs is required for large full-catalog/library uploads to prevent accidental high API cost.';

/** Count actual product / content nodes across the uploaded files. */
function countNodes(files) {
  let products = 0;
  let contents = 0;
  for (const f of files) {
    const c = (f && f.content) || '';
    products += (c.match(/<product product-id="/g) || []).length;
    contents += (c.match(/<content content-id="/g) || []).length;
  }
  return { products, contents };
}

// ---------------------------------------------------------------------------
// Optional HTTP Basic Auth.
//
// Enabled only when APP_PASSWORD is set (so local development stays open).
// Username defaults to "admin" if APP_USERNAME is not set. /healthz is always
// open for platform health checks. Credentials are never logged or echoed.
// ---------------------------------------------------------------------------
const AUTH_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_USERNAME = process.env.APP_USERNAME || 'admin';
const AUTH_ENABLED = AUTH_PASSWORD !== '';

/** Constant-time string comparison (guards against timing attacks). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** True if the request may proceed. When auth is disabled, always true. */
function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.authorization || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return false;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  // Evaluate both before AND-ing so a matching username can't be inferred by timing.
  const okUser = safeEqual(user, AUTH_USERNAME);
  const okPass = safeEqual(pass, AUTH_PASSWORD);
  return okUser && okPass;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.json': 'application/json'
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
  const absPath = path.join(PUBLIC_DIR, filePath);

  // Prevent directory traversal.
  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
    }
    const ext = path.extname(absPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
    res.end(data);
  });
}

/**
 * POST /api/translate — creates a background job and returns { jobId }.
 * Translation runs detached; the browser polls GET /api/jobs/:jobId.
 */
function handleTranslate(req, res) {
  let bodyStr = '';
  req.on('data', (chunk) => {
    bodyStr += chunk.toString();
  });
  req.on('end', () => {
    try {
      const body = JSON.parse(bodyStr);

      // Mode: prefer explicit `mode`, fall back to legacy `xmlFormat`.
      const mode = engine.normalizeMode(body.mode || body.xmlFormat) || 'page-designer';

      const targetLanguages =
        Array.isArray(body.targetLanguages) && body.targetLanguages.length > 0
          ? body.targetLanguages
          : undefined;

      const protectedTerms = engine.normalizeTerms(body.protectedTerms);
      const providerName = body.provider || process.env.TRANSLATION_PROVIDER || 'google';

      // Optional product ids for full-library reduction (Page Designer).
      // Accept an array or a comma/whitespace-separated string.
      let productIds = [];
      if (Array.isArray(body.productIds)) {
        productIds = body.productIds;
      } else if (typeof body.productIds === 'string') {
        productIds = body.productIds.split(/[\s,]+/);
      }
      productIds = productIds.map((s) => String(s).trim()).filter(Boolean);

      // Share one provider (and its cache) across all files in the request.
      const provider = engine.createProvider(providerName, { protectedTerms });

      // Normalize input: single xmlContent or multi xmlContents.
      let files = [];
      if (Array.isArray(body.xmlContents) && body.xmlContents.length > 0) {
        files = body.xmlContents; // [{ name, content }]
      } else if (body.xmlContent) {
        files = [{ name: 'file.xml', content: body.xmlContent }];
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No XML content provided.' }));
      }

      // Cost safety guard — no Product IDs means the whole file is translated.
      if (productIds.length === 0) {
        const { products, contents } = countNodes(files);
        if (products > MAX_PRODUCTS_WITHOUT_IDS || contents > MAX_CONTENT_WITHOUT_IDS) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              error: COST_GUARD_MESSAGE,
              detail: `Detected ${products} products / ${contents} content blocks. Enter the Product IDs to extract, or split the file into smaller uploads.`
            })
          );
        }
      }

      const model = provider.model || (providerName === 'claude' ? 'claude-opus-4-8' : 'google');
      const job = createJob({ provider: providerName, model });

      // Fire-and-forget — the browser tracks progress via the jobs endpoints.
      runJob(job, { files, mode, targetLanguages, provider, productIds });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: job.id }));
    } catch (error) {
      logger.error('Translation error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'An error occurred during translation.' }));
    }
  });
}

/**
 * GET /api/jobs/:jobId          -> live status JSON
 * GET /api/jobs/:jobId/result   -> merged translated XML (once completed)
 */
function handleJob(req, res, urlPath) {
  const rest = urlPath.slice('/api/jobs/'.length);
  const [jobId, sub] = rest.split('/');
  const job = getJob(jobId);

  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Job not found.' }));
  }

  if (sub === 'result') {
    if (job.status !== 'completed' || job.resultXml == null) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Job is not completed (status: ${job.status}).` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(job.resultXml);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(toStatus(job)));
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '').split('?')[0];

  // Health check — always open (platform probes), no auth, no secrets.
  if (req.method === 'GET' && urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  // Basic Auth gate — protects every other route when APP_PASSWORD is set.
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="SFCC XML Translator", charset="UTF-8"',
      'Content-Type': 'text/plain'
    });
    return res.end('Authentication required.');
  }

  if (req.method === 'POST' && urlPath === '/api/translate') {
    return handleTranslate(req, res);
  }
  if (req.method === 'GET' && urlPath.startsWith('/api/jobs/')) {
    return handleJob(req, res, urlPath);
  }
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  logger.info(`Server is running at http://localhost:${PORT}`);
  logger.info(`Basic Auth: ${AUTH_ENABLED ? `enabled (user "${AUTH_USERNAME}")` : 'disabled (set APP_PASSWORD to enable)'}`);
});
