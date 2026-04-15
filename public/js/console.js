/**
 * Console Client (Socket.IO)
 * Spectator view showing the game table.
 * Displays discard pile, player seats, event feed.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

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
  let winScreenShown = false;
  let hasConnected = false;

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
  const btnGoHome = $('#btnGoHome');

  const btnShowMenu = $('#btnShowMenu');
  const gameMenuModal = $('#gameMenuModal');
  const btnRestartGame = $('#btnRestartGame');
  const btnCloseRoom = $('#btnCloseRoom');
  const btnLeaveGame = $('#btnLeaveGame');
  const btnResumeGame = $('#btnResumeGame');

  const confirmModal = $('#confirmModal');
  const confirmTitle = $('#confirmTitle');
  const confirmMessage = $('#confirmMessage');
  const btnConfirmYes = $('#btnConfirmYes');
  const btnConfirmNo = $('#btnConfirmNo');
  let confirmCallback = null;
  let socket = null;

  // ══════════════════════════════════════════════════
  // Initialize
  // ══════════════════════════════════════════════════

  function init() {
    socket = io();

    // Hide host-only buttons for guests
    if (!isHost) {
      $$('[data-host-only="true"]').forEach(el => el.classList.add('hidden'));
    }

    socket.on('connect', () => {
      if (hasConnected) {
        // Reconnection — rejoin existing room
        if (roomCode) {
          socket.emit('join-room', { roomCode, playerName, playerId, role: 'console' }, () => {});
        }
        return;
      }
      hasConnected = true;

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

    socket.on('room-closed', () => {
      showToast('The host has closed the room', 'error');
      setTimeout(() => { window.location.href = '/'; }, 2000);
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
      li.appendChild(document.createTextNode(p.name));
      if (p.id === data.hostId) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = ' HOST';
        li.appendChild(badge);
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

    if (state.status === 'finished' && state.winner && !winScreenShown) {
      winScreenShown = true;
      showWin(state.winner);
    }
    if (state.status !== 'finished') winScreenShown = false;
  }

  function updatePlayers(state) {
    playersStrip.innerHTML = '';

    state.players.forEach((p, idx) => {
      const seat = document.createElement('div');
      seat.className = 'player-seat';

      if (idx === state.currentPlayerIndex && state.status === 'playing') {
        seat.classList.add('active');
      }

      const hasUno = p.calledUno && p.cardCount === 1;
      const needsUno = p.cardCount === 1 && !p.calledUno;

      if (hasUno) seat.classList.add('has-uno');
      if (needsUno) seat.classList.add('warning-1card');

      seat.innerHTML = `
        <span class="seat-name">${escapeHtml(p.name)}</span>
        <span class="seat-cards">${p.cardCount}</span>
        <span class="seat-label">${p.cardCount === 1 ? 'card' : 'cards'}</span>
        <div class="seat-uno-badge">${hasUno ? 'UNO!' : (needsUno ? '⚠️ NO UNO' : '')}</div>
      `;

      playersStrip.appendChild(seat);
    });
  }

  function updateDiscard(state) {
    if (!state.discardTop) return;

    const newImage = state.discardTop.image;
    if (newImage !== prevDiscardImage) {
      consoleDiscardCard.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'card-img card-play-anim';
      img.src = `${CARD_BASE}${newImage}`;
      img.alt = `${state.discardTop.color} ${state.discardTop.value}`;
      img.style.cssText = 'width:100%; height:100%; border-radius: var(--radius-card);';
      consoleDiscardCard.appendChild(img);
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

    // Only host can see/trigger new game
    if (isHost) {
      btnNewGame.classList.remove('hidden');
    } else {
      btnNewGame.classList.add('hidden');
    }

    sfx.win();
  }

  btnNewGame.addEventListener('click', () => {
    winOverlay.classList.remove('active');
    winScreenShown = false;
    if (isHost) {
      socket.emit('new-game', (res) => {
        if (res && res.success) {
          gameView.classList.add('hidden');
          lobbyView.classList.remove('hidden');
        }
      });
    }
  });

  btnGoHome.addEventListener('click', () => {
    window.location.href = '/';
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

  // ── Menu Logic ──
  btnShowMenu.addEventListener('click', () => {
    gameMenuModal.classList.add('active');
    sfx.buttonClick();
  });

  btnResumeGame.addEventListener('click', () => {
    gameMenuModal.classList.remove('active');
    sfx.buttonClick();
  });

  btnRestartGame.addEventListener('click', () => {
    showConfirm(
      'Restart Game?',
      'This will clear all hands and reshuffle the deck. All players will remain in the room.',
      () => {
        socket.emit('new-game', (res) => {
          if (res.error) showToast(res.error, 'error');
          gameMenuModal.classList.remove('active');
        });
      }
    );
  });

  btnCloseRoom.addEventListener('click', () => {
    showConfirm(
      'Close Room?',
      'This will kick all players and delete the room. All progress will be lost.',
      () => {
        socket.emit('close-room', (res) => {
          if (res.error) {
            showToast(res.error, 'error');
          } else {
            window.location.href = '/';
          }
        });
      }
    );
  });

  btnLeaveGame.addEventListener('click', () => {
    showConfirm(
      'Leave Session?',
      'Are you sure you want to exit this console view?',
      () => {
        window.location.href = '/';
      }
    );
  });

  // ── Confirm Modal Logic ──
  function showConfirm(title, message, onYes) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmCallback = onYes;
    confirmModal.classList.add('active');
    sfx.error();
  }

  btnConfirmYes.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    confirmModal.classList.remove('active');
    sfx.buttonClick();
  });

  btnConfirmNo.addEventListener('click', () => {
    confirmCallback = null;
    confirmModal.classList.remove('active');
    sfx.buttonClick();
  });

  // ── Start ──
  init();
})();
