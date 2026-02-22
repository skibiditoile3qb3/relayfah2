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

        const chatUser = await db.collection('users').findOne({ displayUsername: author });
        if (!chatUser) break;

        const msg = {
          author,
          text: text.trim().slice(0, 300),
          ts: new Date().toISOString()
        };

        chatHistory.push(msg);
        if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

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

      case 'groq_ask': {
        const { question } = payload;
        const apiKey = process.env.GROQ_API_KEY;

        if (!apiKey) {
          reply({ type: 'groq_ask_result', error: 'No API key configured' });
          break;
        }
        if (!question || !question.trim()) {
          reply({ type: 'groq_ask_result', error: 'No question provided' });
          break;
        }

        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [{ role: 'user', content: question.trim() }],
              max_tokens: 1024,
              temperature: 0.7
            })
          });

          if (!res.ok) throw new Error('Groq API error ' + res.status);
          const data = await res.json();
          const answer = data.choices?.[0]?.message?.content?.trim();
          if (!answer) throw new Error('Empty response from Groq');

          reply({
            type: 'groq_ask_result',
            answer,
            model: data.model || 'llama-3.1-8b-instant',
            tokens: data.usage?.total_tokens
          });
          console.log(`[GROQ_ASK] Q: "${question.slice(0, 60)}..." | tokens: ${data.usage?.total_tokens}`);
        } catch (err) {
          console.error('[GROQ_ASK] Error:', err.message);
          reply({ type: 'groq_ask_result', error: err.message });
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
