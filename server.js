const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { evaluate7 } = require('./poker_eval.js');
const { computeSidePots } = require('./side_pots.js');

const PORT = process.env.PORT || 8080;
const MAX_ROOMS = 200;
const MAX_PLAYERS = 4;
const IDLE_ROOM_MS = 30 * 60 * 1000; // idle empty-ish lobby rooms are swept

function createStandardDeck() {
  const suits = ['H', 'C', 'D', 'S'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push(`${s}_${r}`);
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sanitizeName(raw, fallback) {
  let n = typeof raw === 'string' ? raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().substring(0, 16) : '';
  if (!n || n.length === 0) n = fallback || 'Pemain';
  return n;
}

const rooms = new Map();

class TableRoom {
  constructor(code, hostWs, hostName, hostChips) {
    this.code = code;
    this.roundNumber = 0;
    this.players = [];
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 10;
    this.minBet = 10;
    this.phase = 'lobby';
    this.turn = -1; // seat number of active player
    this.dealerSeat = 0;
    this.actedInStreet = new Set();
    this.goneContributed = 0; // contributions of players who left mid-round
    this.lastTouched = Date.now();
    this.addPlayer(hostWs, hostName, hostChips);
  }

  addPlayer(ws, name, chips) {
    if (this.players.length >= MAX_PLAYERS) return null;
    const seat = this.players.length;
    let initialChips = parseInt(chips, 10);
    if (isNaN(initialChips) || initialChips <= 0) initialChips = 100;
    initialChips = Math.min(initialChips, 9999999);
    const p = {
      ws,
      name: sanitizeName(name, `Pemain ${seat + 1}`),
      seat,
      chips: initialChips,
      roundContrib: 0,
      currentBet: Math.min(5, initialChips),
      folded: false,
      allIn: false,
      cards: [],
      status: 'Ready'
    };
    this.players.push(p);
    return p;
  }

  removePlayer(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx !== -1) {
      const p = this.players[idx];
      const wasRoundActive = (this.phase !== 'lobby' && this.phase !== 'round_over' && this.phase !== 'showdown');
      if (wasRoundActive) {
        if (!p.folded) {
          p.folded = true;
          p.status = 'Fold';
        }
        // Keep their money in the round's tiers even after they left
        this.goneContributed += (p.roundContrib || 0);
      }

      this.players.splice(idx, 1);
      this.players.forEach((pl, i) => { pl.seat = i; });

      // Shift remaining seat indices in actedInStreet
      const newActed = new Set();
      for (const s of this.actedInStreet) {
        if (s < idx) newActed.add(s);
        else if (s > idx) newActed.add(s - 1);
      }
      this.actedInStreet = newActed;

      if (wasRoundActive) {
        if (this.players.length <= 1) {
          if (this.players.length === 1) {
            const survivor = this.players[0];
            survivor.chips += this.pot;
            survivor.status = `Menang $${this.pot}`;
            this.broadcast({
              type: 'event',
              action: 'win',
              message: `${survivor.name} menang pot $${this.pot}! Lawan keluar meja.`
            });
            this.pot = 0;
          }
          this.phase = 'round_over';
          this.turn = -1;
        } else if (!this.checkFoldWin()) {
          if (this.turn === idx) {
            this.turn = this.nextActiveSeat(idx === 0 ? this.players.length - 1 : idx - 1);
          } else if (this.turn > idx) {
            this.turn = this.turn - 1;
          }
          if (this.turn >= this.players.length) {
            this.turn = this.nextActiveSeat(0);
          }

          if (this.turn === -1) {
            while (this.communityCards.length < 5) {
              this.communityCards.push(this.deck.pop());
            }
            this.showdown();
            return;
          } else if (this.isStreetComplete()) {
            this.advanceStreet();
            return;
          }
        }
      }
    }
    if (this.players.length === 0) {
      rooms.delete(this.code);
    } else {
      this.broadcastState();
    }
  }

  getActivePlayers() {
    return this.players.filter(p => !p.folded);
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    this.lastTouched = Date.now();
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(msg);
      }
    }
  }

  broadcastState() {
    this.lastTouched = Date.now();
    for (const p of this.players) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

      // Anti-cheat: mask opponent hole cards unless showdown revelation applies
      const maskedSeats = this.players.map(pl => {
        const isSelf = (pl.seat === p.seat);
        const canReveal = (isSelf && pl.cards.length > 0) ||
          (this.phase === 'showdown' && !pl.folded && pl.cards.length > 0);
        return {
          seat: pl.seat,
          name: pl.name,
          chips: pl.chips,
          currentBet: pl.currentBet,
          folded: pl.folded,
          allIn: pl.allIn,
          status: pl.status,
          cards: canReveal ? pl.cards : (pl.cards.length ? ['back', 'back'] : []),
          bestHand: (this.phase === 'showdown' && canReveal) ? (pl.bestHand || null) : null
        };
      });

      const payload = {
        type: 'state',
        room: this.code,
        round: this.roundNumber,
        phase: this.phase,
        pot: this.pot,
        currentBet: this.currentBet,
        minBet: this.minBet,
        turnSeat: this.turn,
        isYourTurn: (this.turn === p.seat),
        community: this.communityCards,
        players: maskedSeats,
        mySeat: p.seat,
        isHost: (p.seat === 0)
      };

      p.ws.send(JSON.stringify(payload));
    }
  }

  startRound() {
    if (this.players.length < 2) return;
    if (this.phase !== 'lobby' && this.phase !== 'round_over' && this.phase !== 'showdown') return;
    this.roundNumber++;
    this.deck = createStandardDeck();
    this.communityCards = [];
    this.pot = 0;
    this.goneContributed = 0;
    this.currentBet = this.minBet;
    this.phase = 'bet_preflop';
    this.actedInStreet.clear();

    // Reset and deal 2 cards
    for (const p of this.players) {
      if (p.chips < 10) p.chips = 10; // minimal stack floor so blinds/raises are playable
      p.cards = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
      p.allIn = false;
      p.currentBet = 0;
      p.roundContrib = 0;
      p.status = 'Playing';
      p.bestHand = null;
    }

    // Ante / Small blind & Big blind
    for (const p of this.players) {
      const blind = Math.min(p.chips, 5);
      p.chips -= blind;
      p.currentBet = blind;
      p.roundContrib += blind;
      this.pot += blind;
    }
    this.currentBet = 5;

    // First to act: seat next to host/dealer
    this.turn = (this.dealerSeat + 1) % this.players.length;
    this.broadcastState();
  }

  checkFoldWin() {
    const active = this.getActivePlayers();
    if (active.length === 1 && this.players.length > 1) {
      const winner = active[0];
      winner.chips += this.pot;
      winner.status = `Menang $${this.pot}`;
      this.broadcast({
        type: 'event',
        action: 'win',
        message: `${winner.name} menang pot $${this.pot}! Semua lawan fold.`
      });
      this.pot = 0;
      this.phase = 'round_over';
      this.turn = -1;
      this.broadcastState();
      return true;
    }
    return false;
  }

  advanceStreet() {
    if (this.checkFoldWin()) return;

    this.actedInStreet.clear();
    for (const p of this.players) {
      p.currentBet = 0;
      if (!p.folded && !p.allIn) p.status = 'Playing';
    }
    this.currentBet = 0;

    if (this.phase === 'bet_preflop') {
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'bet_flop';
    } else if (this.phase === 'bet_flop') {
      this.communityCards.push(this.deck.pop());
      this.phase = 'bet_turn';
    } else if (this.phase === 'bet_turn') {
      this.communityCards.push(this.deck.pop());
      this.phase = 'bet_river';
    } else if (this.phase === 'bet_river') {
      this.showdown();
      return;
    }

    // If at most 1 active player can act, fast-forward remaining community cards to showdown
    const active = this.players.filter(p => !p.folded && !p.allIn);
    if (active.length <= 1) {
      while (this.communityCards.length < 5) {
        this.communityCards.push(this.deck.pop());
      }
      this.showdown();
      return;
    }

    // Turn goes to first active player after dealer
    this.turn = this.nextActiveSeat(this.dealerSeat);
    if (this.turn === -1) {
      while (this.communityCards.length < 5) {
        this.communityCards.push(this.deck.pop());
      }
      this.showdown();
      return;
    }
    this.broadcastState();
  }

  nextActiveSeat(fromSeat) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (fromSeat + i) % n;
      const pl = this.players[s];
      if (pl && !pl.folded && !pl.allIn) return s;
    }
    return -1; // No more players can act (everyone all-in)
  }

  isStreetComplete() {
    const contenders = this.players.filter(p => !p.folded);
    if (contenders.length <= 1) return true;

    for (const p of contenders) {
      if (!p.allIn) {
        if (!this.actedInStreet.has(p.seat)) return false;
        if (p.currentBet !== this.currentBet) return false;
      }
    }
    return true;
  }

  handlePlayerAction(ws, { action, amount }) {
    if (this.phase === 'lobby' || this.phase === 'round_over') return;
    if (!String(this.phase).startsWith('bet_')) return;
    const p = this.players.find(pl => pl.ws === ws);
    if (!p || p.folded || p.allIn) return;
    if (p.seat !== this.turn) return;

    const callNeeded = Math.max(0, this.currentBet - p.currentBet);

    if (action === 'fold') {
      p.folded = true;
      p.status = 'Fold';
      this.broadcast({ type: 'event', action: 'fold', seat: p.seat, name: p.name });
      if (this.checkFoldWin()) return;
    } else if (action === 'check') {
      if (callNeeded > 0) return; // Cannot check if bet pending
      p.status = 'Check';
      this.actedInStreet.add(p.seat);
    } else if (action === 'call') {
      const act = Math.min(p.chips, callNeeded);
      p.chips -= act;
      p.currentBet += act;
      p.roundContrib += act;
      this.pot += act;
      if (p.chips === 0) p.allIn = true;
      p.status = `Call $${act}`;
      this.actedInStreet.add(p.seat);
    } else if (action === 'raise') {
      const raiseAmt = Math.max(5, Number(amount) || 10);
      const totalCost = callNeeded + raiseAmt;
      const spent = Math.min(p.chips, totalCost);
      p.chips -= spent;
      p.currentBet += spent;
      p.roundContrib += spent;
      this.pot += spent;
      this.currentBet = Math.max(this.currentBet, p.currentBet);
      if (p.chips === 0) p.allIn = true;
      p.status = `Raise $${Math.min(spent - callNeeded, spent)}`;
      this.actedInStreet.clear(); // Reset others' obligation to call
      this.actedInStreet.add(p.seat);
    } else if (action === 'allin') {
      const allAmt = p.chips;
      p.chips = 0;
      p.currentBet += allAmt;
      p.roundContrib += allAmt;
      this.pot += allAmt;
      const raised = p.currentBet > this.currentBet;
      this.currentBet = Math.max(this.currentBet, p.currentBet);
      p.allIn = true;
      p.status = `ALL IN ($${allAmt})`;
      if (raised) {
        this.actedInStreet.clear();
      }
      this.actedInStreet.add(p.seat);
    } else {
      return; // Unknown action: ignore, do not advance the game
    }

    if (this.isStreetComplete()) {
      this.advanceStreet();
    } else {
      this.turn = this.nextActiveSeat(this.turn);
      if (this.turn === -1) {
        // Everyone is all-in or folded, fast-forward remaining community cards to showdown
        while (this.communityCards.length < 5) {
          this.communityCards.push(this.deck.pop());
        }
        this.showdown();
        return;
      }
      this.broadcastState();
    }
  }

  showdown() {
    if (this.players.length === 0) { this.pot = 0; return; }
    this.phase = 'showdown';
    this.turn = -1;

    const contenders = this.players.filter(p => !p.folded);
    for (const c of contenders) {
      const res2 = evaluate7(c.cards, this.communityCards);
      c.score = res2.score;
      c.bestHand = res2.name;
    }

    contenders.sort((a, b) => b.score - a.score);

    // ---- Side-pot aware distribution ----
    const entries = [];
    for (const p of this.players) {
      entries.push({ contrib: p.roundContrib || 0, score: p.score || 0, eligible: !p.folded });
    }
    if (this.goneContributed > 0) {
      entries.push({ contrib: this.goneContributed, score: 0, eligible: false });
    }

    const potSnapshot = this.pot;
    const { payouts, leftover } = computeSidePots({ entries, totalPot: this.pot });

    let winnersCount = 1;
    if (contenders.length > 0) {
      const topScore = Math.max(...contenders.map(c => c.score || 0));
      winnersCount = contenders.filter(c => c.score === topScore).length;
    }

    for (let i = 0; i < this.players.length; i++) {
      const amt = payouts[i] || 0;
      const p = this.players[i];
      if (amt > 0) {
        p.chips += amt;
        p.status = (winnersCount > 1 ? `SERI ($${amt})` : `MENANG ($${amt})`);
      }
    }

    if (contenders.length > 0) {
      const topScore = Math.max(...contenders.map(c => c.score || 0));
      const winners = contenders.filter(c => c.score === topScore);
      const names = winners.map(w => w.name).join(' & ');
      this.broadcast({
        type: 'event',
        action: 'win',
        message: winners.length > 1
          ? `SERI! ${names} membagi pot $${potSnapshot} (${winners[0].bestHand})!`
          : `${winners[0].name} MENANG POT $${potSnapshot} dengan ${winners[0].bestHand}!`
      });
    }

    if (leftover > 0) {
      // Uncalled excess: return to the biggest contributor still seated
      let maxP = null;
      for (const p of this.players) {
        if (!maxP || (p.roundContrib || 0) > (maxP.roundContrib || 0)) maxP = p;
      }
      if (maxP) maxP.chips += leftover;
    }

    this.pot = 0;
    this.dealerSeat = (this.dealerSeat + 1) % this.players.length;
    this.broadcastState();
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, version: '2.0-sidepots' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let msgCount = 0;
  let msgWindow = Date.now();

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - msgWindow > 2000) { msgWindow = now; msgCount = 0; }
    msgCount++;
    if (msgCount > 40 || raw.length > 8192) return; // flood guard

    try {
      const data = JSON.parse(raw);
      if (data.type === 'create_room') {
        // A socket can never sit in two rooms at once
        if (currentRoom) {
          currentRoom.removePlayer(ws);
          currentRoom = null;
        }
        if (rooms.size >= MAX_ROOMS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Server penuh! Coba lagi beberapa saat.' }));
          return;
        }
        let code = makeRoomCode();
        let guard = 0;
        while (rooms.has(code) && guard++ < 50) code = makeRoomCode();
        const r = new TableRoom(code, ws, data.name, data.chips);
        rooms.set(code, r);
        currentRoom = r;
        ws.send(JSON.stringify({ type: 'joined', room: code, isHost: true }));
        r.broadcastState();
      } else if (data.type === 'join_room') {
        if (currentRoom) {
          currentRoom.removePlayer(ws);
          currentRoom = null;
        }
        const code = (data.room || '').trim().toUpperCase();
        const r = rooms.get(code);
        if (!r) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room tidak ditemukan!' }));
          return;
        }
        if (r.players.length >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Meja sudah penuh (maks 4)!' }));
          return;
        }
        const pl = r.addPlayer(ws, data.name, data.chips);
        if (pl) {
          currentRoom = r;
          ws.send(JSON.stringify({ type: 'joined', room: code, isHost: false }));
          r.broadcastState();
        }
      } else if (data.type === 'start_game' || data.type === 'new_round') {
        if (currentRoom && currentRoom.players.length > 0 && currentRoom.players[0].ws === ws) {
          // 'showdown' is a frozen end-state (the server never auto-advances it),
          // so the host must be able to start the next round from there too.
          const canStart = currentRoom.phase === 'lobby' || currentRoom.phase === 'round_over' || currentRoom.phase === 'showdown';
          if (!canStart) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ronde masih berjalan!' }));
          } else if (currentRoom.players.length < 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Minimal 2 pemain untuk mulai!' }));
          } else {
            currentRoom.startRound();
          }
        }
      } else if (data.type === 'action') {
        if (currentRoom) currentRoom.handlePlayerAction(ws, data);
      } else if (data.type === 'set_name') {
        if (currentRoom && currentRoom.phase === 'lobby') {
          const pl = currentRoom.players.find(p => p.ws === ws);
          if (pl) {
            const cleanName = sanitizeName(data.name, pl.name);
            if (cleanName !== pl.name) {
              pl.name = cleanName;
              currentRoom.broadcastState();
            }
          }
        }
      } else if (data.type === 'chat') {
        // Authority: seat & name always come from the server-side player record,
        // never from the client payload (anti-spoofing).
        if (currentRoom) {
          const pl = currentRoom.players.find(p => p.ws === ws);
          if (pl) {
            const text = typeof data.text === 'string'
              ? data.text.replace(/[\u0000-\u001F\u007F]/g, '').substring(0, 120)
              : '';
            if (text.length > 0) {
              currentRoom.broadcast({ type: 'chat', seat: pl.seat, name: pl.name, text });
            }
          }
        }
      } else if (data.type === 'leave_room') {
        if (currentRoom) {
          currentRoom.removePlayer(ws);
          currentRoom = null;
        }
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e.message);
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.removePlayer(ws);
    }
  });
});

function start() {
  server.listen(PORT, () => {
    console.log(`[Balatro Server] Running on http://localhost:${PORT} (WS on ws://localhost:${PORT})`);
  });
  // Housekeeping: sweep idle rooms that would otherwise leak memory forever
  setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      if (r.players.length <= 1 && (now - (r.lastTouched || now)) > IDLE_ROOM_MS) {
        for (const p of r.players) {
          try { p.ws.send(JSON.stringify({ type: 'error', message: 'Meja ditutup karena tidak aktif.' })); } catch (e2) {}
        }
        rooms.delete(code);
        console.log(`[Balatro Server] Swept idle room ${code}`);
      }
    }
  }, 60 * 1000);
}

if (require.main === module) {
  start();
}

// Allow deterministic unit-testing; app.js entrypoint calls start()
module.exports = { TableRoom, rooms, makeRoomCode, sanitizeName, start };
