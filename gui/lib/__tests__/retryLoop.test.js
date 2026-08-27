// End-to-end stub test for the ported retry loop.
//
// Stands a fake Gemini in front of the real `generateContentWithRetry` by
// intercepting the SDK's module in require.cache, and drives it through the
// sequences that actually killed runs: a 503 spike, a dry key, a revoked key, a
// whole ring going dry, and a reply that arrives unusable.
//
// The clock gets stubbed too, so ten minutes of patience costs no wall time.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");


// -- a scratch project so nothing touches the real .env or stats -------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "stub-"));
fs.mkdirSync(path.join(sandbox, "gui"));
fs.writeFileSync(path.join(sandbox, ".env"),
  "# Adam\nGEMINI_API_KEY=KEY_ONE\n# D Data\n#GEMINI_API_KEY=KEY_TWO\n# Meme Coins\n#GEMINI_API_KEY=KEY_THREE\n", "utf8");

// -- the fake SDK ------------------------------------------------------------
let script = [];            // queue of outcomes, consumed one per request
let requestLog = [];        // {key, n} for every request the loop really sent

class GoogleGenerativeAIFetchError extends Error {
  constructor(message, status, statusText) {
    super(message);
    this.status = status;
    this.statusText = statusText;
  }
}
function fault(status, statusText, detail) {
  return new GoogleGenerativeAIFetchError(
    `Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent: [${status} ${statusText}] ${detail}`,
    status, statusText);
}
const FAULTS = {
  busy: () => fault(503, "Service Unavailable", "The model is overloaded. Please try again later."),
  spike: () => fault(503, "Service Unavailable", "Spikes in demand are usually temporary. Please try again later."),
  dry: () => fault(429, "Too Many Requests", 'You exceeded your current quota. [{"retryDelay":"3s"}]'),
  revoked: () => fault(403, "Forbidden", "PERMISSION_DENIED: Your project has been denied access."),
  bad: () => fault(400, "Bad Request", "Invalid JSON payload received."),
};

class FakeGoogleGenerativeAI {
  constructor(apiKey) { this.apiKey = apiKey; }
  getGenerativeModel() {
    const apiKey = this.apiKey;
    return {
      generateContent: async () => {
        requestLog.push(apiKey);
        const step = script.shift();
        if (!step) throw new Error("stub ran out of script");
        if (typeof step === "string" && FAULTS[step]) throw FAULTS[step]();
        return {
          response: {
            text: () => step.text,
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 },
          },
        };
      },
    };
  }
}

// Intercept BOTH the SDK and the project paths server.js resolves.

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@google/generative-ai") return { GoogleGenerativeAI: FakeGoogleGenerativeAI };
  return realLoad.apply(this, arguments);
};

