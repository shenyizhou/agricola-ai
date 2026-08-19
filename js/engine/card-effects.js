/**
 * CardEffectSystem - dispatches occupation/minor improvement effects in GameEngine.
 *
 * Subscribes to engine events and fires card `trigger` hooks. Also exposes
 * pull-based cost modifiers the engine calls during build/buy/renovate.
 *
 * Per-card runtime state lives on `player.cardRuntime[cardId]` (JSON-safe).
 */

const { CARDS_BY_ID, getCard, dealOpeningHands } = require('../data/cards');
const { MAX_ROUNDS, LIMIT_FENCES } = require('../constants');

class CardEffectSystem {
  constructor(engine) {
    this.engine = engine;
    this.state = engine.state;
    this.e = engine.events;

    engine.events.on('gameStart', () => this._dealHands());
    engine.events.on('newRound', () => this._onNewRound());
    engine.events.on('afterAction', ctx => this._onAfterAction(ctx));
    engine.events.on('endOfWorkPhase', () => this._onEndOfWorkPhase());
    engine.events.on('collect', ctx => this._onCollect(ctx));
    engine.events.on('obtain', ctx => this._onObtain(ctx));
    engine.events.on('buildRoom', ctx => this._fireTrigger(ctx.player, 'afterBuildRoom', ctx));
    engine.events.on('fence', ctx => this._fireTrigger(ctx.player, 'afterFence', ctx));
    engine.events.on('buyMajor', ctx => this._fireTrigger(ctx.player, 'afterBuildMajor', ctx));
    engine.events.on('renovate', ctx => this._fireTrigger(ctx.player, 'afterRenovation', ctx));
    engine.events.on('playCard', ctx => this._onPlayCard(ctx));
    engine.events.on('startOfHarvest', ctx => this._onStartOfHarvest(ctx));
    engine.events.on('harvestFeed', ctx => this._onHarvestFeed(ctx));
    engine.events.on('reap', ctx => this._fireTrigger(ctx.player, 'onReap', ctx));
    engine.events.on('beforeBake', ctx => this._onBeforeBake(ctx));
  }

  // ======================== Helpers ========================

  _playedCards(p) {
    const out = [];
    for (const id of p.occupations) {
      const c = getCard(id);
      if (c) out.push(c);
    }
    for (const id of p.minorImprovements) {
      const c = getCard(id);
      if (c) out.push(c);
    }
    return out;
  }

  _rt(p, cardId, init) {
    if (!p.cardRuntime[cardId]) p.cardRuntime[cardId] = init || {};
    return p.cardRuntime[cardId];
  }

  _canPay(p, cost) {
    if (!cost) return true;
    for (const [k, v] of Object.entries(cost)) {
      if (k === 'begging') continue;
      if ((p.res[k] ?? 0) < v) return false;
    }
    return true;
  }

  _pay(p, cost) {
    if (!cost) return;
    for (const [k, v] of Object.entries(cost)) {
      if (k === 'begging') p.begging += v;
      else p.res[k] -= v;
    }
  }

  _resolveValue(p, spec, ctx) {
    if (typeof spec !== 'string') return spec;
    if (spec === 'perWorker') return p.res.maxWorkers;
    if (spec === 'roundsLeft') return Math.max(0, MAX_ROUNDS - this.state.round);
    if (spec === '2xRoundsLeft') return 2 * Math.max(0, MAX_ROUNDS - this.state.round);
    if (spec === 'equalToStoneInSupply') return p.res.stone;
    if (spec === 'farmersOnAccumulationSpaces') {
      // Count workers currently placed on accumulation spaces (approx: count
      // occupied base/round action spaces that are accumulators).
      let n = 0;
      const occ = this.state.occupied;
      for (const a of [...this.engine._actionDefs, ...this.state.roundCards]) {
        if (occ[a.id] === p.id && a.acc) n++;
      }
      return n;
    }
    return 0;
  }

