/*
 * test-a11y.js — Step 7 accessibility regression guard.
 * Static checks over the served client HTML: the live region exists, zoom is not
 * disabled, interactive non-button elements are keyboard-accessible, inputs are
 * labelled, and the error state isn't color-only. Run: node test-a11y.js
 */
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL  " + label); } };

// live region for server-driven announcements
ok("aria-live status region present", /id="sr-live"[^>]*aria-live="polite"/.test(html));
ok("live region uses role=status", /id="sr-live"[^>]*role="status"/.test(html));
ok("sr-only utility class defined", /\.sr-only\{[^}]*clip:rect\(0,0,0,0\)/.test(html));

// pinch-zoom NOT disabled
ok("viewport does not disable zoom", !/user-scalable=no/.test(html));
ok("viewport meta present", /name="viewport"/.test(html));

// reveal card is keyboard-operable
ok("reveal card has role=button", /id="rev-card"[^>]*role="button"/.test(html));
ok("reveal card is focusable (tabindex)", /id="rev-card"[^>]*tabindex="0"/.test(html));
ok("reveal card has a keydown handler", /id="rev-card"[^>]*onkeydown=/.test(html));
ok("reveal card has an aria-label", /id="rev-card"[^>]*aria-label=/.test(html));

// picker seats keyboard-operable (template strings in JS)
ok("propose picker seats have role=button", /class="st pick[^"]*"\s+role="button"/.test(html));
ok("propose picker seats keyboard handler", /togglePick\(\$\{p\.seat\}\);\}/.test(html));
ok("propose picker seats aria-pressed", /aria-pressed="\$\{proposePick\.includes/.test(html));
ok("assassin targets keyboard handler", /doAssassinate\(\$\{p\.seat\}\);\}/.test(html));

// inputs labelled
ok("name input labelled", /id="name"[^>]*aria-label=/.test(html));
ok("join code input labelled", /id="joincode"[^>]*aria-label=/.test(html));
ok("rename input labelled", /id="rename-input"[^>]*aria-label=/.test(html));

// kick button labelled (not just an ✕ glyph)
ok("kick button has aria-label", /class="kickx"[^>]*aria-label=/.test(html));

// error signalling is not color-only (icon prefix on status.err, icon in toast)
ok("status error has an icon prefix", /\.status\.err::before\{content:"⚠/.test(html));
ok("toast carries a warning icon", /id="toast-icon"/.test(html));

// announce() helper wired
ok("announce() helper present", /function announce\(/.test(html));
ok("phase changes are announced", /function announceGame\(/.test(html));

console.log(`\nStep 7 accessibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
