/*
 * test-lobby.js — Step 6 room-level features: rename, kick, rematch, grace sweep.
 * These exercise the authoritative rooms.js logic directly (no network needed).
 * Run: node test-lobby.js
 */
const { RoomManager, RECONNECT_GRACE_MS } = require("./lib/rooms.js");
const Avalon = require("./lib/avalon-core.js");
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL  " + label); } };

function lobbyOf(nPlayers) {
  const mgr = new RoomManager();
  const room = mgr.create();
  const tokens = [];
  for (let i = 0; i < nPlayers; i++) {
    const p = room.addPlayer("P" + i, 100 + i); // socketId 100+i
    tokens.push(p.token);
  }
  return { mgr, room, tokens };
}

/* ---------- rename ---------- */
{
  const { room, tokens } = lobbyOf(3);
  room.setName(tokens[1], "  Lady Igraine  ");
  ok("rename trims and applies", room.players[1].name === "Lady Igraine");
  room.setName(tokens[1], "   ");
  ok("blank rename keeps previous name", room.players[1].name === "Lady Igraine");
  // rename blocked once out of lobby
  room.phase = "revealed";
  room.setName(tokens[1], "TooLate");
  ok("rename blocked outside lobby", room.players[1].name === "Lady Igraine");
}

/* ---------- kick ---------- */
{
  const { room, tokens } = lobbyOf(5);
  const hostToken = tokens[0];
  // non-host cannot kick
  ok("non-host cannot kick", room.kickPlayer(tokens[1], 2) === null);
  // host cannot kick themselves
  ok("host cannot kick self", room.kickPlayer(hostToken, 0) === null);
  // host kicks seat 3
  const victimName = room.players[3].name;
  const info = room.kickPlayer(hostToken, 3);
  ok("host kick returns victim token+socket", info && info.token && info.socketId === 103);
  ok("kicked player removed from roster", !room.players.some(p => p.name === victimName));
  ok("roster reseated contiguously", room.players.every((p, i) => p.seat === i));
  ok("roster down to 4", room.players.length === 4);
  // kick blocked outside lobby
  room.phase = "game";
  ok("kick blocked outside lobby", room.kickPlayer(hostToken, 1) === null);
}

/* ---------- rematch ---------- */
{
  const { room, tokens } = lobbyOf(5);
  const hostToken = tokens[0];
  room.settings.roles = { merlin:1, percival:1, loyal_servant:1, assassin:1, morgana:1 };
  // deal + start a game, then force it to 'over'
  room.startDeal(hostToken);
  ok("dealt: players have roles", room.players.every(p => p.role));
  // simulate reaching a finished game
  room.phase = "game";
  room.game = Avalon.createGame(room.players.map(p=>({seat:p.seat,name:p.name})), room.deal, room.settings, 0);
  room.game.phase = "over"; room.game.winner = "good";
  // non-host cannot rematch
  ok("non-host cannot rematch", room.rematch(tokens[1]) === false);
  // host rematch resets to a fresh lobby, same roster
  const namesBefore = room.players.map(p => p.name);
  ok("host rematch succeeds", room.rematch(hostToken) === true);
  ok("rematch returns to lobby", room.phase === "lobby");
  ok("rematch clears the game", room.game === null);
  ok("rematch clears roles", room.players.every(p => !p.role));
  ok("rematch keeps the same roster", JSON.stringify(room.players.map(p=>p.name)) === JSON.stringify(namesBefore));
  ok("rematch keeps settings", room.settings.roles.merlin === 1);
  // rematch not allowed from an unfinished game
  room.phase = "game"; room.game = { phase: "vote" };
  ok("rematch blocked mid-game", room.rematch(hostToken) === false);
}

/* ---------- grace sweep ---------- */
{
  const { mgr, room, tokens } = lobbyOf(4);
  // seat 2 disconnects "long ago"
  room.markDisconnected(102);
  const gonePlayer = room.players.find(p => p.seat === 2);
  gonePlayer.disconnectedAt = Date.now() - (RECONNECT_GRACE_MS + 1000);
  // seat 1 disconnected just now (within grace)
  room.markDisconnected(101);
  const before = room.players.length;
  const reclaimed = room.sweepDisconnected(RECONNECT_GRACE_MS);
  ok("grace sweep reclaims the long-gone lobby seat", reclaimed === 1);
  ok("recent disconnect kept within grace", room.players.some(p => p.socketId === null && p.disconnectedAt && (Date.now()-p.disconnectedAt) < RECONNECT_GRACE_MS));
  ok("roster reseated after sweep", room.players.every((p,i)=>p.seat===i));
  // host is never swept even if gone
  const hostP = room.players.find(p => p.token === room.hostToken);
  room.markDisconnected(hostP.socketId || 100); hostP.connected=false; hostP.disconnectedAt = Date.now() - (RECONNECT_GRACE_MS*3);
  room.sweepDisconnected(RECONNECT_GRACE_MS);
  ok("host is never swept", room.players.some(p => p.token === room.hostToken));
  // sweep never touches an active game
  room.phase = "game";
  const n = room.players.length;
  room.players.forEach(p => { p.connected=false; p.disconnectedAt = Date.now() - RECONNECT_GRACE_MS*3; });
  ok("sweep does nothing outside lobby", room.sweepDisconnected(RECONNECT_GRACE_MS) === 0 && room.players.length === n);
}

console.log(`\nStep 6 lobby features: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