  _applyGain(p, gain, ctx) {
    if (!gain) return;
    for (const [k, v] of Object.entries(gain)) {
      const amount = this._resolveValue(p, v, ctx);
      if (k === 'score') {
        p._bonusScore = (p._bonusScore || 0) + amount;
      } else if (k === 'begging') {
        p.begging += amount;
      } else if (k === 'sameAnimal' && ctx && ctx.resource) {
        p.animals[ctx.resource] = (p.animals[ctx.resource] || 0) + amount;
        this.engine._resolveAnimalOverflow(p);
      } else if (['sheep', 'boar', 'cow'].includes(k)) {
        p.animals[k] += amount;
        this.engine._resolveAnimalOverflow(p);
      } else if (p.res[k] !== undefined) {
        const before = p.res[k];
        p.res[k] += amount;
        this.e.emit('obtain', { player: p, resource: k, amount, fromCard: true });
      }
    }
  }

  _checkCondition(p, cond, ctx) {
    if (!cond) return true;
    if (typeof cond === 'string') {
      if (cond === 'stone>clay') return p.res.stone > p.res.clay;
      if (cond === 'twoRoomWoodHouse') {
        const rooms = p.farm.filter(t => t === 1).length;
        return rooms === 2 && p.houseType === 'wood';
      }
      if (cond === 'occCountEqualsImpCount') {
        return p.occupations.length === p.minorImprovements.length + p.majors.length;
      }
      if (cond === 'spaceExactlyOne') return ctx && ctx.amount === 1;
      return true;
    }
    if (typeof cond === 'object') {
      if (cond.roomsAtLeast != null) {
        if (p.farm.filter(t => t === 1).length < cond.roomsAtLeast) return false;
      }
      if (cond.workersExactly != null && p.res.maxWorkers !== cond.workersExactly) return false;
      if (cond.woodAtLeast != null && p.res.wood < cond.woodAtLeast) return false;
    }
    return true;
  }

  _roomCount(p) { return p.farm.filter(t => t === 1).length; }

  // ======================== Game start ========================

  _dealHands() {
    const hands = dealOpeningHands();
    for (const h of hands) {
      const p = this.state.players[h.playerId];
      if (!p) continue;
      p.occupationHand = h.occupations.map(c => ({ ...c }));
      p.minorHand = h.minors.map(c => ({ ...c }));
    }
  }

  // ======================== Card play ========================

  prereqOk(p, card) {
    const pr = card.prereq;
    if (!pr) return true;
    const s = pr.toLowerCase();
    if (s.includes('3 occupations')) return p.occupations.length >= 3;
    if (s.includes('1 occupation')) return p.occupations.length >= 1;
    if (s.includes('no occupations')) return p.occupations.length === 0;
    if (s.includes('all farmyard')) return p.farm.every(t => t !== 0);
    if (s.includes('at most 4 people')) return p.res.maxWorkers <= 4;
    if (s.includes('wooden house')) return p.houseType === 'wood';
    if (s.includes('1 farmer still')) return p.res.workers > 0;
    return true;
  }

  _onPlayCard({ player, card }) {
    this._fireTrigger(player, 'onBuy', { card });
    // Patron (D152): before playing each SUBSEQUENT occupation, +2 food.
    // We model it as: whenever an occupation is played and player already has
    // D152 in play, +2 food. (The +2 is supposed to come before paying cost,
    // but occupations here are free via Lesson, so timing doesn't matter.)
    if (card.type === 'occupation' && player.occupations.includes('D152') && card.id !== 'D152') {
      player.res.food += 2;
    }
  }

  playOccupation(p, cardId) {
    const idx = p.occupationHand.findIndex(c => c.id === cardId);
    if (idx < 0) return false;
    const card = p.occupationHand.splice(idx, 1)[0];
    p.occupations.push(card.id);
    this.e.emit('playCard', { player: p, card });
    return true;
  }

  playMinor(p, cardId) {
    const idx = p.minorHand.findIndex(c => c.id === cardId);
    if (idx < 0) return false;
    const card = p.minorHand[idx];
    if (!this.prereqOk(p, card)) return false;
    if (card.cost && !this._canPay(p, card.cost)) return false;
    p.minorHand.splice(idx, 1);
    if (card.cost) this._pay(p, card.cost);
    p.minorImprovements.push(card.id);
    this.e.emit('playCard', { player: p, card });
    return true;
  }

