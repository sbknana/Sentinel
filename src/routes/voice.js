// Copyright 2026, Forgeborn
const express = require('express');
const https = require('https');
const Database = require('better-sqlite3');
const config = require('../config');

const router = express.Router();

// ============================================================
// TheForge DB access — read/write for voice_messages table
// ============================================================

let forgeDb = null;

function getForgeDb() {
  if (forgeDb) {
    try { forgeDb.prepare('SELECT 1').get(); return forgeDb; } catch { forgeDb = null; }
  }
  if (!config.theforgeDbPath) return null;
  try {
    forgeDb = new Database(config.theforgeDbPath);
    forgeDb.pragma('journal_mode = WAL');
    return forgeDb;
  } catch {
    return null;
  }
}

// ============================================================
// POST /api/voice/send — Write user message to voice_messages
// ============================================================

router.post('/send', (req, res) => {
  const db = getForgeDb();
  if (!db) return res.status(503).json({ error: 'TheForge DB not available' });

  const { content, metadata } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO voice_messages (direction, content, status, metadata)
      VALUES ('inbound', ?, 'pending', ?)
    `);
    const result = stmt.run(content.trim(), metadata ? JSON.stringify(metadata) : null);
    res.json({ id: result.lastInsertRowid, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/voice/poll — Poll for outbound responses
// ============================================================

router.get('/poll', (req, res) => {
  const db = getForgeDb();
  if (!db) return res.status(503).json({ error: 'TheForge DB not available' });

  const afterId = parseInt(req.query.after_id, 10) || 0;

  try {
    const messages = db.prepare(`
      SELECT id, direction, content, status, reply_to, metadata, created_at, processed_at
      FROM voice_messages
      WHERE id > ?
      ORDER BY id ASC
    `).all(afterId);

    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/voice/history — Get conversation history
// ============================================================

router.get('/history', (req, res) => {
  const db = getForgeDb();
  if (!db) return res.status(503).json({ error: 'TheForge DB not available' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const messages = db.prepare(`
      SELECT id, direction, content, status, reply_to, metadata, created_at, processed_at
      FROM voice_messages
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    res.json({ messages: messages.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// POST /api/voice/speak — Generate TTS audio via ElevenLabs
// Uses the forgebridge MCP indirectly via a simple proxy
// For now, returns a placeholder — the frontend handles TTS
// via the browser's SpeechSynthesis API as fallback
// ============================================================

router.post('/speak', async (req, res) => {
  const { text, voice } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Check for ElevenLabs API key in environment
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.json({ fallback: true, message: 'No ElevenLabs API key — use browser TTS' });
  }

  const voiceId = getVoiceId(voice || 'rachel');

  try {
    const audioBuffer = await elevenLabsTTS(apiKey, voiceId, text.trim());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message, fallback: true });
  }
});

// ============================================================
// GET /api/voice/status — Voice system status
// ============================================================

router.get('/status', (req, res) => {
  const db = getForgeDb();
  const dbOk = !!db;

  let stats = { total: 0, pending: 0, completed: 0 };
  if (db) {
    try {
      stats = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM voice_messages
      `).get();
    } catch { /* table may not exist yet */ }
  }

  res.json({
    db_connected: dbOk,
    elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
    stats,
  });
});

// ============================================================
// ElevenLabs TTS Helper
// ============================================================

const VOICE_MAP = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  george: 'JBFqnCBsd6RMkjVDRZzb',
  emily: 'LcfcDJNUP1GQjkzn1xUU',
  charlie: 'IKne3meq5aSn9XLyUdCD',
  alice: 'Xb7hH8MSUJpSbSDYk0k2',
  brian: 'nPczCjzI2devNBz1zQrb',
  daniel: 'onwK4e9ZLuTAKqWW03F9',
  jessica: 'cgSgspJ2msm6clMCkdW9',
};

function getVoiceId(voice) {
  return VOICE_MAP[voice.toLowerCase()] || voice;
}

function elevenLabsTTS(apiKey, voiceId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (resp) => {
      if (resp.statusCode !== 200) {
        let errData = '';
        resp.on('data', (chunk) => { errData += chunk; });
        resp.on('end', () => reject(new Error(`ElevenLabs API error ${resp.statusCode}: ${errData}`)));
        return;
      }
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = router;
