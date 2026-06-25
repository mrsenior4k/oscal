require("dotenv").config();
// server.js
const { google } = require("googleapis");
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const session = require("express-session");
const { DatabaseSync } = require("node:sqlite");


const app = express();
const SERVER_STARTED_AT = Date.now();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (IS_PRODUCTION ? crypto.randomBytes(48).toString("hex") : "dev-session-secret");

if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set. Sessions will rotate on every restart.");
}

function debugLog(...args) {
  if (!IS_PRODUCTION) console.log(...args);
}

let events = []; // simple in-memory log (replace with DB in production)
let userProgress = {};
let supporterProfiles = {};
let supporterStats = {};
let creatorStats = {};
let creatorProfiles = {};
let creatorOwnerDevices = {};
let creatorVideos = {};
let supportRecords = {};

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

app.use(bodyParser.json({ limit: "10mb" }));

function redirectHome(req, res) {
  return res.redirect("/dashboard");
}

function sendViewerPage(req, res, sourcePlatform = "direct") {
  const normalizedSource = normalizeSourcePlatform(sourcePlatform, "direct");
  const creatorKey = getCanonicalCreatorKey(req.params?.creator || req.params?.[0] || "", req);

  if (req.session && creatorKey) {
    req.session.viewerSourcePlatforms = req.session.viewerSourcePlatforms || {};
    req.session.viewerSourcePlatforms[creatorKey] = normalizedSource;
  }

  res.set("Cache-Control", "no-store, max-age=0");

  try {
    const html = fs.readFileSync(path.join(__dirname, "public", "viewer.html"), "utf8");
    const bootstrapScript = `<script>window.__OSCAL_VIEWER_BOOTSTRAP__=${JSON.stringify({
      sourcePlatform: normalizedSource
    })};</script>`;

    return res.send(html.replace("</head>", `${bootstrapScript}\n</head>`));
  } catch (err) {
    console.error("Could not render viewer page:", err);
    return res.status(500).send("Could not load support page.");
  }
}

const LEGACY_CREATOR_SLUGS = new Set([
  "5thdimentionalbeing367",
  "5thdimensionalbeing367",
  "5th dimentional being",
  "5th dimensional being"
]);

const OWNER_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const FALLBACK_CREATOR_PROFILE = {
  slug: process.env.FALLBACK_CREATOR_SLUG || "@5thdimentionalbeing367",
  displayName: process.env.FALLBACK_CREATOR_DISPLAY_NAME || "JSGwithaDream",
  profileImage:
    process.env.FALLBACK_CREATOR_PROFILE_IMAGE ||
    "https://yt3.ggpht.com/jFouBAMmfj9lzDkqUiM9MsTMx-riqEwWPbFnyAlyMA65nMrU4x8u_JtlP34iWzGx3exZV94q5g=s88-c-k-c0x00ffffff-no-rj"
};

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return String(value || "");
  }
}

function normalizeCreatorSlug(slug) {
  return safeDecode(slug)
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function compactCreatorSlug(slug) {
  return normalizeCreatorSlug(slug).replace(/[^a-z0-9]/g, "");
}

function isLegacyCreatorSlug(slug) {
  return LEGACY_CREATOR_SLUGS.has(normalizeCreatorSlug(slug));
}

function getCreatorLookupKeys(...values) {
  const keys = new Set();

  values.filter(Boolean).forEach(value => {
    const raw = safeDecode(value).trim();
    if (!raw) return;

    const bare = raw.replace(/^@+/, "");
    const normalized = normalizeCreatorSlug(raw);
    const compact = compactCreatorSlug(raw);

    [raw, bare, bare ? `@${bare}` : "", normalized, compact, compact ? `@${compact}` : ""]
      .filter(Boolean)
      .forEach(key => keys.add(key));
  });

  return [...keys];
}

function storeCreatorProfile(profile, channelId = "") {
  getCreatorLookupKeys(
    profile.slug,
    profile.displayName,
    channelId
  ).forEach(key => {
    creatorProfiles[key] = profile;
  });
}

function profileMatchesSlug(profile, slug) {
  if (!profile) return false;

  const requested = new Set(getCreatorLookupKeys(slug));
  return getCreatorLookupKeys(profile.slug, profile.displayName).some(key =>
    requested.has(key)
  );
}

function profilesReferToSameCreator(firstProfile, secondProfile) {
  if (!firstProfile || !secondProfile) return false;

  const firstKeys = new Set(
    getCreatorLookupKeys(firstProfile.slug, firstProfile.displayName)
  );

  return getCreatorLookupKeys(secondProfile.slug, secondProfile.displayName).some(key =>
    firstKeys.has(key)
  );
}

function findCreatorProfile(slug, req = null) {
  const keys = getCreatorLookupKeys(slug);

  for (const key of keys) {
    if (creatorProfiles[key]) return creatorProfiles[key];
  }

  for (const profile of Object.values(creatorProfiles)) {
    if (profileMatchesSlug(profile, slug)) return profile;
  }

  if (
    req?.session?.creatorProfile &&
    profileMatchesSlug(req.session.creatorProfile, slug)
  ) {
    return req.session.creatorProfile;
  }

  if (profileMatchesSlug(FALLBACK_CREATOR_PROFILE, slug) || isLegacyCreatorSlug(slug)) {
    return FALLBACK_CREATOR_PROFILE;
  }

  return null;
}

function isLoggedInCreatorForSlug(req, slug) {
  const sessionProfile = req.session?.creatorProfile;
  if (!sessionProfile) return false;

  const targetProfile = findCreatorProfile(slug);

  return (
    profileMatchesSlug(sessionProfile, slug) ||
    profilesReferToSameCreator(sessionProfile, targetProfile)
  );
}

function isSupporterViewRequest(req, explicitValue = false) {
  if (explicitValue === true || explicitValue === "true" || explicitValue === "1") {
    return true;
  }

  if (req.query?.view === "supporter") {
    return true;
  }

  const referrer = req.get("referer") || req.get("referrer") || "";
  if (!referrer) return false;

  try {
    const parsed = new URL(referrer, `${req.protocol}://${req.get("host") || "localhost"}`);
    return parsed.searchParams.get("view") === "supporter";
  } catch (_) {
    return String(referrer).includes("view=supporter");
  }
}

function normalizeCreatorStatsKey(value) {
  const raw = safeDecode(value).trim();
  if (!raw) return "";

  const compact = compactCreatorSlug(raw);
  if (compact) return `@${compact}`;

  return normalizeCreatorSlug(raw);
}

function getCreatorStatsLookupKeys(value, req = null) {
  const profile = findCreatorProfile(value, req);
  const keys = new Set();

  [
    value,
    profile?.slug,
    profile?.displayName
  ].filter(Boolean).forEach(candidate => {
    getCreatorLookupKeys(candidate).forEach(key => keys.add(key));
    const statsKey = normalizeCreatorStatsKey(candidate);
    if (statsKey) keys.add(statsKey);
  });

  return [...keys].filter(Boolean);
}

function getCanonicalCreatorKey(value, req = null) {
  const profile = findCreatorProfile(value, req);
  return normalizeCreatorStatsKey(profile?.slug || value);
}

function getCreatorStatsRecord(value, req = null) {
  for (const key of getCreatorStatsLookupKeys(value, req)) {
    if (creatorStats[key]) return { key, stats: creatorStats[key] };
  }

  return { key: getCanonicalCreatorKey(value, req), stats: null };
}

function mergeCreatorStatRecords(target = {}, source = {}) {
  const merged = {
    supports: Number(target.supports || 0) + Number(source.supports || 0),
    earnings: Number(target.earnings || 0) + Number(source.earnings || 0),
    videos: { ...(target.videos || {}) },
    recentSupports: [
      ...(Array.isArray(target.recentSupports) ? target.recentSupports : []),
      ...(Array.isArray(source.recentSupports) ? source.recentSupports : [])
    ],
    supporterFirstSeen: {
      ...(target.supporterFirstSeen || {})
    },
    supporterOrder: Array.isArray(target.supporterOrder)
      ? [...target.supporterOrder]
      : []
  };

  Object.entries(source.videos || {}).forEach(([videoId, sourceVideo]) => {
    const existing = merged.videos[videoId] || {};
    merged.videos[videoId] = {
      ...existing,
      ...sourceVideo,
      supports: Number(existing.supports || 0) + Number(sourceVideo.supports || 0)
    };
  });

  Object.entries(source.supporterFirstSeen || {}).forEach(([anonId, firstSeen]) => {
    const current = Number(merged.supporterFirstSeen[anonId] || 0);
    const next = Number(firstSeen || 0);

    if (!current || (next && next < current)) {
      merged.supporterFirstSeen[anonId] = next;
    }
  });

  [
    ...(Array.isArray(source.supporterOrder) ? source.supporterOrder : []),
    ...merged.recentSupports
      .sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
      .map(item => String(item.anonId || "").trim())
  ].forEach(anonId => {
    if (anonId && !merged.supporterOrder.includes(anonId)) {
      merged.supporterOrder.push(anonId);
    }
  });

  merged.recentSupports = merged.recentSupports
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, 100);

  return merged;
}

app.get("/", (req, res) => {
  redirectHome(req, res);
});

app.get(["/Support Creator.html", "/Support%20Creator.html"], (req, res) => {
  redirectHome(req, res);
});

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

app.use(express.static('public'));

const redirectUri =
  process.env.GOOGLE_REDIRECT_URI ||
  "https://oscal.onrender.com/auth/youtube/callback";

debugLog("REDIRECT URI:", redirectUri);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

