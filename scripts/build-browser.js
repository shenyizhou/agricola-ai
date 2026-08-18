#!/usr/bin/env node
/**
 * Build script: bundles all engine + AI modules into a single browser file.
 *
 * Usage: node scripts/build-browser.js
 * Output: js/agricola-engine.bundle.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'js', 'agricola-engine.bundle.js');

// Files in dependency order
const FILES = [
  'js/constants.js',
  'js/data/cards.js',
  'js/engine/GameState.js',
  'js/engine/card-effects.js',
  'js/engine/GameEngine.js',
  'js/ai/heuristic-ai.js',
  'js/ai/mcts.js',
];

function stripModuleExports(content) {
  // Remove "const X = require(...)" lines - we'll inline everything
  content = content.replace(/const\s*\{[^}]+\}\s*=\s*require\([^)]+\);?\n/g, '');
  content = content.replace(/const\s+\w+\s*=\s*require\([^)]+\);?\n/g, '');
  // Remove module.exports block at the end
  content = content.replace(/\nmodule\.exports\s*=\s*\{[^}]*\};?\s*$/s, '');
  return content;
}

function build() {
  let out = `/**
 * Agricola Engine + AI Bundle (auto-generated)
 * Includes: constants, GameState, GameEngine, heuristic AI, MCTS
 *
 * Usage:
 *   const engine = new Agricola.GameEngine(4);
 *   const ai = new Agricola.MCTSAI({ iterations: 1000 });
 */
(function(global) {
  'use strict';

`;

  for (const file of FILES) {
    const filePath = path.join(ROOT, file);
    let content = fs.readFileSync(filePath, 'utf-8');
    content = stripModuleExports(content);
    out += `\n// ===== ${file} =====\n`;
    out += content;
    out += '\n';
  }

  // Export globals
  out += `
  global.Agricola = {
    GameEngine,
    EventEmitter,
    createInitialState,
    createPlayer,
    cloneState,
    evaluateState,
    greedyPolicy,
    randomPolicy,
    stagedRolloutPolicy,
    pruneDominatedActions,
    MCTSAI,
    MCTSNode,
    createMCTSPolicy,
    cloneEngineForSimulation,
    CardEffectSystem,
    dealOpeningHands,
    getCard,
    CARDS_BY_ID,
    OCCUPATIONS,
    MINORS,
    ALL_CARDS,
    // constants
    LIMIT_FENCES,
    LIMIT_STABLES,
    MAX_ROUNDS,
    HARVEST_ROUNDS,
    SCORING_TIERS,
    DB_MAJORS,
    BASE_ACTIONS,
    ROUND_CARDS_POOL,
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;

  fs.writeFileSync(OUTPUT, out, 'utf-8');
  const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(`Bundle written: js/agricola-engine.bundle.js (${size} KB)`);
}

build();
