/**
 * Console Client (Socket.IO)
 * Spectator view showing the game table.
 * Displays discard pile, player seats, event feed.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  // ── Session ──
  const session = JSON.parse(localStorage.getItem('uno_session'));
  if (!session) {
    window.location.href = '/';
    return;
  }

  const { playerName, playerId, isHost } = session;
  let roomCode = session.roomCode;
  const CARD_BASE = '/uno-cards/';

  // ── State ──
  let prevDiscardImage = null;

  // ── Elements ──
  const lobbyView = $('#lobbyView');
  const gameView = $('#gameView');
  const lobbyRoomCode = $('#lobbyRoomCode');
  const lobbyPlayerList = $('#lobbyPlayerList');
  const consoleRoomCode = $('#consoleRoomCode');
  const playersStrip = $('#playersStrip');
  const consoleDiscardCard = $('#consoleDiscardCard');
  const consoleColorIndicator = $('#consoleColorIndicator');
  const consoleColorIndicator2 = $('#consoleColorIndicator2');
  const consoleColorLabel = $('#consoleColorLabel');
  const consoleDeckCount = $('#consoleDeckCount');
  const consoleDrawStack = $('#consoleDrawStack');
  const consoleCurrentTurn = $('#consoleCurrentTurn');
  const directionDisplay = $('#directionDisplay');
  const eventFeed = $('#eventFeed');
  const winOverlay = $('#winOverlay');
  const winTitle = $('#winTitle');
  const winName = $('#winName');
  const btnNewGame = $('#btnNewGame');

  // ══════════════════════════════════════════════════
  // Initialize
  // ══════════════════════════════════════════════════

  function init() {
    const socket = io();

    socket.on('connect', () => {
      if (isHost) {
        socket.emit('create-room', { playerName, playerId, role: 'console' }, (res) => {
          if (res.success) {
            roomCode = res.roomCode;
            session.roomCode = roomCode;
            localStorage.setItem('uno_session', JSON.stringify(session));
            lobbyRoomCode.textContent = roomCode;
            consoleRoomCode.textContent = roomCode;
          } else {
            showToast(res.error || 'Failed to create room', 'error');
          }
        });
      } else {
        lobbyRoomCode.textContent = roomCode;
        consoleRoomCode.textContent = roomCode;
        socket.emit('join-room', { roomCode, playerName, playerId, role: 'console' }, (res) => {
          if (res.error) {
            showToast(res.error, 'error');
            setTimeout(() => { window.location.href = '/'; }, 2000);
          }
        });
      }
    });

    socket.on('disconnect', () => {
      showToast('Disconnected — reconnecting...', 'error');
    });

    // ── Server Events ──
    socket.on('lobby-state', onLobbyState);
    socket.on('game-state', onGameState);
    socket.on('player-joined', (data) => {
      showToast(`${data.name} joined`, 'success');
    });
    socket.on('player-left', (data) => {
      showToast(`${data.name} left`, '');
    });
  }

  // ══════════════════════════════════════════════════
  // STATE HANDLERS
  // ══════════════════════════════════════════════════

  function onLobbyState(data) {
    lobbyRoomCode.textContent = data.roomCode;
    consoleRoomCode.textContent = data.roomCode;

    lobbyPlayerList.innerHTML = '';
    (data.players || []).forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.id === data.hostId) {
        li.innerHTML += ' <span class="host-badge">HOST</span>';
      }
      lobbyPlayerList.appendChild(li);
    });
  }

  function onGameState(state) {
    if (state.status === 'playing' || state.status === 'finished') {
      lobbyView.classList.add('hidden');
      gameView.classList.remove('hidden');
    }

    updatePlayers(state);
    updateDiscard(state);
    updateColor(state);
    updateDeck(state);
    updateDirection(state);
    updateCurrentTurn(state);
    updateEventFeed(state);

    if (state.status === 'finished' && state.winner) {
      showWin(state.winner);
    }
  }

  function updatePlayers(state) {
    playersStrip.innerHTML = '';

    state.players.forEach((p, idx) => {
      const seat = document.createElement('div');
      seat.className = 'player-seat';

      if (idx === state.currentPlayerIndex && state.status === 'playing') {
        seat.classList.add('active');
      }

      if (p.calledUno && p.cardCount === 1) {
        seat.classList.add('has-uno');
      }

      seat.innerHTML = `
        <span class="seat-name">${escapeHtml(p.name)}</span>
        <span class="seat-cards">${p.cardCount}</span>
        <span class="seat-label">${p.cardCount === 1 ? 'card' : 'cards'}</span>
        <span class="seat-uno-badge">UNO!</span>
      `;

      playersStrip.appendChild(seat);
    });
  }

  function updateDiscard(state) {
    if (!state.discardTop) return;

    const newImage = state.discardTop.image;
    if (newImage !== prevDiscardImage) {
      consoleDiscardCard.innerHTML = `
        <img class="card-img card-play-anim"
             src="${CARD_BASE}${newImage}"
             alt="${state.discardTop.color} ${state.discardTop.value}"
             style="width:100%; height:100%; border-radius: var(--radius-card);">
      `;
      prevDiscardImage = newImage;
      sfx.cardPlay();
    }
  }

  function updateColor(state) {
    consoleColorIndicator.setAttribute('data-color', state.currentColor || '');
    consoleColorIndicator2.setAttribute('data-color', state.currentColor || '');
    consoleColorLabel.textContent = state.currentColor || '';
  }

  function updateDeck(state) {
    consoleDeckCount.textContent = state.deckCount;

    if (state.drawStack > 0) {
      consoleDrawStack.textContent = `+${state.drawStack} Draw Stack!`;
      consoleDrawStack.classList.remove('hidden');
    } else {
      consoleDrawStack.classList.add('hidden');
    }
  }

  function updateDirection(state) {
    directionDisplay.textContent = state.direction === 1 ? '↻' : '↺';
    directionDisplay.classList.toggle('ccw', state.direction === -1);
  }

  function updateCurrentTurn(state) {
    const current = state.players[state.currentPlayerIndex];
    if (current) {
      consoleCurrentTurn.innerHTML = `<strong>${escapeHtml(current.name)}</strong>'s turn`;
    }
  }

  function updateEventFeed(state) {
    if (!state.eventLog || state.eventLog.length === 0) return;

    eventFeed.innerHTML = '';
    state.eventLog.forEach(evt => {
      const li = document.createElement('li');
      li.textContent = evt.text;
      eventFeed.appendChild(li);
    });

    const footer = $('#consoleFooter');
    footer.scrollTop = footer.scrollHeight;
  }

  // ── Win ──
  function showWin(winner) {
    winTitle.textContent = 'WINNER!';
    winName.textContent = winner.name + ' wins the game! 🎉';
    winOverlay.classList.add('active');
    sfx.win();
  }

  btnNewGame.addEventListener('click', () => {
    winOverlay.classList.remove('active');
  });

  // ── Utilities ──
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type = '') {
    const container = $('#toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'toastOut 0.3s ease-out forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ── Sound init ──
  document.addEventListener('click', () => sfx.init(), { once: true });

  // ── Start ──
  init();
})();
