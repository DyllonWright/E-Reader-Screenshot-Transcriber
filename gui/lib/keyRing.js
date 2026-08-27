// gui/lib/keyRing.js
//
// The `.env` key ring: several Gemini keys, one active, rotate when one runs dry.
//
// A JavaScript port of mission-control's `shared/env-key-ring/env_key_ring.py`,
// which itself came out of ClipPipeline's `foundation/gemini_keys.py` (live
// since 2026-07-26). The semantics match so a fix in one language stays
// portable to the other; where they differ, a comment says why.
//
// The free tier gives a handful of calls a minute and a few dozen a day, so the
// owner keeps several keys in `.env` — one per account — with the spares
// commented out and a label above each:
//
//     # Adam
//     GEMINI_API_KEY=AIza...
//     # D Data
//     #GEMINI_API_KEY=AIza...
//
// That layout IS the state. No database, no lock file, no sidecar. On a 429 the
// ring comments the dry key out, uncomments the next one, and rewrites the file
// — so tomorrow's run STARTS on a key with room instead of rediscovering the
// exhausted one.
//
// Three rules the rewrite follows:
//
//   * Never lose a key. Lines, order, labels, spacing and line endings survive
//     exactly; only the `#` in front of a `GEMINI_API_KEY=` line ever moves. A
//     backup lands at `.env.bak` before the first rewrite of a session.
//   * Exactly one active. Anything else reads as ambiguous — dotenv takes the
//     last one and the label above it becomes a lie.
//   * Duplicates get dropped, first occurrence wins. One key on two lines
//     otherwise makes a rotation look like it moved on when it landed back on
//     the key that just failed.
//
// Values never get printed. A key appears in output as its label plus a short
// fingerprint.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// What the API says when a key has no room left for the day (or the minute).
// Temporary — the key works again tomorrow.
const QUOTA_MARKERS = [
  "resource_exhausted", "quota", "rate limit", "429",
  "rate_limit_exceeded", "exceeded your current quota", "insufficient_quota",
];

// What it says when the key itself gets refused — revoked, wrong project, or a
// banned account. Permanent, and worth telling apart from a dry key: retrying a
// revoked key spends the whole back-off budget on an answer that never changes.
// Observed 2026-07-26 on one of the owner's keys:
// "403 PERMISSION_DENIED ... Your project has been denied access."
//
// "401" and "403" match as substrings, so a message carrying "1403" reads as a
// dead key. Kept deliberately: a false positive costs one wasted rotation, a
// miss costs a run that retries a revoked key until its budget runs out.
const DEAD_MARKERS = [
  "permission_denied", "denied access", "api key not valid",
  "api_key_invalid", "invalid_api_key", "unauthenticated", "401", "403",
];

const UNLABELLED = "(unlabelled)";

// Separators differ across the three places a verdict hides: a message
// ("rate limit"), a status enum ("RATE_LIMIT_EXCEEDED") and a class name
// ("RateLimitError"). Squashing them out of both sides lets ONE marker list
// read all three.
const SEPARATORS = /[\s_\-.]+/g;

function squash(text) {
  return String(text).toLowerCase().replace(SEPARATORS, "");
}

// The error as the two strings a marker gets tested against. The constructor
// name and the status field both go in because some SDKs put the whole verdict
// outside the message — Google's `GoogleGenerativeAIFetchError` carries the
// code on `.status` — so matching the message alone misses a dry key on the
// client that reports it most clearly.
function haystacks(error) {
  const name = (error && error.constructor && error.constructor.name) || "Error";
  const status = error && error.status !== undefined ? ` ${error.status}` : "";
  const message = error && error.message !== undefined ? error.message : String(error);
  const raw = `${name}${status} ${message}`.toLowerCase();
  return [raw, squash(raw)];
}

function matches(error, markers) {
  const [raw, squashed] = haystacks(error);
  return markers.some((m) => raw.includes(m) || squashed.includes(squash(m)));
}

