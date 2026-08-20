/**
 * MCTS - Monte Carlo Tree Search for Agricola.
 *
 * Each node represents a game state and edge = action taken.
 * Multiplayer-aware: tracks whose turn, backprops winner score.
 *
 * Usage:
 *   const ai = new MCTSAI({ iterations: 2000, exploration: 1.4 });
 *   const action = ai.selectAction(engine);
 */

const { GameEngine } = require('../engine/GameEngine');
const { cloneState } = require('../engine/GameState');
const { randomPolicy, stagedRolloutPolicy, greedyPolicy, evaluateState, pruneDominatedActions, filterNoopActions, resolveActionChoices, cloneEngineForSimulation } = require('./heuristic-ai');
const { choosePlan } = require('./card-values');

// ======================== Tree Node ========================

let NODE_ID = 0;

class MCTSNode {
  constructor(engine, parent = null, actionFromParent = null) {
    this.id = NODE_ID++;
    this.parent = parent;
    this.actionFromParent = actionFromParent;
    this.children = [];
    this.visits = 0;
    this.value = 0; // cumulative score for the player who acted to reach this node
    this.unexploredActions = null; // lazy-populated
    this._engine = engine; // owned reference (cloned when expanding children)
    this.playerId = engine.currentPlayer ? engine.currentPlayer.id : -1;
    this.isTerminal = engine.isGameOver;
  }

  get ucb1() {
    if (this.visits === 0) return Infinity;
    const exploit = this.value / this.visits;
    const explore = Math.sqrt(2 * Math.log(this.parent.visits) / this.visits);
    return exploit + explore * 1.4;
  }

  ucb1With(c) {
    if (this.visits === 0) return Infinity;
    const exploit = this.value / this.visits;
    const explore = Math.sqrt(c * Math.log(this.parent.visits) / this.visits);
    return exploit + explore;
  }

  get isFullyExpanded() {
    return this.unexploredActions !== null && this.unexploredActions.length === 0;
  }

  get bestChild() {
    let best = this.children[0];
    for (const child of this.children) {
      if (child.visits > best.visits) best = child;
    }
    return best;
  }
}

// ======================== MCTS AI ========================

class MCTSAI {
  constructor(options = {}) {
    this.iterations = options.iterations || 1000;
    this.exploration = options.exploration ?? Math.SQRT2;
    this.rolloutPolicy = options.rolloutPolicy || stagedRolloutPolicy;
    // Opponents during rollout default to staged (fast, ~9x cheaper than greedy
    // which clones per candidate). Staged also plays stronger than greedy, so
    // score estimates reflect more realistic opponents.
    this.opponentRolloutPolicy = options.opponentRolloutPolicy || stagedRolloutPolicy;
    this.rolloutDepth = options.rolloutDepth || 0; // 0 = play to end
    this.verbose = options.verbose || false;
    this.playerId = options.playerId ?? 0;
  }

  /**
   * Select the best action for the current player.
   * Returns the action object (from engine.getActions()).
   */
  selectAction(engine) {
    this.playerId = engine.currentPlayer.id;
    // Commit to a build-around plan on the opening turn (idempotent).
    const realP = engine.state.players[this.playerId];
    if (engine.state.round <= 2 && realP && !realP.aiPlan) {
      choosePlan(realP, engine);
    }
    const rootEngine = cloneEngineForSimulation(engine);
    const root = new MCTSNode(rootEngine);
    root.unexploredActions = filterNoopActions(rootEngine,
      pruneDominatedActions(rootEngine.getActions()))
      .map(a => resolveActionChoices(rootEngine, a));

    if (root.unexploredActions.length === 0) return null;
    if (root.unexploredActions.length === 1) return root.unexploredActions[0];

    for (let i = 0; i < this.iterations; i++) {
      const node = this._select(root);
      const reward = this._simulate(node);
      this._backpropagate(node, reward);
    }

    if (this.verbose) {
      this._printStats(root);
    }

    const best = root.bestChild;
    return best ? best.actionFromParent : root.unexploredActions[0];
  }

  // ======================== Phases ========================

  _select(node) {
    while (!node.isTerminal) {
      if (!node.isFullyExpanded) {
        return this._expand(node);
      }
      // Pick child by UCB1
      let best = null;
      let bestScore = -Infinity;
      for (const child of node.children) {
        const score = child.ucb1With(this.exploration);
        if (score > bestScore) {
          bestScore = score;
          best = child;
        }
      }
      if (!best) return node;
      node = best;
    }
    return node;
  }