async function importRecentYouTubeVideos(profile, youtube, channelId) {
  if (!profile?.slug || !channelId || !youtube?.search?.list) return;

  try {
    const response = await youtube.search.list({
      part: ["snippet"],
      channelId,
      maxResults: 10,
      order: "date",
      type: "video"
    });

    const creatorKey = getCanonicalCreatorKey(profile.slug);
    const bucket = getCreatorVideoBucket(creatorKey);
    let changed = false;

    (response.data.items || []).forEach(item => {
      const platformVideoId = item.id?.videoId;
      if (!platformVideoId) return;

      const normalized = normalizeCreatorVideoRecord({
        id: `youtube_${platformVideoId}`,
        creatorSlug: creatorKey,
        platform: "youtube",
        platformVideoId,
        title: item.snippet?.title || "YouTube video",
        thumbnailUrl:
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          "",
        contentUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(platformVideoId)}`,
        publishedAt: Date.parse(item.snippet?.publishedAt || "") || Date.now(),
        isEligible: true
      }, creatorKey);

      if (normalized && JSON.stringify(bucket[normalized.id]) !== JSON.stringify(normalized)) {
        bucket[normalized.id] = normalized;
        changed = true;
      }
    });

    if (changed) saveData();
  } catch (err) {
    console.error("Could not import recent YouTube videos:", err.message || err);
  }
}

app.get("/auth/youtube", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    redirect_uri: redirectUri,
    scope: ["https://www.googleapis.com/auth/youtube.readonly"],
    prompt: "consent"
  });

  res.redirect(url);
});

app.get("/auth/creator", (req, res) => {
  res.redirect("/auth/youtube");
});

app.get("/auth/youtube/callback", async (req, res) => {
  const { code } = req.query;

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client
  });

  const response = await youtube.channels.list({
    part: ["snippet"],
    mine: true
  });

  const channel = response.data.items?.[0];

  if (!channel?.snippet) {
    return res.status(502).send("Could not load your creator profile. Please try logging in again.");
  }

  const profileImage =
    channel.snippet.thumbnails?.high?.url ||
    channel.snippet.thumbnails?.medium?.url ||
    channel.snippet.thumbnails?.default?.url ||
    "";

  const creatorProfile = {
    slug: channel.snippet.customUrl || channel.id,
    displayName: channel.snippet.title,
    profileImage,
    youtubeChannelId: channel.id
  };

  storeCreatorProfile(creatorProfile, channel.id);
  await importRecentYouTubeVideos(creatorProfile, youtube, channel.id);
  rememberCreatorOwnerDevice(req, creatorProfile.slug);
  saveData();
  req.session.creatorProfile = creatorProfile;

  req.session.save(() => {
    res.redirect("/dashboard");
  });
});



// ---------- Data storage ----------

const RENDER_DISK_DEFAULT_DIR = "/var/data";

function getDefaultDataDir() {
  if (fs.existsSync(RENDER_DISK_DEFAULT_DIR)) {
    return RENDER_DISK_DEFAULT_DIR;
  }

  return path.join(__dirname, "data");
}

function resolveSqlitePath() {
  const configuredPath = process.env.SQLITE_PATH || process.env.SQLITE_DB_PATH;

  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  const configuredDir = process.env.DATA_DIR || getDefaultDataDir();
  return path.join(path.resolve(configuredDir), "app.sqlite");
}

const DB_PATH = resolveSqlitePath();
const DATA_DIR = path.dirname(DB_PATH);
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const THUMBNAIL_UPLOAD_DIR = path.join(UPLOADS_DIR, "thumbnails");
const hasConfiguredPersistentStore = Boolean(
  process.env.DATA_DIR ||
  process.env.SQLITE_PATH ||
  process.env.SQLITE_DB_PATH ||
  DATA_DIR === RENDER_DISK_DEFAULT_DIR
);

if (process.env.NODE_ENV === "production" && !hasConfiguredPersistentStore) {
  console.warn(
    `SQLite data is using ${DB_PATH}. Set DATA_DIR to a Render Disk mount path so supports survive restarts.`
  );
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(THUMBNAIL_UPLOAD_DIR)) {
  fs.mkdirSync(THUMBNAIL_UPLOAD_DIR, { recursive: true });
}

app.use("/uploads", express.static(UPLOADS_DIR));

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limit_hits (
    bucket TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_bucket_time
    ON rate_limit_hits(bucket, created_at);
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    video_url TEXT NOT NULL,
    normalized_video_key TEXT NOT NULL,
    platform TEXT NOT NULL,
    platform_video_id TEXT,
    thumbnail_url TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    activated_at TEXT,
    deactivated_at TEXT,
    archived_at TEXT,
    legacy_supports INTEGER NOT NULL DEFAULT 0,
    legacy_earnings REAL NOT NULL DEFAULT 0,
    UNIQUE (creator_id, normalized_video_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_one_active
    ON campaigns (creator_id)
    WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_campaigns_creator_status
    ON campaigns (creator_id, status);
  CREATE TABLE IF NOT EXISTS campaign_supports (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    viewer_key TEXT NOT NULL,
    anon_id TEXT,
    fingerprint_hash TEXT,
    attempt_id TEXT UNIQUE,
    completed_at TEXT NOT NULL,
    reward_amount REAL NOT NULL,
    source_platform TEXT,
    source_referrer TEXT,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );
  CREATE INDEX IF NOT EXISTS idx_campaign_supports_viewer
    ON campaign_supports (campaign_id, viewer_key);
  CREATE INDEX IF NOT EXISTS idx_campaign_supports_creator_time
    ON campaign_supports (creator_id, completed_at);
  CREATE TABLE IF NOT EXISTS support_attempts (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    viewer_key TEXT NOT NULL,
    anon_id TEXT,
    fingerprint_hash TEXT,
    source_platform TEXT,
    source_referrer TEXT,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    status TEXT NOT NULL DEFAULT 'started',
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );
  CREATE INDEX IF NOT EXISTS idx_support_attempts_campaign_viewer
    ON support_attempts (campaign_id, viewer_key);
`);

const getStateStmt = db.prepare("SELECT value FROM app_state WHERE key = ?");
const setStateStmt = db.prepare(`
  INSERT INTO app_state (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

function readState(key, fallback) {
  const row = getStateStmt.get(key);
  if (!row) return fallback;

  try {
    return JSON.parse(row.value);
  } catch (err) {
    console.error(`Could not parse DB state for ${key}:`, err);
    return fallback;
  }
}

function writeState(key, value) {
  setStateStmt.run(key, JSON.stringify(value), Date.now());
}

function hasPersistedState() {
  return Boolean(getStateStmt.get("creatorStats"));
}

function migrateJsonDataIfNeeded() {
  if (hasPersistedState() || !fs.existsSync("data.json")) return;

  try {
    const data = JSON.parse(fs.readFileSync("data.json", "utf8"));

    writeState("userProgress", data.userProgress || {});
    writeState("creatorStats", data.creatorStats || {});
    writeState("events", data.events || []);
    writeState("supporterProfiles", data.supporterProfiles || {});
    writeState("supporterStats", data.supporterStats || {});
    writeState("creatorProfiles", data.creatorProfiles || {});
    writeState("creatorOwnerDevices", data.creatorOwnerDevices || {});
    writeState("creatorVideos", data.creatorVideos || {});
    writeState("supportRecords", data.supportRecords || {});

    console.log("Migrated data.json into data/app.sqlite");
  } catch (err) {
    console.error("Could not migrate data.json, starting with empty DB state:", err);
  }
}

migrateJsonDataIfNeeded();

userProgress = readState("userProgress", {});
creatorStats = readState("creatorStats", {});
events = readState("events", []);
supporterProfiles = readState("supporterProfiles", {});
supporterStats = readState("supporterStats", {});
creatorProfiles = readState("creatorProfiles", {});
creatorOwnerDevices = readState("creatorOwnerDevices", {});
creatorVideos = readState("creatorVideos", {});
supportRecords = readState("supportRecords", {});

// ---------- Helpers ----------
function hashFingerprint(fingerprintString) {
  return crypto.createHash('sha256').update(fingerprintString).digest('hex');
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return forwarded || req.socket.remoteAddress || req.ip || "unknown";
}

function getDeviceProgressKey(req, fingerprint) {
  return hashFingerprint(`${getClientIp(req)}|${String(fingerprint || "").trim()}`);
}

function normalizeOwnerDeviceRecord(record = {}) {
  return {
    ipHashes:
      record.ipHashes && typeof record.ipHashes === "object"
        ? record.ipHashes
        : {},
    deviceKeys:
      record.deviceKeys && typeof record.deviceKeys === "object"
        ? record.deviceKeys
        : {}
  };
}

function pruneOwnerDeviceRecord(record, now = Date.now()) {
  ["ipHashes", "deviceKeys"].forEach(group => {
    Object.entries(record[group] || {}).forEach(([key, seenAt]) => {
      if (now - Number(seenAt || 0) > OWNER_DEVICE_TTL_MS) {
        delete record[group][key];
      }
    });
  });
}

function getOwnerDeviceFamily(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function getOwnerIpHash(req) {
  return hashFingerprint(`creator-owner-ip|${getClientIp(req)}`);
}

function getOwnerDeviceKey(req, deviceFamily) {
  const family = getOwnerDeviceFamily(deviceFamily);
  if (!family) return "";

  const userAgent = String(req.headers["user-agent"] || "").slice(0, 260);
  return hashFingerprint(`creator-owner-device|${getClientIp(req)}|${family}|${userAgent}`);
}

function rememberCreatorOwnerDevice(req, creator, deviceFamily = "") {
  const creatorKey = getCanonicalCreatorKey(creator, req);
  if (!creatorKey) return false;

  const now = Date.now();
  const record = normalizeOwnerDeviceRecord(creatorOwnerDevices[creatorKey]);
  pruneOwnerDeviceRecord(record, now);

  let changed = false;
  const ipHash = getOwnerIpHash(req);
  const deviceKey = getOwnerDeviceKey(req, deviceFamily);

  if (!record.ipHashes[ipHash] || now - Number(record.ipHashes[ipHash]) > 24 * 60 * 60 * 1000) {
    record.ipHashes[ipHash] = now;
    changed = true;
  }

  if (
    deviceKey &&
    (!record.deviceKeys[deviceKey] || now - Number(record.deviceKeys[deviceKey]) > 24 * 60 * 60 * 1000)
  ) {
    record.deviceKeys[deviceKey] = now;
    changed = true;
  }

  creatorOwnerDevices[creatorKey] = record;
  if (changed) saveData();

  return changed;
}

function isKnownCreatorOwnerDevice(req, creator, deviceFamily = "") {
  const creatorKey = getCanonicalCreatorKey(creator, req);
  if (!creatorKey) return false;

  const record = normalizeOwnerDeviceRecord(creatorOwnerDevices[creatorKey]);
  pruneOwnerDeviceRecord(record);
  creatorOwnerDevices[creatorKey] = record;

  const deviceKey = getOwnerDeviceKey(req, deviceFamily);
  if (deviceKey && record.deviceKeys[deviceKey]) return true;

  return false;
}

const insertRateLimitHitStmt = db.prepare(
  "INSERT INTO rate_limit_hits (bucket, created_at) VALUES (?, ?)"
);
const countRateLimitHitsStmt = db.prepare(
  "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM rate_limit_hits WHERE bucket = ? AND created_at >= ?"
);
const pruneRateLimitHitsStmt = db.prepare(
  "DELETE FROM rate_limit_hits WHERE created_at < ?"
);
let lastRateLimitPrune = 0;

function getRateLimitBucket(req, scope) {
  const fingerprint = req.body?.fingerprint || "";
  return hashFingerprint(`${scope}|${getClientIp(req)}|${String(fingerprint).slice(0, 400)}`);
}

function checkRateLimit(req, scope, windowMs, maxHits) {
  const now = Date.now();
  const cutoff = now - windowMs;

  if (now - lastRateLimitPrune > 60_000) {
    pruneRateLimitHitsStmt.run(now - 24 * 60 * 60 * 1000);
    lastRateLimitPrune = now;
  }

  const bucket = getRateLimitBucket(req, scope);
  const row = countRateLimitHitsStmt.get(bucket, cutoff);
  const count = Number(row?.count || 0);

  if (count >= maxHits) {
    const oldest = Number(row?.oldest || now);
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    };
  }

  insertRateLimitHitStmt.run(bucket, now);
  return { allowed: true, retryAfter: 0 };
}

function enforceRateLimit(scope, windowMs, maxHits) {
  return (req, res, next) => {
    const limit = checkRateLimit(req, scope, windowMs, maxHits);

    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfter));
      return res.status(429).json({
        success: false,
        message: "Too many attempts. Try again soon.",
        wait: limit.retryAfter
      });
    }

    next();
  };
}

function isLocalRequest(req) {
  const ip = getClientIp(req);
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function requireDevAccess(req, res, next) {
  const token = req.headers["x-dev-token"] || req.query.token;

  if (process.env.DEV_RESET_TOKEN && token === process.env.DEV_RESET_TOKEN) {
    return next();
  }

  if (process.env.NODE_ENV !== "production" && isLocalRequest(req)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "Dev reset is locked."
  });
}

function requireDevResetAccess(req, res, next) {
  if (IS_PRODUCTION && process.env.ENABLE_DEV_RESET !== "true") {
    return res.status(403).json({
      success: false,
      message: "Dev reset is disabled."
    });
  }

  return requireDevAccess(req, res, next);
}

function getToday(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function getSecondsUntilUserMidnight(timeZone) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now);

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = parseInt(part.value, 10);
    }
  }

  const userNowUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour,
    map.minute,
    map.second
  );

  const nextMidnightUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day + 1,
    0,
    0,
    0
  );

  return Math.max(0, Math.floor((nextMidnightUtc - userNowUtc) / 1000));
}

function normalizeSupporterName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function validateSupporterName(name) {
  if (!name) return null;

  if (name.length > 24) {
    return 'Use 24 characters or fewer.';
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    return 'Use letters, numbers, spaces, hyphens, or underscores. Start with a letter or number.';
  }

  return null;
}

function saveData() {
  db.exec("BEGIN IMMEDIATE");

  try {
    writeState("userProgress", userProgress);
    writeState("creatorStats", creatorStats);
    writeState("events", events);
    writeState("supporterProfiles", supporterProfiles);
    writeState("supporterStats", supporterStats);
    writeState("creatorProfiles", creatorProfiles);
    writeState("creatorOwnerDevices", creatorOwnerDevices);
    writeState("creatorVideos", creatorVideos);
    writeState("supportRecords", supportRecords);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function canonicalizeSupporterCreatorCounts(counts) {
  if (!counts || typeof counts !== "object") return {};

  return Object.entries(counts).reduce((result, [creator, count]) => {
    const key = getCanonicalCreatorKey(creator);
    if (!key) return result;

    result[key] = Number(result[key] || 0) + Number(count || 0);
    return result;
  }, {});
}

function canonicalizeSupporterCreatorTimes(times) {
  if (!times || typeof times !== "object") return {};

  return Object.entries(times).reduce((result, [creator, time]) => {
    const key = getCanonicalCreatorKey(creator);
    const next = Number(time || 0);
    const current = Number(result[key] || 0);

    if (key && (!current || (next && next < current))) {
      result[key] = next;
    }

    return result;
  }, {});
}

function canonicalizeStoredCreatorStats() {
  let changed = false;
  const nextCreatorStats = {};
  const nextCreatorOwnerDevices = {};

  Object.entries(creatorStats).forEach(([creator, stats]) => {
    const canonicalKey = getCanonicalCreatorKey(creator);
    if (!canonicalKey) return;

    if (canonicalKey !== creator) changed = true;
    nextCreatorStats[canonicalKey] = mergeCreatorStatRecords(
      nextCreatorStats[canonicalKey],
      stats
    );
  });

  Object.entries(supporterStats).forEach(([anonId, stats]) => {
    if (!stats || typeof stats !== "object") return;

    const supportedCreators = canonicalizeSupporterCreatorCounts(stats.supportedCreators);
    const dayOneCreators = canonicalizeSupporterCreatorTimes(stats.dayOneCreators);

    if (
      JSON.stringify(supportedCreators) !== JSON.stringify(stats.supportedCreators || {}) ||
      JSON.stringify(dayOneCreators) !== JSON.stringify(stats.dayOneCreators || {})
    ) {
      changed = true;
      supporterStats[anonId] = {
        ...stats,
        supportedCreators,
        dayOneCreators
      };
    }
  });

  Object.entries(creatorOwnerDevices).forEach(([creator, record]) => {
    const canonicalKey = getCanonicalCreatorKey(creator);
    if (!canonicalKey) return;

    const normalizedRecord = normalizeOwnerDeviceRecord(record);
    pruneOwnerDeviceRecord(normalizedRecord);

    if (canonicalKey !== creator) changed = true;

    const targetRecord = normalizeOwnerDeviceRecord(nextCreatorOwnerDevices[canonicalKey]);
    ["ipHashes", "deviceKeys"].forEach(group => {
      Object.entries(normalizedRecord[group]).forEach(([key, seenAt]) => {
        targetRecord[group][key] = Math.max(
          Number(targetRecord[group][key] || 0),
          Number(seenAt || 0)
        );
      });
    });
    nextCreatorOwnerDevices[canonicalKey] = targetRecord;
  });

  if (JSON.stringify(nextCreatorOwnerDevices) !== JSON.stringify(creatorOwnerDevices)) {
    creatorOwnerDevices = nextCreatorOwnerDevices;
    changed = true;
  }

  if (changed) {
    creatorStats = nextCreatorStats;
    saveData();
  }
}

canonicalizeStoredCreatorStats();

// ---------- Config ----------
const MAX_CAMPAIGN_SUPPORTS_PER_VIEWER = 3;
const COOLDOWN_MS = 30_000; // 30 seconds
const REWARD_PER_SUPPORT = 0.05;
const MIN_AD_WATCH_MS = 14_000; // basic backend validation
const SUPPORT_ATTEMPT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_BETA_END_AT = Date.UTC(2026, 8, 1);
const parsedBetaEndAt = Date.parse(process.env.BETA_END_AT || "");
const BETA_END_AT = Number.isFinite(parsedBetaEndAt)
  ? parsedBetaEndAt
  : DEFAULT_BETA_END_AT;
const DAY_ONE_SUPPORTER_LIMIT = Math.max(
  1,
  Number(process.env.DAY_ONE_SUPPORTER_LIMIT || 5)
);
const BADGE_DEFINITIONS = [
  {
    id: "og_wave",
    label: "OG Wave",
    short: "OG",
    unlockCondition: "Support during Oscal beta",
    description: "A supporter during Oscal beta."
  },
  {
    id: "first_drop",
    label: "First Drop",
    short: "Drop",
    unlockCondition: "First successful support",
    description: "Completed a first successful support."
  },
  {
    id: "wave_starter",
    label: "Wave Starter",
    short: "Wave",
    unlockCondition: "Support 5 creators",
    description: "Supported 5 different creators."
  },
  {
    id: "fuel_provider",
    label: "Fuel Provider",
    short: "Fuel",
    unlockCondition: "Reach 25 total supports",
    description: "Reached 25 total supports."
  },
  {
    id: "day_one",
    label: "Day One",
    short: "D1",
    unlockCondition: `Be one of the first ${DAY_ONE_SUPPORTER_LIMIT} supporters of a creator`,
    description: `One of the first ${DAY_ONE_SUPPORTER_LIMIT} supporters of a creator.`
  }
];
const SPONSOR_AD_DIR = path.join(__dirname, "public", "ads");
const SPONSOR_AD_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const SPONSOR_AD_CLICK_URLS = {
  "1000004233.mp4": "https://www.tiktok.com/t/ZP9jBjs2Xf1dD-8YB63/",
  "14edef0cbf8a2d40565eb5af393e1aad.mp4": "https://www.tiktok.com/t/ZP9jBUuGC2UoB-GbJqv/",
  "53b751172cd670e0d39bcaaabf7c2df4.mp4": "https://www.tiktok.com/t/ZP9jBP6NX9JAM-0yiKG/",
  "2f94ebea9be3d6a5fec118b6d6b307e0.mp4": "https://www.tiktok.com/t/ZP9jBmBcaw8pS-Yr9uz/"
};
const DEFAULT_SPONSOR_CLICK_URL = SPONSOR_AD_CLICK_URLS["1000004233.mp4"];
const STICKER_DIR = path.join(__dirname, "public", "stickers");
const STICKER_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const STICKER_EXTENSION_PRIORITY = {
  ".webm": 1,
  ".mp4": 2,
  ".m4v": 3,
  ".mov": 4
};
const CONTENT_PLATFORMS = new Set(["tiktok", "instagram", "youtube"]);
const SOURCE_PLATFORMS = new Set(["tiktok", "instagram", "youtube", "direct"]);
const ATTRIBUTION_TYPES = new Set(["selected_video", "creator_only", "skipped"]);
const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;
const METADATA_FETCH_TIMEOUT_MS = 6500;
const MAX_THUMBNAIL_UPLOAD_BYTES = 3 * 1024 * 1024;
const INSTAGRAM_OEMBED_ACCESS_TOKEN =
  process.env.INSTAGRAM_OEMBED_ACCESS_TOKEN ||
  process.env.META_OEMBED_ACCESS_TOKEN ||
  "";

function normalizeSourcePlatform(value, fallback = "direct") {
  const platform = String(value || "").trim().toLowerCase();
  return SOURCE_PLATFORMS.has(platform) ? platform : fallback;
}

function normalizeContentPlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  return CONTENT_PLATFORMS.has(platform) ? platform : "";
}

function getPlatformLabel(platform) {
  return {
    tiktok: "TikTok",
    instagram: "Instagram",
    youtube: "YouTube",
    direct: "Direct",
    other: "Other"
  }[String(platform || "").trim().toLowerCase()] || "Other";
}

function cleanText(value, maxLength = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalUrl(value, maxLength = 800) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().slice(0, maxLength);
  } catch (_) {
    return "";
  }
}

function isValidPlatformPostUrl(platform, value) {
  const normalizedPlatform = normalizeContentPlatform(platform);
  const raw = normalizeOptionalUrl(value, 1000);
  if (!normalizedPlatform || !raw) return false;

  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");

  if (normalizedPlatform === "tiktok") {
    return host === "tiktok.com" || host === "vm.tiktok.com";
  }

  if (normalizedPlatform === "instagram") {
    return host === "instagram.com";
  }

  if (normalizedPlatform === "youtube") {
    return host === "youtube.com" || host === "youtu.be";
  }

  return false;
}

function getVideoIdFromContentUrl(platform, contentUrl) {
  const base = `${normalizeContentPlatform(platform)}|${normalizeOptionalUrl(contentUrl, 1000)}`;
  return `video_${hashFingerprint(base).slice(0, 18)}`;
}

function saveThumbnailUpload(dataUrl, creatorKey, videoId) {
  const raw = String(dataUrl || "").trim();
  if (!raw) return "";

  const match = raw.match(/^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error("Upload a PNG, JPG, WebP, or GIF thumbnail image.");
  }

  const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");

  if (!buffer.length || buffer.length > MAX_THUMBNAIL_UPLOAD_BYTES) {
    throw new Error("Thumbnail image must be smaller than 3 MB.");
  }

  const safeCreator = cleanText(creatorKey, 80).replace(/[^a-z0-9_-]/gi, "_") || "creator";
  const safeVideoId = cleanText(videoId, 80).replace(/[^a-z0-9_-]/gi, "_") || hashFingerprint(raw).slice(0, 16);
  const filename = `${safeCreator}_${safeVideoId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${extension}`;
  const filePath = path.join(THUMBNAIL_UPLOAD_DIR, filename);

  fs.writeFileSync(filePath, buffer);
  return `/uploads/thumbnails/${filename}`;
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Oscal metadata preview"
      }
    });

    if (!response.ok) {
      throw new Error(`Metadata request failed with ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOEmbedMetadata(platform, contentUrl, data = {}) {
  return {
    platform,
    contentUrl,
    title: cleanText(data.title || data.author_name || "", 120),
    thumbnailUrl: normalizeOptionalUrl(data.thumbnail_url || "", 1000),
    publishedAt: 0
  };
}

async function fetchPlatformPostMetadata(platform, contentUrl) {
  const normalizedPlatform = normalizeContentPlatform(platform);
  const normalizedUrl = normalizeOptionalUrl(contentUrl, 1000);

  if (!normalizedPlatform || !isValidPlatformPostUrl(normalizedPlatform, normalizedUrl)) {
    throw new Error("Invalid platform URL.");
  }

  if (normalizedPlatform === "tiktok") {
    const url = new URL("https://www.tiktok.com/oembed");
    url.searchParams.set("url", normalizedUrl);
    return normalizeOEmbedMetadata(normalizedPlatform, normalizedUrl, await fetchJsonWithTimeout(url));
  }

  if (normalizedPlatform === "youtube") {
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", normalizedUrl);
    url.searchParams.set("format", "json");
    return normalizeOEmbedMetadata(normalizedPlatform, normalizedUrl, await fetchJsonWithTimeout(url));
  }

  if (normalizedPlatform === "instagram") {
    if (!INSTAGRAM_OEMBED_ACCESS_TOKEN) {
      throw new Error("Instagram metadata needs Meta oEmbed access.");
    }

    const url = new URL("https://graph.facebook.com/v24.0/instagram_oembed");
    url.searchParams.set("url", normalizedUrl);
    url.searchParams.set("access_token", INSTAGRAM_OEMBED_ACCESS_TOKEN);
    return normalizeOEmbedMetadata(normalizedPlatform, normalizedUrl, await fetchJsonWithTimeout(url));
  }

  throw new Error("Unsupported platform.");
}

function getCreatorVideoBucket(creatorKey) {
  if (!creatorVideos[creatorKey] || typeof creatorVideos[creatorKey] !== "object") {
    creatorVideos[creatorKey] = {};
  }

  return creatorVideos[creatorKey];
}

function normalizeCreatorVideoRecord(video, creatorKey) {
  if (!video || typeof video !== "object") return null;

  const platform = normalizeContentPlatform(video.platform);
  if (!platform) return null;

  const contentUrl = normalizeOptionalUrl(video.contentUrl || video.url, 1000);
  const id = cleanText(video.id || video.videoId || getVideoIdFromContentUrl(platform, contentUrl), 80);
  const title = cleanText(video.title || video.videoTitle || video.caption || "Untitled video", 120);
  const now = Date.now();

  return {
    id,
    creatorSlug: creatorKey,
    platform,
    platformVideoId: cleanText(video.platformVideoId || video.videoId || "", 120),
    title,
    thumbnailUrl: normalizeOptionalUrl(video.thumbnailUrl || video.videoThumbnail, 1000),
    contentUrl,
    publishedAt: Number(video.publishedAt || 0),
    isEligible: video.isEligible !== false,
    createdAt: Number(video.createdAt || now)
  };
}

function normalizeCreatorVideoState() {
  let changed = false;

  Object.entries(creatorVideos || {}).forEach(([creator, bucket]) => {
    const creatorKey = getCanonicalCreatorKey(creator);
    if (!creatorKey || !bucket || typeof bucket !== "object") return;

    const target = getCreatorVideoBucket(creatorKey);
    Object.values(bucket).forEach(video => {
      const normalized = normalizeCreatorVideoRecord(video, creatorKey);
      if (!normalized) {
        changed = true;
        return;
      }

      target[normalized.id] = normalized;
      if (creatorKey !== creator || JSON.stringify(video) !== JSON.stringify(normalized)) {
        changed = true;
      }
    });

    if (creatorKey !== creator) {
      delete creatorVideos[creator];
      changed = true;
    }
  });

  Object.entries(creatorStats || {}).forEach(([creator, stats]) => {
    const creatorKey = getCanonicalCreatorKey(creator);
    if (!creatorKey || !stats?.videos) return;

    Object.values(stats.videos).forEach(video => {
      const normalized = normalizeCreatorVideoRecord({
        id: video.videoId,
        videoId: video.videoId,
        videoTitle: video.videoTitle,
        videoThumbnail: video.videoThumbnail,
        platform: video.platform,
        isEligible: false
      }, creatorKey);

      if (normalized && !getCreatorVideoBucket(creatorKey)[normalized.id]) {
        getCreatorVideoBucket(creatorKey)[normalized.id] = normalized;
        changed = true;
      }
    });
  });

  if (changed) saveData();
}

function getCreatorVideosList(creatorKey, platform = "") {
  const normalizedPlatform = normalizeContentPlatform(platform);
  const videos = Object.values(getCreatorVideoBucket(creatorKey));

  return videos
    .filter(video => !normalizedPlatform || video.platform === normalizedPlatform)
    .sort((a, b) => Number(b.publishedAt || b.createdAt || 0) - Number(a.publishedAt || a.createdAt || 0));
}

function getEligibleVideos(creatorKey, platform, limit = 0) {
  const normalizedSource = normalizeSourcePlatform(platform, "direct");
  const contentPlatform = normalizeContentPlatform(normalizedSource);
  const allVideos = getCreatorVideosList(creatorKey)
    .filter(video => video.isEligible !== false);
  const platformVideos = contentPlatform
    ? allVideos.filter(video => video.platform === contentPlatform)
    : allVideos;
  const videos = platformVideos.length ? platformVideos : allVideos;

  return limit > 0 ? videos.slice(0, limit) : videos;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCampaignUrlForKey(value) {
  const raw = normalizeOptionalUrl(value, 1200);
  if (!raw) return "";

  const url = new URL(raw);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
    .forEach(param => url.searchParams.delete(param));
  return url.toString();
}

function getYouTubeCampaignId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

  if (host === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] || "";
  }

  if (host === "youtube.com") {
    if (url.searchParams.get("v")) return url.searchParams.get("v");

    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || "";
  }

  return "";
}

function getTikTokCampaignId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) return "";

  const parts = url.pathname.split("/").filter(Boolean);
  const videoIndex = parts.indexOf("video");
  if (videoIndex >= 0 && parts[videoIndex + 1]) return parts[videoIndex + 1];

  return "";
}

function getInstagramCampaignId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "instagram.com") return "";

  const parts = url.pathname.split("/").filter(Boolean);
  if (["p", "reel", "tv"].includes(parts[0])) return parts[1] || "";

  return "";
}

function normalizeCampaignVideoIdentity(value) {
  const normalizedUrl = normalizeCampaignUrlForKey(value);
  if (!normalizedUrl) {
    throw new Error("INVALID_VIDEO_URL");
  }

  const url = new URL(normalizedUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

  let platform = "other";
  let platformVideoId = "";

  if (host === "youtube.com" || host === "youtu.be") {
    platform = "youtube";
    platformVideoId = getYouTubeCampaignId(url);
  } else if (["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) {
    platform = "tiktok";
    platformVideoId = getTikTokCampaignId(url);
  } else if (host === "instagram.com") {
    platform = "instagram";
    platformVideoId = getInstagramCampaignId(url);
  }

  const normalizedVideoKey =
    platformVideoId
      ? `${platform}:${platformVideoId}`
      : `${platform}:${normalizedUrl}`;

  return {
    videoUrl: normalizedUrl,
    platform,
    platformVideoId,
    normalizedVideoKey
  };
}

function getFallbackCampaignTitle(identity = {}) {
  const platformLabel = getPlatformLabel(identity.platform);
  const videoId = cleanText(identity.platformVideoId || "", 48);

  if (identity.platform === "other") {
    return "Video campaign";
  }

  return `${platformLabel} video${videoId ? ` ${videoId}` : ""}`;
}

async function getCampaignMetadataPreview(videoUrl) {
  let identity;
  try {
    identity = normalizeCampaignVideoIdentity(videoUrl);
  } catch (_) {
    const err = new Error("INVALID_VIDEO_URL");
    err.code = "INVALID_VIDEO_URL";
    throw err;
  }

  let metadata = { title: "", thumbnailUrl: "" };
  let warning = "";

  if (CONTENT_PLATFORMS.has(identity.platform)) {
    try {
      metadata = await fetchPlatformPostMetadata(identity.platform, identity.videoUrl);
    } catch (err) {
      warning = "Could not auto-fill this video. Add the title or thumbnail manually.";
      debugLog("Could not fetch campaign metadata:", err.message);
    }
  }

  return {
    platform: identity.platform,
    platformLabel: getPlatformLabel(identity.platform),
    platformVideoId: identity.platformVideoId,
    normalizedVideoKey: identity.normalizedVideoKey,
    videoUrl: identity.videoUrl,
    title: cleanText(metadata.title, 140) || getFallbackCampaignTitle(identity),
    thumbnailUrl: normalizeOptionalUrl(metadata.thumbnailUrl, 1200),
    warning
  };
}

function campaignErrorPayload(err) {
  const code = err?.code || err?.message || "CAMPAIGN_ERROR";
  const statusByCode = {
    NO_ACTIVE_CAMPAIGN: 404,
    CAMPAIGN_NOT_FOUND: 404,
    CAMPAIGN_NOT_OWNED: 403,
    CAMPAIGN_ALREADY_ACTIVE: 409,
    CAMPAIGN_ARCHIVED: 409,
    DUPLICATE_VIDEO_CAMPAIGN: 409,
    CAMPAIGN_SUPPORT_LIMIT_REACHED: 409,
    CAMPAIGN_CHANGED: 409,
    INVALID_VIDEO_URL: 400,
    INVALID_CAMPAIGN_TITLE: 400,
    INVALID_THUMBNAIL_UPLOAD: 400,
    AD_WATCH_TOO_SHORT: 400,
    SUPPORT_ATTEMPT_ALREADY_USED: 409,
    RATE_LIMITED: 429,
    SELF_SUPPORT_NOT_ALLOWED: 403,
    LEGACY_CAMPAIGN_LOCKED: 409
  };
  const messageByCode = {
    NO_ACTIVE_CAMPAIGN: "This creator does not currently have an active support island.",
    CAMPAIGN_NOT_FOUND: "Campaign not found.",
    CAMPAIGN_NOT_OWNED: "That campaign does not belong to this creator.",
    CAMPAIGN_ALREADY_ACTIVE: "That campaign is already active.",
    CAMPAIGN_ARCHIVED: "Archived campaigns cannot be used.",
    DUPLICATE_VIDEO_CAMPAIGN: "That video already has a campaign.",
    CAMPAIGN_SUPPORT_LIMIT_REACHED: "You fully supported this video.",
    CAMPAIGN_CHANGED: "The active campaign changed. Please start again.",
    INVALID_VIDEO_URL: "Enter a normal HTTP or HTTPS video URL.",
    INVALID_CAMPAIGN_TITLE: "Add a campaign title.",
    INVALID_THUMBNAIL_UPLOAD: err?.message || "Could not save thumbnail image.",
    AD_WATCH_TOO_SHORT: "Ad not fully watched.",
    SUPPORT_ATTEMPT_ALREADY_USED: "This support was already completed.",
    RATE_LIMITED: "Too many attempts. Try again soon.",
    SELF_SUPPORT_NOT_ALLOWED: "You cannot support your own island.",
    LEGACY_CAMPAIGN_LOCKED: "Historical support totals cannot be managed as campaigns."
  };

  return {
    status: statusByCode[code] || 400,
    body: {
      success: false,
      code,
      message: messageByCode[code] || "Could not update campaign."
    }
  };
}

function sendCampaignError(res, err) {
  const payload = campaignErrorPayload(err);
  return res.status(payload.status).json(payload.body);
}

function getCreatorPublicLink(slug) {
  return `/${encodeURIComponent(String(slug || "").replace(/^@+/, ""))}`;
}

function campaignRowToJson(row) {
  if (!row) return null;

  const supportStats = db.prepare(`
    SELECT COUNT(*) AS supports, COALESCE(SUM(reward_amount), 0) AS earnings
    FROM campaign_supports
    WHERE campaign_id = ?
  `).get(row.id);
  const completedSupports = Number(supportStats?.supports || 0);
  const completedEarnings = Number(supportStats?.earnings || 0);
  const legacySupports = Number(row.legacy_supports || 0);
  const legacyEarnings = Number(row.legacy_earnings || 0);

  return {
    id: row.id,
    creatorId: row.creator_id,
    title: row.title,
    videoUrl: row.video_url,
    normalizedVideoKey: row.normalized_video_key,
    platform: row.platform,
    platformVideoId: row.platform_video_id || "",
    thumbnailUrl: row.thumbnail_url || "",
    description: row.description || "",
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at || "",
    deactivatedAt: row.deactivated_at || "",
    archivedAt: row.archived_at || "",
    completedSupports,
    completedEarnings,
    legacySupports,
    legacyEarnings,
    totalSupports: completedSupports + legacySupports,
    totalEarnings: Number((completedEarnings + legacyEarnings).toFixed(2))
  };
}

function isLegacyCampaign(campaign) {
  return String(campaign?.normalizedVideoKey || campaign?.normalized_video_key || "").startsWith("legacy:");
}

function getCampaignById(campaignId) {
  const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(String(campaignId || ""));
  return campaignRowToJson(row);
}

function getActiveCampaignForCreator(creatorId) {
  const row = db.prepare(`
    SELECT * FROM campaigns
    WHERE creator_id = ? AND status = 'active' AND normalized_video_key NOT LIKE 'legacy:%'
    ORDER BY activated_at DESC
    LIMIT 1
  `).get(creatorId);

  return campaignRowToJson(row);
}

function getCampaignsForCreator(creatorId) {
  return db.prepare(`
    SELECT * FROM campaigns
    WHERE creator_id = ?
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'inactive' THEN 2 ELSE 3 END,
      COALESCE(activated_at, created_at) DESC
  `).all(creatorId).map(campaignRowToJson);
}

function getCampaignOptionsForCreator(creatorId, limit = 5) {
  return getCampaignsForCreator(creatorId)
    .filter(campaign => !isLegacyCampaign(campaign))
    .sort((a, b) => {
      const bTime = new Date(b.activatedAt || b.createdAt || 0).getTime();
      const aTime = new Date(a.activatedAt || a.createdAt || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

function getSupportCampaignForCreator(creatorId, requestedCampaignId = "") {
  const selectedCampaignId = String(requestedCampaignId || "").trim();

  if (selectedCampaignId) {
    const selectedCampaign = getCampaignById(selectedCampaignId);
    if (
      selectedCampaign &&
      selectedCampaign.creatorId === creatorId &&
      !isLegacyCampaign(selectedCampaign)
    ) {
      return selectedCampaign;
    }
  }

  return getActiveCampaignForCreator(creatorId);
}

function getCreatorCampaignTotals(creatorId) {
  const campaigns = getCampaignsForCreator(creatorId);
  return campaigns.reduce((totals, campaign) => {
    totals.supports += Number(campaign.totalSupports || 0);
    totals.earnings += Number(campaign.totalEarnings || 0);
    return totals;
  }, { supports: 0, earnings: 0 });
}

function getCampaignViewerKey(req, fingerprint) {
  return getDeviceProgressKey(req, fingerprint);
}

function getCampaignSupportCount(campaignId, viewerKey) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_supports
    WHERE campaign_id = ? AND viewer_key = ?
  `).get(campaignId, viewerKey);

  return Number(row?.count || 0);
}

function getCampaignStatusPayload(req, creatorId, fingerprint, requestedCampaignId = "") {
  const activeCampaign = getSupportCampaignForCreator(creatorId, requestedCampaignId);
  const campaignOptions = getCampaignOptionsForCreator(creatorId);
  const viewerKey = getCampaignViewerKey(req, fingerprint);

  if (!activeCampaign) {
    return {
      activeCampaign: null,
      campaignOptions,
      completedSupports: 0,
      remainingSupports: 0,
      maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER,
      canSupport: false,
      reason: "NO_ACTIVE_CAMPAIGN"
    };
  }

  const completedSupports = getCampaignSupportCount(activeCampaign.id, viewerKey);
  const remainingSupports = Math.max(0, MAX_CAMPAIGN_SUPPORTS_PER_VIEWER - completedSupports);

  return {
    activeCampaign,
    campaignOptions,
    completedSupports,
    remainingSupports,
    maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER,
    canSupport: remainingSupports > 0,
    reason: remainingSupports > 0 ? "" : "CAMPAIGN_SUPPORT_LIMIT_REACHED"
  };
}

function createCampaignForCreator(creatorId, payload = {}) {
  const description = cleanText(payload.description, 600);
  let thumbnailUrl = normalizeOptionalUrl(payload.thumbnailUrl, 1200);

  let identity;
  try {
    identity = normalizeCampaignVideoIdentity(payload.videoUrl);
  } catch (_) {
    const err = new Error("INVALID_VIDEO_URL");
    err.code = "INVALID_VIDEO_URL";
    throw err;
  }

  const title = cleanText(payload.title, 140) || getFallbackCampaignTitle(identity);

  if (!title || title.length < 2) {
    const err = new Error("INVALID_CAMPAIGN_TITLE");
    err.code = "INVALID_CAMPAIGN_TITLE";
    throw err;
  }

  const campaignId = `campaign_${crypto.randomBytes(12).toString("hex")}`;

  if (payload.thumbnailImageData) {
    try {
      thumbnailUrl = saveThumbnailUpload(payload.thumbnailImageData, creatorId, campaignId);
    } catch (err) {
      err.code = err.code || "INVALID_THUMBNAIL_UPLOAD";
      throw err;
    }
  }

  const campaign = {
    id: campaignId,
    creatorId,
    title,
    videoUrl: identity.videoUrl,
    normalizedVideoKey: identity.normalizedVideoKey,
    platform: identity.platform,
    platformVideoId: identity.platformVideoId,
    thumbnailUrl,
    description,
    createdAt: nowIso()
  };

  try {
    db.prepare(`
      INSERT INTO campaigns (
        id, creator_id, title, video_url, normalized_video_key, platform,
        platform_video_id, thumbnail_url, description, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      campaign.id,
      campaign.creatorId,
      campaign.title,
      campaign.videoUrl,
      campaign.normalizedVideoKey,
      campaign.platform,
      campaign.platformVideoId,
      campaign.thumbnailUrl,
      campaign.description,
      campaign.createdAt
    );
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      const duplicate = new Error("DUPLICATE_VIDEO_CAMPAIGN");
      duplicate.code = "DUPLICATE_VIDEO_CAMPAIGN";
      throw duplicate;
    }

    throw err;
  }

  return getCampaignById(campaign.id);
}

function activateCampaignForCreator(creatorId, campaignId) {
  const campaign = getCampaignById(campaignId);

  if (!campaign) {
    const err = new Error("CAMPAIGN_NOT_FOUND");
    err.code = "CAMPAIGN_NOT_FOUND";
    throw err;
  }

  if (campaign.creatorId !== creatorId) {
    const err = new Error("CAMPAIGN_NOT_OWNED");
    err.code = "CAMPAIGN_NOT_OWNED";
    throw err;
  }

  if (isLegacyCampaign(campaign)) {
    const err = new Error("LEGACY_CAMPAIGN_LOCKED");
    err.code = "LEGACY_CAMPAIGN_LOCKED";
    throw err;
  }

  if (campaign.status === "active") {
    const err = new Error("CAMPAIGN_ALREADY_ACTIVE");
    err.code = "CAMPAIGN_ALREADY_ACTIVE";
    throw err;
  }

  const timestamp = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE campaigns
      SET status = 'inactive', deactivated_at = ?
      WHERE creator_id = ? AND status = 'active'
    `).run(timestamp, creatorId);
    db.prepare(`
      UPDATE campaigns
      SET status = 'active', activated_at = ?, deactivated_at = NULL
      WHERE id = ? AND creator_id = ?
    `).run(timestamp, campaignId, creatorId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return getCampaignById(campaignId);
}

function deactivateCampaignForCreator(creatorId, campaignId) {
  const campaign = getCampaignById(campaignId);

  if (!campaign) {
    const err = new Error("CAMPAIGN_NOT_FOUND");
    err.code = "CAMPAIGN_NOT_FOUND";
    throw err;
  }

  if (campaign.creatorId !== creatorId) {
    const err = new Error("CAMPAIGN_NOT_OWNED");
    err.code = "CAMPAIGN_NOT_OWNED";
    throw err;
  }

  if (isLegacyCampaign(campaign)) {
    const err = new Error("LEGACY_CAMPAIGN_LOCKED");
    err.code = "LEGACY_CAMPAIGN_LOCKED";
    throw err;
  }

  if (campaign.status === "archived") {
    const err = new Error("CAMPAIGN_ARCHIVED");
    err.code = "CAMPAIGN_ARCHIVED";
    throw err;
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE campaigns
    SET status = 'inactive', deactivated_at = ?
    WHERE id = ? AND creator_id = ?
  `).run(timestamp, campaignId, creatorId);

  return getCampaignById(campaignId);
}

function archiveCampaignForCreator(creatorId, campaignId) {
  const campaign = getCampaignById(campaignId);

  if (!campaign) {
    const err = new Error("CAMPAIGN_NOT_FOUND");
    err.code = "CAMPAIGN_NOT_FOUND";
    throw err;
  }

  if (campaign.creatorId !== creatorId) {
    const err = new Error("CAMPAIGN_NOT_OWNED");
    err.code = "CAMPAIGN_NOT_OWNED";
    throw err;
  }

  if (isLegacyCampaign(campaign)) {
    const err = new Error("LEGACY_CAMPAIGN_LOCKED");
    err.code = "LEGACY_CAMPAIGN_LOCKED";
    throw err;
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE campaigns
    SET status = 'archived', archived_at = ?, deactivated_at = COALESCE(deactivated_at, ?)
    WHERE id = ? AND creator_id = ?
  `).run(timestamp, timestamp, campaignId, creatorId);

  return getCampaignById(campaignId);
}

function ensureLegacyCampaigns() {
  Object.entries(creatorStats || {}).forEach(([creator, stats]) => {
    const creatorId = getCanonicalCreatorKey(creator);
    const supports = Number(stats?.supports || 0);
    const earnings = Number(stats?.earnings || 0);

    if (!creatorId || supports <= 0) return;

    const existingLegacy = db.prepare(`
      SELECT id FROM campaigns
      WHERE creator_id = ? AND normalized_video_key = ?
      LIMIT 1
    `).get(creatorId, `legacy:${creatorId}`);

    if (existingLegacy) return;

    const campaignSupportStats = db.prepare(`
      SELECT COUNT(*) AS supports, COALESCE(SUM(reward_amount), 0) AS earnings
      FROM campaign_supports
      WHERE creator_id = ?
    `).get(creatorId);
    const legacySupports = Math.max(0, supports - Number(campaignSupportStats?.supports || 0));
    const legacyEarnings = Math.max(0, earnings - Number(campaignSupportStats?.earnings || 0));

    if (legacySupports <= 0 && legacyEarnings <= 0) return;

    db.prepare(`
      INSERT INTO campaigns (
        id, creator_id, title, video_url, normalized_video_key, platform,
        platform_video_id, thumbnail_url, description, status, created_at,
        legacy_supports, legacy_earnings
      )
      VALUES (?, ?, 'Legacy supports', ?, ?, 'other', '', '', 'Historical supports before campaign tracking.', 'inactive', ?, ?, ?)
      ON CONFLICT(creator_id, normalized_video_key) DO NOTHING
    `).run(
      `legacy_${hashFingerprint(creatorId).slice(0, 18)}`,
      creatorId,
      `legacy:${creatorId}`,
      `legacy:${creatorId}`,
      new Date(0).toISOString(),
      legacySupports,
      legacyEarnings
    );
  });
}

function createSupportAttempt({
  creatorId,
  campaignId,
  viewerKey,
  anonId,
  fingerprintHash,
  sourcePlatform,
  sourceReferrer,
  startedAt = Date.now()
}) {
  const attemptId = `attempt_${crypto.randomBytes(18).toString("hex")}`;
  const expiresAt = startedAt + SUPPORT_ATTEMPT_TTL_MS;

  db.prepare(`
    INSERT INTO support_attempts (
      id, creator_id, campaign_id, viewer_key, anon_id, fingerprint_hash,
      source_platform, source_referrer, started_at, expires_at, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')
  `).run(
    attemptId,
    creatorId,
    campaignId,
    viewerKey,
    String(anonId || "").trim(),
    fingerprintHash,
    sourcePlatform,
    sourceReferrer || "",
    startedAt,
    expiresAt
  );

  return {
    id: attemptId,
    creatorId,
    campaignId,
    viewerKey,
    anonId: String(anonId || "").trim(),
    fingerprintHash,
    sourcePlatform,
    sourceReferrer: sourceReferrer || "",
    startedAt,
    expiresAt,
    status: "started"
  };
}

function getSupportAttempt(attemptId) {
  return db.prepare("SELECT * FROM support_attempts WHERE id = ?")
    .get(String(attemptId || ""));
}

function markSupportAttemptUsed(attemptId, timestamp = Date.now()) {
  db.prepare(`
    UPDATE support_attempts
    SET used_at = ?, status = 'completed'
    WHERE id = ?
  `).run(timestamp, attemptId);
}

function normalizeSupportRecord(record, creatorKey = "") {
  if (!record || typeof record !== "object") return null;

  const completedAt = Number(record.completedAt || record.time || Date.now());
  const sourcePlatform = normalizeSourcePlatform(record.sourcePlatform, "direct");
  const supportId = cleanText(record.supportId || `support_${hashFingerprint(`${creatorKey}|${record.anonId || ""}|${completedAt}`).slice(0, 24)}`, 80);
  const attributionType = ATTRIBUTION_TYPES.has(record.attributionType)
    ? record.attributionType
    : "skipped";

  return {
    supportId,
    creatorSlug: creatorKey || getCanonicalCreatorKey(record.creatorSlug || record.creator || ""),
    anonId: String(record.anonId || "").trim(),
    deviceProgressKey: String(record.deviceProgressKey || record.fingerprint || "").trim(),
    sourcePlatform,
    selectedVideoId: cleanText(record.selectedVideoId || "", 120),
    attributionType,
    completedAt,
    attributedAt: Number(record.attributedAt || 0)
  };
}

function hydrateSupportRecordsFromRecentSupports() {
  let changed = false;

  Object.entries(creatorStats || {}).forEach(([creator, stats]) => {
    const creatorKey = getCanonicalCreatorKey(creator);
    if (!creatorKey || !Array.isArray(stats?.recentSupports)) return;

    stats.recentSupports.forEach(item => {
      const completedAt = Number(item.time || Date.now());
      const supportId = item.supportId ||
        `legacy_${hashFingerprint(`${creatorKey}|${item.anonId || ""}|${completedAt}`).slice(0, 24)}`;
      const normalized = normalizeSupportRecord({
        supportId,
        creatorSlug: creatorKey,
        anonId: item.anonId,
        deviceProgressKey: item.deviceProgressKey,
        sourcePlatform: item.sourcePlatform || "direct",
        selectedVideoId: item.selectedVideoId || "",
        attributionType: item.attributionType || "skipped",
        completedAt,
        attributedAt: item.attributedAt || 0
      }, creatorKey);

      if (!supportRecords[supportId]) {
        supportRecords[supportId] = normalized;
        changed = true;
      }

      ["supportId", "sourcePlatform", "selectedVideoId", "attributionType", "attributedAt"].forEach(key => {
        const next = key === "attributedAt"
          ? normalized.attributedAt
          : normalized[key] || (key === "attributionType" ? "skipped" : "");
        if (item[key] !== next) {
          item[key] = next;
          changed = true;
        }
      });
    });
  });

  Object.entries(supportRecords || {}).forEach(([supportId, record]) => {
    const normalized = normalizeSupportRecord(record, record.creatorSlug);
    if (!normalized) {
      delete supportRecords[supportId];
      changed = true;
      return;
    }

    if (supportId !== normalized.supportId) {
      delete supportRecords[supportId];
      supportRecords[normalized.supportId] = normalized;
      changed = true;
    } else if (JSON.stringify(record) !== JSON.stringify(normalized)) {
      supportRecords[supportId] = normalized;
      changed = true;
    }
  });

  if (changed) saveData();
}

function getSupportRecordsForCreator(creatorKey) {
  return Object.values(supportRecords || {})
    .filter(record => getCanonicalCreatorKey(record.creatorSlug) === creatorKey)
    .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0));
}

function getPlatformCountsForCreator(creatorKey) {
  const counts = { tiktok: 0, instagram: 0, youtube: 0, direct: 0 };

  getSupportRecordsForCreator(creatorKey).forEach(record => {
    counts[normalizeSourcePlatform(record.sourcePlatform)]++;
  });

  return counts;
}

function getVideoAttributionStats(creatorKey) {
  const videoCounts = {};
  let creatorOnly = 0;
  let noVideoSelected = 0;

  getSupportRecordsForCreator(creatorKey).forEach(record => {
    if (record.attributionType === "selected_video" && record.selectedVideoId) {
      videoCounts[record.selectedVideoId] = Number(videoCounts[record.selectedVideoId] || 0) + 1;
      return;
    }

    if (record.attributionType === "creator_only") {
      creatorOnly++;
      return;
    }

    noVideoSelected++;
  });

  const videos = Object.entries(videoCounts)
    .map(([videoId, count]) => {
      const video = getCreatorVideoBucket(creatorKey)[videoId] || {};
      return {
        ...video,
        id: videoId,
        title: video.title || "Unknown video",
        attributedSupports: count
      };
    })
    .sort((a, b) => Number(b.attributedSupports || 0) - Number(a.attributedSupports || 0));

  return { videos, creatorOnly, noVideoSelected };
}

function getSponsorAds() {
  try {
    if (!fs.existsSync(SPONSOR_AD_DIR)) return [];

    return fs
      .readdirSync(SPONSOR_AD_DIR)
      .filter(file => SPONSOR_AD_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .map(file => ({
        file,
        title: path.basename(file, path.extname(file)).replace(/[-_]+/g, " "),
        url: `/ads/${encodeURIComponent(file)}`,
        clickUrl: SPONSOR_AD_CLICK_URLS[file] || DEFAULT_SPONSOR_CLICK_URL
      }));
  } catch (err) {
    console.error("Could not read sponsor ads:", err);
    return [];
  }
}

app.get("/api/sponsor-ad", enforceRateLimit("sponsor-ad", 60_000, 40), (req, res) => {
  const ads = getSponsorAds();

  if (!ads.length) {
    return res.json({
      success: true,
      ad: null,
      minimumWatchMs: MIN_AD_WATCH_MS + 1000
    });
  }

  const ad = ads[Math.floor(Math.random() * ads.length)];

  res.json({
    success: true,
    ad,
    minimumWatchMs: MIN_AD_WATCH_MS + 1000
  });
});

function getStickerVideos() {
  try {
    if (!fs.existsSync(STICKER_DIR)) return [];

    const stickerMap = new Map();

    fs
      .readdirSync(STICKER_DIR)
      .filter(file => STICKER_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .forEach(file => {
        const ext = path.extname(file).toLowerCase();
        const key = path.basename(file, ext).toLowerCase();
        const current = stickerMap.get(key);

        if (
          current &&
          STICKER_EXTENSION_PRIORITY[current.ext] <= STICKER_EXTENSION_PRIORITY[ext]
        ) {
          return;
        }

        stickerMap.set(key, {
          ext,
          file,
          title: path.basename(file, ext).replace(/[-_]+/g, " "),
          url: `/stickers/${encodeURIComponent(file)}`
        });
      });

    return Array.from(stickerMap.values()).map(({ ext, ...sticker }, index) => ({
      ...sticker,
      title: `Sticker ${index + 1}`
    }));
  } catch (err) {
    console.error("Could not read sticker videos:", err);
    return [];
  }
}

function normalizeSupporterStats(stats = {}, firstSeenAt = Date.now()) {
  const firstSeen = Number(stats.firstSeenAt || firstSeenAt || Date.now());

  return {
    firstSeenAt: firstSeen,
    lastSupportAt: Number(stats.lastSupportAt || 0),
    totalSupports: Number(stats.totalSupports || 0),
    supportedCreators:
      stats.supportedCreators && typeof stats.supportedCreators === "object"
        ? stats.supportedCreators
        : {},
    dayOneCreators:
      stats.dayOneCreators && typeof stats.dayOneCreators === "object"
        ? stats.dayOneCreators
        : {},
    equippedBadgeId:
      typeof stats.equippedBadgeId === "string"
        ? stats.equippedBadgeId
        : ""
  };
}

function getOrCreateSupporterStats(anonId, firstSeenAt = Date.now()) {
  const key = String(anonId || "").trim();
  if (!key) return normalizeSupporterStats({}, firstSeenAt);

  supporterStats[key] = normalizeSupporterStats(supporterStats[key], firstSeenAt);
  return supporterStats[key];
}

function ensureCreatorSupporterTracking(creator) {
  const { stats } = getCreatorStatsRecord(creator);
  if (!stats) return false;

  let changed = false;

  if (!stats.supporterFirstSeen || typeof stats.supporterFirstSeen !== "object") {
    stats.supporterFirstSeen = {};
    changed = true;
  }

  if (!Array.isArray(stats.supporterOrder)) {
    stats.supporterOrder = [];
    changed = true;
  }

  if (Array.isArray(stats.recentSupports)) {
    [...stats.recentSupports]
      .sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
      .forEach(item => {
        const key = String(item.anonId || "").trim();
        if (!key) return;

        if (!stats.supporterFirstSeen[key]) {
          stats.supporterFirstSeen[key] = Number(item.time || Date.now());
          changed = true;
        }

        if (!stats.supporterOrder.includes(key)) {
          stats.supporterOrder.push(key);
          changed = true;
        }
      });
  }

  return changed;
}

function hydrateBadgeStateFromRecentSupports() {
  let changed = false;
  const hasSupporterStats = Object.keys(supporterStats || {}).length > 0;

  Object.entries(creatorStats).forEach(([creator, stats]) => {
    if (!stats || typeof stats !== "object") return;
    changed = ensureCreatorSupporterTracking(creator) || changed;

    if (hasSupporterStats || !Array.isArray(stats.recentSupports)) return;

    [...stats.recentSupports]
      .sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
      .forEach(item => {
        const key = String(item.anonId || "").trim();
        if (!key) return;

        const supportTime = Number(item.time || Date.now());
        const supporter = getOrCreateSupporterStats(key, supportTime);
        supporter.firstSeenAt = Math.min(supporter.firstSeenAt, supportTime);
        supporter.lastSupportAt = Math.max(supporter.lastSupportAt, supportTime);
        supporter.totalSupports += 1;
        supporter.supportedCreators[creator] =
          Number(supporter.supportedCreators[creator] || 0) + 1;

        const dayOneIndex = stats.supporterOrder.indexOf(key);
        if (dayOneIndex >= 0 && dayOneIndex < DAY_ONE_SUPPORTER_LIMIT) {
          supporter.dayOneCreators[creator] = stats.supporterFirstSeen[key] || supportTime;
        }

        changed = true;
      });
  });

  if (changed) saveData();
}

function recordSupporterStats(anonId, creator, supportTime = Date.now()) {
  const key = String(anonId || "").trim();
  if (!key) return [];
  const creatorKey = getCanonicalCreatorKey(creator);

  const stats = getOrCreateSupporterStats(key, supportTime);
  stats.firstSeenAt = Math.min(stats.firstSeenAt, supportTime);
  stats.lastSupportAt = supportTime;
  stats.totalSupports += 1;
  stats.supportedCreators[creatorKey] = Number(stats.supportedCreators[creatorKey] || 0) + 1;

  ensureCreatorSupporterTracking(creatorKey);

  const creatorRecord = creatorStats[creatorKey];
  if (creatorRecord && !creatorRecord.supporterFirstSeen[key]) {
    creatorRecord.supporterFirstSeen[key] = supportTime;
    creatorRecord.supporterOrder.push(key);
  }

  const dayOneIndex = creatorRecord?.supporterOrder?.indexOf(key) ?? -1;
  if (dayOneIndex >= 0 && dayOneIndex < DAY_ONE_SUPPORTER_LIMIT) {
    stats.dayOneCreators[creatorKey] = creatorRecord.supporterFirstSeen[key] || supportTime;
  }

  return getSupporterBadges(key);
}

function getDistinctSupportedCreators(anonId) {
  const key = String(anonId || "").trim();
  const stored = supporterStats[key]?.supportedCreators;
  const creators = new Set();

  if (stored && typeof stored === "object") {
    Object.keys(stored).forEach(creator => {
      if (Number(stored[creator] || 0) > 0) creators.add(creator);
    });
  }

  Object.entries(creatorStats).forEach(([creator, stats]) => {
    if (!Array.isArray(stats.recentSupports)) return;

    if (stats.recentSupports.some(item => String(item.anonId) === key)) {
      creators.add(creator);
    }
  });

  return creators.size;
}

function getFirstSupportTime(anonId) {
  const key = String(anonId || "").trim();
  let firstSupportTime = Infinity;

  Object.values(creatorStats).forEach(stats => {
    if (!Array.isArray(stats.recentSupports)) return;

    stats.recentSupports.forEach(item => {
      if (String(item.anonId) !== key) return;
      const time = Number(item.time || 0);
      if (time > 0) firstSupportTime = Math.min(firstSupportTime, time);
    });
  });

  return Number.isFinite(firstSupportTime) ? firstSupportTime : 0;
}

function getDayOneCreatorCount(anonId) {
  const key = String(anonId || "").trim();
  const dayOneCreators = new Set(Object.keys(supporterStats[key]?.dayOneCreators || {}));

  Object.entries(creatorStats).forEach(([creator, stats]) => {
    ensureCreatorSupporterTracking(creator);

    const dayOneIndex = stats.supporterOrder?.indexOf(key) ?? -1;
    if (dayOneIndex >= 0 && dayOneIndex < DAY_ONE_SUPPORTER_LIMIT) {
      dayOneCreators.add(creator);
    }
  });

  return dayOneCreators.size;
}

function getSupporterLifetimeSupports(anonId) {
  const storedTotal = Number(supporterStats[String(anonId || "")]?.totalSupports || 0);
  if (storedTotal > 0) return storedTotal;

  let lifetimeSupports = 0;

  Object.values(creatorStats).forEach(creator => {
    if (!creator.recentSupports) return;

    creator.recentSupports.forEach(item => {
      if (String(item.anonId) === String(anonId)) {
        lifetimeSupports++;
      }
    });
  });

  return lifetimeSupports;
}

function getSupporterBadges(anonId, supportCountOverride = 0) {
  const key = String(anonId || "").trim();
  if (!key) return [];

  const stats = supporterStats[key] || {};
  const lifetimeSupports = Math.max(
    getSupporterLifetimeSupports(key),
    Number(supportCountOverride || 0)
  );
  const supportedCreatorCount = getDistinctSupportedCreators(key);
  const firstSeenAt = Number(stats.firstSeenAt || getFirstSupportTime(key) || 0);
  const dayOneCreatorCount = getDayOneCreatorCount(key);

  return BADGE_DEFINITIONS.filter(badge => {
    if (badge.id === "og_wave") {
      return lifetimeSupports >= 1 && (Date.now() <= BETA_END_AT || firstSeenAt <= BETA_END_AT);
    }

    if (badge.id === "first_drop") {
      return lifetimeSupports >= 1;
    }

    if (badge.id === "wave_starter") {
      return supportedCreatorCount >= 5;
    }

    if (badge.id === "fuel_provider") {
      return lifetimeSupports >= 25;
    }

    if (badge.id === "day_one") {
      return dayOneCreatorCount > 0;
    }

    return false;
  });
}

function getSupporterBadgeCollection(anonId, supportCountOverride = 0) {
  const unlockedIds = new Set(
    getSupporterBadges(anonId, supportCountOverride).map(badge => badge.id)
  );

  return BADGE_DEFINITIONS.map(badge => ({
    ...badge,
    unlocked: unlockedIds.has(badge.id)
  }));
}

function getEquippedSupporterBadge(anonId, supportCountOverride = 0) {
  const key = String(anonId || "").trim();
  if (!key) return null;

  const stats = supporterStats[key];
  const equippedBadgeId = stats?.equippedBadgeId || "";
  if (!equippedBadgeId) return null;

  return getSupporterBadgeCollection(key, supportCountOverride).find(
    badge => badge.id === equippedBadgeId && badge.unlocked
  ) || null;
}

function attachSupporterBadges(item) {
  return {
    ...item,
    sourcePlatform: normalizeSourcePlatform(item.sourcePlatform, "direct"),
    attributionType: item.attributionType || "skipped",
    badges: getSupporterBadgeCollection(item.anonId),
    equippedBadge: getEquippedSupporterBadge(item.anonId)
  };
}

hydrateBadgeStateFromRecentSupports();
normalizeCreatorVideoState();
hydrateSupportRecordsFromRecentSupports();
ensureLegacyCampaigns();

app.get("/api/stickers", enforceRateLimit("stickers", 60_000, 60), (req, res) => {
  res.json({
    success: true,
    stickers: getStickerVideos()
  });
});

// ---------- Event endpoint ----------
app.post('/event', enforceRateLimit("event", 60_000, 24), (req, res) => {
  const {
    type,
    creator,
    fingerprint,
    anonId,
    timeZone,
    deviceFamily = "",
    sourcePlatform = "direct",
    supportAttemptId = "",
    campaignId = ""
  } = req.body;

  debugLog("EVENT RECEIVED:", {
    type,
    creator,
    anonId,
    timeZone,
    deviceFamily,
    sourcePlatform,
    supportAttemptId,
    campaignId
  });

  if (!type || !creator || !fingerprint || !timeZone) {
    return res.json({ success: false, code: "MISSING_DATA", message: 'Missing data' });
  }

  const creatorKey = getCanonicalCreatorKey(creator, req);
  const recordedSourcePlatform = normalizeSourcePlatform(
    req.session?.viewerSourcePlatforms?.[creatorKey] || sourcePlatform,
    "direct"
  );
  const sourceReferrer = cleanText(req.get("referer") || req.get("referrer") || "", 1000);
  const isCreatorOwnerRequest =
    isLoggedInCreatorForSlug(req, creator) ||
    isKnownCreatorOwnerDevice(req, creator, deviceFamily);

  if (isCreatorOwnerRequest) {
    return res.json({
      success: false,
      code: "SELF_SUPPORT_NOT_ALLOWED",
      message: "You cannot support your own island."
    });
  }

  const typeLimit = checkRateLimit(
    req,
    `event:${type}`,
    60_000,
    type === "ad_start" || type === "ad_complete" ? 8 : 4
  );

  if (!typeLimit.allowed) {
    res.set("Retry-After", String(typeLimit.retryAfter));
    return res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message: "Too many support attempts. Try again soon.",
      wait: typeLimit.retryAfter
    });
  }

  const deviceProgressKey = getDeviceProgressKey(req, fingerprint);
  const viewerKey = getCampaignViewerKey(req, fingerprint);
  const today = getToday(timeZone);
  const now = Date.now();

  if (!userProgress[deviceProgressKey]) {
    userProgress[deviceProgressKey] = {
      timeZone,
      days: {}
    };
  }

  if (!userProgress[deviceProgressKey].timeZone) {
    userProgress[deviceProgressKey].timeZone = timeZone;
  }

  if (userProgress[deviceProgressKey].timeZone !== timeZone) {
    return res.json({ success: false, code: "TIMEZONE_MISMATCH", message: 'Timezone mismatch' });
  }

  if (!userProgress[deviceProgressKey].days[today]) {
    userProgress[deviceProgressKey].days[today] = {
      dailyCount: 0,
      lastComplete: 0,
      adStartTime: 0
    };
  }

  const userData = userProgress[deviceProgressKey].days[today];

  if (deviceProgressKey === hashFingerprint(creator)) {
    return res.json({
      success: false,
      code: "SELF_SUPPORT_NOT_ALLOWED",
      message: 'Cannot support yourself'
    });
  }

  if (type === 'ad_start') {
    const activeCampaign = getSupportCampaignForCreator(creatorKey, campaignId);

    if (!activeCampaign) {
      return res.json({
        success: false,
        code: "NO_ACTIVE_CAMPAIGN",
        message: "This creator does not currently have an active support island."
      });
    }

    if (now - Number(userData.lastComplete || 0) < COOLDOWN_MS) {
      return res.json({
        success: false,
        code: "COOLDOWN_ACTIVE",
        message: 'Cooldown active',
        wait: Math.ceil((COOLDOWN_MS - (now - userData.lastComplete)) / 1000)
      });
    }

    const completedSupports = getCampaignSupportCount(activeCampaign.id, viewerKey);
    if (completedSupports >= MAX_CAMPAIGN_SUPPORTS_PER_VIEWER) {
      return res.json({
        success: false,
        code: "CAMPAIGN_SUPPORT_LIMIT_REACHED",
        message: "You fully supported this video.",
        activeCampaign,
        completedSupports,
        remainingSupports: 0,
        maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER
      });
    }

    const attempt = createSupportAttempt({
      creatorId: creatorKey,
      campaignId: activeCampaign.id,
      viewerKey,
      anonId,
      fingerprintHash: deviceProgressKey,
      sourcePlatform: recordedSourcePlatform,
      sourceReferrer,
      startedAt: now
    });

    userData.adStartTime = now;
    userData.supportAttemptId = attempt.id;
    userData.adCampaignId = activeCampaign.id;
    saveData();

    return res.json({
      success: true,
      supportAttemptId: attempt.id,
      campaignId: activeCampaign.id,
      activeCampaign,
      completedSupports,
      remainingSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER - completedSupports,
      maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER
    });
  }

  if (type === 'ad_complete') {
    const attempt = getSupportAttempt(supportAttemptId || userData.supportAttemptId);

    if (!attempt || attempt.creator_id !== creatorKey || attempt.viewer_key !== viewerKey) {
      return res.json({
        success: false,
        code: "CAMPAIGN_CHANGED",
        message: "This support attempt is no longer valid. Please start again."
      });
    }

    if (campaignId && campaignId !== attempt.campaign_id) {
      return res.json({
        success: false,
        code: "CAMPAIGN_CHANGED",
        message: "The active campaign changed. Please start again."
      });
    }

    if (attempt.used_at || attempt.status === "completed") {
      return res.json({
        success: false,
        code: "SUPPORT_ATTEMPT_ALREADY_USED",
        message: "This support was already completed."
      });
    }

    if (now > Number(attempt.expires_at || 0)) {
      return res.json({
        success: false,
        code: "CAMPAIGN_CHANGED",
        message: "This support attempt expired. Please start again."
      });
    }

    const campaign = getCampaignById(attempt.campaign_id);
    if (!campaign || campaign.creatorId !== creatorKey) {
      return res.json({
        success: false,
        code: "CAMPAIGN_NOT_FOUND",
        message: "Campaign not found."
      });
    }

    if (now - Number(attempt.started_at || 0) < MIN_AD_WATCH_MS) {
      return res.json({
        success: false,
        code: "AD_WATCH_TOO_SHORT",
        message: 'Ad not fully watched'
      });
    }

    if (now - Number(userData.lastComplete || 0) < COOLDOWN_MS) {
      return res.json({
        success: false,
        code: "COOLDOWN_ACTIVE",
        message: 'Cooldown active',
        wait: Math.ceil((COOLDOWN_MS - (now - userData.lastComplete)) / 1000)
      });
    }

    const completedBefore = getCampaignSupportCount(campaign.id, viewerKey);
    if (completedBefore >= MAX_CAMPAIGN_SUPPORTS_PER_VIEWER) {
      return res.json({
        success: false,
        code: "CAMPAIGN_SUPPORT_LIMIT_REACHED",
        message: "You fully supported this video.",
        activeCampaign: campaign,
        completedSupports: completedBefore,
        remainingSupports: 0,
        maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER
      });
    }

    const supportId = `support_${crypto.randomBytes(12).toString("hex")}`;

    db.exec("BEGIN IMMEDIATE");
    try {
      const lockedCompletedBefore = getCampaignSupportCount(campaign.id, viewerKey);
      if (lockedCompletedBefore >= MAX_CAMPAIGN_SUPPORTS_PER_VIEWER) {
        db.exec("ROLLBACK");
        return res.json({
          success: false,
          code: "CAMPAIGN_SUPPORT_LIMIT_REACHED",
          message: "You fully supported this video.",
          activeCampaign: campaign,
          completedSupports: lockedCompletedBefore,
          remainingSupports: 0,
          maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER
        });
      }

      db.prepare(`
        INSERT INTO campaign_supports (
          id, campaign_id, creator_id, viewer_key, anon_id, fingerprint_hash,
          attempt_id, completed_at, reward_amount, source_platform, source_referrer
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        supportId,
        campaign.id,
        creatorKey,
        viewerKey,
        String(anonId || "").trim(),
        deviceProgressKey,
        attempt.id,
        new Date(now).toISOString(),
        REWARD_PER_SUPPORT,
        attempt.source_platform || recordedSourcePlatform,
        attempt.source_referrer || sourceReferrer
      );
      markSupportAttemptUsed(attempt.id, now);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (String(err.message || "").includes("UNIQUE")) {
        return res.json({
          success: false,
          code: "SUPPORT_ATTEMPT_ALREADY_USED",
          message: "This support was already completed."
        });
      }
      throw err;
    }

    userData.lastComplete = now;
    userData.adStartTime = 0;
    userData.supportAttemptId = "";
    userData.adCampaignId = "";

    if (!creatorStats[creatorKey]) {
      creatorStats[creatorKey] = {
        supports: 0,
        earnings: 0,
        videos: {},
        recentSupports: [],
        supporterFirstSeen: {},
        supporterOrder: []
      };
    }

    creatorStats[creatorKey].supports++;
    creatorStats[creatorKey].earnings += REWARD_PER_SUPPORT;

    if (!creatorStats[creatorKey].recentSupports) {
      creatorStats[creatorKey].recentSupports = [];
    }

    recordSupporterStats(anonId, creatorKey, now);
    const badges = getSupporterBadgeCollection(anonId);
    const equippedBadge = getEquippedSupporterBadge(anonId);
    const savedProfile = supporterProfiles[anonId] || {};

    creatorStats[creatorKey].recentSupports.unshift({
      supportId,
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      name: savedProfile.name || `Anonymous #${anonId || "0000"}`,
      pfp: savedProfile.pfp || "",
      anonId,
      deviceProgressKey,
      sourcePlatform: attempt.source_platform || recordedSourcePlatform,
      selectedVideoId: campaign.id,
      attributionType: "selected_video",
      attributedAt: now,
      equippedBadge,
      emoji: "",
      time: now
    });

    supportRecords[supportId] = {
      supportId,
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      creatorSlug: creatorKey,
      anonId: String(anonId || "").trim(),
      deviceProgressKey,
      sourcePlatform: attempt.source_platform || recordedSourcePlatform,
      selectedVideoId: campaign.id,
      attributionType: "selected_video",
      completedAt: now,
      attributedAt: now
    };

    creatorStats[creatorKey].recentSupports = creatorStats[creatorKey].recentSupports.slice(0, 100);

    if (!creatorStats[creatorKey].videos) {
      creatorStats[creatorKey].videos = {};
    }

    creatorStats[creatorKey].videos[campaign.id] = {
      videoId: campaign.id,
      videoTitle: campaign.title,
      videoThumbnail: campaign.thumbnailUrl,
      platform: campaign.platform,
      supports: Number(creatorStats[creatorKey].videos[campaign.id]?.supports || 0) + 1
    };

    events.push({
      timestamp: now,
      creator: creatorKey,
      fingerprint: deviceProgressKey,
      type: 'support_complete',
      supportId,
      campaignId: campaign.id,
      sourcePlatform: attempt.source_platform || recordedSourcePlatform,
      timeZone
    });

    saveData();

    const completedSupports = getCampaignSupportCount(campaign.id, viewerKey);
    const remainingSupports = Math.max(0, MAX_CAMPAIGN_SUPPORTS_PER_VIEWER - completedSupports);
    const creatorSupportsForViewer = creatorStats[creatorKey].recentSupports.filter(item =>
      String(item.anonId) === String(anonId)
    ).length;
    const refreshedCampaign = getCampaignById(campaign.id);

    return res.json({
      success: true,
      supports: creatorStats[creatorKey].supports,
      creatorSupports: creatorSupportsForViewer,
      supportId,
      campaignId: campaign.id,
      activeCampaign: refreshedCampaign,
      completedSupports,
      remainingSupports,
      maxSupports: MAX_CAMPAIGN_SUPPORTS_PER_VIEWER,
      sourcePlatform: attempt.source_platform || recordedSourcePlatform,
      badges,
      equippedBadge,
      mostSupportedVideo: refreshedCampaign
    });
  }

  return res.json({ success: false, code: "UNKNOWN_EVENT_TYPE", message: 'Unknown event type' });
});
function requireCreatorLogin(req, res, next) {
  if (!req.session.creatorProfile) {
    return res.redirect("/auth/creator");
  }

  rememberCreatorOwnerDevice(req, req.session.creatorProfile.slug, req.query.deviceFamily);
  next();
}

app.get("/dashboard", requireCreatorLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/support-island", requireCreatorLogin, (req, res) => {
  res.redirect(getCreatorPublicLink(req.session.creatorProfile.slug));
});

// ---------- Count endpoint ----------
app.get('/count/:creator', enforceRateLimit("count", 60_000, 120), (req, res) => {
  const creator = req.params.creator;
  const { key: creatorKey, stats } = getCreatorStatsRecord(creator, req);
  const creatorRecord = stats || {
    supports: 0,
    earnings: 0,
    videos: {},
    recentSupports: []
  };

  debugLog("COUNT REQUEST:", {
  creator,
  creatorKey,
  availableCreators: Object.keys(creatorStats)
});

  const videos = Object.values(creatorRecord.videos || {});

  const topVideos = videos
    .sort((a, b) => b.supports - a.supports)
    .slice(0, 5);
  const campaigns = getCampaignsForCreator(creatorKey);
  const activeCampaign = getActiveCampaignForCreator(creatorKey);
  const campaignTotals = campaigns.reduce((totals, campaign) => {
    totals.supports += Number(campaign.totalSupports || 0);
    totals.earnings += Number(campaign.totalEarnings || 0);
    return totals;
  }, { supports: 0, earnings: 0 });

  res.json({
    supports: Math.max(Number(creatorRecord.supports || 0), campaignTotals.supports),
    earnings: Number(Math.max(Number(creatorRecord.earnings || 0), campaignTotals.earnings).toFixed(2)),
    activeCampaign,
    campaigns,
    recentSupports: (creatorRecord.recentSupports || [])
  .sort((a, b) => b.time - a.time)
  .map(attachSupporterBadges),
    topVideos
  });
});

app.post("/support/profile", enforceRateLimit("support-profile-v2", 60 * 60 * 1000, 60), (req, res) => {
  const { anonId, name, pfp } = req.body;
  const cleanName = normalizeSupporterName(name);
  const nameError = validateSupporterName(cleanName);

  if (!anonId) {
    return res.json({ success: false, message: "Missing profile data" });
  }

  if (getSupporterLifetimeSupports(anonId) < 3) {
    return res.json({
      success: false,
      message: "Profile unlocks after 3 supports."
    });
  }

  if (nameError) {
    return res.json({ success: false, message: nameError });
  }

  supporterProfiles[anonId] = {
    name: cleanName,
    pfp: pfp || ""
  };

  Object.values(creatorStats).forEach(creator => {
    if (!creator.recentSupports) return;

    creator.recentSupports.forEach(item => {
      if (String(item.anonId) === String(anonId)) {
        item.name = cleanName || `Anonymous #${anonId || "0000"}`;
        item.pfp = pfp || "";
      }
    });
  });

  saveData();

  res.json({
    success: true,
    profile: supporterProfiles[anonId],
    badges: getSupporterBadgeCollection(anonId),
    equippedBadge: getEquippedSupporterBadge(anonId)
  });
});

app.post("/support/badge", enforceRateLimit("support-badge", 60_000, 30), (req, res) => {
  const anonId = String(req.body.anonId || "").trim();
  const badgeId = String(req.body.badgeId || "").trim();

  if (!anonId) {
    return res.json({ success: false, message: "Missing supporter." });
  }

  if (!badgeId) {
    if (supporterStats[anonId]) {
      supporterStats[anonId] = normalizeSupporterStats(supporterStats[anonId]);
      supporterStats[anonId].equippedBadgeId = "";
      saveData();
    }

    return res.json({
      success: true,
      badges: getSupporterBadgeCollection(anonId),
      equippedBadge: null
    });
  }

  const badge = getSupporterBadgeCollection(anonId).find(item => item.id === badgeId);

  if (!badge) {
    return res.json({ success: false, message: "Badge not found." });
  }

  if (!badge.unlocked) {
    return res.json({ success: false, message: "Badge is still locked." });
  }

  const stats = getOrCreateSupporterStats(anonId, getFirstSupportTime(anonId) || Date.now());
  stats.equippedBadgeId = badgeId;
  saveData();

  res.json({
    success: true,
    badges: getSupporterBadgeCollection(anonId),
    equippedBadge: getEquippedSupporterBadge(anonId)
  });
});

app.post("/support/emoji", enforceRateLimit("support-reaction", 60_000, 30), (req, res) => {
  const { creator, anonId, emoji, reactionType, stickerUrl } = req.body;
  const reaction = String(emoji || "").trim().slice(0, 80);
  const cleanStickerUrl = String(stickerUrl || "").trim();
  const isSticker = reactionType === "sticker";
  const { stats: creatorRecord } = getCreatorStatsRecord(creator, req);

  if (!creatorRecord || !creatorRecord.recentSupports) {
    return res.json({ success: false, message: "Creator/support list not found" });
  }

  if (!reaction) {
    return res.json({ success: false, message: "Missing reaction" });
  }

  if (isSticker && cleanStickerUrl && !cleanStickerUrl.startsWith("/stickers/")) {
    return res.json({ success: false, message: "Invalid sticker" });
  }

  const supports = creatorRecord.recentSupports;

  const item = supports.find(s =>
    s.name === `Anonymous #${anonId}` ||
    s.name === anonId ||
    s.anonId === anonId
  );

  if (!item) {
    return res.json({ success: false, message: "Supporter not found" });
  }

  item.emoji = reaction;
  item.reactionType = isSticker ? "sticker" : "emoji";
  item.stickerUrl = isSticker ? cleanStickerUrl : "";
  saveData();

  res.json({ success: true, item: attachSupporterBadges(item) });
});

app.post("/dev/reset", requireDevResetAccess, enforceRateLimit("dev-reset", 60_000, 3), (req, res) => {
  userProgress = {};
  creatorStats = {};
  events = [];
  supporterProfiles = {};
  supporterStats = {};
  supportRecords = {};

  saveData();

  res.json({
    success: true,
    message: "Dev data reset."
  });
});

app.get("/api/storage/status", requireDevAccess, (req, res) => {
  let dbFile = null;

  try {
    const stats = fs.statSync(DB_PATH);
    dbFile = {
      exists: true,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString()
    };
  } catch (_) {
    dbFile = { exists: false };
  }

  const totalSupports = Object.values(creatorStats).reduce(
    (sum, stats) => sum + Number(stats?.supports || 0),
    0
  );

  res.json({
    success: true,
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeEnv: process.env.NODE_ENV || "development",
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    hasConfiguredPersistentStore,
    usingRenderDiskDefault: DATA_DIR === RENDER_DISK_DEFAULT_DIR,
    dbFile,
    creatorCount: Object.keys(creatorStats).length,
    ownerDeviceCreatorCount: Object.keys(creatorOwnerDevices).length,
    totalSupports
  });
});

app.get("/api/me", (req, res) => {
  if (req.session.creatorProfile) {
    rememberCreatorOwnerDevice(
      req,
      req.session.creatorProfile.slug,
      req.query.deviceFamily
    );
  }

  res.json(req.session.creatorProfile || null);
});
app.get("/api/creator/:slug", enforceRateLimit("creator-profile", 60_000, 120), (req, res) => {
  const profile = findCreatorProfile(req.params.slug, req);
  if (!profile) return res.json(null);

  const creator = getCanonicalCreatorKey(profile.slug || req.params.slug, req);
  res.json({
    ...profile,
    activeCampaign: getActiveCampaignForCreator(creator)
  });
});
app.get("/api/dashboard/stats", requireCreatorLogin, (req, res) => {
  const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);
  const { stats } = getCreatorStatsRecord(creator, req);
  const creatorRecord = stats || {
    supports: 0,
    earnings: 0,
    videos: {},
    recentSupports: []
  };
  const videos = Object.values(creatorRecord.videos || {});
  const topVideos = videos
    .sort((a, b) => b.supports - a.supports)
    .slice(0, 5);
  const attributionStats = getVideoAttributionStats(creator);
  const campaigns = getCampaignsForCreator(creator);
  const activeCampaign = getActiveCampaignForCreator(creator);
  const campaignTotals = campaigns.reduce((totals, campaign) => {
    totals.supports += Number(campaign.totalSupports || 0);
    totals.earnings += Number(campaign.totalEarnings || 0);
    return totals;
  }, { supports: 0, earnings: 0 });
  const campaignVideos = campaigns
    .filter(campaign => !isLegacyCampaign(campaign))
    .filter(campaign => campaign.status !== "archived" || Number(campaign.totalSupports || 0) > 0)
    .sort((a, b) => Number(b.totalSupports || 0) - Number(a.totalSupports || 0));

  res.json({
    creator,
    supports: Math.max(Number(creatorRecord.supports || 0), campaignTotals.supports),
    earnings: Number(Math.max(Number(creatorRecord.earnings || 0), campaignTotals.earnings).toFixed(2)),
    activeCampaign,
    campaigns,
    campaignTotals: {
      supports: campaignTotals.supports,
      earnings: Number(campaignTotals.earnings.toFixed(2))
    },
    recentSupports: (creatorRecord.recentSupports || [])
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
      .map(attachSupporterBadges),
    videos: creatorRecord.videos || {},
    topVideos,
    platformCounts: getPlatformCountsForCreator(creator),
    creatorVideos: getCreatorVideosList(creator),
    mostSupportedVideos: campaignVideos.length ? campaignVideos : attributionStats.videos,
    attributionSummary: {
      creatorOnly: attributionStats.creatorOnly,
      noVideoSelected: attributionStats.noVideoSelected
    }
  });
});

