// ==UserScript==
// @name         Askelads Loadout Loader
// @namespace    askelads.loadout.loader
// @version      3.5.0
// @description  Captures Torn attack data and renders saved loadouts through the Askelads backend.
// @author       Sneip
// @match        https://www.torn.com/loader.php?sid=attack&user2ID=*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      askelads.grusmedia.no
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.meta.js
// ==/UserScript==

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const SCRIPT_VERSION = "3.5.0";
    const PDA_KEY = "###PDA-APIKEY###";
    const IS_PDA = !PDA_KEY.includes("#");

    const CFG = {
        apiBaseUrl: "https://askelads.grusmedia.no/loadout-api",
        historyLimit: 10,
        store: {
            apiKey: "loadout_loader_api_key",
            backendToken: "loadout_loader_backend_token",
            quietToasts: "loadout_loader_quiet_mode"
        }
    };

    const STATE = {
        uploaded: false,
        loadoutRendered: false,
        attackData: null,
        authChecked: false,
        isAuthorized: false,
        userInfo: null,
        authPromise: null,
        historyOpen: false
    };

    function getLocalStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function setLocalStorage(key, v) {
        try { localStorage.setItem(key, v); } catch {}
    }

    function getAPIKey() {
        return IS_PDA ? PDA_KEY : getLocalStorage(CFG.store.apiKey);
    }

    function getBackendToken() {
        return getLocalStorage(CFG.store.backendToken);
    }

    function setBackendToken(token) {
        setLocalStorage(CFG.store.backendToken, token || "");
    }

    function parseJson(text) {
        try { return JSON.parse(text); } catch { return null; }
    }

    function escapeHtml(v) {
        return String(v ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }

    function formatFixed2(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(2) : "-";
    }

    function whenVisible(fn) {
        if (W.document.visibilityState === "visible") {
            fn();
            return;
        }

        const handler = () => {
            if (W.document.visibilityState !== "visible") return;
            W.document.removeEventListener("visibilitychange", handler);
            fn();
        };

        W.document.addEventListener("visibilitychange", handler);
    }

    function relativeTime(ms) {
        const mins = Math.floor(ms / 60000);
        const hrs = Math.floor(ms / 3600000);
        const days = Math.floor(ms / 86400000);
        const wks = Math.floor(days / 7);
        const mths = Math.floor(days / 30);
        const fmt = (n, u) => `${n} ${u}${n > 1 ? "s" : ""} ago`;

        return mths >= 1 ? fmt(mths, "month")
            : wks >= 1 ? fmt(wks, "week")
            : days >= 1 ? fmt(days, "day")
            : hrs >= 1 ? fmt(hrs, "hour")
            : mins >= 1 ? fmt(mins, "minute")
            : "just now";
    }

    function waitForElement(selector, callback, timeout = 15000) {
        const found = W.document.querySelector(selector);
        if (found) {
            callback(found);
            return;
        }

        const obs = new MutationObserver(() => {
            const el = W.document.querySelector(selector);
            if (el) {
                obs.disconnect();
                W.clearTimeout(timer);
                callback(el);
            }
        });

        obs.observe(W.document.documentElement, { childList: true, subtree: true });
        const timer = W.setTimeout(() => obs.disconnect(), timeout);
    }

    function resetAuthorizationState() {
        STATE.authChecked = false;
        STATE.isAuthorized = false;
        STATE.userInfo = null;
        STATE.authPromise = null;
        setBackendToken("");
    }

    function resetAttackState() {
        STATE.uploaded = false;
        STATE.loadoutRendered = false;
        cleanupScriptOverlays();
    }

    function cleanupScriptOverlays() {
        W.document.querySelectorAll(".ll-slot-overlay, .ll-armor-overlay, .ll-armor-map").forEach(el => el.remove());
    }

    function toast(message, duration = 10000) {
        const host = W.document.getElementById("loadout-toast-host");
        if (!host) return;

        const el = W.document.createElement("div");
        el.style.cssText = [
            "background:linear-gradient(180deg, rgba(24,20,17,0.98), rgba(14,12,10,0.98))",
            "color:#f4e7c2",
            "border:1px solid rgba(191,145,63,0.35)",
            "border-left:4px solid #bf913f",
            "padding:10px 12px",
            "border-radius:12px",
            "font:13px/1.4 'Segoe UI',Tahoma,sans-serif",
            "box-shadow:0 12px 28px rgba(0,0,0,0.45)"
        ].join(";");

        el.innerHTML = `
            <div style="font-weight:800;font-size:11px;color:#d7b46a;margin-bottom:4px;letter-spacing:.4px;text-transform:uppercase;">
                Askelads Loadout
            </div>
            <div>${escapeHtml(message)}</div>
        `;

        host.appendChild(el);
        W.setTimeout(() => el.remove(), duration);
    }

    function toastInfo(message, duration = 2500) {
        if (getLocalStorage(CFG.store.quietToasts) === "1") return;
        toast(message, duration);
    }

    function apiRequest(method, path, body, { auth = false } = {}) {
        const url = `${CFG.apiBaseUrl}${path}`;
        const bridge = W.flutter_inappwebview;

        const headers = {
            "Content-Type": "application/json",
            "X-Script-Version": SCRIPT_VERSION
        };

        if (auth) {
            const token = getBackendToken();
            if (token) headers.Authorization = `Bearer ${token}`;

            const apiKey = getAPIKey();
            if (apiKey) headers["X-Torn-Api-Key"] = apiKey;
        }

        if (bridge?.callHandler) {
            const handler = method === "GET" ? "PDA_httpGet" : "PDA_httpPost";
            const call = method === "GET"
                ? bridge.callHandler(handler, url, headers)
                : bridge.callHandler(handler, url, headers, body ? JSON.stringify(body) : "");

            return call
                .then(r => ({
                    ok: Number(r?.status || 0) >= 200 && Number(r?.status || 0) < 300,
                    status: Number(r?.status || 0),
                    data: parseJson(String(r?.responseText || ""))
                }))
                .catch(() => ({ ok: false, status: 0, data: null }));
        }

        if (typeof GM_xmlhttpRequest === "function") {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    ...(body ? { data: JSON.stringify(body) } : {}),
                    onload: (r) => resolve({
                        ok: r.status >= 200 && r.status < 300,
                        status: r.status,
                        data: parseJson(r.responseText)
                    }),
                    onerror: () => resolve({ ok: false, status: 0, data: null }),
                    ontimeout: () => resolve({ ok: false, status: 0, data: null })
                });
            });
        }

        return W.fetch(url, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {})
        })
            .then(async (r) => ({
                ok: r.ok,
                status: r.status,
                data: parseJson(await r.text())
            }))
            .catch(() => ({ ok: false, status: 0, data: null }));
    }

    function extractUserId(user) {
        return user?.userID ?? user?.id ?? user?.player_id ?? user?.ID ?? null;
    }

    function extractUserName(user) {
        if (!user || typeof user !== "object") return null;
        return user?.playername
            ?? user?.name
            ?? user?.userName
            ?? user?.player_name
            ?? user?.username
            ?? user?.Name
            ?? user?.fullName
            ?? user?.displayName
            ?? user?.user?.name
            ?? user?.profile?.name
            ?? null;
    }

    function getTextContent(selectors) {
        for (const selector of selectors) {
            try {
                const el = W.document.querySelector(selector);
                const text = el?.textContent?.trim();
                if (text) return text;
            } catch {}
        }
        return null;
    }

    function getPageAttackerName() {
        return getTextContent([
            "#attacker [class*='name']",
            "[class*='attacker'] [class*='name']",
            "[class*='attacker'] [class*='title']",
            "[class*='playerArea']:first-child [class*='name']",
            "[class*='playerArea']:first-child a"
        ]);
    }

    function getPageDefenderName() {
        return getTextContent([
            "#defender [class*='name']",
            "[class*='defender'] [class*='name']",
            "[class*='defender'] [class*='title']",
            "[class*='playerArea']:nth-child(2) [class*='name']",
            "[class*='playerArea']:nth-child(2) a"
        ]);
    }

    function extractItemId(raw) {
        return raw?.ID ?? raw?.id ?? raw?.item_id ?? raw?.itemID ?? null;
    }

    function normalizeMods(mods) {
        if (!mods) return [];
        const arr = Array.isArray(mods) ? mods : Object.values(mods);

        return arr.map(m => ({
            icon: m?.icon || m?.key || m?.type || m?.name || null,
            name: m?.title || m?.name || m?.label || "",
            description: m?.desc || m?.description || m?.text || m?.hoverover || ""
        }));
    }

    function normalizeBonuses(bonuses) {
        if (!bonuses) return [];
        const arr = Array.isArray(bonuses)
            ? bonuses
            : Object.entries(bonuses).map(([key, value]) => ({
                bonus_key: key,
                ...(value || {})
            }));

        return arr.map(b => ({
            bonus_key: b?.bonus_key || b?.key || b?.icon || b?.type || b?.title || null,
            name: b?.title || b?.name || b?.label || "",
            description: b?.desc || b?.description || b?.text || b?.hoverover || ""
        }));
    }

    function mapGlowClassToRarity(glowClass) {
        const value = String(glowClass || "").toLowerCase();
        if (value.includes("yellow")) return "yellow";
        if (value.includes("orange")) return "orange";
        if (value.includes("red")) return "red";
        return "";
    }

    function extractAmmoType(raw) {
        const ammo = raw?.ammotype ?? raw?.ammo_type ?? raw?.ammoType ?? null;
        return ammo == null ? null : String(ammo);
    }

    function extractSlotItem(slotData) {
        if (!slotData) return null;

        const raw =
            slotData?.item?.[0] ||
            slotData?.item ||
            slotData?.weapon ||
            slotData;

        if (!raw) return null;

        const itemId = extractItemId(raw);
        if (!itemId) return null;

        return {
            item_id: itemId,
            item_name: raw?.name || raw?.item_name || raw?.itemName || "Unknown",
            damage: raw?.dmg != null ? Number(raw.dmg) : raw?.damage != null ? Number(raw.damage) : null,
            accuracy: raw?.acc != null ? Number(raw.acc) : raw?.accuracy != null ? Number(raw.accuracy) : null,
            rarity: mapGlowClassToRarity(raw?.glowClass || raw?.rarity || ""),
            ammo_type: extractAmmoType(raw),
            mods: normalizeMods(raw?.currentUpgrades || raw?.mods || raw?.attachments || []),
            bonuses: normalizeBonuses(raw?.currentBonuses || raw?.bonuses || [])
        };
    }

    function extractLoadoutFromAttackData(db) {
        const defenderItems = db?.defenderItems;
        if (!defenderItems || typeof defenderItems !== "object") return null;

        const loadout = {};

        for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
            const slotData = defenderItems?.[slot] || defenderItems?.[String(slot)];
            const parsed = extractSlotItem(slotData);
            if (parsed) loadout[slot] = parsed;
        }

        return Object.keys(loadout).length ? loadout : null;
    }

    async function validateUserAccess() {
        const apiKey = getAPIKey();

        if (!apiKey) {
            STATE.authChecked = true;
            STATE.isAuthorized = false;
            STATE.userInfo = null;
            return false;
        }

        const res = await apiRequest("POST", "/api/auth/torn", { apiKey }, { auth: false });

        if (!res.ok || !res.data?.ok || !res.data?.token) {
            toast(res.data?.error || "Failed to authenticate with backend", 5000);
            STATE.authChecked = true;
            STATE.isAuthorized = false;
            STATE.userInfo = null;
            setBackendToken("");
            return false;
        }

        setBackendToken(res.data.token);
        STATE.userInfo = res.data.player || null;
        STATE.authChecked = true;
        STATE.isAuthorized = true;
        return true;
    }

    async function ensureAuthorized() {
        if (STATE.authChecked) return STATE.isAuthorized;
        if (!STATE.authPromise) {
            STATE.authPromise = validateUserAccess().finally(() => {
                STATE.authPromise = null;
            });
        }
        return STATE.authPromise;
    }

    function updateAuthStatus() {
        const statusEl = W.document.getElementById("loadout-auth-status");
        if (!statusEl) return;

        if (!getAPIKey()) {
            statusEl.textContent = "Authorization: API key required";
            statusEl.style.color = "#ffb3b3";
            return;
        }

        if (!STATE.authChecked) {
            statusEl.textContent = "Authorization: Not checked";
            statusEl.style.color = "#b9cfe5";
            return;
        }

        if (!STATE.isAuthorized) {
            const factionText = STATE.userInfo?.faction_name ? ` (${STATE.userInfo.faction_name})` : "";
            statusEl.textContent = `Authorization: Denied${factionText}`;
            statusEl.style.color = "#ff8f8f";
            return;
        }

        const factionText = STATE.userInfo?.faction_name ? ` (${STATE.userInfo.faction_name})` : "";
        statusEl.textContent = `Authorization: Allowed${factionText}`;
        statusEl.style.color = "#9fd09c";
    }

    function currentTargetId() {
        return extractUserId(STATE.attackData?.defenderUser);
    }

    function currentTargetName() {
        return extractUserName(STATE.attackData?.defenderUser) || getPageDefenderName() || "Unknown";
    }

    async function getLatestLoadout(targetId) {
        const res = await apiRequest("GET", `/api/loadouts/${encodeURIComponent(targetId)}/latest`, null, { auth: true });
        if (!res.ok || !res.data?.ok || !res.data?.loadout) return null;
        return res.data.loadout;
    }

    async function fetchAndRenderLoadout(force = false) {
        const authorized = await ensureAuthorized();
        updateAuthStatus();
        if (!authorized) return;

        const targetId = currentTargetId();
        if (!targetId) return;

        const row = await getLatestLoadout(targetId);
        if (row?.loadout) {
            renderLoadout(row.loadout, row.inserted_at, force);
        }
    }

    function queryFirst(root, selectors) {
        for (const s of selectors) {
            try {
                const n = root.querySelector(s);
                if (n) return n;
            } catch {}
        }
        return null;
    }

    function getDefenderArea() {
        const marker = queryFirst(W.document, [
            "#defender_Primary",
            "#defender_Secondary",
            "#defender_Melee",
            "#defender_Temporary"
        ]);

        if (marker) {
            const owner = marker.closest("[class*='playerArea'], [class*='player___']");
            if (owner) return owner;
        }

        const areas = W.document.querySelectorAll("[class*='playerArea']");
        return (areas.length > 1 ? areas[1] : areas[0]) || null;
    }

    function buildIconHtml(icon, title, desc) {
        const safeIcon = icon || "blank-bonus-25";
        const tooltip = escapeHtml([title, desc].filter(Boolean).join(" - "));
        return `<div class="container___LAqaj" title="${tooltip}"><i class="bonus-attachment-${safeIcon}" title="${tooltip}"></i></div>`;
    }

    function buildSlotIcons(arr, key, name, desc) {
        return [0, 1].map(i => arr?.[i]
            ? buildIconHtml(arr[i][key], arr[i][name], arr[i][desc])
            : buildIconHtml(null, "", "")
        ).join("");
    }

    const INFINITY_SVG = `<span class="eternity___QmjtV"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="10" viewBox="0 0 17 10"><g><path d="M 12.3399 1.5 C 10.6799 1.5 9.64995 2.76 8.50995 3.95 C 7.35995 2.76 6.33995 1.5 4.66995 1.5 C 2.89995 1.51 1.47995 2.95 1.48995 4.72 C 1.48995 4.81 1.48995 4.91 1.49995 5 C 1.32995 6.76 2.62995 8.32 4.38995 8.49 C 4.47995 8.49 4.57995 8.5 4.66995 8.5 C 6.32995 8.5 7.35995 7.24 8.49995 6.05 C 9.64995 7.24 10.67 8.5 12.33 8.5 C 14.0999 8.49 15.5199 7.05 15.5099 5.28 C 15.5099 5.19 15.5099 5.09 15.4999 5 C 15.6699 3.24 14.3799 1.68 12.6199 1.51 C 12.5299 1.51 12.4299 1.5 12.3399 1.5 Z M 4.66995 7.33 C 3.52995 7.33 2.61995 6.4 2.61995 5.26 C 2.61995 5.17 2.61995 5.09 2.63995 5 C 2.48995 3.87 3.27995 2.84 4.40995 2.69 C 4.49995 2.68 4.57995 2.67 4.66995 2.67 C 6.01995 2.67 6.83995 3.87 7.79995 5 C 6.83995 6.14 6.01995 7.33 4.66995 7.33 Z M 12.3399 7.33 C 10.99 7.33 10.17 6.13 9.20995 5 C 10.17 3.86 10.99 2.67 12.3399 2.67 C 13.48 2.67 14.3899 3.61 14.3899 4.74 C 14.3899 4.83 14.3899 4.91 14.3699 5 C 14.5199 6.13 13.7299 7.16 12.5999 7.31 C 12.5099 7.32 12.4299 7.33 12.3399 7.33 Z" stroke-width="0"></path></g></svg></span>`;

    function renderSlot(wrapper, item, slotLabel, includeLabel = true, slot = 0) {
        if (!wrapper || !item) return;

        wrapper.querySelector(".ll-slot-overlay")?.remove();

        const overlay = wrapper.cloneNode(true);
        overlay.classList.add("ll-slot-overlay");
        overlay.style.cssText += ";position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;box-sizing:border-box;";
        wrapper.style.position = "relative";
        wrapper.appendChild(overlay);
        wrapper = overlay;

        const rarityGlow = {
            yellow: "glow-yellow",
            orange: "glow-orange",
            red: "glow-red"
        };

        const glow = rarityGlow[item.rarity] || "glow-default";
        wrapper.classList.remove(...[...wrapper.classList].filter(c => /^glow-/.test(c)));
        wrapper.classList.add(glow);

        const border = queryFirst(wrapper, ["[class*='itemBorder']"]);
        if (border) border.className = `itemBorder___mJGqQ ${glow}-border`;

        const img = queryFirst(wrapper, ["[class*='weaponImage'] img", "img"]);
        if (img && item.item_id) {
            const base = `https://www.torn.com/images/items/${item.item_id}/large`;
            img.src = `${base}.png`;
            img.srcset = `${base}.png 1x, ${base}@2x.png 2x, ${base}@3x.png 3x, ${base}@4x.png 4x`;
            img.alt = item.item_name || "";
            img.classList.remove("blank___RpGQA");
            img.style.objectFit = "contain";
        }

        const top = queryFirst(wrapper, ["[class*='top___']"]);
        if (top) {
            const modIcons = buildSlotIcons(item.mods, "icon", "name", "description");
            const bonusIcons = buildSlotIcons(item.bonuses, "bonus_key", "name", "description");

            top.innerHTML = includeLabel
                ? `<div class="props___oL_Cw">${modIcons}</div>
                   <div class="topMarker___OjRyU"><span class="markerText___HdlDL">${escapeHtml(slotLabel)}</span></div>
                   <div class="props___oL_Cw">${bonusIcons}</div>`
                : `<div class="props___oL_Cw">${modIcons}</div>
                   <div class="props___oL_Cw">${bonusIcons}</div>`;
        }

        const bottom = queryFirst(wrapper, ["[class*='bottom___']"]);
        if (bottom) {
            const ammoColorKey = (item.ammo_type || "").toLowerCase().replace(/\s+/g, "-");
            const ammoColor = `var(--attack-ammo-color-${ammoColorKey}, #ddd)`;

            const ammoInner = slot === 3
                ? INFINITY_SVG
                : slot === 5
                    ? `<span class="markerText___HdlDL standard___bW8M5">1</span>`
                    : `<span class="markerText___HdlDL" style="color:${ammoColor}">${escapeHtml(item.ammo_type || "Unknown")}</span>`;

            bottom.innerHTML = `
                <div class="props___oL_Cw">
                    <i class="bonus-attachment-item-damage-bonus" aria-label="Damage"></i>
                    <span class="bonusInfo___vyqlT">${formatFixed2(item.damage)}</span>
                </div>
                <div class="bottomMarker___G1uDs">${ammoInner}</div>
                <div class="props___oL_Cw">
                    <i class="bonus-attachment-item-accuracy-bonus" aria-label="Accuracy"></i>
                    <span class="bonusInfo___vyqlT">${formatFixed2(item.accuracy)}</span>
                </div>`;
        }

        let weaponName = wrapper.querySelector(".ll-weapon-name");
        if (!weaponName) {
            weaponName = W.document.createElement("div");
            weaponName.className = "ll-weapon-name";
            weaponName.style.cssText = "position:absolute;top:16px;left:9px;font-size:10px;color:#d7b46a;";
            wrapper.appendChild(weaponName);
        }

        weaponName.textContent = item.item_name || "";
        wrapper.setAttribute("aria-label", item.item_name || "Unknown");
    }

    function renderArmor(defenderArea, loadout) {
        const modelLayers = queryFirst(defenderArea, ["[class*='modelLayers']"]);
        if (!modelLayers) return;

        modelLayers.querySelector(".ll-armor-overlay")?.remove();
        W.document.querySelector(".ll-armor-map")?.remove();

        const armorOverlay = W.document.createElement("div");
        armorOverlay.className = "ll-armor-overlay ll-slot-overlay";
        armorOverlay.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:4;transform:translateY(${IS_PDA ? "10px" : "20px"});`;

        const layerOrder = { 8: 10, 7: 11, 9: 12, 6: 13, 4: 14 };
        const frag = W.document.createDocumentFragment();

        for (const slot of [8, 7, 9, 6, 4]) {
            const item = loadout[slot];
            if (!item) continue;

            const container = W.document.createElement("div");
            container.className = "armourContainer___zL52C";
            container.style.zIndex = String(layerOrder[slot]);

            const armor = W.document.createElement("div");
            armor.className = "armour___fLnYY";

            const img = W.document.createElement("img");
            img.className = "itemImg___B8FMH";
            img.src = `https://www.torn.com/images/v2/items/model-items/${item.item_id}m.png`;
            img.alt = "";

            armor.appendChild(img);
            container.appendChild(armor);
            frag.appendChild(container);
        }

        armorOverlay.appendChild(frag);
        modelLayers.appendChild(armorOverlay);

        const bodyImg = queryFirst(defenderArea, ["[class*='bodyImage']", "img[src*='model']"]);
        if (!bodyImg) return;

        const MAP_NAME = "ll-armor-map";
        const slotAreas = {
            4: [{ coords: "119,79,99,73,80,96,62,131,54,150,52,167,62,169,79,138,91,118,99,142,95,159,143,161,144,143,148,118,162,141,174,166,187,165,176,129,162,95,140,75" }],
            6: [{ coords: "118,77,104,67,99,52,104,36,118,26,132,32,136,51,133,69" }],
            7: [{ coords: "94,162,145,162,157,204,154,239,150,261,156,275,150,301,136,303,131,283,121,209,109,284,105,300,89,299,85,276,87,257,84,236,85,201" }],
            8: [
                { coords: "87,300,89,322,86,336,78,349,88,354,99,354,104,340,106,325,105,302" },
                { coords: "136,304,153,300,151,318,153,330,160,343,153,352,138,353,132,330" }
            ],
            9: [
                { coords: "48,203,55,192,62,195,67,192,61,172,50,169,44,183,40,203" },
                { coords: "175,171,189,170,196,185,198,200,191,202,184,191,177,196,176,180" }
            ]
        };

        const map = W.document.createElement("map");
        map.name = MAP_NAME;
        map.className = "ll-armor-map ll-slot-overlay";

        for (const slot of [4, 6, 7, 8, 9]) {
            const item = loadout[slot];
            if (!item || !slotAreas[slot]) continue;

            for (const { coords } of slotAreas[slot]) {
                const area = W.document.createElement("area");
                area.shape = "poly";
                area.coords = coords;
                area.alt = item.item_name || "";
                area.title = item.item_name || "";
                map.appendChild(area);
            }
        }

        bodyImg.parentNode.appendChild(map);
        bodyImg.setAttribute("usemap", `#${MAP_NAME}`);
    }

    function renderLoadout(loadout, inserted, force = false) {
        if (!loadout || (STATE.loadoutRendered && !force) || STATE.attackData?.fightID) return;

        waitForElement("#defender_Primary, #defender_Secondary, #defender_Melee, #defender_Temporary, #attacker_Primary, [class*='playerArea']", () => {
            const defenderArea = getDefenderArea();
            if (!defenderArea) return;

            cleanupScriptOverlays();

            const hasDefender = !!defenderArea.querySelector("#defender_Primary");
            const hasAttacker = !!defenderArea.querySelector("#attacker_Primary");
            const includeLabel = hasDefender || hasAttacker;

            const slotMappings = [
                { selector: hasDefender ? "#defender_Primary"   : hasAttacker ? "#attacker_Primary"   : "#weapon_main",   slot: 1, label: "Primary" },
                { selector: hasDefender ? "#defender_Secondary" : hasAttacker ? "#attacker_Secondary" : "#weapon_second", slot: 2, label: "Secondary" },
                { selector: hasDefender ? "#defender_Melee"     : hasAttacker ? "#attacker_Melee"     : "#weapon_melee",  slot: 3, label: "Melee" },
                { selector: hasDefender ? "#defender_Temporary" : hasAttacker ? "#attacker_Temporary" : "#weapon_temp",   slot: 5, label: "Temporary" }
            ];

            for (const { selector, slot, label } of slotMappings) {
                const marker = defenderArea.querySelector(selector);
                const wrapper = marker?.closest("[class*='weaponWrapper'], [class*='weapon']");
                if (wrapper && loadout[slot]) {
                    renderSlot(wrapper, loadout[slot], label, includeLabel, slot);
                }
            }

            renderArmor(defenderArea, loadout);

            const modal = queryFirst(defenderArea, ["[class*='modal']"]);
            if (modal) {
                modal.style.background = "transparent";
                modal.style.backdropFilter = "none";
                modal.style.webkitBackdropFilter = "none";
                modal.style.pointerEvents = "none";
            }

            if (inserted) {
                const stamp = W.document.getElementById("loadout-timestamp");
                if (stamp) {
                    const timeMs = new Date(inserted).getTime();
                    stamp.textContent = `Saved: ${Number.isFinite(timeMs) ? relativeTime(Date.now() - timeMs) : inserted}`;
                    stamp.style.display = "inline-flex";
                }
            }

            STATE.loadoutRendered = true;
        });
    }

    async function reportLoadout(raw) {
        const authorized = await ensureAuthorized();
        updateAuthStatus();
        if (!authorized) return;

        const attackerId = extractUserId(raw?.attackerUser);
        const defenderId = extractUserId(raw?.defenderUser);
        const attackerName = extractUserName(raw?.attackerUser) || getPageAttackerName();
        const defenderName = extractUserName(raw?.defenderUser) || getPageDefenderName();
        const defenderFactionId = raw?.defenderUser?.factionID ?? null;
        const loadout = extractLoadoutFromAttackData(raw);

        if (!attackerId || !defenderId || !loadout) {
            return;
        }

        const payload = {
            defender_id: defenderId,
            attacker_id: attackerId,
            defender_name: defenderName,
            attacker_name: attackerName,
            defender_faction_id: defenderFactionId,
            loadout
        };

        const res = await apiRequest("POST", "/api/loadouts/report", payload, { auth: true });

        if (res.ok && res.data?.ok) {
            toastInfo("Loadout saved to the war chest.");
        } else if (res.status === 401) {
            resetAuthorizationState();
            toast("Backend session expired. Save your API key again.");
        } else {
            toast(res.data?.error || "Failed to save defender loadout.");
        }
    }

    async function fetchHistoryForCurrentTarget() {
        const authorized = await ensureAuthorized();
        updateAuthStatus();
        if (!authorized) return [];

        const targetId = currentTargetId();
        if (!targetId) {
            toast("No defender detected on this page.", 4000);
            return [];
        }

        const res = await apiRequest("GET", `/api/loadouts/${encodeURIComponent(targetId)}/history?limit=${CFG.historyLimit}`, null, { auth: true });
        if (!res.ok || !res.data?.ok || !Array.isArray(res.data.history)) return [];
        return res.data.history;
    }

    function closeHistoryModal() {
        const modal = W.document.getElementById("loadout-history-modal");
        if (modal) modal.remove();
        STATE.historyOpen = false;
    }

    function askeladsButtonStyle(kind = "gold") {
        const styles = {
            gold: "padding:7px 10px;border:1px solid rgba(191,145,63,0.35);border-radius:10px;background:linear-gradient(180deg,#4f3a17,#2d2010);color:#f4e7c2;cursor:pointer;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,0.06);",
            green: "padding:7px 10px;border:1px solid rgba(91,135,84,0.35);border-radius:10px;background:linear-gradient(180deg,#294126,#182718);color:#d9f0d4;cursor:pointer;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);",
            red: "padding:7px 10px;border:1px solid rgba(140,54,54,0.35);border-radius:10px;background:linear-gradient(180deg,#4a1f1f,#291212);color:#ffd6d6;cursor:pointer;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);",
            steel: "padding:7px 10px;border:1px solid rgba(130,130,130,0.22);border-radius:10px;background:linear-gradient(180deg,#2a2d31,#181a1d);color:#e7e7e7;cursor:pointer;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,0.04);",
            bright: "padding:7px 10px;border:1px solid rgba(191,145,63,0.42);border-radius:10px;background:linear-gradient(180deg,#7b5a24,#4f3815);color:#fff3d4;cursor:pointer;font-weight:800;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08);"
        };
        return styles[kind] || styles.gold;
    }

    function getApiKeyHelpHtml() {
        return `
            <div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(191,145,63,0.15);color:#d7cfbf;font-size:11px;line-height:1.45;">
                This tool uses your <b style="color:#f4e7c2;">Torn Public API key</b> only to identify your player and faction and authenticate with the Askelads backend.
                It does <b>not</b> require full-access account data.
                You can create or revoke a public key any time in Torn settings.
            </div>
        `;
    }

    async function showHistoryModal() {
        if (STATE.historyOpen) {
            closeHistoryModal();
            return;
        }

        const targetId = currentTargetId();
        const targetName = currentTargetName();

        if (!targetId) {
            toast("No defender detected on this page.", 4000);
            return;
        }

        STATE.historyOpen = true;

        const overlay = W.document.createElement("div");
        overlay.id = "loadout-history-modal";
        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(0,0,0,0.62)",
            "z-index:2147483647",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "padding:18px"
        ].join(";");

        const card = W.document.createElement("div");
        card.style.cssText = [
            "width:min(560px, 96vw)",
            "max-height:80vh",
            "overflow:hidden",
            "display:flex",
            "flex-direction:column",
            "background:linear-gradient(180deg, rgba(23,19,16,0.985), rgba(12,10,8,0.985))",
            "border:1px solid rgba(191,145,63,0.22)",
            "border-radius:14px",
            "box-shadow:0 18px 38px rgba(0,0,0,0.5)",
            "color:#f1e6c9"
        ].join(";");

        const header = W.document.createElement("div");
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:14px 14px 10px 14px;border-bottom:1px solid rgba(191,145,63,0.12);";
        header.innerHTML = `
            <div>
                <div style="font-weight:800;font-size:15px;color:#f4e7c2;letter-spacing:.3px;">War Chest History</div>
                <div style="font-size:12px;color:#c9b892;">${escapeHtml(targetName)} [${escapeHtml(targetId)}]</div>
            </div>
        `;

        const closeBtn = W.document.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.style.cssText = askeladsButtonStyle("red");
        closeBtn.onclick = closeHistoryModal;
        header.appendChild(closeBtn);

        const body = W.document.createElement("div");
        body.style.cssText = "padding:12px;overflow:auto;display:flex;flex-direction:column;gap:8px;";
        body.innerHTML = `<div style="color:#c9b892;font-size:12px;">Loading history...</div>`;

        card.appendChild(header);
        card.appendChild(body);
        overlay.appendChild(card);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeHistoryModal();
        });

        W.document.body.appendChild(overlay);

        const rows = await fetchHistoryForCurrentTarget();

        if (!STATE.historyOpen) return;
        body.innerHTML = "";

        if (!rows.length) {
            body.innerHTML = `<div style="color:#c9b892;font-size:12px;">No history found for this defender yet.</div>`;
            return;
        }

        rows.forEach((row, index) => {
            const item = W.document.createElement("div");
            item.style.cssText = [
                "border:1px solid rgba(191,145,63,0.12)",
                "background:rgba(255,255,255,0.03)",
                "border-radius:10px",
                "padding:10px",
                "display:flex",
                "align-items:center",
                "justify-content:space-between",
                "gap:10px"
            ].join(";");

            const observedAt = row?.observed_at || "";
            const timeMs = new Date(observedAt).getTime();
            const timeText = Number.isFinite(timeMs) ? relativeTime(Date.now() - timeMs) : observedAt;

            const meta = W.document.createElement("div");
            meta.innerHTML = `
                <div style="font-weight:700;font-size:12px;color:#f4e7c2;">Snapshot #${index + 1}</div>
                <div style="font-size:11px;color:#c9b892;">${escapeHtml(timeText)}</div>
                <div style="font-size:11px;color:#a99a82;">Observed at: ${escapeHtml(observedAt)}</div>
                <div style="font-size:11px;color:#a99a82;">Defender faction: ${escapeHtml(row?.defender_faction_id ?? "Unknown")}</div>
            `;

            const actions = W.document.createElement("div");
            actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;";

            const renderBtn = W.document.createElement("button");
            renderBtn.textContent = "Render";
            renderBtn.style.cssText = askeladsButtonStyle("gold");
            renderBtn.onclick = () => {
                STATE.loadoutRendered = false;
                renderLoadout(row.loadout, row.observed_at, true);
                closeHistoryModal();
            };

            const jsonBtn = W.document.createElement("button");
            jsonBtn.textContent = "JSON";
            jsonBtn.style.cssText = askeladsButtonStyle("steel");
            jsonBtn.onclick = () => {
                W.prompt("Loadout JSON", JSON.stringify(row.loadout, null, 2));
            };

            actions.appendChild(renderBtn);
            actions.appendChild(jsonBtn);

            item.appendChild(meta);
            item.appendChild(actions);
            body.appendChild(item);
        });
    }

    function openTornPublicApiKeyPage() {
        W.open("https://www.torn.com/preferences.php#tab=api", "_blank", "noopener,noreferrer");
    }

    function createPanel() {
        const host = W.document.createElement("div");
        host.id = "loadout-panel";
        host.style.cssText = [
            "position:relative",
            "display:inline-flex",
            "align-items:center",
            "gap:8px",
            "font:12px/1.3 'Segoe UI',Tahoma,sans-serif",
            "margin-left:8px"
        ].join(";");

        const btn = W.document.createElement("button");
        btn.textContent = "⚔ Askelads";
        btn.style.cssText = [
            "border:1px solid rgba(191,145,63,0.35)",
            "background:linear-gradient(180deg,#3f2d14,#24190d)",
            "color:#f4e7c2",
            "padding:0 12px",
            "border-radius:10px",
            "cursor:pointer",
            "font:11px/1.2 'Segoe UI',Tahoma,sans-serif",
            "font-weight:800",
            "height:32px",
            "box-sizing:border-box",
            "letter-spacing:.3px",
            "box-shadow:0 6px 14px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)"
        ].join(";");

        const panel = W.document.createElement("div");
        panel.id = "loadout-panel-inner";
        panel.style.cssText = [
            "display:none",
            "position:absolute",
            "top:calc(100% + 6px)",
            "left:100%",
            "transform:translateX(-100%)",
            "width:390px",
            "z-index:2147483647",
            "border:1px solid rgba(191,145,63,0.22)",
            "background:linear-gradient(180deg, rgba(23,19,16,0.985), rgba(12,10,8,0.985))",
            "color:#f1e6c9",
            "padding:12px",
            "border-radius:14px",
            "box-shadow:0 18px 38px rgba(0,0,0,0.5)"
        ].join(";");

        const savedKey = getAPIKey();

        const pdaKeyControls = IS_PDA
            ? `<div style="margin-bottom:8px;color:#9fd09c;font-size:11px;">Torn-PDA detected. API key is loaded automatically.</div>
               ${getApiKeyHelpHtml()}`
            : `<div style="margin-bottom:5px;color:#d7b46a;font-size:11px;font-weight:700;letter-spacing:.25px;text-transform:uppercase;">Torn Public API Key</div>
               <input id="loadout-key-input" type="password" placeholder="Enter your Torn public API key" value="${escapeHtml(savedKey)}"
                 style="width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(191,145,63,0.18);background:rgba(7,7,7,0.45);color:#f4e7c2;margin-bottom:9px;box-sizing:border-box;outline:none;">

               <div style="display:flex;gap:6px;flex-wrap:wrap;">
                 <button id="loadout-save-btn" style="${askeladsButtonStyle("bright")}">Save Key</button>
                 <button id="loadout-clear-btn" style="${askeladsButtonStyle("red")}">Clear Key</button>
                 <button id="loadout-create-public-key-btn" style="${askeladsButtonStyle(savedKey ? "steel" : "green")}">
                   ${savedKey ? "Open API Settings" : "Create Public Key"}
                 </button>
               </div>

               ${getApiKeyHelpHtml()}`
        ;

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                <div>
                    <div style="font-weight:800;font-size:16px;color:#f4e7c2;letter-spacing:.35px;">Askelads Loadout</div>
                    <div style="font-size:11px;color:#b8a786;">War-room viewer and recorder</div>
                </div>
                <div style="font-size:11px;color:#8f836f;">v${SCRIPT_VERSION}</div>
            </div>

            ${pdaKeyControls}

            <label style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;color:#d8ceb9;font-size:12px;">
                <input id="loadout-quiet-chk" type="checkbox" ${getLocalStorage(CFG.store.quietToasts) === "1" ? "checked" : ""}>
                Quiet mode
            </label>

            <div id="loadout-auth-status" style="margin-top:10px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(191,145,63,0.12);color:#c9b892;font-size:11px;">
                Authorization: Not checked
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
                <button id="loadout-show-history-btn" style="${askeladsButtonStyle("gold")}">History</button>
                <button id="loadout-show-latest-btn" style="${askeladsButtonStyle("green")}">Show Latest</button>
            </div>

            <div style="margin-top:10px;color:#877964;font-size:10px;">
                Askelads backend active
            </div>
        `;

        const stamp = W.document.createElement("span");
        stamp.id = "loadout-timestamp";
        stamp.style.cssText = [
            "display:none",
            "align-items:center",
            "height:32px",
            "padding:0 10px",
            "border-radius:8px",
            "border:1px solid rgba(191,145,63,0.18)",
            "background:rgba(16,13,10,0.72)",
            "color:#d7c093",
            "font-size:11px",
            "white-space:nowrap"
        ].join(";");

        let panelOpen = false;
        btn.onclick = (e) => {
            e.stopPropagation();
            panelOpen = !panelOpen;
            panel.style.display = panelOpen ? "block" : "none";
        };

        W.document.addEventListener("click", (e) => {
            if (panelOpen && !host.contains(e.target)) {
                panelOpen = false;
                panel.style.display = "none";
            }
        });

        panel.querySelector("#loadout-quiet-chk").onchange = (e) => {
            setLocalStorage(CFG.store.quietToasts, e.target.checked ? "1" : "0");
        };

        panel.querySelector("#loadout-show-history-btn").onclick = () => {
            showHistoryModal();
        };

        panel.querySelector("#loadout-show-latest-btn").onclick = () => {
            fetchAndRenderLoadout(true);
        };

        if (!IS_PDA) {
            const input = panel.querySelector("#loadout-key-input");

            panel.querySelector("#loadout-save-btn").onclick = async () => {
                const key = input.value.trim();
                if (!key) {
                    toast("Please enter a key.");
                    return;
                }

                setLocalStorage(CFG.store.apiKey, key);
                resetAuthorizationState();

                const ok = await ensureAuthorized();
                updateAuthStatus();

                if (ok) {
                    toastInfo("Key saved. Welcome back to the war room.");
                    fetchAndRenderLoadout(true);
                }
            };

            panel.querySelector("#loadout-clear-btn").onclick = () => {
                input.value = "";
                setLocalStorage(CFG.store.apiKey, "");
                resetAuthorizationState();
                updateAuthStatus();
                toastInfo("API key cleared.");
            };

            panel.querySelector("#loadout-create-public-key-btn").onclick = () => {
                openTornPublicApiKeyPage();
                toastInfo("Opened Torn API settings.");
            };
        }

        const toastHost = W.document.createElement("div");
        toastHost.id = "loadout-toast-host";
        toastHost.style.cssText = [
            "position:fixed",
            "top:14px",
            "right:14px",
            "z-index:2147483647",
            "display:flex",
            "flex-direction:column",
            "gap:8px",
            "max-width:320px"
        ].join(";");

        host.appendChild(btn);
        host.appendChild(panel);
        host.appendChild(stamp);

        return { host, panel, toastHost };
    }

    async function testBackendAuth() {
        resetAuthorizationState();
        const ok = await ensureAuthorized();
        updateAuthStatus();
        toast(ok ? "Backend auth successful." : "Backend auth failed.");
        return ok;
    }

    W.testBackendAuth = testBackendAuth;

    async function testBackendLatest() {
        const targetId = currentTargetId();
        if (!targetId) {
            toast("No defender detected.");
            return null;
        }
        return apiRequest("GET", `/api/loadouts/${encodeURIComponent(targetId)}/latest`, null, { auth: true });
    }

    W.testBackendLatest = testBackendLatest;

    async function testBackendHistory() {
        const targetId = currentTargetId();
        if (!targetId) {
            toast("No defender detected.");
            return null;
        }
        return apiRequest("GET", `/api/loadouts/${encodeURIComponent(targetId)}/history?limit=5`, null, { auth: true });
    }

    W.testBackendHistory = testBackendHistory;

    function hasNativeDefenderLoadout(defenderItems) {
        if (!defenderItems || typeof defenderItems !== "object") return false;
        return Object.values(defenderItems).some(slot => {
            const raw = slot?.item?.[0] || slot?.item || slot?.weapon || slot;
            return !!extractItemId(raw);
        });
    }

    function processResponse(data) {
        if (!data || typeof data !== "object") return;
        if (!data.attackerUser && !data.DB?.attackerUser) return;

        const db = data.DB || data;
        const newDefenderId = extractUserId(db?.defenderUser);
        const oldDefenderId = extractUserId(STATE.attackData?.defenderUser);
        const hadFightID = !!STATE.attackData?.fightID;
        const isFirstData = !STATE.attackData;

        if (newDefenderId && oldDefenderId && newDefenderId !== oldDefenderId) {
            resetAttackState();
        }

        STATE.attackData = db;

        if (!hadFightID && db.fightID) {
            cleanupScriptOverlays();
        }

        if (hasNativeDefenderLoadout(db?.defenderItems) && !STATE.uploaded) {
            STATE.uploaded = true;
            whenVisible(() => reportLoadout(db));
        } else if (isFirstData) {
            fetchAndRenderLoadout(true);
        }
    }

    if (typeof W.fetch === "function" && !W.__askeladsLoadoutFetchPatched) {
        W.__askeladsLoadoutFetchPatched = true;
        const origFetch = W.fetch;

        W.fetch = async function (...args) {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
            if (!url.includes("sid=attackData")) {
                return origFetch.apply(this, args);
            }

            const response = await origFetch.apply(this, args);
            try {
                response.clone().text().then(text => {
                    const parsed = parseJson(text);
                    processResponse(parsed);
                });
            } catch {}
            return response;
        };
    }

    function initPanel() {
        if (W.document.getElementById("loadout-panel")) return true;

        const labelsContainer = W.document.querySelector("[class*='labelsContainer']");
        if (!labelsContainer) return false;

        const { host, panel, toastHost } = createPanel();
        labelsContainer.insertBefore(host, labelsContainer.firstChild);
        W.document.body.appendChild(toastHost);

        const apiKey = getAPIKey();
        if (!apiKey) {
            panel.style.display = "block";
            toast("Enter your Public API key to join the war room.");
        } else {
            ensureAuthorized().then(updateAuthStatus);
        }

        updateAuthStatus();
        return true;
    }

    const startPanelInit = () => {
        if (!initPanel()) {
            waitForElement("[class*='players___eKiHL'], [class*='labelsContainer']", () => initPanel());
        }
    };

    if (W.document.readyState === "loading") {
        W.document.addEventListener("DOMContentLoaded", startPanelInit, { once: true });
    } else {
        startPanelInit();
    }
})();
