#!/usr/bin/env node
/**
 * Estimate per-action value using the heuristic evaluation function.
 *
 * For each round, simulate N games up to that round, then for every available
 * action apply it and measure delta in evaluateState(). Average across samples.
 *
 * This is a 1-ply lookahead value estimate (not full MCTS), but it reflects
 * the value model currently baked into the AI.
 */

const { GameEngine } = require('../js/engine/GameEngine');
const { greedyPolicy, evaluateState, cloneEngineForSimulation } = require('../js/ai/heuristic-ai');

const ROUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const SAMPLES = 200;

function estimateActionValues() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 行动格启发式价值评估 (eval delta after taking action)');
  console.log('═══════════════════════════════════════════════════\n');

  for (const targetRound of ROUNDS) {
    const acc = {}; // actionId -> { label, deltas: [] }

    for (let s = 0; s < SAMPLES; s++) {
      const engine = new GameEngine(4);
      engine.init();

      // Fast-forward to target round with random play
      while (engine.state.round < targetRound && !engine.isGameOver) {
        const actions = engine.getActions();
        if (actions.length === 0) { engine.state.turnIdx++; continue; }
        engine.applyAction(actions[Math.floor(Math.random() * actions.length)]);
      }
      if (engine.isGameOver) continue;
      // Ensure P0 turn
      while (engine.currentPlayer.id !== 0 && !engine.isGameOver) {
        const actions = engine.getActions();
        if (actions.length === 0) { engine.state.turnIdx++; continue; }
        engine.applyAction(actions[Math.floor(Math.random() * actions.length)]);
      }
      if (engine.isGameOver) continue;

      const actions = engine.getActions();
      if (actions.length === 0) continue;

      const baseScore = evaluateState(engine, 0);

      for (const action of actions) {
        const sim = cloneEngineForSimulation(engine);
        try {
          sim.applyAction(action);
          const after = evaluateState(sim, 0);
          const id = action.id;
          const label = action.label || action.name || id;
          if (!acc[id]) acc[id] = { label, deltas: [] };
          acc[id].deltas.push(after - baseScore);
        } catch (e) { /* skip invalid */ }
      }
    }

    const ranked = Object.entries(acc)
      .map(([id, v]) => ({
        id,
        label: v.label,
        avgDelta: v.deltas.reduce((a,b)=>a+b,0) / v.deltas.length,
        count: v.deltas.length,
      }))
      .sort((a,b) => b.avgDelta - a.avgDelta);

    console.log(`--- 第 ${targetRound} 轮 (样本 ${SAMPLES}) ---`);
    for (const r of ranked.slice(0, 8)) {
      const bar = '█'.repeat(Math.max(0, Math.round(r.avgDelta * 0.5)));
      console.log(`  ${r.label.padEnd(28)} Δ=${r.avgDelta.toFixed(1).padStart(7)} (n=${String(r.count).padStart(3)}) ${bar}`);
    }
    console.log();
  }
}

estimateActionValues();
