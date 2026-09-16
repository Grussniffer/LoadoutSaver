const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const source = fs.readFileSync(require("node:path").join(__dirname, "../LoadoutRevealSupabase.user.js"), "utf8");
const exportsList = "STATE,CFG,queueCapture,uploadCapture,processResponse,isAttackDataUrl,isNativeAttackResponse,retryAfterDelay,cacheWarItems,getLatestCacheEntry,cacheLatestLoadout,cacheScope,setBackendToken,resetAttackState,savedLoadoutIsValid,warmWarCache,knownWarMemberIds,normalizeRosterIds";
const instrumented = source.replace('    if (IS_ATTACK && typeof W.fetch === "function"', "    globalThis.testApi = {" + exportsList + "}; return;\n    if (IS_ATTACK && typeof W.fetch === \"function\"");
const storage = () => {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: k => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
};
function harness(responder = () => ({ status: 200, body: { ok: true } })) {
  const gm = new Map([["loadout_loader_api_key", "test-key"], ["loadout_loader_quiet_mode", "1"]]);
  const timers = new Map();
  const calls = [];
  const token = player => "e30." + Buffer.from(JSON.stringify({ player_id: player, faction_id: 10, exp: Date.now() / 1000 + 10000 })).toString("base64") + ".signature";
  gm.set("loadout_loader_backend_token", token(1));
  const document = { visibilityState: "visible", getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, removeEventListener() {} };
  const window = { document, location: new URL("https://www.torn.com/page.php?sid=attack&user2ID=2"),
    crypto: { randomUUID }, atob: v => Buffer.from(v, "base64").toString(),
    setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), requestIdleCallback: fn => fn(), addEventListener() {} };
  const context = { window, unsafeWindow: window, URL, console, setTimeout, TextDecoder, Uint8Array,
    atob: window.atob, localStorage: storage(), sessionStorage: storage(),
    GM_getValue: (k, fallback) => gm.get(k) ?? fallback, GM_setValue: (k, v) => gm.set(k, v), GM_deleteValue: k => gm.delete(k),
    GM_xmlhttpRequest: options => { calls.push(options); const res = responder(options, calls.length);
      options.onload({ status: res.status, responseText: JSON.stringify(res.body), responseHeaders: res.headers || "" }); } };
  vm.runInNewContext(instrumented, context);
  return { ...context.testApi, calls, gm, timers, token, context, window };
}
const attack = () => ({ attackerUser: { userID: 1, name: "Me" }, defenderUser: { userID: 2, name: "Enemy" },
  fightID: "fight-1", defenderItems: { 999: { item: [{ ID: 999 }] }, 1: { item: [{ ID: 12, name: "Rifle" }] } } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test("hooks accept only same-origin attackData, with native response provenance required", () => {
  const h = harness();
  assert.equal(h.isAttackDataUrl("/loader.php?sid=attackData"), true);
  assert.equal(h.isAttackDataUrl(new URL("https://www.torn.com/loader.php?sid=attackData")), true);
  assert.equal(h.isAttackDataUrl("https://evil.example/loader.php?sid=attackData"), false);
  assert.equal(h.isAttackDataUrl("/loader.php?sid=attackDataOther"), false);
  assert.equal(h.isNativeAttackResponse({ ok: true, type: "basic", url: "https://www.torn.com/loader.php?sid=attackData" }), true);
  assert.equal(h.isNativeAttackResponse({ ok: true, type: "default", url: "" }), false);
  h.processResponse(attack(), false);
  assert.equal(h.STATE.captures.size, 0);
});
test("failed captures retry with the SAME id and become saved only after acknowledgement", async () => {
  const h = harness((_options, n) => n === 1 ? { status: 503, body: {}, headers: "Retry-After: 10" } : { status: 200, body: { ok: true, unchanged: true } });
  h.processResponse(attack(), true);
  await settle();
  assert.equal(h.STATE.uploaded, false);
  assert.equal(h.calls.length, 1);
  const [id, timer] = [...h.timers][0];
  assert.ok(timer.ms >= 10000);
  h.timers.delete(id); timer.fn();
  await settle();
  assert.equal(h.STATE.uploaded, true);
  assert.equal(JSON.parse(h.calls[0].data).capture.id, JSON.parse(h.calls[1].data).capture.id);
  h.processResponse(attack(), true);
  await settle();
  assert.equal(h.calls.length, 2);
});
test("temporary failures stop after five attempts and retain a manual retry candidate", async () => {
  const h = harness(() => ({ status: 503, body: {} }));
  h.queueCapture(attack());
  await settle();
  for (let i = 0; i < 4; i++) {
    const [id, timer] = [...h.timers][0];
    h.timers.delete(id); timer.fn(); await settle();
  }
  assert.equal(h.calls.length, 5);
  assert.equal(h.timers.size, 0);
  assert.equal([...h.STATE.captures.values()][0].failed, true);
  assert.equal(h.STATE.uploaded, false);
});
test("wrong-target data is ignored and clearing the key prevents retries", async () => {
  const h = harness(() => ({ status: 503, body: {} }));
  const other = attack(); other.defenderUser.userID = 3;
  h.processResponse(other, true);
  assert.equal(h.STATE.attackData, null);
  h.queueCapture(attack()); await settle();
  h.gm.set("loadout_loader_api_key", "");
  const [id, timer] = [...h.timers][0]; h.timers.delete(id); timer.fn(); await settle();
  assert.equal(h.calls.length, 1);
});
test("bulk warm populates 100 players with no per-player requests and enforces cache bound", () => {
  const h = harness();
  const rows = Array.from({ length: 100 }, (_, i) => ({ defender_id: i + 1, inserted_at: new Date().toISOString(), loadout: { 1: { item_id: 12, item_name: "Rifle" } } }));
  h.cacheWarItems(rows, []);
  for (let id = 1; id <= 100; id++) assert.equal(h.getLatestCacheEntry(id).data.loadout[1].item_name, "Rifle");
  h.cacheWarItems(rows.map(row => ({ ...row, defender_id: row.defender_id + 100 })), []);
  h.cacheWarItems(rows.map(row => ({ ...row, defender_id: row.defender_id + 200 })), []);
  assert.equal([...h.gm.keys()].filter(k => k.startsWith("loadout_loader_latest_cache_v2:")).length, 200);
  assert.equal(h.calls.length, 0);
});
test("newer cross-tab cache wins and another account cannot reuse it", () => {
  const h = harness();
  h.cacheLatestLoadout(2, { inserted_at: "2026-09-16T10:00:00Z", loadout: { 1: { item_id: 12, item_name: "Old" } } });
  const key = [...h.gm.keys()].find(k => k.startsWith("loadout_loader_latest_cache_v2:"));
  h.gm.set(key, { cachedAt: Date.now() + 1, data: { loadout: { 1: { item_id: 12, item_name: "Fresh" } } } });
  assert.equal(h.getLatestCacheEntry(2).data.loadout[1].item_name, "Fresh");
  h.setBackendToken(h.token(99));
  assert.equal(h.getLatestCacheEntry(2), null);
});
test("malformed saved equipment and mismatched defender ids cannot be rendered", () => {
  const h = harness();
  assert.equal(h.savedLoadoutIsValid({ defender_id: 3, loadout: { 1: { item_id: 12, item_name: "Rifle" } } }, 2), false);
  assert.equal(h.savedLoadoutIsValid({ loadout: { 1: { item_id: "javascript:bad", item_name: "Bad" } } }, 2), false);
  assert.equal(h.savedLoadoutIsValid({ loadout: {} }, 2), false);
});

test("preloading without a known roster makes no requests, including authentication", async () => {
  const h = harness();
  await h.warmWarCache();
  assert.equal(h.calls.length, 0);
});

test("preloading batches 100 known IDs using only the backend token and shares its refresh lease", async () => {
  const h = harness(options => ({ status: 200, body: { ok: true, items: [],
    missing: JSON.parse(options.data).memberIds } }));
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);
  h.gm.set("loadout_war_roster_v2:" + h.cacheScope(), { memberIds: ids, observedAt: Date.now() });
  await h.warmWarCache();
  await h.warmWarCache();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /\/loadouts\/batch$/);
  assert.equal(h.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(h.calls[0].data).memberIds, ids);
  assert.equal(h.calls[0].headers["X-Torn-Api-Key"], undefined);
  assert.ok(h.calls[0].headers.Authorization);
});

