// Isolated fixture test: no real Torn requests, account, or API key.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.LOADOUT_PLAYWRIGHT_MODULE || "playwright");
const source = fs.readFileSync(path.join(__dirname, "../LoadoutRevealSupabase.user.js"), "utf8");
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzsAAAAABJRU5ErkJggg==";
const current = { defender_id: 2, defender_name: "Enemy", inserted_at: "2026-09-16T09:00:00Z",
  loadout: { 1: { item_id: 12, item_name: "Rifle", damage: 70, accuracy: 62, bonuses: [{ name: "Special", description: "Fixture bonus" }] },
    4: { item_id: 32, item_name: "Armor" } } };
const previous = { ...current, observed_at: "2026-09-15T09:00:00Z",
  loadout: { ...current.loadout, 1: { item_id: 13, item_name: "Old rifle", damage: 60, accuracy: 50 } } };
const weapon = label => '<div class="weaponWrapper"><span id="defender_' + label +
  '"></span><div class="top___fixture"></div><div class="weaponImage"><img src="/blank.png"></div><div class="bottom___fixture"></div></div>';
const defender = '<div class="playerArea defender"><div class="modal" style="background:red;pointer-events:auto"></div>' +
  ["Primary", "Secondary", "Melee", "Temporary"].map(weapon).join("") +
  '<div class="modelLayers"><img class="bodyImage" src="/body-m.png"><div class="armoursWrap"></div></div></div>';
const attackHtml = '<div id="attack-root"><div class="labelsContainer"></div><div class="players___fixture"><div class="playerArea attacker"><img id="attacker-untouched" src="/body-m.png"></div>' + defender + '</div></div>';
const profileHtml = '<main class="user-profile"><div class="profile-wrapper"><div class="basic-information">Enemy [2]</div></div></main>';
const factionHtml = '<aside><a href="/profiles.php?XID=777">Sidebar</a></aside><main id="mainContainer">' +
  '<div class="faction-war"><div class="your-faction"><a href="/profiles.php?XID=999">Our member</a></div>' +
  '<div class="enemy-faction">' + Array.from({ length: 100 }, (_, i) =>
    '<a href="/profiles.php?XID=' + (i + 1) + '">Enemy ' + (i + 1) + '</a>').join("") +
  '<a href="/page.php?sid=attack&amp;user2ID=2">Duplicate attack link</a>' +
  '<a href="https://other.example/profiles.php?XID=555">External</a></div></div></main>';

