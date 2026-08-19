/**
 * GameEngine - Headless Agricola engine.
 *
 * Usage:
 *   const engine = new GameEngine();
 *   engine.init();
 *   const actions = engine.getActions();  // available for current player
 *   engine.applyAction(actions[0]);
 *   // ... repeat until engine.state.phase === 'ended'
 *
 * Events are emitted after each action so card effects can hook in.
 */

const { createInitialState, cloneState } = require('./GameState');
const {
  BASE_ACTIONS, ROUND_CARDS_POOL, DB_MAJORS,
  HARVEST_ROUNDS, MAX_ROUNDS, LIMIT_FENCES, SCORING_TIERS,
} = require('../constants');
const { CardEffectSystem } = require('./card-effects');
const { getCard } = require('../data/cards');

// ======================== Event System ========================

class EventEmitter {
  constructor() { this.listeners = {}; }
  on(event, fn) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach(fn => fn(data));
  }
}

// ======================== Engine ========================

class GameEngine {
  constructor(numPlayers = 4, options = {}) {
    this.numPlayers = numPlayers;
    this.options = options;
    this.events = new EventEmitter();
    this.state = null;
    this._actionDefs = null;
  }

  init() {
    this.state = createInitialState(this.numPlayers);
    this.state.nextStartPlayer = this.state.startPlayer;
    this._actionDefs = BASE_ACTIONS
      .filter(a => !a.players || a.players.includes(this.numPlayers))
      .map(a => ({ ...a }));
    this.state.deck = this._buildDeck();
    this.state.majorMarket = DB_MAJORS.map(m => ({ ...m }));
    this._unlockRoundCard();
    this.cards = new CardEffectSystem(this);
    this.events.emit('gameStart', this.state);
    return this.state;
  }

  _buildDeck() {
    const stages = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    ROUND_CARDS_POOL.forEach(c => stages[c.stage].push({ ...c }));
    let deck = [];
    for (let i = 1; i <= 6; i++) {
      deck = deck.concat(stages[i].sort(() => Math.random() - 0.5));
    }
    return deck;
  }

  // ======================== Turn Management ========================

  get currentPlayer() {
    const idx = ((this.state.startPlayer + this.state.turnIdx) % this.numPlayers + this.numPlayers) % this.numPlayers;
    return this.state.players[idx];
  }

  get isGameOver() {
    return this.state.phase === 'ended';
  }

  /**
   * Return list of legal actions for the current player.
   * Each action: { id, label, type, ...payload }
   */
  getActions() {
    if (this.isGameOver) return [];
    const p = this.currentPlayer;
    if (p.res.workers <= 0) return [];

    const actions = [];
    const allActs = [...this._actionDefs, ...this.state.roundCards];

    for (const act of allActs) {
      if (this.state.occupied[act.id] !== undefined && !this._canIgnoreOccupancy(p, act)) continue;
      const legal = this._isActionLegal(p, act);
      if (legal.ok) {
        actions.push({
          id: act.id,
          label: act.name,
          type: act.type,
          mode: act.mode,
          res: act.res,
          amount: act.cur || act.amount || 0,
          lessonCost: act.lessonCost,
          ...legal.extra,
        });
      }
    }
    return actions;
  }

  _canIgnoreOccupancy(p, act) {
    return this.cards && this.cards.canIgnoreOccupancy(p, act);
  }

