const fs = require('node:fs');
const path = require('node:path');

const RETENTION_DAYS = 7;
const MAX_DAILY_BYTES = 1024 * 1024;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: String(error.message).slice(0, 1000),
      stack: String(error.stack || '').slice(0, 4000)
    };
  }
  return { message: String(error).slice(0, 1000) };
}

function createDiagnosticLog(userData, options = {}) {
  const now = options.now || (() => new Date());
  const logDir = path.join(userData, 'logs');
  const sessionFile = path.join(logDir, 'active-session.json');
  let cleanupTimer = null;

  function cleanOldLogs() {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const cutoff = new Date(now());
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS + 1);
      const oldest = localDate(cutoff);
      for (const name of fs.readdirSync(logDir)) {
        if (/^\d{4}-\d{2}-\d{2}\.log$/.test(name) && name.slice(0, 10) < oldest) {
          fs.rmSync(path.join(logDir, name), { force: true });
        }
      }
    } catch (_) {
      // Un error de disco no debe impedir que se use la app.
    }
  }

  function write(level, event, details = {}) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const date = now();
      const file = path.join(logDir, `${localDate(date)}.log`);
      const line = JSON.stringify({ at: date.toISOString(), level, event, ...details }) + '\n';
      const existing = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (existing + Buffer.byteLength(line, 'utf8') <= MAX_DAILY_BYTES) {
        fs.appendFileSync(file, line, 'utf8');
      }
    } catch (_) {
      // El registro de diagnóstico nunca debe provocar un cierre.
    }
  }

  function start(version) {
    cleanOldLogs();
    if (fs.existsSync(sessionFile)) {
      try {
        const previous = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        write('warn', 'previous_session_without_clean_exit', {
          previousPid: previous.pid,
          previousStart: previous.startedAt
        });
      } catch (_) {
        write('warn', 'previous_session_without_clean_exit');
      }
    }
    try {
      fs.writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }), 'utf8');
    } catch (_) {
      // La app puede funcionar aunque no haya espacio para el registro.
    }
    write('info', 'app_started', { pid: process.pid, version });
    cleanupTimer = setInterval(cleanOldLogs, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  function stop(reason) {
    write('info', 'app_stopped', { reason });
    if (cleanupTimer) clearInterval(cleanupTimer);
    try { fs.rmSync(sessionFile, { force: true }); } catch (_) { /* Ignorar errores del registro. */ }
  }

  return {
    directory: logDir,
    write,
    error: (event, error) => write('error', event, errorDetails(error)),
    start,
    stop,
    cleanOldLogs
  };
}

module.exports = { createDiagnosticLog, localDate, RETENTION_DAYS, MAX_DAILY_BYTES };
