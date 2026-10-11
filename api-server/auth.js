const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");

const ttlSeconds = 8 * 60 * 60;
const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(a).digest(),
  crypto.createHash("sha256").update(b).digest(),
);

function createAuth(env = process.env) {
  const production = env.NODE_ENV === "production";
  const username = env.AUTH_USERNAME || "";
  const passwordHash = env.AUTH_PASSWORD_HASH || "";
  const secret = env.AUTH_SESSION_SECRET || "";
  const meetingToken = env.MEETING_API_TOKEN || "";
  const configured = Boolean(username && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash) && Buffer.byteLength(secret) >= 32);
  const cookieName = production ? "__Host-recruit_session" : "recruit_session";
  const cookieOptions = { httpOnly: true, secure: production, sameSite: "lax", path: "/" };
  const origins = new Set((env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean));
  if (!production) {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
    origins.add("http://localhost:5000");
    origins.add("http://127.0.0.1:5000");
  }
  // Credential changes invalidate existing signed cookies without a DB session store.
  const version = crypto.createHash("sha256").update(username + "\0" + passwordHash).digest("hex");
  const unauthorized = res => res.status(401).json({ error: "Authentication required" });
  const trustedOrigin = origin => typeof origin === "string" && origins.has(origin);
  const originGuard = (req, res, next) => {
    if (!trustedOrigin(req.get("Origin"))) return res.status(403).json({ error: "Origin not allowed" });
    next();
  };
  const corsGuard = (req, res, next) => {
    const origin = req.get("Origin");
    if (origin && !trustedOrigin(origin)) return res.status(403).json({ error: "Origin not allowed" });
    next();
  };
  const corsMiddleware = cors({
    origin(origin, callback) { callback(null, Boolean(origin && trustedOrigin(origin))); },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  function sessionUser(req) {
    if (!configured) return null;
    try {
      const claims = jwt.verify(req.cookies?.[cookieName], secret, {
        algorithms: ["HS256"], issuer: "recruit-manager", audience: "recruit-web",
      });
      return claims.sub === username && claims.version === version &&
        Number.isFinite(claims.exp) ? { username } : null;
    } catch { return null; }
  }
  function mobileUser(req) {
    if (!configured) return null;
    const match = /^Bearer (\S+)$/.exec(req.get("Authorization") || "");
    if (!match) return null;
    try {
      const claims = jwt.verify(match[1], secret, {
        algorithms: ["HS256"], issuer: "recruit-manager", audience: "recruit-mobile",
      });
      return claims.sub === username && claims.version === version &&
        claims.type === "user" && claims.client === "mobile" &&
        Number.isFinite(claims.exp) ? { username } : null;
    } catch { return null; }
  }
  function requireSession(req, res, next) {
    const bearer = Boolean(req.get("Authorization"));
    const user = bearer ? mobileUser(req) : sessionUser(req);
    if (!user) return unauthorized(res);
    req.authUser = user;
    if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(req.method)) return originGuard(req, res, next);
    next();
  }
  function requireMeeting(req, res, next) {
    const header = req.get("Authorization");
    if (header) {
      const user = mobileUser(req);
      if (user) { req.authUser = user; return next(); }
      const match = /^Bearer (\S+)$/.exec(header);
      if (Buffer.byteLength(meetingToken) < 32 || !match || req.get("Origin") || req.get("Sec-Fetch-Site") ||
          !safeEqual(match[1], meetingToken)) return unauthorized(res);
      req.meetingAuthenticated = true;
      return next();
    }
    return requireSession(req, res, next);
  }
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    // Shared account budget: independent of proxy headers and client-controlled IPs.
    keyGenerator: () => "recruit-login",
    message: { error: "Too many login attempts" },
  });

  function install(app) {
    app.use("/api", (req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    });
    app.use("/api", corsGuard, corsMiddleware, cookieParser());
    const login = mobile => async (req, res) => {
      if (!configured) return res.status(503).json({ error: "Authentication not configured" });
      const suppliedName = req.body?.username;
      const password = req.body?.password;
      if (typeof suppliedName !== "string" || typeof password !== "string" ||
          !password || bcrypt.truncates(password) || suppliedName.length > 256) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      try {
        const passwordMatches = await bcrypt.compare(password, passwordHash);
        if (!passwordMatches || !safeEqual(suppliedName, username))
          return res.status(401).json({ error: "Invalid credentials" });
        const session = jwt.sign(mobile ? { version, type: "user", client: "mobile" } : { version }, secret, {
          algorithm: "HS256", subject: username, issuer: "recruit-manager",
          audience: mobile ? "recruit-mobile" : "recruit-web", expiresIn: ttlSeconds,
        });
        if (mobile) return res.json({ access_token: session, token_type: "Bearer",
          expires_at: jwt.decode(session).exp * 1000, user: { username } });
        res.cookie(cookieName, session, { ...cookieOptions, maxAge: ttlSeconds * 1000 });
        res.json({ user: { username } });
      } catch { res.status(503).json({ error: "Authentication unavailable" }); }
    };
    app.post("/api/auth/login", loginLimiter, originGuard, login(false));
    app.post("/api/auth/mobile/login", loginLimiter, (req, res, next) => {
      if (req.get("Origin") || req.get("Sec-Fetch-Site"))
        return res.status(403).json({ error: "Native client required" });
      next();
    }, login(true));
    app.post("/api/auth/logout", originGuard, (req, res) => {
      res.clearCookie(cookieName, cookieOptions);
      res.json({ ok: true });
    });
    app.get("/api/auth/me", requireSession, (req, res) => res.json({ user: req.authUser }));
  }
  return { install, requireSession, requireMeeting };
}
module.exports = { createAuth };