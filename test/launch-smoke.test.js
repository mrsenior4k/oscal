const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const server = fs.readFileSync("server.js", "utf8");
const viewer = fs.readFileSync("public/viewer.html", "utf8");
const dashboard = fs.readFileSync("public/dashboard.html", "utf8");
const renderConfig = fs.readFileSync("render.yaml", "utf8");
const privacy = fs.readFileSync("public/privacy.html", "utf8");
const terms = fs.readFileSync("public/terms.html", "utf8");

test("production sessions use an environment secret", () => {
  assert.match(server, /process\.env\.SESSION_SECRET/);
  assert.doesNotMatch(server, /change-this-secret-later/);
});

test("production dev reset requires an explicit enable flag", () => {
  assert.match(server, /ENABLE_DEV_RESET/);
  assert.match(server, /requireDevResetAccess/);
});

test("Render persistent disk is configured", () => {
  assert.match(renderConfig, /mountPath:\s*\/var\/data/);
  assert.match(renderConfig, /DATA_DIR/);
  assert.match(renderConfig, /value:\s*\/var\/data/);
});

test("owner-device self-support guard is wired through viewer and dashboard", () => {
  assert.match(server, /creatorOwnerDevices/);
  assert.match(server, /isKnownCreatorOwnerDevice/);
  assert.match(viewer, /deviceFamily/);
  assert.match(viewer, /credentials:\s*"same-origin"/);
  assert.match(dashboard, /getDashboardDeviceFamily/);
});

test("creator login entrypoint is platform neutral", () => {
  assert.match(server, /app\.get\("\/auth\/creator"/);
  assert.match(server, /res\.redirect\("\/auth\/creator"\)/);
  assert.match(dashboard, /window\.location\.href = "\/auth\/creator"/);
  assert.doesNotMatch(privacy, /YouTube sign-in/);
  assert.doesNotMatch(terms, /sign in with YouTube/);
});

test("browser debug logs are not leaking profile or response details", () => {
  assert.doesNotMatch(viewer, /RAW RESPONSE|CURRENT CREATOR/);
  assert.doesNotMatch(dashboard, /LOGGED IN PROFILE|PROFILE IMAGE URL/);
});

test("sponsor video clicks open the tracking link while playing", () => {
  assert.match(viewer, /SPONSOR_CLICK_URL\s*=\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBjs2Xf1dD-8YB63\/"/);
  assert.match(viewer, /function openSponsorClickUrl/);
  assert.match(viewer, /ad\.clickUrl\s*\|\|\s*adData\.clickUrl\s*\|\|\s*SPONSOR_CLICK_URL/);
  assert.match(viewer, /window\.open\(clickUrl,\s*"_blank"/);
});

test("sponsor ads have file-specific tracking links", () => {
  assert.ok(fs.existsSync("public/ads/14edef0cbf8a2d40565eb5af393e1aad.mp4"));
  assert.ok(fs.existsSync("public/ads/53b751172cd670e0d39bcaaabf7c2df4.mp4"));
  assert.ok(fs.existsSync("public/ads/2f94ebea9be3d6a5fec118b6d6b307e0.mp4"));
  assert.match(server, /"1000004233\.mp4":\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBjs2Xf1dD-8YB63\/"/);
  assert.match(server, /"14edef0cbf8a2d40565eb5af393e1aad\.mp4":\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBUuGC2UoB-GbJqv\/"/);
  assert.match(server, /"53b751172cd670e0d39bcaaabf7c2df4\.mp4":\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBP6NX9JAM-0yiKG\/"/);
  assert.match(server, /"2f94ebea9be3d6a5fec118b6d6b307e0\.mp4":\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBmBcaw8pS-Yr9uz\/"/);
  assert.match(server, /clickUrl:\s*SPONSOR_AD_CLICK_URLS\[file\]\s*\|\|\s*DEFAULT_SPONSOR_CLICK_URL/);
});

test("privacy and terms pages are routed and linked", () => {
  assert.match(server, /app\.get\("\/privacy"/);
  assert.match(server, /app\.get\("\/terms"/);
  assert.match(viewer, /href="\/privacy"/);
  assert.match(viewer, /href="\/terms"/);
  assert.match(dashboard, /href="\/privacy"/);
  assert.match(dashboard, /href="\/terms"/);
  assert.match(privacy, /Privacy Policy/);
  assert.match(privacy, /creator sign-in/);
  assert.match(privacy, /Device and browser signals/);
  assert.match(privacy, /TikTok Ad Links/);
  assert.match(terms, /Terms of Use/);
  assert.match(terms, /Creators may sign in so Oscal can identify/);
  assert.match(terms, /Fair Use/);
  assert.match(terms, /Ad Videos and Third-Party Links/);
  assert.match(terms, /Estimated earnings are not a guarantee/);
});
