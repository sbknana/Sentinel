/**
 * Sentinel Unified Navigation Bar
 * Copyright 2026, Forgeborn
 *
 * Self-contained nav component injected into all Sentinel pages.
 * Include via <script src="/sentinel-nav.js"></script> before </head>.
 */
(function () {
  'use strict';

  const TABS = [
    { id: 'nexus',  label: 'Nexus',  icon: '\u2B21', href: '/nexus.html', desc: 'Command Center' },
    { id: 'guard',  label: 'Guard',  icon: '\uD83D\uDEE1\uFE0F', href: '/guard.html', desc: 'Security' },
    { id: 'recon',  label: 'Recon',  icon: '\uD83D\uDD2D', href: '/recon.html', desc: 'Intelligence' },
    { id: 'voice',  label: 'Voice',  icon: '\uD83C\uDF99\uFE0F', href: '/voice.html', desc: 'AI Command' },
  ];

  // Detect current page
  const path = window.location.pathname;
  function getActiveId() {
    if (path === '/' || path === '/index.html') return 'nexus';
    for (const t of TABS) {
      if (path === t.href) return t.id;
    }
    return '';
  }
  const activeId = getActiveId();

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = `
    /* ============================================
       SENTINEL UNIFIED NAVIGATION
       ============================================ */
    .sentinel-nav {
      position: sticky;
      top: 0;
      z-index: 9000;
      background: rgba(10, 10, 15, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid rgba(245, 158, 11, 0.15);
      padding: 0 24px;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }

    .sentinel-nav-inner {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      height: 52px;
      gap: 0;
    }

    /* Brand */
    .sentinel-nav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-right: 32px;
      text-decoration: none;
      color: #f59e0b;
      flex-shrink: 0;
    }

    .sentinel-nav-brand-icon {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: #0a0a0f;
      font-weight: 800;
      letter-spacing: -1px;
    }

    .sentinel-nav-brand-text {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #e2e8f0;
    }

    .sentinel-nav-brand-sub {
      font-size: 10px;
      color: #64748b;
      font-weight: 400;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    /* Tab links */
    .sentinel-nav-tabs {
      display: flex;
      align-items: stretch;
      height: 52px;
      gap: 0;
      flex: 1;
    }

    .sentinel-nav-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 18px;
      height: 100%;
      color: #94a3b8;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      border-bottom: 2px solid transparent;
      transition: color 0.2s, border-color 0.2s, background 0.15s;
      position: relative;
      white-space: nowrap;
    }

    .sentinel-nav-tab:hover {
      color: #e2e8f0;
      background: rgba(245, 158, 11, 0.05);
    }

    .sentinel-nav-tab.active {
      color: #f59e0b;
      border-bottom-color: #f59e0b;
    }

    .sentinel-nav-tab-icon {
      font-size: 16px;
      line-height: 1;
    }

    .sentinel-nav-tab-label {
      line-height: 1;
    }

    .sentinel-nav-tab-desc {
      font-size: 10px;
      color: #64748b;
      display: none;
    }

    /* Badges */
    .sentinel-nav-badge {
      position: absolute;
      top: 10px;
      right: 8px;
      min-width: 16px;
      height: 16px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      line-height: 1;
    }

    .sentinel-nav-badge.red-dot {
      display: flex;
      background: #ef4444;
      color: #fff;
      min-width: 8px;
      height: 8px;
      padding: 0;
      top: 12px;
      right: 10px;
    }

    .sentinel-nav-badge.count-badge {
      display: flex;
      background: #3b82f6;
      color: #fff;
    }

    /* Right side status */
    .sentinel-nav-status {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .sentinel-nav-clock {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: #64748b;
    }

    /* Hamburger (mobile) */
    .sentinel-nav-hamburger {
      display: none;
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 22px;
      cursor: pointer;
      padding: 4px 8px;
      margin-left: auto;
      line-height: 1;
    }

    .sentinel-nav-hamburger:hover {
      color: #f59e0b;
    }

    /* Mobile */
    @media (max-width: 768px) {
      .sentinel-nav-inner {
        flex-wrap: wrap;
        height: auto;
        min-height: 48px;
        padding: 0;
      }

      .sentinel-nav-brand {
        margin-right: auto;
        padding: 10px 0;
      }

      .sentinel-nav-hamburger {
        display: block;
      }

      .sentinel-nav-tabs {
        display: none;
        flex-direction: column;
        width: 100%;
        height: auto;
        border-top: 1px solid rgba(245, 158, 11, 0.1);
        padding-bottom: 8px;
      }

      .sentinel-nav-tabs.open {
        display: flex;
      }

      .sentinel-nav-tab {
        height: 44px;
        padding: 0 12px;
        border-bottom: none;
        border-left: 3px solid transparent;
        border-radius: 0;
      }

      .sentinel-nav-tab.active {
        border-left-color: #f59e0b;
        border-bottom-color: transparent;
        background: rgba(245, 158, 11, 0.06);
      }

      .sentinel-nav-tab-desc {
        display: inline;
        margin-left: 4px;
      }

      .sentinel-nav-badge {
        position: static;
        margin-left: auto;
      }

      .sentinel-nav-badge.red-dot {
        min-width: 8px;
        height: 8px;
      }

      .sentinel-nav-status {
        display: none;
      }
    }

    /* Push page content below nav */
    .sentinel-nav + .container,
    .sentinel-nav + div.container,
    .sentinel-nav ~ .container {
      /* Existing pages already have padding */
    }
  `;
  document.head.appendChild(style);

  // Build nav HTML
  function buildNav() {
    const nav = document.createElement('nav');
    nav.className = 'sentinel-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Sentinel main navigation');

    const inner = document.createElement('div');
    inner.className = 'sentinel-nav-inner';

    // Brand
    inner.innerHTML = `
      <a href="/nexus.html" class="sentinel-nav-brand" title="Sentinel - Forgeborn Infrastructure">
        <div class="sentinel-nav-brand-icon">S</div>
        <div>
          <div class="sentinel-nav-brand-text">Sentinel</div>
          <div class="sentinel-nav-brand-sub">Forgeborn</div>
        </div>
      </a>
      <button class="sentinel-nav-hamburger" id="sentinelHamburger" aria-label="Toggle navigation" aria-expanded="false">&#9776;</button>
      <div class="sentinel-nav-tabs" id="sentinelTabs">
        ${TABS.map(t => `
          <a href="${t.href}" class="sentinel-nav-tab${t.id === activeId ? ' active' : ''}" data-tab-id="${t.id}">
            <span class="sentinel-nav-tab-icon">${t.icon}</span>
            <span class="sentinel-nav-tab-label">${t.label}</span>
            <span class="sentinel-nav-tab-desc">${t.desc}</span>
            <span class="sentinel-nav-badge" id="sentinelBadge-${t.id}"></span>
          </a>
        `).join('')}
      </div>
      <div class="sentinel-nav-status">
        <span class="sentinel-nav-clock" id="sentinelClock">--:--</span>
      </div>
    `;

    nav.appendChild(inner);
    return nav;
  }

  // Insert nav at top of body
  function init() {
    const nav = buildNav();
    document.body.insertBefore(nav, document.body.firstChild);

    // Hamburger toggle
    const hamburger = document.getElementById('sentinelHamburger');
    const tabs = document.getElementById('sentinelTabs');
    if (hamburger && tabs) {
      hamburger.addEventListener('click', function () {
        const isOpen = tabs.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    // Clock
    updateClock();
    setInterval(updateClock, 30000);

    // Badge polling
    fetchBadges();
    setInterval(fetchBadges, 60000);
  }

  function updateClock() {
    const el = document.getElementById('sentinelClock');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Fetch badge data from APIs
  async function fetchBadges() {
    try {
      await Promise.allSettled([
        fetchGuardBadge(),
        fetchReconBadge(),
      ]);
    } catch (_) { /* silent */ }
  }

  async function fetchGuardBadge() {
    try {
      const res = await fetch('/api/guard/ssl');
      if (!res.ok) return;
      const data = await res.json();
      const badgeEl = document.getElementById('sentinelBadge-guard');
      if (!badgeEl) return;

      // Check if any certs are expiring soon (< 14 days) or expired
      let hasIssue = false;
      if (Array.isArray(data)) {
        hasIssue = data.some(cert => cert.days_remaining != null && cert.days_remaining < 14);
      }

      // Also check services
      try {
        const svcRes = await fetch('/api/guard/services');
        if (svcRes.ok) {
          const svcData = await svcRes.json();
          if (Array.isArray(svcData)) {
            hasIssue = hasIssue || svcData.some(s => s.status !== 'up' && s.status !== 'ok');
          }
        }
      } catch (_) {}

      if (hasIssue) {
        badgeEl.className = 'sentinel-nav-badge red-dot';
        badgeEl.textContent = '';
      } else {
        badgeEl.className = 'sentinel-nav-badge';
        badgeEl.style.display = 'none';
      }
    } catch (_) { /* silent */ }
  }

  async function fetchReconBadge() {
    try {
      const res = await fetch('/api/recon/summary');
      if (!res.ok) return;
      const data = await res.json();
      const badgeEl = document.getElementById('sentinelBadge-recon');
      if (!badgeEl) return;

      const unreadCount = data.unread_mentions || 0;

      if (unreadCount > 0) {
        badgeEl.className = 'sentinel-nav-badge count-badge';
        badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      } else {
        badgeEl.className = 'sentinel-nav-badge';
        badgeEl.style.display = 'none';
      }
    } catch (_) { /* silent */ }
  }

  // Run when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
