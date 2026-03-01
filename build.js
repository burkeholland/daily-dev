#!/usr/bin/env node
// Generates docs/index.html from live GitHub notifications for GitHub Pages.
const fs = require('fs');
const path = require('path');

const { fetchNotifications, renderPage } = require('./server');

try {
  console.log('📡 Fetching notifications...');
  const notifications = fetchNotifications();
  console.log(`📬 Got ${notifications.length} notifications`);
  const html = renderPage(notifications);
  const docsDir = path.join(__dirname, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'index.html'), html, 'utf8');
  console.log(`✅ Built docs/index.html (${(html.length / 1024).toFixed(1)}KB)`);
} catch (err) {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
}
