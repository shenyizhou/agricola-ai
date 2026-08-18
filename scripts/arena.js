#!/usr/bin/env node
/**
 * Arena - Pit AI policies against each other and collect statistics.
 *
 * Usage:
 *   node scripts/arena.js                     # MCTS vs 3 greedy, 10 games
 *   node scripts/arena.js --games 100         # more games
 *   node scripts/arena.js --p1 mcts --p2 random --p3 random --p4 random
 *   node scripts/arena.js --iter 500          # MCTS iterations
 *
 * Policies: random, greedy, mcts, mcts-fast (100 iter), mcts-strong (1000 iter)
 */

const { GameEngine } = require('../js/engine/GameEngine');
const { randomPolicy, greedyPolicy, stagedRolloutPolicy } = require('../js/ai/heuristic-ai');
const { MCTSAI } = require('../js/ai/mcts');

// ======================== Policy Factory ========================

function makePolicy(name, options = {}) {
  switch (name) {
    case 'random':
      return { name: 'random', fn: randomPolicy };
    case 'greedy':
      return { name: 'greedy', fn: greedyPolicy };
    case 'mcts-fast':
      return makeMCTSPolicy(100, options);
    case 'mcts':
      return makeMCTSPolicy(options.iterations || 300, options);
    case 'mcts-strong':
      return makeMCTSPolicy(1000, options);
    default:
      console.error(`Unknown policy: ${name}`);
      process.exit(1);
  }
}

function makeMCTSPolicy(iterations, options) {
  const rolloutPolicy =
    options.rollout === 'greedy' ? greedyPolicy :
    options.rollout === 'random' ? randomPolicy :
    stagedRolloutPolicy; // default: staged, the strongest scripted rollout
  const ai = new MCTSAI({
    iterations,
    exploration: options.exploration ?? 1.4,
    rolloutPolicy,
    verbose: false,
  });
  return {
    name: `mcts(${iterations})`,
    fn: (engine, actions) => ai.selectAction(engine),
  };
}

// ======================== Argument Parsing ========================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    games: 10,
    players: ['mcts', 'greedy', 'greedy', 'greedy'],
    iterations: 300,
    output: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--games') config.games = parseInt(args[++i]);
    else if (args[i] === '--p1') config.players[0] = args[++i];
    else if (args[i] === '--p2') config.players[1] = args[++i];
    else if (args[i] === '--p3') config.players[2] = args[++i];
    else if (args[i] === '--p4') config.players[3] = args[++i];
    else if (args[i] === '--iter') config.iterations = parseInt(args[++i]);
    else if (args[i] === '--output') config.output = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/arena.js [options]

Options:
  --games N         Number of games (default: 10)
  --p1 policy       Player 1 policy (default: mcts)
  --p2 policy       Player 2 policy (default: greedy)
  --p3 policy       Player 3 policy (default: greedy)
  --p4 policy       Player 4 policy (default: greedy)
  --iter N          MCTS iterations (default: 300)
  --output FILE     Save game logs as JSON

Policies: random, greedy, mcts-fast (100 iter), mcts (300 iter), mcts-strong (1000 iter)

Examples:
  node scripts/arena.js --games 100
  node scripts/arena.js --p1 mcts-strong --p2 mcts-fast --p3 greedy --p4 random
  node scripts/arena.js --games 50 --iter 500
`);
      process.exit(0);
    }
  }
  return config;
}

// ======================== Main ========================

function main() {
  const config = parseArgs();
  const policies = config.players.map(name => makePolicy(name, { iterations: config.iterations }));

  console.log(`\nAgricola Arena: ${config.games} games`);
  console.log('Players:', policies.map(p => p.name).join(' vs '));
  console.log('─'.repeat(50));

  const stats = policies.map((p, i) => ({
    name: p.name,
    playerId: i,
    wins: 0,
    totalScore: 0,
    ranks: [0, 0, 0, 0],
  }));

  const gameLogs = [];
  const start = Date.now();

  for (let g = 0; g < config.games; g++) {
    const engine = new GameEngine(4);
    engine.init();
    const moves = [];

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) {
        engine.state.turnIdx++;
        continue;
      }
      const pIdx = engine.currentPlayer.id;
      const action = policies[pIdx].fn(engine, actions);
      if (action) {
        moves.push({ round: engine.state.round, player: pIdx, action: action.label || action.id });
        engine.applyAction(action);
      }
    }

    const sorted = [...engine.state.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, rank) => {
      stats[p.id].wins += rank === 0 ? 1 : 0;
      stats[p.id].totalScore += p.score;
      stats[p.id].ranks[rank]++;
    });

    if (config.output) {
      gameLogs.push({
        game: g,
        finalScores: sorted.map(p => ({ id: p.id, score: p.score })),
        moves,
      });
    }

    process.stdout.write('.');
  }

  const elapsed = (Date.now() - start) / 1000;
  console.log('\n');

  // Print results table
  console.log('Results:');
  console.log('─'.repeat(70));
  console.log(
    'Player'.padEnd(18),
    'Win%'.padStart(7),
    'AvgScore'.padStart(9),
    '1st'.padStart(5),
    '2nd'.padStart(5),
    '3rd'.padStart(5),
    '4th'.padStart(5),
  );
  console.log('─'.repeat(70));
  for (const s of stats) {
    console.log(
      `P${s.playerId} ${s.name}`.padEnd(18),
      (s.wins / config.games * 100).toFixed(0).padStart(6) + '%',
      (s.totalScore / config.games).toFixed(1).padStart(9),
      String(s.ranks[0]).padStart(5),
      String(s.ranks[1]).padStart(5),
      String(s.ranks[2]).padStart(5),
      String(s.ranks[3]).padStart(5),
    );
  }
  console.log('─'.repeat(70));
  console.log(`Time: ${elapsed.toFixed(1)}s (${(config.games/elapsed).toFixed(1)} games/sec)`);

  if (config.output) {
    require('fs').writeFileSync(config.output, JSON.stringify(gameLogs, null, 2));
    console.log(`\nGame logs saved to ${config.output}`);
  }
}

main();