// -- load the real modules under test ---------------------------------------
const { KeyRing, fingerprint } = require("../keyRing.js");
const geminiRetry = require("../geminiRetry.js");
const { Pace } = require("../geminiPace.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// -- the loop, lifted verbatim in shape from server.js ----------------------
// server.js keeps this function inline with express handlers around it, so the
// test rebuilds the same body against the same three modules. Any drift shows
// up as a diff in review; the alternative is booting express to test a retry.
const CONTENT_RETRIES = 3;
const GEMINI_MODEL = "gemini-flash-latest";

let keys, pace, deadKeys, recorded;

function reset() {
  fs.writeFileSync(path.join(sandbox, ".env"),
    "# Adam\nGEMINI_API_KEY=KEY_ONE\n# D Data\n#GEMINI_API_KEY=KEY_TWO\n# Meme Coins\n#GEMINI_API_KEY=KEY_THREE\n", "utf8");
  try { fs.unlinkSync(path.join(sandbox, ".env.bak")); } catch (e) {}
  keys = new KeyRing({ filePath: path.join(sandbox, ".env"), log: () => {} });
  pace = new Pace({ minIntervalMs: 0 });     // the window is tested separately
  deadKeys = new Set();
  recorded = [];
  requestLog = [];
  script = [];
}

function recordGeminiCall(stat) { recorded.push(stat); return stat; }

async function generateContentWithRetry(prompt, onStatusUpdate = null, meta = {}) {
  const note = (m) => { if (onStatusUpdate) onStatusUpdate(m); };
  let activeKey = keys.key() || "";
  if (!activeKey) throw new Error("No GEMINI_API_KEY found.");
  const buildModel = (key) => new GoogleGenerativeAI(key).getGenerativeModel({ model: GEMINI_MODEL });
  let model = buildModel(activeKey);
  const patience = new geminiRetry.Patience(Math.max(1, keys.size()));
  const startTime = Date.now();
  let contentAttempt = 0;

  while (true) {
    const keyId = fingerprint(activeKey);
    if (pace.dueForRotation(keyId)) {
      const next = keys.rotate({ exhausted: activeKey, skip: Array.from(deadKeys) });
      if (next) { pace.clearKey(keyId); activeKey = next.key; model = buildModel(activeKey); note("paced-rotation"); }
    }
    await pace.reserve(fingerprint(activeKey));
    patience.sent();

    let result = null, responseText = "", usage = {}, apiError = null;
    try {
      result = await model.generateContent(prompt);
      responseText = result.response ? result.response.text() : "";
      usage = (result.response && result.response.usageMetadata) || {};
    } catch (e) { apiError = e; }

    if (apiError) {
      const status = geminiRetry.statusOf(apiError);
      let move = patience.consider(apiError);
      if (move === geminiRetry.Patience.ROTATE) {
        if (KeyRing.isDeadKeyError(apiError)) { note(`dead:${activeKey}`); deadKeys.add(activeKey); }
        const next = keys.rotate({ exhausted: activeKey, skip: Array.from(deadKeys) });
        if (next) {
          activeKey = next.key; model = buildModel(activeKey);
          // No clearKey here — mirrors the fix in server.js. Clearing after
          // the reassignment wiped the count of the key rotated ONTO.
          patience.rotated();
          note(`rotated:${next.key}`);
          continue;
        }
        move = geminiRetry.Patience.STOP;
      }
      if (move === geminiRetry.Patience.WAIT && patience.afford(apiError)) {
        note(patience.waitingLine(apiError));
        await patience.rest();
        continue;
      }
      recordGeminiCall({ type: meta.type || "general", status: "error", httpStatus: status || null,
        error: apiError.message, attempts: patience.transient + 1, requests: patience.requests,
        rotations: patience.rotations, keyFingerprint: fingerprint(activeKey), durationMs: Date.now() - startTime });
      throw apiError;
    }

    if (typeof meta.validate === "function") {
      const complaint = meta.validate(responseText);
      if (complaint) {
        contentAttempt += 1;
        if (contentAttempt < CONTENT_RETRIES) { note(`unusable:${complaint}`); await geminiRetry.sleep(0); continue; }
        const giveUp = new Error(`Gemini returned an unusable reply after ${CONTENT_RETRIES} attempts: ${complaint}`);
        recordGeminiCall({ type: meta.type || "general", status: "error", error: giveUp.message,
          attempts: contentAttempt, requests: patience.requests, rotations: patience.rotations,
          keyFingerprint: fingerprint(activeKey), durationMs: Date.now() - startTime });
        throw giveUp;
      }
    }

    const callStat = { type: meta.type || "general", status: "success",
      inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount, attempts: patience.transient + contentAttempt + 1,
      requests: patience.requests, rotations: patience.rotations,
      keyFingerprint: fingerprint(activeKey), durationMs: Date.now() - startTime };
    recordGeminiCall(callStat);
    return { result, responseText, durationMs: callStat.durationMs, callStat };
  }
}

// -- stub the clock so patience costs no wall time --------------------------
const realSetTimeout = global.setTimeout;
let virtualNow = Date.now();
const realDateNow = Date.now;
Date.now = () => virtualNow;
global.setTimeout = (fn, ms) => { virtualNow += (ms || 0); return realSetTimeout(fn, 0); };

// -- harness -----------------------------------------------------------------
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const notes = [];
const collect = (m) => notes.push(m);

(async function run() {

console.log("\n== a 503 spike that clears on the 5th try (the old code died at 5) ==");
{
  reset(); notes.length = 0;
  script = ["spike", "spike", "spike", "spike", { text: "CLEANED TEXT" }];
  const started = virtualNow;
  const out = await generateContentWithRetry("p", collect, { type: "transcription" });
  ok("succeeds", out.responseText === "CLEANED TEXT");
  ok("sent 5 requests", out.callStat.requests === 5, out.callStat.requests);
  ok("no rotation for a 503", out.callStat.rotations === 0);
  ok("all on one key", new Set(requestLog).size === 1, requestLog);
  const waited = (virtualNow - started) / 1000;
  ok("waited minutes, not 30s", waited > 60, waited + "s");
  ok("waited inside the 10-min ceiling", waited <= 600, waited + "s");
  ok("countdown shown to the user", notes.some(n => /patience left/.test(n)), notes.slice(0, 2));
}

console.log("\n== a 503 that never clears: gives up inside the ceiling ==");
{
  reset();
  script = new Array(20).fill("busy");
  const started = virtualNow;
  let threw = null;
  try { await generateContentWithRetry("p", null, {}); } catch (e) { threw = e; }
  ok("throws honestly", threw !== null);
  ok("gave up at the attempt ceiling", requestLog.length === geminiRetry.MAX_TRANSIENT_ATTEMPTS, requestLog.length);
  ok("inside 10 minutes", (virtualNow - started) <= geminiRetry.PATIENCE_MS, (virtualNow - started) / 1000 + "s");
  ok("error stat records the real request count", recorded[0].requests === requestLog.length, recorded[0]);
}

console.log("\n== a dry key rotates instead of waiting ==");
{
  reset(); notes.length = 0;
  script = ["dry", { text: "OK FROM KEY TWO" }];
  const started = virtualNow;
  const out = await generateContentWithRetry("p", collect, {});
  ok("succeeds after rotating", out.responseText === "OK FROM KEY TWO");
  ok("used exactly 2 requests", out.callStat.requests === 2, out.callStat.requests);
  ok("one rotation charged", out.callStat.rotations === 1);
  ok("second request used KEY_TWO", requestLog[1] === "KEY_TWO", requestLog);
  ok("NO waiting on a 429 with a ring", (virtualNow - started) < 1000, (virtualNow - started) + "ms");
  ok("rotation persisted to .env", new KeyRing({ filePath: path.join(sandbox, ".env"), log: () => {} }).key() === "KEY_TWO");
  ok("no transient try spent", out.callStat.attempts === 1, out.callStat.attempts);
}

console.log("\n== the whole ring goes dry: stop, do not loop ==");
{
  reset();
  script = ["dry", "dry", "dry", "dry", "dry"];
  let threw = null;
  try { await generateContentWithRetry("p", null, {}); } catch (e) { threw = e; }
  ok("throws", threw !== null);
  ok("tried each of the 3 keys once", requestLog.length === 3, requestLog);
  ok("each key tried exactly once", new Set(requestLog).size === 3, requestLog);
  ok("stopped without waiting out a daily ceiling", recorded[0].rotations === 2, recorded[0]);
}

console.log("\n== a revoked key gets skipped for the rest of the run ==");
{
  reset(); notes.length = 0;
  script = ["revoked", { text: "OK" }];
  const out = await generateContentWithRetry("p", collect, {});
  ok("rotates off a 403", out.responseText === "OK");
  ok("marked dead", deadKeys.has("KEY_ONE"), Array.from(deadKeys));
  ok("said so", notes.some(n => n.startsWith("dead:")));
  // second call must not rotate back onto the dead key
  script = ["dry", { text: "OK2" }];
  requestLog = [];
  const out2 = await generateContentWithRetry("p", null, {});
  ok("second call skips the dead key entirely", !requestLog.includes("KEY_ONE"), requestLog);
  ok("second call succeeded", out2.responseText === "OK2");
}

console.log("\n== a bad request stops at once ==");
{
  reset();
  script = ["bad", { text: "never reached" }];
  let threw = null;
  try { await generateContentWithRetry("p", null, {}); } catch (e) { threw = e; }
  ok("throws", threw !== null);
  ok("exactly one request — no waiting, no rotating", requestLog.length === 1, requestLog);
  ok("recorded as 400", recorded[0].httpStatus === 400, recorded[0].httpStatus);
}

console.log("\n== an unusable reply keeps its OWN budget ==");
{
  reset(); notes.length = 0;
  const validate = (t) => { try { return Array.isArray(JSON.parse(t)) ? null : "not an array"; } catch (e) { return "invalid JSON"; } };
  script = [{ text: "not json at all" }, { text: "{}" }, { text: '[{"file":"a.jpg"}]' }];
  const out = await generateContentWithRetry("p", collect, { type: "naming", validate });
  ok("retries a bad reply and succeeds", JSON.parse(out.responseText)[0].file === "a.jpg");
  ok("3 requests", out.callStat.requests === 3, out.callStat.requests);
  ok("spent NO transient budget", out.callStat.rotations === 0 && notes.filter(n => /patience left/.test(n)).length === 0);
  ok("complained about each bad reply", notes.filter(n => n.startsWith("unusable:")).length === 2, notes);
}

console.log("\n== an unusable reply that never improves gives up at 3 ==");
{
  reset();
  script = [{ text: "junk" }, { text: "junk" }, { text: "junk" }, { text: "junk" }];
  let threw = null;
  try { await generateContentWithRetry("p", null, { validate: () => "always bad" }); } catch (e) { threw = e; }
  ok("throws", threw !== null && /unusable reply after 3/.test(threw.message), threw && threw.message);
  ok("exactly 3 requests", requestLog.length === 3, requestLog.length);
}

console.log("\n== mixed weather: 503, then a dry key, then success ==");
{
  reset(); notes.length = 0;
  script = ["spike", "dry", { text: "FINALLY" }];
  const out = await generateContentWithRetry("p", collect, {});
  ok("gets there", out.responseText === "FINALLY");
  ok("3 requests", out.callStat.requests === 3, out.callStat.requests);
  ok("one wait AND one rotation", out.callStat.attempts === 2 && out.callStat.rotations === 1, out.callStat);
  ok("finished on KEY_TWO", requestLog[2] === "KEY_TWO", requestLog);
}

console.log("\n== the pacer rotates BEFORE a key hits its ceiling ==");
{
  reset();
  pace = new Pace({ minIntervalMs: 0, callsPerKey: 3 });
  for (let i = 0; i < 4; i++) { script.push({ text: "ok" + i }); }
  for (let i = 0; i < 4; i++) await generateContentWithRetry("p", null, {});
  ok("first 3 on KEY_ONE", requestLog.slice(0, 3).every(k => k === "KEY_ONE"), requestLog);
  ok("4th anticipates and moves to KEY_TWO", requestLog[3] === "KEY_TWO", requestLog);
  ok("no failed call taught it that", recorded.every(r => r.status === "success"));
}

console.log("\n== the 12s rate window actually holds ==");
{
  reset();
  const realPace = new Pace({ minIntervalMs: 12000 });
  realPace.noteCall("k");
  const owed = realPace.owed();
  ok("owes ~12s right after a call", owed > 11000 && owed <= 12000, owed);
  virtualNow += 12000;
  ok("owes nothing 12s later", realPace.owed() === 0, realPace.owed());
}

console.log("\n== CONCURRENCY: two streams cannot pass one rate gate together ==");
{
  // The bug this pins: `owed()` / `waitTurn()` / `noteCall()` as three steps
  // let two callers each read the same `lastStartedAt`, wait the same
  // interval, and fire together. A gate two callers pass at once is not a gate.
  reset();
  const p = new Pace({ minIntervalMs: 12000 });
  // Spy on `noteCall`, not on when the awaiting caller happens to resume.
  // The instant a slot gets CHARGED is the instant that matters; a caller's
  // continuation is a microtask that can run after another reservation has
  // already moved the clock.
  const charged = [];
  const realNote = p.noteCall.bind(p);
  p.noteCall = (keyId) => { charged.push(virtualNow); return realNote(keyId); };

  await Promise.all([1, 2, 3].map(() => p.reserve("same-key")));

  const gaps = charged.slice(1).map((at, i) => at - charged[i]);
  ok("three reservations, three slots", charged.length === 3, charged);
  ok("every gap respects the 12s window", gaps.every((g) => g >= 12000), gaps);
  ok("all three charged to the key", p.spent("same-key") === 3, p.spent("same-key"));
}

console.log("\n== CONCURRENCY: an anticipatory rotation does not reset the new key ==");
{
  // The bug this pins: clearKey(fingerprint(activeKey)) ran AFTER the
  // reassignment, wiping the count of the key being rotated ONTO — so a
  // part-spent key got a fresh budget and sailed past the ceiling.
  reset();
  const p = new Pace({ minIntervalMs: 0, callsPerKey: 3 });
  await p.reserve("key-b");                 // key-b already spent one earlier
  for (let i = 0; i < 3; i++) await p.reserve("key-a");
  ok("key-a hit its ceiling", p.dueForRotation("key-a"));
  p.clearKey("key-a");                       // clear the OLD key, as the fix does
  ok("key-b kept its earlier call", p.spent("key-b") === 1, p.spent("key-b"));
  ok("key-a's history is gone", p.spent("key-a") === 0);
}

console.log("\n== a single-key ring still waits out a 503 ==");
{
  reset();
  fs.writeFileSync(path.join(sandbox, ".env"), "# Only\nGEMINI_API_KEY=SOLO\n", "utf8");
  keys = new KeyRing({ filePath: path.join(sandbox, ".env"), log: () => {} });
  script = ["spike", "spike", { text: "OK SOLO" }];
  const out = await generateContentWithRetry("p", null, {});
  ok("waits and succeeds", out.responseText === "OK SOLO");
  ok("never tried to rotate", out.callStat.rotations === 0);
  ok("3 requests all on SOLO", requestLog.length === 3 && new Set(requestLog).size === 1, requestLog);
}

console.log("\n== a single-key ring WAITS on a 429 (a per-minute 429 clears) ==");
{
  reset();
  fs.writeFileSync(path.join(sandbox, ".env"), "# Only\nGEMINI_API_KEY=SOLO\n", "utf8");
  keys = new KeyRing({ filePath: path.join(sandbox, ".env"), log: () => {} });
  script = ["dry", { text: "OK AFTER THE MINUTE" }];
  const started = virtualNow;
  const out = await generateContentWithRetry("p", null, {});
  ok("waits rather than failing", out.responseText === "OK AFTER THE MINUTE");
  ok("honoured the server's retryDelay of 3s", (virtualNow - started) === 3000, virtualNow - started);
}

Date.now = realDateNow;
global.setTimeout = realSetTimeout;
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
