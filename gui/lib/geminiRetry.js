// gui/lib/geminiRetry.js
//
// How long this repo waits out a Gemini fault, and which faults deserve waiting
// out at all.
//
// A JavaScript port of ClipPipeline's `foundation/gemini_retry.py`, written
// there on 2026-08-13 after the same failure twice. This repo carried the bug
// that module was written to fix: `generateContentWithRetry` retried five times
// on `2000 * 2**attempt`, which comes to waits of 2s, 4s, 8s and 16s — THIRTY
// SECONDS of patience against a 503 whose own message calls it a demand spike,
// and which the other repo measured lasting minutes.
//
// The owner's terms, which set every number below: "I don't mind waiting an
// extra minute or two or however long it takes, as long as I can just come back
// and it's done exactly as it should." So patience gets measured in TEN
// MINUTES, and the thing that must never happen is a run that gives up while
// the API was merely busy.
//
// ## Why the split matters more than the budget
//
// Three faults used to arrive through one `if (isTransient)` and spend one
// budget:
//
//   | fault                          | waiting helps? | what to do instead |
//   |--------------------------------|----------------|--------------------|
//   | 503 / 500 / dropped connection | YES, it clears | back off and retry |
//   | 429 / RESOURCE_EXHAUSTED       | no, key is dry | ROTATE the key     |
//   | 403 / bad key / bad request    | never          | stop and say so    |
//
// Sharing one budget means a 503 spends attempts a malformed reply needed, and
// a dry key spends thirty seconds and five requests proving something it
// announced in its first sentence. `classify` is the whole point of this
// module; `PATIENCE_MS` is just a number underneath it.
//
// No client, no network, no key, no prompt. It reads an error and a clock and
// returns numbers.
"use strict";

const keyRing = require("./keyRing");

// What `classify` answers. Named rather than spelled at each call site, because
// a string typo in a comparison fails by taking the wrong branch in silence.
const TRANSIENT = "transient";
const QUOTA = "quota";
const FATAL = "fatal";

// Milliseconds of patience for ONE call, across all its transient attempts.
//
// The owner's ten minutes. Long enough to sit out every demand spike measured
// so far, and short enough that a genuine outage still hands the GUI back
// inside a coffee. The budget gets spent in WALL CLOCK rather than in attempts
// alone: a doubling schedule overshoots an attempt ceiling by minutes, and "how
// long will this sit there" is the question being answered.
const PATIENCE_MS = 600000;

// Transient tries for one call. The schedule below sums to 585s over its seven
// waits, so this and `PATIENCE_MS` run out together by construction — two
// ceilings that disagree mean one of them is decoration.
const MAX_TRANSIENT_ATTEMPTS = 8;

// The first back-off, and the ceiling one back-off may reach. 15 → 30 → 60 →
// 120 → 120…: long enough that the third try lands well clear of a spike,
// capped because a wait longer than two minutes buys nothing an extra attempt
// would not buy better.
const FIRST_DELAY_MS = 15000;
const DELAY_CAP_MS = 120000;

// Full jitter, floored. Two streams that hit one spike must not come back in
// lockstep and make a second one. Floored at half rather than at zero so a
// jittered wait stays a wait — a uniform draw can return 0.3s, which reads as a
// hammer rather than a back-off.
const JITTER_FLOOR = 0.5;

// HTTP statuses that mean "ask again, it is us, not you".
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504, 509, 529]);

// 429 sits HERE and deliberately not above, though every HTTP table lists it as
// retryable: on a free key it means the key is dry, and the answer is to rotate
// rather than to wait out a ceiling that resets tomorrow. A caller with no
// second key may still fall back to waiting — a per-MINUTE 429 does clear — but
// that stays the caller's decision to take with the ring in hand, not this
// module's to take blind.
const QUOTA_STATUSES = new Set([429]);

// Faults carrying no status at all — a socket that closed, a read that timed
// out, a proxy that hung up. Matched on the error's type name and text
// together, the way `keyRing` matches its own markers.
const TRANSIENT_MARKERS = [
  "unavailable", "internal error", "deadline_exceeded", "deadline exceeded",
  "timed out", "timeout", "temporarily unavailable", "overloaded",
  "high demand", "try again later", "connection reset", "connection aborted",
  "connection refused", "econnreset", "econnrefused", "etimedout", "epipe",
  "enotfound", "eai_again", "socket hang up", "network error", "fetch failed",
  "server disconnected", "broken pipe", "service unavailable",
];

// Set false by tests to take the clock out of the loop. A real sleep inside a
// suite is not a trade worth making.
let ENABLED = true;

