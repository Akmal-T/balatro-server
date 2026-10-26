/**
 * Authoritative 7-card evaluator for Texas Hold'em.
 * Rank hierarchy:
 * 10: Royal Flush, 9: Straight Flush, 8: Four of a Kind, 7: Full House,
 * 6: Flush, 5: Straight, 4: Three of a Kind, 3: Two Pair, 2: One Pair, 1: High Card
 */

function getCombinations5(arr) {
  const result = [];
  const n = arr.length;
  if (n < 5) return result;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            result.push([arr[a], arr[b], arr[c], arr[d], arr[e]]);
          }
        }
      }
    }
  }
  return result;
}

function parseCardKey(key) {
  // key: "S_A", "H_T", "D_9", "C_2", etc.
  const [suit, rankChar] = key.split('_');
  const rankMap = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
  };
  return { key, suit, id: rankMap[rankChar] || 2, valStr: rankChar };
}

function evaluate5(combo) {
  const cards = combo.map(parseCardKey);
  cards.sort((a, b) => b.id - a.id);

  const counts = {};
  const suitCounts = {};
  for (const c of cards) {
    counts[c.id] = (counts[c.id] || 0) + 1;
    suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  }

  const isFlush = Object.values(suitCounts).some(cnt => cnt >= 5);

  const uniqueIds = Array.from(new Set(cards.map(c => c.id))).sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;

  if (uniqueIds.length >= 5) {
    for (let i = 0; i <= uniqueIds.length - 5; i++) {
      if (uniqueIds[i] - uniqueIds[i + 4] === 4) {
        isStraight = true;
        straightHigh = uniqueIds[i];
        break;
      }
    }
    // Ace-low straight: A, 5, 4, 3, 2
    if (!isStraight && uniqueIds.includes(14) && uniqueIds.includes(2) && uniqueIds.includes(3) && uniqueIds.includes(4) && uniqueIds.includes(5)) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  const freq = Object.entries(counts).map(([id, cnt]) => ({ id: Number(id), cnt }));
  freq.sort((a, b) => b.cnt - a.cnt || b.id - a.id);

  let rank = 1;
  let name = 'High Card';

  if (isStraight && isFlush) {
    if (cards[0].id === 14 && straightHigh === 14) {
      rank = 10; name = 'Royal Flush';
    } else {
      rank = 9; name = 'Straight Flush';
    }
  } else if (freq[0].cnt === 4) {
    rank = 8; name = 'Four of a Kind';
  } else if (freq[0].cnt === 3 && freq[1].cnt >= 2) {
    rank = 7; name = 'Full House';
  } else if (isFlush) {
    rank = 6; name = 'Flush';
  } else if (isStraight) {
    rank = 5; name = 'Straight';
  } else if (freq[0].cnt === 3) {
    rank = 4; name = 'Three of a Kind';
  } else if (freq[0].cnt === 2 && freq[1].cnt === 2) {
    rank = 3; name = 'Two Pair';
  } else if (freq[0].cnt === 2) {
    rank = 2; name = 'One Pair';
  }

  let sortedRanks = [];
  if (isStraight) {
    if (straightHigh === 5) {
      sortedRanks = [5, 4, 3, 2, 1];
    } else {
      sortedRanks = [straightHigh, straightHigh - 1, straightHigh - 2, straightHigh - 3, straightHigh - 4];
    }
  } else {
    for (const f of freq) {
      for (let i = 0; i < f.cnt; i++) {
        sortedRanks.push(f.id);
      }
    }
  }

  const score = rank * 1048576
    + (sortedRanks[0] || 0) * 65536
    + (sortedRanks[1] || 0) * 4096
    + (sortedRanks[2] || 0) * 256
    + (sortedRanks[3] || 0) * 16
    + (sortedRanks[4] || 0);

  return { name, score, rank, combo: combo.slice() };
}

function evaluate7(holeKeys, communityKeys) {
  const all = [...(holeKeys || []), ...(communityKeys || [])];
  if (all.length < 5) {
    if ((holeKeys || []).length >= 2) {
      const c1 = parseCardKey(holeKeys[0]);
      const c2 = parseCardKey(holeKeys[1]);
      if (c1.id === c2.id) {
        return { name: `Pocket Pair (${c1.valStr})`, score: 2 * 1048576 + c1.id * 65536 + c2.id * 4096, combo: holeKeys };
      }
      const maxId = Math.max(c1.id, c2.id);
      const minId = Math.min(c1.id, c2.id);
      const highStr = c1.id > c2.id ? c1.valStr : c2.valStr;
      return { name: `High Card (${highStr})`, score: 1 * 1048576 + maxId * 65536 + minId * 4096, combo: holeKeys };
    }
    return { name: 'High Card', score: 1048576, combo: all };
  }

  const combos = getCombinations5(all);
  let best = null;
  for (const c of combos) {
    const res = evaluate5(c);
    if (!best || res.score > best.score) {
      best = res;
    }
  }
  return best;
}

// ponytail: basic assert self-check on import; upgrade to mocha/jest if test harness expanded
const _testRoyal = evaluate7(['H_A', 'H_K'], ['H_Q', 'H_J', 'H_T', 'D_2', 'C_3']);
if (_testRoyal.name !== 'Royal Flush') throw new Error(`Self-check failed: expected Royal Flush, got ${_testRoyal.name}`);

module.exports = {
  getCombinations5,
  parseCardKey,
  evaluate7
};
