'use strict';

const engine = require('../index');
const { isWellFormedXml } = require('../utils/xmlUtils');
const { extractReducedLibrary } = require('../sfcc/pageExtractor');
const { extractReducedCatalog } = require('../sfcc/catalogExtractor');
const { toStatus } = require('./jobStore');
const logger = require('../utils/logger');

/** One-line token/cost summary for the logs (shows up in Railway Logs). */
function usageLine(job) {
  const s = toStatus(job);
  const ex = s.extraction ? ` reduced=${s.extraction.originalContentCount}->${s.extraction.reducedContentCount}` : '';
  return (
    `provider=${s.provider} model=${s.model} | ` +
    `translated=${s.translatedCount} skipped=${s.skippedCount} failed=${s.failedCount} | ` +
    `tokens in=${s.inputTokens} out=${s.outputTokens} | est cost=$${s.estimatedCost} | ` +
    `${s.elapsedSeconds}s files=${s.fileCount}${ex}`
  );
}

/**
 * Drives a translation job through the progress phases and updates the job's
 * live state as it goes. Runs detached from the HTTP request (fire-and-forget);
 * the browser polls GET /api/jobs/:id for progress and fetches the result when
 * the job completes.
 *
 * Business rules are unchanged — this only orchestrates the existing
 * engine.translate() / merge calls and reports progress around them.
 */

function countUnits(xml, mode) {
  const re = mode === 'product' ? /<product\b[\s\S]*?<\/product>/g : /<content\b[\s\S]*?<\/content>/g;
  return (xml.match(re) || []).length;
}

async function runJob(job, { files, mode, targetLanguages, provider, productIds, force, keepOnlyTargetLocales }) {
  try {
    job.status = 'running';
    job.fileCount = files.length;
    // Let the provider report token usage into this job.
    provider.reporter = job;

    job.setPhase('Reading XML');
    // File contents were already read from the request body by the caller.

    let workingFiles = files;

    // Reduce a full library / catalog to just the requested product subtrees
    // before translating — so we never send the whole multi-MB export to Claude.
    const ids = Array.isArray(productIds) ? productIds.map((s) => String(s).trim()).filter(Boolean) : [];
    if (ids.length > 0 && (mode === 'page-designer' || mode === 'product')) {
      const isProduct = mode === 'product';
      job.setPhase(isProduct ? 'Reducing Catalog' : 'Reducing Library');

      const reduced = [];
      const agg = {
        productIds: ids,
        originalContentCount: 0,
        reducedContentCount: 0,
        includedIds: [],
        includedTypes: new Set(),
        missingSeeds: [],
        missingRefs: []
      };
      const rootRe = isProduct ? /<catalog\b/ : /<library\b/;
      for (const f of workingFiles) {
        if (!rootRe.test(f.content)) {
          reduced.push(f); // not the expected root — leave untouched
          continue;
        }
        if (isProduct) {
          const { xml, stats } = extractReducedCatalog(f.content, ids);
          reduced.push({ name: f.name, content: xml });
          agg.originalContentCount += stats.originalCount;
          agg.reducedContentCount += stats.reducedCount;
          agg.includedIds.push(...stats.keptIds);
          agg.missingSeeds.push(...stats.missingSeeds);
        } else {
          const { xml, stats } = extractReducedLibrary(f.content, ids);
          reduced.push({ name: f.name, content: xml });
          agg.originalContentCount += stats.originalContentCount;
          agg.reducedContentCount += stats.reducedContentCount;
          agg.includedIds.push(...stats.includedIds);
          stats.includedTypes.forEach((t) => agg.includedTypes.add(t));
          agg.missingSeeds.push(...stats.missingSeeds);
          agg.missingRefs.push(...stats.missingRefs);
        }
      }
      workingFiles = reduced;
      job.setExtraction({
        label: isProduct ? 'Catalog reduced' : 'Library reduced',
        unit: isProduct ? 'products' : 'content blocks',
        productIds: agg.productIds,
        originalContentCount: agg.originalContentCount,
        reducedContentCount: agg.reducedContentCount,
        includedIds: agg.includedIds,
        includedTypes: [...agg.includedTypes].sort(),
        missingSeeds: [...new Set(agg.missingSeeds)],
        missingRefs: [...new Set(agg.missingRefs)]
      });
      logger.info(
        `[Job] reduced ${isProduct ? 'catalog' : 'library'} ${agg.originalContentCount} -> ${agg.reducedContentCount} ` +
          `${isProduct ? 'products' : 'content blocks'} for [${ids.join(', ')}]`
      );
    }

    const files2 = workingFiles;

    const scanPhase = mode === 'product' ? 'Scanning Products' : 'Scanning Components';

    job.setPhase(scanPhase);
    const total = files2.reduce((sum, f) => sum + countUnits(f.content, mode), 0);
    job.setTotalUnits(total);

    job.setPhase('Preparing Translation');

    job.setPhase('Translating');
    const translated = await Promise.all(
      files2.map((f) =>
        engine.translate(f.content, { mode, targetLanguages, provider, reporter: job, force, keepOnlyTargetLocales })
      )
    );

    job.setPhase('Writing XML');
    let finalXml;
    if (translated.length > 1) {
      finalXml = mode === 'product' ? engine.mergeProductXml(translated) : engine.mergeLibraryXml(translated);
    } else {
      finalXml = translated[0];
    }

    job.setPhase('Validating XML');
    if (!isWellFormedXml(finalXml)) {
      logger.warn('[Job] merged output failed well-formedness check.');
    }

    job.resultXml = finalXml;
    job.setPhase('Completed');
    job.status = 'completed';
    job.endTime = Date.now();
    logger.info(`[Job] ${job.id} completed | ${usageLine(job)}`);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || 'Translation failed.';
    job.endTime = Date.now();
    logger.error(`[Job] ${job.id} FAILED: ${job.error} | ${usageLine(job)}`);
  }
}

module.exports = { runJob };
