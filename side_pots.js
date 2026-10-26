/**
 * Pure side-pot computation for Texas Hold'em showdowns.
 *
 * Problem it solves: when players have unequal total contributions (all-ins,
 * folded callers, departed players), the single winner of "the pot" would walk
 * away with money they never at risk for. Side pots split the pot into tiers
 * per contribution level.
 *
 * computeSidePots({ entries, totalPot })
 *   entries  : Array<{ contrib: number, score?: number, eligible?: boolean }>
 *              - contrib : total chips THIS ENTRY put into the pot this round
 *              - score   : hand rank score (only meaningful when eligible)
 *              - eligible: false for folded/departed rows (they still fund tiers,
 *                          but can never win)
 *   totalPot : optional; defaults to the sum of all contributions.
 *
 * Returns { payouts: number[], leftover: number } — payouts aligned with entries.
 */
function computeSidePots({ entries, totalPot }) {
  if (!Array.isArray(entries)) return { payouts: [], leftover: Number(totalPot) || 0 };
  const n = entries.length;
  const contribs = entries.map((e) => Math.max(0, Math.floor((e && Number(e.contrib)) || 0)));
  const potTotal = Math.round(Number(totalPot) || contribs.reduce((a, b) => a + b, 0));
  const payouts = new Array(n).fill(0);

  const contenderIdx = [];
  for (let i = 0; i < n; i++) {
    if (entries[i] && entries[i].eligible && contribs[i] > 0) contenderIdx.push(i);
  }
  contenderIdx.sort((a, b) => contribs[a] - contribs[b]);

  let prevLevel = 0;
  let k = 0;
  while (k < contenderIdx.length) {
    const level = contribs[contenderIdx[k]];
    if (level > prevLevel) {
      // Everyone (including folded/departed) who covered this level funds the tier
      let count = 0;
      for (const c of contribs) if (c >= level) count++;
      const sideVal = (level - prevLevel) * count;
      if (sideVal > 0) {
        const eligible = contenderIdx.filter((i) => contribs[i] >= level);
        let best = -Infinity;
        for (const i of eligible) {
          const s = Number(entries[i].score) || 0;
          if (s > best) best = s;
        }
        const winners = eligible.filter((i) => (Number(entries[i].score) || 0) === best);
        if (winners.length > 0) {
          const per = Math.floor(sideVal / winners.length);
          let rem = sideVal % winners.length;
          for (const w of winners) {
            payouts[w] += per + (rem > 0 ? 1 : 0);
            if (rem > 0) rem--;
          }
        }
      }
      prevLevel = level;
    }
    const lvl = level;
    while (k < contenderIdx.length && contribs[contenderIdx[k]] <= lvl) k++;
  }

  // Leftover (theoretically 0; guards against rounding/dead-money cases) goes
  // to the highest-contributing eligible player; ties -> lowest seat index.
  let distributed = 0;
  for (const v of payouts) distributed += v;
  let leftover = potTotal - distributed;
  if (leftover > 0 && contenderIdx.length > 0) {
    let pick = contenderIdx[0];
    for (const i of contenderIdx) {
      if (contribs[i] > contribs[pick]) pick = i; // strictly greater keeps the lowest index on ties
    }
    payouts[pick] += leftover;
    leftover = 0;
  }
  return { payouts, leftover };
}

module.exports = { computeSidePots };
