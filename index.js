/*
 * index.js — Avalon online server.
 *
 * - serves the online client from /public
 * - runs a WebSocket endpoint for real-time room play
 * - delivers each player's secret ONLY to their own socket
 *
 * Message protocol (JSON, {type, ...}) — see PROTOCOL.md for the full reference:
 *   client -> server:
 *     lobby/session: create | join | reconnect | setName | leave | disband | ping
 *     setup:         updateSettings | startDeal | requestPrivate
 *     narration:     narrationOpts | startNight | pauseNight | stepNight | segmentDone
 *     game:          startGame | propose | vote | questCard | assassinate | requestGame
 *   server -> client:
 *     created | joined | room_state | private_state | private_game |
 *     disbanded | error | pong
 *
 * SECURITY INVARIANT: private_state and private_game are sent with ws.send to a
 * single socket only. publicState() (broadcast) never contains any role until the
 * game is over. See rooms.js.
 *
 * NOTE on setName/requestPrivate/requestGame: setName is not yet surfaced in the
 * client UI (rename-after-join is a planned feature); requestPrivate/requestGame
 * let a client explicitly re-request its private state. All three are safe no-ops
 * if unused and are covered by host-authority / seat checks.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { RoomManager, RECONNECT_GRACE_MS } = require("./lib/rooms.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const manager = new RoomManager();

/* ---------------- static file serving ---------------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" ) urlPath = "/index.html";
  // join links like /join/ABCD still serve the app; the code is read client-side
  if (urlPath.startsWith("/join/")) urlPath = "/index.html";
  const filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ---------------- websocket wiring ---------------- */
const wss = new WebSocketServer({ server });
let nextSocketId = 1;

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function errorTo(ws, message) { send(ws, { type: "error", message }); }

/* broadcast the PUBLIC room state to everyone connected in the room */
function broadcastRoom(room) {
  const pub = room.publicState();
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      const ws = sockets.get(p.socketId);
      if (ws) send(ws, { type: "room_state", room: pub });
    }
  }
}
/* send one player's PRIVATE state to that player's own socket only */
function sendPrivate(room, token) {
  const p = room.playerByToken(token);
  if (!p || !p.connected || !p.socketId) return;
  const ws = sockets.get(p.socketId);
  if (ws) send(ws, { type: "private_state", you: room.privateStateFor(token) });
}
/* send one player's PRIVATE game-context (turn/team/allowed-cards/assassin) to
   that player's own socket only. Never broadcast. */
function sendPrivateGame(room, token) {
  const p = room.playerByToken(token);
  if (!p || !p.connected || !p.socketId) return;
  const ws = sockets.get(p.socketId);
  if (ws) send(ws, { type: "private_game", ctx: room.privateGameFor(token) });
}
/* after any game transition: broadcast the public view, then refresh every
   player's private game-context (so prompts appear/disappear correctly). */
function pushGame(room) {
  broadcastRoom(room);
  for (const p of room.players) if (p.connected) sendPrivateGame(room, p.token);
}

const sockets = new Map(); // socketId -> ws

/* ---------------- Phase 2: server-driven narration ---------------- */
/*
 * The server owns the sequence cursor so every phone hears the same line at the
 * same moment. On each segment it broadcasts the public narration state (which
 * segment is current + timing), then — if autoFlow — schedules the next advance
 * after that segment's gap. The audio files themselves live on each client; the
 * server only says "segment X is current now".
 */
const narrationTimers = new Map(); // roomCode -> timeout handle

function clearNarrationTimer(room) {
  const h = narrationTimers.get(room.code);
  if (h) { clearTimeout(h); narrationTimers.delete(room.code); }
}
/* estimate how long a segment's audio+reading needs before the gap begins.
   The client plays the real audio; the server uses a word-count estimate so
   auto-advance still works even if a phone's audio 'ended' event never arrives. */
