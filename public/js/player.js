/**
 * Player Client (Socket.IO)
 * Connects to server, renders hand, sends game actions.
 * All game logic is server-side — this is purely UI.
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
  let socket = null;
  let gameState = null;
  let selectedCardId = null;
  let pendingWildCardId = null;
  let myHand = [];
  let isMyTurn = false;

  // ── Elements ──
  const lobbyView = $('#lobbyView');
  const gameView = $('#gameView');
  const lobbyRoomCode = $('#lobbyRoomCode');
  const lobbyPlayerList = $('#lobbyPlayerList');
  const btnStartGame = $('#btnStartGame');
  const handScroll = $('#handScroll');
  const handCount = $('#handCount');
  const discardPreview = $('#discardPreview');
  const headerColorIndicator = $('#headerColorIndicator');
  const centerColorIndicator = $('#centerColorIndicator');
  const colorLabel = $('#colorLabel');
  const turnIndicator = $('#turnIndicator');
  const directionIcon = $('#directionIcon');
  const unoAlertsArea = $('#unoAlertsArea');
  const deckCountLabel = $('#deckCountLabel');
  const drawStackBadge = $('#drawStackBadge');
  const btnDraw = $('#btnDraw');
  const btnUno = $('#btnUno');
  const colorPickerModal = $('#colorPickerModal');
  const drawnCardPrompt = $('#drawnCardPrompt');
  const drawnCardPreview = $('#drawnCardPreview');
  const btnPlayDrawn = $('#btnPlayDrawn');
  const btnKeepDrawn = $('#btnKeepDrawn');
  const gameRoomCode = $('#gameRoomCode');
  const gamePlayerName = $('#gamePlayerName');
  const winOverlay = $('#winOverlay');
  const winTitle = $('#winTitle');
  const winName = $('#winName');
  const btnNewGame = $('#btnNewGame');
  const btnGoHome = $('#btnGoHome');
  const btnCatchUno = $('#btnCatchUno');
  const catchUnoModal = $('#catchUnoModal');
  const catchPlayerList = $('#catchPlayerList');
  const btnCloseCatch = $('#btnCloseCatch');

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

  // ══════════════════════════════════════════════════
  // Initialize
  // ══════════════════════════════════════════════════

  function init() {
    gamePlayerName.textContent = playerName;

    if (isHost) {
      btnStartGame.classList.remove('hidden');
    } else {
      // Hide host-only buttons in menu
      $$('[data-host-only="true"]').forEach(el => el.classList.add('hidden'));
    }

    socket = io();

    socket.on('connect', () => {
      if (isHost) {
        socket.emit('create-room', { playerName, playerId, role: 'player' }, (res) => {
          if (res.success) {
            roomCode = res.roomCode;
            session.roomCode = roomCode;
            localStorage.setItem('uno_session', JSON.stringify(session));
            lobbyRoomCode.textContent = roomCode;
            gameRoomCode.textContent = roomCode;
          } else {
            showToast(res.error || 'Failed to create room', 'error');
          }
        });
      } else {
        lobbyRoomCode.textContent = roomCode;
        gameRoomCode.textContent = roomCode;
        socket.emit('join-room', { roomCode, playerName, playerId, role: 'player' }, (res) => {
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

    socket.on('reconnect', () => {
      showToast('Reconnected!', 'success');
    });

    // ── Server Events ──
    socket.on('lobby-state', onLobbyState);
    socket.on('game-state', onGameState);
    socket.on('player-joined', (data) => {
      showToast(`${data.name} joined!`, 'success');
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
    gameRoomCode.textContent = data.roomCode;
    roomCode = data.roomCode;

    lobbyPlayerList.innerHTML = '';
    (data.players || []).forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.id === data.hostId) {
        li.innerHTML += ' <span class="host-badge">HOST</span>';
      }
      if (p.id === playerId) {
        li.style.color = 'var(--uno-green)';
        li.style.fontWeight = '700';
      }
      lobbyPlayerList.appendChild(li);
    });
  }

  function onGameState(state) {
    gameState = state;

    // Switch to game view
    if (state.status === 'playing' || state.status === 'finished') {
      lobbyView.classList.add('hidden');
      gameView.classList.remove('hidden');
    }

    // Find my player data
    const me = state.players.find(p => p.id === playerId);
    if (me) {
      myHand = me.hand || [];
    }

    // Am I the current player?
    const currentPlayer = state.players[state.currentPlayerIndex];
    const wasMyTurn = isMyTurn;
    isMyTurn = currentPlayer && currentPlayer.id === playerId;

    // Turn notification
    if (isMyTurn && !wasMyTurn) {
      sfx.yourTurn();
      vibrate(200);
      showToast("Your turn! 🎯", 'success');
    }

    // Update UI
    updateTurnIndicator(state);
    updateDiscard(state);
    updateColorIndicator(state);
    updateDeckCount(state);
    updateDrawStack(state);
    updateDirection(state);
    updateUnoAlerts(state);
    renderHand();
    updateActionButtons();
    checkDrawnCardPrompt();

    // Game over
    if (state.status === 'finished' && state.winner) {
      showWinScreen(state.winner);
    }

    // Your turn glow
    gameView.classList.toggle('my-turn', isMyTurn);
  }

  // ══════════════════════════════════════════════════
  // UI UPDATES
  // ══════════════════════════════════════════════════

  function updateTurnIndicator(state) {
    const current = state.players[state.currentPlayerIndex];
    if (!current) return;
    if (isMyTurn) {
      turnIndicator.innerHTML = '<span class="your-turn-label">YOUR TURN</span>';
    } else {
      turnIndicator.textContent = `${current.name}'s turn`;
    }
  }

  function updateDiscard(state) {
    if (!state.discardTop) return;
    discardPreview.innerHTML = `<img class="card-img card-play-anim" src="${CARD_BASE}${state.discardTop.image}" alt="${state.discardTop.color} ${state.discardTop.value}">`;
  }

  function updateColorIndicator(state) {
    headerColorIndicator.setAttribute('data-color', state.currentColor || '');
    centerColorIndicator.setAttribute('data-color', state.currentColor || '');
    colorLabel.textContent = state.currentColor || '';
  }

  function updateDeckCount(state) {
    deckCountLabel.textContent = state.deckCount;
  }

  function updateDrawStack(state) {
    if (state.drawStack > 0) {
      drawStackBadge.textContent = `Must Draw ${state.drawStack}`;
      drawStackBadge.classList.remove('hidden');
    } else {
      drawStackBadge.classList.add('hidden');
    }
  }

  function updateDirection(state) {
    directionIcon.textContent = state.direction === 1 ? '↻' : '↺';
  }

  function updateUnoAlerts(state) {
    const me = state.players.find(p => p.id === playerId);
    if (me) {
      // Is it urgent to call UNO? (1 or 2 cards and not called)
      const isUrgent = me.cardCount <= 2 && !me.calledUno;
      btnUno.classList.toggle('pulsing', me.cardCount <= 2);
      btnUno.classList.toggle('urgent', isUrgent);
    }

    // Build alerts for others
    unoAlertsArea.innerHTML = '';
    state.players.forEach(p => {
      if (p.id === playerId) return;

      if (p.calledUno && p.cardCount === 1) {
        addUnoBadge(p.name, 'Declared UNO! ✅', 'success');
      } else if (p.cardCount === 1) {
        addUnoBadge(p.name, 'HAS 1 CARD! ⚠️', 'warning');
      }
    });
  }

  function addUnoBadge(name, text, type) {
    const badge = document.createElement('div');
    badge.className = `uno-alert-badge ${type}`;
    badge.innerHTML = `<strong>${name}</strong> ${text}`;
    unoAlertsArea.appendChild(badge);
  }

  function renderHand() {
    handScroll.innerHTML = '';

    myHand.forEach(card => {
      const div = document.createElement('div');
      div.className = 'hand-card';
      div.dataset.cardId = card.id;

      const playable = isMyTurn && isCardPlayable(card);
      div.classList.toggle('playable', playable);
      div.classList.toggle('not-playable', isMyTurn && !playable);

      if (selectedCardId === card.id) {
        div.classList.add('selected');
      }

      const img = document.createElement('img');
      img.src = `${CARD_BASE}${card.image}`;
      img.alt = `${card.color} ${card.value}`;
      img.loading = 'lazy';
      div.appendChild(img);

      div.addEventListener('click', () => onCardTap(card, playable));
      handScroll.appendChild(div);
    });

    handCount.textContent = `${myHand.length} card${myHand.length !== 1 ? 's' : ''}`;
  }

  function isCardPlayable(card) {
    if (!gameState) return false;
    if (gameState.drawStack > 0) {
      const topCard = gameState.discardTop;
      return (card.value === 'Draw_2' && topCard.value === 'Draw_2') ||
        card.value === 'Wild_Draw_4';
    }
    if (card.color === 'Wild') return true;
    if (card.color === gameState.currentColor) return true;
    if (gameState.discardTop && card.value === gameState.discardTop.value) return true;
    return false;
  }

  function updateActionButtons() {
    btnDraw.disabled = !isMyTurn;
    const shouldShowUno = myHand.length <= 2;
    btnUno.style.opacity = shouldShowUno ? '1' : '0.3';
  }

  function checkDrawnCardPrompt() {
    if (gameState && gameState.pendingDrawPlayerId === playerId) {
      const drawnCard = myHand[myHand.length - 1];
      if (drawnCard) {
        drawnCardPreview.innerHTML = `<img class="card-img" src="${CARD_BASE}${drawnCard.image}" alt="" style="width:60px; height:90px; border-radius:6px;">`;
        drawnCardPrompt.classList.add('active');
      }
    } else {
      drawnCardPrompt.classList.remove('active');
    }
  }

  // ══════════════════════════════════════════════════
  // CARD INTERACTION
  // ══════════════════════════════════════════════════

  function onCardTap(card, playable) {
    sfx.buttonClick();

    if (!isMyTurn) {
      showToast("Not your turn!", 'error');
      return;
    }

    if (!playable) {
      showToast("Can't play this card", 'error');
      sfx.error();
      return;
    }

    if (selectedCardId === card.id) {
      playSelectedCard(card);
    } else {
      selectedCardId = card.id;
      renderHand();
      vibrate(30);
    }
  }

  function playSelectedCard(card) {
    if (card.color === 'Wild') {
      pendingWildCardId = card.id;
      colorPickerModal.classList.add('active');
      return;
    }

    socket.emit('play-card', { cardId: card.id });
    selectedCardId = null;
    sfx.cardPlay();
    vibrate(50);
  }

  // ── Draw ──
  btnDraw.addEventListener('click', () => {
    if (!isMyTurn) return;
    sfx.cardDraw();
    vibrate(50);
    socket.emit('draw-card');
  });

  // ── UNO ──
  btnUno.addEventListener('click', () => {
    sfx.unoCall();
    vibrate([100, 50, 100]);
    socket.emit('call-uno');
  });

  // ── Catch UNO ──
  btnCatchUno.addEventListener('click', () => {
    if (!gameState) return;

    catchPlayerList.innerHTML = '';
    const catchable = gameState.players.filter(p =>
      p.id !== playerId && p.cardCount === 1 && !p.calledUno
    );

    if (catchable.length === 0) {
      showToast('No one to catch!', 'error');
      return;
    }

    catchable.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-block';
      btn.textContent = `Catch ${p.name}!`;
      btn.addEventListener('click', () => {
        socket.emit('catch-uno', { targetId: p.id });
        catchUnoModal.classList.remove('active');
        sfx.unoCall();
      });
      catchPlayerList.appendChild(btn);
    });

    catchUnoModal.classList.add('active');
  });

  btnCloseCatch.addEventListener('click', () => {
    catchUnoModal.classList.remove('active');
  });

  // ── Color Picker ──
  $$('.color-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      colorPickerModal.classList.remove('active');

      if (pendingWildCardId !== null) {
        socket.emit('play-card', { cardId: pendingWildCardId, chosenColor: color });
        pendingWildCardId = null;
        selectedCardId = null;
        sfx.cardPlay();
        vibrate(50);
      }
    });
  });

  // ── Drawn card prompt ──
  btnPlayDrawn.addEventListener('click', () => {
    if (!gameState || !gameState.pendingDrawPlayerId) return;
    const drawnCard = myHand[myHand.length - 1];
    if (!drawnCard) return;

    if (drawnCard.color === 'Wild') {
      pendingWildCardId = drawnCard.id;
      drawnCardPrompt.classList.remove('active');
      colorPickerModal.classList.add('active');
    } else {
      socket.emit('play-card', { cardId: drawnCard.id });
      drawnCardPrompt.classList.remove('active');
      sfx.cardPlay();
    }
  });

  btnKeepDrawn.addEventListener('click', () => {
    socket.emit('keep-card');
    drawnCardPrompt.classList.remove('active');
    sfx.buttonClick();
  });

  // ── Start Game ──
  btnStartGame.addEventListener('click', () => {
    if (!isHost) return;
    sfx.buttonClick();
    socket.emit('start-game', (res) => {
      if (res && res.error) {
        showToast(res.error, 'error');
      }
    });
  });

  // ── New Game ──
  btnNewGame.addEventListener('click', () => {
    winOverlay.classList.remove('active');
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

  // ── Win Screen ──
  function showWinScreen(winner) {
    winTitle.textContent = winner.id === playerId ? 'YOU WIN! 🎉' : 'GAME OVER';
    winName.textContent = winner.name + ' wins!';
    winOverlay.classList.add('active');
    
    // Only the host should see the restart button
    if (isHost) {
      btnNewGame.classList.remove('hidden');
    } else {
      btnNewGame.classList.add('hidden');
    }

    sfx.win();
    vibrate([200, 100, 200, 100, 400]);
  }

  // ── Utilities ──
  function showToast(message, type = '') {
    const container = $('#toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'toastOut 0.3s ease-out forwards';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  // ── Sound init on first interaction ──
  document.addEventListener('click', () => sfx.init(), { once: true });
  document.addEventListener('touchstart', () => sfx.init(), { once: true });

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
      'This will clear all hands and reshuffle the deck. The same players will stay in the room.',
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
      'Leave Game?',
      'Are you sure you want to leave this session?',
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
    sfx.error(); // Use error sound for warnings
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
