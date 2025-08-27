// pokerEvaluator.js
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

// Convert rank to numeric value
function rankValue(r) {
  return RANKS.indexOf(r);
}

// Generate all 5-card combinations from 7 cards
function getCombinations(cards, k = 5) {
  let result = [];
  function helper(start, combo) {
    if (combo.length === k) {
      result.push(combo);
      return;
    }
    for (let i = start; i < cards.length; i++) {
      helper(i + 1, combo.concat([cards[i]]));
    }
  }
  helper(0, []);
  return result;
}

// Evaluate a 5-card hand
function evaluate5(hand) {
  let ranks = hand.map((c) => c[0]).sort((a, b) => rankValue(a) - rankValue(b));
  let suits = hand.map((c) => c[1]);
  let counts = {};
  ranks.forEach((r) => (counts[r] = (counts[r] || 0) + 1));

  let flush = suits.every((s) => s === suits[0]);
  let uniqueRanks = [...new Set(ranks)];
  let straight = false;
  let highStraight = null;

  // Straight check
  if (uniqueRanks.length >= 5) {
    let values = uniqueRanks.map((r) => rankValue(r)).sort((a, b) => a - b);
    for (let i = 0; i <= values.length - 5; i++) {
      if (values[i + 4] - values[i] === 4) {
        straight = true;
        highStraight = values[i + 4];
      }
    }
    // Special case: A-2-3-4-5 straight
    if (values.includes(12) && values.slice(0, 4).toString() === "0,1,2,3") {
      straight = true;
      highStraight = 3;
    }
  }

  // Build hand ranking
  let countsArr = Object.entries(counts).map(([r, c]) => [r, c]);
  countsArr.sort((a, b) => b[1] - a[1] || rankValue(b[0]) - rankValue(a[0]));

  let handName = "";
  let score = 0;

  if (straight && flush) {
    if (highStraight === 12) {
      handName = "Royal Flush";
      score = 9000000;
    } else {
      handName = "Straight Flush";
      score = 8000000 + highStraight;
    }
  } else if (countsArr[0][1] === 4) {
    handName = "Four of a Kind";
    score = 7000000 + rankValue(countsArr[0][0]);
  } else if (countsArr[0][1] === 3 && countsArr[1]?.[1] === 2) {
    handName = "Full House";
    score = 6000000 + rankValue(countsArr[0][0]);
  } else if (flush) {
    handName = "Flush";
    score = 5000000 + rankValue(ranks[ranks.length - 1]);
  } else if (straight) {
    handName = "Straight";
    score = 4000000 + highStraight;
  } else if (countsArr[0][1] === 3) {
    handName = "Three of a Kind";
    score = 3000000 + rankValue(countsArr[0][0]);
  } else if (countsArr[0][1] === 2 && countsArr[1]?.[1] === 2) {
    handName = "Two Pair";
    score = 2000000 + rankValue(countsArr[0][0]);
  } else if (countsArr[0][1] === 2) {
    handName = "One Pair";
    score = 1000000 + rankValue(countsArr[0][0]);
  } else {
    handName = "High Card";
    score = rankValue(ranks[ranks.length - 1]);
  }

  return { score, handName };
}

// Best hand from 7 cards
function evaluate7(cards) {
  let combos = getCombinations(cards, 5);
  let best = { score: -1, handName: "", hand: [] };
  for (let combo of combos) {
    let result = evaluate5(combo);
    if (result.score > best.score) {
      best = { ...result, hand: combo };
    }
  }
  return best;
}

module.exports = { evaluate7 };
