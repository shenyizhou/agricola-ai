/**
 * HeuristicAI - Evaluation + staged rollout policy for Agricola.
 *
 * Key insight: worker count is the dominant multiplier (each worker gives
 * ~1 extra action per remaining round). Rooms and building resources are
 * valued by their ability to UNLOCK growth, not as raw stock.
 */

const { GameEngine } = require('../engine/GameEngine');
const { cloneState } = require('../engine/GameState');
const { LIMIT_FENCES } = require('../constants');

const HEUR_HARVEST_ROUNDS = [4, 7, 9, 11, 13, 14];
const HEUR_MAX_ROUNDS = 14;

// Cost of a new room by house type
function roomCost(houseType) {
  if (houseType === 'wood') return { wood: 5, reed: 2 };
  if (houseType === 'clay') return { clay: 5, reed: 2 };
  return { stone: 5, reed: 2 };
}

// Cost to renovate (per existing room)
function renoCost(houseType, rooms) {
  if (houseType === 'wood') return { clay: rooms, reed: rooms };
  if (houseType === 'clay') return { stone: rooms, reed: rooms };
  return null;
}

function canAfford(p, cost) {
  return Object.entries(cost).every(([k, v]) => (p.res[k] || 0) >= v);
}

/**
 * Fraction (0..1) of the way to affording `cost`.
 * Returns 1 if already affordable.
 */
function affordFraction(p, cost) {
  let need = 0, have = 0;
  for (const [k, v] of Object.entries(cost)) {
    need += v;
    have += Math.min(v, p.res[k] || 0);
  }
  return need === 0 ? 1 : have / need;
}

/**
 * Evaluate a state from the perspective of player `pId`.
 * Higher is better. Scale roughly 0..100 during game, x100 at terminal.
 */
