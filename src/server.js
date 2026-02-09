// Copyright 2026, TheForge, LLC
const express = require('express');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Initialize database and seed config on startup
getDb();
seedFromConfig();

const server = app.listen(config.port, () => {
  console.log(`Sentinel listening on http://localhost:${config.port}`);
  scheduler.start();
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  scheduler.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
