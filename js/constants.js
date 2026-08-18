// ================= 游戏常量 & 数据 =================

const LIMIT_FENCES = 15;
const LIMIT_STABLES = 4;
const MAX_ROUNDS = 14;
const HARVEST_ROUNDS = [4, 7, 9, 11, 13, 14];

const SCORING_TIERS = {
    fields:  [-1, -1, 1, 2, 3, 4],
    pastures:[-1, 1, 2, 3, 4],
    grain:   [-1, 1, 1, 1, 2, 2, 3, 3, 4],
    veg:     [-1, 1, 2, 3, 4],
    sheep:   [-1, 1, 1, 1, 2, 2, 3, 3, 4],
    boar:    [-1, 1, 1, 2, 2, 3, 3, 4],
    cow:     [-1, 1, 2, 3, 4]
};

const DB_MAJORS = [
    { id: 'm1', name: '🔥火炉(2砖)', cost: {clay:2}, score:1, type:'cook', desc:'烤面包(2食), 变食:羊2/猪2/牛3/菜2', bakeRate:2, cook:{sheep:2, boar:2, cow:3, veg:2} },
    { id: 'm2', name: '🔥火炉(3砖)', cost: {clay:3}, score:1, type:'cook', desc:'同上', bakeRate:2, cook:{sheep:2, boar:2, cow:3, veg:2} },
    { id: 'm3', name: '🍲壁炉(4砖)', cost: {clay:4}, score:1, type:'cook', desc:'烤面包(3食), 变食:羊2/猪3/牛4/菜3', bakeRate:3, cook:{sheep:2, boar:3, cow:4, veg:3} },
    { id: 'm4', name: '🍲壁炉(5砖)', cost: {clay:5}, score:1, type:'cook', desc:'同上', bakeRate:3, cook:{sheep:2, boar:3, cow:4, veg:3} },
    { id: 'm5', name: '💧水井', cost: {stone:3,wood:1}, score:4, desc:'未来每轮+1食物', special:'well' },
    { id: 'm6', name: '🧺芦苇工坊', cost: {reed:2,stone:2}, score:2, desc:'芦苇换食/分 (结束时每2芦苇+1分)', special:'bonus', bonusType: 'reed', convert:{reed:1, food:2} },
    { id: 'm7', name: '🪑木头工坊', cost: {wood:2,stone:2}, score:2, desc:'木头换食/分 (结束时每2木+1分)', special:'bonus', bonusType: 'wood', convert:{wood:1, food:2} },
    { id: 'm8', name: '🧱砖头工坊', cost: {clay:2,stone:2}, score:2, desc:'砖头换食/分 (结束时每2砖+1分)', special:'bonus', bonusType: 'clay', convert:{clay:1, food:2} },
    { id: 'm9', name: '🪨石造烤炉', cost: {stone:3,clay:1}, score:3, desc:'高效烤面包(2麦->8食)', type:'bake', specialBake:{in:2, out:8} },
    { id: 'm10', name: '🏺砖造烤炉', cost: {clay:3,stone:1}, score:2, desc:'高效烤面包(1麦->5食)', type:'bake', specialBake:{in:1, out:5} }
];

const BASE_ACTIONS = [
    { id:'act_forest_3', name:'🌲 森林 (3木)', acc:3, cur:3, type:'res', res:'wood' },
    { id:'act_forest_2', name:'🌳 树林 (2木)', acc:2, cur:2, type:'res', res:'wood' },
    { id:'act_forest_1', name:'🌱 林地 (1木)', acc:1, cur:1, type:'res', res:'wood' },
    { id:'act_clay_pit', name:'🧱 粘土坑 (1砖)', acc:1, cur:1, type:'res', res:'clay' },
    { id:'act_hollow', name:'🧱 泥坑 (2砖)', acc:2, cur:2, type:'res', res:'clay' },
    { id:'act_reed1', name:'🎋 芦苇岸 (1苇)', acc:1, cur:1, type:'res', res:'reed' },
    { id:'act_fish', name:'🐟 钓鱼 (1食)', acc:1, cur:1, type:'res', res:'food' },
    { id:'act_travel', name:'🎭 卖艺 (1食)', acc:1, cur:1, type:'res', res:'food' },
    { id:'act_labor', name:'👷 临时工 (2食)', type:'res', res:'food', amount:2 },
    { id:'act_grain', name:'🌾 小麦种子', type:'res', res:'grain', amount:1 },
    { id:'act_meeting', name:'👥 聚会场所', type:'special', mode:'meeting', desc:'成为下轮起始玩家，可打1张次要改良' },
    { id:'act_lessons', name:'🎓 上课', type:'special', mode:'lesson', lessonCost:[0,1], desc:'花1食打1张职业（第一张免费）' },
    { id:'act_lessons2', name:'🎓 夜校', type:'special', mode:'lesson2', lessonCost:[1,1,2], players:[4], desc:'花2食打1张职业（前两张仅1食）' },
    { id:'act_market', name:'🛒 资源市场', type:'res_combo', desc:'1苇+1石+1食' },
    { id:'act_plow', name:'🚜 犁地', type:'special', mode:'plow' },
    { id:'act_build', name:'🏠 建房/马厩', type:'special', mode:'build_menu', desc:'自由建造房间/马厩' }
];

const ROUND_CARDS_POOL = [
    { id:'r_sheep', name:'🐑 牧羊 (1羊)', acc:1, cur:1, type:'res', res:'sheep', stage:1 },
    { id:'r_sow', name:'🌱 播种', type:'special', mode:'sow', stage:1 },
    { id:'r_fences', name:'🚧 栅栏', type:'special', mode:'fence', stage:1 },
    { id:'r_major', name:'🏗️ 发展卡', type:'special', mode:'major', stage:1 },
    { id:'r_stone', name:'🪨 西部采石 (1石)', acc:1, cur:1, type:'res', res:'stone', stage:2 },
    { id:'r_reno', name:'🔨 翻修+发展卡', type:'special', mode:'reno_major', stage:2 },
    { id:'r_grow', name:'👶 生儿育女', type:'special', mode:'grow', stage:2, desc:'需空房 > 人口' },
    { id:'r_boar', name:'🐗 野猪 (1猪)', acc:1, cur:1, type:'res', res:'boar', stage:3 },
    { id:'r_veg', name:'🥕 蔬菜', type:'res', res:'veg', amount:1, stage:3 },
    { id:'r_cow', name:'🐮 牛 (1牛)', acc:1, cur:1, type:'res', res:'cow', stage:4 },
    { id:'r_stone2', name:'🪨 东部采石 (1石)', acc:1, cur:1, type:'res', res:'stone', stage:4 },
    { id:'r_plow_sow', name:'🚜 犁地+播种', type:'special', mode:'plow_sow', stage:5 },
    { id:'r_grow2', name:'👶 急于求成', type:'special', mode:'grow_force', stage:5 },
    { id:'r_reno_fence', name:'🔨 翻修+栅栏', type:'special', mode:'reno_fence', stage:6 }
];

const RESOURCE_ICONS = {
    wood:'🪵', clay:'🧱', reed:'🎋', stone:'🪨',
    food:'🥣', grain:'🌾', veg:'🥕',
    sheep:'🐑', boar:'🐗', cow:'🐮'
};

// Export for Node.js (testing/AI training) and browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LIMIT_FENCES, LIMIT_STABLES, MAX_ROUNDS, HARVEST_ROUNDS,
        SCORING_TIERS, DB_MAJORS, BASE_ACTIONS, ROUND_CARDS_POOL, RESOURCE_ICONS
    };
}
