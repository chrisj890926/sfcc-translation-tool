'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * In-memory job store for background translation jobs.
 *
 * Each job carries live progress state that the SFCC translators and the Claude
 * provider update through the reporter interface (setPhase / setComponent /
 * addTranslated / addUsage / ...). GET /api/jobs/:id renders toStatus(job).
 */

// USD per 1,000,000 tokens. Source: Claude API model pricing.
const PRICING = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

// Ordered progress phases. "Translating" spans a range and scales by unit count.
const PHASES = [
  'Reading XML',
  'Reducing Library',
  'Scanning Components',
  'Preparing Translation',
  'Translating',
  'Writing XML',
  'Validating XML',
  'Completed'
];

// Progress percent at the start of each phase. Within "Translating" progress
// grows from TRANSLATING_BASE toward WRITING_BASE in proportion to units done.
const PHASE_BASE = {
  Queued: 0,
  'Reading XML': 2,
  'Reducing Library': 5, // Page Designer
  'Reducing Catalog': 5, // Product
  'Scanning Components': 8, // Page Designer
  'Scanning Products': 8, // Product
  'Preparing Translation': 10,
  Translating: 10,
  'Writing XML': 92,
  'Validating XML': 96,
  Completed: 100
};

const jobs = new Map();
const TTL_MS = 30 * 60 * 1000; // finished jobs are dropped 30 minutes after they end

function createJob({ provider, model }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued', // queued | running | completed | failed
    phase: 'Queued',
    component: null,
    locale: null,
    translatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalUnits: 0,
    processedUnits: 0,
    provider: provider || 'google',
    model: model || null,
    startTime: Date.now(),
    endTime: null,
    error: null,
    resultXml: null,
    fileCount: 0,
    extraction: null, // { originalContentCount, reducedContentCount, includedIds, ... } when a library was reduced

    // ---- reporter interface (called by translators + provider) ----
    setExtraction(info) {
      this.extraction = info;
    },
    setPhase(name) {
      this.phase = name;
    },
    setComponent(label) {
      this.component = label;
    },
    setLocale(locale) {
      this.locale = locale;
    },
    setTotalUnits(n) {
      this.totalUnits = n;
    },
    tickUnit() {
      this.processedUnits += 1;
    },
    addTranslated(n = 1) {
      this.translatedCount += n;
    },
    addSkipped(n = 1) {
      this.skippedCount += n;
    },
    addFailed(n = 1) {
      this.failedCount += n;
    },
    addUsage(inTok = 0, outTok = 0) {
      this.inputTokens += inTok;
      this.outputTokens += outTok;
    }
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function progressPercent(job) {
  if (job.status === 'completed') return 100;
  const base = PHASE_BASE[job.phase] != null ? PHASE_BASE[job.phase] : 0;
  if (job.phase === 'Translating' && job.totalUnits > 0) {
    const span = PHASE_BASE['Writing XML'] - PHASE_BASE.Translating; // 82
    const frac = Math.min(1, job.processedUnits / job.totalUnits);
    return Math.min(PHASE_BASE['Writing XML'] - 1, Math.round(base + span * frac));
  }
  return base;
}

function estimatedCost(job) {
  const price = PRICING[job.model];
  if (!price) return 0;
  return (job.inputTokens / 1e6) * price.input + (job.outputTokens / 1e6) * price.output;
}

function toStatus(job) {
  const elapsedSeconds = ((job.endTime || Date.now()) - job.startTime) / 1000;
  return {
    status: job.status,
    progress: progressPercent(job),
    currentPhase: job.phase,
    currentComponent: job.component,
    currentLocale: job.locale,
    translatedCount: job.translatedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    inputTokens: job.inputTokens,
    outputTokens: job.outputTokens,
    estimatedCost: Number(estimatedCost(job).toFixed(4)),
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    provider: job.provider,
    model: job.model,
    fileCount: job.fileCount,
    extraction: job.extraction,
    error: job.error
  };
}

// Periodically drop finished jobs so the map doesn't grow unbounded.
const sweep = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) {
    if (job.endTime && job.endTime < cutoff) {
      jobs.delete(id);
      logger.debug(`[Job] expired ${id}`);
    }
  }
}, 5 * 60 * 1000);
if (sweep.unref) sweep.unref();

module.exports = { createJob, getJob, toStatus, PHASES };
