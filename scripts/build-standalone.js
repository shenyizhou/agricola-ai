#!/usr/bin/env node
/**
 * Build a single self-contained HTML file by inlining the two <script> tags
 * (agricola-engine.bundle.js and browser-game.js) into index.html.
 *
 * Usage: node scripts/build-standalone.js
 * Output: dist/agricola-standalone.html
 *
 * Google Fonts stay as an external <link>; the page degrades gracefully to
 * system fonts when offline.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_HTML = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_HTML = path.join(OUT_DIR, 'agricola-standalone.html');

const SCRIPTS = [
  'js/agricola-engine.bundle.js',
  'js/browser-game.js',
];

function build() {
  let html = fs.readFileSync(SRC_HTML, 'utf-8');

  for (const rel of SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const tag = `<script src="${rel}"></script>`;
    if (!html.includes(tag)) {
      throw new Error(`Expected tag not found in index.html: ${tag}`);
    }
    html = html.replace(tag, `<script>\n${code}\n</script>`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_HTML, html, 'utf-8');

  const kb = (fs.statSync(OUT_HTML).size / 1024).toFixed(1);
  console.log(`Standalone build written: dist/agricola-standalone.html (${kb} KB)`);
}

build();
