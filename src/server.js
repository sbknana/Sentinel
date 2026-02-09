// Copyright 2026, TheForge, LLC
const express = require('express');
const path = require('path');
const config = require('./config');
const { getDb, close: closeDb } = require('./db');
const apiRoutes = require('./routes/api');
const eventsRoutes = require('./routes/events');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api', apiRoutes);
app.use('/events', eventsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Initialize database on startup
getDb();

const server = app.listen(config.port, () => {
  console.log(`Sentinel listening on http://localhost:${config.port}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force exit after 5s if connections hang
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
