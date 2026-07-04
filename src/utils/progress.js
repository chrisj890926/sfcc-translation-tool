'use strict';

/**
 * A no-op progress reporter.
 *
 * Translators and providers call reporter methods unconditionally; when no job
 * is attached (CLI, tests, direct API use) they receive this object so behavior
 * is byte-for-byte identical to before — the reporter only observes, it never
 * influences any translation decision.
 */
const NULL_REPORTER = {
  setPhase() {},
  setComponent() {},
  setLocale() {},
  setTotalUnits() {},
  tickUnit() {},
  addTranslated() {},
  addSkipped() {},
  addFailed() {},
  addUsage() {}
};

module.exports = { NULL_REPORTER };