  _isActionLegal(p, act) {
    // Resource actions are always legal (but may give 0)
    if (act.type === 'res' || act.type === 'res_combo') {
      // Skip empty accumulators unless it's non-accumulating
      if (act.type === 'res' && act.acc && act.cur === 0) return { ok: false };
      return { ok: true };
    }
    if (act.mode === 'meeting') return { ok: true };
    if (act.mode === 'lesson' || act.mode === 'lesson2') {
      if (!p.occupationHand || p.occupationHand.length === 0) return { ok: false };
      const cost = this._lessonCost(p, act);
      return { ok: p.res.food >= cost };
    }
    if (act.mode === 'grow_force') return { ok: true };
    if (act.mode === 'grow') {
      const rooms = p.farm.filter(t => t === 1).length;
      const provided = this.cards ? this.cards.getProvidedRooms(p) : 0;
      if (rooms + provided > p.res.maxWorkers) return { ok: true };
      if (this.cards && this.cards.canGrowWithoutRoom(p)) return { ok: true };
      return { ok: false };
    }
    if (act.mode === 'plow') {
      const hasField = p.farm.includes(2);
      const canPlow = p.farm.some((t, i) => t === 0 && (!hasField || this._hasNeighbor(p, i, 2)));
      return { ok: canPlow };
    }
    if (act.mode === 'sow') {
      const hasSeeds = p.res.grain > 0 || p.res.veg > 0;
      const hasField = p.farm.some((t, i) => t === 2 && p.farmContent[i] === null);
      return { ok: hasSeeds && hasField };
    }
    if (act.mode === 'plow_sow') {
      return { ok: p.farm.some(t => t === 0) && (p.res.grain > 0 || p.res.veg > 0) };
    }
    if (act.mode === 'build_menu') {
      const canRoom = this._canBuildRoom(p);
      const canStable = p.res.wood >= 2 && p.stablesCount < 4;
      const hasSpace = p.farm.includes(0);
      return { ok: hasSpace && (canRoom || canStable) };
    }
    if (act.mode === 'fence') {
      return { ok: p.res.wood >= 1 && p.fences.size < LIMIT_FENCES };
    }
    if (act.mode === 'major') {
      const canBuy = this.state.majorMarket.some(m => this._canAffordCard(p, m));
      const canPlayMinor = p.minorHand && p.minorHand.some(c =>
        this.cards.prereqOk(p, c) && this._canAfford(p, c.cost));
      return { ok: canBuy || canPlayMinor };
    }
    if (act.mode === 'reno_major' || act.mode === 'reno_fence') {
      return { ok: this._canRenovate(p).ok };
    }
    return { ok: true };
  }

  // ======================== Action Execution ========================

  /**
   * Apply an action. action should be one from getActions(), possibly with
   * additional choices (tile index, card to buy, etc).
   *
   * @param {object} action - { id, choices?: { tileIdx, majorId, ... } }
   */
  applyAction(action) {
    const p = this.currentPlayer;
    const act = [...this._actionDefs, ...this.state.roundCards].find(a => a.id === action.id);
    if (!act) throw new Error(`Unknown action: ${action.id}`);
    if (this.state.occupied[act.id] !== undefined && !this._canIgnoreOccupancy(p, act)) {
      throw new Error('Action already occupied');
    }

    const choices = action.choices || {};
    const result = this._executeAction(p, act, choices) || {};

    // Occupy and advance
    if (!(this.cards && this.cards.canIgnoreOccupancy(p, act))) {
      this.state.occupied[act.id] = p.id;
    }
    p.res.workers--;
    this.events.emit('afterAction', { player: p, action: act, choices, result });

    this._advanceTurn();
  }

