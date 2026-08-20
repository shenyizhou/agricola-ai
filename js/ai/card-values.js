/**
 * Single-card valuation + build-around plan system.
 *
 * Two layers:
 *
 *   1. CARD_BASE_VALUE  — hand-curated 1..10 strength per card, plus an
 *      archetype tag. valueCard() applies a timing curve (engine cards decay
 *      as the game goes on; pure-score cards rise).
 *
 *   2. choosePlan()     — on the opening turn, inspect the 7+7 card hand and
 *      pick a "north star" S/A+ card to build around. The plan carries
 *      round-indexed milestones (e.g. bigFarm: R3 2 fields, R5 4 fields +
 *      wood for fences, R7 9-tile pasture). evaluateState / rollout policy
 *      read planProgress() to reweight actions around those milestones.
 *
 * The north-star card is NOT played immediately: it sits in hand until its
 * enablers are in place or its trigger window opens.
 */

// ======================== Base card table ========================
//
// value  : 1..10 static strength assuming the deck's average power level.
//          S (9-10) = build-around, A (7-8) = always happy to play,
//          B (5-6)  = solid, C (3-4) = niche/filler, D (1-2) = trap.
// arche  : 'build' | 'farm' | 'animal' | 'cards' | 'stone' | 'food' | 'flex'
// timing : 'engine' (decays) | 'score' (rises late) | 'burst' (flat) |
//          'discount' (flat while build rounds remain)
// tags   : (optional) synergy package tag(s). Cards sharing a tag STACK:
//          each other in-hand/played card with the same tag adds a synergy
//          bonus. A hand containing 2+ cards of a tag can itself anchor a
//          "package" plan even without a single S-tier card.
// buildAround: true if strong enough to anchor a plan.

