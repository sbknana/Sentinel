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

// Read-only TheForge DB connection for briefing queries
function getForgeDbReadonly() {
  if (!config.theforgeDbPath) return null;
  try {
    return new Database(config.theforgeDbPath, { readonly: true });
  } catch {
    return null;
  }
}

// ============================================================
// POST /api/voice/send — Write user message to voice_messages
// Writes transcribed voice command as inbound/pending message.
// Returns the message ID so the client can poll for a reply.
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
    res.json({ id: Number(result.lastInsertRowid), status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/voice/poll — Poll for outbound response to a message
//
// Query params:
//   reply_to  (required) — the inbound message ID to wait for
//   timeout   (optional) — max wait in ms, default 30000, max 30000
//
// Long-polls up to 30 seconds, checking every 500ms for an
// outbound message with direction='outbound' and
// reply_to=<id> and status='completed'.
// ============================================================

router.get('/poll', async (req, res) => {
  const db = getForgeDb();
  if (!db) return res.status(503).json({ error: 'TheForge DB not available' });

  const replyTo = parseInt(req.query.reply_to, 10);
  const afterId = parseInt(req.query.after_id, 10) || 0;

  // If reply_to is provided, do targeted long-poll for that specific response
  if (replyTo && !isNaN(replyTo)) {
    const timeout = Math.min(parseInt(req.query.timeout, 10) || 30000, 30000);
    const pollInterval = 500;
    const deadline = Date.now() + timeout;

    const check = () => {
      try {
        const row = db.prepare(`
          SELECT id, direction, content, status, reply_to, metadata, created_at, processed_at
          FROM voice_messages
          WHERE direction = 'outbound' AND reply_to = ? AND status = 'completed'
          ORDER BY id DESC
          LIMIT 1
        `).get(replyTo);

        if (row) {
          return res.json({ found: true, message: row });
        }

        if (Date.now() >= deadline) {
          return res.json({ found: false, timeout: true });
        }

        setTimeout(check, pollInterval);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    };

    check();
    return;
  }

  // Fallback: return all messages after a given ID (for general polling)
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
// Sends text to ElevenLabs TTS API and returns audio/mpeg buffer.
// Falls back to browser SpeechSynthesis if no API key configured.
// ============================================================

router.post('/speak', async (req, res) => {
  const { text, voice } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

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
// GET /api/voice/briefing — Morning briefing
//
// Aggregates data from existing Sentinel APIs to produce a
// spoken-word briefing covering:
//   - Active project status (from /api/forge/projects)
//   - Recent task activity (from /api/forge/activity)
//   - Infrastructure health (from /api/forge/tasks)
//   - Open questions and blockers
//
// Returns JSON with structured sections and a combined
// `briefing_text` suitable for TTS.
// ============================================================

router.get('/briefing', (req, res) => {
  const db = getForgeDbReadonly();
  if (!db) return res.status(503).json({ error: 'TheForge DB not available' });

  try {
    // --- Active projects with task counts ---
    const projects = db.prepare(`
      SELECT p.id, p.name, p.codename, p.status,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      HAVING todo_count > 0 OR in_progress_count > 0 OR blocked_count > 0
      ORDER BY in_progress_count DESC, todo_count DESC
    `).all();

    // --- Recently completed tasks (last 24 hours) ---
    const recentCompletions = db.prepare(`
      SELECT t.title, t.completed_at, p.name AS project_name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'done' AND t.completed_at IS NOT NULL
        AND t.completed_at > datetime('now', '-1 day')
      ORDER BY t.completed_at DESC
      LIMIT 10
    `).all();

    // --- In-progress tasks ---
    const inProgress = db.prepare(`
      SELECT t.title, t.priority, p.name AS project_name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'in_progress'
      ORDER BY
        CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    `).all();

    // --- Blocked tasks ---
    const blockedTasks = db.prepare(`
      SELECT t.title, t.priority, p.name AS project_name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'blocked'
      ORDER BY t.created_at DESC
    `).all();

    // --- Open questions ---
    const openQuestions = db.prepare(`
      SELECT q.question, q.priority, p.name AS project_name
      FROM open_questions q
      JOIN projects p ON p.id = q.project_id
      WHERE q.resolved = 0
      ORDER BY
        CASE q.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 5
    `).all();

    // --- Recent decisions (last 24 hours) ---
    const recentDecisions = db.prepare(`
      SELECT d.topic, d.decision, p.name AS project_name
      FROM decisions d
      JOIN projects p ON p.id = d.project_id
      WHERE d.decided_at > datetime('now', '-1 day')
      ORDER BY d.decided_at DESC
      LIMIT 5
    `).all();

    // --- Task summary counts ---
    const taskSummary = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM tasks
    `).get();

    db.close();

    // --- Generate spoken briefing text ---
    const lines = [];
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    lines.push(`Good morning. Here's your ForgeTeam briefing for ${dateStr} at ${timeStr}.`);

    // Overview
    lines.push(`Across ${projects.length} active projects, you have ${taskSummary.in_progress || 0} tasks in progress, ${taskSummary.todo || 0} queued, and ${taskSummary.blocked || 0} blocked.`);

    // Completions
    if (recentCompletions.length > 0) {
      lines.push(`In the last 24 hours, ${recentCompletions.length} task${recentCompletions.length > 1 ? 's were' : ' was'} completed.`);
      for (const t of recentCompletions.slice(0, 3)) {
        lines.push(`  ${t.title} on ${t.project_name}.`);
      }
      if (recentCompletions.length > 3) {
        lines.push(`  And ${recentCompletions.length - 3} more.`);
      }
    } else {
      lines.push('No tasks were completed in the last 24 hours.');
    }

    // In-progress
    if (inProgress.length > 0) {
      lines.push(`Currently in progress:`);
      for (const t of inProgress.slice(0, 5)) {
        const pri = t.priority === 'critical' || t.priority === 'high' ? ` (${t.priority} priority)` : '';
        lines.push(`  ${t.title} on ${t.project_name}${pri}.`);
      }
      if (inProgress.length > 5) {
        lines.push(`  Plus ${inProgress.length - 5} more.`);
      }
    }

    // Blockers
    if (blockedTasks.length > 0) {
      lines.push(`Attention: ${blockedTasks.length} task${blockedTasks.length > 1 ? 's are' : ' is'} currently blocked.`);
      for (const t of blockedTasks.slice(0, 3)) {
        lines.push(`  ${t.title} on ${t.project_name}.`);
      }
    }

    // Open questions
    if (openQuestions.length > 0) {
      lines.push(`There ${openQuestions.length > 1 ? 'are' : 'is'} ${openQuestions.length} unresolved question${openQuestions.length > 1 ? 's' : ''}.`);
      for (const q of openQuestions.slice(0, 2)) {
        lines.push(`  ${q.project_name}: ${q.question}`);
      }
    }

    // Decisions
    if (recentDecisions.length > 0) {
      lines.push(`Recent decisions:`);
      for (const d of recentDecisions.slice(0, 3)) {
        lines.push(`  ${d.project_name}, ${d.topic}: ${d.decision}`);
      }
    }

    // Project breakdown
    if (projects.length > 0) {
      lines.push('Project breakdown:');
      for (const p of projects.slice(0, 5)) {
        const parts = [];
        if (p.in_progress_count) parts.push(`${p.in_progress_count} active`);
        if (p.todo_count) parts.push(`${p.todo_count} queued`);
        if (p.blocked_count) parts.push(`${p.blocked_count} blocked`);
        if (p.done_count) parts.push(`${p.done_count} done`);
        lines.push(`  ${p.name}: ${parts.join(', ')}.`);
      }
    }

    lines.push('End of briefing.');

    const briefingText = lines.join('\n');

    res.json({
      briefing_text: briefingText,
      generated_at: now.toISOString(),
      sections: {
        projects,
        task_summary: taskSummary,
        recent_completions: recentCompletions,
        in_progress: inProgress,
        blocked: blockedTasks,
        open_questions: openQuestions,
        recent_decisions: recentDecisions,
      },
    });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ error: e.message });
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