  _executeAction(p, act, choices) {
    const result = {};
    // Resource collection
    if (act.type === 'res') {
      const amt = act.cur || act.amount || 0;
      if (['sheep', 'boar', 'cow'].includes(act.res)) {
        p.animals[act.res] += amt;
        if (act.acc) act.cur = 0;
        this._resolveAnimalOverflow(p);
      } else {
        p.res[act.res] += amt;
        if (act.acc) act.cur = 0;
      }
      this.events.emit('collect', { player: p, action: act, resource: act.res, amount: amt });
      this.events.emit('obtain', { player: p, resource: act.res, amount: amt });
      if (act.res === 'grain') this.cards.onGrainObtained(p);
      return result;
    }
    if (act.type === 'res_combo') {
      p.res.reed++; p.res.stone++; p.res.food++;
      this.events.emit('obtain', { player: p, resource: 'reed', amount: 1 });
      this.events.emit('obtain', { player: p, resource: 'stone', amount: 1 });
      this.events.emit('obtain', { player: p, resource: 'food', amount: 1 });
      return result;
    }

    switch (act.mode) {
      case 'meeting':
        this.state.nextStartPlayer = p.id;
        if (choices.minorId) {
          const card = p.minorHand.find(c => c.id === choices.minorId);
          if (card && this.cards.playMinor(p, choices.minorId)) result.card = card;
        } else {
          const pm = this._pickPlayableMinor(p);
          if (pm && this.cards.playMinor(p, pm.id)) result.card = pm;
        }
        break;

      case 'lesson':
      case 'lesson2': {
        const foodCost = this._lessonCost(p, act);
        p.res.food -= foodCost;
        let card;
        if (choices.occId) card = p.occupationHand.find(c => c.id === choices.occId);
        if (!card && p.occupationHand.length > 0) card = p.occupationHand[0];
        if (card) {
          this.cards.playOccupation(p, card.id);
          result.card = card;
        }
        break;
      }

      case 'grow':
      case 'grow_force':
        if (p.res.maxWorkers < 5) p.res.maxWorkers++;
        break;

      case 'plow': {
        const idx = choices.tileIdx ?? this._findPlowTile(p);
        if (idx >= 0) p.farm[idx] = 2;
        break;
      }

      case 'sow': {
        this._autoSow(p);
        break;
      }

      case 'plow_sow': {
        const idx = choices.tileIdx ?? this._findPlowTile(p);
        if (idx >= 0) {
          p.farm[idx] = 2;
          this._sowOnTile(p, idx);
        }
        break;
      }

      case 'build_menu': {
        const woodBefore = p.res.wood;
        this._autoBuild(p, choices);
        result.woodSpent = woodBefore - p.res.wood;
        if (choices.buildRooms !== false) this.events.emit('buildRoom', { player: p });
        break;
      }

      case 'fence': {
        const woodBefore = p.res.wood;
        this._autoFence(p, choices);
        result.woodSpent = woodBefore - p.res.wood;
        this.events.emit('fence', { player: p, pastureSize: choices.fences || 0 });
        break;
      }

      case 'major':
      case 'reno_major': {
        if (act.mode === 'reno_major') {
          this._doRenovate(p);
          this.events.emit('renovate', { player: p });
        }
        if (choices.minorId) {
          const card = p.minorHand.find(c => c.id === choices.minorId);
          if (card) {
            this.cards.playMinor(p, choices.minorId);
            result.card = card;
          }
        } else if (choices.majorId) {
          this._buyMajor(p, choices.majorId);
        } else {
          // Prefer playable minor if strong, else auto-pick best affordable major.
          const playableMinor = this._pickPlayableMinor(p);
          if (playableMinor && ((playableMinor.vp || 0) >= 2 || !this._pickBestMajor(p))) {
            this.cards.playMinor(p, playableMinor.id);
            result.card = playableMinor;
          } else {
            const pick = this._pickBestMajor(p);
            if (pick) this._buyMajor(p, pick.id);
          }
        }
        break;
      }

      case 'reno_fence': {
        this._doRenovate(p);
        this.events.emit('renovate', { player: p });
        const woodBefore = p.res.wood;
        this._autoFence(p, choices);
        result.woodSpent = woodBefore - p.res.wood;
        this.events.emit('fence', { player: p, pastureSize: choices.fences || 0 });
        break;
      }
    }
    return result;
  }

  // ======================== Round / Harvest ========================

  _advanceTurn() {
    this.state.turnIdx++;

    // Check if all workers used
    const allUsed = this.state.players.every(p => p.res.workers <= 0);
    if (allUsed) {
      this._endRound();
      return;
    }

    // Skip players with no workers remaining
    let guard = 0;
    while (guard++ < 20) {
      const pIdx = ((this.state.startPlayer + this.state.turnIdx) % this.numPlayers + this.numPlayers) % this.numPlayers;
      if (this.state.players[pIdx].res.workers > 0) break;
      this.state.turnIdx++;
    }
  }

