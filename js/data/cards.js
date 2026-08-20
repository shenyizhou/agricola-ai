/**
 * Selected 56 cards (28 occupations + 28 minor improvements) for AI simulation.
 *
 * Each player is dealt 7 occupations + 7 minors at game start (4 players -> 28 of each used).
 * Cards are drawn from A/B/C/D/E BGA decks; most carry `banned: true` (officially banned
 * in BGA because they swing games or require extra UI flows) — kept here intentionally
 * so the AI has to reason about high-variance opens.
 *
 * Effect schema (each entry in `effects`):
 *   { trigger: '<hookName>', ...params }
 *
 * Common triggers:
 *   onBuy              { gain?: Res, pay?: Res, custom?: string }
 *   onCollect          { resource, gain?: Res, pay?: Res, threshold?: number, leaveInstead?: bool }
 *   onActionSpace      { space: 'dayLaborer'|'fishing'|'lessons'|'majorImprovement'|..., gain?, pay?, extraAction? }
 *   startOfTurn        { condition?, gain?, choice?: Res[] }
 *   startOfWork        { effect: 'placeFarmerOnMissingRes' }
 *   startOfHarvest     { effect: 'freeOccupation' }
 *   endOfWorkPhase     { condition: 'stone>clay', gain }
 *   afterBuildRoom     { gain? }
 *   afterRenovation    { gain? }
 *   afterBuildMajor    { majorIds?: string[], effect: 'freeOccupation', count?: n }
 *   afterFence         { minPastureSize?, gain }
 *   beforeBake         { gain?, pay? }
 *   onBake             { replaceAction: 'freeOccupation' }
 *   onHarvestFeed      { pay, gain, score }
 *   onReap             { resource, scorePerUnit }
 *   endScoring         { kind: 'improvements'|'mostRooms'|'fieldsFood'|'negScoreToPos'|'adjacentFree'|'fullFarmVeg' }
 *   roomCost           { res?: <wood|clay|stone>, amount, reed?, discount?: Res }
 *   fenceCost          { canUseClay?: bool, freeFences?: [13..15] }
 *   stableCost         { nthDiscount: {3:1, 4:1} }
 *   improvementCost    { discount: Res, majorIds?: string[] }
 *   renovationCost     { discount: Res, replaceReedWithWood?: bool }
 *   provideRoom        { count: 1, until?: 'round9' }
 *   placeExtraFarmer   { when: 'onBuy'|'workPhase', removedAtReturnHome?: bool }
 *   growAnytime        { fromRound?: n, needRoom: true, scorePenalty?: n }
 *   minorAsGrow        { fromRound: n }
 *   exchange           { give, get }
 *   ignoreOccupancy    { condition: 'twoRoomWoodHouse' }
 *   accumulator        { stack: Res[], onMatch: { takeStack: n, gain: {pig:n} } }
 *   foodBank           { initial: n, perGrainGain: 1, onEmpty: 'growWithoutRoom' }
 *   custom             { id: 'craftBrewery'|'wolf'|'chapel'|'workCertificate'|'nightworker'|'tradeTeacher'|'petLover'|'summerHouse' }
 *
 * The GameEngine card hooks (when added) will dispatch on `trigger`; cards with only
 * `custom` require bespoke code paths.
 */

// ======================== Occupations (28) ========================

