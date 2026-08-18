#!/usr/bin/env node
/**
 * Analyze MCTS AI strategy:
 * 1. Action win rates by round
 * 2. Resource valuations (marginal win rate of +1 resource)
 * 3. Per-round action frequency
 * 4. Typical game trajectory
 */

const { GameEngine } = require('../js/engine/GameEngine');
const { MCTSAI, MCTSNode } = require('../js/ai/mcts');
const { greedyPolicy, randomPolicy, cloneEngineForSimulation } = require('../js/ai/heuristic-ai');

// ======================== 1. Action Win Rates by Round ========================

function analyzeActionWinRates(games = 50, iterations = 300) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 1. 行动格胜率分析 (MCTS ' + iterations + ' iter, ' + games + ' games)');
  console.log('═══════════════════════════════════════════════════\n');

  // Track for each action at each round: visits and win rate
  const stats = {}; // actionId -> { label, byRound: { round: { visits, wins } } }

  for (let g = 0; g < games; g++) {
    const engine = new GameEngine(4);
    engine.init();
    // Player 0 is our MCTS, others greedy
    const ai = new MCTSAI({ iterations, verbose: false });

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) { engine.state.turnIdx++; continue; }

      if (engine.currentPlayer.id === 0) {
        const round = engine.state.round;
        // Run MCTS and collect child stats
        ai.playerId = 0;
        const rootEngine = cloneEngineForSimulation(engine);
        const root = new MCTSNode(rootEngine);
        root.unexploredActions = rootEngine.getActions();

        for (let i = 0; i < iterations; i++) {
          const node = ai._select(root);
          const reward = ai._simulate(node);
          ai._backpropagate(node, reward);
        }

        // Record each child's win rate
        for (const child of root.children) {
          const id = child.actionFromParent.id;
          const label = child.actionFromParent.label;
          if (!stats[id]) stats[id] = { label, totalVisits: 0, totalValue: 0, byRound: {} };
          if (!stats[id].byRound[round]) stats[id].byRound[round] = { visits: 0, value: 0, count: 0 };
          stats[id].byRound[round].visits += child.visits;
          stats[id].byRound[round].value += child.value;
          stats[id].byRound[round].count++;
          stats[id].totalVisits += child.visits;
          stats[id].totalValue += child.value;
        }

        // Select and play best
        const best = root.bestChild;
        engine.applyAction(best.actionFromParent);
      } else {
        engine.applyAction(greedyPolicy(engine, actions));
      }
    }
  }

  // Print aggregate ranking
  const sorted = Object.entries(stats)
    .map(([id, s]) => ({
      id,
      label: s.label,
      visits: s.totalVisits,
      winRate: s.totalValue / s.totalVisits,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  console.log('整体胜率排名:');
  console.log('─'.repeat(65));
  console.log('Rank  Action                          Visits   WinRate');
  console.log('─'.repeat(65));
  sorted.forEach((s, i) => {
    console.log(
      `#${(i+1).toString().padEnd(3)} ${s.label.padEnd(30)} ${String(s.visits).padStart(7)}   ${(s.winRate*100).toFixed(1)}%`
    );
  });

  // Print by round for top actions
  console.log('\n按轮次胜率 (Top 10 actions):');
  console.log('─'.repeat(80));
  const top10 = sorted.slice(0, 10);
  for (const s of top10) {
    const byRound = stats[s.id].byRound;
    const rounds = Object.keys(byRound).sort((a,b) => a-b);
    const parts = rounds.map(r => {
      const d = byRound[r];
      const wr = (d.value / d.visits * 100).toFixed(0);
      return `R${r}:${wr}%`;
    });
    console.log(`  ${s.label.padEnd(28)} ${parts.join('  ')}`);
  }

  return stats;
}

// ======================== 2. Resource Valuation ========================

function analyzeResourceValue(games = 200) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 2. 资源价值量化 (相关性分析, ' + games + ' random games)');
  console.log('═══════════════════════════════════════════════════\n');

  // Collect (resource_amount_at_round_N, final_score) pairs
  const resources = ['wood','clay','reed','stone','food','grain','veg','sheep','boar','cow'];
  const snapshots = {}; // round -> { resource: [values], score: [values] }

  for (let g = 0; g < games; g++) {
    const engine = new GameEngine(4);
    engine.init();

    // Snapshot state at each harvest round
    const snapshotRounds = [1, 4, 7, 9, 11, 14];
    const taken = {};

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) { engine.state.turnIdx++; continue; }
      engine.applyAction(randomPolicy(engine, actions));

      if (snapshotRounds.includes(engine.state.round) && !taken[engine.state.round]) {
        taken[engine.state.round] = true;
        const p = engine.state.players[0];
        if (!snapshots[engine.state.round]) snapshots[engine.state.round] = [];
        snapshots[engine.state.round].push({
          wood: p.res.wood, clay: p.res.clay, reed: p.res.reed, stone: p.res.stone,
          food: p.res.food, grain: p.res.grain, veg: p.res.veg,
          sheep: p.animals.sheep, boar: p.animals.boar, cow: p.animals.cow,
          workers: p.res.maxWorkers, rooms: p.farm.filter(t=>t===1).length,
          fields: p.farm.filter(t=>t===2).length, majors: p.majors.length,
          score: engine.calculateScore(p),
        });
      }
    }
  }

  // Compute Pearson correlation between each resource and final score
  for (const round of Object.keys(snapshots).sort((a,b)=>a-b)) {
    const data = snapshots[round];
    if (data.length < 10) continue;
    console.log(`\n第 ${round} 轮资源与最终得分的相关系数:`);
    console.log('─'.repeat(45));

    const corrs = resources.concat(['workers','rooms','fields','majors']).map(res => {
      const xs = data.map(d => d[res]);
      const ys = data.map(d => d.score);
      return { res, corr: pearson(xs, ys), avg: avg(xs) };
    }).sort((a, b) => b.corr - a.corr);

    for (const c of corrs) {
      const bar = '█'.repeat(Math.max(0, Math.round(c.corr * 20)));
      console.log(`  ${c.res.padEnd(10)} r=${c.corr.toFixed(3).padStart(7)}  avg=${c.avg.toFixed(1).padStart(5)}  ${bar}`);
    }
  }
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]-mx)*(ys[i]-my);
    dx += (xs[i]-mx)**2;
    dy += (ys[i]-my)**2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx*dy);
}