function evaluateState(engine, pId) {
  const p = engine.state.players[pId];
  const round = engine.state.round;
  const roundsLeft = Math.max(0, HEUR_MAX_ROUNDS - round + 1);
  let score = 0;

  const rooms = p.farm.filter(t => t === 1).length;
  const fields = p.farm.filter(t => t === 2).length;
  const workers = p.res.maxWorkers;
  const emptyRooms = rooms - workers; // capacity for new children

  // ===== Workers: the dominant multiplier =====
  // Per the beginner guide: target is 3 workers (5 wood + 2 reed → 3-room house
  // → grow to 3). 2→3 is huge; 3→4 solid; 4→5 win-more.
  if (workers >= 3) score += roundsLeft * 1.5;
  if (workers >= 4) score += roundsLeft * 1.0;
  if (workers >= 5) score += roundsLeft * 0.5;

  // Empty rooms are a worker "in waiting": one grow action away from a new
  // worker. Value them slightly below a worker (1.5) but clearly ABOVE the
  // "ready to build" state below, so the AI actually converts resources into
  // rooms instead of hoarding them.
  score += Math.min(1, emptyRooms) * roundsLeft * 1.3;
  if (emptyRooms > 1) score += (emptyRooms - 1) * roundsLeft * 0.4;

  // Build-readiness: if worker-capped and close to affording the NEXT room.
  // Target 3 workers first; only push for 4th if game is past R7; 5th past R10.
  const wantMoreRooms = workers < 3 || (workers < 4 && round >= 7) || (workers < 5 && round >= 10);
  if (emptyRooms === 0 && wantMoreRooms) {
    const cost = roomCost(p.houseType);
    const frac = affordFraction(p, cost);
    // Readiness must be worth LESS than actually having the empty room (1.3),
    // otherwise the AI hoards build materials and never builds.
    const spike = (workers === 2 && round <= 6) ? 0.9 : 0.6;
    score += frac * roundsLeft * spike;
    // Small base signal even when frac==0 so the AI starts accumulating.
    score += (1 - frac) * roundsLeft * 0.4;
  }

  // ===== Food security near harvest =====
  const nextHarvest = HEUR_HARVEST_ROUNDS.find(r => r >= round);
  const roundsToHarvest = nextHarvest ? nextHarvest - round : 99;
  const foodNeeded = workers * 2;
  if (roundsToHarvest <= 1) {
    const foodDeficit = Math.max(0, foodNeeded - p.res.food);
    score -= foodDeficit * 15; // begging card = -3 + losing animals/crops, brutal
  } else if (roundsToHarvest <= 3) {
    const foodDeficit = Math.max(0, foodNeeded - p.res.food);
    score -= foodDeficit * 5;
  } else if (roundsToHarvest <= 5) {
    // Medium-term: should be roughly on track
    const foodDeficit = Math.max(0, foodNeeded / 2 - p.res.food);
    score -= foodDeficit * 2;
  }
  // Food in the bank has modest value (diminishing)
  score += Math.min(p.res.food, foodNeeded + 4) * 0.5;

  // ===== Resource valuation =====
  // Build resources have low base value; most of their value comes from
  // build-readiness above. Wood is ranked highest among build resources
  // because it builds BOTH rooms AND fences; clay mainly renovates/cooks;
  // reed is scarce (needed for every build and reno); stone is late-game.
  score += p.res.wood * 0.35;
  score += p.res.clay * 0.2;
  score += p.res.reed * 0.4;
  score += p.res.stone * 0.4;

  // Reno readiness: if wood/clay house and close to affording reno, value it
  const rc = renoCost(p.houseType, rooms);
  if (rc) {
    const frac = affordFraction(p, rc);
    // Reno is worth a few points per room at endgame
    score += frac * rooms * 1.5;
  }

  // Well readiness: well costs 3 stone + 1 wood, gives 4 pts + 1 food at start
  // of each of the next 5 rounds (5 food total). Per guide: "井，给5食物。
  // 有4分，分数性价比超高！"
  const hasWell = p.majors.some(m => m.special === 'well');
  if (hasWell) {
    const well = p.majors.find(m => m.special === 'well');
    const roundsSince = well.wellStartRound != null ? round - well.wellStartRound : 5;
    const foodRemaining = Math.max(0, 5 - Math.max(0, roundsSince));
    score += 4 + foodRemaining * 0.8;
  } else if (round >= 4) {
    // Only start valuing well materials from R4 onward (stone isn't an R1-3
    // priority per the guide).
    const wellCost = { stone: 3, wood: 1 };
    const frac = affordFraction(p, wellCost);
    const wellValue = 4 + Math.min(5, roundsLeft) * 0.8;
    score += frac * wellValue * 0.8;
    score += (1 - frac) * 1.0; // mild signal to accumulate stone
  }

  // Cooker readiness: without a cook/bake major, animals can't be turned into
  // food at harvest. Cheapest cooker is 2 clay.
  const hasCooker = p.majors.some(m => m.type === 'cook' || m.type === 'bake');
  if (!hasCooker) {
    const cookerCost = { clay: 2 };
    const frac = affordFraction(p, cookerCost);
    // Cooker becomes critical by R5-6 (sheep arrive). Give a base "need clay"
    // signal even when frac==0 so the AI accumulates clay, plus a big spike
    // when we're close (1 clay) or can buy it (frac==1).
    const cookerUrgency = round >= 5 ? 1.5 : (round >= 3 ? 0.8 : 0.3);
    // Readiness must be worth LESS than actually owning a cooker (~5.5 pts:
    // 3 base + 1.5 major + 1 score), else the AI hoards clay and never buys one.
    score += frac * 2 * cookerUrgency;
    score += (1 - frac) * 1.5 * cookerUrgency;
  } else {
    // Cooker owned: solid food engine.
    score += 3;
  }

  // Food/resources that score directly.
  // Per guide: unplanted grain/veg are weak resources, but with a baker grain
  // is a food engine (1 grain → bakeRate food), so value it higher then.
  const baker = p.majors.find(m => m.bakeRate || m.specialBake);
  const grainFood = baker ? (baker.specialBake ? baker.specialBake.out / baker.specialBake.in : baker.bakeRate) : 1;
  score += p.res.grain * Math.max(0.5, grainFood * 0.8);
  score += p.res.veg * 1.0;
  score += p.animals.sheep * 1.5;
  score += p.animals.boar * 2.0;
  score += p.animals.cow * 3.0;

  // ===== Farm development =====
  // Fields: 5 fields = 4 endgame pts, plus sown crops generate food/grain/veg.
  score += fields * 3.5;
  if (fields >= 2) score += 2;
  if (fields >= 4) score += 3;
  if (fields >= 5) score += 2;

  score += p.stablesCount * 2.5;

  // Sown crops: veg cooks to 2-3 food and scores higher; grain is 1:1. Value
  // by remaining harvests.
  const sownGrain = p.farmContent ? p.farmContent.filter(c => c === 'grain').length : 0;
  const sownVeg = p.farmContent ? p.farmContent.filter(c => c === 'veg').length : 0;
  const harvestsLeft = HEUR_HARVEST_ROUNDS.filter(r => r >= round).length;
  score += sownGrain * (1 + harvestsLeft * 0.4);
  score += sownVeg * (2 + harvestsLeft * 1.0);

  // Unused-farm-space penalty. Endgame scoring is -(15 - occupied), so empty
  // tiles are a brutal late-game drain. Ramp the pressure up earlier and
  // harder so the AI fills the farm from R8 onward.
  const occupied = p.farm.filter(t => t !== 0).length;
  const emptyTiles = 15 - occupied;
  const fillUrgency = Math.max(0, 1 - roundsLeft / 12);
  score -= emptyTiles * fillUrgency * 3.0;
  // Pastures (each 4 fences ≈ 1 pasture, worth up to ~4 endgame points)
  const pastureTiles = Math.floor(p.fences.size / 4);
  score += pastureTiles * 2.0;
  // If we hold animals but lack capacity, wood-for-fences is more valuable
  const totalAnimals = p.animals.sheep + p.animals.boar + p.animals.cow;
  const animalCapacity = pastureTiles * 2 + p.stablesCount * 2 + 1;
  if (totalAnimals >= animalCapacity && p.res.wood < 4) {
    score += (4 - p.res.wood) * 0.3;
  }

  // Endgame diversity bonus: at least 1 of each animal/crop = baseline points.
  // Per guide: "羊、猪、牛、麦、菜 至少都要 1 个，拿保底分".
  if (roundsLeft <= 4) {
    if (p.animals.sheep >= 1) score += 1;
    if (p.animals.boar >= 1) score += 1.5;
    if (p.animals.cow >= 1) score += 2;
    if (p.res.grain >= 1) score += 1;
    if (p.res.veg >= 1) score += 1.5;
  }

  // House type
  if (p.houseType === 'clay') score += 3;
  if (p.houseType === 'stone') score += 8;

  // Majors (cook improvement especially)
  score += p.majors.length * 1.5;
  score += p.majors.reduce((s, m) => s + (m.score || 0), 0);

  // Played occupations & minor improvements: their effects compound over every
  // remaining round, so they carry ongoing value beyond any immediate VP.
  // Occupations are valued higher because several are best played early (the
  // first lesson is free), so an early occupation pays off all game long.
  score += p.occupations.length * 2.0;
  score += p.minorImprovements.length * 1.0;

  // Begging
  score -= p.begging * 8;

  // Terminal: use actual score
  if (engine.state.phase === 'ended') {
    return engine.calculateScore(p) * 100;
  }

  return score;
}

