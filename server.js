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
      : process.env.CORS_ORIGIN || false, // explicit allowlist in dev; no wildcard
  },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const PORT = process.env.PORT || 3000;

// ── Static Files ──
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uno-cards', express.static(path.join(__dirname, 'uno-cards')));

// ── Room Management ──
// rooms: Map<roomCode, { game: UnoGame, host: playerId, sockets: Map<socketId, playerInfo> }>
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
  // Strip HTML-significant chars, backticks, control characters,
  // javascript: URIs, and inline event handlers
  return str
    .replace(/[<>&"'`]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .slice(0, maxLen);
}

// ── Rate Limiting ──
const socketRateLimits = new Map(); // socketId -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 20;

function checkRateLimit(socketId) {
  const now = Date.now();
  let entry = socketRateLimits.get(socketId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    socketRateLimits.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_EVENTS;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Broadcast helpers ──
// SECURITY: Never expose internal playerIds to clients.
// Use isYou/isHost flags and array indices instead.

function broadcastLobbyState(roomCode) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return;

  // Build player list WITHOUT playerIds
  const players = [];
  const playerIdToIndex = new Map();

  roomData.sockets.forEach((info) => {
    if (info.role === 'player') {
      const idx = players.length;
      playerIdToIndex.set(info.playerId, idx);
      players.push({ name: info.name, isHost: info.playerId === roomData.host });
    }
  });

  // Send per-socket so each client gets their own yourIndex
  roomData.sockets.forEach((info, socketId) => {
    io.to(socketId).emit('lobby-state', {
      roomCode,
      players,
      yourIndex: playerIdToIndex.has(info.playerId) ? playerIdToIndex.get(info.playerId) : -1,
    });
  });
}

function broadcastGameState(roomCode) {
  const roomData = rooms.get(roomCode);
  if (!roomData || !roomData.game) return;

  const fullState = roomData.game.getState();

  // Send per-player state — each client only sees their own hand
  // SECURITY: Strip all playerIds from broadcast data
  roomData.sockets.forEach((info, socketId) => {
    const myPlayer = fullState.players.find(p => p.id === info.playerId);

    const state = {
      roomCode: fullState.roomCode,
      discardTop: fullState.discardTop,
      currentPlayerIndex: fullState.currentPlayerIndex,
      currentPlayerName: fullState.currentPlayerName,
      direction: fullState.direction,
      currentColor: fullState.currentColor,
      status: fullState.status,
      deckCount: fullState.deckCount,
      drawStack: fullState.drawStack,
      eventLog: fullState.eventLog,
      // Replace pendingDrawPlayerId with a boolean flag
      pendingDrawIsYou: fullState.pendingDrawPlayerId === info.playerId,
      // Replace winner id with isYou flag
      winner: fullState.winner
        ? { name: fullState.winner.name, isYou: fullState.winner.id === info.playerId }
        : null,
      // Strip playerIds, add isYou flags, hide other hands
      players: fullState.players.map(p => ({
        name: p.name,
        cardCount: p.cardCount,
        calledUno: p.calledUno,
        isYou: p.id === info.playerId,
        hand: p.id === info.playerId ? myPlayer?.hand : undefined,
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
  // Clean up stale rate limit entries
  const now = Date.now();
  for (const [id, entry] of socketRateLimits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 10) {
      socketRateLimits.delete(id);
    }
  }
}, 60000);

// ══════════════════════════════════════════════════
// Socket.IO Connection Handling
// ══════════════════════════════════════════════════
io.on('connection', (socket) => {
  let currentRoom = null;

  // Rate-limit wrapper
  function rateLimited(callback) {
    if (!checkRateLimit(socket.id)) {
      return () => {
        const cb = arguments[arguments.length - 1];
        if (typeof cb === 'function') cb({ error: 'Rate limited — slow down' });
      };
    }
    return callback;
  }

  // ── Create Room ──
  socket.on('create-room', ({ playerName, playerId, role }, callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    playerName = sanitize(playerName, 16);
    playerId = sanitize(playerId, 64);
    role = ['player', 'console'].includes(role) ? role : 'player';
    if (!playerName || !playerId) return callback?.({ error: 'Invalid input' });

    const roomCode = generateRoomCode();
    const game = new UnoGame(roomCode);
    const sessionToken = generateSessionToken();

    const roomData = {
      game,
      host: playerId,
      sockets: new Map(),
    };

    rooms.set(roomCode, roomData);
    socket.join(`room-${roomCode}`);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    socket.data.sessionToken = sessionToken;
    currentRoom = roomCode;

    if (role === 'player') {
      game.addPlayer(playerId, playerName);
    }

    roomData.sockets.set(socket.id, { playerId, name: playerName, role, sessionToken });

    // Return sessionToken to client — this is their auth credential
    callback({ success: true, roomCode, sessionToken });
    broadcastLobbyState(roomCode);
  });

  // ── Join Room ──
  socket.on('join-room', ({ roomCode, playerName, playerId, role, sessionToken: clientToken }, callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    playerName = sanitize(playerName, 16);
    playerId = sanitize(playerId, 64);
    role = ['player', 'console'].includes(role) ? role : 'player';
    if (!playerName || !playerId) return callback?.({ error: 'Invalid input' });
    roomCode = (roomCode || '').toUpperCase();
    const roomData = rooms.get(roomCode);

    if (!roomData) {
      return callback({ error: 'Room not found' });
    }

    // SECURITY: Check if this playerId already exists (reconnection attempt)
    let existingEntry = null;
    for (const [existingSocketId, existingInfo] of roomData.sockets) {
      if (existingInfo.playerId === playerId && existingSocketId !== socket.id) {
        existingEntry = { socketId: existingSocketId, info: existingInfo };
        break;
      }
    }

    let sessionToken;

    if (existingEntry) {
      // Reconnection: REQUIRE valid session token
      if (!clientToken || clientToken !== existingEntry.info.sessionToken) {
        return callback({ error: 'Invalid session — cannot reconnect as this player' });
      }
      // Token verified — safe to replace the old socket
      sessionToken = existingEntry.info.sessionToken;
      roomData.sockets.delete(existingEntry.socketId);
    } else {
      // New player joining
      sessionToken = generateSessionToken();

      if (role === 'player' && roomData.game.status === 'waiting') {
        const result = roomData.game.addPlayer(playerId, playerName);
        if (result.error) return callback({ error: result.error });
      }
    }

    socket.join(`room-${roomCode}`);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    socket.data.sessionToken = sessionToken;
    currentRoom = roomCode;

    roomData.sockets.set(socket.id, { playerId, name: playerName, role, sessionToken });
    callback({ success: true, roomCode, sessionToken });

    // Notify others
    socket.to(`room-${roomCode}`).emit('player-joined', { name: playerName, role });

    if (roomData.game.status === 'playing') {
      // Send current state to late joiner (via broadcastGameState which is per-socket)
      broadcastGameState(roomCode);
    } else {
      broadcastLobbyState(roomCode);
    }
  });

  // ── Start Game ──
  socket.on('start-game', (callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

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
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

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
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.drawCard(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Keep Drawn Card (don't play it) ──
  socket.on('keep-card', (callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.keepDrawnCard(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Call UNO ──
  socket.on('call-uno', (callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    const result = roomData.game.callUno(playerId);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── Catch UNO ──
  // SECURITY: Uses player array index instead of playerId to identify target
  socket.on('catch-uno', ({ targetIndex }, callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

    const context = getRoomContext(socket, callback);
    if (!context) return;
    const { roomCode, playerId, roomData } = context;

    if (typeof targetIndex !== 'number') return callback?.({ error: 'Invalid target' });

    // Resolve index to internal playerId
    const targetPlayer = roomData.game.players[targetIndex];
    if (!targetPlayer) return callback?.({ error: 'Invalid target player' });

    const result = roomData.game.catchUno(playerId, targetPlayer.id);
    callback?.(result);
    broadcastGameState(roomCode);
  });

  // ── New Game (restart) ──
  socket.on('new-game', (callback) => {
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

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
    if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limited' });

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
    socketRateLimits.delete(socket.id);

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
