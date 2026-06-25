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
  assert.match(server, /DELETE FROM support_attempts/);
  assert.match(server, /DELETE FROM campaign_supports/);
  assert.match(server, /legacy_supports = 0/);
  assert.match(server, /legacy_earnings = 0/);
});

test("Render persistent disk is configured", () => {
  assert.match(renderConfig, /mountPath:\s*\/var\/data/);
  assert.match(renderConfig, /DATA_DIR/);
  assert.match(renderConfig, /value:\s*\/var\/data/);
});

test("owner-device self-support guard is wired through viewer and dashboard", () => {
  assert.match(server, /creatorOwnerDevices/);
  assert.match(server, /isKnownCreatorOwnerDevice/);
  assert.doesNotMatch(server, /return Boolean\(record\.ipHashes\[getOwnerIpHash\(req\)\]\)/);
  assert.match(viewer, /deviceFamily/);
  assert.match(server, /isCreatorOwner:\s*isCreatorOwnerRequest/);
  assert.match(viewer, /serverIdentifiedCreatorOwner/);
  assert.match(viewer, /You cannot support your own island/);
  assert.match(viewer, /deviceFamily,\s*campaignId:\s*getSelectedCampaignId\(\)/);
  assert.match(viewer, /credentials:\s*"same-origin"/);
  assert.match(dashboard, /getDashboardDeviceFamily/);
});