/**
 * Greedy AI: pick the action that gives the best immediate evaluation.
 */
function greedyPolicy(engine, actions) {
  const pId = engine.currentPlayer.id;
  const candidates = filterNoopActions(engine, pruneDominatedActions(actions));
  let bestAction = candidates[0];
  let bestScore = -Infinity;

  for (const raw of candidates) {
    const action = resolveActionChoices(engine, raw);
    const simEngine = cloneEngineForSimulation(engine);
    try {
      simEngine.applyAction(action);
      const score = evaluateState(simEngine, pId);
      if (score > bestScore) {
        bestScore = score;
        bestAction = action;
      }
    } catch (e) {
      // skip
    }
  }
  return bestAction;
}

/**
 * For actions with ambiguous outcomes (build_menu = build room OR stable,
 * major = pick which major), attach explicit choices so sim outcomes are
 * deterministic and AI doesn't accidentally build a stable when it wanted
 * a room (or vice versa).
 */
function resolveActionChoices(engine, action) {
  if (action.mode === 'build_menu' && !action.choices) {
    const p = engine.currentPlayer;
    const canRoom = engine._canBuildRoom(p);
    if (canRoom) return { ...action, choices: { buildRooms: true, buildStables: false } };
    return { ...action, choices: { buildRooms: false, buildStables: false } };
  }
  if (action.mode === 'major' && !action.choices) {
    const p = engine.currentPlayer;
    // A real cooker (m1-m4, has a `cook` table) is the food engine. If we
    // don't own one yet, prefer the cheapest cooker over the highest-score
    // major (bake ovens m9/m10 and well don't cook animals/veg in headless).
    const hasCooker = p.majors.some(m => m.cook);
    let pick = null;
    if (!hasCooker) {
      pick = engine.state.majorMarket
        .filter(m => m.cook && engine._canAfford(p, m.cost))
        .sort((a, b) => (a.cost.clay || 0) - (b.cost.clay || 0))[0];
    }
    if (!pick) pick = engine._pickBestMajor(p);
    if (pick) return { ...action, choices: { majorId: pick.id } };
  }
  // Fence: default to spending up to 4 wood (1 pasture) if affordable.
  if (action.mode === 'fence' && !action.choices) {
    const p = engine.currentPlayer;
    const wood = Math.min(4, p.res.wood, 15 - p.fences.size);
    return { ...action, choices: { fences: wood } };
  }
  return action;
}