  _endRound() {
    this.events.emit('endOfWorkPhase', this.state);
    // B22 walking boots: remove the extra worker added this round.
    for (const p of this.state.players) {
      if (p.minorImprovements.includes('B22')) {
        const rt = this.cards._rt(p, 'B22', {});
        if (rt.extraWorker) {
          p.res.maxWorkers = Math.max(2, p.res.maxWorkers - 1);
          rt.extraWorker = 0;
        }
      }
    }
    this.state.occupied = {};
    for (const p of this.state.players) {
      p.res.workers = p.res.maxWorkers;
    }
    // Accumulate resources
    [...this._actionDefs, ...this.state.roundCards].forEach(a => {
      if (a.acc) a.cur += a.acc;
    });

    if (HARVEST_ROUNDS.includes(this.state.round)) {
      this._doHarvest();
    } else {
      this._advanceRound();
    }
  }

  _advanceRound() {
    if (this.state.round >= MAX_ROUNDS) {
      this._endGame();
      return;
    }
    this.state.round++;
    // Well: 1 food at the start of each of the next 5 rounds after purchase.
    for (const p of this.state.players) {
      const well = p.majors.find(m => m.special === 'well');
      if (well && well.wellStartRound != null) {
        const roundsSince = this.state.round - well.wellStartRound;
        if (roundsSince >= 1 && roundsSince <= 5) p.res.food++;
      }
    }
    this._unlockRoundCard();
    this.state.startPlayer = this.state.nextStartPlayer;
    this.state.turnIdx = 0;
    this.events.emit('newRound', this.state.round);
  }

  _unlockRoundCard() {
    if (this.state.deck.length > 0) {
      const card = this.state.deck.shift();
      this.state.roundCards.push(card);
    }
  }

  _doHarvest() {
    this.events.emit('startOfHarvest', this.state);
    this.state.phase = 'harvestField';
    // 1. Field harvest
    for (const p of this.state.players) {
      let reapedVeg = 0;
      for (let i = 0; i < 15; i++) {
        if (p.farm[i] === 2 && p.farmCounts[i] > 0) {
          const kind = p.farmContent[i];
          p.res[kind]++;
          this.events.emit('obtain', { player: p, resource: kind, amount: 1 });
          if (kind === 'veg') reapedVeg++;
          if (kind === 'grain') this.cards.onGrainObtained(p);
          p.farmCounts[i]--;
          if (p.farmCounts[i] === 0) p.farmContent[i] = null;
        }
      }
      if (reapedVeg > 0) this.events.emit('reap', { player: p, resource: 'veg', amount: reapedVeg });
    }
    this.events.emit('harvestField', this.state);

    // 2. Feed (auto for AI, human players need choices - for headless we auto-feed)
    this.state.phase = 'harvestFeed';
    for (const p of this.state.players) {
      this.events.emit('harvestFeed', { player: p });
      this._autoFeed(p);
    }
    this.events.emit('harvestFeed', this.state);

    // 3. Breed
    this.state.phase = 'harvestBreed';
    for (const p of this.state.players) {
      for (const type of ['sheep', 'boar', 'cow']) {
        if (p.animals[type] >= 2) {
          p.animals[type]++;
        }
      }
      this._resolveAnimalOverflow(p);
    }
    this.events.emit('harvestBreed', this.state);

    this.state.phase = 'work';
    this._advanceRound();
  }

  _autoFeed(p) {
    const need = p.res.maxWorkers * 2;
    let food = p.res.food;
    let deficit = need - food;

    const cooker = p.majors.find(m => (m.type === 'cook' || m.type === 'bake') && m.cook);
    const baker = p.majors.find(m => m.bakeRate || m.specialBake);

    // Grain: baked with an oven (bakeRate on fireplaces, specialBake on stone/
    // clay ovens). Without a baker grain is 1:1 food.
    if (p.res.grain > 0 && (baker || p.minorImprovements.length > 0)) {
      this.events.emit('beforeBake', { player: p, context: 'feed' });
    }
    if (deficit > 0 && p.res.grain > 0) {
      if (baker && baker.specialBake) {
        const inG = baker.specialBake.in;
        const outF = baker.specialBake.out;
        const batches = Math.min(Math.floor(p.res.grain / inG), Math.ceil(deficit / outF));
        if (batches > 0) {
          p.res.grain -= batches * inG;
          p.res.food += batches * outF;
          deficit -= batches * outF;
        }
      } else if (baker) {
        const rate = baker.bakeRate || 1;
        const take = Math.min(p.res.grain, Math.ceil(deficit / rate));
        p.res.grain -= take;
        p.res.food += take * rate;
        deficit -= take * rate;
      } else {
        const take = Math.min(p.res.grain, deficit);
        p.res.grain -= take;
        p.res.food += take;
        deficit -= take;
      }
    }

    // Veg is worth cook.veg food each when a cooker is owned (matching the
    // original game: veg + cooker is the intended farming food engine).
    if (deficit > 0 && p.res.veg > 0) {
      const vegFood = cooker ? cooker.cook.veg : 1;
      const take = Math.min(p.res.veg, Math.ceil(deficit / vegFood));
      p.res.veg -= take;
      p.res.food += take * vegFood;
      deficit -= take * vegFood;
    }

    if (deficit > 0 && cooker) {
      for (const type of ['sheep', 'boar', 'cow']) {
        if (deficit <= 0) break;
        while (p.animals[type] > 0 && deficit > 0) {
          p.animals[type]--;
          p.res.food += cooker.cook[type];
          deficit -= cooker.cook[type];
        }
      }
    }

    const pay = Math.min(p.res.food, need);
    p.res.food -= pay;
    const begging = need - pay;
    if (begging > 0) p.begging += begging;
  }