app.get("/api/dashboard/campaigns", requireCreatorLogin, (req, res) => {
  const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

  res.json({
    success: true,
    activeCampaign: getActiveCampaignForCreator(creator),
    campaigns: getCampaignsForCreator(creator)
  });
});

app.post(
  "/api/dashboard/campaigns/metadata",
  requireCreatorLogin,
  enforceRateLimit("dashboard-campaign-metadata", 60_000, 20),
  async (req, res) => {
    try {
      const preview = await getCampaignMetadataPreview(req.body.videoUrl);
      res.json({ success: true, preview });
    } catch (err) {
      sendCampaignError(res, err);
    }
  }
);

app.post(
  "/api/dashboard/campaigns",
  requireCreatorLogin,
  enforceRateLimit("dashboard-campaign-create", 60_000, 20),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

    try {
      const campaign = createCampaignForCreator(creator, req.body);
      res.json({
        success: true,
        campaign,
        activeCampaign: getActiveCampaignForCreator(creator),
        campaigns: getCampaignsForCreator(creator)
      });
    } catch (err) {
      sendCampaignError(res, err);
    }
  }
);

app.get("/api/dashboard/campaigns/:campaignId", requireCreatorLogin, (req, res) => {
  const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);
  const campaign = getCampaignById(req.params.campaignId);

  if (!campaign) {
    return sendCampaignError(res, { code: "CAMPAIGN_NOT_FOUND" });
  }

  if (campaign.creatorId !== creator) {
    return sendCampaignError(res, { code: "CAMPAIGN_NOT_OWNED" });
  }

  res.json({ success: true, campaign });
});