/**
 * Random policy - baseline.
 */
function randomPolicy(engine, actions) {
  return actions[Math.floor(Math.random() * actions.length)];
}

/**
 * Staged rollout policy: priority-ordered strategy that knows the
 * "build room -> grow -> plow/sow -> diversify" rhythm of Agricola.
 * Adds a small amount of noise so rollouts stay stochastic.
 */
function stagedRolloutPolicy(engine, actions) {
  const pId = engine.currentPlayer.id;
  const p = engine.state.players[pId];
  const round = engine.state.round;
  actions = filterNoopActions(engine, pruneDominatedActions(actions)).map(a => resolveActionChoices(engine, a));

  // Small epsilon noise keeps MCTS rollouts stochastic so it can average out
  // variance and distinguish robust moves (deterministic rollouts collapse
  // MCTS to 1-ply greedy).
  if (actions.length > 1 && Math.random() < 0.15) {
    return actions[Math.floor(Math.random() * actions.length)];
  }

  const rooms = p.farm.filter(t => t === 1).length;
  const fields = p.farm.filter(t => t === 2).length;
  const workers = p.res.maxWorkers;
  const emptyRooms = rooms - workers;

  const byId = id => actions.find(a => a.id === id);
  const byMode = mode => actions.find(a => a.mode === mode);
  const hasWell = p.majors.some(m => m.special === 'well');
  const hasCook = p.majors.some(m => m.cook); // only real cookers (m1-m4)

  // 1) Grow: workers are the dominant multiplier (more actions → more of
  //    everything). But each worker costs 2 food/harvest, so we only grow once
  //    a food engine (cooker + animals/veg) is producing. 2→3 is the opening
  //    spike; 4th/5th need a real food engine or a large food bank.
  if (emptyRooms > 0 && workers < 5) {
    const nextNeed = (workers + 1) * 2;
    const totalAnimals = p.animals.sheep + p.animals.boar + p.animals.cow;
    const sownCrops = p.farmContent ? p.farmContent.filter(c => c != null).length : 0;
    const foodEngine = hasCook && (totalAnimals >= 2 || sownCrops >= 1);
    let foodOk;
    // 3rd worker is the biggest multiplier in the game; grow it as soon as an
    // empty room exists, then gate the 4th/5th on a real food engine.
    if (workers === 2) foodOk = round <= 9 || p.res.food >= nextNeed + 2 || foodEngine;
    else if (workers === 3) foodOk = foodEngine || p.res.food >= nextNeed + 4; // 4th
    else foodOk = foodEngine && (totalAnimals >= 3 || sownCrops >= 2 ||
      p.res.food >= nextNeed + 4);                        // 5th
    if (foodOk) {
      const grow = byMode('grow') || byMode('grow_force');
      if (grow) return grow;
    }
  }
  // Forced growth (hasty, no room): late game only, with a food buffer.
  if (round >= 11 && workers < 5 && emptyRooms === 0) {
    const forceGrow = byMode('grow_force');
    if (forceGrow && p.res.food >= (workers + 1) * 2) return forceGrow;
  }

  // 2) Food emergency: begging cards are -3 each. If next harvest is close
  //    and we can't feed, grab food now.
  const nextHarvest = HEUR_HARVEST_ROUNDS.find(r => r >= round);
  const roundsToHarvest = nextHarvest ? nextHarvest - round : 99;
  const foodNeeded = workers * 2;
  if (roundsToHarvest <= 2 && p.res.food < foodNeeded) {
    const foodAction = bestFoodAction(engine, actions);
    if (foodAction) return foodAction;
  }

  // 2b) Free first occupation: the first lesson is free, so the lesson space is
  //     hotly contested in the opening. Grab it early — but only the free one;
  //     paid lessons wait until the room/food engine is secured (step 3e).
  if (p.occupationHand.length > 0) {
    const lesson = byMode('lesson') || byMode('lesson2');
    if (lesson) {
      const cost = engine._lessonCost ? engine._lessonCost(p, lesson) : 0;
      if (cost === 0 && round <= 4) return lesson;
    }
  }

  // 2c) Meeting space (next start player) must be grabbed in two tempo spots,
  //     even without a minor improvement to play:
  //     - Round 4/5: grow (生儿育女) unlocks in stage 2 (rounds 5-7). If it
  //       hasn't appeared yet and we (or others) can grow, becoming start player
  //       guarantees the first pick of the grow space next round.
  //     - Round 11: round 12 reveals one of the powerful last-stage cards
  //       (犁地+播种 / 急于求成 / 翻修+栅栏); start player gets first crack.
  const meeting = byMode('meeting');
  const growUnlocked = (engine.state.roundCards || []).some(c => c.mode === 'grow');
  const canGrow = rooms > workers || emptyRooms > 0;
  if (meeting) {
    if (round === 4 && !growUnlocked && canGrow) return meeting;
    if (round === 5 && !growUnlocked && canGrow) return meeting;
    if (round === 11) return meeting;
  }

  // 3) Build a room when affordable and we can still grow. Don't over-invest
  //    in rooms (wood/reed) until a food engine is producing, or we starve.
  const totalAnimalsPre = p.animals.sheep + p.animals.boar + p.animals.cow;
  const sownCropsPre = p.farmContent ? p.farmContent.filter(c => c != null).length : 0;
  const foodEnginePre = hasCook && (totalAnimalsPre >= 2 || sownCropsPre >= 1);
  // Priority ladder per strategy: the FIRST room (2→3 workers) is the top
  // building priority. Only after the food engine is stable AND there are
  // still enough rounds left do we build a 4th/5th room; otherwise points.
  const wantBuild = (workers < 3) ||
    (workers < 4 && foodEnginePre && round <= 9) ||
    (workers < 5 && foodEnginePre && (totalAnimalsPre >= 3 || sownCropsPre >= 2) && round <= 7);
  if (emptyRooms === 0 && wantBuild) {
    const cost = roomCost(p.houseType);
    if (canAfford(p, cost)) {
      const build = byMode('build_menu');
      if (build) return { ...build, choices: { buildRooms: true, buildStables: false } };
    }

    // Gather missing materials. R1-3: take resource market first (covers reed
    // + stone + food per guide). Then target scarcest resource.
    if (round <= 3) {
      const market = actions.find(a => a.type === 'res_combo');
      if (market) return market;
    }
    if (round <= 11) {
      let scarcest = null, scarcity = 0;
      for (const [res, need] of Object.entries(cost)) {
        const have = p.res[res] || 0;
        const short = need - have;
        if (short > 0) {
          const weight = res === 'reed' ? short * 2.5 : short;
          if (weight > scarcity) { scarcity = weight; scarcest = res; }
        }
      }
      if (scarcest) {
        if (scarcest === 'reed') {
          const market = actions.find(a => a.type === 'res_combo');
          if (market) return market;
        }
        const candidates = actions
          .filter(a => a.type === 'res' && a.res === scarcest)
          .map(a => ({ a, amount: a.amount || a.cur || a.acc || 1 }))
          .sort((x, y) => y.amount - x.amount);
        if (candidates.length > 0) return candidates[0].a;
      }
    }
  }

  // 3a) Once the first room is built and we've grown to 3 workers, the food
  //     engine becomes the top non-grow priority. Without a cooker the 3-worker
  //     household starves; grab clay now even if it delays a 4th room.
  if (!hasCook && workers >= 3 && p.res.clay < 2) {
    const clayActs = actions.filter(a => a.type === 'res' && a.res === 'clay')
      .sort((x, y) => (y.amount || 0) - (x.amount || 0));
    if (clayActs.length > 0) return clayActs[0];
  }

  // 3b) Buy cooker once 2 clay available AND room is built or materials secured.
  if (!hasCook && p.res.clay >= 2 && (workers >= 3 || canAfford(p, roomCost(p.houseType)) || round >= 4)) {
    const major = byMode('major');
    if (major) return major;
  }

  // 3c) Gather clay for cooker if we already have most room materials (≥3 wood
  //     or ≥1 reed), so we don't delay the first room.
  if (!hasCook && p.res.clay < 2 && round >= 2 && round <= 6 &&
      (p.res.wood >= 3 || p.res.reed >= 1)) {
    const clayActs = actions.filter(a => a.type === 'res' && a.res === 'clay')
      .sort((x, y) => (y.amount || 0) - (x.amount || 0));
    if (clayActs.length > 0) return clayActs[0];
  }

  // 3d) Mid-game resource market still good (reed + stone + food bundle).
  if (round <= 5) {
    const market = actions.find(a => a.type === 'res_combo');
    if (market) return market;
  }

  // 3e) Additional cards once the foundation is set (3+ workers). Extra
  //     occupations and playable minor improvements are worth an action, but
  //     only after the opening room/growth so we don't starve chasing cards.
  if (workers >= 3) {
    if (p.occupationHand.length > 0 && p.occupations.length < 3 && round <= 9) {
      const lesson = byMode('lesson') || byMode('lesson2');
      if (lesson) {
        const cost = engine._lessonCost ? engine._lessonCost(p, lesson) : 0;
        if (p.res.food >= cost + 2) return lesson;
      }
    }
    // Meeting space only when we can actually play a minor improvement.
    if (p.minorHand && p.minorHand.length > 0 && engine._pickPlayableMinor && round <= 10) {
      const meeting = byMode('meeting');
      if (meeting && engine._pickPlayableMinor(p)) return meeting;
    }
  }

  // 4) Sheep bulk grab is part of the food engine: with a cooker, 2 sheep = 4
  //    food, 3 = 6. Grab as soon as 2+ pile up so we don't starve waiting.
  const sheepAct = actions.find(a => a.res === 'sheep');
  if (sheepAct && hasCook) {
    const sheepAmt = sheepAct.amount || sheepAct.cur || 1;
    if (sheepAmt >= 2) return sheepAct;
  }

  // 5) Plow: 2 fields early for baseline; 4-5 fields in mid/late game. Don't
  //    over-plow before workers + food engine are secured.
  if (fields < 2) {
    const plow = byMode('plow_sow') || byId('act_plow') || byMode('plow');
    if (plow) return plow;
  }
  if (workers >= 3 && fields < 5 && round >= 6) {
    const plow = byMode('plow_sow') || byId('act_plow') || byMode('plow');
    if (plow) return plow;
  }

  // 6) Fill farm tiles: stables (2 wood = +1 pt + 1 tile + 2 animal capacity)
  //    and fences/pastures (4 wood = 1 pasture tile + animal capacity). Each
  //    empty tile is -1 at endgame, so filling the farm is a top priority.
  //    Gather wood explicitly here when short — after the room-building rush
  //    the policy otherwise never regains wood for fences/stables.
  if (round >= 5) {
    const occupied = p.farm.filter(t => t !== 0).length;
    const empty = 15 - occupied;
    if (empty >= 2) {
      if (p.res.wood < 2) {
        const woodAct = actions.filter(a => a.type === 'res' && a.res === 'wood')
          .sort((x, y) => (y.amount || 0) - (x.amount || 0))[0];
        if (woodAct) return woodAct;
      }
      if (p.res.wood >= 2 && p.stablesCount < 4) {
        const build = byMode('build_menu');
        if (build) return { ...build, choices: { buildRooms: false, buildStables: true } };
      }
      if (p.res.wood >= 4 && p.fences.size < LIMIT_FENCES) {
        const fence = byMode('fence');
        if (fence) return { ...fence, choices: { fences: Math.min(4, p.res.wood) } };
      }
      if (fields < 5) {
        const plow = byMode('plow_sow') || byId('act_plow') || byMode('plow');
        if (plow) return plow;
      }
    }
  }

  // 7) Sow veg first (cooks to 2-3 food, scores higher), then grain (1:1).
  const sownCount = p.farmContent ? p.farmContent.filter(c => c != null).length : 0;
  const unsownFields = fields - sownCount;
  if (unsownFields > 0 && (p.res.grain > 0 || p.res.veg > 0)) {
    const sow = byMode('sow') || byMode('plow_sow');
    if (sow) return sow;
  }

  // 7b) Acquire seeds if we have empty fields.
  if (unsownFields > 0) {
    if (p.res.veg === 0 && round >= 5) {
      const vegAct = actions.find(a => a.res === 'veg' || a.mode === 'veg');
      if (vegAct) return vegAct;
    }
    if (p.res.grain === 0 && round <= 8) {
      const grainAct = actions.find(a => a.res === 'grain');
      if (grainAct) return grainAct;
    }
  }

  // 8) Animals for scoring, once we have capacity (pastures/stables). Sheep
  //    first (cooks 2 food, breeds fastest), then boar/cow.
  const capacity = p.stablesCount * 2 + Math.floor(p.fences.size / 4) * 2 + 1;
  const held = p.animals.sheep + p.animals.boar + p.animals.cow;
  if (held < capacity) {
    for (const animal of ['sheep', 'boar', 'cow']) {
      const act = actions.find(a => a.res === animal);
      if (!act) continue;
      const amt = act.amount || act.cur || 1;
      if (amt >= 2 || round >= 9) return act;
    }
  }

  // 9) Cooker / well majors + clay accumulation.
  const major = byMode('major');
  if (major) {
    if (!hasCook && p.res.clay >= 2) return major;
    if (!hasWell && p.res.stone >= 3 && p.res.wood >= 1) {
      return { ...major, choices: { majorId: 'm5' } };
    }
  }
  if (!hasCook && p.res.clay < 2 && round >= 3 && round <= 8) {
    const clayActs = actions.filter(a => a.type === 'res' && a.res === 'clay')
      .sort((x, y) => (y.amount || 0) - (x.amount || 0));
    if (clayActs.length > 0) return clayActs[0];
  }

  // 10) Renovate: clay +1/room, stone +2/room. Only when spare reed exists
  //    (reed is shared with room building, which is more important).
  if (p.houseType === 'wood' && round >= 8) {
    const rc = renoCost('wood', rooms);
    if (canAfford(p, rc)) {
      const reno = byMode('reno_major') || byMode('reno_fence');
      if (reno) return reno;
    }
  }
  if (p.houseType === 'clay' && round >= 11) {
    const rc = renoCost('clay', rooms);
    if (rc && canAfford(p, rc)) {
      const reno = byMode('reno_major') || byMode('reno_fence');
      if (reno) return reno;
    }
  }

  // 11) Late-game diversity: grab 1 of each missing category (avoid -1 tiers).
  if (round >= 10) {
    const gaps = [];
    if (p.animals.sheep < 1) gaps.push('sheep');
    if (p.animals.boar < 1) gaps.push('boar');
    if (p.animals.cow < 1) gaps.push('cow');
    if (p.res.grain < 1) gaps.push('grain');
    if (p.res.veg < 1) gaps.push('veg');
    for (const g of gaps) {
      const a = actions.find(x => x.res === g || x.mode === g);
      if (a) return a;
    }
  }

  // 12) Fallback: greedy.
  return greedyPolicy(engine, actions);
}

