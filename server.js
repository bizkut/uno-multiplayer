/**
 * UNO Multiplayer Server
 * Express + Socket.IO — handles all game logic server-side.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const UnoGame = require('./public/js/game-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? false  // same-origin only in production
      : '*',
  },
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
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      code += chars[bytes[i] % chars.length];
    }
    attempts++;
    if (attempts > 100) throw new Error('Cannot generate unique room code');
  } while (rooms.has(code));
  return code;
}

function sanitize(str, maxLen = 16) {
  if (typeof str !== 'string') return '';
  // Strip HTML-significant chars and control characters
  return str
    .replace(/[<>&"']/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLen);
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

  // Pre-build public player data (hands hidden)
  const publicPlayers = fullState.players.map(p => ({
    ...p,
    hand: undefined,
  }));

  // Send per-player state — each client only sees their own hand
  roomData.sockets.forEach((info, socketId) => {
    // Find this player's actual hand from the fullState
    const myPlayer = fullState.players.find(p => p.id === info.playerId);
    const state = {
      ...fullState,
      players: publicPlayers.map(p =>
        p.id === info.playerId
          ? { ...p, hand: myPlayer?.hand }
          : p
      ),
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

function getRoomContext(socket, callback) {
  const { roomCode, playerId } = socket.data;
  if (!roomCode || !playerId) {
    callback?.({ error: 'Not in a room or invalid session' });
    return null;
  }
  const roomData = rooms.get(roomCode);
  if (!roomData) {
    callback?.({ error: 'Room not found' });
    return null;
  }
  return { roomCode, playerId, roomData };
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
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
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
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    currentRoom = roomCode;

    if (role === 'player' && roomData.game.status === 'waiting') {
      const result = roomData.game.addPlayer(playerId, playerName);
      if (result.error) return callback({ error: result.error });
    }

    // Clean up stale socket entries for this playerId (e.g. from a reconnect)
    for (const [existingSocketId, existingInfo] of roomData.sockets) {
      if (existingInfo.playerId === playerId && existingSocketId !== socket.id) {
        roomData.sockets.delete(existingSocketId);
      }
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
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    // Only host can start
    if (playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can start the game' });
    }

    const result = roomData.game.startGame();
    if (result.error) return callback?.({ error: result.error });

    callback?.({ success: true });
    broadcastGameState(roomCode);
  });

  // ── Play Card ──
  socket.on('play-card', ({ cardId, chosenColor }, callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    if (typeof cardId !== 'number') return callback?.({ error: 'Invalid card ID' });

    const result = roomData.game.playCard(playerId, cardId, chosenColor);
    callback?.(result);

    if (result.success) {
      broadcastGameState(roomCode);
    }
  });

  // ── Draw Card ──
  socket.on('draw-card', (callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.drawCard(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Keep Drawn Card (don't play it) ──
  socket.on('keep-card', (callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.keepDrawnCard(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Call UNO ──
  socket.on('call-uno', (callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.callUno(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Catch UNO ──
  socket.on('catch-uno', ({ targetId }, callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    if (typeof targetId !== 'string') return callback?.({ error: 'Invalid target player ID' });

    const result = roomData.game.catchUno(playerId, targetId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── New Game (restart) ──
  socket.on('new-game', (callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    if (playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can restart' });
    }

    // Keep players, reset game
    const players = roomData.game.players.map(p => ({ id: p.id, name: p.name }));
    roomData.game = new UnoGame(roomCode);
    players.forEach(p => roomData.game.addPlayer(p.id, p.name));

    callback?.({ success: true });
    broadcastLobbyState(roomCode);
  });

  // ── Close Room ──
  socket.on('close-room', (callback) => {
    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    if (playerId !== roomData.host) {
      return callback?.({ error: 'Only the host can close the room' });
    }

    // Notify everyone
    io.to(`room-${roomCode}`).emit('room-closed');

    // Force all sockets to leave the channel
    const roomChannel = `room-${roomCode}`;
    io.in(roomChannel).socketsLeave(roomChannel);

    // Clean up
    rooms.delete(roomCode);
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
