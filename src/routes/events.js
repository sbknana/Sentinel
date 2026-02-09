// Copyright 2026, TheForge, LLC
const express = require('express');
const { addClient, getClientCount } = require('../sse');

const router = express.Router();

// GET /events - SSE stream for real-time updates
router.get('/', (req, res) => {
  addClient(res);
});

// GET /events/status - how many SSE clients connected
router.get('/status', (req, res) => {
  res.json({ clients: getClientCount() });
});

module.exports = router;