const OCCUPATIONS = [
  // -------- 建材 / 建造 --------
  {
    id: 'A116', deck: 'A', type: 'occupation',
    name: '伐木工', nameEn: 'Wood Cutter',
    players: '1+', cost: null,
    effects: [{ trigger: 'onCollect', resource: 'wood', gain: { wood: 1 } }],
    desc: '你每次使用一个木材累积格时，额外获得1个木材。'
  },
  {
    id: 'A143', deck: 'A', type: 'occupation',
    name: '石匠', nameEn: 'Stonecutter',
    players: '3+', cost: null,
    effects: [
      { trigger: 'improvementCost', discount: { stone: 1 } },
      { trigger: 'roomCost', discount: { stone: 1 } },
      { trigger: 'renovationCost', discount: { stone: 1 } },
    ],
    desc: '所有改良、建房、翻修费用 −1 石。'
  },
  {
    id: 'B126', deck: 'B', type: 'occupation',
    name: '木匠', nameEn: 'Carpenter',
    players: '1+', cost: null,
    effects: [{ trigger: 'roomCost', amount: 3, reed: 2 }],
    desc: '每个新房间只需 3 对应建材 + 2 苇（木房=3木，砖房=3砖，石房=3石）。'
  },
  {
    id: 'B145', deck: 'B', type: 'occupation',
    name: '拾柴工', nameEn: 'Brushwood Collector',
    players: '3+', cost: null, banned: true,
    effects: [
      { trigger: 'roomCost', replace: { reed: 'wood' } },
      { trigger: 'renovationCost', replace: { reed: 'wood' } },
    ],
    desc: '建房或翻修时，可用 1 木替换所需的 1~2 苇。'
  },
  {
    id: 'C88', deck: 'C', type: 'occupation',
    name: '木匠学徒', nameEn: "Carpenter's Apprentice",
    players: '1+', cost: null,
    effects: [
      { trigger: 'roomCost', discount: { wood: 2 }, onlyRoomType: 'wood' },
      { trigger: 'stableCost', nthDiscount: { 3: 1, 4: 1 } },
      { trigger: 'fenceCost', freeSegments: [13, 14, 15] },
    ],
    desc: '木房 −2 木；第 3、4 个马厩各 −1 木；第 13~15 段栅栏免费。'
  },
  {
    id: 'C102', deck: 'C', type: 'occupation',
    name: '森林守卫', nameEn: 'Tree Guard',
    players: '1+', cost: null, banned: true,
    effects: [{
      trigger: 'onCollect', resource: 'wood',
      optional: true,
      pay: { wood: 4 }, payToSpace: true,
      gain: { stone: 2, clay: 1, reed: 1, grain: 1 },
    }],
    desc: '每次取木后，可把 4 木放回该累积格，立刻换 2石+1砖+1苇+1麦。'
  },
  {
    id: 'C126', deck: 'C', type: 'occupation',
    name: '挖掘工', nameEn: 'Excavator',
    players: '1+', cost: null,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      gain: { wood: 1, clay: 1 },
      extra: { optional: true, pay: { food: 1 }, gain: { stone: 1 } },
    }],
    desc: '每次用临时工格 +1木+1砖，并可花 1食买 1石。'
  },
  {
    id: 'B117', deck: 'B', type: 'occupation',
    name: '线人', nameEn: 'Informant',
    players: '1+', cost: null, banned: true,
    effects: [
      { trigger: 'onBuy', gain: { wood: 1 } },
      { trigger: 'endOfWorkPhase', condition: 'stone>clay', gain: { wood: 1 } },
    ],
    desc: '打出时 +1木；每个工作阶段结束时若手中石多于砖，+1木。'
  },

  // -------- 扩房 / 家庭 --------
  {
    id: 'B87', deck: 'B', type: 'occupation',
    name: '佃农', nameEn: 'Cottager',
    players: '1+', cost: null,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      optional: true,
      extraAction: 'construct1roomOrRenovate',
    }],
    desc: '每次用临时工格，可额外建 1 房或翻修（正常付费）。'
  },
  {
    id: 'B91', deck: 'B', type: 'occupation',
    name: '耕种帮手', nameEn: 'Assistant Tiller',
    players: '1+', cost: null,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      optional: true, extraAction: 'plow1',
    }],
    desc: '每次用临时工格，可额外犁 1 田。'
  },
  {
    id: 'B114', deck: 'B', type: 'occupation',
    name: '无子嗣者', nameEn: 'Childless',
    players: '1+', cost: null,
    effects: [{
      trigger: 'startOfTurn',
      condition: { roomsAtLeast: 3, workersExactly: 2 },
      gain: { food: 1 },
      choice: [{ grain: 1 }, { veg: 1 }],
    }],
    desc: '每轮开始时若至少 3 房但只有 2 人，+1食 +（1麦 或 1菜）。'
  },
  {
    id: 'D92', deck: 'D', type: 'occupation',
    name: '儿童监护人', nameEn: 'Child Ombudsman',
    players: '1+', cost: null, banned: true,
    effects: [{
      trigger: 'afterAnyAction', fromRound: 5, needRoom: true,
      effect: 'grow', scorePenalty: 2,
    }],
    desc: '第 5 轮起，任何工人动作结束时若有空房，可触发生儿育女，但 −2 分。'
  },
  {
    id: 'B151', deck: 'B', type: 'occupation',
    name: '农孩', nameEn: 'Little Peasant',
    players: '4+', cost: null, banned: true,
    effects: [
      { trigger: 'onBuy', gain: { stone: 1 } },
      { trigger: 'ignoreOccupancy', condition: 'twoRoomWoodHouse', except: ['meetingPlace'] },
    ],
    desc: '打出 +1石；只要仍住 2 房木屋，除聚会所外所有行动格对你都算无人占用。'
  },
  {
    id: 'D152', deck: 'D', type: 'occupation',
    name: '资助人', nameEn: 'Patron',
    players: '4+', cost: null,
    effects: [{ trigger: 'beforePlayOccupation', gain: { food: 2 } }],
    desc: '在这张职业之后每打一张职业，付费之前先 +2食。'
  },

  // -------- 食物 / 资源 --------
  {
    id: 'A114', deck: 'A', type: 'occupation',
    name: '季节工', nameEn: 'Seasonal Worker',
    players: '1+', cost: null,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      gain: { grain: 1 },
      fromRound: 6, choice: [{ grain: 1 }, { veg: 1 }],
    }],
    desc: '用临时工格 +1麦；第 6 轮起可改为 +1菜。'
  },
  {
    id: 'A138', deck: 'A', type: 'occupation',
    name: '鱼叉猎手', nameEn: 'Harpooner',
    players: '3+', cost: null,
    effects: [{
      trigger: 'onActionSpace', space: 'fishing',
      optional: true, pay: { wood: 1 },
      gain: { food: 'perWorker', reed: 1 },
    }],
    desc: '使用钓鱼格时可花 1木：每人得 1食 + 1苇。'
  },
  {
    id: 'D137', deck: 'D', type: 'occupation',
    name: '贸易导师', nameEn: 'Trade Teacher',
    players: '3+', cost: null, banned: true,
    effects: [{
      trigger: 'onActionSpace', space: 'lessons',
      custom: 'tradeTeacherShop',
      shop: [
        { res: 'grain', cost: 1 }, { res: 'stone', cost: 1 },
        { res: 'sheep', cost: 1 }, { res: 'boar', cost: 1 },
        { res: 'cow', cost: 2 }, { res: 'veg', cost: 2 },
      ],
      maxDifferent: 2,
    }],
    desc: '你每次使用“职业训练”行动格后，你可以购买最多2种不同的货物:谷物、石材、羊、野猪每个花费1食物;牛和蔬菜每个花费2食物。'
  },
  {
    id: 'D138', deck: 'D', type: 'occupation',
    name: '宠物爱好者', nameEn: 'Pet Lover',
    players: '3+', cost: null,
    effects: [{
      trigger: 'onCollect', resource: 'animal',
      condition: 'spaceExactlyOne',
      optional: true,
      leaveOnSpace: true,
      gain: { sameAnimal: 1, food: 3, grain: 1 },
    }],
    desc: '用仅 1 只动物的累积格时，可把那只留在格上，改为从供应堆拿同种 1 只 +3食+1麦。'
  },
  {
    id: 'E103', deck: 'E', type: 'occupation',
    name: '狼', nameEn: 'Wolf',
    players: '1+', cost: null,
    effects: [
      { trigger: 'onBuy', custom: 'wolfInit' },
      { trigger: 'onObtain', custom: 'wolfMatch' },
    ],
    desc: '卡上从底到顶叠 1砖、1木、1麦；每次获得与顶部相同的货，可拿走该货并得 1 猪。'
  },
  {
    id: 'C125', deck: 'C', type: 'occupation',
    name: '夜班工人', nameEn: 'Nightworker',
    players: '1+', cost: null, banned: true,
    effects: [{
      trigger: 'startOfWork',
      custom: 'nightworkerPlaceFarmer',
    }],
    desc: '每工作阶段开始前，可在你手中为 0 的建材（木/砖/苇/石）的累积格上先放 1 个工人。'
  },

  // -------- 职业引擎 / 动作 --------
  {
    id: 'A97', deck: 'A', type: 'occupation',
    name: '新手学徒', nameEn: 'Freshman',
    players: '1+', cost: null, banned: true,
    effects: [{
      trigger: 'onBake',
      optional: true, perTurn: 1,
      replaceAction: 'freeOccupation',
    }],
    desc: '每次获得烤面包动作时，可改为免费打 1 张职业（每回合最多 1 次）。'
  },
  {
    id: 'A131', deck: 'A', type: 'occupation',
    name: '技校导师', nameEn: 'Craft Teacher',
    players: '3+', cost: null, banned: true,
    effects: [{
      trigger: 'afterBuildMajor',
      majorIds: ['joinery', 'pottery', 'basketmakersWorkshop'],
      effect: 'freeOccupation', count: 2,
    }],
    desc: '每次建木工房/陶工房/编笼工房后，可免费打最多 2 张职业。'
  },
  {
    id: 'D97', deck: 'D', type: 'occupation',
    name: '乞讨学徒', nameEn: 'Begging Student',
    players: '1+', cost: null, banned: true,
    effects: [
      { trigger: 'onBuy', gain: { begging: 1 } },
      { trigger: 'startOfHarvest', optional: true, effect: 'freeOccupation' },
    ],
    desc: '打出时拿 1 乞讨标记；每次收获开始可免费打 1 张职业。'
  },
  {
    id: 'B161', deck: 'B', type: 'occupation',
    name: '体弱多病者', nameEn: 'Weakling',
    players: '4+', cost: null, banned: true,
    effects: [{
      trigger: 'onTurnIfAccumulationUnused',
      threshold: 5, gain: { veg: 1 },
    }],
    desc: '你回合时若场上有累积 ≥5 货的累积格而你没用其中任何一格，得 1菜。'
  },

  // -------- 终局计分 --------
  {
    id: 'A133', deck: 'A', type: 'occupation',
    name: '吹牛者', nameEn: 'Braggart',
    players: '3+', cost: null, banned: true,
    effects: [{
      trigger: 'endScoring', kind: 'improvements',
      map: { 5: 2, 6: 3, 7: 4, 8: 5, 9: 7, 10: 9 },
    }],
    desc: '终局按改良总数得分：5/6/7/8/9/10 → 2/3/4/5/7/9 分。'
  },
  {
    id: 'B132', deck: 'B', type: 'occupation',
    name: '庄园主', nameEn: 'Estate Master',
    players: '3+', cost: null, banned: true,
    effects: [
      { trigger: 'afterFarmFull', flag: true },
      { trigger: 'onReap', resource: 'veg', scorePerUnit: 1, requiresFlag: true },
    ],
    desc: '农场所有格子用完后，每次收割 1 蔬菜 +1 分。'
  },
  {
    id: 'B136', deck: 'B', type: 'occupation',
    name: '房屋管家', nameEn: 'House Steward',
    players: '3+', cost: null,
    effects: [
      { trigger: 'onBuy', gainWoodByRoundsLeft: [0, 1, 1, 2, 2, 2, 3, 3, 3, 4] },
      { trigger: 'endScoring', kind: 'mostRooms', score: 3 },
    ],
    desc: '打出时按剩余完整轮数得 1/2/3/4 木（剩 1/3/6/9 轮）；终局房间最多者（含并列）+3 分。'
  },
  {
    id: 'C99', deck: 'C', type: 'occupation',
    name: '园林设计师', nameEn: 'Garden Designer',
    players: '1+', cost: null, banned: true,
    effects: [{
      trigger: 'beforeEndOfGame',
      options: [
        { pay: { food: 1 }, score: 1 },
        { pay: { food: 4 }, score: 2 },
        { pay: { food: 7 }, score: 3 },
      ],
      perEmptyField: true,
    }],
    desc: '计分开时，可在每块空田放 1/4/7 食 → +1/2/3 分。'
  },
];

