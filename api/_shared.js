const { kv } = require("@vercel/kv");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const DEVICE_LIMIT = 2;
const PLAN_TITLE = process.env.PLAN_TITLE || "Full Access";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // For production, set JWT_SECRET in Vercel env vars.
    return "dev-insecure-jwt-secret-change-in-prod";
  }
  return secret;
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Very simple in-memory rate limiting stub per function instance.
const rateLimitStore = {};
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

function rateLimit(req, res) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitStore[ip] || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;
  rateLimitStore[ip] = entry;

  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "rate_limited" }));
    return true;
  }

  return false;
}

function userKey(email) {
  return `user:${email.toLowerCase()}`;
}

async function getUser(email) {
  if (!email) return null;
  return (await kv.get(userKey(email))) || null;
}

async function saveUser(user) {
  if (!user || !user.email) return;
  await kv.set(userKey(user.email), user);
}

function computeTrialDaysRemaining(trialStartedAtIso) {
  if (!trialStartedAtIso) return 0;
  const startedAt = new Date(trialStartedAtIso);
  if (Number.isNaN(startedAt.getTime())) return 0;
  const now = new Date();
  const diffMs = now.getTime() - startedAt.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const remaining = 5 - days;
  return remaining > 0 ? remaining : 0;
}

function createJwt(email) {
  const tokenId = crypto.randomBytes(16).toString("hex");
  const payload = {
    email,
    token_id: tokenId
  };

  const token = jwt.sign(payload, getJwtSecret(), {
    expiresIn: "30d"
  });

  return { token, tokenId };
}

function verifyJwt(token) {
  return jwt.verify(token, getJwtSecret());
}

module.exports = {
  DEVICE_LIMIT,
  PLAN_TITLE,
  rateLimit,
  getUser,
  saveUser,
  computeTrialDaysRemaining,
  createJwt,
  verifyJwt,
  userKey
};


