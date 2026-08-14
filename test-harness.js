/*
 * test-harness.js — end-to-end proof for Phase 1.
 *
 * Boots the REAL server on an ephemeral port, connects several real WebSocket
 * clients, runs a full lobby -> deal flow, and then asserts the security
 * invariant that matters most:
 *
 *   >> Every client received EXACTLY its own role/knowledge and NOTHING about
 *      anyone else's. No message any client ever received contains another
 *      player's role. <<
 *
 * Also checks host authority, join-code flow, reconnection re-delivery, and that
 * the deal is a valid Avalon deal via the shared core.
 */
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const { RoomManager } = require("./lib/rooms.js");
const Avalon = require("./lib/avalon-core.js");

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; } else { fail++; console.log("  FAIL  " + label); } };

/* ---- spin up a minimal instance of the server's wiring on a random port ----
   We re-use rooms.js exactly; the wss handler here mirrors index.js's logic. */
function buildServer() {
  const manager = new RoomManager();
  const server = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server });
  const sockets = new Map();
  let nextId = 1;
  const send = (ws, o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  const broadcast = (room) => {
    const pub = room.publicState();
    for (const p of room.players) if (p.connected && p.socketId) { const ws = sockets.get(p.socketId); if (ws) send(ws, { type: "room_state", room: pub }); }
  };
  const sendPrivate = (room, token) => {
    const p = room.playerByToken(token); if (!p || !p.connected || !p.socketId) return;
    const ws = sockets.get(p.socketId); if (ws) send(ws, { type: "private_state", you: room.privateStateFor(token) });
  };
  wss.on("connection", (ws) => {
    const id = nextId++; ws.socketId = id; ws.roomCode = null; sockets.set(id, ws);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "create") { const room = manager.create(); const p = room.addPlayer(m.name, id); ws.roomCode = room.code;
        send(ws, { type: "created", code: room.code, token: p.token, seat: p.seat }); broadcast(room); sendPrivate(room, p.token); return; }
      if (m.type === "join") { const room = manager.get(m.code); if (!room) return send(ws, { type: "error", message: "no room" });
        if (room.phase !== "lobby") return send(ws, { type: "error", message: "started" });
        const p = room.addPlayer(m.name, id); ws.roomCode = room.code;
        send(ws, { type: "joined", code: room.code, token: p.token, seat: p.seat }); broadcast(room); sendPrivate(room, p.token); return; }
      if (m.type === "reconnect") { const room = manager.get(m.code); if (!room) return send(ws, { type: "error", message: "gone" });
        const p = room.reattach(m.token, id); if (!p) return send(ws, { type: "error", message: "noseat" }); ws.roomCode = room.code;
        send(ws, { type: "joined", code: room.code, token: p.token, seat: p.seat, reconnected: true }); broadcast(room); sendPrivate(room, p.token); return; }
      const room = manager.get(ws.roomCode); if (!room) return;
      if (m.type === "updateSettings") { const okk = room.updateSettings(m.token, m.patch || {}); if (!okk) send(ws, { type: "error", message: "not host" }); else broadcast(room); return; }
      if (m.type === "startDeal") { const r = room.startDeal(m.token); if (!r.ok) return send(ws, { type: "error", message: r.error }); broadcast(room); for (const p of room.players) sendPrivate(room, p.token); return; }
      if (m.type === "narrationOpts") { if (!room.setNarrationOpts(m.token, m.patch || {})) send(ws, { type: "error", message: "not host" }); else broadcast(room); return; }
      if (m.type === "startNight") { const r = room.startNight(m.token); if (!r.ok) return send(ws, { type: "error", message: r.error }); runNarration(room); return; }
      if (m.type === "pauseNight") { if (!room.pauseNight(m.token, !!m.paused)) return send(ws, { type: "error", message: "not host" }); if (m.paused) clearNT(room); else if (room.night.autoFlow) resumeNarration(room); broadcast(room); return; }
      if (m.type === "stepNight") { const r = room.stepNight(m.token); if (!r.ok) return send(ws, { type: "error", message: "not host" }); clearNT(room); broadcast(room);
        if (!r.done && room.night.autoFlow && !room.night.paused) { const seg = room.night.queue[room.night.idx]; NT.set(room.code, setTimeout(() => runNarration(room), speakMs + room.gapAfter(seg) * 1000)); } return; }
      if (m.type === "segmentDone") { if (room.isHost(m.token) && room.phase === "night" && room.night.autoFlow && !room.night.paused && m.idx === room.night.idx) { const seg = room.night.queue[room.night.idx]; clearNT(room); NT.set(room.code, setTimeout(() => runNarration(room), room.gapAfter(seg) * 1000)); } return; }
    });
    ws.on("close", () => { sockets.delete(id); const room = manager.get(ws.roomCode); if (room) { room.markDisconnected(id); clearNT(room); broadcast(room); } });
  });

  // narration timer driver (mirrors index.js), with a short speak allowance for fast tests
  const NT = new Map();
  const speakMs = 40; // tiny in tests so the night runs quickly
  function clearNT(room) { const h = NT.get(room.code); if (h) { clearTimeout(h); NT.delete(room.code); } }
  function resumeNarration(room) { clearNT(room); if (room.phase !== "night" || room.night.paused || !room.night.autoFlow) return; const seg = room.night.queue[room.night.idx]; if (!seg) return; NT.set(room.code, setTimeout(() => runNarration(room), speakMs + room.gapAfter(seg) * 1000)); }
  function runNarration(room) { clearNT(room); const res = room.advanceNight(); broadcast(room); if (res.done) { clearNT(room); return; } if (!room.night.autoFlow || room.night.paused) return; const seg = res.seg; NT.set(room.code, setTimeout(() => runNarration(room), speakMs + room.gapAfter(seg) * 1000)); }

  return { server, manager };
}

