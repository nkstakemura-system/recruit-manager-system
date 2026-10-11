const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");
const filename = path.join(__dirname, "../lib/mobileClient.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const m = new Module(filename, module);
m._compile(compiled, filename);
const { createMobileClient, AuthenticationRequired } = m.exports;
function harness(responses = []) {
  let saved = null;
  const calls = [];
  const storage = {
    async getItemAsync() { return saved; },
    async setItemAsync(key, value) { saved = value; },
    async deleteItemAsync() { saved = null; },
  };
  const request = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected mock request");
    return typeof next === "function" ? next() : next;
  };
  return {
    client: createMobileClient(storage, request, "https://test.invalid"), calls, storage,
    saved: () => saved, seed: value => { saved = value; },
  };
}
const generatedToken = () => crypto.randomBytes(32).toString("hex");
const loginResponse = () => new Response(JSON.stringify({
  access_token: generatedToken(), expires_at: Date.now() + 8 * 60 * 60 * 1000,
}), { status: 200 });

test("no saved token opens login without requests; login stores securely and adds Bearer", async () => {
  const h = harness([loginResponse(), new Response(JSON.stringify({ user: {} })), new Response("[]")]);
  assert.equal(await h.client.check(), null); assert.equal(h.calls.length, 0);
  await h.client.login("test-user", crypto.randomBytes(12).toString("hex"));
  const saved = JSON.parse(h.saved());
  assert.equal(typeof saved.token, "string");
  assert.equal(await h.client.check(), saved.expiresAt);
  await h.client.apiFetch("/api/candidates");
  assert.equal(h.calls[2].options.headers.get("Authorization"), "Bearer " + saved.token);
  assert.equal(h.calls[2].options.credentials, "omit");
});

test("logout deletes token and notifies UI without a server call", async () => {
  const h = harness([loginResponse()]);
  await h.client.login("test-user", crypto.randomBytes(12).toString("hex"));
  let notified = 0; h.client.subscribe(() => { notified++; });
  await h.client.logout();
  assert.equal(h.saved(), null); assert.equal(notified, 1);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.client.apiFetch("/api/candidates"), AuthenticationRequired);
});

test("expiry, corrupt storage and server 401 delete saved token", async () => {
  for (const saved of [
    JSON.stringify({ token: generatedToken(), expiresAt: Date.now() - 1 }), "invalid-json",
  ]) {
    const h = harness(); h.seed(saved);
    assert.equal(await h.client.check(), null);
    assert.equal(h.saved(), null); assert.equal(h.calls.length, 0);
  }
  const h = harness([new Response("{}", { status: 401 })]);
  h.seed(JSON.stringify({ token: generatedToken(), expiresAt: Date.now() + 10000 }));
  await assert.rejects(h.client.apiFetch("/api/expenses"), AuthenticationRequired);
  assert.equal(h.saved(), null);
});

test("logout while a protected request is pending prevents stale data display", async () => {
  let resolve, started;
  const requested = new Promise(r => { started = r; });
  const response = new Promise(r => { resolve = r; });
  const h = harness([() => { started(); return response; }]);
  h.seed(JSON.stringify({ token: generatedToken(), expiresAt: Date.now() + 10000 }));
  const pending = h.client.apiFetch("/api/candidates");
  await requested; await h.client.logout();
  resolve(new Response("[]"));
  await assert.rejects(pending, AuthenticationRequired);
  assert.equal(h.saved(), null);
});

test("login failure stores no token; storage-delete failure keeps current process logged out", async () => {
  const h = harness([new Response("{}", { status: 401 })]);
  await assert.rejects(h.client.login("test-user", crypto.randomBytes(12).toString("hex")));
  assert.equal(h.saved(), null);
  h.seed(JSON.stringify({ token: generatedToken(), expiresAt: Date.now() + 10000 }));
  h.storage.deleteItemAsync = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(h.client.logout());
  assert.equal(await h.client.check(), null);
});