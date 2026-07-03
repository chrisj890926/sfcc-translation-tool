'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./index');
const logger = require('./utils/logger');

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

async function handleTranslate(req, res) {
  let bodyStr = '';
  req.on('data', (chunk) => {
    bodyStr += chunk.toString();
  });
  req.on('end', async () => {
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

      const translated = await Promise.all(
        files.map((file) => engine.translate(file.content, { mode, targetLanguages, provider }))
      );

      let finalXml;
      if (translated.length > 1) {
        finalXml = mode === 'product' ? engine.mergeProductXml(translated) : engine.mergeLibraryXml(translated);
      } else {
        finalXml = translated[0];
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ xmlContent: finalXml, fileCount: files.length }));
    } catch (error) {
      logger.error('Translation error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'An error occurred during translation.' }));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }
  if (req.method === 'POST' && req.url === '/api/translate') {
    return handleTranslate(req, res);
  }
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  logger.info(`Server is running at http://localhost:${PORT}`);
});