  // ======================== Animal / Capacity ========================

  _resolveAnimalOverflow(p) {
    // Simplified: if animals exceed capacity, cook if possible, else discard
    const capacity = this._getAnimalCapacity(p);
    for (const type of ['sheep', 'boar', 'cow']) {
      if (p.animals[type] > capacity[type]) {
        const overflow = p.animals[type] - capacity[type];
        const cooker = p.majors.find(m => (m.type === 'cook' || m.type === 'bake') && m.cook);
        if (cooker) {
          p.res.food += overflow * cooker.cook[type];
        }
        p.animals[type] = capacity[type];
      }
    }
  }

  _getAnimalCapacity(p) {
    // Simplified: each pasture (enclosed area) holds 2 per tile, stable doubles
    // For headless, give a generous capacity based on fences + stables
    const fenceCount = p.fences.size;
    const pastureTiles = Math.max(0, Math.floor(fenceCount / 4)); // rough estimate
    const stableBonus = p.stablesCount * 2;
    const total = pastureTiles * 2 + stableBonus + 1; // +1 for house pet
    return { sheep: total, boar: total, cow: total };
  }

  // ======================== Building Helpers ========================

  _canBuildRoom(p) {
    const cost = this._roomCost(p, 1);
    return this._canAfford(p, cost);
  }

  _roomCost(p, count = 1) {
    const base = {
      wood: p.houseType === 'wood' ? 5 * count : 0,
      clay: p.houseType === 'clay' ? 5 * count : 0,
      stone: p.houseType === 'stone' ? 5 * count : 0,
      reed: 2 * count,
    };
    return this.cards ? this.cards.getRoomCost(p, base, p.houseType, count) : base;
  }

  _canAfford(p, cost) {
    return Object.entries(cost || {}).every(([k, v]) => (p.res[k] ?? 0) >= v);
  }

  _lessonCost(p, act) {
    const table = act.lessonCost || [0, 1];
    const idx = Math.min(p.occupations.length, table.length - 1);
    return table[idx];
  }

  _canAffordCard(p, major) {
    const cost = this.cards ? this.cards.getImprovementCost(p, major) : major.cost;
    return this._canAfford(p, cost);
  }

  _canRenovate(p) {
    const rooms = p.farm.filter(t => t === 1).length;
    let base;
    if (p.houseType === 'wood') base = { clay: rooms, reed: rooms };
    else if (p.houseType === 'clay') base = { stone: rooms, reed: rooms };
    else return { ok: false };
    const cost = this.cards ? this.cards.getRenovationCost(p, base) : base;
    if (this._canAfford(p, cost)) {
      return { ok: true, cost, next: p.houseType === 'wood' ? 'clay' : 'stone' };
    }
    return { ok: false };
  }

  _doRenovate(p) {
    const r = this._canRenovate(p);
    if (!r.ok) return;
    for (const [k, v] of Object.entries(r.cost)) {
      if (v) p.res[k] -= v;
    }
    p.houseType = r.next;
  }

