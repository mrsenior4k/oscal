const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const server = fs.readFileSync("server.js", "utf8");
const viewer = fs.readFileSync("public/viewer.html", "utf8");
const dashboard = fs.readFileSync("public/dashboard.html", "utf8");
const renderConfig = fs.readFileSync("render.yaml", "utf8");

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

test("browser debug logs are not leaking profile or response details", () => {
  assert.doesNotMatch(viewer, /RAW RESPONSE|CURRENT CREATOR/);
  assert.doesNotMatch(dashboard, /LOGGED IN PROFILE|PROFILE IMAGE URL/);
});

test("sponsor video clicks open the tracking link while playing", () => {
  assert.match(viewer, /SPONSOR_CLICK_URL\s*=\s*"https:\/\/www\.tiktok\.com\/t\/ZP9jBjs2Xf1dD-8YB63\/"/);
  assert.match(viewer, /function openSponsorClickUrl/);
  assert.match(viewer, /window\.open\(clickUrl,\s*"_blank"/);
});
