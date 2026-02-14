// Copyright 2026, Forgeborn
const cron = require('node-cron');
const config = require('./config');
const { collectAll } = require('./collectors/vm-health');
const { collectDockerAll } = require('./collectors/docker');
const { collectBackupStatus } = require('./collectors/backup');
const { runFullGather } = require('./collectors/recon');

let metricsTask = null;
let backupTask = null;
let reconTask = null;

/**
 * Start the collection scheduler.
 * Runs collectAll() on the configured interval (default: every 30 seconds).
 * Runs backup checks every 5 minutes (backups are heavier than metrics).
 * Also runs immediate first collections on startup.
 */
function start() {
  const intervalSec = config.collectIntervalMs / 1000;

  // Build a cron expression from the interval for metrics
  let cronExpr;
  if (intervalSec <= 59) {
    cronExpr = `*/${intervalSec} * * * * *`;
  } else {
    const intervalMin = Math.max(1, Math.round(intervalSec / 60));
    cronExpr = `0 */${intervalMin} * * * *`;
  }

  console.log(`[scheduler] Metrics collection every ${intervalSec}s (cron: ${cronExpr})`);

  metricsTask = cron.schedule(cronExpr, async () => {
    try {
      await collectAll();
    } catch (err) {
      console.error('[scheduler] Metrics collection error:', err.message);
    }
    try {
      await collectDockerAll();
    } catch (err) {
      console.error('[scheduler] Docker collection error:', err.message);
    }
  });

  // Run first collections immediately
  console.log('[scheduler] Running initial metrics + Docker collection...');
  collectAll().catch((err) => {
    console.error('[scheduler] Initial metrics collection error:', err.message);
  });
  collectDockerAll().catch((err) => {
    console.error('[scheduler] Initial Docker collection error:', err.message);
  });

  // Backup checks: every 5 minutes (heavier than metrics — spawns restic processes)
  if (config.backups.length > 0) {
    console.log(`[scheduler] Backup checks every 5 minutes for ${config.backups.length} backup(s)`);

    backupTask = cron.schedule('0 */5 * * * *', async () => {
      try {
        const results = await collectBackupStatus();
        console.log(`[scheduler] Backup check: ${results.map((r) => `${r.name}=${r.status}`).join(', ')}`);
      } catch (err) {
        console.error('[scheduler] Backup check error:', err.message);
      }
    });

    // Run first backup check after a short delay (let server finish starting)
    setTimeout(() => {
      console.log('[scheduler] Running initial backup check...');
      collectBackupStatus()
        .then((results) => console.log(`[scheduler] Backup check: ${results.map((r) => `${r.name}=${r.status}`).join(', ')}`))
        .catch((err) => console.error('[scheduler] Initial backup check error:', err.message));
    }, 3000);
  }

  // ForgeRecon: intelligence gathering every N hours (default: 6)
  const reconConfig = config.recon || {};
  if (reconConfig.enabled) {
    const hours = reconConfig.gather_interval_hours || 6;
    const reconCron = `0 0 */${hours} * * *`; // At minute 0 of every Nth hour
    console.log(`[scheduler] ForgeRecon intelligence gathering every ${hours}h (cron: ${reconCron})`);

    reconTask = cron.schedule(reconCron, async () => {
      try {
        const results = await runFullGather();
        const redditNew = results.reddit?.items_new || 0;
        const newsNew = results.news?.items_new || 0;
        console.log(`[scheduler] ForgeRecon gather: reddit=${redditNew} new, news=${newsNew} new`);
      } catch (err) {
        console.error('[scheduler] ForgeRecon gather error:', err.message);
      }
    });

    // Run initial recon gather after a longer delay (10s — let metrics/backups finish first)
    setTimeout(() => {
      console.log('[scheduler] Running initial ForgeRecon gather...');
      runFullGather()
        .then((results) => {
          const redditNew = results.reddit?.items_new || 0;
          const newsNew = results.news?.items_new || 0;
          console.log(`[scheduler] Initial ForgeRecon: reddit=${redditNew} new, news=${newsNew} new`);
        })
        .catch((err) => console.error('[scheduler] Initial ForgeRecon error:', err.message));
    }, 10000);
  }
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (metricsTask) {
    metricsTask.stop();
    metricsTask = null;
  }
  if (backupTask) {
    backupTask.stop();
    backupTask = null;
  }
  if (reconTask) {
    reconTask.stop();
    reconTask = null;
  }
}

module.exports = { start, stop };
