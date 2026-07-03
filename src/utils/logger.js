'use strict';

/**
 * Tiny leveled logger. Control verbosity with LOG_LEVEL=error|warn|info|debug.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[process.env.LOG_LEVEL] != null ? LEVELS[process.env.LOG_LEVEL] : LEVELS.info;

function emit(level, args) {
  if (LEVELS[level] <= current) {
    const fn = console[level] || console.log;
    fn(`[${level}]`, ...args);
  }
}

module.exports = {
  error: (...args) => emit('error', args),
  warn: (...args) => emit('warn', args),
  info: (...args) => emit('info', args),
  debug: (...args) => emit('debug', args)
};
