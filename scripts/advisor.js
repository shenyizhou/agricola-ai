#!/usr/bin/env node
/**
 * Advisor - Analyze a game position and recommend moves.
 *
 * Runs MCTS and prints all candidate actions ranked by win rate,
 * so you can see what the AI would do and learn from it.
 *
 * For now, starts from a fresh game. Can be extended to load positions.
 *
 * Usage:
 *   node scripts/advisor.js                    # analyze opening
 *   node scripts/advisor.js --round 5          # simulate to round 5 then analyze
 *   node scripts/advisor.js --iter 1000        # more iterations
 */

const { GameEngine } = require('../js/engine/GameEngine');
const { MCTSAI } = require('../js/ai/mcts');
const { randomPolicy, greedyPolicy } = require('../js/ai/heuristic-ai');
const { cloneState } = require('../js/engine/GameState');

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { iterations: 1000, round: 1, randomSim: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iter') config.iterations = parseInt(args[++i]);
    if (args[i] === '--round') config.round = parseInt(args[++i]);
    if (args[i] === '--random') config.randomSim = true;
  }
  return config;
}

// Simulate forward with random/greedy moves to reach a target round
function simulateToRound(engine, targetRound) {
  while (engine.state.round < targetRound && !engine.isGameOver) {
    const actions = engine.getActions();
    if (actions.length === 0) { engine.state.turnIdx++; continue; }
    const action = greedyPolicy(engine, actions);
    engine.applyAction(action);
  }
}

function main() {
  const config = parseArgs();
  const engine = new GameEngine(4);
  engine.init();

  if (config.round > 1) {
    simulateToRound(engine, config.round);
  }

  const round = engine.state.round;
  const player = engine.currentPlayer;
  const actions = engine.getActions();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           Agricola Move Advisor                 ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`Round: ${round}    Your resources:`);
  console.log(`  Wood:${player.res.wood}  Clay:${player.res.clay}  Reed:${player.res.reed}  Stone:${player.res.stone}`);
  console.log(`  Food:${player.res.food}  Grain:${player.res.grain}  Veg:${player.res.veg}`);
  console.log(`  Sheep:${player.animals.sheep}  Boar:${player.animals.boar}  Cow:${player.animals.cow}`);
  console.log(`  Workers:${player.res.workers}/${player.res.maxWorkers}  Rooms:${player.farm.filter(t=>t===1).length}  Fields:${player.farm.filter(t=>t===2).length}`);
  console.log(`\nAnalyzing ${actions.length} available actions with ${config.iterations} iterations...\n`);

  // Custom MCTS that collects stats
  const ai = new MCTSAI({ iterations: config.iterations, verbose: false });
  ai.playerId = player.id;

  const { cloneEngineForSimulation } = require('../js/ai/heuristic-ai');
  const rootEngine = cloneEngineForSimulation(engine);
  const { MCTSNode } = require('../js/ai/mcts');
  const root = new MCTSNode(rootEngine);
  root.unexploredActions = rootEngine.getActions();

  for (let i = 0; i < config.iterations; i++) {
    const node = ai._select(root);
    const reward = ai._simulate(node);
    ai._backpropagate(node, reward);
  }

  // Rank children by visits
  const ranked = [...root.children].sort((a, b) => b.visits - a.visits);

  console.log('Rank  Action                          WinRate   Visits');
  console.log('─'.repeat(60));
  ranked.forEach((child, rank) => {
    const winRate = (child.value / child.visits * 100).toFixed(1);
    const label = (child.actionFromParent.label || child.actionFromParent.id).padEnd(30);
    const marker = rank === 0 ? ' ★' : '';
    console.log(
      `#${rank + 1}`.padEnd(5),
      label,
      winRate.padStart(6) + '%',
      String(child.visits).padStart(7),
      marker,
    );
  });

  console.log('\n★ = recommended move');
  console.log('\nTip: Win rate reflects how often MCTS simulations led to a win');
  console.log('     after taking that action. Higher = better.\n');
}

main();
