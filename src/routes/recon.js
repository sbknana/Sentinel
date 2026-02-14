// Copyright 2026, Forgeborn
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// ============================================================
// ForgeRecon — Competitive Intelligence API
// ============================================================

// Ensure recon tables exist
function ensureReconTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS recon_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      industry TEXT NOT NULL,
      product TEXT,
      title TEXT NOT NULL,
      url TEXT,
      summary TEXT,
      sentiment TEXT DEFAULT 'neutral',
      score REAL DEFAULT 0,
      author TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_actionable INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT
    );

    CREATE TABLE IF NOT EXISTS recon_pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor TEXT NOT NULL,
      industry TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_period TEXT DEFAULT 'monthly',
      notes TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recon_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor TEXT NOT NULL,
      industry TEXT NOT NULL,
      store TEXT NOT NULL,
      rating REAL,
      review_count INTEGER,
      avg_sentiment REAL,
      positive_pct REAL,
      negative_pct REAL,
      neutral_pct REAL,
      top_complaints TEXT,
      top_praises TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recon_mentions_industry ON recon_mentions(industry, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_recon_mentions_source ON recon_mentions(source, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_recon_pricing_competitor ON recon_pricing(competitor, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_recon_reviews_competitor ON recon_reviews(competitor, recorded_at);
  `);
}

let tablesEnsured = false;
function ensureTables() {
  if (!tablesEnsured) {
    ensureReconTables();
    tablesEnsured = true;
  }
}

// ============================================================
// SEED DEMO DATA — populates tables on first request if empty
// ============================================================

function seedDemoData() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM recon_mentions').get().c;
  if (count > 0) return;

  const now = new Date();
  function daysAgo(n) {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  function hoursAgo(n) {
    const d = new Date(now);
    d.setHours(d.getHours() - n);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }

  // --- Mentions ---
  const mentions = [
    // Auto repair software
    { source: 'reddit', industry: 'auto-repair', product: 'Tekmetric', title: 'Tekmetric just raised their prices again - looking for alternatives', url: 'https://reddit.com/r/AutoRepairShop/comments/abc123', summary: 'Shop owner frustrated with Tekmetric\'s latest 15% price hike. Multiple commenters suggest Shopmonkey and Mitchell 1 as alternatives. Thread has 47 upvotes.', sentiment: 'negative', score: 47, author: 'MechanicMike42', published_at: hoursAgo(3) },
    { source: 'reddit', industry: 'auto-repair', product: 'Shopmonkey', title: 'Switched from Shopmonkey to Shop-Ware - my experience after 6 months', url: 'https://reddit.com/r/AutoRepairShop/comments/def456', summary: 'Detailed comparison post. User prefers Shop-Ware\'s inventory management but misses Shopmonkey\'s mobile app. Mixed reception in comments.', sentiment: 'neutral', score: 32, author: 'WrenchTurner2025', published_at: hoursAgo(8) },
    { source: 'reddit', industry: 'auto-repair', product: 'Mitchell 1', title: 'Mitchell 1 ProDemand integration issues - anyone else?', url: 'https://reddit.com/r/MechanicAdvice/comments/ghi789', summary: 'Multiple mechanics reporting sync failures between Mitchell 1 Manager and ProDemand since last update. Official support response is slow.', sentiment: 'negative', score: 28, author: 'ShopTech_Pro', published_at: hoursAgo(12) },
    { source: 'forum', industry: 'auto-repair', product: 'AutoLeap', title: 'AutoLeap announces new AI-powered repair estimation feature', url: 'https://autoshopowner.com/threads/autoleap-ai-estimation.12345/', summary: 'AutoLeap rolling out AI estimates for common repairs. Early users report 80% accuracy. Could disrupt manual estimation workflows.', sentiment: 'positive', score: 15, author: 'ForumAdmin', published_at: hoursAgo(18) },
    { source: 'news', industry: 'auto-repair', product: 'Tekmetric', title: 'Tekmetric Raises $45M Series B to Expand Auto Repair Platform', url: 'https://techcrunch.com/2026/02/10/tekmetric-series-b/', summary: 'Tekmetric secured $45M in Series B funding led by Greenspring Associates. Plans to expand AI features and enter the fleet management market. Valuation undisclosed.', sentiment: 'positive', score: 0, author: 'TechCrunch', published_at: daysAgo(4) },

    // MTG / TCG software
    { source: 'reddit', industry: 'tcg', product: 'TCGplayer', title: 'TCGplayer seller fees increasing March 2026 - megathread', url: 'https://reddit.com/r/mtgfinance/comments/jkl012', summary: 'TCGplayer announcing fee increases from 10.25% to 12.5% for standard sellers. Community outrage. Several sellers considering moving to CardMarket or direct sales.', sentiment: 'negative', score: 234, author: 'MTG_Finance_Mod', published_at: hoursAgo(5) },
    { source: 'reddit', industry: 'tcg', product: 'Moxfield', title: 'Moxfield just added collection value tracking - finally catches up to Archidekt', url: 'https://reddit.com/r/EDH/comments/mno345', summary: 'Moxfield\'s new collection value feature tracks price history. Users comparing it favorably to Archidekt but noting it still lacks bulk import from CSV.', sentiment: 'positive', score: 89, author: 'CommanderFan99', published_at: hoursAgo(14) },
    { source: 'reddit', industry: 'tcg', product: 'Delver Lens', title: 'Delver Lens scan accuracy has gotten way worse - any alternatives?', url: 'https://reddit.com/r/mtg/comments/pqr678', summary: 'Users reporting decreased scan accuracy in latest Delver Lens update. Some recommending TCG Kungfu and CardConduit as better scanning alternatives.', sentiment: 'negative', score: 56, author: 'ScannerPro', published_at: daysAgo(1) },
    { source: 'news', industry: 'tcg', product: 'ChannelFireball', title: 'ChannelFireball launches new storefront platform for LGS', url: 'https://icv2.com/articles/news/channelfireball-storefront-launch', summary: 'CFB offering white-label storefront solution for local game stores. Integrates with their marketplace. Could compete with TCGplayer Direct.', sentiment: 'neutral', score: 0, author: 'ICv2', published_at: daysAgo(2) },
    { source: 'forum', industry: 'tcg', product: 'CardConduit', title: 'CardConduit grading integration review - is it worth switching from PSA direct?', url: 'https://blowoutcards.com/forums/topic/cardconduit-grading.54321/', summary: 'Detailed user review of CardConduit\'s grading submission portal. Consensus: great for BGS/CGC bulk, not yet competitive with PSA direct for high-value cards.', sentiment: 'neutral', score: 22, author: 'GradingGeek', published_at: daysAgo(3) },

    // Blockchain
    { source: 'reddit', industry: 'blockchain', product: 'Ethereum', title: 'Ethereum L2 gas fees comparison - Feb 2026 update', url: 'https://reddit.com/r/ethereum/comments/stu901', summary: 'Comprehensive comparison of Arbitrum, Optimism, Base, and zkSync gas fees. Base winning on cost, Arbitrum on ecosystem. Average L2 tx now $0.003.', sentiment: 'neutral', score: 156, author: 'L2_Analyst', published_at: hoursAgo(6) },
    { source: 'reddit', industry: 'blockchain', product: 'Solana', title: 'Solana downtime tracker - 2026 has been surprisingly stable', url: 'https://reddit.com/r/solana/comments/vwx234', summary: 'Community tracking Solana uptime. Only 1 minor degradation event in 2026 so far (45 min). Significant improvement over 2024-2025.', sentiment: 'positive', score: 312, author: 'SOL_Watcher', published_at: hoursAgo(10) },
    { source: 'news', industry: 'blockchain', product: 'DOGE', title: 'Dogecoin smart contracts proposal gains momentum', url: 'https://coindesk.com/2026/02/12/dogecoin-smart-contracts/', summary: 'Dogecoin Foundation publishes updated roadmap including Dogechain smart contract layer. Community vote scheduled for March. Could significantly expand DOGE utility.', sentiment: 'positive', score: 0, author: 'CoinDesk', published_at: daysAgo(2) },
    { source: 'forum', industry: 'blockchain', product: null, title: 'Best crypto portfolio trackers in 2026 - community poll results', url: 'https://bitcointalk.org/index.php?topic=portfolio-trackers-2026', summary: 'Poll results: CoinGecko (34%), CoinMarketCap (28%), Delta (18%), Zerion (12%), Other (8%). DeFi tracking accuracy is the top differentiator.', sentiment: 'neutral', score: 45, author: 'CryptoTracker', published_at: daysAgo(5) },

    // More recent mentions
    { source: 'reddit', industry: 'auto-repair', product: 'Shop-Ware', title: 'Shop-Ware just released multi-location management - game changer?', url: 'https://reddit.com/r/AutoRepairShop/comments/yz567', summary: 'Shop-Ware\'s new multi-location feature allows cross-shop inventory and scheduling. Enterprise pricing at $399/mo per location. Several chain owners excited.', sentiment: 'positive', score: 41, author: 'MultiShopOwner', published_at: hoursAgo(2) },
    { source: 'reddit', industry: 'tcg', product: 'Archidekt', title: 'Archidekt premium subscription now includes AI deck suggestions', url: 'https://reddit.com/r/EDH/comments/abc890', summary: 'Archidekt rolling out AI-powered card suggestions for Commander decks. Premium only at $4.99/mo. Mixed reactions - some love it, purists hate it.', sentiment: 'positive', score: 67, author: 'DeckTech', published_at: hoursAgo(4) },
  ];

  const insertMention = db.prepare(`
    INSERT INTO recon_mentions (source, industry, product, title, url, summary, sentiment, score, author, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const m of mentions) {
    insertMention.run(m.source, m.industry, m.product, m.title, m.url, m.summary, m.sentiment, m.score, m.author, m.published_at);
  }

  // --- Pricing ---
  const pricing = [
    // Auto repair
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Standard', price: 349, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Standard', price: 379, billing_period: 'monthly', recorded_at: daysAgo(60) },
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Standard', price: 399, billing_period: 'monthly', recorded_at: daysAgo(30) },
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Standard', price: 449, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Premium', price: 549, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Tekmetric', industry: 'auto-repair', plan_name: 'Premium', price: 599, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Shopmonkey', industry: 'auto-repair', plan_name: 'Clever', price: 249, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Shopmonkey', industry: 'auto-repair', plan_name: 'Clever', price: 249, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Shopmonkey', industry: 'auto-repair', plan_name: 'Genius', price: 399, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Shopmonkey', industry: 'auto-repair', plan_name: 'Genius', price: 419, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Shop-Ware', industry: 'auto-repair', plan_name: 'Standard', price: 299, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Shop-Ware', industry: 'auto-repair', plan_name: 'Standard', price: 299, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Mitchell 1', industry: 'auto-repair', plan_name: 'Manager SE', price: 329, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Mitchell 1', industry: 'auto-repair', plan_name: 'Manager SE', price: 359, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'AutoLeap', industry: 'auto-repair', plan_name: 'Standard', price: 199, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'AutoLeap', industry: 'auto-repair', plan_name: 'Standard', price: 229, billing_period: 'monthly', recorded_at: daysAgo(1) },

    // TCG
    { competitor: 'TCGplayer', industry: 'tcg', plan_name: 'Seller Fee', price: 10.25, billing_period: 'percentage', recorded_at: daysAgo(90) },
    { competitor: 'TCGplayer', industry: 'tcg', plan_name: 'Seller Fee', price: 12.5, billing_period: 'percentage', recorded_at: daysAgo(1) },
    { competitor: 'TCGplayer', industry: 'tcg', plan_name: 'Pro Seller', price: 49.99, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'TCGplayer', industry: 'tcg', plan_name: 'Pro Seller', price: 59.99, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Moxfield', industry: 'tcg', plan_name: 'Premium', price: 3.99, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Moxfield', industry: 'tcg', plan_name: 'Premium', price: 4.99, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Archidekt', industry: 'tcg', plan_name: 'Premium', price: 2.99, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Archidekt', industry: 'tcg', plan_name: 'Premium', price: 4.99, billing_period: 'monthly', recorded_at: daysAgo(1) },
    { competitor: 'Delver Lens', industry: 'tcg', plan_name: 'Pro', price: 5.99, billing_period: 'monthly', recorded_at: daysAgo(90) },
    { competitor: 'Delver Lens', industry: 'tcg', plan_name: 'Pro', price: 5.99, billing_period: 'monthly', recorded_at: daysAgo(1) },
  ];

  const insertPricing = db.prepare(`
    INSERT INTO recon_pricing (competitor, industry, plan_name, price, billing_period, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const p of pricing) {
    insertPricing.run(p.competitor, p.industry, p.plan_name, p.price, p.billing_period, p.recorded_at);
  }

  // --- Reviews ---
  const reviews = [
    { competitor: 'Tekmetric', industry: 'auto-repair', store: 'App Store', rating: 4.1, review_count: 856, avg_sentiment: 0.62, positive_pct: 65, negative_pct: 20, neutral_pct: 15, top_complaints: 'Price increases, occasional sync issues, slow customer support', top_praises: 'Clean UI, great reporting, digital inspections' },
    { competitor: 'Tekmetric', industry: 'auto-repair', store: 'Google Play', rating: 3.8, review_count: 423, avg_sentiment: 0.55, positive_pct: 58, negative_pct: 25, neutral_pct: 17, top_complaints: 'Android app crashes, missing features vs iOS', top_praises: 'Easy to learn, good integrations' },
    { competitor: 'Shopmonkey', industry: 'auto-repair', store: 'App Store', rating: 4.5, review_count: 1203, avg_sentiment: 0.78, positive_pct: 80, negative_pct: 10, neutral_pct: 10, top_complaints: 'Limited reporting, no multi-location', top_praises: 'Best mobile experience, fast setup, great support' },
    { competitor: 'Shopmonkey', industry: 'auto-repair', store: 'Google Play', rating: 4.3, review_count: 678, avg_sentiment: 0.72, positive_pct: 75, negative_pct: 12, neutral_pct: 13, top_complaints: 'Occasional slow loading, limited customization', top_praises: 'Intuitive interface, reliable notifications' },
    { competitor: 'Mitchell 1', industry: 'auto-repair', store: 'App Store', rating: 3.2, review_count: 345, avg_sentiment: 0.38, positive_pct: 40, negative_pct: 38, neutral_pct: 22, top_complaints: 'Outdated UI, steep learning curve, frequent downtime', top_praises: 'Comprehensive data, repair info integration' },
    { competitor: 'Shop-Ware', industry: 'auto-repair', store: 'App Store', rating: 4.0, review_count: 234, avg_sentiment: 0.65, positive_pct: 68, negative_pct: 18, neutral_pct: 14, top_complaints: 'Pricing opacity, complex setup', top_praises: 'Powerful inventory, good for multi-location' },
    { competitor: 'AutoLeap', industry: 'auto-repair', store: 'App Store', rating: 4.4, review_count: 167, avg_sentiment: 0.75, positive_pct: 78, negative_pct: 10, neutral_pct: 12, top_complaints: 'Newer platform, fewer integrations', top_praises: 'Affordable, modern design, good onboarding' },
    { competitor: 'TCGplayer', industry: 'tcg', store: 'App Store', rating: 3.6, review_count: 2340, avg_sentiment: 0.42, positive_pct: 45, negative_pct: 35, neutral_pct: 20, top_complaints: 'High fees, seller disputes, shipping issues', top_praises: 'Largest marketplace, price tracking, easy buying' },
    { competitor: 'Moxfield', industry: 'tcg', store: 'App Store', rating: 4.7, review_count: 890, avg_sentiment: 0.88, positive_pct: 90, negative_pct: 5, neutral_pct: 5, top_complaints: 'Occasional search lag, no offline mode', top_praises: 'Best deck builder, clean interface, fast updates' },
    { competitor: 'Delver Lens', industry: 'tcg', store: 'App Store', rating: 4.0, review_count: 567, avg_sentiment: 0.60, positive_pct: 62, negative_pct: 22, neutral_pct: 16, top_complaints: 'Scan accuracy declining, subscription price', top_praises: 'Fast scanning, good collection tracking' },
    { competitor: 'Delver Lens', industry: 'tcg', store: 'Google Play', rating: 3.5, review_count: 1456, avg_sentiment: 0.48, positive_pct: 50, negative_pct: 30, neutral_pct: 20, top_complaints: 'Crashes on older devices, poor foil detection', top_praises: 'Free tier available, bulk scanning' },
  ];

  const insertReview = db.prepare(`
    INSERT INTO recon_reviews (competitor, industry, store, rating, review_count, avg_sentiment, positive_pct, negative_pct, neutral_pct, top_complaints, top_praises, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const r of reviews) {
    insertReview.run(r.competitor, r.industry, r.store, r.rating, r.review_count, r.avg_sentiment, r.positive_pct, r.negative_pct, r.neutral_pct, r.top_complaints, r.top_praises);
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// GET /api/recon/mentions — recent mentions with optional filters
router.get('/mentions', (req, res) => {
  try {
    ensureTables();
    seedDemoData();
    const db = getDb();

    const { industry, source, product, unread, limit } = req.query;
    let sql = 'SELECT * FROM recon_mentions WHERE 1=1';
    const params = [];

    if (industry) { sql += ' AND industry = ?'; params.push(industry); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (product) { sql += ' AND product = ?'; params.push(product); }
    if (unread === '1') { sql += ' AND is_read = 0'; }

    sql += ' ORDER BY published_at DESC LIMIT ?';
    params.push(parseInt(limit) || 50);

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recon/pricing — competitor pricing history
router.get('/pricing', (req, res) => {
  try {
    ensureTables();
    seedDemoData();
    const db = getDb();

    const { industry, competitor } = req.query;
    let sql = 'SELECT * FROM recon_pricing WHERE 1=1';
    const params = [];

    if (industry) { sql += ' AND industry = ?'; params.push(industry); }
    if (competitor) { sql += ' AND competitor = ?'; params.push(competitor); }

    sql += ' ORDER BY competitor, plan_name, recorded_at ASC';

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recon/reviews — app store review sentiment
router.get('/reviews', (req, res) => {
  try {
    ensureTables();
    seedDemoData();
    const db = getDb();

    const { industry, competitor } = req.query;
    let sql = 'SELECT * FROM recon_reviews WHERE 1=1';
    const params = [];

    if (industry) { sql += ' AND industry = ?'; params.push(industry); }
    if (competitor) { sql += ' AND competitor = ?'; params.push(competitor); }

    sql += ' ORDER BY competitor, store';

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recon/trends — mention frequency by day
router.get('/trends', (req, res) => {
  try {
    ensureTables();
    seedDemoData();
    const db = getDb();

    const { industry, days } = req.query;
    const dayLimit = parseInt(days) || 30;

    let sql = `
      SELECT
        date(published_at) as day,
        industry,
        COUNT(*) as mention_count,
        SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral
      FROM recon_mentions
      WHERE published_at >= datetime('now', ?)
    `;
    const params = [`-${dayLimit} days`];

    if (industry) { sql += ' AND industry = ?'; params.push(industry); }

    sql += ' GROUP BY day, industry ORDER BY day ASC';

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recon/summary — overview counts
router.get('/summary', (req, res) => {
  try {
    ensureTables();
    seedDemoData();
    const db = getDb();

    const total = db.prepare('SELECT COUNT(*) as c FROM recon_mentions').get().c;
    const unread = db.prepare('SELECT COUNT(*) as c FROM recon_mentions WHERE is_read = 0').get().c;
    const actionable = db.prepare('SELECT COUNT(*) as c FROM recon_mentions WHERE is_actionable = 1').get().c;

    const byIndustry = db.prepare(`
      SELECT industry, COUNT(*) as count
      FROM recon_mentions
      GROUP BY industry
    `).all();

    const bySource = db.prepare(`
      SELECT source, COUNT(*) as count
      FROM recon_mentions
      GROUP BY source
    `).all();

    const bySentiment = db.prepare(`
      SELECT sentiment, COUNT(*) as count
      FROM recon_mentions
      GROUP BY sentiment
    `).all();

    const competitorCount = db.prepare('SELECT COUNT(DISTINCT competitor) as c FROM recon_pricing').get().c;
    const reviewCount = db.prepare('SELECT COUNT(*) as c FROM recon_reviews').get().c;

    res.json({
      total_mentions: total,
      unread_mentions: unread,
      actionable_mentions: actionable,
      competitors_tracked: competitorCount,
      review_sources: reviewCount,
      by_industry: byIndustry,
      by_source: bySource,
      by_sentiment: bySentiment,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recon/mentions/:id/read — mark mention as read
router.post('/mentions/:id/read', (req, res) => {
  try {
    ensureTables();
    const db = getDb();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    db.prepare('UPDATE recon_mentions SET is_read = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recon/mentions/:id/actionable — toggle actionable
router.post('/mentions/:id/actionable', (req, res) => {
  try {
    ensureTables();
    const db = getDb();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    db.prepare('UPDATE recon_mentions SET is_actionable = CASE WHEN is_actionable = 0 THEN 1 ELSE 0 END WHERE id = ?').run(id);
    const row = db.prepare('SELECT is_actionable FROM recon_mentions WHERE id = ?').get(id);
    res.json({ ok: true, is_actionable: row ? row.is_actionable : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recon/mentions/mark-all-read — mark all as read
router.post('/mentions/mark-all-read', (req, res) => {
  try {
    ensureTables();
    const db = getDb();
    const { industry } = req.query;

    if (industry) {
      db.prepare('UPDATE recon_mentions SET is_read = 1 WHERE industry = ?').run(industry);
    } else {
      db.prepare('UPDATE recon_mentions SET is_read = 1').run();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
