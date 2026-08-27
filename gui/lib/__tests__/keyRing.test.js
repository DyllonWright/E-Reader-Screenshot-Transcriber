const fs = require("fs");
const os = require("os");
const path = require("path");
const { KeyRing, fingerprint } = require("../keyRing.js");
const retry = require("../geminiRetry.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function tmpEnv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ring-"));
  const p = path.join(dir, ".env");
  fs.writeFileSync(p, text, "utf8");
  return p;
}
const quiet = () => {};

console.log("\n== KeyRing: parse / active / ring ==");
{
  const p = tmpEnv("# Adam\nGEMINI_API_KEY=AAA\n# D Data\n#GEMINI_API_KEY=BBB\n# Meme Coins\n#GEMINI_API_KEY=CCC\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  ok("finds 3 keys", r.size() === 3, r.size());
  ok("active is AAA", r.key() === "AAA", r.key());
  ok("labels read", r.ring().map(e => e.label).join("|") === "Adam|D Data|Meme Coins", r.ring().map(e => e.label));
  ok("describe hides values", JSON.stringify(r.describe()).indexOf("AAA") === -1);
}

console.log("\n== KeyRing: rotation persists and stays exactly-one-active ==");
{
  const p = tmpEnv("# Adam\nGEMINI_API_KEY=AAA\n# D Data\n#GEMINI_API_KEY=BBB\n# Meme\n#GEMINI_API_KEY=CCC\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  const n = r.rotate({ exhausted: "AAA" });
  ok("rotates to BBB", n && n.key === "BBB", n && n.key);
  ok("file now says BBB", new KeyRing({ filePath: p, log: quiet }).key() === "BBB");
  const uncommented = fs.readFileSync(p, "utf8").split("\n").filter(l => /^GEMINI_API_KEY=/.test(l));
  ok("exactly one active line", uncommented.length === 1, uncommented);
  ok("no key lost", new KeyRing({ filePath: p, log: quiet }).size() === 3);
  ok("backup written", fs.existsSync(p + ".bak"));
  ok("no tmp left behind", !fs.existsSync(p + ".tmp"));
  r.rotate({ exhausted: "BBB" });
  ok("rotates on to CCC", new KeyRing({ filePath: p, log: quiet }).key() === "CCC");
  r.rotate({ exhausted: "CCC" });
  ok("wraps back to AAA", new KeyRing({ filePath: p, log: quiet }).key() === "AAA");
}

console.log("\n== KeyRing: skip a dead key ==");
{
  const p = tmpEnv("#a\nGEMINI_API_KEY=AAA\n#b\n#GEMINI_API_KEY=BBB\n#c\n#GEMINI_API_KEY=CCC\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  const n = r.rotate({ exhausted: "AAA", skip: ["BBB"] });
  ok("steps over BBB to CCC", n && n.key === "CCC", n && n.key);
}

console.log("\n== KeyRing: single key / empty ring rotate to null ==");
{
  const p = tmpEnv("GEMINI_API_KEY=ONLY\n");
  ok("one key cannot rotate", new KeyRing({ filePath: p, log: quiet }).rotate({ exhausted: "ONLY" }) === null);
  const e = tmpEnv("");
  const r = new KeyRing({ filePath: e, log: quiet });
  ok("empty ring size 0", r.size() === 0);
  ok("empty ring key null", r.key() === null);
  ok("empty ring rotate null", r.rotate() === null);
}

console.log("\n== KeyRing: CRLF survives a rotation ==");
{
  const p = tmpEnv("# Adam\r\nGEMINI_API_KEY=AAA\r\n# D\r\n#GEMINI_API_KEY=BBB\r\n");
  new KeyRing({ filePath: p, log: quiet }).rotate({ exhausted: "AAA" });
  const after = fs.readFileSync(p, "utf8");
  ok("still CRLF", after.indexOf("\r\n") !== -1 && !/[^\r]\n/.test(after), JSON.stringify(after));
  ok("rotation still took", new KeyRing({ filePath: p, log: quiet }).key() === "BBB");
}

console.log("\n== KeyRing: other settings survive untouched ==");
{
  const p = tmpEnv("PORT=3301\n# Adam\nGEMINI_API_KEY=AAA\nOTHER=keepme\n# D\n#GEMINI_API_KEY=BBB\n");
  new KeyRing({ filePath: p, log: quiet }).rotate({ exhausted: "AAA" });
  const after = fs.readFileSync(p, "utf8");
  ok("PORT kept", after.indexOf("PORT=3301") !== -1);
  ok("OTHER kept", after.indexOf("OTHER=keepme") !== -1);
}

console.log("\n== KeyRing: dedupe ==");
{
  const p = tmpEnv("#a\nGEMINI_API_KEY=AAA\n#b\n#GEMINI_API_KEY=AAA\n#c\n#GEMINI_API_KEY=BBB\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  ok("ring dedupes in memory", r.size() === 2, r.size());
  r.rotate({ exhausted: "AAA" });
  ok("duplicate line dropped on write", (fs.readFileSync(p, "utf8").match(/AAA/g) || []).length === 1);
}

console.log("\n== KeyRing: setKey upsert never clobbers the ring ==");
{
  const p = tmpEnv("# Adam\nGEMINI_API_KEY=AAA\n# D Data\n#GEMINI_API_KEY=BBB\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  r.setKey("CCC", "New Account");
  const after = new KeyRing({ filePath: p, log: quiet });
  ok("new key became active", after.key() === "CCC", after.key());
  ok("ring grew to 3", after.size() === 3, after.size());
  ok("old keys survived", ["AAA", "BBB"].every(k => after.ring().some(e => e.key === k)));
  ok("label recorded", after.ring().some(e => e.label === "New Account"));
  r.setKey("AAA");
  const back = new KeyRing({ filePath: p, log: quiet });
  ok("re-selecting a known key just activates it", back.key() === "AAA" && back.size() === 3, [back.key(), back.size()]);
}

console.log("\n== KeyRing: all-commented file still yields a key ==");
{
  const p = tmpEnv("#a\n#GEMINI_API_KEY=AAA\n#b\n#GEMINI_API_KEY=BBB\n");
  ok("falls back to first", new KeyRing({ filePath: p, log: quiet }).key() === "AAA");
}

console.log("\n== classify: the real SDK error shapes ==");
function sdkError(status, statusText, message) {
  class GoogleGenerativeAIFetchError extends Error {}
  const e = new GoogleGenerativeAIFetchError(
    `Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent: [${status} ${statusText}] ${message}`);
  e.status = status;
  e.statusText = statusText;
  return e;
}
{
  const busy = sdkError(503, "Service Unavailable", "The model is overloaded. Please try again later.");
  ok("503 -> transient", retry.classify(busy) === retry.TRANSIENT, retry.classify(busy));
  ok("503 status parsed", retry.statusOf(busy) === 503);

  const dry = sdkError(429, "Too Many Requests", "You exceeded your current quota. [{\"retryDelay\":\"35s\"}]");
  ok("429 -> quota", retry.classify(dry) === retry.QUOTA, retry.classify(dry));
  ok("retryDelay honoured", retry.retryAfter(dry) === 35000, retry.retryAfter(dry));
  ok("delayFor uses the asked wait", retry.delayFor(1, dry) === 35000);

  const revoked = sdkError(403, "Forbidden", "PERMISSION_DENIED: Your project has been denied access.");
  ok("403 -> fatal", retry.classify(revoked) === retry.FATAL, retry.classify(revoked));
  ok("403 rotates anyway", require("../keyRing.js").shouldRotate(revoked));

  const bad = sdkError(400, "Bad Request", "Invalid JSON payload.");
  ok("400 -> fatal", retry.classify(bad) === retry.FATAL);

  const server = sdkError(500, "Internal Server Error", "Internal error encountered.");
  ok("500 -> transient", retry.classify(server) === retry.TRANSIENT);

  const socket = Object.assign(new Error("fetch failed"), { cause: "ECONNRESET" });
  ok("socket drop -> transient", retry.classify(socket) === retry.TRANSIENT, retry.classify(socket));

  const weird = new Error("something nobody has seen");
  ok("unknown -> fatal", retry.classify(weird) === retry.FATAL);

  // The bug this whole port exists to kill: a status hiding in a token count.
  const tokens = new Error("finished with 503 output tokens and 200 input tokens");
  ok("no false 503 from a token count", retry.statusOf(tokens) === null, retry.statusOf(tokens));
}

console.log("\n== Patience: the three moves ==");
{
  const busy = sdkError(503, "Service Unavailable", "overloaded");
  const dry = sdkError(429, "Too Many Requests", "quota exceeded");

  const solo = new retry.Patience(1);
  ok("503, no ring -> wait", solo.consider(busy) === retry.Patience.WAIT);
  ok("429, no ring -> wait (a per-minute 429 clears)", solo.consider(dry) === retry.Patience.WAIT);

  const ringed = new retry.Patience(3);
  ok("429 with a ring -> rotate", ringed.consider(dry) === retry.Patience.ROTATE);
  ringed.rotated();
  ok("second 429 -> rotate again", ringed.consider(dry) === retry.Patience.ROTATE);
  ringed.rotated();
  ok("ring walked -> stop", ringed.consider(dry) === retry.Patience.STOP);
  ok("503 still waits after the ring walked", ringed.consider(busy) === retry.Patience.WAIT);

  const revoked = sdkError(403, "Forbidden", "PERMISSION_DENIED denied access");
  ok("403 with a ring -> rotate", new retry.Patience(2).consider(revoked) === retry.Patience.ROTATE);
  ok("403 with no ring -> stop", new retry.Patience(1).consider(revoked) === retry.Patience.STOP);
}

console.log("\n== Patience: the budget actually bounds things ==");
{
  const p = new retry.Patience(1);
  const busy = sdkError(503, "Service Unavailable", "overloaded");
  let taken = 0, total = 0;
  while (p.afford(busy)) { taken++; total += p.lastDelay; p.started -= p.lastDelay; }
  ok("stops at MAX_TRANSIENT_ATTEMPTS", taken < retry.MAX_TRANSIENT_ATTEMPTS, taken);
  ok("total patience within 10 min", total <= retry.PATIENCE_MS, total / 1000 + "s");
  ok("patience beats the old 30s by a lot", total > 120000, total / 1000 + "s");

  const schedule = [1,2,3,4,5,6].map(a => retry.delayFor(a, null, 1.0) / 1000);
  ok("schedule 15/30/60/120/120/120", schedule.join(",") === "15,30,60,120,120,120", schedule);
  ok("jitter floors at half", retry.delayFor(1, null, 0.5) === 7500);
  ok("describe reads as a clock", retry.describe(461000) === "7m 41s", retry.describe(461000));
}

console.log("\n== requests counter ==");
{
  const p = new retry.Patience(2);
  p.sent(); p.sent(); p.sent();
  ok("counts every request, not every call", p.requests === 3, p.requests);
}

console.log("\n== scrubSecrets: one guard, both clients ==");
{
  const { scrubSecrets } = require("../keyRing.js");
  ok("redacts an AIza key", scrubSecrets("failed with AIzaSyD1234567890abcdefXYZ here") === "failed with [key redacted] here", scrubSecrets("failed with AIzaSyD1234567890abcdefXYZ here"));
  ok("redacts a ?key= query", scrubSecrets("GET https://x/y?key=SEKRET123&z=1").indexOf("SEKRET123") === -1);
  ok("leaves ordinary text alone", scrubSecrets("503 Service Unavailable") === "503 Service Unavailable");
  ok("handles null", scrubSecrets(null) === "");
}

console.log("\n== redactLabel: recognisable, not readable ==");
{
  const { redactLabel } = require("../keyRing.js");
  const r = redactLabel("sanders.llc147@gmail.com");
  ok("keeps the first two characters", r.startsWith("sa"), r);
  ok("keeps the domain", r.endsWith("@gmail.com"), r);
  ok("hides the rest of the local part", r.indexOf("nders.llc147") === -1, r);
  ok("length does not shrink (no free hint)", r.length === "sanders.llc147@gmail.com".length, r);

  const n = redactLabel("daathdata #2");
  ok("non-email labels redact too", n.startsWith("da") && n.indexOf("athdata") === -1, n);

  ok("unlabelled passes through", redactLabel("(unlabelled)") === "(unlabelled)");
  ok("empty passes through", redactLabel("") === "(unlabelled)");
  ok("null is safe", redactLabel(null) === "(unlabelled)");
  ok("a one-char local part still redacts", redactLabel("a@b.co").indexOf("•") !== -1, redactLabel("a@b.co"));
}

console.log("\n== summary(): what actually crosses the wire ==");
{
  const p = tmpEnv("# alice@example.com\nGEMINI_API_KEY=AAA\n# bob@example.com\n#GEMINI_API_KEY=BBB\n# carol@example.com\n#GEMINI_API_KEY=CCC\n");
  const r = new KeyRing({ filePath: p, log: quiet });
  const s = r.summary();
  const blob = JSON.stringify(s);

  ok("counts the ring", s.total === 3, s);
  ok("counts the spares", s.backups === 2, s);
  ok("names the active key", s.active.fingerprint === require("../keyRing.js").fingerprint("AAA"));

  ok("NO key value crosses", !/AAA|BBB|CCC/.test(blob), blob);
  ok("NO inactive label crosses", blob.indexOf("bob") === -1 && blob.indexOf("carol") === -1, blob);
  ok("active label is redacted", blob.indexOf("alice@example.com") === -1, blob);
  ok("active label stays recognisable", s.active.label.startsWith("al") && s.active.label.endsWith("@example.com"), s.active.label);

  const empty = new KeyRing({ filePath: tmpEnv(""), log: quiet }).summary();
  ok("empty ring -> active null", empty.active === null && empty.total === 0 && empty.backups === 0, empty);

  const solo = new KeyRing({ filePath: tmpEnv("# solo\nGEMINI_API_KEY=ONE\n"), log: quiet }).summary();
  ok("single key -> zero backups", solo.total === 1 && solo.backups === 0, solo);

  // describe() keeps full labels — it feeds the terminal, where the owner is.
  ok("describe() still carries full labels for the console",
     JSON.stringify(r.describe()).indexOf("bob@example.com") !== -1);
}

console.log("\n== defaultRingPath ==");
{
  const { defaultRingPath } = require("../keyRing.js");
  const projectEnv = path.join(os.tmpdir(), "project", ".env");
  const warnings = [];
  const warn = (m) => warnings.push(m);

  delete process.env.ENV_KEY_RING_PATH;
  ok("unset -> project .env", defaultRingPath(projectEnv, warn) === projectEnv);
  ok("unset warns about nothing", warnings.length === 0);

  process.env.ENV_KEY_RING_PATH = path.join(os.tmpdir(), "definitely-not-here-9f3a", "keys.env");
  ok("missing path -> falls back", defaultRingPath(projectEnv, warn) === projectEnv);
  ok("missing path WARNS (a typo used to look like a 1-key setup)", warnings.length === 1, warnings);

  const shared = tmpEnv("# shared\nGEMINI_API_KEY=SHARED\n");
  process.env.ENV_KEY_RING_PATH = shared;
  ok("existing path wins", defaultRingPath(projectEnv, warn) === shared);
  ok("an explicit filePath still beats the env var", new KeyRing({ filePath: projectEnv, log: quiet }).path === projectEnv);
  delete process.env.ENV_KEY_RING_PATH;
}

console.log("\n== the .env write leaves no scratch file behind ==");
{
  const p = tmpEnv("# a\nGEMINI_API_KEY=AAA\n# b\n#GEMINI_API_KEY=BBB\n");
  new KeyRing({ filePath: p, log: quiet }).rotate({ exhausted: "AAA" });
  const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith(".tmp"));
  ok("no .tmp file left behind", leftovers.length === 0, leftovers);
  ok("rotation landed", new KeyRing({ filePath: p, log: quiet }).key() === "BBB");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