function setEnabled(value) {
  ENABLED = Boolean(value);
}

/** Indirected so a test can drive the clock rather than wait on it. */
function now() {
  return Date.now();
}

function text(error) {
  const name = (error && error.constructor && error.constructor.name) || "Error";
  const message = error && error.message !== undefined ? error.message : String(error);
  return `${name} ${message}`.toLowerCase();
}

/**
 * The HTTP status this error carries, or null.
 *
 * Read from the error's own field first and its text second. The Node SDK sets
 * `.status` on `GoogleGenerativeAIFetchError` and opens the message with
 * `Error fetching from <url>: [503 Service Unavailable] …`, so the bracket form
 * matters here where the Python sibling anchors on a LEADING code instead — the
 * one place the two ports genuinely differ, because the two SDKs genuinely do.
 *
 * A bare substring search for "503" would match a token count, an elapsed
 * figure, or a request id. Anchored patterns only.
 */
function statusOf(error) {
  for (const field of ["status", "statusCode", "code"]) {
    const value = error ? error[field] : undefined;
    if (typeof value === "number" && value >= 100 && value <= 599) return value;
  }

  const raw = error && error.message !== undefined ? String(error.message) : String(error);
  const bracketed = raw.match(/\[\s*(\d{3})\s/);          // [503 Service Unavailable]
  if (bracketed) return Number(bracketed[1]);
  const leading = raw.match(/^\s*(\d{3})\b/);             // 503 UNAVAILABLE …
  if (leading) return Number(leading[1]);
  const coded = raw.match(/["']code["']\s*:\s*(\d{3})\b/); // {"code": 503, …}
  if (coded) return Number(coded[1]);
  return null;
}

/**
 * `TRANSIENT`, `QUOTA` or `FATAL` — see the table in the module header.
 *
 * An unrecognised error classifies FATAL on purpose. Waiting ten minutes on a
 * fault nobody has seen before is worse than reporting it in the first second:
 * the report is how it becomes recognised.
 */
function classify(error) {
  const status = statusOf(error);
  if (status !== null) {
    if (QUOTA_STATUSES.has(status)) return QUOTA;
    if (TRANSIENT_STATUSES.has(status)) return TRANSIENT;
    return FATAL;
  }

  // Order matters and `keyRing` already settled it: a 429 reads as a DRY key,
  // never a dead one, and `isDeadKeyError` returns false for anything a quota
  // marker matched.
  if (keyRing.isQuotaError(error)) return QUOTA;
  if (keyRing.isDeadKeyError(error)) return FATAL;

  const haystack = text(error);
  if (TRANSIENT_MARKERS.some((marker) => haystack.includes(marker))) return TRANSIENT;
  return FATAL;
}

/**
 * The wait Gemini itself asked for, in milliseconds, or null.
 *
 * A 429 body carries `"retryDelay": "35s"`. When the server has named a number
 * it knows something the schedule below does not, so it wins.
 */
function retryAfter(error) {
  const raw = error && error.message !== undefined ? String(error.message) : String(error);
  const asked = raw.match(/retry[-_ ]?(?:delay|after)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*s?/i);
  if (!asked) return null;
  const ms = Number(asked[1]) * 1000;
  return ms > 0 && ms <= PATIENCE_MS ? ms : null;
}

/**
 * Milliseconds to wait before transient attempt number `attempt` + 1.
 *
 * `attempt` counts from 1 — the number of transient failures seen so far. A
 * wait the server ASKED for wins over the schedule; otherwise the schedule
 * doubles from `FIRST_DELAY_MS` to `DELAY_CAP_MS` and gets jittered down.
 * `jitter` is injectable so a test reads a schedule rather than a range.
 */
function delayFor(attempt, error = null, jitter = null) {
  const asked = error ? retryAfter(error) : null;
  if (asked !== null) return asked;
  const base = Math.min(FIRST_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)), DELAY_CAP_MS);
  const factor = jitter === null ? JITTER_FLOOR + Math.random() * (1 - JITTER_FLOOR) : jitter;
  return Math.round(base * factor);
}

/** `7m 41s`, for a message someone reads while deciding whether to wait. */
function describe(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function sleep(ms) {
  if (!ENABLED || ms <= 0) return Promise.resolve(0);
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms));
}

