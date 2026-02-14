// Copyright 2026, Forgeborn
const https = require('https');
const { getDb } = require('../db');
const config = require('../config');

// ============================================================
// ForgeRecon Intelligence Collector
// Gathers competitive intelligence from Reddit and news sources
// ============================================================

const USER_AGENT = 'ForgeRecon/1.0 (Sentinel Intelligence Gathering)';

// ============================================================
// SCHEMA — ensure recon intelligence tables exist
// ============================================================

function ensureReconIntelTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS recon_gather_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      items_found INTEGER DEFAULT 0,
      items_new INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS recon_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT,
      industry TEXT,
      title TEXT NOT NULL,
      url TEXT,
      body TEXT,
      summary TEXT,
      author TEXT,
      score INTEGER DEFAULT 0,
      sentiment TEXT DEFAULT 'neutral',
      subreddit TEXT,
      keywords_matched TEXT,
      ai_analysis TEXT,
      gathered_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_actionable INTEGER NOT NULL DEFAULT 0,
      run_id INTEGER REFERENCES recon_gather_runs(id)
    );

    CREATE TABLE IF NOT EXISTS recon_ai_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'daily',
      industry TEXT,
      summary TEXT NOT NULL,
      key_findings TEXT,
      action_items TEXT,
      threat_level TEXT DEFAULT 'low',
      intel_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recon_intel_source ON recon_intel(source, gathered_at);
    CREATE INDEX IF NOT EXISTS idx_recon_intel_industry ON recon_intel(industry, gathered_at);
    CREATE INDEX IF NOT EXISTS idx_recon_intel_source_id ON recon_intel(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_recon_gather_runs_time ON recon_gather_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_recon_ai_summaries_time ON recon_ai_summaries(created_at);
  `);
}

let tablesReady = false;
function ensureTables() {
  if (!tablesReady) {
    ensureReconIntelTables();
    tablesReady = true;
  }
}

// ============================================================
// HTTP HELPERS — built-in https, no external deps
// ============================================================

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...headers,
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        } else if (res.statusCode === 429) {
          reject(new Error(`Rate limited (429) from ${urlObj.hostname}`));
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${urlObj.hostname}${urlObj.pathname}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${urlObj.hostname}`));
    });

    req.on('error', reject);
    req.end();
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout posting to ${urlObj.hostname}`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================
// INDUSTRY DETECTION
// ============================================================

function detectIndustry(text) {
  const lower = (text || '').toLowerCase();
  const industries = config.recon.industries || {};
  for (const [industry, keywords] of Object.entries(industries)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return industry;
    }
  }
  return 'general';
}

function findMatchedKeywords(text) {
  const lower = (text || '').toLowerCase();
  const allKeywords = config.recon.reddit?.keywords || [];
  return allKeywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

// ============================================================
// REDDIT FETCHER — uses Reddit's public .json API
// ============================================================

async function fetchRedditPosts(subreddit, limit = 25) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limit}&raw_json=1`;
  const resp = await httpGet(url, { Accept: 'application/json' });
  const data = JSON.parse(resp.body);

  if (!data.data || !data.data.children) return [];

  return data.data.children
    .filter((child) => child.kind === 't3')
    .map((child) => {
      const post = child.data;
      return {
        source_id: post.id,
        title: post.title,
        url: `https://www.reddit.com${post.permalink}`,
        body: (post.selftext || '').slice(0, 2000),
        author: post.author,
        score: post.score || 0,
        subreddit: post.subreddit,
        published_at: new Date(post.created_utc * 1000).toISOString().replace('T', ' ').slice(0, 19),
        num_comments: post.num_comments || 0,
      };
    });
}

