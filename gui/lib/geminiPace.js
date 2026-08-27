// gui/lib/geminiPace.js
//
// How fast this repo may talk to Gemini, and when to change keys before it has
// to.
//
// A JavaScript port of ClipPipeline's `foundation/gemini_pace.py`, whose rule
// the owner set on 2026-08-07: "when we do calls make sure we wait 12s per call
// to not trip the 5calls/min limit window, and anticipate the rolling keys when
// we hit 20".
//
// Two separate mechanisms, and they fail differently:
//
//   - The INTERVAL answers a rolling-window limit. 60 / 12 = 5, so twelve
//     seconds between calls is exactly five a minute — the ceiling, not a
//     margin under it. Raise `minIntervalMs` if the window ever bites.
//   - The KEY BUDGET is a per-key count, and rotating on it is ANTICIPATION.
//     The ring already rotates on a 429 — but that means the call which
//     discovers the ceiling is a call that FAILED, and in this pipeline a
//     failure lands in the middle of a batch of fifty pages.
//
// It counts CALLS, not batches. A gate that counts batches has to be re-tuned
// every time the shape of a batch changes, and nothing tells you when it
// should be.
//
// NOTHING HERE READS A KEY. The caller passes an opaque id — a fingerprint, not
// a label and never a value — so this module imports no ring and no client and
// stays a clock plus a counter.
"use strict";

// Milliseconds between the START of one call and the start of the next.
//
// Twice-sourced, which is why it is not a guess: the owner asked for 12s, and
// ClipPipeline has enforced 12.0s + 5/min since its clip path was written.
const DEFAULT_MIN_INTERVAL_MS = 12000;

// Calls one key may serve before this rotates OFF it. Anticipation: the 21st
// call is the one that would otherwise have discovered the ceiling by failing.
// The GUI's `dailyQuotaTarget` overrides it, since that setting is the owner
// saying what a key's day holds.
const DEFAULT_CALLS_PER_KEY = 20;

let ENABLED = true;

function setEnabled(value) {
  ENABLED = Boolean(value);
}

class Pace {
  constructor({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
                callsPerKey = DEFAULT_CALLS_PER_KEY } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.callsPerKey = callsPerKey;
    this.lastStartedAt = null;      // ms, or null before the first call
    this.callsByKey = new Map();    // opaque key id -> calls this process spent
    // The queue that makes `reserve` atomic. Every reservation awaits the
    // previous one, so "read the clock, wait, then record" cannot interleave.
    this._chain = Promise.resolve();
  }

  /** Re-read the budget when the owner changes it in settings mid-session. */
  configure({ callsPerKey } = {}) {
    if (Number.isFinite(callsPerKey) && callsPerKey > 0) this.callsPerKey = callsPerKey;
  }

  /**
   * True when `keyId` has served its budget and the NEXT call should not use it.
   *
   * Asked BEFORE the call rather than after, so the rotation happens between
   * two calls instead of inside a failed one.
   */
  dueForRotation(keyId) {
    return (this.callsByKey.get(keyId) || 0) >= this.callsPerKey;
  }

  /** Calls charged to `keyId`, or to the whole process when asked for nothing. */
  spent(keyId = null) {
    if (keyId === null) {
      let total = 0;
      for (const count of this.callsByKey.values()) total += count;
      return total;
    }
    return this.callsByKey.get(keyId) || 0;
  }

  noteCall(keyId) {
    this.callsByKey.set(keyId, (this.callsByKey.get(keyId) || 0) + 1);
    this.lastStartedAt = Date.now();
  }

  /** Forget a key's count — called after rotating onto a fresh one. */
  clearKey(keyId) {
    this.callsByKey.delete(keyId);
  }

  /** Milliseconds still owed to the rate window, or 0. */
  owed() {
    if (!ENABLED || this.lastStartedAt === null) return 0;
    return Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartedAt));
  }

  /**
   * Take the next slot in the rate window: wait for it, then claim it.
   *
   * ONE method rather than `owed()` + `waitTurn()` + `noteCall()`, because
   * those three read and wrote `lastStartedAt` without holding anything in
   * between. Two `/api/process-stream` requests could each read the same
   * `lastStartedAt`, wait the same interval, and fire together — a gate that
   * two callers pass simultaneously is not a gate. Reservations now queue on
   * `_chain`, so the second caller's wait starts when the first one's slot
   * closes.
   *
   * `onWait` gets the milliseconds owed BEFORE the sleep, so a caller can show
   * a countdown rather than going quiet. Returns the milliseconds waited.
   */
  async reserve(keyId, onWait = null) {
    const prior = this._chain;
    let release;
    this._chain = new Promise((resolve) => { release = resolve; });
    try {
      await prior;
      const owed = this.owed();
      if (owed > 0) {
        if (onWait) onWait(owed);
        await new Promise((resolve) => setTimeout(resolve, owed));
      }
      this.noteCall(keyId);
      return owed;
    } finally {
      release();
    }
  }

  /**
   * Block until `minIntervalMs` has passed since the last call started.
   *
   * Kept for a caller that only wants the wait — `reserve` is the one that
   * makes waiting and claiming a single step, and it is what the clients use.
   */
  async waitTurn() {
    const owed = this.owed();
    if (owed <= 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, owed));
    return owed;
  }
}

module.exports = {
  Pace,
  setEnabled,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_CALLS_PER_KEY,
};