  _expand(parent) {
    if (parent.unexploredActions === null) {
      parent.unexploredActions = filterNoopActions(parent._engine,
        pruneDominatedActions(parent._engine.getActions()));
    }
    if (parent.unexploredActions.length === 0) return parent;

    const action = resolveActionChoices(parent._engine, parent.unexploredActions.pop());
    const childEngine = cloneEngineForSimulation(parent._engine);
    try {
      childEngine.applyAction(action);
    } catch (e) {
      // Action turned out invalid during sim, skip
      return this._expand(parent);
    }

    const child = new MCTSNode(childEngine, parent, action);
    if (!child.isTerminal) {
      child.unexploredActions = pruneDominatedActions(childEngine.getActions());
    }
    parent.children.push(child);
    return child;
  }

  _simulate(node) {
    if (node.isTerminal) {
      return this._getReward(node._engine);
    }

    const simEngine = cloneEngineForSimulation(node._engine);
    let depth = 0;

    while (!simEngine.isGameOver) {
      if (this.rolloutDepth > 0 && depth >= this.rolloutDepth) {
        return this._heuristicReward(simEngine);
      }
      const actions = simEngine.getActions();
      if (actions.length === 0) {
        // Safety: force advance
        simEngine.state.turnIdx++;
        depth++;
        if (depth > 2000) break;
        continue;
      }
      const policy = simEngine.currentPlayer.id === this.playerId
        ? this.rolloutPolicy
        : this.opponentRolloutPolicy;
      const action = policy(simEngine, actions);
      try {
        simEngine.applyAction(action);
      } catch (e) {
        // skip invalid
      }
      depth++;
    }

    return this._getReward(simEngine);
  }

  _backpropagate(node, reward) {
    let current = node;
    while (current !== null) {
      current.visits++;
      // Reward is from root player's perspective
      current.value += reward;
      current = current.parent;
    }
  }

  // ======================== Reward ========================

  /**
   * Terminal reward: blend of rank (win signal) and normalized score (absolute
   * skill signal). Rank alone doesn't reward scoring 40 vs 10; score alone
   * makes MCTS chase points at expense of winning. Blend both.
   */
  _getReward(engine) {
    const players = engine.state.players;
    const targetPlayer = players.find(p => p.id === this.playerId);
    if (!targetPlayer) return 0;

    const sorted = [...players].sort((a, b) => b.score - a.score);
    const rank = sorted.findIndex(p => p.id === this.playerId);
    const rankReward = 1 - rank / (sorted.length - 1);

    // Normalized score: map score to roughly [0, 1] around 0..50
    const scoreReward = 1 / (1 + Math.exp(-(targetPlayer.score - 20) / 15));

    // 30% rank, 70% absolute score — heavily reward high scores so MCTS seeks
    // 40+ point games, not just beating weak opponents.
    return rankReward * 0.3 + scoreReward * 0.7;
  }

  /**
   * Non-terminal reward using heuristic evaluation.
   */
  _heuristicReward(engine) {
    const rawScore = evaluateState(engine, this.playerId);
    // Sigmoid-like normalization into [0, 1]
    return 1 / (1 + Math.exp(-rawScore / 30));
  }

  // ======================== Debug ========================

  _printStats(root) {
    const sorted = [...root.children].sort((a, b) => b.visits - a.visits);
    console.log(`\nMCTS Stats (${this.iterations} iterations, player ${this.playerId}):`);
    for (const child of sorted.slice(0, 8)) {
      const winRate = (child.value / child.visits * 100).toFixed(1);
      const actionLabel = child.actionFromParent.label || child.actionFromParent.id;
      console.log(`  ${actionLabel.padEnd(30)} visits=${String(child.visits).padStart(5)}  winRate=${winRate}%`);
    }
  }
}

// ======================== Policy wrapper ========================

/**
 * Create an MCTS policy function compatible with GameEngine.playOut().
 * Each call runs MCTS for the configured iterations.
 */
function createMCTSPolicy(options = {}) {
  const ai = new MCTSAI(options);
  return (engine, actions) => ai.selectAction(engine);
}

module.exports = { MCTSAI, MCTSNode, createMCTSPolicy };