async function gatherReddit() {
  ensureTables();
  const db = getDb();
  const reconConfig = config.recon.reddit || {};
  const subreddits = reconConfig.subreddits || [];
  const keywords = reconConfig.keywords || [];
  const maxPosts = reconConfig.max_posts_per_sub || 25;

  if (subreddits.length === 0) {
    return { source: 'reddit', items_found: 0, items_new: 0, error: 'No subreddits configured' };
  }

  // Start a gather run
  const run = db.prepare(
    "INSERT INTO recon_gather_runs (source, status) VALUES ('reddit', 'running')"
  ).run();
  const runId = Number(run.lastInsertRowid);

  let totalFound = 0;
  let totalNew = 0;
  const errors = [];

  const insertIntel = db.prepare(`
    INSERT INTO recon_intel (source, source_id, industry, title, url, body, author, score, subreddit, keywords_matched, published_at, run_id)
    VALUES ('reddit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const sub of subreddits) {
    try {
      const posts = await fetchRedditPosts(sub, maxPosts);

      for (const post of posts) {
        const combinedText = post.title + ' ' + post.body;
        const matched = findMatchedKeywords(combinedText);

        // Only store posts that match at least one keyword
        if (matched.length === 0) continue;

        totalFound++;

        // Deduplicate by source_id
        const existing = db.prepare(
          "SELECT id FROM recon_intel WHERE source = 'reddit' AND source_id = ?"
        ).get(post.source_id);

        if (existing) continue;

        const industry = detectIndustry(combinedText);
        insertIntel.run(
          post.source_id,
          industry,
          post.title,
          post.url,
          post.body.slice(0, 2000),
          post.author,
          post.score,
          post.subreddit,
          matched.join(', '),
          post.published_at,
          runId
        );
        totalNew++;
      }

      // Small delay between subreddit fetches to be polite
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      errors.push(`r/${sub}: ${err.message}`);
      console.error(`[recon] Reddit fetch error for r/${sub}:`, err.message);
    }
  }

  // Update run record
  const status = errors.length === subreddits.length ? 'failed' : errors.length > 0 ? 'partial' : 'success';
  db.prepare(
    "UPDATE recon_gather_runs SET finished_at = datetime('now'), items_found = ?, items_new = ?, status = ?, error = ? WHERE id = ?"
  ).run(totalFound, totalNew, status, errors.length > 0 ? errors.join('; ') : null, runId);

  console.log(`[recon] Reddit gather complete: ${totalFound} matched, ${totalNew} new, ${errors.length} errors`);
  return { source: 'reddit', items_found: totalFound, items_new: totalNew, errors, run_id: runId };
}

// ============================================================
// NEWS FETCHER — parses RSS/Atom XML feeds
// ============================================================

function parseRssItems(xml) {
  const items = [];
  // Simple XML parser for RSS <item> elements
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: getTag('title'),
      url: getTag('link'),
      description: getTag('description').replace(/<[^>]+>/g, '').slice(0, 2000),
      author: getTag('dc:creator') || getTag('author'),
      pubDate: getTag('pubDate'),
    });
  }

  // Also handle Atom <entry> elements
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    items.push({
      title: getTag('title'),
      url: linkMatch ? linkMatch[1] : '',
      description: getTag('summary').replace(/<[^>]+>/g, '').slice(0, 2000) ||
                    getTag('content').replace(/<[^>]+>/g, '').slice(0, 2000),
      author: getTag('author') ? getTag('name') : '',
      pubDate: getTag('published') || getTag('updated'),
    });
  }

  return items;
}

async function fetchNewsFeed(feedUrl) {
  // Handle both http and https
  const url = feedUrl.startsWith('http://') ? feedUrl.replace('http://', 'https://') : feedUrl;
  const resp = await httpGet(url, { Accept: 'application/rss+xml, application/xml, text/xml' });
  return parseRssItems(resp.body);
}

async function gatherNews() {
  ensureTables();
  const db = getDb();
  const newsConfig = config.recon.news || {};
  const feeds = newsConfig.rss_feeds || [];
  const keywords = newsConfig.keywords || [];

  if (feeds.length === 0) {
    return { source: 'news', items_found: 0, items_new: 0, error: 'No RSS feeds configured' };
  }

  const run = db.prepare(
    "INSERT INTO recon_gather_runs (source, status) VALUES ('news', 'running')"
  ).run();
  const runId = Number(run.lastInsertRowid);

  let totalFound = 0;
  let totalNew = 0;
  const errors = [];

  const insertIntel = db.prepare(`
    INSERT INTO recon_intel (source, source_id, industry, title, url, body, author, keywords_matched, published_at, run_id)
    VALUES ('news', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const feedUrl of feeds) {
    try {
      const items = await fetchNewsFeed(feedUrl);

      for (const item of items) {
        const combinedText = item.title + ' ' + item.description;
        const matchedKeywords = keywords.filter((kw) =>
          combinedText.toLowerCase().includes(kw.toLowerCase())
        );

        if (matchedKeywords.length === 0) continue;
        totalFound++;

        // Generate a source_id from URL hash
        const sourceId = Buffer.from(item.url || item.title).toString('base64').slice(0, 40);

        const existing = db.prepare(
          "SELECT id FROM recon_intel WHERE source = 'news' AND source_id = ?"
        ).get(sourceId);

        if (existing) continue;

        const industry = detectIndustry(combinedText);
        let publishedAt = null;
        if (item.pubDate) {
          try {
            publishedAt = new Date(item.pubDate).toISOString().replace('T', ' ').slice(0, 19);
          } catch {
            publishedAt = null;
          }
        }

        insertIntel.run(
          sourceId,
          industry,
          item.title,
          item.url,
          item.description,
          item.author || null,
          matchedKeywords.join(', '),
          publishedAt,
          runId
        );
        totalNew++;
      }

      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      errors.push(`${feedUrl}: ${err.message}`);
      console.error(`[recon] News fetch error for ${feedUrl}:`, err.message);
    }
  }

  const status = errors.length === feeds.length ? 'failed' : errors.length > 0 ? 'partial' : 'success';
  db.prepare(
    "UPDATE recon_gather_runs SET finished_at = datetime('now'), items_found = ?, items_new = ?, status = ?, error = ? WHERE id = ?"
  ).run(totalFound, totalNew, status, errors.length > 0 ? errors.join('; ') : null, runId);

  console.log(`[recon] News gather complete: ${totalFound} matched, ${totalNew} new, ${errors.length} errors`);
  return { source: 'news', items_found: totalFound, items_new: totalNew, errors, run_id: runId };
}

// ============================================================
// AI ANALYSIS — uses Claude API to analyze gathered intelligence
// ============================================================

async function analyzeIntelligence(options = {}) {
  ensureTables();
  const db = getDb();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: 'ANTHROPIC_API_KEY not set — AI analysis unavailable' };
  }

  const { industry, hours = 24, scope = 'daily' } = options;

  // Gather recent intel items
  let sql = `
    SELECT id, source, industry, title, url, body, author, score, subreddit, keywords_matched, published_at
    FROM recon_intel
    WHERE gathered_at >= datetime('now', ?)
  `;
  const params = [`-${hours} hours`];

  if (industry) {
    sql += ' AND industry = ?';
    params.push(industry);
  }

  sql += ' ORDER BY gathered_at DESC LIMIT 50';

  const items = db.prepare(sql).all(...params);

  if (items.length === 0) {
    return { error: 'No recent intelligence items to analyze', items_count: 0 };
  }

  // Build prompt for Claude
  const intelSummary = items
    .map((item, i) => {
      const parts = [
        `${i + 1}. [${item.source}/${item.industry}] "${item.title}"`,
        item.body ? `   Content: ${item.body.slice(0, 300)}` : '',
        item.subreddit ? `   Subreddit: r/${item.subreddit}` : '',
        item.score ? `   Score: ${item.score}` : '',
        item.keywords_matched ? `   Keywords: ${item.keywords_matched}` : '',
      ];
      return parts.filter(Boolean).join('\n');
    })
    .join('\n\n');

  const prompt = `You are ForgeRecon, a competitive intelligence analyst for Forgeborn. Analyze the following ${items.length} intelligence items gathered from Reddit and news sources.

Industries we track: auto repair software, TCG/MTG (trading card games), and blockchain/crypto.

Intelligence items:
${intelSummary}

Provide a structured analysis with:
1. **Executive Summary** (2-3 sentences overview)
2. **Key Findings** (bullet points of the most important discoveries)
3. **Competitive Threats** (any threats to our products or market position)
4. **Opportunities** (market gaps, competitor weaknesses we could exploit)
5. **Action Items** (specific recommended actions)
6. **Threat Level** (low/medium/high based on competitive landscape)

Be concise and actionable. Focus on insights relevant to a software company competing in auto repair shop management and TCG/card scanning markets.`;

  try {
    const response = await httpPost('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });

    const result = JSON.parse(response.body);
    const analysisText = result.content?.[0]?.text || 'No analysis generated';

    // Extract threat level from analysis
    const threatMatch = analysisText.match(/threat\s*level[:\s]*\**(low|medium|high)\**/i);
    const threatLevel = threatMatch ? threatMatch[1].toLowerCase() : 'low';

    // Extract key findings and action items
    const keyFindings = extractSection(analysisText, 'Key Findings');
    const actionItems = extractSection(analysisText, 'Action Items');

    // Store the AI summary
    const intelIds = items.map((i) => i.id).join(',');
    const summaryInsert = db.prepare(`
      INSERT INTO recon_ai_summaries (scope, industry, summary, key_findings, action_items, threat_level, intel_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope,
      industry || 'all',
      analysisText,
      keyFindings,
      actionItems,
      threatLevel,
      intelIds
    );

    // Update intel items with AI analysis reference
    const summaryId = Number(summaryInsert.lastInsertRowid);
    for (const item of items) {
      db.prepare('UPDATE recon_intel SET ai_analysis = ? WHERE id = ?').run(
        `summary:${summaryId}`,
        item.id
      );
    }

    console.log(`[recon] AI analysis complete: ${items.length} items analyzed, threat level: ${threatLevel}`);

    return {
      summary_id: summaryId,
      items_analyzed: items.length,
      threat_level: threatLevel,
      summary: analysisText,
      key_findings: keyFindings,
      action_items: actionItems,
    };
  } catch (err) {
    console.error('[recon] AI analysis error:', err.message);
    return { error: err.message, items_count: items.length };
  }
}

function extractSection(text, sectionName) {
  const regex = new RegExp(`\\*\\*${sectionName}\\*\\*[\\s:]*([\\s\\S]*?)(?=\\*\\*[A-Z]|$)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

// ============================================================
// FULL GATHER RUN — called by cron job
// ============================================================

async function runFullGather() {
  console.log('[recon] Starting full intelligence gather...');
  const results = {};

  try {
    results.reddit = await gatherReddit();
  } catch (err) {
    results.reddit = { error: err.message };
    console.error('[recon] Reddit gather failed:', err.message);
  }

  try {
    results.news = await gatherNews();
  } catch (err) {
    results.news = { error: err.message };
    console.error('[recon] News gather failed:', err.message);
  }

  // Run AI analysis on newly gathered items if API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      results.analysis = await analyzeIntelligence({ hours: 6, scope: 'scheduled' });
    } catch (err) {
      results.analysis = { error: err.message };
      console.error('[recon] AI analysis failed:', err.message);
    }
  }

  console.log('[recon] Full intelligence gather complete');
  return results;
}

module.exports = {
  ensureTables,
  gatherReddit,
  gatherNews,
  analyzeIntelligence,
  runFullGather,
};