function roundsInLateGame(round) {
  return round >= 12;
}

function bestFoodAction(engine, actions) {
  const p = engine.currentPlayer;
  const cooker = p.majors.find(m => m.cook);
  let best = null, bestGain = 0;
  for (const a of actions) {
    let gain = 0;
    if (a.type === 'res' && a.res === 'food') gain = a.amount || a.cur || 1;
    if (a.id === 'act_labor') gain = 2;
    // With a cooker, animals and veg convert to (more) food, so they're a
    // better emergency food source than raw 1-food actions.
    if (cooker && a.type === 'res' && ['sheep', 'boar', 'cow'].includes(a.res)) {
      gain = (a.amount || a.cur || 1) * (cooker.cook[a.res] || 1);
    }
    if (cooker && a.type === 'res' && a.res === 'veg') {
      gain = (a.amount || a.cur || 1) * (cooker.cook.veg || 1);
    }
    if (gain > bestGain) { bestGain = gain; best = a; }
  }
  return best;
}

/**
 * Create a lightweight engine clone for simulation.
 */
function cloneEngineForSimulation(engine) {
  const sim = new GameEngine(engine.numPlayers);
  sim.state = cloneState(engine.state);
  sim._actionDefs = engine._actionDefs.map(a => ({ ...a }));
  sim.state.roundCards = engine.state.roundCards.map(a => ({ ...a }));
  sim.state.majorMarket = engine.state.majorMarket.map(m => ({ ...m }));
  if (engine.cards) {
    const { CardEffectSystem } = require('../engine/card-effects');
    sim.cards = new CardEffectSystem(sim);
  }
  return sim;
}

