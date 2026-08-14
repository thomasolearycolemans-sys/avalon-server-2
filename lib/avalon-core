/*
 * avalon-core.js — shared, transport-agnostic Avalon game logic.
 *
 * This is the single source of truth for the game's RULES. It is pure logic:
 * no DOM, no network, no timers, no device assumptions. It is consumed by
 *   (a) the existing local browser app (offline, single device), and
 *   (b) the future online server (Node, authoritative).
 * Keeping both on this one module guarantees they can never drift apart.
 *
 * Every function that depends on game state takes that state EXPLICITLY as an
 * argument (a plain object). Nothing here reads a global. That is what makes it
 * safe to run per-room on a server handling many simultaneous games.
 *
 * GAME-STATE SHAPE (the object passed in as `g`):
 *   {
 *     deal:  [ { player: "Alex", role: "merlin", seat: 0 }, ... ],  // seats in order
 *     lanc:  "default" | "variant",     // Lancelot rules
 *     sorc:  boolean,                    // hidden Evil Sorcerer option
 *     msg:   boolean,                    // Messenger night step option
 *     firstLeaderIdx: number             // index into deal[] of the first quest leader
 *   }
 * Not every function needs every field; each documents what it uses.
 *
 * Works both as an ES/CommonJS module (server) and as a plain browser global
 * (the local app) — see the export shim at the bottom.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;            // Node / server
  } else {
    root.AvalonCore = api;           // browser global
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ================= ROLES (24) ================= */
  const ROLES = {
    merlin: { n: "Merlin", t: "good" }, percival: { n: "Percival", t: "good" },
    loyal_servant: { n: "Loyal Servant", t: "good", max: 6 },
    cleric: { n: "Cleric", t: "good" }, troublemaker: { n: "Troublemaker", t: "good" },
    untrustworthy_servant: { n: "Untrustworthy Servant", t: "good" },
    good_lancelot: { n: "Lancelot (Good)", t: "good" }, good_sorcerer: { n: "Sorcerer (Good)", t: "good" },
    good_rogue: { n: "Rogue (Good)", t: "good" },
    senior_messenger: { n: "Senior Messenger", t: "good" }, junior_messenger: { n: "Junior Messenger", t: "good" },
    assassin: { n: "Assassin", t: "evil" }, morgana: { n: "Morgana", t: "evil" }, mordred: { n: "Mordred", t: "evil" },
    oberon: { n: "Oberon", t: "evil" }, minion: { n: "Minion of Mordred", t: "evil", max: 4 },
    trickster: { n: "Trickster", t: "evil" }, lunatic: { n: "Lunatic", t: "evil" }, brute: { n: "Brute", t: "evil" },
    revealer: { n: "Revealer", t: "evil" }, evil_lancelot: { n: "Lancelot (Evil)", t: "evil" },
    evil_sorcerer: { n: "Sorcerer (Evil)", t: "evil" }, evil_rogue: { n: "Rogue (Evil)", t: "evil" },
    evil_messenger: { n: "Evil Messenger", t: "evil" }
  };

  /* Standard evil counts by player count (rulebook). */
  const EVIL_COUNT = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

  /* Roles that learn nothing at night, and therefore receive the maths-equation
     decoy so their screen-time can't betray them. */
  const NO_INFO_ROLES = new Set(["loyal_servant", "minion"]);

  /* ================= small pure helpers ================= */
  function shuffle(arr, rnd) {
    const r = rnd || Math.random;
    const b = arr.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }
  function hasRole(g, k) { return g.deal.some(d => d.role === k); }
  function playersWithRole(g, k) { return g.deal.filter(d => d.role === k).map(d => d.player); }
  function isVariantLancelot(g) {
    return g.lanc === "variant" && hasRole(g, "good_lancelot") && hasRole(g, "evil_lancelot");
  }

  /* ================= DEALING ================= */
  /* Build the ordered pool of role keys from a role-count map, e.g. {merlin:1, minion:2}. */
  function rolePool(roleCounts) {
    const pool = [];
    for (const k in roleCounts) for (let i = 0; i < roleCounts[k]; i++) pool.push(k);
    return pool;
  }
  /*
   * Shuffle a role pool and bind to seats.
   * seatNames: array of names (blanks become "Player N"); rnd: optional RNG for testing.
   * Returns { deal:[{player,role,seat}], firstLeaderIdx }.
   * NOTE: on the server, `rnd` should be a cryptographically-seeded RNG, not Math.random.
   */
  function dealRoles(roleCounts, seatNames, rnd) {
    const r = rnd || Math.random;
    const pool = shuffle(rolePool(roleCounts), r);
    const deal = pool.map((role, i) => ({
      player: (seatNames && seatNames[i]) ? seatNames[i] : "Player " + (i + 1),
      role, seat: i
    }));
    const firstLeaderIdx = Math.floor(r() * deal.length);
    return { deal, firstLeaderIdx };
  }

  /* ================= NIGHT SEQUENCE ================= */
  /*
   * Build the ordered list of narration segment ids for a given game.
   * Uses g.deal (for which roles are present), g.lanc, g.sorc, g.msg.
   * Each entry: { id, gap } where gap is the default post-line pause in seconds.
   * This mirrors the canonical v4.1 order exactly.
   */
  function buildQueue(g) {
    const has = k => hasRole(g, k);
    const q = [];
    const push = (id, gap) => q.push({ id, gap });
    const variantMode = isVariantLancelot(g);
    const hiddenSorc = g.sorc && has("evil_sorcerer");
    push("010-settle", 3); push("020-close", 4);
    if (has("cleric")) { push("025-cleric", 5); push("026-cleric-close", 3); }
    if (variantMode) push("028-lancelot-thumb", 3);
    let sfx = "";
    if (has("oberon")) sfx += "-ob";
    if (has("evil_rogue")) sfx += "-ro";
    if (variantMode) sfx += "-la";
    if (hiddenSorc) sfx += "-so";
    push("030-evil-open" + sfx, 6);
    push("034-evil-close", 3);
    if (variantMode) push("035-lancelot-fist", 3);
    push("040-checkpoint", 3);
    if (has("merlin")) {
      let t = "";
      if (has("mordred")) t += "-mo";
      if (has("evil_rogue")) t += "-ro";
      if (has("untrustworthy_servant")) t += "-ut";
      push("060-thumbs" + t, 3); push("062-merlin-open", 6); push("064-reform-merlin-close", 3); push("040-checkpoint", 3);
    }
    if (has("untrustworthy_servant") && has("assassin")) { push("070-uts", 5); push("072-uts-close", 3); }
    if (has("percival") && has("merlin")) { push(has("morgana") ? "080-percival-a" : "080-percival-b", 6); push("082-percival-close", 3); }
    if (!variantMode && has("good_lancelot") && has("evil_lancelot")) { push("090-lancelot-meet", 5); push("092-lancelot-meet-close", 3); }
    if (g.msg && has("senior_messenger") && has("junior_messenger")) { push("100-messenger", 5); push("102-messenger-close", 3); }
    push("040-checkpoint", 3); push("190-dawn", 0);
    return q;
  }

  /* ================= KNOWLEDGE ENGINE ================= */
  /* who the evil council sees (with the online-safe exclusions) */
  function evilSeen(g) {
    const variantMode = isVariantLancelot(g);
    const hiddenSorc = g.sorc && hasRole(g, "evil_sorcerer");
    return g.deal.filter(d => {
      if (ROLES[d.role].t !== "evil") return false;
      if (d.role === "oberon") return false;
      if (d.role === "evil_rogue") return false;
      if (variantMode && d.role === "evil_lancelot") return false;
      if (hiddenSorc && d.role === "evil_sorcerer") return false;
      return true;
    }).map(d => d.player);
  }
  /* who Merlin sees: all evil except Mordred and the Evil Rogue, plus the Untrustworthy Servant */
  function merlinSees(g) {
    return g.deal.filter(d => {
      if (d.role === "mordred") return false;
      if (d.role === "evil_rogue") return false;
      if (d.role === "untrustworthy_servant") return true;
      return ROLES[d.role].t === "evil";
    }).map(d => d.player);
  }

  /*
   * Compute what a single dealt player learns.
   * entry: one element of g.deal ({player, role, seat}).
   * rnd: optional RNG so name-order shuffles are deterministic in tests.
   * Returns { head, names[], none?, sub? } or null when the role learns nothing
   * (null -> the caller shows the maths-equation decoy).
   *
   * IMPORTANT (server use): call this once per player and deliver the result ONLY
   * to that player's own connection. The result for player A must never be sent
   * to player B — that is the whole security model of online mode.
   */
  function knowledgeFor(g, entry, rnd) {
    const role = entry.role, me = entry.player;
    const others = n => n.filter(x => x !== me);
    const variantMode = isVariantLancelot(g);
    const sh = a => shuffle(a, rnd);

    if (role === "merlin") {
      return { head: "agents of evil", names: sh(merlinSees(g)),
        sub: hasRole(g, "mordred") ? "One evil player is hidden from you." : "" };
    }
    if (role === "percival") {
      if (!hasRole(g, "merlin")) return null;
      const pair = [...playersWithRole(g, "merlin"), ...playersWithRole(g, "morgana")];
      return { head: hasRole(g, "morgana") ? "one of these is merlin" : "merlin", names: sh(pair),
        sub: hasRole(g, "morgana") ? "The other is Morgana wearing his face. You cannot tell which is which." : "" };
    }
    if (role === "oberon") return { head: "your allies", none: "You serve Mordred alone. The other evil players do not know you, and you do not know them.", names: [] };
    if (role === "evil_rogue") return { head: "your allies", none: "You walk your own dark road. Evil does not know you, and you do not know them.", names: [] };
    if (role === "cleric") {
      const leader = g.deal[g.firstLeaderIdx];
      const leaderEvil = ROLES[leader.role].t === "evil";
      return { head: "the first quest leader", names: [leader.player],
        sub: `${leader.player} is ${leaderEvil ? "EVIL" : "GOOD"}.` };
    }
    if (role === "untrustworthy_servant") {
      if (!hasRole(g, "assassin")) return null;
      return { head: "the assassin", names: playersWithRole(g, "assassin"),
        sub: "You are Good, but Merlin sees you as evil. You may never play a Fail card." };
    }
    if (role === "good_lancelot" || role === "evil_lancelot") {
      const other = role === "good_lancelot" ? "evil_lancelot" : "good_lancelot";
      if (!hasRole(g, other)) return null;
      if (variantMode) {
        if (role === "evil_lancelot") return { head: "your allies", names: sh(others(evilSeen(g))),
          sub: "The other evil players know you, but you do not learn them beyond this." };
        return null;
      }
      return { head: "the other lancelot", names: playersWithRole(g, other), sub: "Fate may yet trade your banners." };
    }
    if (role === "senior_messenger") {
      if (!(g.msg && hasRole(g, "junior_messenger"))) return null;
      return { head: "the junior messenger", names: playersWithRole(g, "junior_messenger"), sub: "" };
    }
    if (ROLES[role].t === "evil") {
      const n = others(evilSeen(g));
      if (!n.length) return { head: "your fellow conspirators", none: "No other evil player is known to you.", names: [] };
      return { head: "your fellow conspirators", names: sh(n), sub: "" };
    }
    return null; // Loyal Servant, Junior Messenger (default), Troublemaker, Sorcerers, Good Rogue, Brute, etc.
  }

  /* ================= BALANCE / VALIDATION ================= */
  /*
   * Given a player count and a role-count map, return an array of human-readable
   * warnings (empty array = a clean standard setup). Non-blocking guidance only,
   * matching the local app's setup warnings.
   */
  function balanceWarnings(players, roleCounts) {
    const has = k => (roleCounts[k] || 0) > 0;
    let good = 0, evil = 0;
    for (const k in roleCounts) {
      if (!ROLES[k]) continue;
      if (ROLES[k].t === "good") good += roleCounts[k]; else evil += roleCounts[k];
    }
    const needE = EVIL_COUNT[players], needG = players - needE;
    const w = [];
    if (good !== needG || evil !== needE)
      w.push(`For ${players} players the usual mix is ${needG} good and ${needE} evil — you have ${good} and ${evil}.`);
    if (has("percival") && !has("merlin")) w.push("Percival is in, but Merlin is not — Percival's step will be skipped.");
    if (has("morgana") && !has("percival")) w.push("Morgana must be played with Percival — she deceives no one without him.");
    if (has("merlin") && !has("assassin")) w.push("Merlin without an Assassin: designate another evil player to act as the Assassin at game's end.");
    if (has("percival") && players === 5 && !has("mordred") && !has("morgana")) w.push("With Percival at five players, adding Mordred or Morgana is recommended.");
    if (has("untrustworthy_servant") && !has("assassin")) w.push("The Untrustworthy Servant has no Assassin to identify — that step will be skipped.");
    if (has("good_lancelot") !== has("evil_lancelot")) w.push("Only one Lancelot is in — the Lancelot steps will be skipped.");
    return w;
  }

  /* Total roles in a role-count map (ignores unknown keys). */
  function roleTotal(roleCounts) {
    let n = 0; for (const k in roleCounts) if (ROLES[k]) n += roleCounts[k]; return n;
  }

  /* =======================================================================
   * PHASE 3 — GAME ENGINE (proposals, voting, quests, assassination)
   * Pure state-machine logic. No network, no timers. The server drives it.
   * ===================================================================== */

  /* Quest team sizes by player count and quest number (1-indexed quest).
     Standard Avalon values (verified against the rulebook). */
  const QUEST_SIZES = {
    5:  [2, 3, 2, 3, 3],
    6:  [2, 3, 4, 3, 4],
    7:  [2, 3, 3, 4, 4],
    8:  [3, 4, 4, 5, 5],
    9:  [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5]
  };
  /* Quest 4 requires TWO fails to fail, in games of 7+. */
  function questNeedsTwoFails(players, questNumber) {
    return players >= 7 && questNumber === 4;
  }
  function questSize(players, questNumber) {
    const row = QUEST_SIZES[players];
    return row ? row[questNumber - 1] : null;
  }

  /*
   * Initialise a Phase 3 game from an authoritative deal.
   * players: [{seat, name}] in seat order (the connected, dealt players).
   * deal: the avalon-core deal ([{player, role, seat}]).
   * Returns the initial game object the server holds and mutates via the
   * transition functions below.
   */
  function createGame(players, deal, settings, firstLeaderIdx) {
    const n = players.length;
    return {
      version: 1,
      playerCount: n,
      players: players.map(p => ({ seat: p.seat, name: p.name })),
      deal,                          // authoritative roles (server-only)
      settings,
      phase: "proposal",            // proposal | vote | quest | assassination | over
      questNumber: 1,               // 1..5
      questResults: [],             // "success" | "fail" per completed quest
      voteHistory: [],              // per-completed-proposal: {questNumber, round, leaderSeat, proposal, votes{seat:approve|reject}, approve, reject, passed}
      questHistory: [],             // per-completed-quest: {questNumber, result, fails, team[]}
      leaderIdx: firstLeaderIdx,    // index into players[] whose turn to propose
      proposal: null,               // [seatIndices] currently proposed team
      voteRejectCount: 0,           // consecutive rejected proposals this quest
      votes: null,                  // {seat: "approve"|"reject"} in progress
      questCards: null,             // {seat: "success"|"fail"} in progress
      winner: null,                 // "good" | "evil" once decided
      winReason: null,
      log: []                        // human-readable event log (public-safe)
    };
  }

  function currentQuestSize(g) { return questSize(g.playerCount, g.questNumber); }
  function leaderSeat(g) { return g.players[g.leaderIdx].seat; }
  function roleOf(g, seat) { const d = g.deal.find(x => x.seat === seat); return d ? d.role : null; }
  function teamOf(g, seat) { const r = roleOf(g, seat); return r ? ROLES[r].t : null; }
  function nextLeader(g) { g.leaderIdx = (g.leaderIdx + 1) % g.playerCount; }

  /* ---- PROPOSAL ---- */
  /* Leader proposes a team (array of seat indices). Validates size + membership. */
  function proposeTeam(g, byToken, seats, tokenSeatMap) {
    if (g.phase !== "proposal") return { ok: false, error: "Not in the proposal phase." };
    const bySeat = tokenSeatMap(byToken);
    if (bySeat !== leaderSeat(g)) return { ok: false, error: "Only the current leader may propose." };
    const size = currentQuestSize(g);
    const uniq = Array.from(new Set(seats));
    if (uniq.length !== size) return { ok: false, error: `The team must have exactly ${size} members.` };
    if (!uniq.every(s => g.players.some(p => p.seat === s))) return { ok: false, error: "Invalid team member." };
    g.proposal = uniq.slice();
    g.phase = "vote";
    g.votes = {};
    g.log.push(`${nameOfSeat(g, leaderSeat(g))} proposed a team of ${size}.`);
    return { ok: true };
  }

  function nameOfSeat(g, seat) { const p = g.players.find(x => x.seat === seat); return p ? p.name : "?"; }

  /* ---- VOTE ---- */
  /* Every player votes approve/reject on the current proposal. */
  function castVote(g, seat, vote) {
    if (g.phase !== "vote") return { ok: false, error: "Not voting right now." };
    if (vote !== "approve" && vote !== "reject") return { ok: false, error: "Invalid vote." };
    if (!g.players.some(p => p.seat === seat)) return { ok: false, error: "Not a player." };
    g.votes[seat] = vote;
    const done = g.players.every(p => g.votes[p.seat]);
    if (!done) return { ok: true, complete: false };
    // tally
    const approve = g.players.filter(p => g.votes[p.seat] === "approve").length;
    const reject = g.playerCount - approve;
    const passed = approve > reject;               // strict majority approves
    const record = { proposal: g.proposal.slice(), votes: { ...g.votes }, approve, reject, passed };
    // persist the completed vote for public history (Avalon votes are public).
    // Recorded ONLY here, after every player has voted — never mid-vote — so it
    // cannot leak an in-progress tally.
    g.voteHistory.push({
      questNumber: g.questNumber,
      round: g.voteRejectCount + 1,               // which proposal attempt on this quest
      leaderSeat: leaderSeat(g),
      proposal: g.proposal.slice(),
      votes: { ...g.votes },
      approve, reject, passed
    });
    if (passed) {
      g.phase = "quest";
      g.questCards = {};
      g.voteRejectCount = 0;
      g.log.push(`The team was approved (${approve}–${reject}).`);
      return { ok: true, complete: true, passed: true, record };
    } else {
      g.voteRejectCount += 1;
      g.log.push(`The team was rejected (${approve}–${reject}).`);
      g.proposal = null;
      g.votes = null;
      // five consecutive rejects on the same quest => evil wins
      if (g.voteRejectCount >= 5) {
        g.phase = "over"; g.winner = "evil"; g.winReason = "Five teams were rejected in a row.";
        g.log.push("Five rejected proposals — evil prevails.");
        return { ok: true, complete: true, passed: false, gameOver: true, record };
      }
      nextLeader(g);
      g.phase = "proposal";
      return { ok: true, complete: true, passed: false, record };
    }
  }

  /* ---- QUEST ---- */
  /* Only proposed team members submit a quest card. Good MUST play success;
     the engine enforces that a success-only role cannot fail. */
  function submitQuestCard(g, seat, card) {
    if (g.phase !== "quest") return { ok: false, error: "No quest in progress." };
    if (!g.proposal.includes(seat)) return { ok: false, error: "You are not on this quest." };
    if (card !== "success" && card !== "fail") return { ok: false, error: "Invalid card." };
    // Good players cannot play fail (rulebook). Enforce server-side.
    if (card === "fail" && teamOf(g, seat) === "good") {
      return { ok: false, error: "You cannot play Fail." };
    }
    g.questCards[seat] = card;
    const done = g.proposal.every(s => g.questCards[s]);
    if (!done) return { ok: true, complete: false };
    // resolve
    const fails = g.proposal.filter(s => g.questCards[s] === "fail").length;
    const needTwo = questNeedsTwoFails(g.playerCount, g.questNumber);
    const failed = needTwo ? fails >= 2 : fails >= 1;
    const result = failed ? "fail" : "success";
    g.questResults.push(result);
    g.log.push(`Quest ${g.questNumber} ${failed ? "failed" : "succeeded"} (${fails} fail${fails === 1 ? "" : "s"}).`);
    const record = { questNumber: g.questNumber, result, fails, team: g.proposal.slice() };
    // persist for public history: which team went, the outcome, and the fail count
    // (all of which are revealed at the table anyway when the quest resolves).
    g.questHistory.push({ questNumber: g.questNumber, result, fails, team: g.proposal.slice() });
    // check overall standing
    const successes = g.questResults.filter(r => r === "success").length;
    const failures = g.questResults.filter(r => r === "fail").length;
    g.questCards = null;
    g.proposal = null;
    if (failures >= 3) {
      g.phase = "over"; g.winner = "evil"; g.winReason = "Three quests failed.";
      return { ok: true, complete: true, result, record, gameOver: true };
    }
    if (successes >= 3) {
      // good has won the quests — assassination stage if an Assassin (and Merlin) are in play
      const hasAssassin = g.deal.some(d => d.role === "assassin");
      const hasMerlin = g.deal.some(d => d.role === "merlin");
      if (hasAssassin && hasMerlin) {
        g.phase = "assassination";
        g.log.push("Three quests succeeded — the Assassin now seeks Merlin.");
        return { ok: true, complete: true, result, record, toAssassination: true };
      }
      g.phase = "over"; g.winner = "good"; g.winReason = "Three quests succeeded.";
      return { ok: true, complete: true, result, record, gameOver: true };
    }
    // otherwise advance to next quest
    g.questNumber += 1;
    g.voteRejectCount = 0;
    nextLeader(g);
    g.phase = "proposal";
    return { ok: true, complete: true, result, record };
  }

  /* ---- ASSASSINATION ---- */
  /* The Assassin names a target seat. If it's Merlin, evil steals the game. */
  function assassinate(g, byToken, targetSeat, tokenSeatMap) {
    if (g.phase !== "assassination") return { ok: false, error: "Not the assassination phase." };
    const bySeat = tokenSeatMap(byToken);
    if (roleOf(g, bySeat) !== "assassin") return { ok: false, error: "Only the Assassin may strike." };
    if (!g.players.some(p => p.seat === targetSeat)) return { ok: false, error: "Invalid target." };
    const targetRole = roleOf(g, targetSeat);
    const hitMerlin = targetRole === "merlin";
    g.phase = "over";
    g.winner = hitMerlin ? "evil" : "good";
    g.winReason = hitMerlin
      ? `The Assassin found Merlin (${nameOfSeat(g, targetSeat)}). Evil wins.`
      : `The Assassin missed — ${nameOfSeat(g, targetSeat)} was not Merlin. Good wins.`;
    g.log.push(g.winReason);
    return { ok: true, gameOver: true, hitMerlin, targetSeat };
  }

  /*
   * The public, broadcast-safe view of a game in progress. Contains NO roles
   * (except at game end, when everything is revealed). This is what every client
   * may see. Per-player private data (their own role/knowledge, and their private
   * quest-card choice) is delivered separately by the server.
   */
  function publicGameView(g) {
    const base = {
      phase: g.phase,
      questNumber: g.questNumber,
      questSize: currentQuestSize(g),
      questResults: g.questResults.slice(),
      needsTwoFails: questNeedsTwoFails(g.playerCount, g.questNumber),
      leaderSeat: leaderSeat(g),
      leaderName: nameOfSeat(g, leaderSeat(g)),
      proposal: g.proposal ? g.proposal.slice() : null,
      voteRejectCount: g.voteRejectCount,
      players: g.players.map(p => ({ seat: p.seat, name: p.name })),
      log: g.log.slice(-12),
      // public deduction history — both are only ever appended AFTER a vote or
      // quest completes, so they contain no in-progress secrets. Votes are public
      // in Avalon; quest teams and fail counts are revealed when a quest resolves.
      voteHistory: g.voteHistory.slice(),
      questHistory: g.questHistory.slice(),
      winner: g.winner,
      winReason: g.winReason
    };
    // during voting, show who has voted (not how) until all in, then reveal tally
    if (g.phase === "vote" && g.votes) {
      base.votedSeats = Object.keys(g.votes).map(Number);
    }
    // at game end, reveal all roles
    if (g.phase === "over") {
      base.reveal = g.deal.map(d => ({ seat: d.seat, name: d.player, role: d.role, roleName: ROLES[d.role].n, team: ROLES[d.role].t }));
    }
    return base;
  }

  return {
    ROLES, EVIL_COUNT, NO_INFO_ROLES,
    shuffle, hasRole, playersWithRole, isVariantLancelot,
    rolePool, dealRoles,
    buildQueue,
    evilSeen, merlinSees, knowledgeFor,
    balanceWarnings, roleTotal,
    // Phase 3
    QUEST_SIZES, questSize, questNeedsTwoFails,
    createGame, currentQuestSize, leaderSeat, roleOf, teamOf,
    proposeTeam, castVote, submitQuestCard, assassinate,
    publicGameView,
    VERSION: "core-1.1.0"
  };
});