const CARD_TABLE = {
  // -------- Occupations (28) --------
  A116: { v: 9, arche: 'build',  timing: 'engine',   buildAround: true, tags: ['wood']        }, // Wood Cutter
  A143: { v: 7, arche: 'stone',  timing: 'discount', buildAround: true                         }, // Stonecutter
  B126: { v: 8, arche: 'build',  timing: 'discount', buildAround: true, tags: ['room']        }, // Carpenter
  B145: { v: 6, arche: 'build',  timing: 'discount',                       tags: ['room']        }, // Brushwood Collector
  C88:  { v: 7, arche: 'build',  timing: 'discount', buildAround: true, tags: ['room','wood'] }, // Carpenter's Apprentice
  C102: { v: 4, arche: 'flex',   timing: 'engine',                         tags: ['wood']        }, // Tree Guard
  C126: { v: 5, arche: 'stone',  timing: 'engine',                         tags: ['dayLaborer']  }, // Excavator
  B117: { v: 5, arche: 'build',  timing: 'engine',                         tags: ['wood']        }, // Informant
  B87:  { v: 5, arche: 'build',  timing: 'engine',                         tags: ['dayLaborer','room'] }, // Cottager
  B91:  { v: 7, arche: 'farm',   timing: 'engine',   buildAround: true, tags: ['dayLaborer','plow'] }, // Assistant Tiller
  B114: { v: 4, arche: 'food',   timing: 'engine'                                                 }, // Childless
  D92:  { v: 6, arche: 'food',   timing: 'engine'                                                 }, // Child Ombudsman
  B151: { v: 8, arche: 'flex',   timing: 'engine',   buildAround: true                              }, // Little Peasant
  D152: { v: 8, arche: 'cards',  timing: 'engine',   buildAround: true, tags: ['occupationEngine'] }, // Patron
  A114: { v: 4, arche: 'farm',   timing: 'engine',                         tags: ['dayLaborer']  }, // Seasonal Worker
  A138: { v: 2, arche: 'food',   timing: 'engine'                                                 }, // Harpooner
  D137: { v: 7, arche: 'flex',   timing: 'engine'                                                 }, // Trade Teacher
  D138: { v: 5, arche: 'animal', timing: 'engine'                                                 }, // Pet Lover
  E103: { v: 4, arche: 'animal', timing: 'engine'                                                 }, // Wolf
  C125: { v: 7, arche: 'build',  timing: 'engine',   buildAround: true                              }, // Nightworker
  A97:  { v: 4, arche: 'cards',  timing: 'engine',                         tags: ['occupationEngine'] }, // Freshman (needs baker)
  A131: { v: 7, arche: 'cards',  timing: 'engine',   buildAround: true, tags: ['occupationEngine'] }, // Craft Teacher
  D97:  { v: 2, arche: 'cards',  timing: 'engine'                                                 }, // Begging Student (-1 begging)
  B161: { v: 3, arche: 'food',   timing: 'engine'                                                 }, // Weakling
  A133: { v: 6, arche: 'build',  timing: 'score'                                                  }, // Braggart
  B132: { v: 4, arche: 'farm',   timing: 'score'                                                  }, // Estate Master
  B136: { v: 6, arche: 'build',  timing: 'burst',                          tags: ['room']        }, // House Steward
  C99:  { v: 4, arche: 'farm',   timing: 'score'                                                  }, // Garden Designer

  // -------- Minor improvements (28) --------
  A14:  { v: 6, arche: 'build',  timing: 'discount', tags: ['room']        }, // Carpenter's Hammer
  A15:  { v: 3, arche: 'build',  timing: 'discount', tags: ['wood']        }, // Carpenter's Axe
  A16:  { v: 4, arche: 'animal', timing: 'discount', tags: ['fence']       }, // Rammed Clay
  B13:  { v: 9, arche: 'build',  timing: 'discount', buildAround: true, tags: ['room'] }, // Carpenter's Parlor
  B15:  { v: 5, arche: 'animal', timing: 'engine',   tags: ['wood','fence'] }, // Carpenter's Bench
  C82:  { v: 4, arche: 'stone',  timing: 'burst',    tags: ['dayLaborer']  }, // Hardware Store
  D4:   { v: 5, arche: 'build',  timing: 'burst',    tags: ['wood']        }, // Cross-Cut Wood
  D74:  { v: 6, arche: 'build',  timing: 'discount', tags: ['wood']        }, // Royal Wood
  B10:  { v: 9, arche: 'food',   timing: 'burst',    buildAround: true      }, // Caravan
  B21:  { v: 8, arche: 'food',   timing: 'engine',   buildAround: true      }, // Hayloft Barn
  B22:  { v: 8, arche: 'food',   timing: 'burst',    buildAround: true      }, // Walking Boots
  D21:  { v: 5, arche: 'food',   timing: 'engine'                          }, // Recruitment
  C3:   { v: 8, arche: 'food',   timing: 'burst',    buildAround: true      }, // Carriage Trip
  A48:  { v: 4, arche: 'food',   timing: 'engine',   tags: ['wood']        }, // Shaving Horse
  B67:  { v: 2, arche: 'food',   timing: 'engine'                          }, // Hand Truck
  D66:  { v: 2, arche: 'farm',   timing: 'engine'                          }, // Potter Ceramics
  C63:  { v: 5, arche: 'food',   timing: 'engine'                          }, // Craft Brewery
  B49:  { v: 2, arche: 'cards',  timing: 'engine'                          }, // Scales
  D19:  { v: 7, arche: 'farm',   timing: 'engine',   buildAround: true, tags: ['plow']        }, // Pulverizer Plow
  A83:  { v: 6, arche: 'animal', timing: 'engine',   buildAround: true, tags: ['fence','sheep'] }, // Shepherd's Crook
  A82:  { v: 7, arche: 'stone',  timing: 'engine'                          }, // Work Certificate
  C27:  { v: 4, arche: 'build',  timing: 'discount'                         }, // Blueprint
  C28:  { v: 5, arche: 'cards',  timing: 'engine',   tags: ['occupationEngine'] }, // Teacher's Desk
  A33:  { v: 9, arche: 'farm',   timing: 'score',    buildAround: true      }, // Big Country  ★ big-farm payoff
  A39:  { v: 4, arche: 'flex',   timing: 'score'                           }, // Chapel
  C31:  { v: 6, arche: 'flex',   timing: 'score'                           }, // Writing Chamber
  D33:  { v: 6, arche: 'stone',  timing: 'score'                           }, // Summer House
  B77:  { v: 5, arche: 'stone',  timing: 'engine',   tags: ['dayLaborer']  }, // Loam Pit
};