  // ======================== Event handlers ========================

  _onNewRound() {
    // startOfTurn for the first player of the round; startOfWork for all.
    for (const p of this.state.players) {
      this._fireTrigger(p, 'startOfWork', {});
    }
    // startOfTurn fires for each player when their turn begins; approximate by
    // firing for current player now and advancing via afterAction.
    this._fireTrigger(this.engine.currentPlayer, 'startOfTurn', {});
  }

  _onAfterAction({ player, action, choices, result }) {
    const ctx = { action, choices, result };
    // Re-fire startOfTurn for the next current player.
    this._fireTrigger(this.engine.currentPlayer, 'startOfTurn', {});

    // onActionSpace: match by mode / id.
    this._fireTrigger(player, 'onActionSpace', { ...ctx, space: action.mode || action.id });

    // afterPlayCard for scales-like triggers after playing a card this action.
    if (result && result.card) {
      this._fireTrigger(player, 'afterPlayCard', { ...ctx, card: result.card });
    }

    // afterAnyAction (D92 grow, A82 work certificate).
    this._fireTrigger(player, 'afterAnyAction', ctx);

    // endOfTurnAfterPay (D74 royal wood refund).
    this._fireTrigger(player, 'endOfTurnAfterPay', ctx);
  }

  _onCollect({ player, action, resource, amount }) {
    const ctx = { action, resource, amount };
    // onCollect fires for specific resource or 'animal'.
    for (const card of this._playedCards(player)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'onCollect') continue;
        if (eff.resource !== resource && !(eff.resource === 'animal' && ['sheep', 'boar', 'cow'].includes(resource))) continue;
        if (!this._checkCondition(player, eff.condition, ctx)) continue;
        this._applyCollectEffect(player, card, eff, ctx);
      }
    }
  }

  _applyCollectEffect(p, card, eff, ctx) {
    // Optional pay-to-space effects: auto-trigger if affordable & beneficial.
    if (eff.payToSpace && eff.pay) {
      if (!this._canPay(p, eff.pay)) return;
      // Only auto-do if there is a gain.
      if (!eff.gain && !eff.extraAction) return;
      this._pay(p, eff.pay);
      if (eff.extraAction === 'plow1') {
        const idx = this.engine._findPlowTile(p);
        if (idx >= 0) p.farm[idx] = 2;
      }
      if (eff.gain) this._applyGain(p, eff.gain, ctx);
      return;
    }
    if (eff.optional && eff.extraAction === 'build1Stable') {
      // A15 carpenter's axe: build 1 stable at cost override if wood>=7.
      if (p.res.wood >= (eff.costOverride?.wood ?? 2) && p.stablesCount < 4) {
        const idx = this.engine._findStableTile(p);
        if (idx >= 0) {
          p.res.wood -= eff.costOverride?.wood ?? 2;
          p.farm[idx] = 5;
          p.stablesCount++;
        }
      }
      return;
    }
    if (eff.optional && eff.extraAction === 'fenceWithTakenWood') {
      // B15 carpenter's bench: 1 free fence segment now.
      if (p.fences.size < LIMIT_FENCES) {
        p.fences.add(`b15-${p.fences.size}`);
        this.engine._maybePlacePastureTiles(p);
      }
      return;
    }
    if (eff.optional && eff.leaveOnSpace) {
      // D138 pet lover: leave the animal, take same + bonus from supply.
      // We already collected into animals; "leave on space" = put it back by
      // decrementing, then gain bonus. Since we took from accumulator which
      // reset to 0, place 1 back onto the space.
      if (ctx.action) ctx.action.cur = 1;
      p.animals[ctx.resource] -= 1;
      this._applyGain(p, eff.gain, ctx);
      return;
    }
    if (eff.gain) this._applyGain(p, eff.gain, ctx);
  }

  _onObtain({ player, resource, amount, fromCard }) {
    // A48 Shaving Horse: wood→food exchange.
    if (resource === 'wood' && player.minorImprovements.includes('A48')) {
      const mandatory = player.res.wood >= 7;
      const optional = player.res.wood >= 5;
      if (mandatory || optional) {
        // Auto-exchange one wood per obtain for safety at high counts.
        player.res.wood -= 1;
        player.res.food += 3;
      }
    }
    // E103 Wolf: match top of stack.
    if (player.occupations.includes('E103')) {
      const rt = this._rt(player, 'E103');
      if (rt.stack && rt.stack.length > 0) {
        const top = rt.stack[rt.stack.length - 1];
        if (top === resource) {
          rt.stack.pop();
          player.res[resource] = (player.res[resource] || 0) + 1; // take the stacked good
          player.animals.boar += 1;
          this.engine._resolveAnimalOverflow(player);
        }
      }
    }
  }

  _onEndOfWorkPhase() {
    for (const p of this.state.players) {
      this._fireTrigger(p, 'endOfWorkPhase', {});
    }
  }

  _onStartOfHarvest() {
    for (const p of this.state.players) {
      // D97 begging student: free occupation at harvest start.
      if (p.occupations.includes('D97')) {
        if (p.occupationHand.length > 0) {
          this.playOccupation(p, p.occupationHand[0].id);
        }
      }
    }
  }

  _onHarvestFeed({ player }) {
    if (!player) return;
    // C63 Craft Brewery: discard 1 grain hand + 1 grain field → 4 food + 2 score.
    if (player.minorImprovements.includes('C63')) {
      if (player.res.grain >= 1) {
        const fieldIdx = player.farm.findIndex((t, i) => t === 2 && player.farmContent[i] === 'grain' && player.farmCounts[i] > 0);
        if (fieldIdx >= 0) {
          player.res.grain -= 1;
          player.farmCounts[fieldIdx] -= 1;
          if (player.farmCounts[fieldIdx] === 0) player.farmContent[fieldIdx] = null;
          player.res.food += 4;
          player._bonusScore = (player._bonusScore || 0) + 2;
        }
      }
    }
  }

  _onBeforeBake({ player }) {
    for (const card of this._playedCards(player)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'beforeBake') continue;
        if (eff.exchange) {
          // D66 potter: 1 clay → 1 grain, optional (auto if clay available).
          const give = eff.exchange.give;
          const get = eff.exchange.get;
          if (this._canPay(player, give)) {
            this._pay(player, give);
            this._applyGain(player, get, {});
          }
        } else if (eff.gain) {
          this._applyGain(player, eff.gain, {});
        }
      }
    }
  }

  // ======================== Generic trigger firing ========================

  _fireTrigger(player, trigger, ctx) {
    for (const card of this._playedCards(player)) {
      for (const eff of card.effects) {
        if (eff.trigger !== trigger) continue;
        this._applyEffect(player, card, eff, ctx || {});
      }
    }
  }

  _applyEffect(p, card, eff, ctx) {
    // Round gating.
    if (eff.fromRound && this.state.round < eff.fromRound) return;

    switch (eff.trigger) {
      case 'onBuy':
        this._onBuyEffect(p, card, eff, ctx);
        break;
      case 'endOfWorkPhase':
      case 'startOfTurn':
      case 'afterBuildRoom':
      case 'afterFence':
      case 'afterBuildMajor':
      case 'afterRenovation':
        if (!this._checkCondition(p, eff.condition, ctx)) return;
        if (eff.gain) this._applyGain(p, eff.gain, ctx);
        if (eff.choice) this._applyChoice(p, eff.choice, ctx);
        if (eff.effect === 'grow' && eff.needRoom && this._roomCount(p) > p.res.maxWorkers) {
          if (p.res.maxWorkers < 5) {
            p.res.maxWorkers++;
            if (eff.scorePenalty) p._bonusScore = (p._bonusScore || 0) - eff.scorePenalty;
          }
        }
        if (eff.effect === 'freeOccupation') {
          const n = eff.count || 1;
          for (let i = 0; i < n && p.occupationHand.length > 0; i++) {
            this.playOccupation(p, p.occupationHand[0].id);
          }
        }
        if (eff.majorIds && ctx.major && eff.majorIds.includes(ctx.major.type)) {
          if (eff.effect === 'freeOccupation') {
            const n = eff.count || 1;
            for (let i = 0; i < n && p.occupationHand.length > 0; i++) {
              this.playOccupation(p, p.occupationHand[0].id);
            }
          }
        }
        if (eff.minPastureSize && ctx.pastureSize >= eff.minPastureSize) {
          if (eff.gain) this._applyGain(p, eff.gain, ctx);
        }
        break;
      case 'onActionSpace':
        this._onActionSpace(p, card, eff, ctx);
        break;
      case 'afterAnyAction':
        this._afterAnyAction(p, card, eff, ctx);
        break;
      case 'endOfTurnAfterPay':
        this._endOfTurnAfterPay(p, card, eff, ctx);
        break;
      case 'startOfWork':
        this._startOfWork(p, card, eff);
        break;
      case 'provideRoom':
      case 'placeExtraFarmer':
      case 'ignoreOccupancy':
      case 'roomCost':
      case 'fenceCost':
      case 'stableCost':
      case 'improvementCost':
      case 'renovationCost':
      case 'minorImprovementAction':
      case 'onBake':
      case 'endScoring':
      case 'beforeEndOfGame':
      case 'afterFarmFull':
      case 'onReap':
      case 'beforePlayOccupation':
        // Handled in dedicated hooks / scoring.
        break;
      default:
        break;
    }
  }

  _onBuyEffect(p, card, eff, ctx) {
    if (eff.custom === 'wolfInit') {
      this._rt(p, 'E103', { stack: ['clay', 'wood', 'grain'] });
      return;
    }
    if (eff.custom === 'hayloftBarnInit') {
      this._rt(p, 'B21', { food: 4, empty: false });
      return;
    }
    if (eff.gainWoodByRoundsLeft) {
      const left = Math.max(0, MAX_ROUNDS - this.state.round);
      const arr = eff.gainWoodByRoundsLeft;
      const w = arr[Math.min(left, arr.length - 1)] || 0;
      if (w) p.res.wood += w;
    }
    if (eff.gain) this._applyGain(p, eff.gain, ctx);
    if (eff.inWorkPhase && eff.extraAction === 'placeFarmer') {
      // C3 carriage trip: one extra worker placement this action.
      p.res.workers += 1;
    }
    // B22 walking boots second effect: +1 worker for the rest of this round.
    if (card.id === 'B22') {
      p.res.maxWorkers += 1;
      p.res.workers += 1;
      this._rt(p, 'B22', {}).extraWorker = 1;
    }
  }

  _onActionSpace(p, card, eff, ctx) {
    const space = eff.space;
    const act = ctx.action;
    const match =
      space === act.id ||
      space === act.mode ||
      (space === 'lessons' && (act.mode === 'lesson' || act.mode === 'lesson2')) ||
      (space === 'majorImprovementOrRenoMajor' && (act.mode === 'major' || act.mode === 'reno_major')) ||
      (space === 'majorImprovement' && act.mode === 'major');
    if (!match) return;
    if (!this._checkCondition(p, eff.condition, ctx)) return;

    // Trade teacher (D137): shop after lessons.
    if (eff.custom === 'tradeTeacherShop') {
      this._tradeTeacher(p, eff);
      return;
    }

    if (eff.extraAction === 'construct1roomOrRenovate') {
      // B87 cottager: free extra build/reno (normal cost). Try build room first.
      if (this.engine._canBuildRoom(p)) {
        this.engine._buildRoomAuto(p);
      } else {
        const r = this.engine._canRenovate(p);
        if (r.ok) this.engine._doRenovate(p);
      }
      return;
    }
    if (eff.extraAction === 'plow1') {
      const idx = this.engine._findPlowTile(p);
      if (idx >= 0) p.farm[idx] = 2;
      return;
    }
    if (eff.extra) {
      // C126 excavator: optional pay food → stone.
      if (eff.extra.pay && this._canPay(p, eff.extra.pay)) {
        this._pay(p, eff.extra.pay);
        this._applyGain(p, eff.extra.gain, ctx);
      }
    }
    if (eff.pay && !eff.gain) return;
    if (eff.optional && eff.pay) {
      if (this._canPay(p, eff.pay)) {
        this._pay(p, eff.pay);
        if (eff.gain) this._applyGain(p, eff.gain, ctx);
        if (eff.effect === 'playOccupation' && p.occupationHand.length > 0) {
          this.playOccupation(p, p.occupationHand[0].id);
        }
      }
      return;
    }
    if (eff.gain) {
      // A138 harpooner: pay wood for perWorker food+reed.
      if (eff.pay && !this._canPay(p, eff.pay)) return;
      if (eff.pay) this._pay(p, eff.pay);
      this._applyGain(p, eff.gain, ctx);
    }
    if (eff.fromRound && eff.choice && this.state.round >= eff.fromRound) {
      this._applyChoice(p, eff.choice, ctx);
    }
  }

  _applyChoice(p, choice, ctx) {
    // Pick the first option (AI simplification). Each option is a gain obj.
    if (Array.isArray(choice) && choice.length > 0) {
      this._applyGain(p, choice[0], ctx);
    }
  }

  _tradeTeacher(p, eff) {
    // Auto-buy up to 2 different goods: prefer sheep, stone, boar, grain.
    const prefs = ['sheep', 'stone', 'boar', 'grain', 'cow', 'veg'];
    let bought = 0;
    for (const res of prefs) {
      if (bought >= (eff.maxDifferent || 2)) break;
      const item = eff.shop.find(s => s.res === res);
      if (!item) continue;
      if (p.res.food >= item.cost) {
        p.res.food -= item.cost;
        if (['sheep', 'boar', 'cow'].includes(res)) {
          p.animals[res] += 1;
          this.engine._resolveAnimalOverflow(p);
        } else {
          p.res[res] += 1;
        }
        bought++;
      }
    }
  }

  _afterAnyAction(p, card, eff, ctx) {
    if (eff.custom === 'workCertificateTakeOne') {
      // A82: take 1 building resource from any accumulator with >=4.
      for (const a of [...this.engine._actionDefs, ...this.state.roundCards]) {
        if (a.acc && ['wood', 'clay', 'reed', 'stone'].includes(a.res) && a.cur >= 4) {
          a.cur -= 1;
          p.res[a.res] += 1;
          return;
        }
      }
      return;
    }
    if (eff.effect === 'grow' && eff.needRoom) {
      if (this.state.round >= (eff.fromRound || 0) && this._roomCount(p) > p.res.maxWorkers) {
        if (p.res.maxWorkers < 5) {
          p.res.maxWorkers++;
          if (eff.scorePenalty) p._bonusScore = (p._bonusScore || 0) - eff.scorePenalty;
        }
      }
    }
  }

  _endOfTurnAfterPay(p, card, eff, ctx) {
    // D74 Royal Wood: refund 1 wood per 2 spent on farmExpansion/improvement this turn.
    if (eff.appliesTo && eff.refund) {
      const mode = ctx.action && ctx.action.mode;
      const id = ctx.action && ctx.action.id;
      const relevant = (mode === 'build_menu') || (mode === 'major') || (mode === 'reno_major') || (id === 'act_build');
      if (!relevant) return;
      const perWood = eff.refund.perWood;
      const refundPer = eff.refund.refund;
      // Approximate: count wood spent by comparing... we don't track; use
      // result.woodSpent if engine provides it.
      const spent = (ctx.result && ctx.result.woodSpent) || 0;
      const back = Math.floor(spent / perWood) * refundPer;
      if (back > 0) p.res.wood += back;
    }
  }

  _startOfWork(p, card, eff) {
    if (eff.custom === 'nightworkerPlaceFarmer') {
      // C125 Nightworker: at the start of the work phase, for each building
      // resource (wood/clay/reed/stone) the player holds 0 of, place ONE
      // farmer on the largest available accumulator for that resource and
      // immediately collect its current accumulation. This consumes one of
      // the player's workers AND occupies the action tile for the round
      // (other players cannot use it).
      if (p.res.workers <= 0) return;
      for (const res of ['wood', 'clay', 'reed', 'stone']) {
        if (p.res.workers <= 0) break;
        if (p.res[res] > 0) continue;
        let best = null;
        for (const a of [...this.engine._actionDefs, ...this.state.roundCards]) {
          if (a.res !== res || !a.acc) continue;
          if (this.state.occupied[a.id] !== undefined) continue;
          if ((a.cur || 0) <= 0) continue;
          if (!best || a.cur > best.cur) best = a;
        }
        if (best) {
          const amount = best.cur;
          p.res[res] += amount;
          best.cur = 0;
          p.res.workers--;
          this.state.occupied[best.id] = p.id;
          this.e.emit('placeWorker', { player: p, action: best, fromCard: true });
          this.e.emit('obtain', { player: p, resource: res, amount, fromCard: true });
        }
      }
    }
  }

  // ======================== Pull hooks (cost modifiers) ========================

  getRoomCost(p, base, roomType, count) {
    const cost = { ...base };
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'roomCost') continue;
        if (eff.onlyRoomType && eff.onlyRoomType !== roomType) continue;
        if (eff.replace) {
          // B145 brushwood: replace reed with wood (1:1 per reed).
          for (const [from, to] of Object.entries(eff.replace)) {
            if (cost[from]) {
              cost[to] = (cost[to] || 0) + cost[from];
              cost[from] = 0;
            }
          }
        }
        if (eff.amount) {
          // B126 carpenter / B13 carpenter parlor: flat per-room material.
          cost[roomType] = eff.amount * count;
          if (eff.reed != null) cost.reed = eff.reed * count;
        }
        if (eff.discount) {
          for (const [k, v] of Object.entries(eff.discount)) {
            cost[k] = Math.max(0, (cost[k] || 0) - v * (eff.perRoom ? count : 1));
          }
        }
        if (eff.discountByRoomType && count >= (eff.minRooms || 1)) {
          const d = eff.discountByRoomType[roomType] || 0;
          cost[roomType] = Math.max(0, (cost[roomType] || 0) - d);
        }
      }
    }
    return cost;
  }

  getStableCost(p, nth) {
    let wood = 2;
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'stableCost') continue;
        if (eff.nthDiscount && eff.nthDiscount[nth]) {
          wood = Math.max(0, wood - eff.nthDiscount[nth]);
        }
      }
    }
    return { wood };
  }

  getFenceCanUseClay(p) {
    return this._playedCards(p).some(c => c.effects.some(e => e.trigger === 'fenceCost' && e.canUseClay));
  }

  getFenceFreeSegments(p) {
    let free = 0;
    const freeSet = new Set();
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'fenceCost') continue;
        if (eff.freeSegments) eff.freeSegments.forEach(s => freeSet.add(s));
      }
    }
    return freeSet;
  }

  getImprovementCost(p, major) {
    const cost = { ...(major.cost || {}) };
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'improvementCost') continue;
        if (eff.majorIds && !eff.majorIds.includes(major.type)) continue;
        if (eff.onlyMajors && major.type === 'minor') continue;
        if (eff.discount) {
          for (const [k, v] of Object.entries(eff.discount)) {
            cost[k] = Math.max(0, (cost[k] || 0) - v);
          }
        }
      }
    }
    return cost;
  }

  getRenovationCost(p, base) {
    const cost = { ...base };
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'renovationCost') continue;
        if (eff.replace) {
          for (const [from, to] of Object.entries(eff.replace)) {
            if (cost[from]) {
              cost[to] = (cost[to] || 0) + cost[from];
              cost[from] = 0;
            }
          }
        }
        if (eff.replaceReedWithWood) {
          cost.wood = (cost.wood || 0) + (cost.reed || 0);
          cost.reed = 0;
        }
        if (eff.discount) {
          for (const [k, v] of Object.entries(eff.discount)) {
            cost[k] = Math.max(0, (cost[k] || 0) - v);
          }
        }
      }
    }
    return cost;
  }

  getProvidedRooms(p) {
    let n = 0;
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger === 'provideRoom') n += eff.count || 1;
      }
    }
    return n;
  }

  canIgnoreOccupancy(p, act) {
    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger !== 'ignoreOccupancy') continue;
        if (eff.except && eff.except.includes(act.id)) continue;
        if (this._checkCondition(p, eff.condition, {})) return true;
      }
    }
    return false;
  }

  canGrowWithoutRoom(p) {
    // B21 hayloft barn: when food emptied, allows grow without room.
    if (p.minorImprovements.includes('B21')) {
      const rt = this._rt(p, 'B21', { food: 4, empty: false });
      if (rt.empty) return true;
    }
    return false;
  }

  // ======================== Endgame scoring ========================

  scoreCardBonuses(p) {
    let bonus = p._bonusScore || 0;

    // A39 chapel: +3 flat (already vp:3 but ensure).
    // (majors/minors with `vp` are scored in calculateScore; card-level scoring
    // triggers handled here.)

    for (const card of this._playedCards(p)) {
      for (const eff of card.effects) {
        if (eff.trigger === 'endScoring') {
          bonus += this._endScoringBonus(p, card, eff);
        } else if (eff.trigger === 'beforeEndOfGame') {
          bonus += this._beforeEndOfGame(p, eff);
        } else if (eff.trigger === 'onReap') {
          // B132 estate master: handled during reap; nothing to add here.
        }
      }
    }
    return bonus;
  }

  _endScoringBonus(p, card, eff) {
    switch (eff.kind) {
      case 'improvements': {
        const count = p.minorImprovements.length + p.majors.length;
        return eff.map[count] || 0;
      }
      case 'mostRooms': {
        const myRooms = this._roomCount(p);
        const max = Math.max(...this.state.players.map(pl => this._roomCount(pl)));
        return myRooms === max ? eff.score : 0;
      }
      case 'negScoreToPos': {
        // C31 writing chamber: convert begging penalties to positive (capped).
        const neg = p.begging * 3;
        return Math.min(eff.max || 7, neg);
      }
      case 'adjacentFreeToStoneHouse': {
        // D33 summer house: +2 per empty tile orthogonally adjacent to a room.
        if (p.houseType !== 'stone') return 0;
        let n = 0;
        for (let i = 0; i < 15; i++) {
          if (p.farm[i] !== 0) continue;
          const neigh = [];
          if (i >= 5) neigh.push(i - 5);
          if (i < 10) neigh.push(i + 5);
          if (i % 5 !== 0) neigh.push(i - 1);
          if (i % 5 !== 4) neigh.push(i + 1);
          if (neigh.some(x => p.farm[x] === 1)) n++;
        }
        return n * (eff.scorePer || 2);
      }
      default:
        return 0;
    }
  }

  _beforeEndOfGame(p, eff) {
    // C99 garden designer: pay food per empty field for bonus points.
    if (!eff.perEmptyField) return 0;
    const emptyFields = p.farm.filter(t => t === 0).length;
    let bonus = 0;
    for (let i = 0; i < emptyFields; i++) {
      // Pick the best affordable tier.
      let picked = null;
      for (const opt of eff.options) {
        if (p.res.food >= opt.pay.food) picked = opt;
      }
      if (!picked) break;
      p.res.food -= picked.pay.food;
      bonus += picked.score;
    }
    return bonus;
  }

  // ======================== Hayloft grain hook ========================

  onGrainObtained(p) {
    if (p.minorImprovements.includes('B21')) {
      const rt = this._rt(p, 'B21', { food: 4, empty: false });
      if (rt.food > 0) {
        rt.food -= 1;
        p.res.food += 1;
        if (rt.food === 0) rt.empty = true;
      }
    }
  }
}

module.exports = { CardEffectSystem };
