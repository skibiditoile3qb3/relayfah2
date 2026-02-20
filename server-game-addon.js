// ═══════════════════════════════════════════════════════════════════
// EMOJI CIPHER GAME — Server-side patch for server.js
// Add this code block inside the switch(type) in handleMessage(),
// BEFORE the `default:` case.
// ═══════════════════════════════════════════════════════════════════

// ─── GAME ROOMS (in-memory, above connectDB or at top of file) ──────────────
// ADD THIS NEAR THE TOP OF server.js (after chatHistory declaration):
//
// const gameRooms = new Map(); // roomCode -> roomState
//
// ─── ROOM STATE SHAPE ────────────────────────────────────────────────────────
// {
//   code: String,
//   hostWs: WebSocket,
//   players: [{ ws, name, score }],
//   state: 'waiting' | 'making' | 'guessing' | 'reveal' | 'finished',
//   currentRound: Number,
//   totalRounds: Number,
//   wordList: [String],
//   currentMakerIndex: Number,
//   currentWord: String,
//   currentEmojis: String,
//   correctGuessers: Set<String>,
//   roundTimer: Timeout | null,
// }
// ─────────────────────────────────────────────────────────────────────────────

case 'game_join': {
  const { roomCode, player: pName, isHost } = payload;
  if (!roomCode || !pName) break;

  let room = gameRooms.get(roomCode);

  if (!room) {
    // Create new room
    room = {
      code: roomCode,
      hostWs: ws,
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

  // Add player if not already in
  if (!room.players.find(p => p.name === pName)) {
    room.players.push({ ws, name: pName, score: 0 });
    // Notify everyone else of new join
    room.players.forEach(p => {
      if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({ type: 'game_player_joined', payload: { player: pName } }));
      }
    });
  }

  break;
}

case 'game_start_game': {
  const { roomCode, totalRounds: tr, wordList } = payload;
  const room = gameRooms.get(roomCode);
  if (!room || room.state !== 'waiting') break;

  room.totalRounds = tr;
  room.wordList = wordList;
  room.currentRound = 0;
  room.currentMakerIndex = 0;
  room.state = 'making';

  const playerNames = room.players.map(p => p.name);

  // Broadcast game_started
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'game_game_started',
      payload: { totalRounds: tr, players: room.players.map(pl => ({ name: pl.name, score: 0 })) }
    }));
  });

  // Start round 1
  startGameRound(room);
  break;
}

case 'game_emoji_locked': {
  const { roomCode, emojis, player: pName } = payload;
  const room = gameRooms.get(roomCode);
  if (!room || room.state !== 'making') break;

  room.currentEmojis = emojis;
  room.correctGuessers = new Set();
  room.state = 'guessing';

  const makerName = room.players[room.currentMakerIndex]?.name;

  // Broadcast emoji to all
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'game_emoji_revealed',
      payload: { emojis, maker: makerName }
    }));
  });

  // Auto-end guessing phase after 90s
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => endGameRound(room, null), 90000);
  break;
}

case 'game_player_guess': {
  const { roomCode, player: guesser, guess } = payload;
  const room = gameRooms.get(roomCode);
  if (!room || room.state !== 'guessing') break;

  const makerName = room.players[room.currentMakerIndex]?.name;
  if (guesser === makerName) break; // maker can't guess
  if (room.correctGuessers.has(guesser)) break; // already got it

  const correct =
    guess.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim() ===
    room.currentWord.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();

  let points = 0;
  if (correct) {
    room.correctGuessers.add(guesser);
    const guessNum = room.correctGuessers.size;
    // First guesser gets 1000, second 700, etc.
    points = Math.max(200, 1000 - (guessNum - 1) * 300);
    const guesserPlayer = room.players.find(p => p.name === guesser);
    if (guesserPlayer) guesserPlayer.score += points;
    // Maker also gets points for a correct guess
    const makerPlayer = room.players.find(p => p.name === makerName);
    if (makerPlayer) makerPlayer.score += 150;
  }

  // Broadcast result to all
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'game_guess_result',
      payload: { player: guesser, guess, correct, points }
    }));
  });

  // If all non-makers have guessed correctly, end round
  const nonMakers = room.players.filter(p => p.name !== makerName);
  if (correct && room.correctGuessers.size >= nonMakers.length) {
    endGameRound(room, guesser);
  }
  break;
}

case 'game_ready_next_round': {
  // Individual ready signals — for simplicity, host triggers next round via start_game
  // Just ack
  reply({ type: 'game_ready_ack' });
  break;
}

// ─── END of game cases ───────────────────────────────────────────────────────
// Also add these HELPER FUNCTIONS somewhere in server.js (e.g. after connectDB):

/*
function startGameRound(room) {
  room.currentRound++;
  if (room.currentRound > room.totalRounds) {
    // Game over
    room.state = 'finished';
    room.players.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'game_game_over',
        payload: { finalPlayers: room.players.map(pl => ({ name: pl.name, score: pl.score })) }
      }));
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
    const isMaker = p.name === makerName;
    p.ws.send(JSON.stringify({
      type: 'game_round_start',
      payload: {
        round: room.currentRound,
        makerIndex: room.currentMakerIndex,
        word: isMaker ? room.currentWord : undefined, // only maker gets the word
      }
    }));
  });

  // Maker has 70 seconds to lock in emojis
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.state === 'making') {
      // Auto-skip if maker didn't lock in
      endGameRound(room, null);
    }
  }, 70000);
}

function endGameRound(room, winnerName) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  room.state = 'reveal';

  const scores = {};
  room.players.forEach(p => { scores[p.name] = p.score; });

  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'game_round_end',
      payload: {
        winner: winnerName,
        word: room.currentWord,
        scores,
      }
    }));
  });

  // Start next round after 6s (reveal time)
  setTimeout(() => startGameRound(room), 6000);
}
*/