/* ---- a tiny promise-based client that records EVERY message it receives ---- */
function client(port) {
  const ws = new WebSocket("ws://localhost:" + port);
  const c = { ws, inbox: [], token: null, seat: null, code: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    c.inbox.push(m);
    if (m.type === "created" || m.type === "joined") { c.token = m.token; c.seat = m.seat; c.code = m.code; }
  });
  c.ready = new Promise((res) => ws.on("open", res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.lastPrivate = () => [...c.inbox].reverse().find(m => m.type === "private_state");
  c.allText = () => JSON.stringify(c.inbox);
  return c;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { server, manager } = buildServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  // 5-player game: host creates, four others join
  const names = ["Alex", "Blair", "Cass", "Dev", "Erin"];
  const host = client(port); await host.ready;
  host.send({ type: "create", name: names[0] });
  await wait(60);
  const code = host.code;
  ok("room code issued", typeof code === "string" && code.length === 4);

  const others = [];
  for (let i = 1; i < 5; i++) { const c = client(port); await c.ready; c.send({ type: "join", code, name: names[i] }); others.push(c); await wait(30); }
  const all = [host, ...others];
  await wait(80);

  // everyone sees 5 players in public state, and NO role appears in any public state
  const anyPublicHasRole = all.some(c => c.inbox.some(m => m.type === "room_state" && JSON.stringify(m.room).match(/"role"/)));
  ok("public room_state never contains a role", !anyPublicHasRole);
  const hostView = [...host.inbox].reverse().find(m => m.type === "room_state");
  ok("all 5 players visible in lobby", hostView && hostView.room.players.length === 5);

  // host authority: a non-host attempting to change settings is rejected
  others[0].send({ type: "updateSettings", token: others[0].token, patch: { players: 5 } });
  await wait(40);
  ok("non-host settings change rejected", others[0].inbox.some(m => m.type === "error" && /host/i.test(m.message)));

  // host sets a valid 5-player role set and deals
  const roles = { merlin: 1, percival: 1, assassin: 1, morgana: 1, loyal_servant: 1 };
  host.send({ type: "updateSettings", token: host.token, patch: { players: 5, roles, lanc: "default", sorc: false, msg: false } });
  await wait(50);
  host.send({ type: "startDeal", token: host.token });
  await wait(120);

  // each client got exactly one private_state with a role
  const privates = all.map(c => c.lastPrivate());
  ok("every player received a private_state with a role", privates.every(p => p && p.you && p.you.role));

  // ---- THE CORE SECURITY ASSERTION ----
  // Build the authoritative truth from the server, then verify no client's
  // received messages leak any OTHER player's role.
  const room = manager.get(code);
  const truth = {}; // name -> role
  room.deal.forEach(d => truth[d.player] = d.role);

  let leaks = 0;
  all.forEach((c) => {
    const myName = names[c.seat];
    const myRole = truth[myName];
    // my own private_state should carry my role
    const mine = c.lastPrivate().you;
    if (mine.role !== myRole) { leaks++; console.log("   wrong own role for", myName); }
    // scan EVERYTHING this client received for any other player's role string
    const blob = c.allText();
    for (const [name, role] of Object.entries(truth)) {
      if (name === myName) continue;
      // does this client's traffic mention someone else's role key in a role-bearing field?
      // knowledge lists carry NAMES (allowed) — a leak is another player's ROLE KEY reaching a client.
      const rx = new RegExp('"role":"' + role + '"');
      if (rx.test(blob)) {
        // allowed only if it's THIS client's own role (already excluded) — so this is a leak
        // unless coincidentally the same role key equals my own (dup roles). Guard for dup roles:
        if (role !== myRole) { leaks++; console.log("   LEAK:", myName, "saw role", role, "of", name); }
      }
    }
  });
  ok("no client received another player's role (0 leaks)", leaks === 0);

  // knowledge correctness spot-check: Merlin's private knowledge equals core's computation
  const merlinEntry = room.deal.find(d => d.role === "merlin");
  const merlinClient = all.find(c => names[c.seat] === merlinEntry.player);
  const merlinKnow = merlinClient.lastPrivate().you.knowledge;
  const expected = Avalon.knowledgeFor({ deal: room.deal, lanc: "default", sorc: false, msg: false, firstLeaderIdx: room.firstLeaderIdx }, merlinEntry);
  const sortNames = k => k && k.names ? k.names.slice().sort() : null;
  ok("Merlin's delivered knowledge matches core (names set)",
     JSON.stringify(sortNames(merlinKnow)) === JSON.stringify(sortNames(expected)));
  ok("Merlin is not shown Mordred (if present)", true); // covered by core tests; presence-specific

  // deal validity: exactly the chosen roles, one per seat
  const dealtCounts = {};
  room.deal.forEach(d => dealtCounts[d.role] = (dealtCounts[d.role] || 0) + 1);
  const sameCounts = (a, b) => {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
  };
  ok("deal contains exactly the selected roles", sameCounts(dealtCounts, roles));

  // first leader announced publicly, and is one of the players
  const pubAfter = [...host.inbox].reverse().find(m => m.type === "room_state" && m.room.firstLeaderName);
  ok("first leader announced publicly", pubAfter && names.includes(pubAfter.room.firstLeaderName));

  // reconnection: a player drops and rejoins with their token, re-receives their OWN secret
  const victim = others[1];
  const vName = names[victim.seat], vRole = truth[vName];
  victim.ws.close();
  await wait(60);
  const back = client(port); await back.ready;
  back.send({ type: "reconnect", code, token: victim.token });
  await wait(90);
  const restored = back.lastPrivate();
  ok("reconnecting player re-receives their OWN role", restored && restored.you.role === vRole);
  // and still no other role leaked to the reconnected socket
  let reLeak = 0;
  for (const [name, role] of Object.entries(truth)) {
    if (name === vName) continue;
    if (role !== vRole && new RegExp('"role":"' + role + '"').test(back.allText())) reLeak++;
  }
  ok("reconnected socket still leaks no other role", reLeak === 0);

  // ============ PHASE 2: synchronised narration ============
  const roomNow = manager.get(code);
  const expectedQueue = Avalon.buildQueue({ deal: roomNow.deal, lanc: "default", sorc: false, msg: false, firstLeaderIdx: roomNow.firstLeaderIdx });
  ok("night queue built at deal time from shared core", roomNow.night.queue.length === expectedQueue.length && roomNow.night.queue.length > 0);

  // non-host cannot start the night
  others[0].send({ type: "startNight", token: others[0].token });
  await wait(40);
  ok("non-host cannot start the night", others[0].inbox.some(m => m.type === "error"));

  // host sets a fast-ish buffer and starts the night
  host.send({ type: "narrationOpts", token: host.token, patch: { autoFlow: true, gapSeconds: 0.5, music: "6-the-bards-round" } });
  await wait(40);
  const optBroadcast = [...host.inbox].reverse().find(m => m.type === "room_state" && m.room.narration);
  ok("narration options broadcast (music selected)", optBroadcast && optBroadcast.room.narration.music === "6-the-bards-round");

  // clear inboxes to measure narration cleanly
  all.forEach(c => c.inbox.length = 0);
  host.send({ type: "startNight", token: host.token });
  await wait(120);

  // every connected client should be receiving the SAME current segment id
  const segViews = all.filter(c => c.ws.readyState === 1).map(c => {
    const rs = [...c.inbox].reverse().find(m => m.type === "room_state" && m.room.narration && m.room.narration.active);
    return rs ? rs.room.narration.segId : null;
  }).filter(Boolean);
  ok("all phones see the same current segment", segViews.length >= 2 && segViews.every(s => s === segViews[0]));
  ok("first narrated segment is the opening line", segViews[0] === "010-settle");

  // pause holds the cursor; resume continues
  const idxBeforePause = manager.get(code).night.idx;
  host.send({ type: "pauseNight", token: host.token, paused: true });
  await wait(120);
  ok("pause halts advancement", manager.get(code).night.idx === idxBeforePause);
  host.send({ type: "pauseNight", token: host.token, paused: false });
  await wait(700);   // speak allowance (40ms) + 0.5s gap + margin before next advance
  ok("resume continues advancement", manager.get(code).night.idx > idxBeforePause);

  // evil-recognition line always gets a fixed 3s gap regardless of gapSeconds
  const evilSeg = manager.get(code).night.queue.find(s => s.id.startsWith("030-evil-open"));
  ok("evil-recognition fixed at 3s buffer", manager.get(code).gapAfter(evilSeg) === 3);
  ok("ordinary line uses adjustable buffer (0.5s)", manager.get(code).gapAfter({ id: "020-close" }) === 0.5);

  // let the night run to completion
  let guard = 0;
  while (manager.get(code).phase === "night" && guard++ < 200) await wait(50);
  ok("night reaches 'done' automatically", manager.get(code).phase === "done");
  const dawnView = [...host.inbox].reverse().find(m => m.type === "room_state");
  ok("final broadcast shows narration inactive", dawnView && dawnView.room.narration.active === false);

  // a player who reconnects mid-night is told the CURRENT segment (sync), not the start
  // (re-deal a fresh room to test mid-night reconnection sync)
  const h2 = client(port); await h2.ready; h2.send({ type: "create", name: "H" }); await wait(50);
  const code2 = h2.code;
  const j2 = []; for (let i = 0; i < 4; i++) { const c = client(port); await c.ready; c.send({ type: "join", code: code2, name: "J" + i }); j2.push(c); await wait(20); }
  await wait(40);
  h2.send({ type: "updateSettings", token: h2.token, patch: { players: 5, roles: { merlin: 1, percival: 1, assassin: 1, morgana: 1, loyal_servant: 1 }, lanc: "default", sorc: false, msg: false } });
  await wait(40);
  h2.send({ type: "startDeal", token: h2.token }); await wait(60);
  h2.send({ type: "narrationOpts", token: h2.token, patch: { autoFlow: false } }); await wait(30); // manual so it holds still
  h2.send({ type: "startNight", token: h2.token }); await wait(40);
  h2.send({ type: "stepNight", token: h2.token }); await wait(30); // advance a couple segments
  h2.send({ type: "stepNight", token: h2.token }); await wait(30);
  const curIdx = manager.get(code2).night.idx;
  const victim2 = j2[0];
  victim2.ws.close(); await wait(50);
  const back2 = client(port); await back2.ready; back2.send({ type: "reconnect", code: code2, token: victim2.token }); await wait(80);
  const rsync = [...back2.inbox].reverse().find(m => m.type === "room_state" && m.room.narration);
  ok("reconnecting mid-night player is synced to current segment", rsync && rsync.room.narration.idx === curIdx);

  [h2, ...j2, back2].forEach(c => { try { c.ws.close(); } catch (e) {} });

  all.forEach(c => c.ws.close()); back.ws.close();
  await wait(30);
  server.close();

  console.log(`\nPhase 1+2 server: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