app.post(
  "/api/dashboard/campaigns/:campaignId/activate",
  requireCreatorLogin,
  enforceRateLimit("dashboard-campaign-activate", 60_000, 20),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

    try {
      const campaign = activateCampaignForCreator(creator, req.params.campaignId);
      res.json({
        success: true,
        campaign,
        activeCampaign: campaign,
        campaigns: getCampaignsForCreator(creator)
      });
    } catch (err) {
      sendCampaignError(res, err);
    }
  }
);

app.post(
  "/api/dashboard/campaigns/:campaignId/deactivate",
  requireCreatorLogin,
  enforceRateLimit("dashboard-campaign-deactivate", 60_000, 20),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

    try {
      const campaign = deactivateCampaignForCreator(creator, req.params.campaignId);
      res.json({
        success: true,
        campaign,
        activeCampaign: getActiveCampaignForCreator(creator),
        campaigns: getCampaignsForCreator(creator)
      });
    } catch (err) {
      sendCampaignError(res, err);
    }
  }
);

app.post(
  "/api/dashboard/campaigns/:campaignId/archive",
  requireCreatorLogin,
  enforceRateLimit("dashboard-campaign-archive", 60_000, 20),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

    try {
      const campaign = archiveCampaignForCreator(creator, req.params.campaignId);
      res.json({
        success: true,
        campaign,
        activeCampaign: getActiveCampaignForCreator(creator),
        campaigns: getCampaignsForCreator(creator)
      });
    } catch (err) {
      sendCampaignError(res, err);
    }
  }
);

