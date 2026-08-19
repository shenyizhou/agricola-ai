/**
 * BrowserGame - Controller bridging the headless engine with the HTML UI.
 *
 * Responsibilities:
 *  - Initialize the GameEngine
 *  - Render state to DOM
 *  - Handle human interactive actions (build, sow, fence, buy cards)
 *  - Run MCTS for AI players
 *  - Game loop
 */

(function(global) {
'use strict';

const { GameEngine, MCTSAI, MCTSNode, DB_MAJORS, BASE_ACTIONS, ROUND_CARDS_POOL,
        LIMIT_FENCES, LIMIT_STABLES, HARVEST_ROUNDS, MAX_ROUNDS, SCORING_TIERS,
        randomPolicy, greedyPolicy, cloneEngineForSimulation, getCard } = global.Agricola;

// 7-row, 6-column action board. Base actions occupy fixed cells; the 14 round
// cards unlock one per round into fixed turn slots (some span 2 rows).
const ACTION_LAYOUT = {
  act_forest_1: { r: 1, c: 1 },       // 林地
  act_build:    { r: 1, c: 2 },       // 扩建农庄
  act_forest_2: { r: 2, c: 1 },       // 树林
  act_meeting:  { r: 2, c: 2 },       // 聚会场所
  act_forest_3: { r: 2, c: 3, rs: 2 },// 森林 (跨2-3排)
  act_market:   { r: 3, c: 1 },       // 资源市场
  act_grain:    { r: 3, c: 2 },       // 小麦种子
  act_hollow:   { r: 4, c: 1 },       // 泥坑
  act_plow:     { r: 4, c: 2 },       // 犁田
  act_clay_pit: { r: 4, c: 3 },       // 黏土坑
  act_lessons:  { r: 5, c: 1 },       // 上课
  act_lessons2: { r: 5, c: 2 },       // 夜校
  act_reed1:    { r: 5, c: 3 },       // 芦苇池
  act_travel:   { r: 6, c: 1 },       // 卖艺
  act_labor:    { r: 6, c: 2 },       // 临时工
  act_fish:     { r: 6, c: 3 },       // 钓鱼
};

// Index 0 = round 1 turn slot, etc. rs = row span.
const TURN_LAYOUT = [
  { r: 1, c: 3 }, { r: 1, c: 4 }, { r: 1, c: 5 }, { r: 1, c: 6 },          // 1-4
  { r: 2, c: 4, rs: 2 }, { r: 2, c: 5, rs: 2 }, { r: 2, c: 6, rs: 2 },     // 5-7 跨二三排
  { r: 4, c: 4 }, { r: 4, c: 5 },                                          // 8-9
  { r: 5, c: 4, rs: 2 }, { r: 5, c: 5, rs: 2 },                           // 10-11 跨五六排
  { r: 7, c: 2 }, { r: 7, c: 3 }, { r: 7, c: 4 },                         // 12-14
];

class BrowserGame {
  constructor(options = {}) {
    this.engine = null;
    this.aiPlayers = {}; // playerId -> MCTSAI instance
    this.aiIterations = options.aiIterations || 500;
    this.humanPlayerId = 0;
    this.uiMode = null;  // current interactive mode: 'build', 'sow', 'fence', etc.
    this.uiState = {};   // temporary data for current mode
    this.pendingAction = null; // action being configured by human
    this.onStateChange = options.onStateChange || (() => {});
    this.onLog = options.onLog || (() => {});
    this.aiThinking = false;
  }

  init() {
    this.engine = new GameEngine(4);
    this.engine.init();

    // Configure AI players
    for (let i = 1; i < 4; i++) {
      this.aiPlayers[i] = new MCTSAI({
        iterations: this.aiIterations,
        verbose: false,
      });
    }

    this._wireLogEvents();
    this.log('🎮 游戏开始！', '#4fc3f7');
    this._scheduleNextTurn();
  }

  // ======================== Ledger event wiring ========================

  _wireLogEvents() {
    const eng = this.engine;
    eng.events.on('buildRoom', ({ player }) => {
      this._pendingBuildNote = this._pendingBuildNote || {};
      this._pendingBuildNote.room = true;
    });
    eng.events.on('renovate', ({ player }) => {
      this._pendingBuildNote = this._pendingBuildNote || {};
      this._pendingBuildNote.reno = true;
    });
    eng.events.on('fence', ({ player, pastureSize }) => {
      this._pendingBuildNote = this._pendingBuildNote || {};
      this._pendingBuildNote.fence = pastureSize || 0;
    });
    eng.events.on('buyMajor', ({ player, major }) => {
      this._pendingCard = { kind: 'major', name: major.name, cost: major.cost };
    });
    eng.events.on('playCard', ({ player, card }) => {
      this._pendingCard = { kind: card.type, name: card.name, cost: card.cost };
    });
  }

  // ======================== Game Loop ========================

  _scheduleNextTurn(delay = 300) {
    setTimeout(() => this._nextTurn(), delay);
  }

  _nextTurn() {
    if (this.engine.isGameOver) {
      this._showEndGame();
      return;
    }

    const p = this.engine.currentPlayer;

    // Skip players with no workers
    if (p.res.workers <= 0) {
      this.engine.state.turnIdx++;
      this._scheduleNextTurn(0);
      return;
    }

    this.onStateChange();

    if (p.type === 'ai') {
      this._runAITurn(p);
    } else {
      this.log(`轮到你了，请选择行动`, p.color || '#29b6f6');
    }
  }

  _runAITurn(p) {
    this.aiThinking = true;
    this.onStateChange();
    this.log(`${p.name} 思考中...`, this._playerColor(p));

    // Run MCTS asynchronously to avoid blocking UI
    setTimeout(() => {
      const start = Date.now();
      const ai = this.aiPlayers[p.id];
      const actions = this.engine.getActions();
      if (actions.length === 0) {
        // Force end turn
        p.res.workers = 0;
        this.engine._advanceTurn();
        this.aiThinking = false;
        this._scheduleNextTurn();
        return;
      }

      const action = ai.selectAction(this.engine);
      const elapsed = Date.now() - start;

      try {
        this._beginActionLog();
        this.engine.applyAction(action);
        this._commitActionLog(p, action);
      } catch (e) {
        console.error('AI action failed:', e);
        // Fallback: random
        const fallback = actions[Math.floor(Math.random() * actions.length)];
        this.engine.applyAction(fallback);
      }

      this.aiThinking = false;
      this.onStateChange();
      this._scheduleNextTurn(500);
    }, 50);
  }

  // ======================== Human Action Handling ========================

  /**
   * Called when human clicks an action slot.
   */
  handleActionClick(actionId) {
    if (this.aiThinking) return;
    const p = this.engine.currentPlayer;
    if (p.type !== 'human') return;
    if (this.uiMode) return; // already in a mode

    const act = [...this.engine._actionDefs, ...this.engine.state.roundCards]
      .find(a => a.id === actionId);
    if (!act) return;
    if (this.engine.state.occupied[actionId] !== undefined) return;

    // Check legality
    const legal = this.engine._isActionLegal(p, act);
    if (!legal.ok) {
      this._toast('无法执行此行动');
      return;
    }

    // For simple actions, execute immediately
    const simpleModes = [null, 'meeting', 'grow_force'];
    const isSimple = act.type === 'res' || act.type === 'res_combo' ||
                     simpleModes.includes(act.mode);

    if (isSimple || act.mode === 'grow') {
      // grow is simple in engine (no card play in headless mode)
      this._executeHumanAction({ id: actionId });
      return;
    }

    // Interactive modes
    this.pendingAction = { id: actionId, act, choices: {} };
    switch (act.mode) {
      case 'plow':
        this.uiMode = 'plow';
        this._toast('点击空地开垦农田');
        break;
      case 'sow':
        this.uiMode = 'sow';
        this.engine._autoSow(p);
        this._executeHumanAction({ id: actionId, choices: {} });
        return;
      case 'plow_sow':
        this.uiMode = 'plow_sow';
        this._toast('点击空地开垦并播种');
        break;
      case 'build_menu':
        this.uiMode = 'build_menu';
        this._toast('选择要建造的位置');
        break;
      case 'fence':
        // Fence in headless is simplified - just execute
        this._executeHumanAction({ id: actionId, choices: { fences: Math.min(p.res.wood, 5) } });
        return;
      case 'major':
      case 'reno_major':
        this._showMajorMarket(act);
        return;
      case 'lesson':
      case 'lesson2':
        this._showOccupationMarket(act);
        return;
      case 'reno_fence':
        this.engine._doRenovate(p);
        this._executeHumanAction({ id: actionId, choices: { fences: Math.min(p.res.wood, 5) } });
        return;
      default:
        this._executeHumanAction({ id: actionId });
    }
    this.onStateChange();
  }

  /**
   * Called when human clicks a farm tile during an interactive mode.
   */
  handleTileClick(tileIdx) {
    if (!this.uiMode) return;
    const p = this.engine.currentPlayer;
    if (p.type !== 'human') return;

    if (this.uiMode === 'plow' || this.uiMode === 'plow_sow') {
      if (p.farm[tileIdx] !== 0) { this._toast('必须是空地'); return; }
      const hasField = p.farm.includes(2);
      if (hasField && !this.engine._hasNeighbor(p, tileIdx, 2)) {
        this._toast('必须相邻已有农田'); return;
      }
      p.farm[tileIdx] = 2;
      if (this.uiMode === 'plow_sow') {
        this.engine._sowOnTile(p, tileIdx);
      }
      this._finishInteractive({ tileIdx });
    }

    else if (this.uiMode === 'build_menu') {
      if (p.farm[tileIdx] !== 0) { this._toast('必须是空地'); return; }

      // Try room first if adjacent to existing room
      const canRoom = this.engine._canBuildRoom(p);
      if (canRoom && this.engine._hasNeighbor(p, tileIdx, 1)) {
        this.uiState = { buildType: 'room', tileIdx };
        this._confirmBuild();
      } else if (p.res.wood >= 2 && p.stablesCount < LIMIT_STABLES) {
        this.uiState = { buildType: 'stable', tileIdx };
        this._confirmBuild();
      } else {
        this._toast('无法在此建造');
      }
    }
  }

  _confirmBuild() {
    const { buildType, tileIdx } = this.uiState;
    this._finishInteractive({
      tileIdx: buildType === 'room' ? tileIdx : undefined,
      stableIdx: buildType === 'stable' ? tileIdx : undefined,
      buildRooms: buildType === 'room',
      buildStables: buildType === 'stable',
    });
  }

  _finishInteractive(choices = {}) {
    const actionId = this.pendingAction.id;
    this.uiMode = null;
    this.uiState = {};
    this.pendingAction = null;
    this._executeHumanAction({ id: actionId, choices });
  }

  cancelInteractive() {
    this.uiMode = null;
    this.uiState = {};
    this.pendingAction = null;
    this.onStateChange();
  }

  _executeHumanAction(action) {
    try {
      this._beginActionLog();
      this.engine.applyAction(action);
      const p = this.engine.state.players[this.humanPlayerId];
      this._commitActionLog(p, action);
    } catch (e) {
      console.error('Action failed:', e);
      this._toast('行动失败: ' + e.message);
    }
    this.uiMode = null;
    this.pendingAction = null;
    this.onStateChange();
    this._scheduleNextTurn(300);
  }

  // ======================== Major Improvement Modal ========================

  /**
   * Browse-only modal opened from the toolbar button. No purchase — just shows
   * all majors with the current player's affordability.
   */
  showMajorBrowser() {
    const p = this.engine.currentPlayer;
    this._openMajorModal({
      title: '主要发展卡',
      canBuy: false,
      showMinors: false,
      player: p,
    });
  }

  /**
   * Read-only modal showing the current player's occupation and minor
   * improvement hands in full (name + description), complementing the
   * abbreviated mini-cards in the player panel.
   */
  showHandBrowser() {
    const p = this.engine.currentPlayer;
    const modal = document.getElementById('modal');
    document.getElementById('modal-title').innerText = '手牌 · 职业 & 次要改良';
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    const occs = p.occupationHand || [];
    const minors = p.minorHand || [];

    let html = `<div style="font-size:13px;color:var(--ink-soft);margin-bottom:8px;">${p.name} 的手牌（只读查看）</div>`;

    html += `<div class="section-title">职业卡 (${occs.length})</div>`;
    if (occs.length === 0) {
      html += '<div style="font-size:12px;color:var(--ink-soft);">无职业卡手牌</div>';
    } else {
      html += '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;">';
      for (const c of occs) {
        html += `<div class="occ-card" title="${c.desc || ''}"><b>${c.name}</b><div style="font-size:11px;color:#e2f0f7;margin-top:3px;">${c.desc || ''}</div></div>`;
      }
      html += '</div>';
    }

    html += `<div class="section-title" style="margin-top:14px;">次要改良 (${minors.length})</div>`;
    if (minors.length === 0) {
      html += '<div style="font-size:12px;color:var(--ink-soft);">无次要改良手牌</div>';
    } else {
      html += '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;">';
      for (const c of minors) {
        const cost = c.cost ? this._costLine(p, c.cost) : '免费';
        html += `<div class="major-card" title="${c.desc || ''}"><b>${c.name}</b><div class="cost-line">${cost}</div>${c.vp ? `<div>${c.vp}分</div>` : ''}<div style="font-size:10px;color:#ffe0b2;margin-top:2px;">${c.desc || ''}</div></div>`;
      }
      html += '</div>';
    }

    body.innerHTML = html;
    footer.style.display = 'block';
    modal.style.display = 'flex';
  }

  /**
   * Modal opened after clicking the Major Improvement or Renovation+Major
   * action. Affordables are clickable to buy; unaffordables are grayed out.
   */
  _showMajorMarket(act) {
    const p = this.engine.currentPlayer;
    if (act.mode === 'reno_major') {
      this.engine._doRenovate(p);
    }

    const anyAffordable = this.engine.state.majorMarket.some(m => this.engine._canAffordCard(p, m));
    if (!anyAffordable && !(p.minorHand && p.minorHand.some(c => this.engine.cards.prereqOk(p, c) && this.engine._canAfford(p, c.cost)))) {
      this._toast('买不起任何发展卡');
      this._executeHumanAction({ id: act.id });
      return;
    }

    this._majorAct = act;
    this._openMajorModal({
      title: act.mode === 'reno_major' ? '翻修 + 发展卡' : '主要发展卡',
      canBuy: true,
      showMinors: true,
      player: p,
    });
  }

  _costLine(p, cost) {
    return Object.entries(cost || {}).map(([k, v]) => {
      const have = p.res[k] ?? 0;
      const cls = have >= v ? '' : 'missing';
      return `<span class="${cls}">${v}${this._resLabel(k)}</span>`;
    }).join(' ');
  }

  _openMajorModal({ title, canBuy, showMinors, player }) {
    const modal = document.getElementById('modal');
    document.getElementById('modal-title').innerText = title;
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    let html = '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;">';
    for (const m of this.engine.state.majorMarket) {
      const cost = this.engine.cards.getImprovementCost(player, m);
      const afford = this.engine._canAfford(player, cost);
      const cls = 'major-card' + (canBuy && afford ? '' : ' disabled');
      const click = canBuy && afford ? `game.buyMajor('${m.id}')` : '';
      const desc = m.desc ? `<div style="font-size:10px;color:#ffe0b2;margin-top:2px;">${m.desc}</div>` : '';
      html += `<div class="${cls}" ${click ? `onclick="${click}"` : ''} title="${m.desc || ''}">
        <b>${m.name}</b>
        <div class="cost-line">${this._costLine(player, cost)}</div>
        <div>${m.score || 0}分</div>
        ${desc}
      </div>`;
    }
    html += '</div>';

    // Playable minor improvements from hand (when taking a major action).
    if (showMinors && player.minorHand && player.minorHand.length > 0) {
      html += '<div class="section-title" style="margin-top:12px;">手牌次要改良</div>';
      html += '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;">';
      for (const c of player.minorHand) {
        const prereq = this.engine.cards.prereqOk(player, c);
        const afford = this.engine._canAfford(player, c.cost);
        const ok = prereq && afford;
        const cls = 'major-card' + (canBuy && ok ? '' : ' disabled');
        const click = canBuy && ok ? `game.buyMinor('${c.id}')` : '';
        html += `<div class="${cls}" ${click ? `onclick="${click}"` : ''} title="${c.desc||''}">
          <b>${c.name}</b>
          <div class="cost-line">${c.cost ? this._costLine(player, c.cost) : '免费'}</div>
          <div>${c.vp ? c.vp + '分' : ''} ${!prereq ? ' (条件不符)' : ''}</div>
          <div style="font-size:10px;color:#ffe0b2;margin-top:2px;">${c.desc || ''}</div>
        </div>`;
      }
      html += '</div>';
    }

    if (canBuy) {
      html += `<div style="margin-top:12px;">
        <button class="btn btn-wood" onclick="game.cancelMajorPurchase()">不购买</button>
      </div>`;
    }

    body.innerHTML = html;
    footer.style.display = canBuy ? 'none' : 'block';
    modal.style.display = 'flex';
  }

  buyMajor(majorId) {
    const p = this.engine.currentPlayer;
    this.engine._buyMajor(p, majorId);
    this._closeModal();
    const actionId = this._majorAct.id;
    this._majorAct = null;
    this._finalizeCardAction(actionId, p);
  }

  buyMinor(minorId) {
    const p = this.engine.currentPlayer;
    this.engine.cards.playMinor(p, minorId);
    this._closeModal();
    const actionId = this._majorAct.id;
    this._majorAct = null;
    this._finalizeCardAction(actionId, p);
  }

  _finalizeCardAction(actionId, p) {
    this.uiMode = null;
    this.pendingAction = null;
    this.engine.state.occupied[actionId] = p.id;
    p.res.workers--;
    const act = [...this.engine._actionDefs, ...this.engine.state.roundCards].find(a => a.id === actionId);
    this.engine.events.emit('afterAction', { player: p, action: act || { id: actionId }, choices: {} });
    this.engine._advanceTurn();
    this.onStateChange();
    this._scheduleNextTurn(300);
  }

  cancelMajorPurchase() {
    this._closeModal();
    const actionId = this._majorAct.id;
    this._majorAct = null;
    this._executeHumanAction({ id: actionId });
  }

  // ======================== Occupation (lesson) Modal ========================

  _showOccupationMarket(act) {
    const p = this.engine.currentPlayer;
    this._occupationAct = act;
    const modal = document.getElementById('modal');
    document.getElementById('modal-title').innerText = '选择职业卡';
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    const foodCost = this.engine._lessonCost(p, act);
    let html = `<div style="font-size:13px;color:var(--ink-soft);margin-bottom:8px;">花费 ${foodCost} 食打出 1 张职业卡（从手牌 ${p.occupationHand.length} 张中选择）</div>`;
    html += '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:6px;">';
    for (const c of p.occupationHand) {
      html += `<div class="occ-card" onclick="game.playOccupationChoice('${c.id}')" title="${c.desc || ''}">
        <b>${c.name}</b>
        <div style="font-size:11px;color:#e2f0f7;margin-top:3px;">${c.desc || ''}</div>
      </div>`;
    }
    html += '</div>';
    html += '<div style="margin-top:14px;"><button class="btn btn-outline" onclick="game.cancelOccupation()">取消</button></div>';

    body.innerHTML = html;
    footer.style.display = 'none';
    modal.style.display = 'flex';
  }

  playOccupationChoice(occId) {
    this._closeModal();
    const actionId = this._occupationAct.id;
    this._occupationAct = null;
    this._executeHumanAction({ id: actionId, choices: { occId } });
  }

  cancelOccupation() {
    this._closeModal();
    this._occupationAct = null;
    this.onStateChange();
  }

  _closeModal() {
    document.getElementById('modal').style.display = 'none';
  }

  // ======================== Rendering ========================

  render() {
    const s = this.engine.state;
    document.getElementById('round-info').innerText = `第 ${s.round} 轮`;

    const p = this.engine.currentPlayer;
    const turnText = this.aiThinking ? `${p.name} 思考中… (MCTS ${this.aiIterations}次模拟)` : `轮到 ${p.name}`;
    const ti = document.getElementById('turn-info');
    ti.innerText = turnText;
    ti.style.color = '#fff7e6';
    ti.style.background = this._playerColor(p);
    ti.style.borderColor = 'rgba(0,0,0,0.35)';

    this._renderActions();
    this._renderPlayers();
  }

  _renderActions() {
    const s = this.engine.state;
    const board = document.getElementById('central-board');
    board.innerHTML = '';

    for (const act of this.engine._actionDefs) {
      const pos = ACTION_LAYOUT[act.id];
      if (pos) this._renderActionTile(board, act, pos, false);
    }
    // Render all 14 turn slots. Unlocked ones (s.roundCards) are active; the
    // rest show a locked placeholder so the board keeps its real geometry.
    for (let i = 0; i < TURN_LAYOUT.length; i++) {
      const pos = TURN_LAYOUT[i];
      const act = s.roundCards[i];
      if (act) {
        this._renderActionTile(board, act, pos, false);
      } else {
        this._renderLockedSlot(board, pos, i + 1);
      }
    }
  }

  _placeTile(d, pos) {
    d.style.gridRow = `${pos.r} / span ${pos.rs || 1}`;
    d.style.gridColumn = `${pos.c} / span ${pos.cs || 1}`;
  }

  _renderLockedSlot(container, pos, turnNum) {
    const d = document.createElement('div');
    d.className = 'action-tile round-locked';
    this._placeTile(d, pos);
    d.innerHTML = `<div class="ico" style="opacity:0.4">🔒</div><div>${turnNum}</div>`;
    container.appendChild(d);
  }

  _meepleIcon(color) {
    return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M12 2.2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" fill="${color}"/>
      <path d="M12 8.2c-3.4 0-5.6 2.1-5.6 4.8V20c0 1.1.9 2 2 2h7.2c1.1 0 2-.9 2-2v-7c0-2.7-2.2-4.8-5.6-4.8z" fill="${color}"/>
    </svg>`;
  }

  _renderActionTile(container, act, pos) {
    const d = document.createElement('div');
    d.className = 'action-tile';
    this._placeTile(d, pos);
    d.dataset.actionId = act.id;
    const occupied = this.engine.state.occupied[act.id];

    const name = act.name || '';
    const icoMatch = name.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    const ico = icoMatch ? icoMatch[1] : '•';
    const label = name.replace(/^[^\u4e00-\u9fa5\w]+/, '').trim();

    if (occupied !== undefined) {
      d.classList.add('disabled');
      const who = this.engine.state.players[occupied];
      const c = this._playerColor(who);
      d.style.borderColor = c;
      d.innerHTML = `<div class="worker-token">${this._meepleIcon(c)}</div><div class="ico" style="opacity:0.5">${ico}</div><div style="color:${c};font-size:11px;font-weight:700;">${who.name}</div>`;
    } else {
      d.onclick = () => this.handleActionClick(act.id);
      d.innerHTML = `<div class="ico">${ico}</div><div>${label}</div>`;
    }

    if (act.acc && act.cur > 0) {
      const icon = this._resIcon(act.res);
      const cap = 5;
      const n = act.cur;
      let icons = '';
      if (icon) {
        const shown = Math.min(n, cap);
        icons = `<span class="acc-icons">${icon.repeat(shown)}${n > cap ? ` <em>+${n - cap}</em>` : ''}</span>`;
      }
      d.innerHTML += `<div class="acc-badge"><span class="acc-num">${n}</span>${icons}</div>`;
    }
    container.appendChild(d);
  }

  _resIcon(k) {
    return {
      wood: '🪵', clay: '🧱', reed: '🎋', stone: '🪨',
      food: '🍞', grain: '🌾', veg: '🥕',
      sheep: '🐑', boar: '🐗', cow: '🐮',
    }[k] || '';
  }

  _resLabel(k) {
    return {
      wood: '木', clay: '砖', reed: '苇', stone: '石',
      food: '食', grain: '麦', veg: '菜',
      sheep: '羊', boar: '猪', cow: '牛',
    }[k] || k;
  }

  _resChip(k, n) {
    const ico = this._resIcon(k);
    return `<span class="res-chip" title="${this._resLabel(k)}">${ico} ${n}</span>`;
  }

  _foodChip(p) {
    // Display food as a/b where a = current food, b = food needed to feed
    // the current population at the next harvest (2 food per worker).
    const cur = p.res.food;
    const need = p.res.maxWorkers * 2;
    const deficit = cur < need;
    const cls = deficit ? 'res-chip res-chip-warn' : 'res-chip';
    return `<span class="${cls}" title="食物：当前 ${cur} / 下次收获需要 ${need}">🍞 ${cur}<span class="res-need">/${need}</span></span>`;
  }

  _renderPlayers() {
    const con = document.getElementById('players-container');
    con.innerHTML = '';
    for (const p of this.engine.state.players) {
      con.appendChild(this._renderPlayer(p));
    }
  }

  _playerColor(p) {
    return p.color || (p.id === 0 ? '#2a7ab8' : ['#c94a44', '#3f9e4a', '#c98a20'][p.id - 1] || '#6b5438');
  }

  _renderPlayer(p) {
    const div = document.createElement('div');
    div.className = 'player-panel';
    div.id = `p-${p.id}`;
    if (this.engine.currentPlayer.id === p.id) div.classList.add('active');
    const isStart = this.engine.state.startPlayer === p.id;

    const score = this.engine.calculateScore(p);
    const rooms = p.farm.filter(t => t === 1).length;
    const fields = p.farm.filter(t => t === 2).length;

    const color = this._playerColor(p);
    const startTag = isStart ? '<span class="start-tag">🚩 先手</span>' : '';

    div.innerHTML = `
      <div class="player-head">
        <span class="player-name" style="color:${color};">${p.name}${startTag}</span>
        <span class="player-score">🌟 ${score}</span>
      </div>
      <div class="player-meta">工人 ${p.res.workers}/${p.res.maxWorkers} · 房间 ${rooms} · 农田 ${fields}</div>
      <div class="res-row">
        ${this._resChip('wood', p.res.wood)}
        ${this._resChip('clay', p.res.clay)}
        ${this._resChip('reed', p.res.reed)}
        ${this._resChip('stone', p.res.stone)}
        ${this._foodChip(p)}
        ${this._resChip('grain', p.res.grain)}
        ${this._resChip('veg', p.res.veg)}
      </div>
      <div class="res-row">
        <span class="res-chip">🐑 ${p.animals.sheep}</span>
        <span class="res-chip">🐗 ${p.animals.boar}</span>
        <span class="res-chip">🐮 ${p.animals.cow}</span>
        ${p.begging > 0 ? `<span class="res-chip" style="color:#b03a20; border-color:#c94a44;">🆘 ${p.begging}</span>` : ''}
      </div>
      ${this._renderPlayedCards(p)}
      <div class="farm-wrapper">${this._renderFarmGrid(p)}</div>
    `;
    return div;
  }

  _renderPlayedCards(p) {
    const occs = (p.occupations || []).map(id => getCard(id)).filter(Boolean);
    const minors = (p.minorImprovements || []).map(id => getCard(id)).filter(Boolean);
    const majors = p.majors || [];

    let html = '';
    if (occs.length > 0) {
      html += `<div class="section-title">职业卡 (${occs.length})</div><div class="mini-card-container">`;
      html += occs.map(c => `<div class="mini-card occ" title="${c.name}：${c.desc || ''}">${c.name.substring(0, 2)}</div>`).join('');
      html += '</div>';
    }
    if (minors.length > 0) {
      html += `<div class="section-title">次要改良 (${minors.length})</div><div class="mini-card-container">`;
      html += minors.map(c => `<div class="mini-card minor" title="${c.name}：${c.desc || ''}">${c.name.substring(0, 2)}</div>`).join('');
      html += '</div>';
    }
    if (majors.length > 0) {
      html += `<div class="section-title">主要发展 (${majors.length})</div><div class="mini-card-container">`;
      html += majors.map(m => `<div class="mini-card major" title="${m.desc || ''}">${m.name.substring(0, 2)}</div>`).join('');
      html += '</div>';
    }
    return html;
  }

  _renderFarmGrid(p) {
    let html = '<div class="farm-grid">';
    for (let i = 0; i < 15; i++) {
      let classes = ['tile'];
      if (p.farm[i] === 1) classes.push(`house-${p.houseType}`);
      else if (p.farm[i] === 2) classes.push('field');

      const isHuman = p.id === this.humanPlayerId &&
                      (this.uiMode === 'plow' || this.uiMode === 'plow_sow' || this.uiMode === 'build_menu');
      if (isHuman) classes.push('clickable');

      let inner = '';

      // Render crops
      if (p.farm[i] === 2 && p.farmContent[i]) {
        const icon = p.farmContent[i] === 'grain' ? '🌾' : '🥕';
        for (let k = 0; k < Math.min(p.farmCounts[i], 3); k++) {
          inner += `<div class="scatter-item" style="top:${5+k*8}px; left:${5+k*8}px">${icon}</div>`;
        }
      }

      if (p.farm[i] === 5) inner += '<div class="stable-icon">🏚️</div>';

      // Fences (simplified rendering)
      if (p.fences.size > 0 && i < 12) {
        inner += '<div class="fence h"></div>';
      }
      if (p.fences.size > 0 && i % 5 !== 0) {
        inner += '<div class="fence v"></div>';
      }

      const clickable = isHuman;
      html += `<div class="${classes.join(' ')}" ${clickable ? `onclick="game.handleTileClick(${i})"` : ''}>${inner}</div>`;
    }
    return html + '</div>';
  }

  // ======================== End Game ========================

  _showEndGame() {
    const sorted = [...this.engine.state.players].sort((a, b) =>
      this.engine.calculateScore(b) - this.engine.calculateScore(a)
    );

    let html = `<h2>🎉 游戏结束!</h2>
      <table class="score-table"><tr><th>玩家</th><th>总分</th></tr>`;
    for (const p of sorted) {
      html += `<tr><td style="color:${this._playerColor(p)}; font-weight:bold;">${p.name}</td>
        <td class="score-total">${this.engine.calculateScore(p)}</td></tr>`;
    }
    html += `</table>
      <div style="margin-top:15px;">
        <button class="btn btn-green" onclick="game.restart()">再来一局</button>
      </div>`;

    const modal = document.getElementById('modal');
    document.getElementById('modal-title').innerText = '最终得分';
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-footer').style.display = 'none';
    modal.style.display = 'flex';

    this.log('🏁 游戏结束！', '#ffd700');
  }

  restart() {
    this._closeModal();
    this.init();
  }

  // ======================== Utilities ========================

  _toast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.style.opacity = 1;
    setTimeout(() => (t.style.opacity = 0), 2000);
  }

  log(msg, color) {
    this.onLog(msg, color);
    const l = document.getElementById('log');
    if (l) {
      l.innerHTML = `<div class="log-entry"><span style="color:${color||'#ccc'}">${msg}</span></div>` + l.innerHTML;
    }
  }

  // ======================== Detailed action ledger ========================

  _resLabel(k) {
    return {
      wood: '木', clay: '砖', reed: '苇', stone: '石', food: '食',
      grain: '麦', veg: '菜',
      sheep: '羊', boar: '猪', cow: '牛',
    }[k] || k;
  }

  _beginActionLog() {
    const p = this.engine.currentPlayer;
    this._preActionSnap = {
      res: { ...p.res },
      animals: { ...p.animals },
    };
    this._pendingBuildNote = null;
    this._pendingCard = null;
  }

  _findActionLabel(action) {
    if (!action) return '';
    if (action.label) return action.label;
    const act = [...this.engine._actionDefs, ...this.engine.state.roundCards]
      .find(a => a.id === action.id);
    return act ? act.name : action.id;
  }

  _commitActionLog(player, action) {
    const color = this._playerColor(player);
    const label = this._findActionLabel(action);

    // Build / fence / renovate costs come out of the build_menu / fence /
    // reno_* actions. We compute the resource delta vs. a pre-action snapshot
    // taken before applyAction (see below).
    const before = this._preActionSnap;

    const head = `<b style="color:${color}">${player.name}</b> → ${label}`;
    const detail = [];

    // Card played via this action (occupation/minor/major).
    if (this._pendingCard) {
      const c = this._pendingCard;
      const typeName = c.kind === 'occupation' ? '职业' :
                       c.kind === 'minor' ? '次要改良' : '主要发展';
      const costParts = [];
      if (c.cost) {
        for (const [k, v] of Object.entries(c.cost)) {
          if (v) costParts.push(`-${v}${this._resLabel(k)}`);
        }
      }
      detail.push(`<span style="color:#e8b64a">打出[${typeName}] ${c.name}</span>` +
                  (costParts.length ? ` <span style="color:#e08a6a">${costParts.join(' ')}</span>` : ''));
    }

    // Build notes.
    if (this._pendingBuildNote) {
      const b = this._pendingBuildNote;
      const bparts = [];
      if (b.room) bparts.push('扩建房间');
      if (b.reno) bparts.push('翻修');
      if (b.fence) bparts.push(`建${b.fence}段栅栏`);
      if (bparts.length) detail.push(`<span style="color:#b98a55">${bparts.join('、')}</span>`);
    }

    // Resource/animal delta against the snapshot (catches build & fence costs).
    if (before) {
      const resKeys = ['wood', 'clay', 'reed', 'stone', 'food', 'grain', 'veg'];
      for (const k of resKeys) {
        const d = (player.res[k] || 0) - (before.res[k] || 0);
        if (d > 0 && !(this._pendingCard && this._pendingCard.cost && this._pendingCard.cost[k])) {
          detail.push(`<span style="color:#8fcf6f">+${d}${this._resLabel(k)}</span>`);
        } else if (d < 0) {
          detail.push(`<span style="color:#e08a6a">${d}${this._resLabel(k)}</span>`);
        }
      }
      for (const k of ['sheep', 'boar', 'cow']) {
        const d = (player.animals[k] || 0) - (before.animals[k] || 0);
        if (d > 0) detail.push(`<span style="color:#8fcf6f">+${d}${this._resLabel(k)}</span>`);
        else if (d < 0) detail.push(`<span style="color:#e08a6a">${d}${this._resLabel(k)}</span>`);
      }
    }

    // Special actions without resource deltas worth calling out.
    if (action.mode === 'grow' || action.mode === 'grow_force') {
      detail.push('<span style="color:#e8b64a">家庭成员 +1</span>');
    }
    if (action.mode === 'plow' || action.mode === 'plow_sow') {
      detail.push('<span style="color:#b98a55">开垦农田</span>');
    }
    if (action.mode === 'sow' || action.mode === 'plow_sow') {
      // sowing handled via res delta if it happened; add a marker if nothing else.
      if (!detail.some(d => d.includes('农田'))) detail.push('<span style="color:#b98a55">播种</span>');
    }
    if (action.mode === 'meeting' && !this._pendingCard) {
      detail.push('<span style="color:#b98a55">取得下轮先手</span>');
    }

    const line = head + (detail.length ? `　<span style="color:#d8c4a0">|</span> ${detail.join(' ')}` : '');
    this.log(line, color);

    this._preActionSnap = null;
    this._pendingBuildNote = null;
    this._pendingCard = null;
  }

  setAIIterations(n) {
    this.aiIterations = n;
    for (const id in this.aiPlayers) {
      this.aiPlayers[id].iterations = n;
    }
  }

  // ======================== Advisor (training tool) ========================

  async showAdvisor() {
    const p = this.engine.currentPlayer;
    if (p.type !== 'human' || this.aiThinking) {
      this._toast('现在无法使用推荐');
      return;
    }

    const bar = document.getElementById('recommend-bar');
    bar.classList.add('visible');
    bar.innerHTML = '<span class="thinking">🤔 AI 分析中...</span>';

    // Run MCTS asynchronously
    await new Promise(r => setTimeout(r, 50));

    const ai = new MCTSAI({ iterations: this.aiIterations * 2, verbose: false });
    ai.playerId = p.id;

    const rootEngine = cloneEngineForSimulation(this.engine);
    const root = new MCTSNode(rootEngine);
    root.unexploredActions = rootEngine.getActions();

    for (let i = 0; i < this.aiIterations * 2; i++) {
      const node = ai._select(root);
      const reward = ai._simulate(node);
      ai._backpropagate(node, reward);
    }

    const ranked = [...root.children].sort((a, b) => b.visits - a.visits);
    const top = ranked.slice(0, 3);

    let html = '<b>💡 AI 推荐:</b> ';
    top.forEach((child, i) => {
      const wr = (child.value / child.visits * 100).toFixed(0);
      const marker = i === 0 ? '⭐' : `${i+1}.`;
      html += `<span style="margin:0 8px;">${marker} ${child.actionFromParent.label} (${wr}%)</span>`;
    });
    bar.innerHTML = html;

    // Highlight best action on board
    if (top[0]) {
      this._highlightAction(top[0].actionFromParent.id);
    }

    setTimeout(() => bar.classList.remove('visible'), 8000);
  }

  _highlightAction(actionId) {
    document.querySelectorAll('.action-tile').forEach(el => el.classList.remove('recommended'));
    const el = document.querySelector(`.action-tile[data-action-id="${actionId}"]`);
    if (el) el.classList.add('recommended');
  }
}

global.BrowserGame = BrowserGame;
})(typeof window !== 'undefined' ? window : globalThis);