  _hasNeighbor(p, idx, type) {
    const n = [];
    if (idx >= 5) n.push(idx - 5);
    if (idx < 10) n.push(idx + 5);
    if (idx % 5 !== 0) n.push(idx - 1);
    if (idx % 5 !== 4) n.push(idx + 1);
    return n.some(x => p.farm[x] === type);
  }

  _findPlowTile(p) {
    const hasField = p.farm.includes(2);
    for (let i = 0; i < 15; i++) {
      if (p.farm[i] === 0 && (!hasField || this._hasNeighbor(p, i, 2))) return i;
    }
    return -1;
  }

  _findRoomTile(p) {
    for (let i = 0; i < 15; i++) {
      if (p.farm[i] === 0 && this._hasNeighbor(p, i, 1)) return i;
    }
    return -1;
  }

  _findStableTile(p) {
    for (let i = 0; i < 15; i++) {
      if (p.farm[i] === 0) return i;
    }
    return -1;
  }

  _sowOnTile(p, idx) {
    // Veg is strictly better than grain in this economy (cooks to 2-3 food with
    // a cooker vs grain's 1:1, and scores more at endgame). Sow veg first.
    if (p.res.veg > 0) {
      p.res.veg--;
      p.farmContent[idx] = 'veg';
      p.farmCounts[idx] = 2;
    } else if (p.res.grain > 0) {
      p.res.grain--;
      p.farmContent[idx] = 'grain';
      p.farmCounts[idx] = 3;
    }
  }

  _autoSow(p) {
    for (let i = 0; i < 15; i++) {
      if (p.farm[i] === 2 && p.farmContent[i] === null) {
        if (p.res.veg > 0) {
          p.res.veg--;
          p.farmContent[i] = 'veg';
          p.farmCounts[i] = 2;
        } else if (p.res.grain > 0) {
          p.res.grain--;
          p.farmContent[i] = 'grain';
          p.farmCounts[i] = 3;
        }
      }
    }
  }

  _autoBuild(p, choices) {
    const wantRoom = choices.buildRooms !== false;
    const wantStable = choices.buildStables !== false;

    if (wantRoom && this._canBuildRoom(p)) {
      const idx = choices.tileIdx ?? this._findRoomTile(p);
      if (idx >= 0) {
        this._buildRoomAuto(p, idx);
        return;
      }
    }
    if (wantStable && p.stablesCount < 4) {
      const nth = p.stablesCount + 1;
      const sc = this.cards ? this.cards.getStableCost(p, nth) : { wood: 2 };
      if (p.res.wood >= sc.wood) {
        const idx = choices.stableIdx ?? this._findStableTile(p);
        if (idx >= 0) {
          p.res.wood -= sc.wood;
          p.farm[idx] = 5;
          p.stablesCount++;
        }
      }
    }
  }

  _buildRoomAuto(p, idx) {
    const cost = this._roomCost(p, 1);
    for (const [k, v] of Object.entries(cost)) {
      if (v) p.res[k] -= v;
    }
    p.farm[idx ?? this._findRoomTile(p)] = 1;
  }

  _autoFence(p, choices) {
    if (!choices.fences) return;
    const freeSegs = this.cards ? this.cards.getFenceFreeSegments(p) : new Set();
    const canUseClay = this.cards && this.cards.getFenceCanUseClay(p);
    let budgetWood = p.res.wood;
    let budgetClay = canUseClay ? p.res.clay : 0;
    let count = Math.min(choices.fences, LIMIT_FENCES - p.fences.size);
    for (let i = 0; i < count; i++) {
      const segNum = p.fences.size + 1;
      if (freeSegs.has(segNum)) {
        p.fences.add(`auto-${p.fences.size}`);
        continue;
      }
      if (budgetWood > 0) {
        budgetWood--;
        p.fences.add(`auto-${p.fences.size}`);
      } else if (budgetClay > 0) {
        budgetClay--;
        p.fences.add(`auto-${p.fences.size}`);
      } else {
        break;
      }
    }
    p.res.wood = budgetWood;
    if (canUseClay) p.res.clay = budgetClay;
    this._maybePlacePastureTiles(p);
  }

