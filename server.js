const WebSocket = require('ws');
const http = require('http');
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 8080;

if (!MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is not set.');
  process.exit(1);
}

let db;

// ─── HTTP SERVER (Render free tier requires an HTTP port to stay alive) ───────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Forum WebSocket Server OK\n');
});

// ─── WEBSOCKET SERVER (attached to HTTP server) ───────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

// ─── ONLINE USER TRACKING ─────────────────────────────────────────────────────
const onlineClients = new Map(); // ws -> { username, lastSeen }

function broadcastOnlineCount() {
  const count = onlineClients.size;
  const msg = JSON.stringify({ type: 'online_count', count });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── CHAT HISTORY (last 100 messages in memory) ──────────────────────────────
const chatHistory = [];
const gameRooms = new Map();
const MAX_CHAT_HISTORY = 100;

// Prune stale clients every 30s (missed 2 heartbeats)
setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of onlineClients.entries()) {
    if (now - info.lastSeen > 40000) {
      onlineClients.delete(ws);
    }
  }
  broadcastOnlineCount();
}, 30000);

// ─── MONGODB ──────────────────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('forum_db');
  console.log('[DB] Connected to MongoDB');

  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('users').createIndex({ permId: 1 }, { unique: true });
  await db.collection('posts').createIndex({ createdAt: -1 });
  await db.collection('posts').createIndex({ likes: -1 });
}

// ─── GAME HELPERS ─────────────────────────────────────────────────────────────
function startGameRound(room) {
  room.currentRound++;
  if (room.currentRound > room.totalRounds) {
    room.state = 'finished';
    room.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'game_game_over',
          payload: { finalPlayers: room.players.map(pl => ({ name: pl.name, score: pl.score })) }
        }));
      }
    });
    gameRooms.delete(room.code);
    return;
  }

  room.state = 'making';
  room.currentMakerIndex = (room.currentRound - 1) % room.players.length;
  room.currentWord = room.wordList[room.currentRound - 1] || 'MYSTERY';
  room.currentEmojis = '';
  room.correctGuessers = new Set();

  const makerName = room.players[room.currentMakerIndex].name;

  room.players.forEach(p => {
    if (p.ws.readyState !== WebSocket.OPEN) return;
    p.ws.send(JSON.stringify({
      type: 'game_round_start',
      payload: {
        round: room.currentRound,
        makerIndex: room.currentMakerIndex,
        word: p.name === makerName ? room.currentWord : undefined,
      }
    }));
  });

  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.state === 'making') endGameRound(room, null);
  }, 70000);
}