app.get("/api/dashboard/videos", requireCreatorLogin, (req, res) => {
  const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);

  res.json({
    success: true,
    videos: getCreatorVideosList(creator)
  });
});

app.post(
  "/api/dashboard/videos/metadata",
  requireCreatorLogin,
  enforceRateLimit("dashboard-video-metadata", 60_000, 20),
  async (req, res) => {
    const platform = normalizeContentPlatform(req.body.platform);
    const contentUrl = normalizeOptionalUrl(req.body.contentUrl, 1000);

    if (!platform) {
      return res.status(400).json({ success: false, message: "Choose TikTok, Instagram, or YouTube." });
    }

    if (!contentUrl || !isValidPlatformPostUrl(platform, contentUrl)) {
      return res.status(400).json({ success: false, message: `Enter a valid ${getPlatformLabel(platform)} URL.` });
    }

    try {
      const metadata = await fetchPlatformPostMetadata(platform, contentUrl);
      return res.json({ success: true, metadata });
    } catch (err) {
      debugLog("Could not fetch post metadata:", err.message);
      return res.status(422).json({
        success: false,
        message:
          platform === "instagram" && !INSTAGRAM_OEMBED_ACCESS_TOKEN
            ? "Instagram needs Meta oEmbed access before Oscal can auto-fill this. Add the title manually for now."
            : "Could not auto-fill this post. Add the title manually."
      });
    }
  }
);

