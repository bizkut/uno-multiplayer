/**
 * UNO Multiplayer Server
 * Express + Socket.IO — handles all game logic server-side.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const UnoGame = require('./public/js/game-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const PORT = process.env.PORT || 3000;

// ── Static Files ──
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uno-cards', express.static(path.join(__dirname, 'uno-cards')));

// ── Room Management ──
// rooms: Map<roomCode, { game: UnoGame, host: socketId, sockets: Map<socketId, playerInfo> }>
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    attempts++;
    if (attempts > 100) throw new Error('Cannot generate unique room code');
  } while (rooms.has(code));
  return code;
}

function sanitize(str, maxLen = 16) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function broadcastLobbyState(roomCode) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return;

  const players = [];
  roomData.sockets.forEach((info) => {
    if (info.role === 'player') {
      players.push({ id: info.playerId, name: info.name });
    }
  });

  io.to(`room-${roomCode}`).emit('lobby-state', {
    roomCode,
    players,
    hostId: roomData.host,
  });
}

function broadcastGameState(roomCode) {
  const roomData = rooms.get(roomCode);
  if (!roomData || !roomData.game) return;

  const fullState = roomData.game.getState();

  // Send per-player state — each client only sees their own hand
  roomData.sockets.forEach((info, socketId) => {
    const state = {
      ...fullState,
      players: fullState.players.map(p => ({
        ...p,
        hand: p.id === info.playerId ? p.hand : undefined,
      })),
    };
    io.to(socketId).emit('game-state', state);
  });
}

function getPlayerIdBySocket(roomCode, socketId) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return null;
  const info = roomData.sockets.get(socketId);
  return info ? info.playerId : null;
}

// ── Clean up empty rooms periodically ──
setInterval(() => {
  for (const [code, roomData] of rooms) {
    if (roomData.sockets.size === 0) {
      rooms.delete(code);
    }
  }
}, 60000);

// ══════════════════════════════════════════════════
// Socket.IO Connection Handling
// ══════════════════════════════════════════════════
io.on('connection', (socket) => {
  let currentRoom = null;

  // ── Create Room ──
  socket.on('create-room', ({ playerName, playerId, role }, callback) => {
    playerName = sanitize(playerName, 16);
    playerId = sanitize(playerId, 64);
    role = ['player', 'console'].includes(role) ? role : 'player';
    if (!playerName || !playerId) return callback?.({ error: 'Invalid input' });

    const roomCode = generateRoomCode();
    const game = new UnoGame(roomCode);

    const roomData = {
      game,
      host: playerId,
      sockets: new Map(),
    };

    rooms.set(roomCode, roomData);
    socket.join(`room-${roomCode}`);
    currentRoom = roomCode;

    if (role === 'player') {
      game.addPlayer(playerId, playerName);
    }

    roomData.sockets.set(socket.id, { playerId, name: playerName, role });

    callback({ success: true, roomCode });
    broadcastLobbyState(roomCode);
  });

  // ── Join Room ──
  socket.on('join-room', ({ roomCode, playerName, playerId, role }, callback) => {
    playerName = sanitize(playerName, 16);
    playerId = sanitize(playerId, 64);
    role = ['player', 'console'].includes(role) ? role : 'player';
    if (!playerName || !playerId) return callback?.({ error: 'Invalid input' });
    roomCode = (roomCode || '').toUpperCase();
    const roomData = rooms.get(roomCode);

    if (!roomData) {
      return callback({ error: 'Room not found' });
    }

    socket.join(`room-${roomCode}`);
    currentRoom = roomCode;

    if (role === 'player' && roomData.game.status === 'waiting') {
      const result = roomData.game.addPlayer(playerId, playerName);
      if (result.error) return callback({ error: result.error });
    }

    roomData.sockets.set(socket.id, { playerId, name: playerName, role });
    callback({ success: true, roomCode });

    // Notify others
    socket.to(`room-${roomCode}`).emit('player-joined', { name: playerName, role });

    if (roomData.game.status === 'playing') {
      // Send current state to late joiner
      socket.emit('game-state', roomData.game.getState());
    } else {
      broadcastLobbyState(roomCode);
    }
  });

  // ── Start Game ──
  socket.on('start-game', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    // Only host can start
    const info = roomData.sockets.get(socket.id);
    if (!info || info.playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can start the game' });
    }

    const result = roomData.game.startGame();
    if (result.error) return callback?.({ error: result.error });

    callback?.({ success: true });
    broadcastGameState(currentRoom);
  });

  // ── Play Card ──
  socket.on('play-card', ({ cardId, chosenColor }, callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const playerId = getPlayerIdBySocket(currentRoom, socket.id);
    if (!playerId) return callback?.({ error: 'Player not found' });

    const result = roomData.game.playCard(playerId, cardId, chosenColor);
    callback?.(result);

    if (result.success || result.needsColor) {
      broadcastGameState(currentRoom);
    }
  });

  // ── Draw Card ──
  socket.on('draw-card', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const playerId = getPlayerIdBySocket(currentRoom, socket.id);
    if (!playerId) return callback?.({ error: 'Player not found' });

    const result = roomData.game.drawCard(playerId);
    callback?.(result);
    broadcastGameState(currentRoom);
  });

  // ── Keep Drawn Card (don't play it) ──
  socket.on('keep-card', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const playerId = getPlayerIdBySocket(currentRoom, socket.id);
    if (!playerId) return callback?.({ error: 'Player not found' });

    const result = roomData.game.keepDrawnCard(playerId);
    callback?.(result);
    broadcastGameState(currentRoom);
  });

  // ── Call UNO ──
  socket.on('call-uno', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const playerId = getPlayerIdBySocket(currentRoom, socket.id);
    if (!playerId) return callback?.({ error: 'Player not found' });

    const result = roomData.game.callUno(playerId);
    callback?.(result);
    broadcastGameState(currentRoom);
  });

  // ── Catch UNO ──
  socket.on('catch-uno', ({ targetId }, callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const playerId = getPlayerIdBySocket(currentRoom, socket.id);
    if (!playerId) return callback?.({ error: 'Player not found' });

    const result = roomData.game.catchUno(playerId, targetId);
    callback?.(result);
    broadcastGameState(currentRoom);
  });

  // ── New Game (restart) ──
  socket.on('new-game', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const info = roomData.sockets.get(socket.id);
    if (!info || info.playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can restart' });
    }

    // Keep players, reset game
    const players = roomData.game.players.map(p => ({ id: p.id, name: p.name }));
    roomData.game = new UnoGame(currentRoom);
    players.forEach(p => roomData.game.addPlayer(p.id, p.name));

    callback?.({ success: true });
    broadcastLobbyState(currentRoom);
  });

  // ── Close Room ──
  socket.on('close-room', (callback) => {
    if (!currentRoom) return callback?.({ error: 'Not in a room' });
    const roomData = rooms.get(currentRoom);
    if (!roomData) return callback?.({ error: 'Room not found' });

    const info = roomData.sockets.get(socket.id);
    if (!info || info.playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can close the room' });
    }

    // Notify everyone
    io.to(`room-${currentRoom}`).emit('room-closed');

    // Force all sockets to leave the channel
    const roomChannel = `room-${currentRoom}`;
    io.in(roomChannel).socketsLeave(roomChannel);

    // Clean up
    rooms.delete(currentRoom);
    callback?.({ success: true });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const roomData = rooms.get(currentRoom);
    if (!roomData) return;

    const info = roomData.sockets.get(socket.id);
    if (!info) return;

    roomData.sockets.delete(socket.id);

    if (info.role === 'player') {
      roomData.game.removePlayer(info.playerId);
      socket.to(`room-${currentRoom}`).emit('player-left', { name: info.name });
    }

    if (roomData.game.status === 'playing') {
      broadcastGameState(currentRoom);
    } else {
      broadcastLobbyState(currentRoom);
    }

    // Clean up empty rooms
    if (roomData.sockets.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

// ── Start ──
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  console.log(`\n  🎮 UNO Multiplayer Server`);
  console.log(`  ─────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
  console.log(`\n  Open the Network URL on mobile devices to play!\n`);
});