function endGameRound(room, winnerName) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  room.state = 'reveal';

  const scores = {};
  room.players.forEach(p => { scores[p.name] = p.score; });

  room.players.forEach(p => {
    if (p.ws.readyState !== WebSocket.OPEN) return;
    p.ws.send(JSON.stringify({
      type: 'game_round_end',
      payload: { winner: winnerName, word: room.currentWord, scores }
    }));
  });

  setTimeout(() => startGameRound(room), 6000);
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
async function handleMessage(ws, message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  const { type, payload, reqId } = parsed;

  const reply = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...data, reqId }));
    }
  };

  const broadcast = (data, excludeWs) => {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
        client.send(JSON.stringify(data));
      }
    });
  };

  try {
    switch (type) {

      case 'check_username': {
        const { username } = payload;
        const existing = await db.collection('users').findOne({ username: username.toLowerCase() });
        reply({ type: 'check_username_result', inUse: !!existing });
        break;
      }

      case 'register_user': {
        const { username, permId } = payload;
        const existing = await db.collection('users').findOne({ username: username.toLowerCase() });
        if (existing) {
          reply({ type: 'register_result', success: false, reason: 'USERNAME_TAKEN' });
          return;
        }
        await db.collection('users').insertOne({
          username: username.toLowerCase(),
          displayUsername: username,
          permId,
          createdAt: new Date()
        });
        reply({ type: 'register_result', success: true });
        break;
      }

      case 'verify_user': {
        const { username, permId } = payload;
        const user = await db.collection('users').findOne({ permId });
        if (!user) {
          reply({ type: 'verify_result', valid: false, reason: 'PERM_ID_NOT_FOUND' });
          return;
        }
        if (user.username !== username.toLowerCase()) {
          reply({ type: 'verify_result', valid: false, reason: 'USERNAME_MISMATCH' });
          return;
        }
        reply({ type: 'verify_result', valid: true, displayUsername: user.displayUsername });
        break;
      }

      case 'get_posts': {
        const { sort = 'newest' } = payload || {};
        let sortQuery = { createdAt: -1 };
        if (sort === 'popular') sortQuery = { likes: -1 };
        if (sort === 'oldest') sortQuery = { createdAt: 1 };
        const posts = await db.collection('posts').find({}).sort(sortQuery).toArray();
        reply({ type: 'posts_list', posts });
        break;
      }

      case 'create_post': {
        const { title, content, authorUsername, authorPermId } = payload;
        const user = await db.collection('users').findOne({ permId: authorPermId });
        if (!user || user.username !== authorUsername.toLowerCase()) {
          reply({ type: 'create_post_result', success: false, reason: 'AUTH_FAILED' });
          return;
        }
        const post = {
          title,
          content,
          author: user.displayUsername,
          likes: 0,
          likedBy: [],
          comments: [],
          createdAt: new Date()
        };
        const result = await db.collection('posts').insertOne(post);
        post._id = result.insertedId;
        reply({ type: 'create_post_result', success: true, post });
        broadcast({ type: 'new_post', post }, ws);
        break;
      }

      case 'get_post': {
        const { postId } = payload;
        let post = null;
        try {
          post = await db.collection('posts').findOne({ _id: new ObjectId(postId) });
        } catch { /* invalid id */ }
        reply({ type: 'post_detail', post });
        break;
      }

      case 'like_post': {
        const { postId, permId, username } = payload;
        const user = await db.collection('users').findOne({ permId });
        if (!user || user.username !== username.toLowerCase()) {
          reply({ type: 'like_result', success: false, reason: 'AUTH_FAILED' });
          return;
        }
        let post = null;
        try {
          post = await db.collection('posts').findOne({ _id: new ObjectId(postId) });
        } catch {
          reply({ type: 'like_result', success: false, reason: 'INVALID_ID' });
          return;
        }
        if (!post) {
          reply({ type: 'like_result', success: false, reason: 'POST_NOT_FOUND' });
          return;
        }
        const alreadyLiked = (post.likedBy || []).includes(permId);
        const update = alreadyLiked
          ? { $inc: { likes: -1 }, $pull: { likedBy: permId } }
          : { $inc: { likes: 1 }, $push: { likedBy: permId } };
        await db.collection('posts').updateOne({ _id: new ObjectId(postId) }, update);
        const newLikes = alreadyLiked ? post.likes - 1 : post.likes + 1;
        reply({ type: 'like_result', success: true, postId, likes: newLikes, liked: !alreadyLiked });
        broadcast({ type: 'post_likes_updated', postId, likes: newLikes }, ws);
        break;
      }

      case 'add_comment': {
        const { postId, content, authorUsername, authorPermId } = payload;
        const user = await db.collection('users').findOne({ permId: authorPermId });
        if (!user || user.username !== authorUsername.toLowerCase()) {
          reply({ type: 'add_comment_result', success: false, reason: 'AUTH_FAILED' });
          return;
        }
        const comment = {
          id: new ObjectId().toString(),
          content,
          author: user.displayUsername,
          createdAt: new Date()
        };
        try {
          await db.collection('posts').updateOne(
            { _id: new ObjectId(postId) },
            { $push: { comments: comment } }
          );
        } catch {
          reply({ type: 'add_comment_result', success: false, reason: 'INVALID_ID' });
          return;
        }
        reply({ type: 'add_comment_result', success: true, comment });
        broadcast({ type: 'new_comment', postId, comment }, ws);
        break;
      }

      case 'get_chat_history': {
        reply({ type: 'chat_history', messages: chatHistory });
        break;
      }

      case 'chat_message': {
        const { text, author } = payload;
        if (!text || !text.trim() || !author) break;

        // Verify sender is logged in
        const chatUser = await db.collection('users').findOne({ displayUsername: author });
        if (!chatUser) break;

        const msg = {
          author,
          text: text.trim().slice(0, 300),
          ts: new Date().toISOString()
        };

        // Store in memory history
        chatHistory.push(msg);
        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

        // Broadcast to ALL clients including sender
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'chat_message', ...msg }));
          }
        });
        break;
      }

      case 'heartbeat': {
        onlineClients.set(ws, { username: payload.username, lastSeen: Date.now() });
        broadcastOnlineCount();
        reply({ type: 'heartbeat_ack', count: onlineClients.size });
        break;
      }

         case 'game_join': {
        const { roomCode, player: pName } = payload;
        if (!roomCode || !pName) break;

        let room = gameRooms.get(roomCode);
        if (!room) {
          room = {
            code: roomCode,
            players: [],
            state: 'waiting',
            currentRound: 0,
            totalRounds: 0,
            wordList: [],
            currentMakerIndex: 0,
            currentWord: '',
            currentEmojis: '',
            correctGuessers: new Set(),
            roundTimer: null,
          };
          gameRooms.set(roomCode, room);
        }

        if (!room.players.find(p => p.name === pName)) {
          room.players.push({ ws, name: pName, score: 0 });
          room.players.forEach(p => {
            if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({
                type: 'game_player_joined',
                payload: { player: pName }
              }));
            }
          });
        }
        reply({ type: 'game_join_ack', roomCode });
        break;
      }

      case 'game_start_game': {
        const { roomCode, totalRounds: tr, wordList } = payload;
        const room = gameRooms.get(roomCode);
        if (!room || room.state !== 'waiting') break;

        room.totalRounds = tr;
        room.wordList = wordList;
        room.currentRound = 0;
        room.state = 'making';

        room.players.forEach(p => {
          if (p.ws.readyState !== WebSocket.OPEN) return;
          p.ws.send(JSON.stringify({
            type: 'game_game_started',
            payload: {
              totalRounds: tr,
              players: room.players.map(pl => ({ name: pl.name, score: 0 }))
            }
          }));
        });

        startGameRound(room);
        break;
      }

      case 'game_emoji_locked': {
        const { roomCode, emojis } = payload;
        const room = gameRooms.get(roomCode);
        if (!room || room.state !== 'making') break;

        room.currentEmojis = emojis;
        room.correctGuessers = new Set();
        room.state = 'guessing';

        const makerName = room.players[room.currentMakerIndex]?.name;

        room.players.forEach(p => {
          if (p.ws.readyState !== WebSocket.OPEN) return;
          p.ws.send(JSON.stringify({
            type: 'game_emoji_revealed',
            payload: { emojis, maker: makerName }
          }));
        });

        if (room.roundTimer) clearTimeout(room.roundTimer);
        room.roundTimer = setTimeout(() => endGameRound(room, null), 90000);
        break;
      }

      case 'game_player_guess': {
        const { roomCode, player: guesser, guess } = payload;
        const room = gameRooms.get(roomCode);
        if (!room || room.state !== 'guessing') break;

        const makerName = room.players[room.currentMakerIndex]?.name;
        if (guesser === makerName || room.correctGuessers.has(guesser)) break;

        const normalize = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
        const correct = normalize(guess) === normalize(room.currentWord);

        let points = 0;
        if (correct) {
          room.correctGuessers.add(guesser);
          const guessNum = room.correctGuessers.size;
          points = Math.max(200, 1000 - (guessNum - 1) * 300);

          const guesserPlayer = room.players.find(p => p.name === guesser);
          if (guesserPlayer) guesserPlayer.score += points;

          const makerPlayer = room.players.find(p => p.name === makerName);
          if (makerPlayer) makerPlayer.score += 150;
        }

        room.players.forEach(p => {
          if (p.ws.readyState !== WebSocket.OPEN) return;
          p.ws.send(JSON.stringify({
            type: 'game_guess_result',
            payload: { player: guesser, guess, correct, points }
          }));
        });

        const nonMakers = room.players.filter(p => p.name !== makerName);
        if (correct && room.correctGuessers.size >= nonMakers.length) {
          endGameRound(room, guesser);
        }
        break;
      }

      case 'game_ready_next_round': {
        reply({ type: 'game_ready_ack' });
        break;
      }
        case 'groq_guess': {
        const { emojis, previousGuesses } = payload;
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
          reply({ type: 'groq_result', error: 'No API key configured' });
          break;
        }
          console.log(`[GROQ] Request for emojis: ${emojis} | Previous guesses: ${previousGuesses?.length || 0}`);
        const prevText = previousGuesses?.length
          ? ` Do NOT guess: ${previousGuesses.map(g => `"${g}"`).join(', ')}.`
          : '';
        const prompt = `What single word or short phrase does this emoji combination represent?${prevText} Reply with ONLY the word or phrase, nothing else. Emoji combo: ${emojis}`;
        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'llama3-70b-8192',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 20,
              temperature: 0.7
            })
          });
          if (!res.ok) throw new Error('Groq error ' + res.status);
          const data = await res.json();
          const guess = data.choices?.[0]?.message?.content?.trim().toUpperCase();
          if (!guess) throw new Error('Empty response');
          reply({ type: 'groq_result', guess });
          console.log(`[GROQ] Response: "${guess}"`);

        } catch (err) {
          reply({ type: 'groq_result', error: err.message });
        }
        break;
      }

      default:
        reply({ type: 'error', message: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error('[Handler Error]', type, err);
    reply({ type: 'error', message: 'Server error: ' + err.message });
  }
}

// ─── WS EVENTS ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip}`);

  // Register as online immediately
  onlineClients.set(ws, { username: null, lastSeen: Date.now() });
  broadcastOnlineCount();

  ws.on('message', (message) => handleMessage(ws, message.toString()));

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${ip}`);
    onlineClients.delete(ws);
    broadcastOnlineCount();
  });

  ws.on('error', (err) => {
    console.error('[WS] Socket error:', err.message);
    onlineClients.delete(ws);
    broadcastOnlineCount();
  });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[Server] Connecting to MongoDB...');
  await connectDB();

  httpServer.listen(PORT, () => {
    console.log(`[Server] HTTP + WebSocket listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('[FATAL] Startup error:', err);
  process.exit(1);
});