app.post(
  "/api/dashboard/videos",
  requireCreatorLogin,
  enforceRateLimit("dashboard-videos-add", 60_000, 20),
  async (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);
    const platform = normalizeContentPlatform(req.body.platform);
    const contentUrl = normalizeOptionalUrl(req.body.contentUrl, 1000);
    let title = cleanText(req.body.title, 120);
    let thumbnailUrl = normalizeOptionalUrl(req.body.thumbnailUrl, 1000);
    const thumbnailImageData = String(req.body.thumbnailImageData || "");

    if (!platform) {
      return res.status(400).json({ success: false, message: "Choose TikTok, Instagram, or YouTube." });
    }

    if (!contentUrl || !isValidPlatformPostUrl(platform, contentUrl)) {
      return res.status(400).json({ success: false, message: `Enter a valid ${getPlatformLabel(platform)} URL.` });
    }

    if (!title || !thumbnailUrl) {
      try {
        const metadata = await fetchPlatformPostMetadata(platform, contentUrl);
        title = title || metadata.title;
        thumbnailUrl = thumbnailUrl || metadata.thumbnailUrl;
      } catch (err) {
        debugLog("Could not auto-fill video before save:", err.message);
      }
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Paste a URL Oscal can read, or add a title or short label."
      });
    }

    const bucket = getCreatorVideoBucket(creator);
    if (Object.values(bucket).some(video => video.contentUrl === contentUrl)) {
      return res.status(409).json({ success: false, message: "That post is already saved." });
    }

    const videoId = getVideoIdFromContentUrl(platform, contentUrl);

    if (thumbnailImageData) {
      try {
        thumbnailUrl = saveThumbnailUpload(thumbnailImageData, creator, videoId);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message || "Could not save thumbnail image." });
      }
    }

    const video = normalizeCreatorVideoRecord({
      id: videoId,
      creatorSlug: creator,
      platform,
      title,
      thumbnailUrl,
      contentUrl,
      publishedAt: 0,
      isEligible: true,
      createdAt: Date.now()
    }, creator);

    bucket[video.id] = video;
    saveData();

    res.json({ success: true, video });
  }
);