// Synergy packages: a tag is "active as a plan anchor" when the hand contains
// at least `threshold` cards sharing that tag. The plan then prioritises
// playing all of them quickly, and leans on the named action space.
const SYNERGY_PACKAGES = {
  dayLaborer: {
    label: '临时工套',
    threshold: 2,
    anchorActionId: 'act_labor',
    playByRound: 6,
  },
  occupationEngine: {
    label: '职业连锁',
    threshold: 2,
    anchorActionId: 'act_lessons',
    playByRound: 7,
  },
  // Resource/structural tags don't become their own plans; they only modify
  // values (a pile of wood cards makes wood-themed actions better) and the
  // generic archetype plans pick up the slack.
  wood:     { structural: true },
  room:     { structural: true },
  fence:    { structural: true },
  plow:     { structural: true },
  sheep:    { structural: true },
};

const ARCHETYPE_LABEL = {
  build:  '建造',
  farm:   '大农场',
  animal: '畜牧',
  cards:  '卡牌',
  stone:  '石屋工匠',
  food:   '食物引擎',
  flex:   '灵活',
};

// ======================== valueCard ========================

function _cardTags(card) {
  const t = card && CARD_TABLE[card.id];
  return (t && t.tags) || [];
}

/**
 * Count other cards (in hand AND already played) that share at least one
 * synergy tag with `card`. Used by valueCard to apply stack bonuses.
 */
function _synergyCount(card, ctx) {
  if (!ctx || !ctx.p) return 0;
  const tags = _cardTags(card);
  if (tags.length === 0) return 0;
  const p = ctx.p;
  const all = []
    .concat(p.occupationHand || [], p.minorHand || [])
    .concat((p.occupations || []).map(id => ({ id })))
    .concat((p.minorImprovements || []).map(id => ({ id })));
  let count = 0;
  for (const other of all) {
    if (other.id === card.id) continue;
    const ot = _cardTags(other);
    if (ot.some(t => tags.includes(t))) count++;
  }
  return count;
}

/**
 * Return a 0..~14 valuation for a card in context.
 * ctx: { round, p, engine, played:bool (in hand vs already on table) }
 */
function valueCard(card, ctx) {
  if (!card) return 0;
  const t = CARD_TABLE[card.id];
  if (!t) return 3; // unknown card: neutral
  const round = ctx && ctx.round != null ? ctx.round : 1;
  let v = t.v;

  if (t.timing === 'engine') {
    // Engine cards pay off every time you use them; best early, worthless late.
    // R1=1.0, R7=0.75, R14=0.4
    v *= Math.max(0.4, 1 - (round - 1) * 0.05);
  } else if (t.timing === 'score') {
    // Pure-scoring cards: weak early, full value in last ~4 rounds.
    v *= Math.min(1.0, 0.45 + (round - 1) * 0.05);
  } else if (t.timing === 'discount') {
    // Discounts valuable while build rounds remain (up to ~R10).
    v *= Math.max(0.6, 1 - Math.max(0, round - 10) * 0.1);
  }
  // burst: flat

  // Synergy stack bonus: each matching other card adds ~15% of base. Two
  // day-laborer enablers in hand means each one is worth noticeably more.
  const syn = _synergyCount(card, ctx);
  if (syn > 0) v *= 1 + Math.min(syn, 4) * 0.15;

  return v;
}

function cardArchetype(card) {
  return (card && CARD_TABLE[card.id] && CARD_TABLE[card.id].arche) || 'flex';
}

