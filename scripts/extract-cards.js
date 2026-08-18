/**
 * PHP Card Extractor
 * Parses all PHP card files from bga-agricola-main_Q and extracts metadata to JSON.
 *
 * Usage: node scripts/extract-cards.js
 */

const fs = require('fs');
const path = require('path');

const BGA_CARDS_DIR = path.join(__dirname, '..', 'bga-agricola-main_Q', 'modules', 'php', 'Cards');
const OUTPUT_DIR = path.join(__dirname, '..', 'data');

// Map PHP resource constants to our string keys
const RESOURCE_MAP = {
  WOOD: 'wood',
  CLAY: 'clay',
  REED: 'reed',
  STONE: 'stone',
  FOOD: 'food',
  GRAIN: 'grain',
  VEGETABLE: 'veg',
  SHEEP: 'sheep',
  PIG: 'boar',
  CATTLE: 'cow',
};

// Determine card type from parent class and $type property
function getCardType(parentClass, content) {
  if (parentClass.includes('Occupation')) return 'occupation';
  if (parentClass.includes('MajorImprovement')) return 'major';
  if (parentClass.includes('MinorImprovement')) return 'minor';
  if (parentClass.includes('PlayerActionCard')) {
    const typeMatch = content.match(/protected\s+\$type\s*=\s*(\w+)/);
    if (typeMatch) {
      const t = typeMatch[1].toUpperCase();
      if (t === 'OCCUPATION') return 'occupation';
      if (t === 'MAJOR') return 'major';
      if (t === 'MINOR') return 'minor';
    }
    return 'minor'; // default for PlayerActionCard
  }
  return 'unknown';
}

// Extract class name (parent class)
function extractParentClass(content) {
  const match = content.match(/class\s+\w+\s+extends\s+([^\s{]+)/);
  return match ? match[1] : '';
}

// Extract a string property, handling both single and double quotes
function extractStringProp(content, prop) {
  // Try clienttranslate('...') first
  let regex = new RegExp(`\\$this->${prop}\\s*=\\s*clienttranslate\\(\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  let match = content.match(regex);
  if (match) return match[1];
  // Try plain single-quoted string
  regex = new RegExp(`\\$this->${prop}\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  match = content.match(regex);
  if (match) return match[1];
  // Try double-quoted string (with or without clienttranslate)
  regex = new RegExp(`\\$this->${prop}\\s*=\\s*(?:clienttranslate\\(\\s*)?"((?:[^"\\\\]|\\\\.)*)"`);
  match = content.match(regex);
  return match ? match[1] : null;
}

// Extract a numeric property: $this->prop = 5;
function extractNumberProp(content, prop) {
  const regex = new RegExp(`\\$this->${prop}\\s*=\\s*(\\d+)`);
  const match = content.match(regex);
  return match ? parseInt(match[1]) : null;
}

// Extract a boolean property: $this->prop = true/false;
function extractBoolProp(content, prop) {
  const regex = new RegExp(`\\$this->${prop}\\s*=\\s*(true|false)`);
  const match = content.match(regex);
  if (!match) return null;
  return match[1] === 'true';
}

// Extract cost array: $this->cost = [WOOD => 1, STONE => 3];
// Also handles quoted strings: [WOOD => '2']
function extractCost(content) {
  const match = content.match(/\$this->cost\s*=\s*\[([^\]]*)\]/);
  if (!match) return null;
  const cost = {};
  const entries = match[1].split(',');
  for (const entry of entries) {
    const m = entry.match(/(\w+)\s*=>\s*'?(\d+)'?/);
    if (m) {
      const key = RESOURCE_MAP[m[1]] || m[1].toLowerCase();
      cost[key] = parseInt(m[2]);
    }
  }
  return Object.keys(cost).length > 0 ? cost : null;
}

// Extract vp/score: $this->vp = 4;
function extractVp(content) {
  return extractNumberProp(content, 'vp');
}

// Extract description array: $this->desc = [ clienttranslate('...'), ... ];
function extractDesc(content) {
  // Try array form first
  const arrayMatch = content.match(/\$this->desc\s*=\s*\[([\s\S]*?)\];/);
  if (arrayMatch) {
    const parts = [];
    // Match clienttranslate('...') or plain strings in the array
    const regex = /clienttranslate\(\s*'((?:[^'\\]|\\.)*)'\s*\)|'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = regex.exec(arrayMatch[1])) !== null) {
      const text = m[1] !== undefined ? m[1] : m[2];
      if (text) parts.push(text.trim());
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }
  // Single string form
  return extractStringProp(content, 'desc');
}