/**
 * One call's worth of waiting, and the move to make at each failure.
 *
 * The functions above answer questions; this holds the counters that make the
 * answers add up over a whole call — how long it has been going, how many
 * transient tries it has spent, how much of the key ring it has walked.
 *
 * Three moves, and the caller does the acting:
 *
 *   - ROTATE — a dry key with somewhere to go. The caller swaps keys and asks
 *     again AT ONCE, spending no transient try, because the next key has had no
 *     attempt of its own yet.
 *   - WAIT — the server is busy, or the key is dry with no ring behind it (a
 *     per-MINUTE 429 does clear). `afford()` prices the wait and says whether
 *     the budget allows it.
 *   - STOP — a refused key, a bad request, an unrecognised fault, or a ring
 *     walked and dry. None of those change by being asked again.
 */
class Patience {
  constructor(ringSize = 1) {
    this.started = now();
    this.transient = 0;
    this.rotations = 0;
    // Rotations this call may spend: each OTHER key gets one shot at it.
    this.maxRotations = Math.max(0, (ringSize || 1) - 1);
    this.lastDelay = 0;
    // Every HTTP request this call really sent, successes and failures alike.
    // The old stats meter counted one call as one call however many requests it
    // took, which is how a 20-call ceiling got read as 20% full at 40%.
    this.requests = 0;
  }

  /** Charge one HTTP request. Called just before each attempt goes out. */
  sent() {
    this.requests += 1;
    return this.requests;
  }

  /**
   * `ROTATE`, `WAIT` or `STOP` for one failed attempt.
   *
   * Rotating and waiting answer two different questions, and a fault can say
   * yes to one and no to the other. A REVOKED key (403) classifies FATAL here —
   * no amount of waiting revives it — and still rotates, because another key
   * would plainly serve. `keyRing.shouldRotate` owns that judgement; asking it
   * rather than re-deriving it keeps the two answers from drifting apart.
   */
  consider(error) {
    const kind = classify(error);

    if (keyRing.shouldRotate(error)) {
      if (this.rotations < this.maxRotations) return Patience.ROTATE;
      // A ring already walked is a ring with no room in it, and waiting cannot
      // find a key that has some — the ceiling it would sit out resets
      // tomorrow. With no ring at all, a dry key is still worth waiting on,
      // because a per-MINUTE 429 really does clear.
      if (this.maxRotations || kind !== QUOTA) return Patience.STOP;
      return Patience.WAIT;
    }

    return kind === TRANSIENT ? Patience.WAIT : Patience.STOP;
  }

  /** Charge one rotation. Called after the caller's swap succeeded. */
  rotated() {
    this.rotations += 1;
  }

  /**
   * Charge one transient try and price its delay. False when out of budget.
   *
   * Prices it WITHOUT taking it, so the caller can show the countdown before
   * the GUI goes quiet — a run that sits silent for two minutes reads as a
   * hang. Refuses a wait that would FINISH past the ceiling rather than one
   * that starts past it, so a call gives up at ten minutes instead of at ten
   * minutes plus one delay.
   */
  afford(error = null) {
    this.transient += 1;
    this.lastDelay = delayFor(this.transient, error);
    if (this.transient >= MAX_TRANSIENT_ATTEMPTS) return false;
    return this.spent() + this.lastDelay <= PATIENCE_MS;
  }

  /** Take the delay `afford` priced. */
  rest() {
    return sleep(this.lastDelay);
  }

  spent() {
    return Math.max(0, now() - this.started);
  }

  left() {
    return Math.max(0, PATIENCE_MS - this.spent());
  }

  /** What to show before sleeping. Reads as a countdown, not a symptom. */
  waitingLine(error) {
    const label = statusOf(error) || (error && error.constructor && error.constructor.name) || "error";
    return `Gemini is busy (${label}). Waiting ${Math.round(this.lastDelay / 1000)}s, ` +
      `then attempt ${this.transient + 1}/${MAX_TRANSIENT_ATTEMPTS} — ` +
      `${describe(this.left())} of patience left.`;
  }

  /** What to show when the call is over. Says which ceiling got hit. */
  closingLine(error) {
    const why = error && error.message ? error.message : String(error);
    if (this.transient) {
      return `Gemini stayed unavailable for ${describe(this.spent())} across ` +
        `${this.transient} attempts: ${why}`;
    }
    if (this.rotations) return `Every key in the ring is out of room: ${why}`;
    return `Gemini refused this call: ${why}`;
  }
}

Patience.ROTATE = "rotate";
Patience.WAIT = "wait";
Patience.STOP = "stop";

module.exports = {
  TRANSIENT, QUOTA, FATAL,
  PATIENCE_MS, MAX_TRANSIENT_ATTEMPTS, FIRST_DELAY_MS, DELAY_CAP_MS,
  TRANSIENT_STATUSES, QUOTA_STATUSES,
  classify, statusOf, retryAfter, delayFor, describe, sleep, now,
  setEnabled, Patience,
};