function isBuildAround(card) {
  return !!(card && CARD_TABLE[card.id] && CARD_TABLE[card.id].buildAround);
}

function bestCardInHand(hand, ctx) {
  let best = null, bestV = -1;
  for (const c of hand || []) {
    const v = valueCard(c, ctx);
    if (v > bestV) { bestV = v; best = c; }
  }
  return best ? { card: best, value: bestV } : null;
}

// ======================== Plan selection ========================

/**
 * Milestones per archetype, keyed by target round. The planner checks progress
 * at each round index; evaluateState rewards/penalises being on schedule.
 *
 * Each entry:  { by: <round>, check: (p, engine) => {onTrack, score} }
 *   - onTrack (bool) gates whether the plan "still feels possible"
 *   - score is a small delta added to evaluateState when on track
 */

function roomsOf(p) { return p.farm.filter(t => t === 1).length; }
function fieldsOf(p) { return p.farm.filter(t => t === 2).length; }
function pastureTilesOf(p) { return Math.floor((p.fences ? p.fences.size : 0) / 4); }
function occupiedTiles(p) { return p.farm.filter(t => t !== 0).length; }

const PLAN_MILESTONES = {
  // ── 大农场 (Big Country): fill all 15 tiles so A33 pays out every round ──
  // 2-room house (2) + 4 fields (4) + 9-tile pasture (9) = 15 by R5-7.
  // That requires ~12 wood for fences + wood/reed for 2 extra fields + sowing.
  farm: [
    { by: 2, check: p => {
      const ok = fieldsOf(p) >= 1 && p.res.wood >= 3;
      return { onTrack: ok, score: ok ? 1.0 : -0.5 };
    }},
    { by: 3, check: p => {
      const ok = fieldsOf(p) >= 2 && p.res.wood >= 4 && p.res.reed >= 1;
      return { onTrack: ok, score: ok ? 2.0 : -1.0 };
    }},
    { by: 5, check: p => {
      // 4 fields + wood banked for a 12-segment fence (3x3 pasture).
      const fenceWood = (p.fences ? p.fences.size : 0);
      const ok = fieldsOf(p) >= 4 && (p.res.wood + fenceWood) >= 10;
      return { onTrack: ok, score: ok ? 3.5 : -2.0 };
    }},
    { by: 7, check: p => {
      const ok = pastureTilesOf(p) >= 6 && fieldsOf(p) >= 4;
      return { onTrack: ok, score: ok ? 5.0 : -3.0 };
    }},
    { by: 9, check: p => {
      const ok = occupiedTiles(p) >= 13;
      return { onTrack: ok, score: ok ? 6.0 : -4.0 };
    }},
    { by: 11, check: p => {
      const ok = occupiedTiles(p) >= 15;
      return { onTrack: ok, score: ok ? 8.0 : -5.0 };
    }},
  ],

  // ── 建造 (Carpenter/Parlor/Apprentice/Braggart): many rooms + many improvements ──
  build: [
    { by: 3, check: p => {
      const ok = p.res.wood >= 5 || roomsOf(p) >= 3;
      return { onTrack: ok, score: ok ? 1.5 : -0.5 };
    }},
    { by: 5, check: p => {
      const ok = roomsOf(p) >= 3 && p.res.maxWorkers >= 3;
      return { onTrack: ok, score: ok ? 2.5 : -1.0 };
    }},
    { by: 8, check: p => {
      const improvements = (p.minorImprovements||[]).length + p.majors.length;
      const ok = roomsOf(p) >= 4 && improvements >= 3;
      return { onTrack: ok, score: ok ? 3.5 : -1.5 };
    }},
    { by: 11, check: p => {
      const improvements = (p.minorImprovements||[]).length + p.majors.length;
      const ok = improvements >= 5 && roomsOf(p) >= 4;
      return { onTrack: ok, score: ok ? 5.0 : -2.5 };
    }},
  ],

  // ── 畜牧 (Shepherd's Crook/Pet Lover/Wolf): pastures + 3 animal types ──
  animal: [
    { by: 4, check: p => {
      const ok = p.res.wood >= 4 && p.res.reed >= 1;
      return { onTrack: ok, score: ok ? 1.5 : -0.5 };
    }},
    { by: 6, check: p => {
      const total = p.animals.sheep + p.animals.boar + p.animals.cow;
      const ok = pastureTilesOf(p) >= 2 && total >= 2;
      return { onTrack: ok, score: ok ? 2.5 : -1.0 };
    }},
    { by: 9, check: p => {
      const types = (p.animals.sheep>0?1:0)+(p.animals.boar>0?1:0)+(p.animals.cow>0?1:0);
      const ok = types >= 2 && pastureTilesOf(p) >= 4;
      return { onTrack: ok, score: ok ? 3.5 : -1.5 };
    }},
    { by: 12, check: p => {
      const types = (p.animals.sheep>0?1:0)+(p.animals.boar>0?1:0)+(p.animals.cow>0?1:0);
      const ok = types >= 3;
      return { onTrack: ok, score: ok ? 5.0 : -2.0 };
    }},
  ],

  // ── 卡牌 (Patron/Craft Teacher): many occupations, ideally 4+ by R8 ──
  cards: [
    { by: 3, check: p => {
      const ok = (p.occupations||[]).length >= 1;
      return { onTrack: ok, score: ok ? 1.5 : -0.5 };
    }},
    { by: 6, check: p => {
      const ok = (p.occupations||[]).length >= 3;
      return { onTrack: ok, score: ok ? 2.5 : -1.0 };
    }},
    { by: 9, check: p => {
      const ok = (p.occupations||[]).length >= 5;
      return { onTrack: ok, score: ok ? 4.0 : -2.0 };
    }},
    { by: 12, check: p => {
      const ok = (p.occupations||[]).length >= 6;
      return { onTrack: ok, score: ok ? 5.0 : -2.5 };
    }},
  ],

  // ── 石屋工匠 (Stonecutter/Summer House): clay by R7, stone by R10, reno to stone ──
  stone: [
    { by: 4, check: p => {
      const ok = p.res.clay >= 2 || p.houseType !== 'wood';
      return { onTrack: ok, score: ok ? 1.0 : -0.5 };
    }},
    { by: 7, check: p => {
      const ok = p.houseType !== 'wood' && p.res.stone >= 1;
      return { onTrack: ok, score: ok ? 2.5 : -1.0 };
    }},
    { by: 10, check: p => {
      const ok = p.houseType === 'stone';
      return { onTrack: ok, score: ok ? 4.0 : -2.0 };
    }},
    { by: 12, check: p => {
      const ok = p.houseType === 'stone' && p.res.stone >= 2;
      return { onTrack: ok, score: ok ? 5.0 : -2.5 };
    }},
  ],

  // ── 食物引擎 (Caravan/Boots/Hayloft/Carriage): grow to 4+ workers fast ──
  food: [
    { by: 4, check: p => {
      const ok = p.res.maxWorkers >= 3;
      return { onTrack: ok, score: ok ? 2.0 : -0.5 };
    }},
    { by: 7, check: p => {
      const ok = p.res.maxWorkers >= 4 && p.res.food >= p.res.maxWorkers * 2;
      return { onTrack: ok, score: ok ? 3.0 : -1.5 };
    }},
    { by: 10, check: p => {
      const ok = p.res.maxWorkers >= 4;
      return { onTrack: ok, score: ok ? 4.0 : -2.0 };
    }},
    { by: 12, check: p => {
      const ok = p.res.maxWorkers >= 5 || p.res.food >= 12;
      return { onTrack: ok, score: ok ? 5.0 : -2.5 };
    }},
  ],

  // ── 灵活 (Little Peasant, etc.): keep options open, no strong milestones ──
  flex: [
    { by: 12, check: p => {
      const ok = p.res.maxWorkers >= 3;
      return { onTrack: ok, score: ok ? 2.0 : -1.0 };
    }},
  ],
};

