const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { evaluate7 } = require('./poker_eval.js');

const PORT = process.env.PORT || 8080;

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
    this.addPlayer(hostWs, hostName, hostChips);
  }

  addPlayer(ws, name, chips) {
    if (this.players.length >= 4) return null;
    const seat = this.players.length;
    let initialChips = parseInt(chips, 10);
    if (isNaN(initialChips) || initialChips <= 0) initialChips = 100;
    const p = {
      ws,
      name: name || `Player ${seat + 1}`,
      seat,
      chips: initialChips,
      currentBet: 0,
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
      if (wasRoundActive && !p.folded) {
        p.folded = true;
        p.status = 'Fold';
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
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(msg);
      }
    }
  }

  broadcastState() {
    for (const p of this.players) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

      // Anti-cheat: Mask opponent hole cards unless showdown
      const maskedSeats = this.players.map(pl => {
        const isSelf = (pl.seat === p.seat);
        const canReveal = (this.phase === 'showdown' || isSelf) && !pl.folded;
        return {
          seat: pl.seat,
          name: pl.name,
          chips: pl.chips,
          currentBet: pl.currentBet,
          folded: pl.folded,
          allIn: pl.allIn,
          status: pl.status,
          cards: canReveal ? pl.cards : (pl.cards.length ? ['back', 'back'] : []),
          bestHand: pl.bestHand || null
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
    this.roundNumber++;
    this.deck = createStandardDeck();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = this.minBet;
    this.phase = 'bet_preflop';
    this.actedInStreet.clear();

    // Reset and deal 2 cards
    for (const p of this.players) {
      if (p.chips < this.minBet) p.chips = 100; // Bailout reload
      p.cards = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
      p.allIn = false;
      p.currentBet = 0;
      p.status = 'Playing';
      p.bestHand = null;
    }

    // Ante / Small blind & Big blind
    for (const p of this.players) {
      const blind = Math.min(p.chips, 5);
      p.chips -= blind;
      p.currentBet = blind;
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
    const p = this.players.find(pl => pl.ws === ws);
    if (!p || p.seat !== this.turn || this.phase === 'lobby' || this.phase === 'round_over') return;

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
      this.pot += spent;
      this.currentBet = Math.max(this.currentBet, p.currentBet);
      if (p.chips === 0) p.allIn = true;
      p.status = `Raise $${raiseAmt}`;
      this.actedInStreet.clear(); // Reset others' obligation to call
      this.actedInStreet.add(p.seat);
    } else if (action === 'allin') {
      const allAmt = p.chips;
      p.chips = 0;
      p.currentBet += allAmt;
      this.pot += allAmt;
      const raised = p.currentBet > this.currentBet;
      this.currentBet = Math.max(this.currentBet, p.currentBet);
      p.allIn = true;
      p.status = `ALL IN ($${allAmt})`;
      if (raised) {
        this.actedInStreet.clear();
      }
      this.actedInStreet.add(p.seat);
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
    this.phase = 'showdown';
    this.turn = -1;

    const contenders = this.players.filter(p => !p.folded);
    for (const c of contenders) {
      const res = evaluate7(c.cards, this.communityCards);
      c.score = res.score;
      c.bestHand = res.name;
    }

    contenders.sort((a, b) => b.score - a.score);
    if (contenders.length > 0) {
      const topScore = contenders[0].score;
      const winners = contenders.filter(c => c.score === topScore);
      const splitPot = Math.floor(this.pot / winners.length);
      const remainder = this.pot % winners.length;
      winners.forEach((w, i) => {
        const payout = splitPot + (i === 0 ? remainder : 0);
        w.chips += payout;
        w.status = winners.length > 1 ? `SERI ($${payout})` : `MENANG ($${payout})`;
      });
      const names = winners.map(w => w.name).join(' & ');
      this.broadcast({
        type: 'event',
        action: 'win',
        message: winners.length > 1
          ? `SERI! ${names} membagi pot $${this.pot} (${winners[0].bestHand})!`
          : `${winners[0].name} MENANG POT $${this.pot} dengan ${winners[0].bestHand}!`
      });
      this.pot = 0;
    }

    this.dealerSeat = (this.dealerSeat + 1) % this.players.length;
    this.broadcastState();
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'create_room') {
        let code = makeRoomCode();
        while (rooms.has(code)) code = makeRoomCode();
        const r = new TableRoom(code, ws, data.name, data.chips);
        rooms.set(code, r);
        currentRoom = r;
        ws.send(JSON.stringify({ type: 'joined', room: code, isHost: true }));
        r.broadcastState();
      } else if (data.type === 'join_room') {
        const code = (data.room || '').trim().toUpperCase();
        const r = rooms.get(code);
        if (!r) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room tidak ditemukan!' }));
          return;
        }
        if (r.players.length >= 4) {
          ws.send(JSON.stringify({ type: 'error', message: 'Meja sudah penuh (maks 4)!' }));
          return;
        }
        const pl = r.addPlayer(ws, data.name, data.chips);
        if (pl) {
          currentRoom = r;
          ws.send(JSON.stringify({ type: 'joined', room: code, isHost: false }));
          r.broadcastState();
        }
      } else if (data.type === 'start_game') {
        if (currentRoom && currentRoom.players[0].ws === ws) {
          currentRoom.startRound();
        }
      } else if (data.type === 'new_round') {
        if (currentRoom && currentRoom.players[0].ws === ws) {
          currentRoom.startRound();
        }
      } else if (data.type === 'action') {
        if (currentRoom) currentRoom.handlePlayerAction(ws, data);
      } else if (data.type === 'set_name') {
        if (currentRoom && currentRoom.phase === 'lobby') {
          const pl = currentRoom.players.find(p => p.ws === ws);
          if (pl && data.name && typeof data.name === 'string') {
            const cleanName = data.name.trim().substring(0, 16);
            if (cleanName.length > 0) {
              pl.name = cleanName;
              currentRoom.broadcastState();
            }
          }
        }
      } else if (data.type === 'chat') {
        if (currentRoom) {
          currentRoom.broadcast({
            type: 'chat',
            seat: data.seat,
            name: data.name,
            text: data.text
          });
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

server.listen(PORT, () => {
  console.log(`[Balatro Server] Running on http://localhost:${PORT} (WS on ws://localhost:${PORT})`);
});