// ======================== Minor Improvements (28) ========================

const MINORS = [
  // -------- 建材 / 建造 --------
  {
    id: 'A14', deck: 'A', type: 'minor',
    name: '木匠锤', nameEn: "Carpenter's Hammer",
    cost: { wood: 1 },
    effects: [{
      trigger: 'roomCost', discount: { reed: 2 },
      discountByRoomType: { wood: 2, clay: 3, stone: 4 },
      minRooms: 2,
    }],
    desc: '一次建至少 2 房时，共减免 2 苇，以及木/砖/石房分别 2木/3砖/4石。'
  },
  {
    id: 'A15', deck: 'A', type: 'minor',
    name: '木匠斧', nameEn: "Carpenter's Axe",
    cost: { wood: 1 },
    effects: [{
      trigger: 'onCollect', resource: 'wood',
      condition: { woodAtLeast: 7 },
      optional: true,
      extraAction: 'build1Stable', costOverride: { wood: 1 },
    }],
    desc: '从木材累积格取木后若手中 ≥7 木，可花 1 木建 1 马厩。'
  },
  {
    id: 'A16', deck: 'A', type: 'minor',
    name: '夯实粘土', nameEn: 'Rammed Clay',
    cost: null,
    effects: [
      { trigger: 'onBuy', gain: { clay: 1 } },
      { trigger: 'fenceCost', canUseClay: true },
    ],
    desc: '打出时 +1砖；可用砖代替木修栅栏。'
  },
  {
    id: 'B13', deck: 'B', type: 'minor',
    name: '木匠小屋', nameEn: "Carpenter's Parlor",
    cost: { wood: 1, stone: 1 },
    effects: [{ trigger: 'roomCost', onlyRoomType: 'wood', amount: 2, reed: 2 }],
    desc: '木房每间只需 2 木 + 2 苇。'
  },
  {
    id: 'B15', deck: 'B', type: 'minor',
    name: '木工台', nameEn: "Carpenter's Bench",
    cost: { wood: 1 }, banned: true,
    effects: [{
      trigger: 'onCollect', resource: 'wood',
      optional: true,
      extraAction: 'fenceWithTakenWood', freeFences: 1,
    }],
    desc: '取木后可立刻用这批木围 1 牧场，其中 1 段栅栏免费。'
  },
  {
    id: 'C82', deck: 'C', type: 'minor',
    name: '五金店', nameEn: 'Hardware Store',
    cost: { wood: 1, clay: 1 }, vp: 1,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      optional: true,
      pay: { food: 2 }, gain: { wood: 1, clay: 1, reed: 1, stone: 1 },
    }],
    desc: '用临时工格后，可花 2食买 1木+1砖+1苇+1石。'
  },
  {
    id: 'D4', deck: 'D', type: 'minor',
    name: '横切木', nameEn: 'Cross-Cut Wood',
    cost: { food: 1 }, prereq: '3 occupations',
    effects: [{ trigger: 'onBuy', gain: { wood: 'equalToStoneInSupply' } }],
    desc: '立刻获得等同于手中石数量的木。'
  },
  {
    id: 'D74', deck: 'D', type: 'minor',
    name: '皇家木材', nameEn: 'Royal Wood',
    cost: { food: 1 }, banned: true,
    effects: [{
      trigger: 'endOfTurnAfterPay',
      appliesTo: ['farmExpansion', 'improvement'],
      refund: { perWood: 2, refund: 1 },
    }],
    desc: '用扩房或建改良时，当回合所花木每 2 块回合末返还 1 块。'
  },

  // -------- 扩房 / 家庭 --------
  {
    id: 'B10', deck: 'B', type: 'minor',
    name: '篷车', nameEn: 'Caravan',
    cost: { wood: 3, food: 3 }, banned: true,
    effects: [{ trigger: 'provideRoom', count: 1 }],
    desc: '提供 1 人住房（无需真建房）。'
  },
  {
    id: 'B21', deck: 'B', type: 'minor',
    name: '干草棚', nameEn: 'Hayloft Barn',
    cost: { wood: 3 }, prereq: '1 occupation', banned: true,
    effects: [{ trigger: 'onBuy', custom: 'hayloftBarnInit' }],
    desc: '卡上放 4食；每次得麦取 1食；取空后获得"无房也能生娃"动作。'
  },
  {
    id: 'B22', deck: 'B', type: 'minor',
    name: '行路靴', nameEn: 'Walking Boots',
    cost: null, prereq: 'at most 4 people', banned: true,
    effects: [
      { trigger: 'onBuy', gain: { food: 2 } },
      { trigger: 'placeExtraFarmer', removedAtReturnHome: true },
    ],
    desc: '立刻 +2食，并从供应堆额外放 1 工人，本轮返乡时移除。'
  },
  {
    id: 'D21', deck: 'D', type: 'minor',
    name: '发展人口', nameEn: 'Recruitment',
    cost: { food: 1 }, banned: true,
    effects: [{
      trigger: 'minorImprovementAction',
      fromRound: 5, needRoom: true,
      replaceAction: 'grow',
    }],
    desc: '第 5 轮起，获得次要改良动作时可改为生儿育女（需空房）。'
  },
  {
    id: 'C3', deck: 'C', type: 'minor',
    name: '马车旅行', nameEn: 'Carriage Trip',
    cost: null, prereq: '1 farmer still to place', banned: true,
    effects: [{ trigger: 'onBuy', inWorkPhase: true, extraAction: 'placeFarmer' }],
    desc: '工作阶段打出可立刻再放 1 工人。'
  },

  // -------- 食物 / 炉灶 / 烤面包 --------
  {
    id: 'A48', deck: 'A', type: 'minor',
    name: '刨木架', nameEn: 'Shaving Horse',
    cost: { wood: 1 }, banned: true,
    effects: [{
      trigger: 'onObtain', resource: 'wood',
      exchange: { give: { wood: 1 }, get: { food: 3 } },
      optionalThreshold: 5, mandatoryThreshold: 7,
    }],
    desc: '每次获得 ≥1 木后，若手中 ≥5木可把 1木换3食；≥7木必须换。'
  },
  {
    id: 'B67', deck: 'B', type: 'minor',
    name: '手推车', nameEn: 'Hand Truck',
    cost: { wood: 1 },
    effects: [{
      trigger: 'beforeBake',
      gain: { grain: 'farmersOnAccumulationSpaces' },
    }],
    desc: '烤面包前，每个在累积格上的工人 +1麦。'
  },
  {
    id: 'D66', deck: 'D', type: 'minor',
    name: '陶器坊', nameEn: 'Potter Ceramics',
    cost: null,
    effects: [{
      trigger: 'beforeBake',
      optional: true,
      exchange: { give: { clay: 1 }, get: { grain: 1 } },
    }],
    desc: '烤面包前可把 1砖换成 1麦。'
  },
  {
    id: 'C63', deck: 'C', type: 'minor',
    name: '精酿啤酒坊', nameEn: 'Craft Brewery',
    cost: { wood: 2, clay: 1 }, banned: true,
    effects: [{
      trigger: 'onHarvestFeed',
      pay: { grain: 1 }, payFromField: { grain: 1 },
      gain: { food: 4 }, score: 2,
    }],
    desc: '收获喂食阶段，可弃手中 1麦+田里 1麦 → +4食+2分。'
  },
  {
    id: 'B49', deck: 'B', type: 'minor',
    name: '天平', nameEn: 'Scales',
    cost: { wood: 1 }, prereq: 'no occupations',
    effects: [{
      trigger: 'afterPlayCard', appliesTo: ['occupation', 'improvement'],
      condition: 'occCountEqualsImpCount', gain: { food: 2 },
    }],
    desc: '每次打出职业或改良后，若场上职业与改良数量相等 → +2食。'
  },

  // -------- 种田 / 栅栏 --------
  {
    id: 'D19', deck: 'D', type: 'minor',
    name: '碎土犁', nameEn: 'Pulverizer Plow',
    cost: { wood: 2 }, prereq: '1 occupation', banned: true,
    effects: [{
      trigger: 'onCollect', resource: 'clay',
      optional: true,
      pay: { clay: 1 }, payToSpace: true,
      extraAction: 'plow1',
    }],
    desc: '取砖后可花 1砖放回该格犁 1 田。'
  },
  {
    id: 'A83', deck: 'A', type: 'minor',
    name: '牧杖', nameEn: "Shepherd's Crook",
    cost: { wood: 1 },
    effects: [{
      trigger: 'afterFence', minPastureSize: 4,
      gain: { sheep: 2 }, perPasture: true,
    }],
    desc: '围出 ≥4 格的牧场时，立即在该牧场得 2 只羊。'
  },

  // -------- 改良 / 职业引擎 --------
  {
    id: 'A82', deck: 'A', type: 'minor',
    name: '工作证', nameEn: 'Work Certificate',
    cost: { food: 1 }, prereq: '3 occupations', banned: true,
    effects: [{ trigger: 'afterAnyAction', custom: 'workCertificateTakeOne' }],
    desc: '每次行动后，可从任意积 ≥4 建材的累积格白拿 1 建材。'
  },
  {
    id: 'C27', deck: 'C', type: 'minor',
    name: '蓝图', nameEn: 'Blueprint',
    cost: { food: 1 },
    effects: [{
      trigger: 'minorImprovementAction',
      allowMajors: ['joinery', 'pottery', 'basketmakersWorkshop'],
      improvementCost: { discount: { stone: 1 }, onlyMajors: true },
    }],
    desc: '次要改良动作也可建木工房/陶工房/编笼工房，各 −1石。'
  },
  {
    id: 'C28', deck: 'C', type: 'minor',
    name: '教师讲台', nameEn: "Teacher's Desk",
    cost: { wood: 1 }, prereq: '1 occupation', banned: true,
    effects: [{
      trigger: 'onActionSpace', space: 'majorImprovementOrRenoMajor',
      optional: true, pay: { food: 1 }, effect: 'playOccupation',
    }],
    desc: '用主要改良或翻修+发展卡格时，可花 1食打 1 张职业。'
  },

  // -------- 终局 / 计分 --------
  {
    id: 'A33', deck: 'A', type: 'minor',
    name: '大农场', nameEn: 'Big Country',
    cost: null, prereq: 'all farmyard spaces used', banned: true,
    effects: [{
      trigger: 'onBuy',
      gain: { score: 'roundsLeft', food: '2xRoundsLeft' },
    }],
    desc: '农场所有格子都使用后打出：每剩余 1 轮 +1分 +2食。'
  },
  {
    id: 'A39', deck: 'A', type: 'minor',
    name: '礼拜堂', nameEn: 'Chapel',
    cost: { wood: 3, clay: 2 }, prereq: '2 occupations', vp: 3, banned: true,
    effects: [{
      trigger: 'provideActionSpace',
      score: 3,
      othersPay: { grain: 1, to: 'owner' },
    }],
    desc: '成为全员可用的行动格；使用者 +3分，他人使用先付你 1麦。'
  },
  {
    id: 'C31', deck: 'C', type: 'minor',
    name: '写作室', nameEn: 'Writing Chamber',
    cost: { wood: 2 }, banned: true,
    effects: [{ trigger: 'endScoring', kind: 'negScoreToPos', max: 7 }],
    desc: '计分时把你所有负分的绝对值转为加分（最多 +7）。'
  },
  {
    id: 'D33', deck: 'D', type: 'minor',
    name: '避暑屋', nameEn: 'Summer House',
    cost: { wood: 3, stone: 1 }, prereq: 'still in wooden house', banned: true,
    effects: [{
      trigger: 'endScoring', kind: 'adjacentFreeToStoneHouse',
      scorePer: 2,
    }],
    desc: '石屋时，每块与房屋正交相邻的空格 +2分（空格仍扣 −1）。'
  },

  // -------- 其他 --------
  {
    id: 'B77', deck: 'B', type: 'minor',
    name: '泥坑', nameEn: 'Loam Pit',
    cost: { food: 1 }, prereq: '3 occupations', vp: 1,
    effects: [{
      trigger: 'onActionSpace', space: 'dayLaborer',
      gain: { clay: 3 },
    }],
    desc: '每次用临时工格 +3砖。'
  },
];

// ======================== Exports ========================

const ALL_CARDS = [...OCCUPATIONS, ...MINORS];

const CARDS_BY_ID = Object.fromEntries(ALL_CARDS.map(c => [c.id, c]));

function getCard(id) { return CARDS_BY_ID[id] || null; }

function dealOpeningHands(rng = Math.random) {
  // Shuffle and deal 7 occupations + 7 minors to each of 4 players.
  const occs = [...OCCUPATIONS];
  const mins = [...MINORS];
  const shuffle = arr => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(occs);
  shuffle(mins);
  const hands = [];
  for (let p = 0; p < 4; p++) {
    hands.push({
      playerId: p,
      occupations: occs.slice(p * 7, p * 7 + 7),
      minors: mins.slice(p * 7, p * 7 + 7),
    });
  }
  return hands;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OCCUPATIONS, MINORS, ALL_CARDS, CARDS_BY_ID, getCard, dealOpeningHands };
}