/**
 * Find a synergy package anchor: a non-structural tag that appears on >=
 * threshold cards in the opening hand. Returns { tag, cards, score } or null.
 */
function _findPackage(p, ctx) {
  const tagCards = {};
  for (const c of [].concat(p.occupationHand || [], p.minorHand || [])) {
    for (const tag of _cardTags(c)) {
      const pkg = SYNERGY_PACKAGES[tag];
      if (!pkg || pkg.structural) continue;
      (tagCards[tag] = tagCards[tag] || []).push(c);
    }
  }
  let best = null;
  for (const [tag, cards] of Object.entries(tagCards)) {
    const pkg = SYNERGY_PACKAGES[tag];
    if (cards.length < pkg.threshold) continue;
    // Score: SUM of card values (each piece is an engine that stacks) plus a
    // package-completeness bonus. Two v~6 cards that share a trigger behave
    // like a single S-tier engine; three+ are genuinely backbreaking.
    let sum = 0;
    for (const c of cards) sum += valueCard(c, ctx);
    const score = sum + (cards.length - pkg.threshold) * 2.5;
    if (!best || score > best.score) best = { tag, cards, score };
  }
  return best;
}

/**
 * Pick a north-star card from the player's opening hand and commit a plan.
 * Returns the plan object (also stored on p.aiPlan). Idempotent: if a plan
 * already exists and its north-star hasn't been obsoleted, keep it.
 */