function avg(arr) { return arr.reduce((a,b)=>a+b,0) / arr.length; }

// ======================== 3. Typical Game Trajectory ========================

function analyzeTrajectory(games = 100, iterations = 200) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 3. MCTS 典型对局轨迹 (avg resources per round)');
  console.log('═══════════════════════════════════════════════════\n');

  const roundData = {};
  const actionCounts = {}; // round -> actionId -> count

  for (let g = 0; g < games; g++) {
    const engine = new GameEngine(4);
    engine.init();
    const ai = new MCTSAI({ iterations, verbose: false });

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) { engine.state.turnIdx++; continue; }

      const round = engine.state.round;
      let action;
      if (engine.currentPlayer.id === 0) {
        action = ai.selectAction(engine);
      } else {
        action = greedyPolicy(engine, actions);
      }

      if (engine.currentPlayer.id === 0) {
        if (!actionCounts[round]) actionCounts[round] = {};
        const id = action.id;
        actionCounts[round][id] = (actionCounts[round][id] || 0) + 1;
      }

      engine.applyAction(action);

      // Snapshot after action for P0 at start of each round
      if (engine.currentPlayer.id === 0 && !roundData[round]) {
        const p = engine.state.players[0];
        roundData[round] = { food: [], wood: [], clay: [], reed: [], grain: [], workers: [], fields: [], score: [] };
      }
    }

    // Final snapshot
    const p = engine.state.players[0];
    const r = engine.state.round;
    if (!roundData[r]) roundData[r] = { food: [], wood: [], clay: [], reed: [], grain: [], workers: [], fields: [], score: [] };
  }

  // More accurate: just run games and record P0 state each turn
  const trajectory = [];
  for (let g = 0; g < games; g++) {
    const engine = new GameEngine(4);
    engine.init();
    const ai = new MCTSAI({ iterations, verbose: false });
    const gameSnapshots = {};

    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) { engine.state.turnIdx++; continue; }
      const round = engine.state.round;
      if (!gameSnapshots[round] && engine.currentPlayer.id === 0) {
        const p = engine.state.players[0];
        gameSnapshots[round] = {
          round, food: p.res.food, wood: p.res.wood, clay: p.res.clay,
          reed: p.res.reed, stone: p.res.stone, grain: p.res.grain, veg: p.res.veg,
          workers: p.res.maxWorkers, fields: p.farm.filter(t=>t===2).length,
          rooms: p.farm.filter(t=>t===1).length, sheep: p.animals.sheep,
          boar: p.animals.boar, cow: p.animals.cow, majors: p.majors.length,
          score: engine.calculateScore(p),
        };
      }
      const action = engine.currentPlayer.id === 0 ? ai.selectAction(engine) : greedyPolicy(engine, actions);
      engine.applyAction(action);
    }

    const p = engine.state.players[0];
    gameSnapshots[14] = {
      round: 14, food: p.res.food, wood: p.res.wood, clay: p.res.clay,
      reed: p.res.reed, stone: p.res.stone, grain: p.res.grain, veg: p.res.veg,
      workers: p.res.maxWorkers, fields: p.farm.filter(t=>t===2).length,
      rooms: p.farm.filter(t=>t===1).length, sheep: p.animals.sheep,
      boar: p.animals.boar, cow: p.animals.cow, majors: p.majors.length,
      score: engine.calculateScore(p),
    };
    trajectory.push(gameSnapshots);
  }

  // Average per round
  console.log('Round | Food | Wood | Clay | Reed | Stone | Grain | Workers | Fields | Rooms | Sheep | Boar | Cow | Score');
  console.log('─'.repeat(105));
  for (let r = 1; r <= 14; r++) {
    const snaps = trajectory.map(g => g[r]).filter(Boolean);
    if (snaps.length === 0) continue;
    const avg = k => (snaps.reduce((s,d)=>s+d[k],0) / snaps.length).toFixed(1).padStart(5);
    console.log(
      `R${String(r).padStart(2)}  |${avg('food')} |${avg('wood')} |${avg('clay')} |${avg('reed')} |${avg('stone')} |${avg('grain')} |${avg('workers')}    |${avg('fields')}    |${avg('rooms')}    |${avg('sheep')} |${avg('boar')} |${avg('cow')} |${avg('score')}`
    );
  }

  // Most common actions per round (P0)
  console.log('\n每轮最常选择的行动:');
  const actionLabels = {};
  const { BASE_ACTIONS, ROUND_CARDS_POOL } = require('../js/constants');
  [...BASE_ACTIONS, ...ROUND_CARDS_POOL].forEach(a => actionLabels[a.id] = a.name);

  // Aggregate action counts across games
  const aggCounts = {};
  for (const g of trajectory) {
    // We need to re-run to track actions; use actionCounts from previous run
  }
}

// ======================== Main ========================

const args = process.argv.slice(2);
const mode = args[0] || 'all';

if (mode === 'all' || mode === 'actions') analyzeActionWinRates(30, 200);
if (mode === 'all' || mode === 'resources') analyzeResourceValue(300);
if (mode === 'all' || mode === 'trajectory') analyzeTrajectory(50, 150);
