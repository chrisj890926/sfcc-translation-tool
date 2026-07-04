'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./index');
const logger = require('./utils/logger');
const { createJob, getJob, toStatus } = require('./jobs/jobStore');
const { runJob } = require('./jobs/runner');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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
});