app.patch(
  "/api/dashboard/videos/:videoId",
  requireCreatorLogin,
  enforceRateLimit("dashboard-videos-edit", 60_000, 40),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);
    const bucket = getCreatorVideoBucket(creator);
    const video = bucket[req.params.videoId];

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found." });
    }

    video.isEligible = req.body.isEligible !== false;
    saveData();

    res.json({ success: true, video });
  }
);

app.delete(
  "/api/dashboard/videos/:videoId",
  requireCreatorLogin,
  enforceRateLimit("dashboard-videos-delete", 60_000, 20),
  (req, res) => {
    const creator = getCanonicalCreatorKey(req.session.creatorProfile.slug, req);
    const bucket = getCreatorVideoBucket(creator);

    if (!bucket[req.params.videoId]) {
      return res.status(404).json({ success: false, message: "Video not found." });
    }

    delete bucket[req.params.videoId];
    saveData();

    res.json({ success: true });
  }
);

app.get("/support/eligible-videos", enforceRateLimit("eligible-videos", 60_000, 60), (req, res) => {
  const creator = getCanonicalCreatorKey(req.query.creator, req);
  const platform = normalizeSourcePlatform(req.query.platform, "direct");

  if (!creator) {
    return res.json({ success: true, videos: [] });
  }

  res.json({
    success: true,
    videos: getEligibleVideos(creator, platform)
  });
});

