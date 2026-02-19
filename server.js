const WebSocket = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = 'mongodb+srv://skibiditoile3qb_db_user:VVnERbwKXqwivQEo@cluster0.fydfhut.mongodb.net/?appName=Cluster0';
const PORT = process.env.PORT || 8080;

let db;
let wss;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('forum_db');
  console.log('Connected to MongoDB');
}

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
    ws.send(JSON.stringify({ ...data, reqId }));
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

        const posts = await db.collection('posts')
          .find({})
          .sort(sortQuery)
          .toArray();

        reply({ type: 'posts_list', posts });
        break;
      }

      case 'create_post': {
        const { title, content, authorUsername, authorPermId } = payload;

        // verify author
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
        const post = await db.collection('posts').findOne({ _id: new ObjectId(postId) });
        if (!post) {
          reply({ type: 'post_detail', post: null });
          return;
        }
        reply({ type: 'post_detail', post });
        break;
      }

      case 'like_post': {
        const { postId, permId, username } = payload;

        // verify
        const user = await db.collection('users').findOne({ permId });
        if (!user || user.username !== username.toLowerCase()) {
          reply({ type: 'like_result', success: false, reason: 'AUTH_FAILED' });
          return;
        }

        const post = await db.collection('posts').findOne({ _id: new ObjectId(postId) });
        if (!post) {
          reply({ type: 'like_result', success: false, reason: 'POST_NOT_FOUND' });
          return;
        }

        const alreadyLiked = post.likedBy.includes(permId);
        let update;
        let newLikes;

        if (alreadyLiked) {
          newLikes = post.likes - 1;
          update = { $inc: { likes: -1 }, $pull: { likedBy: permId } };
        } else {
          newLikes = post.likes + 1;
          update = { $inc: { likes: 1 }, $push: { likedBy: permId } };
        }

        await db.collection('posts').updateOne({ _id: new ObjectId(postId) }, update);

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

        await db.collection('posts').updateOne(
          { _id: new ObjectId(postId) },
          { $push: { comments: comment } }
        );

        reply({ type: 'add_comment_result', success: true, comment });
        broadcast({ type: 'new_comment', postId, comment }, ws);
        break;
      }

      default:
        reply({ type: 'error', message: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error('Handler error:', err);
    reply({ type: 'error', message: 'Server error: ' + err.message });
  }
}

async function main() {
  await connectDB();

  wss = new WebSocket.Server({ port: PORT });

  wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
      handleMessage(ws, message.toString());
    });

    ws.on('close', () => {
      console.log('Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('WS error:', err);
    });
  });

  console.log(`WebSocket server running on port ${PORT}`);
}

main().catch(console.error);