function estimateSegmentMs(room, seg) {
  // conservative: assume a spoken line then the configured gap; the client also
  // reports 'segmentDone' when its own audio finishes, which advances earlier.
  return 6000; // baseline speaking allowance; real advance is usually client-reported
}
function runNarrationResume(room) {
  // reschedule advance for the CURRENT segment after unpause (don't skip it)
  clearNarrationTimer(room);
  if (room.phase !== "night" || room.night.paused || !room.night.autoFlow) return;
  const seg = room.night.queue[room.night.idx];
  if (!seg) return;
  const h = setTimeout(() => runNarration(room), estimateSegmentMs(room, seg) + room.gapAfter(seg) * 1000);
  narrationTimers.set(room.code, h);
}
function runNarration(room) {
  clearNarrationTimer(room);
  const res = room.advanceNight();
  broadcastRoom(room);
  if (res.done) { clearNarrationTimer(room); return; }
  if (!room.night.autoFlow || room.night.paused) return; // wait for host tap / resume
  const seg = res.seg;
  const speak = estimateSegmentMs(room, seg);
  const gap = room.gapAfter(seg) * 1000;
  const h = setTimeout(() => runNarration(room), speak + gap);
  narrationTimers.set(room.code, h);
}

wss.on("connection", (ws) => {
  const socketId = nextSocketId++;
  ws.socketId = socketId;
  ws.roomCode = null;
  sockets.set(socketId, ws);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return errorTo(ws, "Bad message."); }
    const t = msg.type;

    if (t === "ping") return send(ws, { type: "pong" });

    if (t === "create") {
      const room = manager.create();
      const p = room.addPlayer(msg.name, socketId);
      ws.roomCode = room.code;
      send(ws, { type: "created", code: room.code, token: p.token, seat: p.seat });
      broadcastRoom(room);
      sendPrivate(room, p.token);
      return;
    }

    if (t === "join") {
      const room = manager.get(msg.code);
      if (!room) return errorTo(ws, "No game with that code.");
      if (room.phase !== "lobby") return errorTo(ws, "That game has already started.");
      const p = room.addPlayer(msg.name, socketId);
      ws.roomCode = room.code;
      send(ws, { type: "joined", code: room.code, token: p.token, seat: p.seat });
      broadcastRoom(room);
      sendPrivate(room, p.token);
      return;
    }

    if (t === "reconnect") {
      const room = manager.get(msg.code);
      if (!room) return errorTo(ws, "That game no longer exists.");
      const p = room.reattach(msg.token, socketId);
      if (!p) return errorTo(ws, "Could not restore your seat.");
      ws.roomCode = room.code;
      send(ws, { type: "joined", code: room.code, token: p.token, seat: p.seat, reconnected: true });
      broadcastRoom(room);
      sendPrivate(room, p.token);   // re-delivers their secret after a drop
      sendPrivateGame(room, p.token); // re-delivers their live game prompts (if a game is running)
      return;
    }

    // all remaining actions require an established room + token
    const room = manager.get(ws.roomCode);
    if (!room) return errorTo(ws, "You are not in a game.");

    if (t === "setName") {
      room.setName(msg.token, msg.name);
      broadcastRoom(room);
      return;
    }
    if (t === "kick") {
      const info = room.kickPlayer(msg.token, msg.seat);
      if (!info) return errorTo(ws, "Couldn't remove that player (host-only, lobby-only, not the host).");
      // notify the kicked player directly, then close their socket
      if (info.socketId) {
        const w = sockets.get(info.socketId);
        if (w) { send(w, { type: "kicked" }); }
      }
      broadcastRoom(room);
      return;
    }
    if (t === "rematch") {
      if (!room.rematch(msg.token)) return errorTo(ws, "Only the host can start a rematch, and only after a game ends.");
      broadcastRoom(room);
      for (const p of room.players) if (p.connected) sendPrivate(room, p.token);
      return;
    }
    if (t === "updateSettings") {
      if (!room.updateSettings(msg.token, msg.patch || {}))
        return errorTo(ws, "Only the host can change settings, and only before the game starts.");
      broadcastRoom(room);
      return;
    }
    if (t === "startDeal") {
      const res = room.startDeal(msg.token);
      if (!res.ok) return errorTo(ws, res.error);
      broadcastRoom(room);
      // deliver every player's private secret to their OWN socket, individually
      for (const p of room.players) sendPrivate(room, p.token);
      return;
    }
    if (t === "requestPrivate") {
      sendPrivate(room, msg.token);
      return;
    }
    /* ---- Phase 2 narration controls (host-authoritative) ---- */
    if (t === "narrationOpts") {
      if (!room.setNarrationOpts(msg.token, msg.patch || {}))
        return errorTo(ws, "Only the host can change narration settings.");
      broadcastRoom(room);
      return;
    }
    if (t === "startNight") {
      const res = room.startNight(msg.token);
      if (!res.ok) return errorTo(ws, res.error);
      runNarration(room);   // advances to segment 0 and schedules the rest
      return;
    }
    if (t === "pauseNight") {
      if (!room.pauseNight(msg.token, !!msg.paused)) return errorTo(ws, "Only the host can pause.");
      if (msg.paused) clearNarrationTimer(room);
      else if (room.night.autoFlow) runNarrationResume(room);
      broadcastRoom(room);
      return;
    }
    if (t === "stepNight") {
      // manual advance (autoFlow off) OR host Skip
      const r = room.stepNight(msg.token);
      if (!r.ok) return errorTo(ws, "Only the host can advance the narration.");
      clearNarrationTimer(room);
      broadcastRoom(room);
      if (!r.done && room.night.autoFlow && !room.night.paused) {
        const seg = room.night.queue[room.night.idx];
        const h = setTimeout(() => runNarration(room), estimateSegmentMs(room, seg) + room.gapAfter(seg) * 1000);
        narrationTimers.set(room.code, h);
      }
      return;
    }
    if (t === "segmentDone") {
      // a client reports its audio for the current segment finished; if it's the
      // host's phone and autoFlow is on, advance immediately rather than waiting
      // out the speaking estimate. Guarded to the current segment to avoid races.
      if (room.isHost(msg.token) && room.phase === "night" && room.night.autoFlow &&
          !room.night.paused && msg.idx === room.night.idx) {
        const seg = room.night.queue[room.night.idx];
        clearNarrationTimer(room);
        const h = setTimeout(() => runNarration(room), room.gapAfter(seg) * 1000);
        narrationTimers.set(room.code, h);
      }
      return;
    }
    /* ---- Phase 3: refereed game ---- */
    if (t === "startGame") {
      const res = room.startGame(msg.token);
      if (!res.ok) return errorTo(ws, res.error);
      pushGame(room);
      return;
    }
    if (t === "propose") {
      const res = room.gamePropose(msg.token, Array.isArray(msg.seats) ? msg.seats : []);
      if (!res.ok) return errorTo(ws, res.error);
      pushGame(room);
      return;
    }
    if (t === "vote") {
      const res = room.gameVote(msg.token, msg.vote);
      if (!res.ok) return errorTo(ws, res.error);
      pushGame(room);
      return;
    }
    if (t === "questCard") {
      const res = room.gameQuestCard(msg.token, msg.card);
      if (!res.ok) return errorTo(ws, res.error);
      pushGame(room);
      return;
    }
    if (t === "assassinate") {
      const res = room.gameAssassinate(msg.token, msg.targetSeat);
      if (!res.ok) return errorTo(ws, res.error);
      pushGame(room);
      return;
    }
    if (t === "requestGame") {
      // a (re)joining player asks for their private game-context
      sendPrivateGame(room, msg.token);
      return;
    }
    if (t === "leave") {
      room.markDisconnected(socketId);
      clearNarrationTimer(room);
      broadcastRoom(room);
      return;
    }
    if (t === "disband") {
      if (!room.isHost(msg.token)) return errorTo(ws, "Only the host can disband the game.");
      // tell everyone the room is closing, then tear it down
      for (const p of room.players) {
        if (p.connected && p.socketId) {
          const w = sockets.get(p.socketId);
          if (w) send(w, { type: "disbanded" });
        }
      }
      clearNarrationTimer(room);
      manager.remove(room.code);
      return;
    }
  });

  ws.on("close", () => {
    sockets.delete(socketId);
    const room = manager.get(ws.roomCode);
    if (room) {
      room.markDisconnected(socketId);
      broadcastRoom(room);
    }
  });
});

/* periodic cleanup of abandoned rooms */
setInterval(() => {
  const changed = manager.sweep(RECONNECT_GRACE_MS);
  for (const room of changed) broadcastRoom(room);
}, 1000 * 60).unref?.();

server.listen(PORT, () => {
  console.log(`Avalon online server listening on http://localhost:${PORT}`);
});

module.exports = { server, wss, manager }; // for tests