app.post("/support/attribute-video", enforceRateLimit("support-attribute-video", 60_000, 20), (req, res) => {
  const {
    creator,
    supportId,
    anonId,
    fingerprint,
    selectedVideoId = "",
    attributionType
  } = req.body;
  const creatorKey = getCanonicalCreatorKey(creator, req);
  const record = supportRecords[String(supportId || "")];

  if (!creatorKey || !record || record.creatorSlug !== creatorKey) {
    return res.status(404).json({ success: false, message: "Support record not found." });
  }

  if (String(record.anonId) !== String(anonId || "")) {
    return res.status(403).json({ success: false, message: "Supporter mismatch." });
  }

  const deviceProgressKey = getDeviceProgressKey(req, fingerprint);
  if (record.deviceProgressKey && record.deviceProgressKey !== deviceProgressKey) {
    return res.status(403).json({ success: false, message: "Device mismatch." });
  }

  if (Date.now() - Number(record.completedAt || 0) > ATTRIBUTION_WINDOW_MS) {
    return res.status(410).json({ success: false, message: "This support can no longer be updated." });
  }

  if (record.attributedAt) {
    return res.status(409).json({ success: false, message: "Video attribution already submitted." });
  }

  const nextType = ATTRIBUTION_TYPES.has(attributionType) ? attributionType : "";
  if (!nextType) {
    return res.status(400).json({ success: false, message: "Choose a valid attribution option." });
  }

  let nextVideoId = "";
  if (nextType === "selected_video") {
    nextVideoId = cleanText(selectedVideoId, 120);
    const video = getCreatorVideoBucket(creatorKey)[nextVideoId];

    if (!video || video.creatorSlug !== creatorKey) {
      return res.status(404).json({ success: false, message: "Video not found." });
    }

    const recordSourcePlatform = normalizeSourcePlatform(record.sourcePlatform, "direct");
    const matchingPlatformVideos = recordSourcePlatform === "direct"
      ? []
      : getCreatorVideosList(creatorKey, recordSourcePlatform)
        .filter(item => item.isEligible !== false);
    const platformMatches =
      recordSourcePlatform === "direct" ||
      video.platform === recordSourcePlatform ||
      matchingPlatformVideos.length === 0;

    if (!platformMatches || video.isEligible === false) {
      return res.status(400).json({ success: false, message: "Video is not eligible for this platform." });
    }
  }

  record.attributionType = nextType;
  record.selectedVideoId = nextVideoId;
  record.attributedAt = Date.now();

  const { stats: creatorRecord } = getCreatorStatsRecord(creatorKey, req);
  const recentItem = creatorRecord?.recentSupports?.find(item => item.supportId === record.supportId);
  if (recentItem) {
    recentItem.attributionType = record.attributionType;
    recentItem.selectedVideoId = record.selectedVideoId;
    recentItem.attributedAt = record.attributedAt;
  }

  saveData();

  res.json({ success: true, record });
});

// ---------- Creator page route ----------
app.post("/support/status", enforceRateLimit("support-status", 60_000, 60), (req, res) => {
  const { fingerprint, timeZone, creator, deviceFamily = "", campaignId = "" } = req.body;

  if (!fingerprint || !timeZone) {
    return res.json({ success: false });
  }

  const deviceProgressKey = getDeviceProgressKey(req, fingerprint);
  const today = getToday(timeZone);
  const anonId = req.body.anonId;

let lifetimeSupports = getSupporterLifetimeSupports(anonId);
let creatorSupports = 0;
const creatorKey = getCanonicalCreatorKey(creator, req);
const { stats: creatorRecord } = getCreatorStatsRecord(creatorKey, req);
const campaignStatus = getCampaignStatusPayload(req, creatorKey, fingerprint, campaignId);
const isCreatorOwnerRequest =
  isLoggedInCreatorForSlug(req, creator) ||
  isKnownCreatorOwnerDevice(req, creator, deviceFamily);

if (creatorRecord?.recentSupports) {
  creatorRecord.recentSupports.forEach(item => {
    if (String(item.anonId) === String(anonId)) {
      creatorSupports++;
    }
  });
}

const profile = supporterProfiles[anonId] || null;
const hasProfile = !!profile;

  const userData = userProgress[deviceProgressKey]?.days?.[today];
  // Badge progress belongs to the supporter identity, not the device daily cap.
  // A fresh anonId on the same browser/device should start with zero badges.
const badges = getSupporterBadgeCollection(anonId, lifetimeSupports);
const equippedBadge = getEquippedSupporterBadge(anonId, lifetimeSupports);

  if (!userData) {
    return res.json({
      success: true,
      wait: 0,
      ...campaignStatus,
      isCreatorOwner: isCreatorOwnerRequest,
      lifetimeSupports,
      creatorSupports,
      hasProfile,
      profile,
      badges,
      equippedBadge
    });
  }

  const now = Date.now();
  const remaining = COOLDOWN_MS - (now - userData.lastComplete);
  const wait = remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  const nextCampaignStatus = {
    ...campaignStatus,
    canSupport: campaignStatus.canSupport && wait <= 0,
    reason:
      campaignStatus.reason ||
      (wait > 0 ? "COOLDOWN_ACTIVE" : "")
  };

  res.json({
    success: true,
    wait,
    ...nextCampaignStatus,
    isCreatorOwner: isCreatorOwnerRequest,
    lifetimeSupports,
    creatorSupports,
    hasProfile,
    profile,
    badges,
    equippedBadge
  });
});

app.get("/island/:creator", (req, res) => {
  const profile = findCreatorProfile(req.params.creator, req);

  if (
    profile?.slug &&
    isLegacyCreatorSlug(req.params.creator) &&
    normalizeCreatorSlug(profile.slug) !== normalizeCreatorSlug(req.params.creator)
  ) {
    return res.redirect(`/island/${encodeURIComponent(profile.slug)}`);
  }

  sendViewerPage(req, res, "direct");
});


app.get("/:creator/:sourcePlatform", (req, res, next) => {
  const sourcePlatform = normalizeContentPlatform(req.params.sourcePlatform);
  if (!sourcePlatform) return next();

  const profile = findCreatorProfile(req.params.creator, req);

  if (
    profile?.slug &&
    isLegacyCreatorSlug(req.params.creator) &&
    normalizeCreatorSlug(profile.slug) !== normalizeCreatorSlug(req.params.creator)
  ) {
    return res.redirect(`/${encodeURIComponent(profile.slug)}/${sourcePlatform}`);
  }

  sendViewerPage(req, res, sourcePlatform);
});

app.get("/:creator", (req, res) => {
  sendViewerPage(req, res, "direct");
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
