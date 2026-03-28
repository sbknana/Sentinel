// Copyright 2026, Forgeborn
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getDb, close: closeDb } = require('./db');
const { seedFromConfig } = require('./seed');
const statusRoutes = require('./routes/status');
const containersRoutes = require('./routes/containers');
const alertsRoutes = require('./routes/alerts');
const backupsRoutes = require('./routes/backups');
const configRoutes = require('./routes/configRoute');
const eventsRoutes = require('./routes/events');
const forgeRoutes = require('./routes/forge');
const healingRoutes = require('./routes/healing');
const guardRoutes = require('./routes/guard');
const reconRoutes = require('./routes/recon');
const voiceRoutes = require('./routes/voice');
const scheduler = require('./scheduler');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', statusRoutes);
app.use('/api/containers', containersRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/forge', forgeRoutes);
app.use('/api/healing', healingRoutes);
app.use('/api/guard', guardRoutes);
app.use('/api/recon', reconRoutes);
app.use('/api/voice', voiceRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Initialize database and seed config on startup
getDb();
seedFromConfig();

// ── HTTP server ──────────────────────────────────────────────
const server = app.listen(config.port, () => {
  console.log(`Sentinel listening on http://localhost:${config.port}`);
  scheduler.start();
});

// ── HTTPS server (for Web Speech API / mic access) ───────────
const certsDir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');

let httpsServer = null;
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsPort = config.port + 1; // 3003
  try {
    const sslOpts = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    httpsServer = https.createServer(sslOpts, app).listen(httpsPort, () => {
      console.log(`Sentinel HTTPS listening on https://localhost:${httpsPort}`);
    });
  } catch (e) {
    console.warn('HTTPS startup failed (continuing HTTP-only):', e.message);
  }
} else {
  console.log('No certs found at', certsDir, '— HTTPS disabled. Voice recognition requires HTTPS.');
}

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  scheduler.stop();
  server.close(() => {
    if (httpsServer) httpsServer.close();
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
