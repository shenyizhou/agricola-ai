#!/usr/bin/env node
/**
 * Marginal resource value: how much does +1 resource change win rate?
 * Uses MCTS at specific positions to compute.
 */

const { GameEngine } = require('../js/engine/GameEngine');
const { MCTSAI, MCTSNode } = require('../js/ai/mcts');
const { cloneEngineForSimulation } = require('../js/ai/heuristic-ai');

function computeMarginalValues(rounds = [1, 4, 7, 10], iterations = 300, samples = 20) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 资源边际价值 (MCTS win rate delta for +1 resource)');
  console.log('═══════════════════════════════════════════════════\n');

  const resources = ['food','wood','clay','reed','stone','grain','veg','sheep','boar','cow'];

  for (const targetRound of rounds) {
    console.log(`--- 第 ${targetRound} 轮开局 ---`);

    const deltas = {};
    resources.forEach(r => deltas[r] = []);

    for (let s = 0; s < samples; s++) {
      // Simulate to target round with random play first
      const engine = new GameEngine(4);
      engine.init();
      const ai = new MCTSAI({ iterations: 100, verbose: false });

      while (engine.state.round < targetRound && !engine.isGameOver) {
        const actions = engine.getActions();
        if (actions.length === 0) { engine.state.turnIdx++; continue; }
        engine.applyAction(actions[Math.floor(Math.random() * actions.length)]);
      }
      if (engine.isGameOver) continue;
      // Ensure it's P0's turn
      while (engine.currentPlayer.id !== 0 && !engine.isGameOver) {
        const actions = engine.getActions();
        if (actions.length === 0) { engine.state.turnIdx++; continue; }
        engine.applyAction(actions[Math.floor(Math.random() * actions.length)]);
      }

      // Baseline win rate
      const baseline = estimateWinRate(engine, iterations);

      // For each resource, add 1 and measure
      for (const res of resources) {
        const sim = cloneEngineForSimulation(engine);
        const p = sim.state.players[0];
        if (['sheep','boar','cow'].includes(res)) {
          p.animals[res]++;
        } else {
          p.res[res]++;
        }
        const wr = estimateWinRate(sim, iterations);
        deltas[res].push(wr - baseline);
      }
    }

    // Report
    const results = resources.map(r => ({
      resource: r,
      avgDelta: deltas[r].reduce((a,b)=>a+b, 0) / deltas[r].length,
    })).sort((a, b) => b.avgDelta - a.avgDelta);

    console.log('Resource         ΔWinRate   Value');
    console.log('─'.repeat(45));
    for (const r of results) {
      const bar = '█'.repeat(Math.max(0, Math.round(r.avgDelta * 200)));
      const neg = r.avgDelta < 0 ? '░'.repeat(Math.min(5, Math.round(-r.avgDelta * 200))) : '';
      console.log(`  ${r.resource.padEnd(12)}  ${(r.avgDelta*100).toFixed(2).padStart(6)}%   ${bar}${neg}`);
    }
    console.log();
  }
}

function estimateWinRate(engine, iterations) {
  const ai = new MCTSAI({ iterations, verbose: false });
  ai.playerId = 0;
  const rootEngine = cloneEngineForSimulation(engine);
  const root = new MCTSNode(rootEngine);
  root.unexploredActions = rootEngine.getActions();
  if (root.unexploredActions.length === 0) return 0;

  for (let i = 0; i < iterations; i++) {
    const node = ai._select(root);
    const reward = ai._simulate(node);
    ai._backpropagate(node, reward);
  }

  // Weighted average of children
  let totalVisits = 0, totalValue = 0;
  for (const child of root.children) {
    totalVisits += child.visits;
    totalValue += child.value;
  }
  return totalVisits > 0 ? totalValue / totalVisits : 0;
}

computeMarginalValues([1, 4, 7, 10], 200, 15);
