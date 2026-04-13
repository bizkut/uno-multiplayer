/**
 * Landing Page Logic
 * Handles room creation/joining and navigation to player/console views.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  // ── State ──
  let selectedRole = 'player';

  // ── Elements ──
  const nameInput = $('#playerName');
  const roomInput = $('#roomCode');
  const btnCreate = $('#btnCreate');
  const btnJoin = $('#btnJoin');
  const roleToggle = $('#roleToggle');

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
    let id = localStorage.getItem('uno_player_id');
    if (!id) {
      id = 'p_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
      localStorage.setItem('uno_player_id', id);
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
    return name;
  }

  // ── Create Room ──
  btnCreate.addEventListener('click', () => {
    const name = validateName();
    if (!name) return;

    const session = {
      roomCode: null, // Server generates the room code
      playerName: name,
      playerId: getOrCreatePlayerId(),
      role: selectedRole,
      isHost: true,
    };
    localStorage.setItem('uno_session', JSON.stringify(session));

    const target = selectedRole === 'console' ? '/console.html' : '/player.html';
    window.location.href = target;
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

    const session = {
      roomCode: code,
      playerName: name,
      playerId: getOrCreatePlayerId(),
      role: selectedRole,
      isHost: false,
    };
    localStorage.setItem('uno_session', JSON.stringify(session));

    const target = selectedRole === 'console' ? '/console.html' : '/player.html';
    window.location.href = target;
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

  // ── Restore name from previous session ──
  const prev = localStorage.getItem('uno_session');
  if (prev) {
    try {
      const s = JSON.parse(prev);
      if (s.playerName) nameInput.value = s.playerName;
    } catch (e) {}
  }
})();