test("launch support limits and owner self-support block are restored", () => {
  assert.match(server, /const MAX_CAMPAIGN_SUPPORTS_PER_VIEWER = 3/);
  assert.match(server, /const CAMPAIGN_SUPPORT_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(server, /const MAX_SUPPORTS_PER_DAY/);
  assert.match(viewer, /const selfSupportTestMode = false/);
  assert.match(viewer, /const ownerSelfSupportTestMode = false/);
  assert.match(viewer, /isCreatorViewingOwnIsland\s*&&\s*!ownerSelfSupportTestMode/);
  assert.match(server, /if \(isCreatorOwnerRequest\)/);
  assert.match(server, /deviceProgressKey === hashFingerprint\(creator\)/);
  assert.doesNotMatch(server, /allowSelfSupportTest/);
  assert.doesNotMatch(server, /supporterViewMode\s*&&\s*isCreatorOwnerRequest/);
});

test("creator login entrypoint is platform neutral", () => {
  assert.match(server, /app\.get\("\/auth\/creator"/);
  assert.match(server, /res\.redirect\("\/auth\/creator"\)/);
  assert.match(dashboard, /window\.location\.href = "\/auth\/creator"/);
  assert.doesNotMatch(privacy, /YouTube sign-in/);
  assert.doesNotMatch(terms, /sign in with YouTube/);
});

test("dashboard shows campaign controls without the recent support feed", () => {
  assert.doesNotMatch(dashboard, /Recent support/);
  assert.doesNotMatch(dashboard, /recentFeed/);
  assert.doesNotMatch(dashboard, /function formatSupportTimestamp/);
  assert.match(dashboard, /Your platform links/);
  assert.match(dashboard, /Where supporters came from/);
  assert.match(dashboard, /Support goal/);
  assert.match(dashboard, /Save goal/);
  assert.match(dashboard, /function saveSupportGoal/);
  assert.match(dashboard, /function parseGoalAmountInput/);
  assert.match(dashboard, /class="money-field"/);
  assert.match(dashboard, /placeholder="100\.00"/);
  assert.match(dashboard, /credentials:\s*"same-origin"/);
  assert.match(dashboard, /\/api\/dashboard\/goal/);
  assert.doesNotMatch(dashboard, /Estimated earned/);
  assert.match(dashboard, /Campaign videos/);
  assert.match(dashboard, /Add videos supporters can choose from when they support/);
  assert.match(dashboard, /Campaign breakdown/);
  assert.match(dashboard, /Add campaign/);
  assert.doesNotMatch(dashboard, /Make active/);
  assert.doesNotMatch(dashboard, /const canActivate = campaign\.status !== "active";/);
  assert.doesNotMatch(dashboard, /Deactivate/);
  assert.doesNotMatch(dashboard, /activeCampaignCard/);
  assert.doesNotMatch(dashboard, /renderActiveCampaign/);
  assert.doesNotMatch(dashboard, /postCampaignAction/);
  assert.doesNotMatch(dashboard, /function activateCampaign/);
  assert.doesNotMatch(dashboard, /function deactivateCampaign/);
  assert.match(dashboard, />Remove</);
  assert.match(dashboard, /function removeCampaign/);
  assert.match(dashboard, /\/api\/dashboard\/campaigns\/\$\{encodeURIComponent\(campaignId\)\}\/archive/);
  assert.match(dashboard, /Thumbnail image upload/);
  assert.match(dashboard, /function isLegacyCampaign/);
  assert.match(dashboard, /function getCampaignUrlFallbackTitle/);
  assert.match(dashboard, /function ensureCampaignFallbackTitle/);
  assert.doesNotMatch(dashboard, /function campaignMetaLine\(campaign\) \{\s*return \[\s*PLATFORM_LABELS\[campaign\.platform\]/);
  assert.match(dashboard, /No video campaigns yet/);
  assert.match(dashboard, /Auto-fill could not load/);
  assert.match(dashboard, /filter\(campaign => !isLegacyCampaign\(campaign\)\)/);
  assert.doesNotMatch(dashboard, /Create tracked content link/);
  assert.doesNotMatch(dashboard, /contentThumbnailFile/);
  assert.doesNotMatch(dashboard, />Archive</);
  assert.doesNotMatch(dashboard, /function archiveCampaign/);
  assert.doesNotMatch(server, /\/api\/dashboard\/thumbnail/);
  assert.match(server, /app\.get\("\/api\/dashboard\/campaigns"/);
  assert.match(server, /\/api\/dashboard\/goal/);
  assert.match(server, /function normalizeSupportGoal/);
  assert.match(server, /function parseSupportGoalAmount/);
  assert.match(server, /CREATOR_LOGIN_REQUIRED/);
  assert.match(server, /\/api\/dashboard\/campaigns\/metadata/);
  assert.match(server, /\/api\/dashboard\/campaigns\/:campaignId\/activate/);
  assert.match(server, /\/api\/dashboard\/campaigns\/:campaignId\/deactivate/);
  assert.match(server, /\/api\/dashboard\/campaigns\/:campaignId\/archive/);
  assert.match(server, /https:\/\/www\.tiktok\.com\/oembed/);
  assert.match(server, /https:\/\/www\.youtube\.com\/oembed/);
  assert.match(server, /function getFallbackCampaignTitle/);
  assert.match(server, /function saveThumbnailUpload/);
  assert.match(viewer, /activeCampaign/);
  assert.match(viewer, /campaignRemainingSupports/);
  assert.match(viewer, /goalProgressFill/);
  assert.match(viewer, /function updateGoalProgress/);
  assert.match(viewer, /supportGoal = normalizeSupportGoal\(data\.supportGoal/);
  assert.doesNotMatch(viewer, /Estimated earned/);
  assert.match(viewer, /Which video made you want to support/);
  assert.doesNotMatch(viewer, /This helps the creator see which posts are connecting with viewers/);
  assert.doesNotMatch(viewer, /contentPlatformText/);
  assert.doesNotMatch(viewer, /content-platform/);
  assert.doesNotMatch(viewer, /getCampaignPlatformLabel/);
  assert.match(viewer, /campaignChoiceStorageKey/);
  assert.match(viewer, /sessionStorage\.setItem\(campaignChoiceStorageKey/);
  assert.match(viewer, /function showCampaignChoicePrompt/);
  assert.match(viewer, /function selectCampaignChoice/);
  assert.match(viewer, /function skipCampaignChoice/);
  assert.match(viewer, /campaignOptions\.slice\(0, 5\)/);
  assert.doesNotMatch(viewer, /totalSupports \|\| 0\)} supports/);
  assert.match(viewer, /sourcePlatform/);
  assert.match(dashboard, /Looking up video details/);
  assert.match(dashboard, /thumbnailImageData/);
  assert.doesNotMatch(dashboard, /toggleVideoEligibility/);
  assert.doesNotMatch(dashboard, />Pause</);
});

test("campaign tables and active campaign uniqueness are migrated in SQLite", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS campaigns/);
  assert.match(server, /CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_one_active/);
  assert.match(server, /WHERE status = 'active'/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS campaign_supports/);
  assert.match(server, /idx_campaign_supports_viewer_time/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS support_attempts/);
  assert.match(server, /UNIQUE \(creator_id, normalized_video_key\)/);
  assert.match(server, /attempt_id TEXT UNIQUE/);
  assert.match(server, /function isLegacyCampaign/);
  assert.match(server, /function getCampaignOptionsForCreator/);
  assert.match(server, /function getSupportCampaignForCreator/);
  assert.match(server, /function getCampaignViewerKey\(req, fingerprint, deviceFamily = ""\)/);
  assert.match(server, /function getCampaignDeviceFamily/);
  assert.match(server, /\[width, height\]\.sort/);
  assert.match(server, /function getLegacyCampaignViewerKey/);
  assert.match(server, /campaign-viewer-device/);
  assert.match(server, /function getCampaignViewerKeys/);
  assert.match(server, /getLegacyCampaignViewerKey\(req, deviceFamily\)/);
  assert.match(server, /viewer_key IN \(\$\{placeholders\}\)/);
  assert.match(server, /completed_at >= \?/);
  assert.match(server, /normalized_video_key NOT LIKE 'legacy:%'/);
  assert.match(server, /ensureLegacyCampaigns\(\)/);
});

test("campaign duplicate, activation, and support attempt protections are enforced", () => {
  assert.match(server, /function normalizeCampaignVideoIdentity/);
  assert.match(server, /DUPLICATE_VIDEO_CAMPAIGN/);
  assert.match(server, /function activateCampaignForCreator/);
  assert.match(server, /db\.exec\("BEGIN IMMEDIATE"\)/);
  assert.match(server, /UPDATE campaigns\s+SET status = 'inactive'/);
  assert.match(server, /UPDATE campaigns\s+SET status = 'active'/);
  assert.doesNotMatch(server, /function activateCampaignForCreator[\s\S]*?CAMPAIGN_ARCHIVED[\s\S]*?function deactivateCampaignForCreator/);
  assert.match(server, /NO_ACTIVE_CAMPAIGN/);
  assert.match(server, /CAMPAIGN_SUPPORT_LIMIT_REACHED/);
  assert.match(server, /CAMPAIGN_CHANGED/);
  assert.match(server, /LEGACY_CAMPAIGN_LOCKED/);
  assert.match(server, /Historical support totals cannot be managed as campaigns/);
  assert.match(server, /SUPPORT_ATTEMPT_ALREADY_USED/);
  assert.match(server, /AD_WATCH_TOO_SHORT/);
});

test("viewer support completion is assigned automatically to the active campaign", () => {
  assert.match(viewer, /No support video yet/);
  assert.match(viewer, /You fully supported this video/);
  assert.match(viewer, /wait 24 hours to support this one again/);
  assert.match(viewer, /campaignId:\s*activeCampaign\.id/);
  assert.match(viewer, /campaignId:\s*getSelectedCampaignId\(\)/);
  assert.match(viewer, /supportAttemptId:\s*activeSupportAttemptId/);
  assert.match(viewer, /campaignRemainingSupports <= 0/);
  assert.match(viewer, /function snapBackToWellScene/);
  assert.match(viewer, /scene\.scrollIntoView\(\{/);
  assert.match(viewer, /setTimeout\(\(\) => triggerWellGlow\(4500\), wellGlowDelay\)/);
  assert.doesNotMatch(viewer, /submitVideoAttribution/);
  assert.match(server, /getSupportCampaignForCreator\(creatorKey, campaignId\)/);
  assert.match(server, /getCampaignStatusPayload\(\s*req,\s*creatorKey,\s*fingerprint,\s*campaignId,\s*deviceFamily\s*\)/);
  assert.match(server, /getCampaignViewerKey\(req, fingerprint, deviceFamily\)/);
  assert.match(server, /getCampaignViewerKeys\(req, fingerprint, deviceFamily\)/);
});

test("dashboard uses one permanent creator link for every source", () => {
  assert.match(dashboard, /function getSupportIslandLink/);
  assert.match(dashboard, /return getSupportIslandLink\(\)/);
  assert.doesNotMatch(dashboard, /\/island\/"\s*\+/);
  assert.doesNotMatch(dashboard, /\?view=supporter/);
  assert.doesNotMatch(dashboard, /\$\{window\.location\.origin\}\/\$\{encodeURIComponent\(slug\)\}\/\$\{platform\}/);
  assert.match(server, /app\.get\("\/:creator", \(req, res\) => \{\s*sendViewerPage\(req, res, "direct"\);\s*\}\);/);
  assert.doesNotMatch(server, /app\.get\("\/:creator",[\s\S]*?res\.redirect\("\/dashboard"\)/);
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

test("mobile uses the original well wish animation and stickers are disabled", () => {
  assert.match(viewer, /const stickerAssetVersion = "2026-06-24"/);
  assert.doesNotMatch(viewer, /const stickerAssetVersion = Date\.now/);
  assert.match(viewer, /const STICKERS_ENABLED = false/);
  assert.match(viewer, /function isLowPowerStickerMode/);
  assert.match(viewer, /function shouldUseLightweightWishAnimation/);
  assert.match(viewer, /function shouldUseLightweightWishAnimation\(\)\s*{\s*return false;/);
  assert.match(viewer, /function playWishAnimation/);
  assert.match(viewer, /overlay\.classList\.remove\("quick-wish"\)/);
  assert.match(viewer, /function destroyStickerCanvases/);
  assert.match(viewer, /reactionType === "sticker" && !STICKERS_ENABLED/);
  assert.match(viewer, /reactionType === "sticker" && STICKERS_ENABLED/);
  assert.match(viewer, /stickerRow\.classList\.add\("hidden"\)/);
  assert.match(server, /Sticker \$\{index \+ 1\}/);
  assert.match(viewer, /clearStickerContainer\(stickerRow\)/);
  assert.match(viewer, /hideReactionPicker\(\)/);
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
