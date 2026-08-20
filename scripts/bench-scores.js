#!/usr/bin/env node
/**
 * Quick score benchmark: N games with all players running the same AI
 * (MCTS at a given iteration budget), print score distribution per seat
 * plus component breakdown.
 *
 * Usage:
 *   node scripts/bench-scores.js [games] [iterations] [policy]
 *   policy: mcts | staged | greedy
 */
const { GameEngine } = require('../js/engine/GameEngine');
const { MCTSAI } = require('../js/ai/mcts');
const { stagedRolloutPolicy, greedyPolicy } = require('../js/ai/heuristic-ai');

const GAMES = parseInt(process.argv[2] || '20', 10);
const ITERS = parseInt(process.argv[3] || '300', 10);
const POLICY = process.argv[4] || 'mcts';

function pickAction(engine, actions, ai) {
  if (POLICY === 'mcts') return ai.selectAction(engine);
  if (POLICY === 'staged') return stagedRolloutPolicy(engine, actions);
  return greedyPolicy(engine, actions);
}

function pct(arr, q) {
  const s = [...arr].sort((a,b)=>a-b);
  return s[Math.min(s.length-1, Math.floor(s.length*q))];
}

function run() {
  const totals = [[],[],[],[]];
  const occCounts = [0,0,0,0];
  const minorCounts = [0,0,0,0];
  let winScores = [];

  for (let g = 0; g < GAMES; g++) {
    const engine = new GameEngine(4);
    engine.init();
    const ais = [0,1,2,3].map(id => {
      const a = new MCTSAI({ iterations: ITERS, verbose: false });
      a.playerId = id;
      return a;
    });

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) { engine.state.turnIdx++; continue; }
      const pid = engine.currentPlayer.id;
      const action = pickAction(engine, actions, ais[pid]);
      engine.applyAction(action);
    }

    const scores = engine.state.players.map(p => {
      occCounts[p.id] += (p.occupations || []).length;
      minorCounts[p.id] += (p.minorImprovements || []).length;
      return engine.calculateScore(p);
    });
    let winner = 0;
    for (let i = 1; i < 4; i++) if (scores[i] > scores[winner]) winner = i;
    winScores.push(scores[winner]);
    scores.forEach((s, i) => totals[i].push(s));
  }

  console.log(`\nPolicy=${POLICY}  games=${GAMES}  mctsIterations=${ITERS}\n`);
  console.log('seat  |  avg   min   p25   med   p75   max  |  avgOcc  avgMinor');
  console.log('-'.repeat(78));
  for (let i = 0; i < 4; i++) {
    const arr = totals[i];
    const avg = arr.reduce((a,b)=>a+b,0)/arr.length;
    console.log(
      `P${i}    | ${avg.toFixed(1).padStart(5)} ${pct(arr,0).toString().padStart(5)} ${pct(arr,.25).toString().padStart(5)} ${pct(arr,.5).toString().padStart(5)} ${pct(arr,.75).toString().padStart(5)} ${pct(arr,1).toString().padStart(5)}` +
      `  |  ${(occCounts[i]/GAMES).toFixed(1).padStart(5)}    ${(minorCounts[i]/GAMES).toFixed(1).padStart(5)}`
    );
  }
  const all = totals.flat();
  console.log('-'.repeat(78));
  console.log(`ALL   | avg ${(all.reduce((a,b)=>a+b,0)/all.length).toFixed(1)}  med ${pct(all,.5)}  max ${pct(all,1)}`);
  console.log(`WIN   | avg ${(winScores.reduce((a,b)=>a+b,0)/winScores.length).toFixed(1)}  max ${pct(winScores,1)}`);
}

run();
