const express = require('express');
const { execSync } = require('child_process');
const app = express();
const PORT = 4242;

process.on('uncaughtException', (err) => { console.error('Uncaught:', err.message); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

// --- Scoring ---
function scoreNotification(n) {
  let score = 0;
  const reasonScores = { mention: 50, review_requested: 40, assign: 35, author: 15, comment: 5 };
  score += reasonScores[n.reason] || 0;
  const typeScores = { SecurityAdvisory: 60, PullRequest: 20, Issue: 10, Release: 5 };
  score += typeScores[n.subject?.type] || 0;
  if (n.unread && n.updated_at) {
    const age = Date.now() - new Date(n.updated_at).getTime();
    if (age > 24 * 60 * 60 * 1000) score += 10;
  }
  if (n.repository?.private) score += 5;
  return score;
}

// --- Headline Generation ---
function truncateWords(str, max) {
  const words = (str || '').split(/\s+/);
  return words.length <= max ? str : words.slice(0, max).join(' ') + '…';
}

function generateHeadline(n, style = 'lead') {
  const title = n.subject?.title || 'Untitled';
  const repo = n.repository?.full_name?.split('/')[1] || n.repository?.full_name || 'REPO';
  const type = n.subject?.type === 'PullRequest' ? 'PR' : n.subject?.type || 'Item';

  if (style === 'lead') {
    switch (n.reason) {
      case 'review_requested': return `LOCAL DEVELOPER SUMMONED TO REVIEW ${truncateWords(title, 6).toUpperCase()}`;
      case 'mention': return `YOUR NAME INVOKED IN ${repo.toUpperCase()} DISCUSSION`;
      case 'assign': return `RESPONSIBILITY ASSIGNED: ${truncateWords(title, 6).toUpperCase()}`;
      case 'comment': return `NEW DEVELOPMENT IN ${truncateWords(title, 6).toUpperCase()}`;
      case 'author': return `YOUR ${type.toUpperCase()} DRAWS ATTENTION`;
      case 'security_advisory': return `⚠ SECURITY BULLETIN: ${title.toUpperCase()}`;
      default: return truncateWords(title, 8).toUpperCase();
    }
  } else {
    switch (n.reason) {
      case 'review_requested': return `Dev Summoned to Review ${truncateWords(title, 6)}`;
      case 'mention': return `Mentioned in ${repo}: ${truncateWords(title, 6)}`;
      case 'assign': return `Assigned: ${truncateWords(title, 6)}`;
      case 'comment': return `New Development in ${truncateWords(title, 6)}`;
      case 'author': return `Your ${type} Draws Comments`;
      case 'security_advisory': return `⚠ Security: ${truncateWords(title, 6)}`;
      default: return truncateWords(title, 8);
    }
  }
}

// --- Data Fetching ---
const GH_ENV = { ...process.env, GH_PAGER: 'cat', NO_PAGER: '1', PAGER: 'cat' };

function fetchNotifications() {
  const output = execSync('gh api "notifications?per_page=50&all=false"', { encoding: 'utf8', timeout: 15000, env: GH_ENV });
  return JSON.parse(output);
}

function enrichNotification(n) {
  try {
    if (!n.subject?.url) return n;
    const apiPath = n.subject.url.replace('https://api.github.com/', '');
    const detail = JSON.parse(execSync(`gh api "${apiPath}"`, { encoding: 'utf8', timeout: 10000, env: GH_ENV }));
    n._detail = {
      body: (detail.body || '').slice(0, 300),
      comments: detail.comments || 0,
      state: detail.state,
      labels: (detail.labels || []).map(l => l.name),
      user: detail.user?.login,
      html_url: detail.html_url
    };
  } catch (e) { /* enrichment is optional */ }
  return n;
}

// --- Date/Edition helpers ---
function getDateInfo() {
  const now = new Date();
  const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const hour = now.getHours();
  const edition = hour < 12 ? 'Morning Edition' : hour < 18 ? 'Afternoon Edition' : 'Late Edition';
  const epoch = new Date('2024-01-01').getTime();
  const issueNo = Math.floor((now.getTime() - epoch) / (24*60*60*1000));
  return { dateStr, edition, issueNo };
}

// --- Weather Widget ---
function weatherWidget(notifications) {
  const unread = notifications.filter(n => n.unread).length;
  const prs = notifications.filter(n => n.reason === 'review_requested').length;
  const issues = notifications.filter(n => n.reason === 'assign' && n.subject?.type === 'Issue').length;
  let outlook;
  if (unread === 0) outlook = 'Clear skies. Go touch grass.';
  else if (unread <= 3) outlook = 'Light activity. Manageable.';
  else if (unread <= 10) outlook = 'Moderate notification storm.';
  else if (unread <= 20) outlook = 'Heavy inbox weather.';
  else outlook = 'SEVERE ALERT: Notification flood.';
  return { unread, prs, issues, outlook };
}

// --- Accent Color ---
function accentColor(n) {
  if (n.subject?.type === 'SecurityAdvisory') return 'var(--coral)';
  if (n.subject?.type === 'PullRequest') return 'var(--azure)';
  if (n._detail?.state === 'closed' || n._detail?.state === 'merged') return 'var(--sage)';
  return 'var(--black)';
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- HTML Rendering ---
function renderPage(notifications, error = null) {
  const { dateStr, edition, issueNo } = getDateInfo();

  let scored = notifications.map(n => ({ ...n, _score: scoreNotification(n) }));
  scored.sort((a, b) => b._score - a._score);

  // Enrich top items
  scored = scored.map((n, i) => {
    if (n._score >= 40 && i < 6) return enrichNotification(n);
    return n;
  });

  // Always promote top item to lead, bump score if needed
  let lead = [];
  let columns = [];
  if (scored.length > 0) {
    const topItem = scored[0];
    if (topItem._score < 80) topItem._score = 80; // Promote to lead
    lead = [topItem];
    columns = scored.slice(1).filter(n => n._score >= 40 && n._score < 80);
  }
  const belowFold = scored.filter(n => n._score >= 20 && n._score < 40 && !lead.includes(n) && !columns.includes(n));
  const inBrief = scored.filter(n => n._score < 20);

  const weather = weatherWidget(notifications);
  const hasNotifications = notifications.length > 0;

  const leadStory = lead[0];

  function renderLeadStory() {
    if (!leadStory) return '';
    const headline = generateHeadline(leadStory, 'lead');
    const repo = escapeHtml(leadStory.repository?.full_name || '');
    const body = escapeHtml(leadStory._detail?.body || leadStory.subject?.title || '');
    const byline = leadStory._detail?.user || 'Staff Correspondent';
    const url = leadStory._detail?.html_url || leadStory.repository?.html_url || '#';
    const ago = timeAgo(leadStory.updated_at);
    const accent = accentColor(leadStory);
    const labels = (leadStory._detail?.labels || []).slice(0, 3);
    return `
      <section class="lead-story">
        <div class="lead-story-inner" style="border-left: 5px solid ${accent};">
          <div class="lead-kicker">${escapeHtml(repo)} · ${escapeHtml(leadStory.subject?.type || '')} · Score: ${leadStory._score}</div>
          <a href="${escapeHtml(url)}" target="_blank" class="lead-headline-link">
            <h1 class="lead-headline">${escapeHtml(headline)}</h1>
          </a>
          <div class="lead-meta">
            <span class="byline">By ${escapeHtml(byline)}</span>
            <span class="timestamp">${ago}</span>
            ${labels.map(l => `<span class="label">${escapeHtml(l)}</span>`).join('')}
          </div>
          <p class="lead-body">${escapeHtml(body)}</p>
          ${lead.length > 1 ? `<div class="lead-related"><strong>Related:</strong> ${lead.slice(1, 4).map(n => `<span class="related-item">${escapeHtml(generateHeadline(n, 'column'))}</span>`).join(' · ')}</div>` : ''}
        </div>
      </section>`;
  }

  function renderColumnStory(n) {
    const headline = generateHeadline(n, 'column');
    const repo = escapeHtml(n.repository?.full_name || '');
    const body = escapeHtml((n._detail?.body || n.subject?.title || '').slice(0, 150));
    const byline = n._detail?.user || 'Staff';
    const url = n._detail?.html_url || n.repository?.html_url || '#';
    const ago = timeAgo(n.updated_at);
    const accent = accentColor(n);
    return `
      <article class="column-story">
        <div class="story-accent" style="background: ${accent};"></div>
        <div class="story-kicker">${escapeHtml(repo)}</div>
        <a href="${escapeHtml(url)}" target="_blank" class="story-link">
          <h3 class="column-headline">${escapeHtml(headline)}</h3>
        </a>
        <p class="story-body">${body}</p>
        <div class="story-meta">
          <span class="byline">By ${escapeHtml(byline)}</span> · <span class="timestamp">${ago}</span>
        </div>
      </article>`;
  }

  function renderBelowFold() {
    if (belowFold.length === 0) return '';
    return `
      <section class="below-fold">
        <h2 class="section-header section-header--sage">Below the Fold</h2>
        <div class="below-fold-grid">
          ${belowFold.map(n => {
            const headline = generateHeadline(n, 'column');
            const repo = escapeHtml(n.repository?.full_name || '');
            const url = n.repository?.html_url || '#';
            const ago = timeAgo(n.updated_at);
            return `<div class="below-fold-item">
              <div class="story-kicker">${repo}</div>
              <a href="${escapeHtml(url)}" target="_blank"><h4>${escapeHtml(headline)}</h4></a>
              <span class="timestamp">${ago}</span>
            </div>`;
          }).join('')}
        </div>
      </section>`;
  }

  function renderInBrief() {
    if (inBrief.length === 0) return '';
    return `
      <div class="in-brief">
        <h2 class="section-header section-header--coral">In Brief</h2>
        <ul class="brief-list">
          ${inBrief.map(n => {
            const url = n.repository?.html_url || '#';
            const repo = n.repository?.full_name?.split('/')[1] || '';
            return `<li><a href="${escapeHtml(url)}" target="_blank"><strong>${escapeHtml(repo)}</strong>: ${escapeHtml(truncateWords(n.subject?.title || '', 8))}</a> <span class="timestamp">${timeAgo(n.updated_at)}</span></li>`;
          }).join('')}
        </ul>
      </div>`;
  }

  function renderWeather() {
    return `
      <div class="weather-widget">
        <h2 class="section-header section-header--azure">Today's Forecast</h2>
        <div class="weather-bar"></div>
        <div class="weather-stats">
          <div class="weather-stat">⚡ <strong>${weather.unread}</strong> unread notifications</div>
          <div class="weather-stat">🔀 <strong>${weather.prs}</strong> PRs awaiting review</div>
          <div class="weather-stat">🐛 <strong>${weather.issues}</strong> issues assigned</div>
        </div>
        <div class="weather-bar"></div>
        <div class="weather-outlook">Outlook: ${escapeHtml(weather.outlook)}</div>
      </div>`;
  }

  function renderEmptyState() {
    return `
      <section class="lead-story empty-state">
        <div class="lead-story-inner" style="border-left: 5px solid var(--sage); text-align: center; padding: 3rem;">
          <h1 class="lead-headline" style="font-size: 3rem; margin-bottom: 1rem;">SLOW NEWS DAY</h1>
          <p class="lead-body" style="font-size: 1.1rem; max-width: 500px; margin: 0 auto;">
            No notifications to report. The inbox is empty, the PRs are merged, and all is well in the world of code.
          </p>
          <p style="margin-top: 2rem; font-family: 'Space Mono', monospace; color: var(--sage); font-size: 0.9rem;">
            — The Editors
          </p>
        </div>
      </section>`;
  }

  function renderError() {
    return `
      <section class="lead-story empty-state">
        <div class="lead-story-inner" style="border-left: 5px solid var(--coral); text-align: center; padding: 3rem;">
          <h1 class="lead-headline" style="font-size: 2.5rem; margin-bottom: 1rem;">PRESS EMERGENCY</h1>
          <p class="lead-body" style="font-size: 1rem; max-width: 500px; margin: 0 auto;">
            Our reporters were unable to reach GitHub's notification service. Please check your <code>gh</code> CLI authentication and try again.
          </p>
          <p style="margin-top: 1rem; font-family: 'Inter', sans-serif; color: var(--muted); font-size: 0.85rem;">
            ${escapeHtml(String(error || ''))}
          </p>
        </div>
      </section>`;
  }

  // Distribute column stories dynamically based on count
  const numCols = Math.min(columns.length, 3);
  const col1 = [], col2 = [], col3 = [];
  columns.forEach((n, i) => {
    if (numCols === 1) col1.push(n);
    else if (numCols === 2) {
      if (i % 2 === 0) col1.push(n);
      else col2.push(n);
    } else {
      if (i % 3 === 0) col1.push(n);
      else if (i % 3 === 1) col2.push(n);
      else col3.push(n);
    }
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Daily Dev — ${edition}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --coral: #ff7f50;
    --azure: #0ea5e9;
    --sage: #84cc16;
    --black: #111827;
    --cream: #f5f0e8;
    --white: #fafafa;
    --muted: #6b7280;
    --divider: #d1cfc9;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background-color: var(--cream);
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
    color: var(--black);
    font-size: 14px;
    line-height: 1.6;
    min-height: 100vh;
  }
  a { color: inherit; text-decoration: none; }
  a:hover { opacity: 0.8; }

  .newspaper {
    max-width: 1200px;
    margin: 0 auto;
    background: var(--white);
    min-height: 100vh;
    box-shadow: 0 0 60px rgba(0,0,0,0.08);
    position: relative;
  }

  /* --- Masthead --- */
  .masthead {
    padding: 1.5rem 2rem 0;
    text-align: center;
    position: relative;
  }
  .masthead-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }
  .masthead-date {
    font-family: 'Space Mono', monospace;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .masthead-title {
    font-family: 'Space Mono', monospace;
    font-weight: 700;
    font-size: 4rem;
    letter-spacing: 0.15em;
    line-height: 1;
    color: var(--black);
    margin: 0.25rem 0;
  }
  .masthead-tagline {
    font-family: 'Inter', sans-serif;
    font-size: 0.8rem;
    color: var(--muted);
    font-style: italic;
    margin-bottom: 0.75rem;
    letter-spacing: 0.04em;
  }
  .masthead-edition {
    font-family: 'Space Mono', monospace;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .masthead-rule {
    border: none;
    border-top: 3px solid var(--black);
    margin: 0;
  }
  .color-stripe {
    display: flex;
    height: 12px;
  }
  .color-stripe span {
    flex: 1;
  }
  .color-stripe .coral { background: var(--coral); }
  .color-stripe .azure { background: var(--azure); }
  .color-stripe .sage { background: var(--sage); }

  /* --- Content Area --- */
  .content {
    padding: 1.5rem 2rem;
  }

  /* --- Lead Story --- */
  .lead-story {
    margin-bottom: 2rem;
  }
  .lead-story-inner {
    padding: 1.5rem 2rem;
    background: linear-gradient(135deg, rgba(245,240,232,0.3) 0%, transparent 100%);
  }
  .lead-kicker {
    font-family: 'Space Mono', monospace;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .lead-headline {
    font-family: 'Space Mono', monospace;
    font-weight: 700;
    font-size: 2.4rem;
    line-height: 1.1;
    color: var(--black);
    margin-bottom: 0.75rem;
    letter-spacing: -0.01em;
  }
  .lead-headline-link { display: block; }
  .lead-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .byline {
    font-family: 'Inter', sans-serif;
    font-style: italic;
    font-size: 12px;
    color: var(--muted);
  }
  .timestamp {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    color: var(--muted);
  }
  .label {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    background: var(--cream);
    color: var(--black);
    padding: 2px 8px;
    border-radius: 2px;
    letter-spacing: 0.05em;
  }
  .lead-body {
    font-family: 'Inter', sans-serif;
    font-size: 1rem;
    line-height: 1.7;
    color: #374151;
    max-width: 75ch;
  }
  .lead-related {
    margin-top: 1rem;
    font-size: 0.85rem;
    color: var(--muted);
    border-top: 1px solid var(--divider);
    padding-top: 0.75rem;
  }
  .related-item { font-style: italic; }

  /* --- Section Headers --- */
  .section-header {
    font-family: 'Space Mono', monospace;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding-bottom: 0.4rem;
    margin-bottom: 1rem;
    border-bottom: 2px solid currentColor;
  }
  .section-header--coral { color: var(--coral); }
  .section-header--azure { color: var(--azure); }
  .section-header--sage { color: var(--sage); }

  /* --- Main Grid (columns + sidebar) --- */
  .main-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 280px;
    gap: 0;
    border-top: 1px solid var(--divider);
    margin-bottom: 2rem;
  }
  .column {
    padding: 1.25rem;
    border-right: 1px solid var(--divider);
  }
  .column:last-child { border-right: none; }
  .sidebar {
    padding: 1.25rem;
  }

  /* --- Column Stories --- */
  .column-story {
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--divider);
    position: relative;
  }
  .column-story:last-child { border-bottom: none; }
  .story-accent {
    width: 30px;
    height: 3px;
    margin-bottom: 0.5rem;
  }
  .story-kicker {
    font-family: 'Space Mono', monospace;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 0.3rem;
  }
  .column-headline {
    font-family: 'Space Mono', monospace;
    font-weight: 700;
    font-size: 1rem;
    line-height: 1.25;
    color: var(--black);
    margin-bottom: 0.4rem;
  }
  .story-body {
    font-size: 0.85rem;
    line-height: 1.55;
    color: #4b5563;
    margin-bottom: 0.4rem;
  }
  .story-meta {
    font-size: 11px;
    color: var(--muted);
  }
  .story-link { display: block; }

  /* --- In Brief Sidebar --- */
  .in-brief { margin-bottom: 1.5rem; }
  .brief-list {
    list-style: none;
    padding: 0;
  }
  .brief-list li {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--divider);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .brief-list li:last-child { border-bottom: none; }
  .brief-list li strong {
    font-family: 'Space Mono', monospace;
    font-size: 0.7rem;
    text-transform: uppercase;
  }

  /* --- Weather Widget --- */
  .weather-widget {
    margin-bottom: 1.5rem;
  }
  .weather-bar {
    height: 2px;
    background: var(--azure);
    margin: 0.5rem 0;
    opacity: 0.4;
  }
  .weather-stats {
    padding: 0.25rem 0;
  }
  .weather-stat {
    font-size: 0.85rem;
    padding: 0.3rem 0;
    font-family: 'Inter', sans-serif;
  }
  .weather-outlook {
    font-family: 'Space Mono', monospace;
    font-size: 0.75rem;
    font-style: italic;
    color: var(--muted);
    margin-top: 0.3rem;
  }

  /* --- Below the Fold --- */
  .below-fold {
    padding: 1.5rem 0;
    border-top: 1px solid var(--divider);
  }
  .below-fold-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }
  .below-fold-item {
    padding: 0.75rem;
    border-left: 3px solid var(--divider);
  }
  .below-fold-item h4 {
    font-family: 'Space Mono', monospace;
    font-size: 0.85rem;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 0.25rem;
  }

  /* --- Footer --- */
  .footer {
    border-top: 3px solid var(--black);
    padding: 0.75rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: 'Space Mono', monospace;
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.05em;
  }
  .footer-left { }
  .footer-right { text-align: right; }

  /* --- Empty State --- */
  .empty-state {
    padding: 2rem 0;
  }

  /* --- Responsive --- */
  @media (max-width: 900px) {
    .masthead-title { font-size: 2.5rem; }
    .lead-headline { font-size: 1.6rem; }
    .main-grid { grid-template-columns: 1fr 1fr; }
    .sidebar { grid-column: 1 / -1; }
  }
  @media (max-width: 600px) {
    .main-grid { grid-template-columns: 1fr; }
    .masthead-title { font-size: 1.8rem; }
    .content { padding: 1rem; }
  }
</style>
</head>
<body>
<div class="newspaper">
  <!-- Masthead -->
  <header class="masthead">
    <div class="masthead-top">
      <div class="masthead-date">${dateStr}</div>
      <div class="masthead-edition">${edition}</div>
    </div>
    <div class="masthead-title">THE DAILY DEV</div>
    <div class="masthead-tagline">All the Commits That Are Fit to Ship</div>
    <div class="masthead-top">
      <div class="masthead-date">Your GitHub Notifications · Delivered Fresh</div>
      <div class="masthead-edition">VOL. 1, NO. ${issueNo}</div>
    </div>
    <hr class="masthead-rule">
    <div class="color-stripe">
      <span class="coral"></span>
      <span class="azure"></span>
      <span class="sage"></span>
    </div>
  </header>

  <div class="content">
    ${error ? renderError() : (!hasNotifications ? renderEmptyState() : renderLeadStory())}

    ${!error && hasNotifications ? `
    <div class="main-grid" style="grid-template-columns: ${numCols === 1 ? '1fr' : numCols === 2 ? '1fr 1fr' : '1fr 1fr 1fr'} 280px;">
      ${col1.length ? `
      <div class="column">
        <h2 class="section-header section-header--coral">Top Stories</h2>
        ${col1.map(renderColumnStory).join('')}
      </div>` : ''}
      ${col2.length ? `
      <div class="column">
        <h2 class="section-header section-header--azure">Developments</h2>
        ${col2.map(renderColumnStory).join('')}
      </div>` : ''}
      ${col3.length ? `
      <div class="column">
        <h2 class="section-header section-header--sage">Also Noted</h2>
        ${col3.map(renderColumnStory).join('')}
      </div>` : ''}
      <div class="sidebar">
        ${renderWeather()}
        ${renderInBrief()}
      </div>
    </div>
    ${renderBelowFold()}
    ` : `
    <div class="main-grid" style="grid-template-columns: 1fr 280px;">
      <div class="column"></div>
      <div class="sidebar">
        ${renderWeather()}
      </div>
    </div>
    `}
  </div>

  <!-- Footer -->
  <footer class="footer">
    <div class="footer-left">Last updated: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · Refreshing in <span id="countdown">2:00</span></div>
    <div class="footer-right">© The Daily Dev · A Burke Holland Production</div>
  </footer>
</div>

<script>
let secs = 120;
setInterval(() => {
  secs--;
  if (secs <= 0) location.reload();
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  document.getElementById('countdown').textContent = m + ':' + s;
}, 1000);
</script>
</body>
</html>`;
}

// --- Routes ---
app.get('/', (req, res) => {
  try {
    const notifications = fetchNotifications();
    res.send(renderPage(notifications));
  } catch (err) {
    res.send(renderPage([], err.message));
  }
});

app.get('/api/notifications', (req, res) => {
  try {
    const notifications = fetchNotifications();
    const scored = notifications.map(n => ({ ...n, _score: scoreNotification(n) }));
    scored.sort((a, b) => b._score - a._score);
    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`📰 The Daily Dev is hot off the press at http://localhost:${PORT}`);
  });
} else {
  module.exports = { fetchNotifications, renderPage };
}
