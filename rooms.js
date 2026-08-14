/*
 * rooms.js — in-memory room + session management for Avalon online.
 *
 * Responsibilities:
 *   - create/find rooms by short join code
 *   - track players (seat, name, session token, live socket, connection status)
 *   - enforce host authority (only the host may start/adjust)
 *   - hold the authoritative deal + game state server-side, and expose per-player
 *     private state (roles, knowledge, and live game prompts)
 *   - drive the full room lifecycle:
 *       lobby -> revealed -> [night -> done] -> game -> (game ends inside `game`)
 *     ("night"/"done" are the optional synchronised narration; "game" is the
 *      refereed Phase 3 game whose end-state lives in the engine object.)
 *
 * Nothing here talks to a socket directly; index.js wires messages to these methods.
 * That keeps the game/authority logic testable without a network (see the test suites).
 */
const crypto = require("crypto");
const Avalon = require("./avalon-core.js");

/* crypto-strong RNG in [0,1) — used for the real shuffle + leader pick */
function secureRandom() {
  // 6 bytes -> 48-bit integer -> float in [0,1)
  return crypto.randomBytes(6).readUIntBE(0, 6) / 0x1000000000000;
}

/* Unambiguous code alphabet (no 0/O, 1/I/L) */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode(len = 4) {
  let s = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
function makeToken() { return crypto.randomBytes(24).toString("hex"); }

const ROOM_TTL_MS = 1000 * 60 * 60 * 3;      // 3h idle -> room discarded
const RECONNECT_GRACE_MS = 1000 * 60 * 5;    // player shown 'away' this long before seat is freed in lobby

class Room {
  constructor(code) {
    this.code = code;
    this.hostToken = null;
    this.players = [];          // { token, name, seat, socketId, connected, role?, knowledge? }
    this.settings = {           // mirrors the local app's setup options
      players: 5,
      roles: {},                // role-count map
      lanc: "default", sorc: false, msg: false,
      narration: false,         // optional synced narration flavour
      music: "off"              // selected music track key
    };
    this.phase = "lobby";       // lobby | revealed | night | done | game
    this.deal = null;           // authoritative [{player, role, seat}]
    this.firstLeaderIdx = null;
    this.game = null;           // Phase 3 refereed game state (avalon-core.createGame)
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    // ---- Phase 2: server-driven synchronised narration ----
    this.night = {
      queue: [],                // [{id, gap}] from avalon-core.buildQueue
      idx: -1,                  // current segment index (-1 = not started)
      autoFlow: true,           // auto-advance vs host taps Next
      gapSeconds: 2,            // adjustable buffer (fixed 3s for evil-recognition)
      music: "off",             // selected track key (client owns the audio files)
      paused: false,
      startedAt: null           // ms timestamp the current segment began (for late-joiner sync)
    };
  }

  touch() { this.lastActivity = Date.now(); }
  isHost(token) { return token && token === this.hostToken; }
  playerByToken(t) { return this.players.find(p => p.token === t); }
  playerBySocket(id) { return this.players.find(p => p.socketId === id); }
  connectedCount() { return this.players.filter(p => p.connected).length; }

  addPlayer(name, socketId) {
    const token = makeToken();
    const seat = this.players.length;
    const p = { token, name: (name || "").trim() || ("Player " + (seat + 1)), seat, socketId, connected: true };
    this.players.push(p);
    if (!this.hostToken) this.hostToken = token;   // first joiner is host
    this.touch();
    return p;
  }

  /* reconnect an existing player by their session token */
  reattach(token, socketId) {
    const p = this.playerByToken(token);
    if (!p) return null;
    p.socketId = socketId;
    p.connected = true;
    this.touch();
    return p;
  }

  markDisconnected(socketId) {
    const p = this.playerBySocket(socketId);
    if (p) { p.connected = false; p.socketId = null; p.disconnectedAt = Date.now(); this.touch(); }
    return p;
  }

  /*
   * Reclaim seats of players who've been gone longer than the grace period —
   * but ONLY while in the lobby, and never the host. In any active phase
   * (revealed/night/game) a seat must persist so the player can reconnect to
   * their role, so we leave those alone entirely. Returns the number reclaimed.
   */
  sweepDisconnected(graceMs) {
    if (this.phase !== "lobby") return 0;
    const now = Date.now();
    const before = this.players.length;
    this.players = this.players.filter(p =>
      p.connected || p.token === this.hostToken || !p.disconnectedAt || (now - p.disconnectedAt) < graceMs
    );
    if (this.players.length !== before) {
      this.players.forEach((p, i) => { p.seat = i; }); // keep seats contiguous
      this.touch();
    }
    return before - this.players.length;
  }

  setName(token, name) {
    const p = this.playerByToken(token);
    if (p && this.phase === "lobby") { p.name = (name || "").trim() || p.name; this.touch(); }
    return p;
  }

  /* host-only: remove a player by seat (lobby only). Returns the removed player's
     token (so the server can notify + disconnect them) or null. Reseats the rest. */
  kickPlayer(byToken, seat) {
    if (!this.isHost(byToken) || this.phase !== "lobby") return null;
    const idx = this.players.findIndex(p => p.seat === seat);
    if (idx < 0) return null;
    const victim = this.players[idx];
    if (victim.token === this.hostToken) return null; // host can't kick themselves
    const info = { token: victim.token, socketId: victim.socketId };
    this.players.splice(idx, 1);
    // reseat remaining players so seats stay 0..n-1 and contiguous
    this.players.forEach((p, i) => { p.seat = i; });
    this.touch();
    return info;
  }

  /* host-only: after a game is over (or narration done), reset back to a fresh
     lobby with the SAME roster and settings, so the group can play again. */
  rematch(byToken) {
    if (!this.isHost(byToken)) return false;
    if (this.phase !== "game" || !this.game || this.game.phase !== "over") {
      // allow rematch from a finished game, or from the post-night "done" screen
      if (!(this.phase === "done" || (this.game && this.game.phase === "over"))) return false;
    }
    this.phase = "lobby";
    this.deal = null;
    this.firstLeaderIdx = null;
    this.game = null;
    this.night = {
      queue: [], idx: -1, autoFlow: this.night.autoFlow, gapSeconds: this.night.gapSeconds,
      music: this.settings.music || "off", paused: false, startedAt: null
    };
    // clear per-player role state; keep names/seats/tokens
    this.players.forEach(p => { delete p.role; delete p.knowledge; });
    this.touch();
    return true;
  }

  /* host-only: update settings in the lobby */
  updateSettings(token, patch) {
    if (!this.isHost(token) || this.phase !== "lobby") return false;
    const s = this.settings;
    if (typeof patch.players === "number") s.players = Math.min(10, Math.max(5, patch.players));
    if (patch.roles && typeof patch.roles === "object") s.roles = patch.roles;
    if (patch.lanc === "default" || patch.lanc === "variant") s.lanc = patch.lanc;
    if (typeof patch.sorc === "boolean") s.sorc = patch.sorc;
    if (typeof patch.msg === "boolean") s.msg = patch.msg;
    if (typeof patch.narration === "boolean") s.narration = patch.narration;
    if (typeof patch.music === "string") { s.music = patch.music; this.night.music = patch.music; }
    this.touch();
    return true;
  }

  /* the public, broadcastable view of the room (NEVER includes roles) */
  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostSeat: this.players.find(p => p.token === this.hostToken)?.seat ?? null,
      settings: {
        players: this.settings.players, lanc: this.settings.lanc,
        sorc: this.settings.sorc, msg: this.settings.msg, narration: this.settings.narration,
        music: this.settings.music,
        roleTotal: Avalon.roleTotal(this.settings.roles)
      },
      players: this.players.map(p => ({ seat: p.seat, name: p.name, connected: p.connected, isHost: p.token === this.hostToken })),
      firstLeaderSeat: (this.phase !== "lobby" && this.deal) ? this.firstLeaderIdx : null,
      firstLeaderName: (this.phase !== "lobby" && this.deal) ? this.deal[this.firstLeaderIdx].player : null,
      narration: this.narrationState(),
      game: this.publicGame(),
      warnings: Avalon.balanceWarnings(this.settings.players, this.settings.roles)
    };
  }

  /*
   * host-only: shuffle + deal. Binds roles to the CURRENT connected players in
   * seat order. Requires the role total to equal the player count.
   * Returns {ok, error?}.
   */
  startDeal(token) {
    if (!this.isHost(token)) return { ok: false, error: "Only the host can start the game." };
    if (this.phase !== "lobby") return { ok: false, error: "The game has already started." };
    const seated = this.players.filter(p => p.connected);
    const total = Avalon.roleTotal(this.settings.roles);
    if (seated.length < 5) return { ok: false, error: "Need at least 5 players." };
    if (total !== seated.length)
      return { ok: false, error: `You have ${seated.length} players but ${total} roles selected. They must match.` };

    const seatNames = seated.map(p => p.name);
    const { deal, firstLeaderIdx } = Avalon.dealRoles(this.settings.roles, seatNames, secureRandom);
    this.deal = deal;
    this.firstLeaderIdx = firstLeaderIdx;

    // bind each dealt entry back to the player at that seat index
    seated.forEach((p, i) => {
      p.role = deal[i].role;
      // compute the player's private knowledge against the authoritative game-state
      p.knowledge = Avalon.knowledgeFor(
        { deal, lanc: this.settings.lanc, sorc: this.settings.sorc, msg: this.settings.msg, firstLeaderIdx },
        deal[i], secureRandom
      );
    });
    this.phase = "revealed";
    // pre-build the night queue from the same shared rules the local app uses,
    // so an optional synchronised narration can run after everyone has seen their role.
    this.night.queue = Avalon.buildQueue(
      { deal, lanc: this.settings.lanc, sorc: this.settings.sorc, msg: this.settings.msg, firstLeaderIdx }
    );
    this.night.idx = -1;
    this.night.music = this.settings.music || "off";
    this.touch();
    return { ok: true };
  }

  /* ---- Phase 2: synchronised narration control (host-authoritative) ---- */

  /* the current segment plus enough timing for a late/reconnecting phone to sync */
  narrationState() {
    const n = this.night;
    const seg = n.idx >= 0 && n.idx < n.queue.length ? n.queue[n.idx] : null;
    return {
      active: this.phase === "night",
      idx: n.idx,
      total: n.queue.length,
      segId: seg ? seg.id : null,
      autoFlow: n.autoFlow,
      gapSeconds: n.gapSeconds,
      music: n.music,
      paused: n.paused,
      // ms elapsed in the current segment, so a joiner can start mid-line rather than restart it
      elapsedMs: (seg && n.startedAt && !n.paused) ? (Date.now() - n.startedAt) : 0
    };
  }

  /* host-only: set narration options (also usable in lobby to pre-choose music) */
  setNarrationOpts(token, patch) {
    if (!this.isHost(token)) return false;
    const n = this.night;
    if (typeof patch.autoFlow === "boolean") n.autoFlow = patch.autoFlow;
    if (typeof patch.gapSeconds === "number") n.gapSeconds = Math.min(6, Math.max(0.5, patch.gapSeconds));
    if (typeof patch.music === "string") { n.music = patch.music; this.settings.music = patch.music; }
    this.touch();
    return true;
  }

  /* host-only: begin the synchronised night after the reveal */
  startNight(token) {
    if (!this.isHost(token)) return { ok: false, error: "Only the host can start the night." };
    if (this.phase !== "revealed") return { ok: false, error: "Deal the roles first." };
    this.phase = "night";
    this.night.idx = -1;
    this.night.paused = false;
    this.touch();
    return { ok: true };
  }

  /* compute the gap after a segment: fixed 3s for evil-recognition, else the adjustable buffer */
  gapAfter(seg) {
    if (!seg) return 0;
    if (seg.id === "190-dawn") return 0;
    if (seg.id.startsWith("030-evil-open")) return 3;   // fixed evil-recognition buffer
    return this.night.gapSeconds;
  }

  /* advance to the next segment; returns {done} when the night is complete */
  advanceNight() {
    const n = this.night;
    if (this.phase !== "night") return { done: true };
    n.idx++;
    if (n.idx >= n.queue.length) { this.phase = "done"; n.startedAt = null; return { done: true }; }
    n.startedAt = Date.now();
    this.touch();
    return { done: false, seg: n.queue[n.idx] };
  }

  pauseNight(token, paused) {
    if (!this.isHost(token)) return false;
    this.night.paused = !!paused;
    if (!paused) this.night.startedAt = Date.now(); // resume clock
    this.touch();
    return true;
  }
  /* host-only manual step (used when autoFlow is off) */
  stepNight(token) {
    if (!this.isHost(token)) return { ok: false };
    return { ok: true, ...this.advanceNight() };
  }

  /* =======================================================================
   * PHASE 3 — live refereed game (proposals, votes, quests, assassination)
   * The room's `phase` becomes "game" here; the engine object `this.game`
   * (from avalon-core.createGame) holds the authoritative state and is driven
   * by the routers below. index.js wires client messages to these.
   * ===================================================================== */

  /* host-only: begin the refereed game. Allowed after the deal (revealed) or
     after narration (done). Uses the SAME authoritative deal + seating. */
  startGame(token) {
    if (!this.isHost(token)) return { ok: false, error: "Only the host can begin the game." };
    if (this.phase !== "revealed" && this.phase !== "done")
      return { ok: false, error: "Deal the roles first." };
    if (!this.deal) return { ok: false, error: "No deal to play." };
    // players in seat order (only those who were dealt, i.e. connected at deal time)
    const seated = this.deal.map(d => {
      const p = this.players.find(pp => pp.seat === d.seat);
      return { seat: d.seat, name: d.player };
    });
    this.game = Avalon.createGame(
      seated, this.deal,
      { lanc: this.settings.lanc, sorc: this.settings.sorc, msg: this.settings.msg },
      this.firstLeaderIdx
    );
    this.phase = "game";
    // stop any narration timer state cleanly
    this.night.paused = true;
    this.touch();
    return { ok: true };
  }

  /* map a session token to its seat index (engine authority checks use this) */
  seatOfToken(token) {
    const p = this.playerByToken(token);
    return p ? p.seat : -1;
  }

  /* ---- routers: each validates via the engine, then we broadcast/deliver ---- */
  gamePropose(token, seats) {
    if (this.phase !== "game" || !this.game) return { ok: false, error: "No game in progress." };
    const r = Avalon.proposeTeam(this.game, token, seats, t => this.seatOfToken(t));
    if (r.ok) this.touch();
    return r;
  }
  gameVote(token, vote) {
    if (this.phase !== "game" || !this.game) return { ok: false, error: "No game in progress." };
    const seat = this.seatOfToken(token);
    if (seat < 0) return { ok: false, error: "You are not seated." };
    const r = Avalon.castVote(this.game, seat, vote);
    if (r.ok) this.touch();
    return r;
  }
  gameQuestCard(token, card) {
    if (this.phase !== "game" || !this.game) return { ok: false, error: "No game in progress." };
    const seat = this.seatOfToken(token);
    if (seat < 0) return { ok: false, error: "You are not seated." };
    const r = Avalon.submitQuestCard(this.game, seat, card);
    if (r.ok) this.touch();
    return r;
  }
  gameAssassinate(token, targetSeat) {
    if (this.phase !== "game" || !this.game) return { ok: false, error: "No game in progress." };
    const r = Avalon.assassinate(this.game, token, targetSeat, t => this.seatOfToken(t));
    if (r.ok) this.touch();
    return r;
  }

  /* the public, broadcast-safe game view (no roles until game over) */
  publicGame() {
    if (!this.game) return null;
    const view = Avalon.publicGameView(this.game);
    // Enrich (additively) with "who are we waiting on", joined to live connection
    // status — data the pure engine doesn't have. This lets the table see, and a
    // host act on, a dropped player who would otherwise silently stall the round.
    view.awaiting = this.awaitingSeats().map(seat => ({
      seat,
      name: this.nameOfSeat(seat),
      connected: this.isSeatConnected(seat)
    }));
    view.anyAwaitingDisconnected = view.awaiting.some(a => !a.connected);
    return view;
  }

  nameOfSeat(seat) { const p = this.players.find(x => x.seat === seat); return p ? p.name : "?"; }
  isSeatConnected(seat) { const p = this.players.find(x => x.seat === seat); return !!(p && p.connected); }

  /* Which seats the game is currently waiting on to act (empty outside vote/quest). */
  awaitingSeats() {
    const g = this.game;
    if (!g) return [];
    if (g.phase === "vote" && g.votes) {
      return g.players.filter(p => !g.votes[p.seat]).map(p => p.seat);
    }
    if (g.phase === "quest" && g.proposal && g.questCards) {
      return g.proposal.filter(s => !g.questCards[s]);
    }
    if (g.phase === "proposal") {
      return [Avalon.leaderSeat(g)];
    }
    if (g.phase === "assassination") {
      const a = g.deal.find(d => d.role === "assassin");
      return a ? [a.seat] : [];
    }
    return [];
  }

  /*
   * The PRIVATE game-context for one player: what only they may see right now.
   * - whether it's their turn to propose (they're the leader)
   * - whether they're ON the current quest team (and may submit a card)
   * - which cards they're allowed to play (Good may not Fail)
   * - whether they are the Assassin during the assassination phase
   * Delivered ONLY to that player's own socket by index.js.
   */
  privateGameFor(token) {
    if (this.phase !== "game" || !this.game) return null;
    const g = this.game;
    const seat = this.seatOfToken(token);
    if (seat < 0) return null;
    const myRole = Avalon.roleOf(g, seat);
    const myTeam = Avalon.ROLES[myRole] ? Avalon.ROLES[myRole].t : null;
    const ctx = { seat, phase: g.phase };
    if (g.phase === "proposal") {
      ctx.isLeader = (Avalon.leaderSeat(g) === seat);
      ctx.questSize = Avalon.currentQuestSize(g);
    }
    if (g.phase === "vote") {
      ctx.hasVoted = !!(g.votes && g.votes[seat]);
    }
    if (g.phase === "quest") {
      ctx.onTeam = g.proposal.includes(seat);
      if (ctx.onTeam) {
        ctx.hasSubmitted = !!(g.questCards && g.questCards[seat]);
        // Good may only play success; evil may choose
        ctx.allowedCards = (myTeam === "good") ? ["success"] : ["success", "fail"];
      }
    }
    if (g.phase === "assassination") {
      ctx.isAssassin = (myRole === "assassin");
    }
    return ctx;
  }

  /*
   * The PRIVATE payload for exactly one player. index.js must send this ONLY to
   * that player's own socket. Contains their role + their knowledge — nobody else's.
   */
  privateStateFor(token) {
    const p = this.playerByToken(token);
    if (!p) return null;
    const base = { seat: p.seat, name: p.name, isHost: p.token === this.hostToken, phase: this.phase };
    if (this.phase === "lobby" || !p.role) return base;
    const r = Avalon.ROLES[p.role];
    return {
      ...base,
      role: p.role,
      roleName: r.n,
      team: r.t,                                 // for the player's OWN eyes only
      knowledge: p.knowledge || null,            // null => client shows the maths decoy
      noInfo: !p.knowledge,
      firstLeaderName: this.deal[this.firstLeaderIdx].player
    };
  }

  expired() { return Date.now() - this.lastActivity > ROOM_TTL_MS; }
}

class RoomManager {
  constructor() { this.rooms = new Map(); }

  create() {
    let code;
    do { code = makeCode(4); } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }
  get(code) { return this.rooms.get((code || "").toUpperCase()); }
  remove(code) { this.rooms.delete(code); }

  sweep(graceMs) {
    const changed = [];
    for (const [code, room] of this.rooms) {
      if (room.expired()) { this.rooms.delete(code); continue; }
      if (graceMs && room.sweepDisconnected(graceMs) > 0) changed.push(room);
    }
    return changed; // rooms whose roster changed (server rebroadcasts these)
  }
}

module.exports = { RoomManager, Room, makeCode, makeToken, secureRandom,
  CODE_ALPHABET, ROOM_TTL_MS, RECONNECT_GRACE_MS };