/**
 * Remove actions strictly dominated by another available action.
 *
 * For simple resource actions (type === 'res'), if two actions give the same
 * resource, keep only the one with the highest current amount. This reflects
 * the obvious "2 food > 1 food" / "3 wood > 2 wood > 1 wood" dominance.
 *
 * Note: accumulation means a lower-base action can sometimes out-scale a
 * fixed one (e.g. fishing cur=3 > labor fixed=2), so we compare the LIVE
 * `amount` field, not static definitions.
 *
 * All non-res actions (build, plow, sow, grow, majors, combos, etc.) are
 * always retained.
 */
function pruneDominatedActions(actions) {
  const bestByRes = new Map(); // res -> action with max amount

  for (const a of actions) {
    if (a.type === 'res' && a.res) {
      const cur = bestByRes.get(a.res);
      if (!cur || (a.amount || 0) > (cur.amount || 0)) {
        bestByRes.set(a.res, a);
      }
    }
  }

  // The resource market (1 reed + 1 stone + 1 food) strictly dominates taking
  // 1 reed alone, so never consider reed when the market is available.
  const marketAvailable = actions.some(a => a.type === 'res_combo');

  return actions.filter(a => {
    if (a.type === 'res' && a.res) {
      if (bestByRes.get(a.res) !== a) return false;
      if (marketAvailable && a.res === 'reed') return false;
    }
    return true;
  });
}