  _maybePlacePastureTiles(p) {
    const pastureTiles = Math.floor(p.fences.size / 4);
    let placed = p.farm.filter(t => t === 3).length;
    while (placed < pastureTiles) {
      const idx = this._findStableTile(p);
      if (idx < 0) break;
      p.farm[idx] = 3;
      placed++;
    }
  }

  _pickPlayableMinor(p) {
    if (!p.minorHand || p.minorHand.length === 0) return null;
    const playable = p.minorHand
      .filter(c => this.cards.prereqOk(p, c) && this._canAfford(p, c.cost))
      .sort((a, b) => (b.vp || 0) - (a.vp || 0));
    return playable[0] || null;
  }

  _pickBestMajor(p) {
    const affordable = this.state.majorMarket
      .filter(m => this._canAffordCard(p, m))
      .sort((a, b) => {
        const va = (a.score || 0) + (a.special ? 1 : 0);
        const vb = (b.score || 0) + (b.special ? 1 : 0);
        return vb - va;
      });
    return affordable[0] || null;
  }

  _buyMajor(p, majorId) {
    const idx = this.state.majorMarket.findIndex(m => m.id === majorId);
    if (idx < 0) return;
    const m = this.state.majorMarket[idx];
    const cost = this.cards ? this.cards.getImprovementCost(p, m) : m.cost;
    if (!this._canAfford(p, cost)) return;
    for (const [k, v] of Object.entries(cost)) p.res[k] -= v;
    p.majors.push(m);
    if (m.special === 'well') {
      m.wellStartRound = this.state.round;
    }
    this.state.majorMarket.splice(idx, 1);
    this.events.emit('buyMajor', { player: p, major: m });
  }

  // ======================== Scoring ========================

  _tierScore(category, count) {
    const tiers = SCORING_TIERS[category];
    if (!tiers) return 0;
    if (count >= tiers.length) return tiers[tiers.length - 1];
    return tiers[count];
  }

  calculateScore(p) {
    let s = 0;
    s += this._tierScore('fields', p.farm.filter(t => t === 2).length);
    s += this._tierScore('pastures', Math.floor(p.fences.size / 4));
    s += this._tierScore('grain', p.res.grain);
    s += this._tierScore('veg', p.res.veg);
    s += this._tierScore('sheep', p.animals.sheep);
    s += this._tierScore('boar', p.animals.boar);
    s += this._tierScore('cow', p.animals.cow);

    const occupied = p.farm.filter(t => t !== 0).length;
    s -= (15 - occupied);

    s += p.stablesCount;
    const rooms = p.farm.filter(t => t === 1).length;
    const houseVal = p.houseType === 'wood' ? 0 : (p.houseType === 'clay' ? 1 : 2);
    s += rooms * houseVal;
    s += p.res.maxWorkers * 3;
    p.majors.forEach(m => { s += m.score || 0; });
    // Minor improvements with vp
    for (const id of p.minorImprovements) {
      const c = getCard(id);
      if (c && c.vp) s += c.vp;
    }
    s += p.begging * -3;
    if (this.cards) s += this.cards.scoreCardBonuses(p);
    return s;
  }

  _endGame() {
    this.state.phase = 'ended';
    this.state.players.forEach(p => { p.score = this.calculateScore(p); });
    this.state.players.sort((a, b) => b.score - a.score);
    this.events.emit('gameEnd', this.state.players);
  }

  // ======================== Simulation Helper ========================

  /**
   * Fast-forward a full game using a given policy function.
   * Useful for AI training / evaluation.
   *
   * @param {function} chooseAction - (engine, actions) => action
   * @returns {object} final scores
   */
  static playOut(chooseAction, numPlayers = 4) {
    const engine = new GameEngine(numPlayers);
    engine.init();
    while (!engine.isGameOver) {
      const actions = engine.getActions();
      if (actions.length === 0) {
        // Should not happen, but safety
        engine.state.turnIdx++;
        continue;
      }
      const action = chooseAction(engine, actions);
      engine.applyAction(action);
    }
    return engine.state.players;
  }
}

module.exports = { GameEngine, EventEmitter };