test("a background batch 401 never reauthenticates against Torn", async () => {
  const h = harness(() => ({ status: 401, body: { error: "Expired session" } }));
  h.gm.set("loadout_war_roster_v2:" + h.cacheScope(), { memberIds: [2], observedAt: Date.now() });
  await h.warmWarCache();
  await h.warmWarCache();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /\/loadouts\/batch$/);
});

test("an expired token, hidden page or disabled preloading never triggers network access", async () => {
  const h = harness();
  h.gm.set("loadout_war_roster_v2:" + h.cacheScope(), { memberIds: [2], observedAt: Date.now() });
  h.window.document.visibilityState = "hidden";
  await h.warmWarCache();
  h.window.document.visibilityState = "visible";
  h.gm.set(h.CFG.store.warCache, "0");
  await h.warmWarCache();
  h.gm.set(h.CFG.store.warCache, "1");
  const expired = "e30." + Buffer.from(JSON.stringify({ player_id: 1, faction_id: 10, exp: 1 })).toString("base64") + ".signature";
  h.setBackendToken(expired);
  await h.warmWarCache();
  assert.equal(h.calls.length, 0);
});

test("roster reuse is bounded, expires without extending itself and is account-scoped", () => {
  const h = harness();
  const key = "loadout_war_roster_v2:" + h.cacheScope();
  h.gm.set(key, { memberIds: [3, 2, 3], observedAt: Date.now() });
  assert.deepEqual(Array.from(h.knownWarMemberIds()), [2, 3]);
  h.setBackendToken(h.token(99));
  assert.equal(h.knownWarMemberIds().length, 0);
  h.setBackendToken(h.token(1));
  h.gm.set(key, { memberIds: [2], observedAt: Date.now() - h.CFG.warRosterMaxAgeMs });
  assert.equal(h.knownWarMemberIds().length, 0);
  assert.equal(h.normalizeRosterIds(Array.from({ length: 101 }, (_, i) => i + 1)).length, 0);
  assert.equal(h.normalizeRosterIds([2, -3]).length, 0);
});