(async () => {
  const browser = await chromium.launch({ channel: process.env.LOADOUT_BROWSER_CHANNEL || "msedge", headless: true });
  try {
    for (const mode of ["profile", "attack", "faction", "faction-empty"]) {
      const page = await browser.newPage({ viewport: { width: 1050, height: 800 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/png", body: Buffer.from(image, "base64") });
        return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><style>body{background:#111;color:#ddd;font:14px Arial;padding:20px}.labelsContainer{min-height:40px}.players___fixture{display:flex}.playerArea{width:45%;position:relative}.weaponWrapper{width:150px;height:160px;position:relative;border:1px solid #555;display:inline-block}.weaponImage img{width:80px;height:80px}.armoursWrap{height:180px;position:relative}.armourContainer___ftMzt{position:absolute}.armourContainer___ftMzt img{height:160px}</style></head><body>' +
          (mode === "profile" ? profileHtml : mode === "attack" ? attackHtml : "<h1>Faction</h1>") + "</body></html>" });
      });
      await page.addInitScript(({ current, previous }) => {
        const store = new Map([
          ["loadout_loader_api_key", "fixture-key"],
          ["loadout_loader_quiet_mode", "1"],
          ["loadout_loader_backend_token", "e30." + btoa(JSON.stringify({ player_id: 1, faction_id: 10, exp: Date.now() / 1000 + 10000 })) + ".signature"]
        ]);
        window.GM_getValue = (key, fallback) => store.get(key) ?? fallback;
        window.GM_setValue = (key, value) => store.set(key, value);
        window.GM_deleteValue = key => store.delete(key);
        window.requests = [];
        window.requestDetails = [];
        window.GM_xmlhttpRequest = options => {
          window.requests.push(options.url);
          window.requestDetails.push({ url: options.url, headers: options.headers, data: options.data });
          const ids = options.url.endsWith("/batch") ? JSON.parse(options.data).memberIds : [];
          const body = options.url.endsWith("/batch") ? { ok: true, items: [current], missing: ids.filter(id => id !== 2) } :
            options.url.includes("history") ? { ok: true, history: [{ ...current, observed_at: current.inserted_at }, previous] } :
            options.url.includes("/report") ? { ok: true, latest: current } : { ok: true, loadout: current };
          queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(body) }));
        };
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.copied = text; } } });
        window.nativeFetchResponse = null;
        window.fetch = async () => {
          const db = { attackerUser: { userID: 1, name: "Me" }, defenderUser: { userID: 2, name: "Enemy" }, fightID: "fight-fixture",
            defenderItems: { 999: { item: [{ ID: 999 }] }, 1: { item: [{ ID: 12, name: "Rifle" }] } } };
          const response = new Response(JSON.stringify(db));
          Object.defineProperties(response, { url: { value: "https://www.torn.com/loader.php?sid=attackData" }, type: { value: "basic" } });
          window.nativeFetchResponse = response;
          return response;
        };
      }, { current, previous });
      await page.goto("https://www.torn.com/" + (mode === "profile" ? "profiles.php?XID=2" : mode === "attack" ? "page.php?sid=attack&user2ID=2" : "factions.php?step=your&type=1#/war/rank"));
      await page.addScriptTag({ content: source });
      if (mode === "profile") {
        await page.waitForSelector('#ll-profile [data-slot="1"]');
        assert.match(await page.locator("#ll-profile").innerText(), /Rifle/);
        await page.evaluate(() => { window.keptArmorImage = document.querySelector('#ll-profile [data-slot="4"] img'); });
        await page.locator('#ll-profile [data-action="older"]').click();
        await page.waitForFunction(() => document.querySelector('#ll-profile [data-slot="1"]').textContent.includes("Old rifle"));
        assert.equal(await page.evaluate(() => window.keptArmorImage === document.querySelector('#ll-profile [data-slot="4"] img')), true);
        await page.locator('#ll-profile [data-action="copy"]').click();
        assert.match(await page.evaluate(() => window.copied), /Old rifle/);
        await page.locator('#ll-profile [data-action="newer"]').click();
        assert.match(await page.locator('#ll-profile [data-slot="1"]').innerText(), /Rifle/);
        await page.screenshot({ path: path.join(__dirname, "profile-preview.png") });
        await page.setViewportSize({ width: 375, height: 700 });
        await page.locator("#loadout-panel > button").click();
        const box = await page.locator("#loadout-panel-inner").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 375, "settings menu fits the mobile viewport");
        await page.locator('[data-preference="profile"]').uncheck();
        assert.equal(await page.locator("#ll-profile .ll-profile-item").count(), 0);
        await page.locator('[data-preference="profile"]').check();
        await page.waitForSelector('#ll-profile [data-slot="1"]');
        await page.locator("#loadout-close-panel-btn").click();
      } else if (mode === "attack") {
        await page.waitForSelector(".ll-slot-overlay");
        assert.equal(await page.locator("#defender_Primary").count(), 1, "overlay clones must not duplicate native IDs");
        await page.evaluate(() => { window.keptWeapon = document.querySelector(".ll-slot-overlay img"); });
        // A native rerender outside our overlay should not recreate unchanged images.
        await page.evaluate(() => document.querySelector(".defender").appendChild(document.createElement("span")));
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.keptWeapon === document.querySelector(".ll-slot-overlay img")), true);
        // Replacing the defender subtree must remount our UI without touching the attacker.
        await page.evaluate(html => { document.querySelector(".defender").outerHTML = html; }, defender);
        await page.waitForSelector(".defender .ll-slot-overlay");
        assert.equal(await page.locator("#attacker-untouched").getAttribute("src"), "/body-m.png");
        const unchanged = await page.evaluate(async () => (await fetch("/loader.php?sid=attackData")) === window.nativeFetchResponse);
        assert.equal(unchanged, true, "Torn must receive its original response");
        await page.waitForFunction(() => window.requests.some(url => url.includes("/report")));
        assert.equal(await page.locator(".ll-slot-overlay").count(), 0, "native equipment replaces saved overlays");
        assert.equal(await page.locator('[data-action="copy"]').isDisabled(), true);
        assert.equal(await page.locator(".defender .modal").evaluate(el => el.style.pointerEvents), "auto");
      } else if (mode === "faction") {
        // No loaded roster means no discovery/authentication calls.
        await page.waitForTimeout(1000);
        assert.deepEqual(await page.evaluate(() => window.requests), []);
        // Simulate Torn asynchronously mounting its own native roster.
        await page.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), factionHtml);
        await page.waitForFunction(() => window.requests.some(url => url.endsWith("/batch")));
        const batch = await page.evaluate(() => window.requestDetails.find(row => row.url.endsWith("/batch")));
        assert.deepEqual(JSON.parse(batch.data).memberIds, Array.from({ length: 100 }, (_, i) => i + 1));
        assert.equal(batch.headers["X-Torn-Api-Key"], undefined);
        // A changed native roster must warm newly seen IDs without fetching Torn.
        await page.evaluate(() => document.querySelector('.enemy-faction a[href="/profiles.php?XID=100"]').outerHTML =
          '<a href="/profiles.php?XID=102">New arrival</a>');
        await page.waitForFunction(() => window.requests.filter(url => url.endsWith("/batch")).length === 2);
        await page.waitForTimeout(750);
        assert.equal(await page.evaluate(() => window.requests.length), 2);
        const second = await page.evaluate(() => JSON.parse(window.requestDetails[1].data).memberIds);
        assert.ok(second.includes(102) && !second.includes(100) && !second.includes(999));
        assert.equal(await page.locator(".ll-slot-overlay").count(), 0);
      } else {
        await page.waitForTimeout(1000);
        assert.deepEqual(await page.evaluate(() => window.requests), []);
      }
      assert.equal(await page.evaluate(() => window.requests.some(url => /api\.torn\.com|\/auth\/|war-cache/.test(url))), false);
      assert.deepEqual(errors, [], mode + " should have no page errors");
      console.log("PASS " + mode + " browser fixture");
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