// Extract prerequisite
function extractPrerequisite(content) {
  return extractStringProp(content, 'prerequisite');
}

// Extract players (1+, 3+, etc)
function extractPlayers(content) {
  return extractStringProp(content, 'players');
}

// Extract category
function extractCategory(content) {
  // Could be a constant or a quoted string
  const constMatch = content.match(/\$this->category\s*=\s*([A-Z_]+)/);
  if (constMatch) return constMatch[1];
  return extractStringProp(content, 'category');
}

// Extract implemented flag
function extractImplemented(content) {
  return extractBoolProp(content, 'implemented');
}

// Parse a single PHP card file
function parseCardFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parentClass = extractParentClass(content);

  let name = extractStringProp(content, 'name');
  // Fallback: derive name from ID (e.g. "A7_GardenersKnife" -> "Gardeners Knife")
  if (!name) {
    const idMatch = path.basename(filePath, '.php').match(/^\w+_(.+)$/);
    if (idMatch) name = idMatch[1].replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  const card = {
    id: extractStringProp(content, 'id'),
    name: name,
    deck: extractStringProp(content, 'deck'),
    number: extractNumberProp(content, 'number'),
    type: getCardType(parentClass, content),
    category: extractCategory(content),
    cost: extractCost(content),
    vp: extractVp(content),
    desc: extractDesc(content),
    prerequisite: extractPrerequisite(content),
    players: extractPlayers(content),
    implemented: extractImplemented(content),
  };

  // Clean up null/undefined values
  for (const key of Object.keys(card)) {
    if (card[key] === null || card[key] === undefined) {
      delete card[key];
    }
  }

  return card;
}

// Process all card files
function extractAll() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const decks = ['A', 'B', 'C', 'D', 'E', 'R', 'Major'];
  const allCards = [];
  const stats = {};

  for (const deck of decks) {
    const deckDir = path.join(BGA_CARDS_DIR, deck);
    if (!fs.existsSync(deckDir)) continue;

    const files = fs.readdirSync(deckDir).filter(f => f.endsWith('.php'));
    const cards = [];

    for (const file of files) {
      try {
        const card = parseCardFile(path.join(deckDir, file));
        if (card.id) {
          cards.push(card);
          allCards.push(card);
        }
      } catch (e) {
        console.warn(`Warning: Failed to parse ${file}: ${e.message}`);
      }
    }

    // Sort by number
    cards.sort((a, b) => (a.number || 0) - (b.number || 0));

    const outFile = path.join(OUTPUT_DIR, `cards_${deck.toLowerCase()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(cards, null, 2), 'utf-8');

    stats[deck] = cards.length;
    console.log(`  ${deck}: ${cards.length} cards -> data/cards_${deck.toLowerCase()}.json`);
  }

  // Write all cards combined
  const allFile = path.join(OUTPUT_DIR, 'cards_all.json');
  fs.writeFileSync(allFile, JSON.stringify(allCards, null, 2), 'utf-8');

  // Write summary
  const summary = {
    total: allCards.length,
    byType: {},
    byDeck: stats,
    implemented: allCards.filter(c => c.implemented === true).length,
  };
  for (const card of allCards) {
    summary.byType[card.type] = (summary.byType[card.type] || 0) + 1;
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'cards_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8'
  );

  console.log(`\nTotal: ${allCards.length} cards`);
  console.log(`Types:`, summary.byType);
  console.log(`Implemented: ${summary.implemented}`);
}

extractAll();
