/**
 * Landing Page Logic
 * Handles room creation/joining and navigation to player/console views.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const CONFIG = {
    PLAYER_URL: '/player.html',
    CONSOLE_URL: '/console.html',
    MAX_NAME_LEN: 16,
    SESSION_KEY: 'uno_session',
    PLAYER_ID_KEY: 'uno_player_id'
  };

  // ── State ──
  let selectedRole = 'player';

  // ── Elements ──
  const nameInput = $('#playerName');
  const roomInput = $('#roomCode');
  const btnCreate = $('#btnCreate');
  const btnJoin = $('#btnJoin');
  const roleToggle = $('#roleToggle');
  const rejoinSection = $('#rejoinSection');
  const rejoinText = $('#rejoinText');
  const btnRejoin = $('#btnRejoin');

  // ── Role Toggle ──
  roleToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-toggle-btn');
    if (!btn) return;
    roleToggle.querySelectorAll('.role-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRole = btn.dataset.role;
  });

  // ── Generate Player ID ──
  function getOrCreatePlayerId() {
    let id = localStorage.getItem(CONFIG.PLAYER_ID_KEY);
    if (!id) {
      // Use crypto.randomUUID if available, else fallback to robust random string
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : 'p_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
      localStorage.setItem(CONFIG.PLAYER_ID_KEY, id);
    }
    return id;
  }

  // ── Validation ──
  function validateName() {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Please enter your name', 'error');
      nameInput.focus();
      return null;
    }
    return name.slice(0, CONFIG.MAX_NAME_LEN);
  }

  // ── Navigation ──
  function navigateToGame(session) {
    localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
    const target = session.role === 'console' ? CONFIG.CONSOLE_URL : CONFIG.PLAYER_URL;
    window.location.href = target;
  }

  // ── Create Room ──
  btnCreate.addEventListener('click', () => {
    const name = validateName();
    if (!name) return;

    navigateToGame({
      roomCode: null, // Server generates the room code
      playerName: name,
      playerId: getOrCreatePlayerId(),
      role: selectedRole,
      isHost: true,
    });
  });

  // ── Join Room ──
  btnJoin.addEventListener('click', () => {
    const name = validateName();
    if (!name) return;

    const code = roomInput.value.trim().toUpperCase();
    if (!code || code.length !== 4) {
      showToast('Enter a 4-character room code', 'error');
      roomInput.focus();
      return;
    }

    navigateToGame({
      roomCode: code,
      playerName: name,
      playerId: getOrCreatePlayerId(),
      role: selectedRole,
      isHost: false,
    });
  });

  // ── Room code input: auto uppercase ──
  roomInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ── Enter key support ──
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (roomInput.value.trim().length === 4) {
        btnJoin.click();
      }
    }
  });

  // ── Toast ──
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

  // ── Restore session & Rejoin logic ──
  function checkRecentSession() {
    const prev = localStorage.getItem(CONFIG.SESSION_KEY);
    if (!prev) return;

    try {
      const s = JSON.parse(prev);
      if (s.playerName) nameInput.value = s.playerName;

      // Show rejoin button if there's a recent room code
      if (s.roomCode) {
        rejoinSection.classList.remove('hidden');
        rejoinText.textContent = `Room ${s.roomCode}`;

        btnRejoin.addEventListener('click', () => {
          const name = validateName();
          if (!name) return;

          s.playerName = name;
          // Keep s.isHost as it was originally saved
          navigateToGame(s);
        }, { once: true });
      }
    } catch (e) {
      console.error('Failed to parse session', e);
      localStorage.removeItem(CONFIG.SESSION_KEY);
    }
  }

  checkRecentSession();
})();