function choosePlan(p, engine) {
  if (p.aiPlan && p.aiPlan.northStar) {
    const ns = p.aiPlan.northStar;
    const stillInHand =
      (p.occupationHand || []).some(c => c.id === ns) ||
      (p.minorHand || []).some(c => c.id === ns);
    const played =
      (p.occupations || []).includes(ns) ||
      (p.minorImprovements || []).includes(ns);
    if (stillInHand || played) return p.aiPlan;
    // North star vanished somehow (shouldn't happen) — fall through to repick.
  }

  const round = engine.state.round;
  const ctx = { round, p, engine, played: false };

  // 1) Synergy package? Two+ cards sharing a non-structural tag (e.g. day
  //    laborer) is a strong plan anchor even without a single S-tier card.
  const pkg = _findPackage(p, ctx);

  // 2) Best single card.
  const candidates = []
    .concat((p.occupationHand || []).map(c => ({ card: c, kind: 'occupation' })))
    .concat((p.minorHand || []).map(c => ({ card: c, kind: 'minor' })));

  let pick = null;
  for (const cand of candidates) {
    const v = valueCard(cand.card, ctx);
    const bonus = isBuildAround(cand.card) ? 1.5 : 0;
    if (!pick || v + bonus > pick.score) {
      pick = { card: cand.card, kind: cand.kind, score: v + bonus, value: v };
    }
  }

  // Package wins when its score is comparable to or above the best single.
  if (pkg && (!pick || pkg.score >= pick.score - 1.0)) {
    const def = SYNERGY_PACKAGES[pkg.tag];
    // "North star" = the highest-value card in the package.
    let nsCard = pkg.cards[0], nsV = -1;
    for (const c of pkg.cards) {
      const v = valueCard(c, ctx);
      if (v > nsV) { nsV = v; nsCard = c; }
    }
    const plan = {
      kind: 'package',
      packageTag: pkg.tag,
      packageCardIds: pkg.cards.map(c => c.id),
      archetype: 'flex',
      archetypeLabel: def.label,
      northStar: nsCard.id,
      northStarName: nsCard.name,
      northStarKind: pkg.cards[0].type,
      chosenRound: round,
      milestones: _packageMilestones(pkg.tag, pkg.cards, def),
      anchorActionId: def.anchorActionId,
      playByRound: def.playByRound,
    };
    p.aiPlan = plan;
    return plan;
  }

  if (!pick) return null;

  const arche = cardArchetype(pick.card);
  const plan = {
    kind: 'archetype',
    archetype: arche,
    archetypeLabel: ARCHETYPE_LABEL[arche] || arche,
    northStar: pick.card.id,
    northStarName: pick.card.name,
    northStarKind: pick.kind,
    chosenRound: round,
    milestones: PLAN_MILESTONES[arche] || PLAN_MILESTONES.flex,
  };
  p.aiPlan = plan;
  return plan;
}

