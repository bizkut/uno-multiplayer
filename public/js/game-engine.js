/**
 * UNO Game Engine
 * Runs in the host player's browser — handles all game logic, validation, state.
 * Broadcasts state via Pusher client events.
 */
class UnoGame {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.players = [];       // [{id, name, hand: [], calledUno: false}]
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1;      // 1 = clockwise, -1 = counter-clockwise
    this.currentColor = null;
    this.status = 'waiting'; // waiting | playing | finished
    this.winner = null;
    this.eventLog = [];
    this.drawStack = 0;      // accumulated draw count for stacking
    this.pendingDrawPlayerId = null; // player who just drew and can play drawn card
    this.lastDrawnCard = null;
  }

  // ──────────────────── Setup ────────────────────

  addPlayer(id, name) {
    if (this.status !== 'waiting') return { error: 'Game already started' };
    if (this.players.length >= 10) return { error: 'Room is full (max 10)' };
    if (this.players.find(p => p.id === id)) return { error: 'Already in room' };

    this.players.push({
      id,
      name,
      hand: [],
      calledUno: false,
    });

    this.addEvent(`${name} joined the game`);
    return { success: true };
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;

    const player = this.players[idx];
    this.addEvent(`${player.name} left the game`);

    // Return cards to deck
    if (player.hand.length > 0) {
      this.deck.push(...player.hand);
    }

    this.players.splice(idx, 1);

    // Adjust current player index if needed
    if (this.status === 'playing' && this.players.length >= 2) {
      if (idx < this.currentPlayerIndex) {
        this.currentPlayerIndex--;
      } else if (idx === this.currentPlayerIndex) {
        this.currentPlayerIndex = this.currentPlayerIndex % this.players.length;
      }
    }

    // End game if too few players
    if (this.status === 'playing' && this.players.length < 2) {
      this.status = 'finished';
      if (this.players.length === 1) {
        this.winner = this.players[0];
        this.addEvent(`🎉 ${this.winner.name} wins by default!`);
      }
    }
  }

  // ──────────────────── Deck Construction ────────────────────

  createDeck() {
    const colors = ['Red', 'Blue', 'Green', 'Yellow'];
    const deck = [];
    let cardId = 0;

    for (const color of colors) {
      // One 0 per color
      deck.push(this._card(cardId++, color, '0', 'number'));

      // Two each of 1–9
      for (let n = 1; n <= 9; n++) {
        deck.push(this._card(cardId++, color, String(n), 'number'));
        deck.push(this._card(cardId++, color, String(n), 'number'));
      }

      // Two each of action cards
      for (let i = 0; i < 2; i++) {
        deck.push(this._card(cardId++, color, 'Skip', 'action'));
        deck.push(this._card(cardId++, color, 'Reverse', 'action'));
        deck.push(this._card(cardId++, color, 'Draw_2', 'action'));
      }
    }

    // 4 Wild + 4 Wild Draw 4
    for (let i = 0; i < 4; i++) {
      deck.push(this._card(cardId++, 'Wild', 'Wild', 'wild'));
      deck.push(this._card(cardId++, 'Wild', 'Wild_Draw_4', 'wild'));
    }

    return deck; // 108 cards
  }

  _card(id, color, value, type) {
    return {
      id,
      color,
      value,
      type,
      image: this._cardImage(color, value),
    };
  }

  _cardImage(color, value) {
    if (color === 'Wild') {
      return value === 'Wild' ? 'Wild.jpg' : 'Wild_Draw_4.jpg';
    }
    // Handle the RED_Reverse.jpg naming inconsistency in assets
    if (color === 'Red' && value === 'Reverse') {
      return 'RED_Reverse.jpg';
    }
    return `${color}_${value}.jpg`;
  }

  // ──────────────────── Shuffle ────────────────────

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ──────────────────── Game Start ────────────────────

  startGame() {
    if (this.players.length < 2) {
      return { error: 'Need at least 2 players' };
    }

    // Reset state
    this.deck = this.shuffle(this.createDeck());
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.status = 'playing';
    this.winner = null;
    this.eventLog = [];
    this.drawStack = 0;
    this.pendingDrawPlayerId = null;
    this.lastDrawnCard = null;

    // Deal 7 cards to each player
    for (const player of this.players) {
      player.hand = [];
      player.calledUno = false;
      for (let i = 0; i < 7; i++) {
        player.hand.push(this.deck.pop());
      }
    }

    // Flip first card — reshuffle if Wild Draw 4
    let firstCard = this.deck.pop();
    while (firstCard.value === 'Wild_Draw_4') {
      this.deck.unshift(firstCard);
      this.shuffle(this.deck);
      firstCard = this.deck.pop();
    }
    this.discardPile.push(firstCard);

    // Set initial color
    if (firstCard.color === 'Wild') {
      const colors = ['Red', 'Blue', 'Green', 'Yellow'];
      this.currentColor = colors[Math.floor(Math.random() * 4)];
      this.addEvent(`First card is Wild — color set to ${this.currentColor}`);
    } else {
      this.currentColor = firstCard.color;
    }

    // Apply first card effects
    if (firstCard.value === 'Skip') {
      this.addEvent(`First card is Skip! ${this.players[0].name} is skipped.`);
      this.advanceTurn();
    } else if (firstCard.value === 'Reverse') {
      this.direction = -1;
      this.addEvent('First card is Reverse! Playing counter-clockwise.');
      if (this.players.length === 2) {
        this.advanceTurn();
      }
    } else if (firstCard.value === 'Draw_2') {
      this.drawStack = 2;
      this.addEvent(`First card is Draw 2! ${this.players[0].name} must draw or stack.`);
    }

    this.addEvent('🎮 Game started! ' + this.players[this.currentPlayerIndex].name + "'s turn.");
    return { success: true };
  }

  // ──────────────────── Play Card ────────────────────

  playCard(playerId, cardId, chosenColor = null) {
    if (this.status !== 'playing') return { error: 'Game not in progress' };

    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: 'Player not found' };
    if (playerIndex !== this.currentPlayerIndex) return { error: 'Not your turn' };

    const player = this.players[playerIndex];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return { error: 'Card not in hand' };

    const card = player.hand[cardIndex];

    // If there's a draw stack, only matching draw cards can be played
    if (this.drawStack > 0) {
      const topCard = this.getTopCard();
      const canStack =
        (card.value === 'Draw_2' && topCard.value === 'Draw_2') ||
        (card.value === 'Wild_Draw_4');
      if (!canStack) {
        return { error: `You must draw ${this.drawStack} cards or stack a Draw card` };
      }
    }

    // Validate play
    if (!this.isValidPlay(card)) {
      return { error: 'Invalid play — must match color, number, or play a Wild' };
    }

    // Wild cards need a color choice
    if (card.color === 'Wild' && !chosenColor) {
      return { error: 'Choose a color', needsColor: true };
    }

    // ── Execute the play ──
    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.pendingDrawPlayerId = null;
    this.lastDrawnCard = null;

    // Set current color
    if (card.color === 'Wild') {
      this.currentColor = chosenColor;
    } else {
      this.currentColor = card.color;
    }

    // Event log
    const cardLabel = card.color === 'Wild'
      ? `${card.value.replace('_', ' ')} → ${chosenColor}`
      : `${card.color} ${card.value.replace('_', ' ')}`;
    this.addEvent(`${player.name} played ${cardLabel}`);

    // Check for win
    if (player.hand.length === 0) {
      this.status = 'finished';
      this.winner = player;
      this.addEvent(`🎉🏆 ${player.name} WINS THE GAME!`);
      return { success: true, winner: player.name };
    }

    // Apply card effects (may advance turn extra for Skip)
    this.applyCardEffect(card);

    // Advance to next player
    this.advanceTurn();

    return { success: true, cardPlayed: card };
  }

  // ──────────────────── Validation ────────────────────

  isValidPlay(card) {
    // Wild cards always playable
    if (card.color === 'Wild') return true;

    const topCard = this.getTopCard();
    // Match current color
    if (card.color === this.currentColor) return true;
    // Match value/type
    if (card.value === topCard.value) return true;

    return false;
  }

  getTopCard() {
    return this.discardPile[this.discardPile.length - 1];
  }

  // ──────────────────── Card Effects ────────────────────

  applyCardEffect(card) {
    switch (card.value) {
      case 'Skip':
        this.addEvent(`⏭️ ${this.getNextPlayer().name} is skipped!`);
        this.advanceTurn(); // extra advance = skip
        break;

      case 'Reverse':
        this.direction *= -1;
        const dirLabel = this.direction === 1 ? 'clockwise ↻' : 'counter-clockwise ↺';
        this.addEvent(`🔄 Direction reversed! Now ${dirLabel}`);
        if (this.players.length === 2) {
          this.advanceTurn(); // In 2-player, reverse = skip
        }
        break;

      case 'Draw_2':
        this.drawStack += 2;
        this.addEvent(`📥 ${this.getNextPlayer().name} must draw ${this.drawStack} or stack!`);
        break;

      case 'Wild_Draw_4':
        this.drawStack += 4;
        this.addEvent(`📥💀 ${this.getNextPlayer().name} must draw ${this.drawStack} or stack!`);
        break;
    }
  }

  // ──────────────────── Draw Card ────────────────────

  drawCard(playerId) {
    if (this.status !== 'playing') return { error: 'Game not in progress' };

    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: 'Player not found' };
    if (playerIndex !== this.currentPlayerIndex) return { error: 'Not your turn' };

    const player = this.players[playerIndex];

    // If there's a draw stack, must draw all
    if (this.drawStack > 0) {
      const count = this.drawStack;
      for (let i = 0; i < count; i++) {
        this._drawFromDeck(player);
      }
      this.drawStack = 0;
      this.addEvent(`${player.name} drew ${count} cards 📥`);
      this.advanceTurn();
      return { success: true, drawn: count };
    }

    // Regular draw — draw 1
    const card = this._drawFromDeck(player);
    this.addEvent(`${player.name} drew a card`);

    // Can the drawn card be played?
    if (this.isValidPlay(card)) {
      this.pendingDrawPlayerId = playerId;
      this.lastDrawnCard = card;
      return { success: true, drawn: 1, canPlay: true, drawnCard: card };
    }

    // Can't play — turn over
    this.advanceTurn();
    return { success: true, drawn: 1, canPlay: false };
  }

  keepDrawnCard(playerId) {
    if (this.pendingDrawPlayerId !== playerId) return { error: 'No pending draw' };
    this.pendingDrawPlayerId = null;
    this.lastDrawnCard = null;
    this.addEvent(`${this.players[this.currentPlayerIndex].name} kept the drawn card`);
    this.advanceTurn();
    return { success: true };
  }

  _drawFromDeck(player) {
    if (this.deck.length === 0) {
      this._reshuffleDeck();
    }
    const card = this.deck.pop();
    player.hand.push(card);
    return card;
  }

  _reshuffleDeck() {
    if (this.discardPile.length <= 1) return; // Nothing to reshuffle
    const topCard = this.discardPile.pop();
    this.deck = this.shuffle([...this.discardPile]);
    this.discardPile = [topCard];
    this.addEvent('🔀 Deck reshuffled from discard pile!');
  }

  // ──────────────────── UNO Call ────────────────────

  callUno(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };

    if (player.hand.length <= 2) {
      player.calledUno = true;
      this.addEvent(`🔴 ${player.name} called UNO!`);
      return { success: true };
    }
    return { error: 'Can only call UNO with 1-2 cards' };
  }

  catchUno(callerId, targetId) {
    const caller = this.players.find(p => p.id === callerId);
    const target = this.players.find(p => p.id === targetId);

    if (!caller || !target) return { error: 'Player not found' };

    if (target.hand.length === 1 && !target.calledUno) {
      // Caught! Penalty: draw 2
      this._drawFromDeck(target);
      this._drawFromDeck(target);
      this.addEvent(`🚨 ${caller.name} caught ${target.name}! +2 penalty cards!`);
      return { success: true, caught: true };
    }

    return { success: false, message: 'Player already called UNO or has too many cards' };
  }

  // ──────────────────── Turn Management ────────────────────

  advanceTurn() {
    this.currentPlayerIndex = this.getNextPlayerIndex();
    const currentPlayer = this.players[this.currentPlayerIndex];
    // Reset UNO flag if they have more than 1 card
    if (currentPlayer && currentPlayer.hand.length > 1) {
      currentPlayer.calledUno = false;
    }
  }

  getNextPlayerIndex() {
    return ((this.currentPlayerIndex + this.direction) + this.players.length) % this.players.length;
  }

  getNextPlayer() {
    return this.players[this.getNextPlayerIndex()];
  }

  // ──────────────────── Event Log ────────────────────

  addEvent(text) {
    this.eventLog.push({
      text,
      timestamp: Date.now(),
    });
    if (this.eventLog.length > 50) {
      this.eventLog.shift();
    }
  }

  // ──────────────────── State Serialization ────────────────────

  getState() {
    return {
      roomCode: this.roomCode,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        hand: p.hand.map(c => ({ ...c })),
        calledUno: p.calledUno,
      })),
      discardTop: this.getTopCard() ? { ...this.getTopCard() } : null,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerName: this.players[this.currentPlayerIndex]
        ? this.players[this.currentPlayerIndex].name
        : null,
      direction: this.direction,
      currentColor: this.currentColor,
      status: this.status,
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      deckCount: this.deck.length,
      drawStack: this.drawStack,
      pendingDrawPlayerId: this.pendingDrawPlayerId,
      eventLog: this.eventLog.slice(-25),
    };
  }

  // ──────────────────── Save / Restore (localStorage) ────────────────────

  serialize() {
    return JSON.stringify({
      roomCode: this.roomCode,
      players: this.players,
      deck: this.deck,
      discardPile: this.discardPile,
      currentPlayerIndex: this.currentPlayerIndex,
      direction: this.direction,
      currentColor: this.currentColor,
      status: this.status,
      winner: this.winner,
      eventLog: this.eventLog,
      drawStack: this.drawStack,
      pendingDrawPlayerId: this.pendingDrawPlayerId,
      lastDrawnCard: this.lastDrawnCard,
    });
  }

  static deserialize(json) {
    const data = JSON.parse(json);
    const game = new UnoGame(data.roomCode);
    Object.assign(game, data);
    return game;
  }
}

// Export for both browser and Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UnoGame;
}
