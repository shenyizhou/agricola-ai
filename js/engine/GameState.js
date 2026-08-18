/**
 * GameState - Pure data container for an Agricola game.
 * No DOM, no side effects, fully serializable.
 */

function createPlayer(id, name, type) {
  return {
    id,
    name,
    type, // 'human' | 'ai'
    res: {
      wood: 0, clay: 0, reed: 0, stone: 0,
      food: id === 0 ? 2 : 3,
      grain: 0, veg: 0,
      workers: 2, maxWorkers: 2,
    },
    farm: Array(15).fill(0),      // 0=empty, 1=room, 2=field, 5=stable
    farmCounts: Array(15).fill(0), // crop remaining rounds
    farmContent: Array(15).fill(null), // 'grain' | 'veg'
    fences: new Set(),
    stablesCount: 0,
    houseType: 'wood', // wood -> clay -> stone
    majors: [],
    occupations: [],       // played occupation card ids
    minorImprovements: [], // played minor improvement card ids
    occupationHand: [],    // card objects dealt at game start
    minorHand: [],
    cardRuntime: {},       // per-card runtime state keyed by cardId
    begging: 0,
    animals: { sheep: 0, boar: 0, cow: 0 },
    score: 0,
  };
}

function createInitialState(numPlayers = 4) {
  const players = [];
  const names = ['You', 'AI Red', 'AI Green', 'AI Yellow'];
  const types = ['human', 'ai', 'ai', 'ai'];
  for (let i = 0; i < numPlayers; i++) {
    players.push(createPlayer(i, names[i], types[i]));
  }
  // Initial rooms at positions 5, 10
  players.forEach(p => { p.farm[5] = 1; p.farm[10] = 1; });

  return {
    players,
    round: 1,
    startPlayer: Math.floor(Math.random() * numPlayers),
    nextStartPlayer: 0,
    turnIdx: 0,
    numPlayers,
    occupied: {},
    roundCards: [],
    deck: [],
    majorMarket: [],
    phase: 'work',
    harvestQueue: [],
    harvestIdx: 0,
    log: [],
  };
}

// Deep clone for simulation (MCTS etc.)
function cloneState(state) {
  const cloned = {
    ...state,
    occupied: { ...state.occupied },
    roundCards: state.roundCards.map(a => ({ ...a })),
    deck: state.deck.map(a => ({ ...a })),
    majorMarket: state.majorMarket.map(m => ({ ...m })),
    harvestQueue: [...state.harvestQueue],
    players: state.players.map(p => ({
      ...p,
      res: { ...p.res },
      farm: [...p.farm],
      farmCounts: [...p.farmCounts],
      farmContent: [...p.farmContent],
      fences: new Set(p.fences),
      majors: [...p.majors],
      occupations: [...p.occupations],
      minorImprovements: [...p.minorImprovements],
      occupationHand: [...p.occupationHand],
      minorHand: [...p.minorHand],
      cardRuntime: JSON.parse(JSON.stringify(p.cardRuntime || {})),
      animals: { ...p.animals },
    })),
    log: [], // don't clone log for simulation
  };
  return cloned;
}

module.exports = { createInitialState, createPlayer, cloneState };