function _packageMilestones(tag, cards, def) {
  const ids = new Set(cards.map(c => c.id));
  const playedOf = p => [...(p.occupations||[]), ...(p.minorImprovements||[])]
    .filter(id => ids.has(id)).length;
  const out = [
    { by: 3, check: p => {
      const ok = playedOf(p) >= 1;
      return { onTrack: ok, score: ok ? 1.0 : -0.3 };
    }},
  ];
  if (cards.length >= 3) {
    out.push({ by: 5, check: p => {
      const ok = playedOf(p) >= 2;
      return { onTrack: ok, score: ok ? 1.5 : -0.5 };
    }});
  }
  out.push({ by: def.playByRound || 6, check: p => {
    const ok = playedOf(p) >= cards.length;
    return { onTrack: ok, score: ok ? 2.5 : -0.8 };
  }});
  // Packages only pay off if the household is also functioning — require
  // 3 workers by late game so rollouts don't chase cards at the cost of
  // growing.
  out.push({ by: 10, check: p => {
    const ok = p.res.maxWorkers >= 3;
    return { onTrack: ok, score: ok ? 2.0 : -1.5 };
  }});
  return out;
}

/**
 * Evaluate how the player is doing against their plan at the current round.
 * Positive = on/ahead of schedule, negative = falling behind.
 *
 * Only milestones with `by` <= current round count; the most recent milestone
 * dominates (short-term focus), with a small trailing average for stability.
 */
function planProgress(plan, p, engine) {
  if (!plan || !plan.milestones || plan.milestones.length === 0) return 0;
  const round = engine.state.round;
  let total = 0, n = 0;
  for (const m of plan.milestones) {
    if (m.by > round) continue;
    const r = m.check(p, engine);
    total += r.score;
    n++;
  }
  if (n === 0) return 0;
  // Weight the most recent milestone ~2x for short-term focus.
  return total / n;
}

/**
 * Return a [0..1] multiplier that discounts resource weights when a plan
 * makes a specific resource more valuable. Used by evaluateState.
 *
 * resource: one of wood/clay/reed/stone/food/grain/veg
 */
function planResourceMultiplier(plan, resource) {
  if (!plan) return 1.0;
  const table = {
    farm:   { wood: 1.35, reed: 1.25, grain: 1.25, veg: 1.3 },
    build:  { wood: 1.25, reed: 1.3, clay: 1.15 },
    animal: { wood: 1.35, reed: 1.3 },
    stone:  { clay: 1.25, stone: 1.35, reed: 1.15 },
    food:   { food: 1.3, clay: 1.15 },
    cards:  { food: 1.15 },
    flex:   {},
  };
  const m = (table[plan.archetype] || {})[resource];
  return m || 1.0;
}

/**
 * Return an {action mode/type: boost} map for stagedRolloutPolicy.
 * Boosts are additive "interest" scores for picking matching actions.
 */