/**
 * Filter out actions that are known no-ops for the current player (e.g.
 * build_menu when room is unaffordable and we don't want a stable). Without
 * this, MCTS wastes visits on actions that do nothing.
 */
function filterNoopActions(engine, actions) {
  const p = engine.currentPlayer;
  return actions.filter(a => {
    if (a.mode === 'build_menu') {
      if (engine._canBuildRoom(p)) return true;
      if (engine.state.round >= 8 && p.res.wood >= 2 && p.stablesCount < 4) return true;
      return false;
    }
    // Major action is a no-op if no major is affordable.
    if (a.mode === 'major') {
      return engine.state.majorMarket.some(m => engine._canAfford(p, m.cost));
    }
    // Reno_major requires being able to renovate.
    if (a.mode === 'reno_major' || a.mode === 'reno_fence') {
      if (p.houseType === 'stone') return false;
      const rc = renoCost(p.houseType, p.farm.filter(t => t === 1).length);
      return rc && canAfford(p, rc);
    }
    // Fence needs wood.
    if (a.mode === 'fence' && p.res.wood < 1) return false;
    // Plow requires empty field tile.
    if (a.mode === 'plow' && !p.farm.some((t, i) => t === 0 &&
        (!p.farm.some(x => x === 2) || engine._hasNeighbor(p, i, 2)))) return false;
    return true;
  });
}

module.exports = {
  evaluateState,
  greedyPolicy,
  randomPolicy,
  stagedRolloutPolicy,
  pruneDominatedActions,
  filterNoopActions,
  resolveActionChoices,
  cloneEngineForSimulation,
};