// A short, stable, non-reversible handle for a key. Safe to print, and safe to
// write into a stats file that gets committed.
//
// The FINGERPRINT rather than the label wherever a key gets identified in a log
// or a budget counter: a label is editable in `.env` and two could collide,
// which merges two keys' budgets into one counter and lets the second sail past
// its ceiling.
function fingerprint(key) {
  return crypto.createHash("sha256").update(String(key || ""), "utf8")
    .digest("hex").slice(0, 8);
}

/**
 * A label with its middle starred out — enough to recognise, not to read.
 *
 * Labels in a personal ring are account names, usually the email the key was
 * minted under. Printing thirteen of them in the GUI put the owner's whole
 * account list on screen, in the `/api/status` JSON, and in any screenshot or
 * screen share. None of that is a key, and all of it is nobody's business.
 *
 * Keeps the first two characters and the domain, since recognising WHICH
 * account is live is the entire job of this string:
 *
 *     sanders.llc147@gmail.com  ->  sa••••••••••@gmail.com
 *     daathdata #2              ->  da••••••••
 */
function redactLabel(label) {
  const text = String(label == null ? "" : label).trim();
  // A key with no label has nothing to hide, and `(u••••••••••` reads as a
  // bug rather than as discretion.
  if (!text || text === UNLABELLED) return UNLABELLED;

  const at = text.lastIndexOf("@");
  if (at > 0) {
    const local = text.slice(0, at);
    const domain = text.slice(at);           // includes the "@"
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${"•".repeat(Math.max(3, local.length - head.length))}${domain}`;
  }
  const head = text.slice(0, Math.min(2, text.length));
  return `${head}${"•".repeat(Math.max(3, text.length - head.length))}`;
}

/**
 * Strip anything key-shaped out of text bound for a file or a log.
 *
 * Lives HERE rather than beside one caller because both clients write error
 * messages into `gemini_stats.json`, and for a while only the GUI scrubbed
 * them — the CLI wrote `error.message` raw. A guard that half the callers
 * apply is a guard nobody can rely on.
 *
 * Nothing observed so far puts a key in an error message (the SDK sends it as
 * a header, and its URLs carry no `?key=`), so treat this as insurance against
 * a future SDK that does.
 */
function scrubSecrets(text) {
  return String(text == null ? "" : text)
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key redacted]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
}

/** Whether this error says the key ran out rather than the call broke. */
function isQuotaError(error) {
  return matches(error, QUOTA_MARKERS);
}

/**
 * Whether the key itself gets refused — revoked, wrong project, banned.
 *
 * Quota wins the tie. A 429 is a dry key, never a dead one, and reading it as
 * dead would drop a perfectly good key out of the ring for the rest of the run.
 */
function isDeadKeyError(error) {
  if (matches(error, QUOTA_MARKERS)) return false;
  return matches(error, DEAD_MARKERS);
}

/**
 * Whether another key could plausibly succeed where this one failed.
 *
 * True for a dry key and for a refused one; false for a broken connection or a
 * server fault, where every key fails the same way and rotating would spend the
 * whole ring on one bad minute.
 */
function shouldRotate(error) {
  return isQuotaError(error) || isDeadKeyError(error);
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split into lines that KEEP their endings, so a rewrite puts back exactly what
// it read. A `.env` that arrives CRLF and leaves LF shows up as a whole-file
// diff in whatever repo holds it — from a module whose first promise is that it
// moves one `#`. The Python original hit this bug; both carry the fix now.
function splitKeep(text) {
  if (!text) return [];
  return text.split(/(?<=\n)/);
}

function stripEnding(line) {
  return line.replace(/\r?\n$/, "");
}

function stripQuotes(value) {
  const trimmed = String(value == null ? "" : value).trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1] &&
      (trimmed[0] === '"' || trimmed[0] === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Where the ring reads, when nobody names a file.
 *
 * `ENV_KEY_RING_PATH` is mission-control's own convention (`ask_google.py`
 * reads the same variable), so pointing this repo at the shared ring is one
 * line in `.env` rather than a second copy of thirteen keys:
 *
 *     ENV_KEY_RING_PATH=C:/Users/<you>/.env-key-ring/keys.env
 *
 * That file uses this exact layout — it IS an `env_key_ring` ring — so the
 * parser needs nothing special to read it. Left unset, the project's own `.env`
 * holds the ring, which is what a fresh clone should do.
 */
function defaultRingPath(projectEnv, warn = console.warn) {
  const named = process.env.ENV_KEY_RING_PATH || process.env.GEMINI_KEY_RING_PATH;
  if (named) {
    if (fs.existsSync(named)) return named;
    // Say so rather than falling back in silence. A typo in this path used to
    // look exactly like a working single-key setup — the ring quietly held one
    // key instead of thirteen, and nothing anywhere said why.
    warn(`[Gemini Keys] ENV_KEY_RING_PATH points at "${named}", which does not exist. ` +
         `Falling back to ${path.basename(projectEnv)}.`);
  }
  return projectEnv;
}

/**
 * One `.env` variable's worth of keys, and the file that holds them.
 *
 * `varName` names the environment variable; `filePath` names the `.env`. `log`
 * takes anything callable that accepts one string — pass `() => {}` to silence
 * it, or an SSE emitter to put rotations in front of the user.
 */
class KeyRing {
  constructor({ varName = "GEMINI_API_KEY", filePath = null, log = console.log } = {}) {
    this.var = String(varName);
    // An EXPLICIT `filePath` always wins — `defaultRingPath` decides only when
    // the caller expressed no preference. A test handing this a temp file must
    // get that temp file, whatever `ENV_KEY_RING_PATH` happens to say.
    this.path = filePath || defaultRingPath(path.join(__dirname, "..", "..", ".env"));
    this.log = log || (() => {});
    // Built per instance because the variable name is per instance — a
    // module-level regex is exactly what made the original single-provider.
    this._line = new RegExp(
      `^(\\s*)(#\\s*)?(${escapeRe(this.var)})\\s*=\\s*(.*?)\\s*$`
    );
  }

  // -- the file -----------------------------------------------------------

  _read() {
    try {
      // Node hands back the bytes as written, so CRLF survives the round trip
      // without the `newline=""` its Python sibling needs.
      return fs.readFileSync(this.path, "utf8");
    } catch (err) {
      return "";                     // a missing `.env` reads as an empty ring
    }
  }

  // Rewrite `.env` atomically, keeping ONE backup from before the first edit.
  //
  // One, not one per rotation: the file worth recovering is the file as the
  // owner last wrote it by hand, and a per-rotation backup overwrites that with
  // a machine-edited copy within a minute of the first failure.
  //
  // `.env.bak` and `.env.tmp` both carry real key values. `.gitignore` names
  // them explicitly, because the pattern `.env` matches that one name and
  // nothing else.
  _write(text) {
    const backup = `${this.path}.bak`;
    if (fs.existsSync(this.path) && !fs.existsSync(backup)) {
      fs.copyFileSync(this.path, backup);
    }
    // A UNIQUE temp name, not a fixed `.env.tmp`: the GUI and the CLI can both
    // be running, and two writers sharing one scratch path would have each
    // read the other's half-written bytes. `.gitignore` covers `.env.*`, so
    // every variant stays out of the repo.
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");

    // Windows fails a rename onto a file an editor, a sync client, or a
    // virus scanner holds open — with EPERM or EBUSY, and only for a moment.
    // Three quick tries beat losing the rotation.
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmp, this.path);
        return;
      } catch (err) {
        lastError = err;
        if (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "EACCES") break;
        const until = Date.now() + 100;
        while (Date.now() < until) { /* the write path is sync; so is the wait */ }
      }
    }
    try { fs.unlinkSync(tmp); } catch (err) { /* the temp file is already gone */ }
    throw lastError;
  }

  // -- reading ------------------------------------------------------------

  /**
   * Read the text into key entries, in file order.
   *
   * Each entry: `{label, key, active, index}`, `index` counting lines from 0. A
   * plain comment labels whatever key follows it; any other setting in between
   * clears the label, or `# Adam` five lines above an unrelated variable would
   * name the wrong key.
   */
  parse(text) {
    const lines = splitKeep(text);
    const entries = [];
    let label = null;

    lines.forEach((raw, index) => {
      const line = stripEnding(raw);
      const match = this._line.exec(line);
      if (match) {
        entries.push({
          label: label || UNLABELLED,
          key: stripQuotes(match[4]),
          active: !match[2],
          index,
        });
        label = null;
        return;
      }
      const stripped = line.trim();
      if (stripped.startsWith("#")) {
        label = stripped.replace(/^#+/, "").trim() || label;
      } else if (stripped) {
        label = null;                // some other setting — the label stops here
      }
    });
    return entries;
  }

  /** Every distinct key in the file, in file order. Deduped in memory. */
  ring() {
    const seen = new Set();
    const out = [];
    for (const entry of this.parse(this._read())) {
      if (!entry.key || seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push(entry);
    }
    return out;
  }

  /**
   * The key currently uncommented, or the first in the ring, or null.
   *
   * Falling back to the first entry means a file whose keys ALL sit commented
   * out still works — the ring is what matters, not which line lost its hash.
   */
  active() {
    const keys = this.ring();
    if (!keys.length) return null;
    return keys.find((e) => e.active) || keys[0];
  }

  /** The active key's value, or null. The one-liner most callers want. */
  key() {
    const entry = this.active();
    return entry ? entry.key : null;
  }

  /** How many distinct keys this ring holds. */
  size() {
    return this.ring().length;
  }

  // -- editing ------------------------------------------------------------

  /**
   * Drop repeated keys, keeping the first. Returns `{text, dropped}`.
   *
   * The failure this prevents: two lines carrying one key make the ring think
   * it moved on when `rotate` landed back on the key that just failed.
   */
  dedupe(text) {
    const lines = splitKeep(text);
    const seen = new Set();
    const drop = new Set();

    for (const entry of this.parse(text)) {
      if (!entry.key) continue;
      if (seen.has(entry.key)) drop.add(entry.index);
      else seen.add(entry.key);
    }

    if (!drop.size) return { text, dropped: 0 };
    const kept = lines.filter((_line, i) => !drop.has(i));
    return { text: kept.join(""), dropped: drop.size };
  }

  /**
   * The text with `key` the only uncommented one. Never reorders.
   *
   * Only the `#` moves, and each line keeps its own ending character for
   * character.
   */
  setActive(text, key) {
    const lines = splitKeep(text);

    for (const entry of this.parse(text)) {
      const line = lines[entry.index];
      const bare = stripEnding(line);
      const match = this._line.exec(bare);
      if (!match) continue;
      const ending = line.slice(bare.length);
      const wantActive = entry.key === key && entry.key !== "";
      if (wantActive === entry.active) continue;  // already the way it should be
      const prefix = wantActive ? "" : "#";
      lines[entry.index] = `${match[1]}${prefix}${this.var}=${match[4]}${ending}`;
    }
    return lines.join("");
  }

  /**
   * Move to the next usable key in the ring and persist it.
   *
   * `exhausted` names the key the caller was really using — trust that over the
   * file, since a long-running server may hold a client built before something
   * else rotated underneath it.
   *
   * `skip` names keys already proven dead this session, so a revoked key gets
   * stepped over instead of rotated onto, failing, and rotated again on every
   * subsequent call.
   *
   * Returns the new entry, or null when the ring holds nothing else to try —
   * the caller then fails honestly rather than looping over keys that all sit
   * dry.
   */
  rotate({ exhausted = null, skip = [], exportEnv = true } = {}) {
    const keys = this.ring();
    if (keys.length < 2) return null;

    const current = exhausted || this.key();
    const position = keys.findIndex((e) => e.key === current);

    const dead = new Set(skip || []);
    let next = null;
    for (let step = 1; step <= keys.length; step++) {
      const candidate = keys[(position + step + keys.length) % keys.length];
      if (candidate.key !== current && !dead.has(candidate.key)) {
        next = candidate;
        break;
      }
    }
    if (!next) return null;

    const { text: deduped, dropped } = this.dedupe(this._read());
    this._write(this.setActive(deduped, next.key));
    if (dropped) {
      this.log(`Dropped ${dropped} duplicate key line(s) from ${path.basename(this.path)}.`);
    }

    if (exportEnv) process.env[this.var] = next.key;
    this.log(`Rotating to "${next.label}" (${fingerprint(next.key)}).`);
    return next;
  }

  /**
   * Make `value` the active key, adding it to the ring when it reads as new.
   *
   * This exists because the settings form used to do
   * `writeFileSync(".env", "GEMINI_API_KEY=" + key)`, which replaced the whole
   * file with one line — every commented-out spare in the ring gone, on a save
   * the user meant as "use this key". An upsert says the same thing without
   * destroying anything.
   */
  setKey(value, label = null) {
    const key = stripQuotes(value);
    if (!key) return null;

    const { text: deduped } = this.dedupe(this._read());
    const known = this.parse(deduped).some((e) => e.key === key);

    let text;
    if (known) {
      text = this.setActive(deduped, key);
    } else {
      const ending = deduped.includes("\r\n") ? "\r\n" : "\n";
      const head = deduped && !deduped.endsWith("\n") ? ending : "";
      const name = (label || `added ${new Date().toISOString().slice(0, 10)}`).trim();
      // Append COMMENTED, then let `setActive` uncomment exactly this one. Two
      // steps rather than one so the "exactly one active" rule gets enforced by
      // the function that owns it instead of re-derived here.
      text = `${deduped}${head}# ${name}${ending}#${this.var}=${key}${ending}`;
      text = this.setActive(text, key);
    }

    this._write(text);
    process.env[this.var] = key;
    return this.ring().find((e) => e.key === key) || null;
  }

  /**
   * Dedupe and settle on exactly one active key. Returns a short report.
   *
   * Worth running at start-up in a project whose owner edits `.env` by hand:
   * two uncommented keys make every label a lie, and dotenv silently takes the
   * last.
   */
  tidy() {
    const original = this._read();
    if (!original.trim()) {
      return { keys: 0, dropped: 0, active: null, changed: false };
    }

    const { text: deduped, dropped } = this.dedupe(original);
    const chosen = this.active();
    const text = chosen ? this.setActive(deduped, chosen.key) : deduped;

    const changed = text !== original;
    if (changed) this._write(text);
    return {
      keys: this.ring().length,
      dropped,
      active: chosen ? chosen.label : null,
      changed,
    };
  }

  /**
   * The ring as plain objects for the GUI. Labels and fingerprints only.
   *
   * Never a key value, and never a masked slice of one either: the first six
   * and last four characters of an API key, published together, narrow a brute
   * force more than nothing does.
   */
  describe() {
    return this.ring().map((e) => ({
      label: e.label,
      fingerprint: fingerprint(e.key),
      active: e.active,
    }));
  }

  /**
   * What the GUI gets: the live key, redacted, and a count of the rest.
   *
   * `describe()` keeps full labels for the terminal, where the owner is
   * already sitting. This is the shape that crosses the wire, because the
   * browser has no use for twelve account names it only renders as noise —
   * and every one of them would sit in the JSON, in devtools, and in a
   * screenshot.
   */
  summary() {
    const keys = this.ring();
    const live = keys.find((e) => e.active) || keys[0] || null;
    return {
      active: live
        ? { label: redactLabel(live.label), fingerprint: fingerprint(live.key) }
        : null,
      total: keys.length,
      backups: Math.max(0, keys.length - 1),
    };
  }
}

KeyRing.fingerprint = fingerprint;
KeyRing.isQuotaError = isQuotaError;
KeyRing.isDeadKeyError = isDeadKeyError;
KeyRing.shouldRotate = shouldRotate;

module.exports = {
  KeyRing,
  defaultRingPath,
  fingerprint,
  scrubSecrets,
  redactLabel,
  isQuotaError,
  isDeadKeyError,
  shouldRotate,
  QUOTA_MARKERS,
  DEAD_MARKERS,
  UNLABELLED,
};
