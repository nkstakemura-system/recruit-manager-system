const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createAuth } = require("../auth");

const password = crypto.randomBytes(20).toString("hex");
const env = {
  NODE_ENV: "production",
  AUTH_USERNAME: crypto.randomBytes(8).toString("hex"),
  AUTH_PASSWORD_HASH: bcrypt.hashSync(password, 10),
  AUTH_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
  MEETING_API_TOKEN: crypto.randomBytes(32).toString("hex"),
  ALLOWED_ORIGINS: "https://recruit.example,https://meeting.example",
};
function harness(settings = env) {
  const routes = new Map(), layers = [];
  const app = {
    use(...args) { layers.push(args); },
    post(url, ...handlers) { routes.set("POST " + url, handlers); },
    get(url, ...handlers) { routes.set("GET " + url, handlers); },
  };
  const auth = createAuth(settings);
  auth.install(app);
  const req = (overrides = {}) => ({
    method: "GET", headers: {}, cookies: {}, body: {}, ip: "192.0.2.4",
    socket: { remoteAddress: "192.0.2.4" },
    app: { get: () => false }, get(name) { return this.headers[name.toLowerCase()]; },
    ...overrides,
  });
  const res = () => Object.assign(new EventEmitter(), {
    statusCode: 200, body: null, headers: {}, cookiesSet: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    setHeader(name, value) { this.set(name, value); },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    append(name, value) { this.set(name, value); },
    cookie(name, value, options) { this.cookiesSet.push({ name, value, options }); },
    clearCookie(name, options) { this.cleared = { name, options }; },
  });
  async function run(handlers, request, response) {
    for (const handler of handlers) {
      let continued = false;
      await handler(request, response, error => { if (error) throw error; continued = true; });
      if (!continued) break;
    }
    return response;
  }
  return { auth, layers, routes, req, res, run };
}
async function login(h) {
  const r = h.res();
  await h.run(h.routes.get("POST /api/auth/login").slice(1), h.req({
    method: "POST", headers: { origin: "https://recruit.example" }, body: { username: env.AUTH_USERNAME, password },
  }), r);
  assert.equal(r.statusCode, 200);
  return r;
}

test("login, HttpOnly Secure cookie, auth/me, restart verification and logout", async () => {
  const h = harness(), r = await login(h), cookie = r.cookiesSet[0];
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.secure, true);
  assert.equal(cookie.options.sameSite, "lax");
  assert.equal(cookie.options.maxAge, 8 * 60 * 60 * 1000);
  assert.equal(cookie.name, "__Host-recruit_session");
  assert.deepEqual(Object.keys(r.body), ["user"]);
  const request = h.req({ cookies: { [cookie.name]: cookie.value } });
  const me = await h.run(h.routes.get("GET /api/auth/me"), request, h.res());
  assert.deepEqual(me.body, { user: { username: env.AUTH_USERNAME } });
  let passed = false;
  harness().auth.requireSession(request, h.res(), () => { passed = true; });
  assert(passed);
  const logout = await h.run(h.routes.get("POST /api/auth/logout"), h.req({
    method: "POST", headers: { origin: "https://recruit.example" }, cookies: request.cookies,
  }), h.res());
  assert.equal(logout.cleared.name, cookie.name);
  assert.equal(logout.cleared.options.secure, true);
  const loggedOut = await h.run(h.routes.get("GET /api/auth/me"), h.req(), h.res());
  assert.equal(loggedOut.statusCode, 401);
});