function planActionInterest(plan, p, engine) {
  if (!plan) return {};
  const out = {};
  const round = engine.state.round;

  // Package plans: strongly push the anchor action once at least one package
  // card is in play, and push lesson/meeting before that to get the cards out.
  if (plan.kind === 'package') {
    const ids = new Set(plan.packageCardIds || []);
    const playedCount = [...(p.occupations||[]), ...(p.minorImprovements||[])]
      .filter(id => ids.has(id)).length;
    const total = ids.size;
    const allPlayed = playedCount >= total;

    if (!allPlayed) {
      // Need to get the pieces on the table first.
      for (const id of ids) {
        const inHand = (p.occupationHand||[]).some(c => c.id === id);
        if (inHand) out['lesson'] = Math.max(out['lesson'] || 0, 2.5);
        const inMinorHand = (p.minorHand||[]).some(c => c.id === id);
        if (inMinorHand) out['meeting'] = Math.max(out['meeting'] || 0, 2.0);
      }
      if (round >= 4 && playedCount === 0) {
        // Falling behind on landing the package — spike card actions further.
        out['lesson'] = (out['lesson'] || 0) + 1.0;
      }
    }
    if (playedCount >= 1) {
      // Once a piece is on the table, its anchor action becomes a solid
      // choice — but not an obsession. 2.0 is enough to beat generic plow/
      // fence in the ladder while still losing to grow/food/build. Each
      // additional in-play piece adds a little.
      const anchorKey = 'id:' + (plan.anchorActionId || '');
      out[anchorKey] = (out[anchorKey] || 0) + 1.5 + 0.5 * playedCount;
    }
    // Day laborer costs food; keep a small buffer so we don't get stuck.
    if (plan.anchorActionId === 'act_labor' && p.res.food < 3) {
      out['food'] = (out['food'] || 0) + 1.0;
    }
    return out;
  }

  const fields = fieldsOf(p);
  const rooms = roomsOf(p);
  const pasture = pastureTilesOf(p);
  const totalAnimals = p.animals.sheep + p.animals.boar + p.animals.cow;
  const improvements = (p.minorImprovements||[]).length + p.majors.length;
  const occupations = (p.occupations||[]).length;

  switch (plan.archetype) {
    case 'farm':
      if (round <= 5 && fields < 4) {
        out['plow'] = 3.0; out['plow_sow'] = 3.0;
        out['wood'] = 2.0; out['reed'] = 1.5;
      } else if (round <= 8 && pasture < 6) {
        out['fence'] = 3.0; out['wood'] = 2.5; out['reed'] = 1.0;
      } else {
        out['sow'] = 1.5; out['veg'] = 1.5; out['grain'] = 1.0;
      }
      break;
    case 'build':
      if (rooms < 3 || round <= 6) {
        out['wood'] = 2.0; out['reed'] = 2.5; out['build_menu'] = 2.0;
      } else if (improvements < 5) {
        out['major'] = 2.0; out['meeting'] = 1.0;
        out['clay'] = 1.0; out['stone'] = 1.0;
      }
      break;
    case 'animal':
      if (pasture < 4) {
        out['wood'] = 2.0; out['fence'] = 3.0; out['reed'] = 1.5;
      } else {
        out['sheep'] = 2.0; out['boar'] = 2.0; out['cow'] = 2.5;
      }
      if (totalAnimals === 0 && p.majors.every(m => !m.cook)) out['major'] = 1.5;
      break;
    case 'cards':
      if (occupations < 5) {
        out['lesson'] = 2.5; out['lesson2'] = 2.0; out['meeting'] = 1.5;
      }
      if (occupations >= 2) out['major'] = 1.0; // craft teacher enabler
      break;
    case 'stone':
      if (p.houseType === 'wood') {
        out['clay'] = 2.0; out['reed'] = 1.5; out['renovate'] = 2.0;
      } else if (p.houseType === 'clay') {
        out['stone'] = 2.5; out['renovate'] = 2.5;
      } else {
        out['stone'] = 1.5;
      }
      break;
    case 'food':
      out['food'] = 1.5;
      if (p.res.maxWorkers < 4 && rooms > p.res.maxWorkers) out['grow'] = 2.5;
      break;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CARD_TABLE,
    ARCHETYPE_LABEL,
    valueCard,
    cardArchetype,
    isBuildAround,
    bestCardInHand,
    choosePlan,
    planProgress,
    planResourceMultiplier,
    planActionInterest,
    roomsOf,
    fieldsOf,
    pastureTilesOf,
    occupiedTiles,
  };
}