test("wrong username/password have identical failures and emit no cookie", async () => {
  const h = harness(), outputs = [];
  for (const body of [
    { username: "incorrect-test-user", password },
    { username: env.AUTH_USERNAME, password: crypto.randomBytes(16).toString("hex") },
  ]) {
    const r = await h.run(h.routes.get("POST /api/auth/login").slice(1), h.req({
      method: "POST", headers: { origin: "https://recruit.example" }, body,
    }), h.res());
    outputs.push(r.body);
    assert.equal(r.statusCode, 401); assert.equal(r.cookiesSet.length, 0);
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test("all session API mutations require authentication and a trusted Origin", async () => {
  const h = harness(), cookie = (await login(h)).cookiesSet[0];
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const r = h.res(); h.auth.requireSession(h.req({ method }), r, () => assert.fail("unauthenticated"));
    assert.equal(r.statusCode, 401);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of [undefined, "https://attacker.example", "null"]) {
      const r = h.res();
      h.auth.requireSession(h.req({ method, cookies: { [cookie.name]: cookie.value }, headers: { origin } }), r, () => assert.fail("cross-site"));
      assert.equal(r.statusCode, 403);
    }
    let passed = false;
    h.auth.requireSession(h.req({ method, cookies: { [cookie.name]: cookie.value }, headers: { origin: "https://recruit.example" } }), h.res(), () => { passed = true; });
    assert(passed);
  }
});

test("meeting supports session or server-only Bearer; rejects invalid/missing/browser Bearer", async () => {
  const h = harness(), cookie = (await login(h)).cookiesSet[0];
  for (const request of [
    h.req({ cookies: { [cookie.name]: cookie.value } }),
    h.req({ headers: { authorization: "Bearer " + env.MEETING_API_TOKEN } }),
  ]) {
    let passed = false; h.auth.requireMeeting(request, h.res(), () => { passed = true; }); assert(passed);
  }
  for (const headers of [
    {}, { authorization: "Bearer wrong" },
    { authorization: "Bearer " + env.MEETING_API_TOKEN, origin: "https://recruit.example" },
    { authorization: "Bearer " + env.MEETING_API_TOKEN, "sec-fetch-site": "same-origin" },
  ]) {
    const r = h.res(); h.auth.requireMeeting(h.req({ headers }), r, () => assert.fail("invalid token"));
    assert.equal(r.statusCode, 401);
  }
  const r = h.res();
  h.auth.requireSession(h.req({ headers: { authorization: "Bearer " + env.MEETING_API_TOKEN } }), r, () => assert.fail("token granted write access"));
  assert.equal(r.statusCode, 401);
});

test("CORS rejects unknown origins, permits configured origins, and fails closed in production", async () => {
  const h = harness();
  const guard = h.layers[1][1], cors = h.layers[1][2];
  const bad = h.res(); guard(h.req({ headers: { origin: "https://attacker.example" } }), bad, () => assert.fail());
  assert.equal(bad.statusCode, 403);
  for (const origin of ["https://recruit.example", "https://meeting.example"]) {
    const r = await h.run([guard, cors], h.req({ headers: { origin } }), h.res());
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.equal(r.headers["access-control-allow-credentials"], "true");
  }
  const closed = harness({ ...env, ALLOWED_ORIGINS: "" }), r = closed.res();
  closed.layers[1][1](closed.req({ headers: { origin: "https://recruit.example" } }), r, () => assert.fail());
  assert.equal(r.statusCode, 403);
});

test("expired, forged, rotated and unconfigured sessions fail closed", async () => {
  const h = harness(), cookie = (await login(h)).cookiesSet[0];
  const original = jwt.decode(cookie.value);
  const expired = jwt.sign({ version: original.version }, env.AUTH_SESSION_SECRET, {
    subject: env.AUTH_USERNAME, issuer: "recruit-manager", audience: "recruit-web", expiresIn: -1,
  });
  for (const [settings, value] of [
    [env, expired], [env, cookie.value + "invalid"],
    [{ ...env, AUTH_SESSION_SECRET: crypto.randomBytes(48).toString("hex") }, cookie.value],
    [{ ...env, AUTH_PASSWORD_HASH: bcrypt.hashSync(crypto.randomBytes(20).toString("hex"), 10) }, cookie.value],
    [{ NODE_ENV: "production" }, cookie.value],
  ]) {
    const a = harness(settings), r = a.res();
    a.auth.requireSession(a.req({ cookies: { [cookie.name]: value } }), r, () => assert.fail());
    assert.equal(r.statusCode, 401);
  }
});

test("login rate limiter blocks attempt 11 with 429", async () => {
  const h = harness(), limiter = h.routes.get("POST /api/auth/login")[0];
  for (let i = 1; i <= 11; i++) {
    const r = h.res(); let next = false;
    await limiter(h.req({ method: "POST" }), r, () => { next = true; });
    if (i <= 10) assert(next); else assert.equal(r.statusCode, 429);
  }
});

test("server registers guards before every data route and API fallback returns JSON", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../server.js"), "utf8");
  assert.match(source, /app\.get\("\/api\/meeting\/hr-summary", auth\.requireMeeting/);
  const globalGuard = source.indexOf('app.use("/api", auth.requireSession)');
  for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\("\/api\/(candidates|expenses)[^"]*"/g))
    assert(globalGuard >= 0 && globalGuard < match.index);
  assert.match(source, /app\.use\("\/api", \(req, res\) => res\.status\(404\)\.json/);
});
async function mobileLogin(h) {
  const r = await h.run(h.routes.get("POST /api/auth/mobile/login").slice(1), h.req({
    method: "POST", body: { username: env.AUTH_USERNAME, password },
  }), h.res());
  assert.equal(r.statusCode, 200);
  assert.equal(r.cookiesSet.length, 0);
  return r.body.access_token;
}

test("mobile login returns scoped eight-hour JWT and no cookie; failures are generic", async () => {
  const h = harness(), token = await mobileLogin(h);
  const claims = jwt.verify(token, env.AUTH_SESSION_SECRET, {
    algorithms: ["HS256"], issuer: "recruit-manager", audience: "recruit-mobile",
  });
  assert.equal(claims.type, "user"); assert.equal(claims.client, "mobile");
  assert.equal(claims.exp - claims.iat, 8 * 60 * 60);
  const results = [];
  for (const body of [
    { username: env.AUTH_USERNAME, password: crypto.randomBytes(20).toString("hex") },
    { username: crypto.randomBytes(8).toString("hex"), password },
  ]) {
    const r = await h.run(h.routes.get("POST /api/auth/mobile/login").slice(1),
      h.req({ method: "POST", body }), h.res());
    assert.equal(r.statusCode, 401); results.push(r.body);
  }
  assert.deepEqual(results[0], results[1]);
  const browser = await h.run(h.routes.get("POST /api/auth/mobile/login").slice(1), h.req({
    method: "POST", headers: { origin: "https://recruit.example" },
    body: { username: env.AUTH_USERNAME, password },
  }), h.res());
  assert.equal(browser.statusCode, 403);
});

test("mobile Bearer grants normal reads/writes and hr-summary without cookie CSRF rules", async () => {
  const h = harness(), token = await mobileLogin(h);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    let passed = false;
    h.auth.requireSession(h.req({ method, headers: { authorization: "Bearer " + token } }), h.res(), () => { passed = true; });
    assert(passed);
  }
  const me = await h.run(h.routes.get("GET /api/auth/me"), h.req({
    headers: { authorization: "Bearer " + token },
  }), h.res());
  assert.equal(me.statusCode, 200); assert.equal(me.body.user.username, env.AUTH_USERNAME);
  let meeting = false;
  h.auth.requireMeeting(h.req({ headers: { authorization: "Bearer " + token } }), h.res(), () => { meeting = true; });
  assert(meeting);
});

test("mobile JWT rejects expiry, forgery, wrong audience/type, cookie substitution and meeting tokens", async () => {
  const h = harness(), token = await mobileLogin(h), version = jwt.decode(token).version;
  const sign = (payload, audience, expiresIn) => jwt.sign(payload, env.AUTH_SESSION_SECRET, {
    algorithm: "HS256", subject: env.AUTH_USERNAME, issuer: "recruit-manager", audience, expiresIn,
  });
  for (const invalid of [
    token + "invalid", env.MEETING_API_TOKEN,
    sign({ version, type: "user", client: "mobile" }, "recruit-mobile", -1),
    sign({ version, type: "user", client: "mobile" }, "recruit-web", 3600),
    sign({ version, type: "meeting", client: "mobile" }, "recruit-mobile", 3600),
  ]) {
    const r = h.res();
    h.auth.requireSession(h.req({ headers: { authorization: "Bearer " + invalid } }), r, () => assert.fail("invalid accepted"));
    assert.equal(r.statusCode, 401);
  }
  const r = h.res();
  h.auth.requireSession(h.req({ cookies: { "__Host-recruit_session": token } }), r, () => assert.fail("mobile used as cookie"));
  assert.equal(r.statusCode, 401);
});

test("Web and mobile login share the same rate-limit budget", async () => {
  const h = harness();
  const web = h.routes.get("POST /api/auth/login")[0], mobile = h.routes.get("POST /api/auth/mobile/login")[0];
  assert.equal(web, mobile);
  for (let i = 0; i < 11; i++) {
    const r = h.res(); let continued = false;
    await (i % 2 ? mobile : web)(h.req({ method: "POST" }), r, () => { continued = true; });
    if (i < 10) assert(continued); else assert.equal(r.statusCode, 429);
  }
});