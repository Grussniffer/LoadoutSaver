// ==UserScript==
// @name         Loadout Aggregator
// @namespace    loadout.loader
// @version      2.2.0
// @description  Captures Torn attack data and renders saved loadouts.
// @author       Modified
// @match        https://www.torn.com/loader.php?sid=attack&user2ID=*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      supabase.grusmedia.no
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const SCRIPT_VERSION = "2.1.0";
    const PDA_KEY = "###PDA-APIKEY###";
    const IS_PDA = !PDA_KEY.includes("#");
const CFG = {
    supabaseUrl: "https://supabase.grusmedia.no:444",
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTc0OTU5MzQ2NiwiZXhwIjoyMDY0OTUzNDY2fQ.Eq_oqn_miVnHoQGO1gbZJQgmonJRAxv7NQRgoWg5Z_Q",
    store: {
        apiKey: "sr_loadout_api_key",
        quietToasts: "sr_loadout_quiet_mode"
    }
};

    const STATE = { uploaded: false, loadoutRendered: false, attackData: null};

    /* Helpers */

    function getLocalStorage(key) { try { return localStorage.getItem(key); } catch { return null; } }
    function setLocalStorage(key, v) { try { localStorage.setItem(key, v); } catch {} }
    function getAPIKey() {
        return IS_PDA ? PDA_KEY : getLocalStorage(CFG.store.apiKey);
    }
    function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
    function escapeHtml(v) {
        return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    }
    function formatFixed2(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(2) : "-";
    }
    function whenVisible(fn) {
        if (W.document.visibilityState === "visible") { fn(); return; }
        const handler = () => {
            if (W.document.visibilityState !== "visible") return;
            W.document.removeEventListener("visibilitychange", handler);
            fn();
        };
        W.document.addEventListener("visibilitychange", handler);
    }
    function relativeTime(ms) {
        const mins = Math.floor(ms / 60000);
        const hrs  = Math.floor(ms / 3600000);
        const days = Math.floor(ms / 86400000);
        const wks  = Math.floor(days / 7);
        const mths = Math.floor(days / 30);
        const fmt = (n, u) => `${n} ${u}${n > 1 ? "s" : ""} ago`;
        return mths >= 1 ? fmt(mths, "month") : wks  >= 1 ? fmt(wks, "week")
            : days >= 1 ? fmt(days, "day")   : hrs  >= 1 ? fmt(hrs, "hour")
                : mins >= 1 ? fmt(mins, "minute") : "just now";
    }



    /* API */
function supabaseHeaders(extra = {}) {
    return {
        apikey: CFG.supabaseAnonKey,
        Authorization: `Bearer ${CFG.supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...extra,
    };
}

function supabaseRequest(method, path, body, extraHeaders = {}) {
    const url = `${CFG.supabaseUrl}/rest/v1${path}`;

    const bridge = W.flutter_inappwebview;
    if (bridge?.callHandler) {
        const headers = supabaseHeaders(extraHeaders);
        const handler = method === "GET" ? "PDA_httpGet" : "PDA_httpPost";
        const call = method === "GET"
            ? bridge.callHandler(handler, url, headers)
            : bridge.callHandler(handler, url, headers, body ? JSON.stringify(body) : "");

        return call
            .then(r => ({
                ok: Number(r?.status || 0) >= 200 && Number(r?.status || 0) < 300,
                status: Number(r?.status || 0),
                data: parseJson(String(r?.responseText || "")),
            }))
            .catch(() => ({ ok: false, status: 0, data: null }));
    }

    if (typeof GM_xmlhttpRequest === "function") {
        return new Promise((resolve) => {
            const headers = supabaseHeaders(extraHeaders);
            const req = {
                method,
                url,
                headers,
                ...(body ? { data: JSON.stringify(body) } : {}),
                onload: (r) => resolve({
                    ok: r.status >= 200 && r.status < 300,
                    status: r.status,
                    data: parseJson(r.responseText),
                }),
                onerror: () => resolve({ ok: false, status: 0, data: null }),
                ontimeout: () => resolve({ ok: false, status: 0, data: null }),
            };
            GM_xmlhttpRequest(req);
        });
    }

    return W.fetch(url, {
        method,
        headers: supabaseHeaders(extraHeaders),
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
        .then(async (r) => ({
            ok: r.ok,
            status: r.status,
            data: parseJson(await r.text()),
        }))
        .catch(() => ({ ok: false, status: 0, data: null }));
}

    /* UI */
    function normalizeMods(mods) {
    if (!Array.isArray(mods)) return [];
    return mods.map(m => ({
        icon: m?.icon || m?.key || m?.type || null,
        name: m?.name || m?.title || "",
        description: m?.description || m?.desc || "",
    }));
}


function normalizeBonuses(bonuses) {
    if (!Array.isArray(bonuses)) return [];
    return bonuses.map(b => ({
        bonus_key: b?.bonus_key || b?.key || b?.icon || null,
        name: b?.name || b?.title || "",
        description: b?.description || b?.desc || "",
    }));
}

function extractSlotItem(slotData) {
    if (!slotData) return null;

    const raw =
        slotData?.item?.[0] ||
        slotData?.item ||
        slotData?.weapon ||
        slotData;

    if (!raw) return null;

    const itemId = raw?.ID ?? raw?.id ?? raw?.item_id ?? raw?.itemID;
    if (!itemId) return null;

    return {
        item_id: itemId,
        item_name: raw?.name || raw?.item_name || raw?.itemName || "Unknown",
        damage: raw?.damage ?? raw?.Damage ?? raw?.displayDamage ?? null,
        accuracy: raw?.accuracy ?? raw?.Accuracy ?? raw?.displayAccuracy ?? null,
        rarity: String(raw?.rarity || raw?.Rarity || "").toLowerCase(),
        mods: normalizeMods(slotData?.mods || raw?.mods || raw?.attachments || []),
        bonuses: normalizeBonuses(slotData?.bonuses || raw?.bonuses || []),
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
    function toast(message, duration = 10000) {
        const host = W.document.getElementById("sr-toast-host");
        if (!host) return;
        const el = W.document.createElement("div");
        el.style.cssText = [
            "background:rgba(20,24,33,0.94)", "color:#fff",
            "border:1px solid rgba(255,255,255,0.12)", "border-left:4px solid #ff6b6b",
            "padding:10px 12px", "border-radius:10px",
            "font:13px/1.35 'Segoe UI',Tahoma,sans-serif",
            "box-shadow:0 10px 26px rgba(0,0,0,0.35)",
        ].join(";");
        el.innerHTML = `
            <div style="font-weight:700;font-size:11px;color:#a0bcd8;margin-bottom:4px;">S&R Loadout Aggregator</div>
            <div>${escapeHtml(message)}</div>`;
        host.appendChild(el);
        W.setTimeout(() => el.remove(), duration);
    }

    function toastInfo(message, duration = 2500) {
        if (getLocalStorage(CFG.store.quietToasts) === "1") return;
        toast(message, duration);
    }

    const API_ERRORS = {
        1: "Invalid Torn API Key",
        2: "That is not your API Key",
        3: "You are already registered",
        4: "Please add your API Key",
        5: "Invalid data sent to the server",
        6: "This script has expired, please update now",
        7: "Your licence has expired. Send Lord_Rhino Xanax to extend it!",
        8: "You have been blacklisted from this service",
        9: "An unknown item or bonus was uploaded",
    };
    function toastErr(data) {
        const err = data?.error;
        toast(API_ERRORS[err?.code] || err?.message || "Unknown error.");
    }

    function updateBlacklistedDisplay() {
        const panel = W.document.getElementById("sr-loadout-panel-inner");
        if (panel) panel.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;">
                <div style="font-size:14px;">&#9888;&#65039; You have been blacklisted from this service</div>
            </div>`;
    }

    function updateLicenceDisplay(licence) {
        const el = W.document.getElementById("sr-licence-info");
        if (!el) return;

        if (!licence || new Date(licence.expires) < new Date()) {
            const panel = W.document.getElementById("sr-loadout-panel-inner");
            if (panel) panel.innerHTML = `
                <div style="font-weight:700;margin-bottom:8px;">Your licence has expired!</div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <div>You can extend it for 1 Xanax / 15 Days.</div>
                    <div>Send Xanax directly to <a href="https://www.torn.com/profiles.php?XID=2632894" target="_blank" style="color:#5aabff;">Lord_Rhino</a> with message: <strong>SRLA</strong></div>
                    <div>Xanax can be sent in bulk and the process is automated and payments are recognised within a minute.</div>
                    <div>Do not send by trade or in parcels!</div>
                </div>`;
            return;
        }

        const expires = new Date(licence.expires);
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() + 100);

        let expiryStr;
        if (expires > cutoff) {
            expiryStr = "Never";
        } else {
            const diffMs = expires - Date.now();
            const days = Math.floor(diffMs / 86400000);
            const hours = Math.floor((diffMs % 86400000) / 3600000);
            expiryStr = `in ${days}d ${hours}h`;
        }
        el.textContent = `Licence: ${licence.type || "standard"} | Expires: ${expiryStr}`;
    }

    function createPanel() {
        const host = W.document.createElement("div");
        host.id = "sr-loadout-panel";
        host.style.cssText = [
            "position:relative", "display:inline-flex", "align-items:center", "gap:8px",
            "font:12px/1.3 'Segoe UI',Tahoma,sans-serif", "margin-left:8px",
        ].join(";");

        const btn = W.document.createElement("button");
        btn.textContent = "S&R Settings";
        btn.style.cssText = [
            "border:1px solid rgba(255,255,255,0.16)", "background:rgba(15,23,34,0.96)",
            "color:#dfefff", "padding:0 10px", "border-radius:8px", "cursor:pointer",
            "font:11px/1.2 'Segoe UI',Tahoma,sans-serif", "font-weight:700",
            "height:30px", "box-sizing:border-box",
        ].join(";");

        const panel = W.document.createElement("div");
        panel.id = "sr-loadout-panel-inner";
        panel.style.cssText = [
            "display:none", "position:absolute", "top:calc(100% + 4px)", "left:100%", "transform:translateX(-100%)",
            "width:320px", "z-index:2147483647",
            "border:1px solid rgba(255,255,255,0.16)", "background:rgba(10,16,24,0.97)",
            "color:#dfefff", "padding:10px", "border-radius:10px",
            "box-shadow:0 10px 26px rgba(0,0,0,0.35)",
        ].join(";");

        const pdaKeyControls = IS_PDA
            ? `<div style="margin-bottom:6px;color:#7bcf9a;font-size:11px;">Torn-PDA detected. API key is loaded automatically.</div>`
            : `<div style="margin-bottom:4px;color:#b9cfe5;">Torn API Key (Public)</div>
               <input id="sr-key-input" type="password" placeholder="Enter your Torn API key" value="${escapeHtml(getAPIKey())}"
                 style="width:100%;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:rgba(2,8,14,0.94);color:#eaf4ff;margin-bottom:8px;box-sizing:border-box;">
               <div style="display:flex;gap:6px;">
                 <button id="sr-save-btn" style="padding:6px 9px;border:none;border-radius:8px;background:#1e7cdd;color:#fff;cursor:pointer;">Save Key</button>
                 <button id="sr-clear-btn" style="padding:6px 9px;border:none;border-radius:8px;background:#6c3f7e;color:#fff;cursor:pointer;">Clear Key</button>
               </div>`;

        panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px;">S&R Loadout Aggregator - Settings</div>
            ${pdaKeyControls}
            <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;color:#b9cfe5;font-size:12px;">
                <input id="sr-quiet-chk" type="checkbox" ${getLocalStorage(CFG.store.quietToasts) === "1" ? "checked" : ""}>
                Quiet mode (hide routine alerts)
            </label>
            <div style="margin-top:10px;color:#6a8aaa;font-size:10px;">Backend: Supabase</div>`;

        const stamp = W.document.createElement("span");
        stamp.id = "sr-loadout-timestamp";
        stamp.style.cssText = [
            "display:none", "align-items:center", "height:30px",
            "padding:0 10px", "border-radius:6px",
            "border:1px solid rgba(255,255,255,0.12)", "background:rgba(0,0,0,0.22)",
            "color:#d7d7d7", "font-size:11px", "white-space:nowrap",
        ].join(";");

        btn.onclick = () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; };
        panel.querySelector("#sr-quiet-chk").onchange = (e) => setLocalStorage(CFG.store.quietToasts, e.target.checked ? "1" : "0");

        if (!IS_PDA) {
            const input = panel.querySelector("#sr-key-input");
            panel.querySelector("#sr-save-btn").onclick = async () => {
                const key = input.value.trim();
                if (!key) { toast("Please enter a key.", 5000); return; }
                setLocalStorage(CFG.store.apiKey, key);
                toastInfo("API key saved.");
                fetchAndRenderLoadout();
            };
            panel.querySelector("#sr-clear-btn").onclick = () => {
                input.value = "";
                setLocalStorage(CFG.store.apiKey, "");
                toastInfo("API Key cleared.");
            };
        }

        const toastHost = W.document.createElement("div");
        toastHost.id = "sr-toast-host";
        toastHost.style.cssText = [
            "position:fixed", "top:14px", "right:14px", "z-index:2147483647",
            "display:flex", "flex-direction:column", "gap:8px", "max-width:320px",
        ].join(";");

        host.appendChild(btn);
        host.appendChild(panel);
        host.appendChild(stamp);

        return { host, panel, toastHost };
    }

    /* Fetch & Render Loadout */
async function fetchAndRenderLoadout() {
    const targetId = STATE.attackData?.defenderUser?.userID;
    if (!targetId) return;

    const res = await supabaseRequest(
        "GET",
        `/sr_loadouts?defender_id=eq.${encodeURIComponent(targetId)}&select=loadout,inserted_at&limit=1`
    );

    if (!res.ok || !Array.isArray(res.data) || !res.data.length) return;

    const row = res.data[0];
    if (row?.loadout) {
        renderLoadout(row.loadout, row.inserted_at);
    }
}

    /* Rendering */
    function queryFirst(root, selectors) {
        for (const s of selectors) {
            try { const n = root.querySelector(s); if (n) return n; } catch {}
        }
        return null;
    }

    function getDefenderArea() {
        const marker = queryFirst(W.document, ["#defender_Primary", "#defender_Secondary", "#defender_Melee", "#defender_Temporary"]);
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

        const rarityGlow = { yellow: "glow-yellow", orange: "glow-orange", red: "glow-red" };
        const glow = rarityGlow[item.rarity] || "glow-default";
        wrapper.className = wrapper.className.split(/\s+/).filter(c => c && !/^glow-/.test(c)).join(" ");
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
            const ammoInner = slot === 3 ? INFINITY_SVG
                : slot === 5 ? `<span class="markerText___HdlDL standard___bW8M5">1</span>`
                    : `<span class="markerText___HdlDL">Unknown</span>`;
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

        let xp = wrapper.querySelector(".tt-weapon-experience");
        if (!xp) {
            xp = W.document.createElement("div");
            xp.className = "tt-weapon-experience";
            wrapper.appendChild(xp);
        }
        xp.textContent = item.item_name || "";
        wrapper.setAttribute("aria-label", item.item_name || "Unknown");
    }

    function renderArmor(defenderArea, loadout) {
        const modelLayers = queryFirst(defenderArea, ["[class*='modelLayers']"]);
        const armorWrap = modelLayers ? queryFirst(modelLayers, ["[class*='armoursWrap']"]) : null;
        if (!armorWrap) return;

        armorWrap.innerHTML = "";
        armorWrap.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:4;transform:translateY(${IS_PDA ? "10px" : "20px"});`;

        const layerOrder = { 8: 10, 7: 11, 9: 12, 6: 13, 4: 14 };
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
            armorWrap.appendChild(container);
        }
    }

    function hasNativeDefenderLoadout(defenderItems) {
        if (!defenderItems || typeof defenderItems !== "object") return false;
        return Object.entries(defenderItems).some(([key, slot]) => {
            const k = Number(key);
            return k >= 1 && k <= 9 && slot?.item?.[0]?.ID;
        });
    }

    function renderLoadout(loadout, inserted) {
        if (!loadout || STATE.loadoutRendered) return;

        const waitForDom = W.setInterval(() => {
            const defenderArea = getDefenderArea();
            if (!defenderArea) return;
            W.clearInterval(waitForDom);

            const hasDefender = !!defenderArea.querySelector("#defender_Primary");
            const hasAttacker = !!defenderArea.querySelector("#attacker_Primary");
            const includeLabel = hasDefender || hasAttacker;
            const slotMappings = [
                { selector: hasDefender ? "#defender_Primary"   : hasAttacker ? "#attacker_Primary"   : "#weapon_main",   slot: 1, label: "Primary" },
                { selector: hasDefender ? "#defender_Secondary" : hasAttacker ? "#attacker_Secondary" : "#weapon_second", slot: 2, label: "Secondary" },
                { selector: hasDefender ? "#defender_Melee"     : hasAttacker ? "#attacker_Melee"     : "#weapon_melee",  slot: 3, label: "Melee" },
                { selector: hasDefender ? "#defender_Temporary" : hasAttacker ? "#attacker_Temporary" : "#weapon_temp",   slot: 5, label: "Temporary" },
            ];

            for (const { selector, slot, label } of slotMappings) {
                const marker = defenderArea.querySelector(selector);
                const wrapper = marker?.closest("[class*='weaponWrapper'], [class*='weapon']");
                if (wrapper && loadout[slot]) renderSlot(wrapper, loadout[slot], label, includeLabel, slot);
            }

            renderArmor(defenderArea, loadout);

            const modal = queryFirst(defenderArea, ["[class*='modal']"]);
            if (modal) {
                modal.style.background = "transparent";
                modal.style.backdropFilter = "none";
                modal.style.webkitBackdropFilter = "none";
            }

            if (inserted) {
                const stamp = W.document.getElementById("sr-loadout-timestamp");
                if (stamp) {
                    stamp.textContent = `Saved: ${relativeTime(Date.now() - new Date(inserted).getTime())}`;
                    stamp.style.display = "inline-flex";
                }
            }

            STATE.loadoutRendered = true;
        }, 100);
    }

    /* Upload */
async function uploadLoadoutData(raw) {
    const apiKey = getAPIKey();
    const attackerId = raw?.attackerUser?.userID;
    const defenderId = raw?.defenderUser?.userID;
    if (!apiKey || !attackerId || !defenderId) return;

    const loadout = extractLoadoutFromAttackData(raw);
    if (!loadout) return;

    const payload = {
        defender_id: defenderId,
        attacker_id: attackerId,
        defender_name: raw?.defenderUser?.name || null,
        attacker_name: raw?.attackerUser?.name || null,
        loadout,
        raw_payload: raw,
    };

    const res = await supabaseRequest(
        "POST",
        "/sr_loadouts?on_conflict=defender_id",
        payload,
        { Prefer: "resolution=merge-duplicates,return=representation" }
    );

    if (res.ok) {
        toastInfo("Defender loadout saved");
    } else {
        console.error("[SR Loadout Aggregator] Supabase upload failed", res);
        toast("Failed to save defender loadout");
    }
}

    /* Network Interception */
    async function testSupabaseConnection() {
    const res = await supabaseRequest(
        "GET",
        "/sr_loadouts?select=defender_id,inserted_at&limit=1"
    );
    console.log("[SR TEST] Supabase test response:", res);
    toast(res.ok ? "Supabase reachable" : "Supabase NOT reachable", 5000);
}
W.testSupabaseConnection = testSupabaseConnection;
    function processResponse(data) {
        if (!data || typeof data !== "object") return;
        if (!data.attackerUser && !data.DB?.attackerUser) return;

        const db = data.DB || data;
        const isFirstData = !STATE.attackData;
        STATE.attackData = db;

        if (hasNativeDefenderLoadout(db.defenderItems) && !STATE.uploaded) {
            STATE.uploaded = true;
            whenVisible(() => uploadLoadoutData(db));
        } else if (isFirstData) {
            fetchAndRenderLoadout();
        }
    }

    if (typeof W.fetch === "function") {
        const origFetch = W.fetch;
        W.fetch = async function (...args) {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
            if (!url.includes("sid=attackData")) return origFetch.apply(this, args);

            const response = await origFetch.apply(this, args);
            try { response.clone().text().then(text => processResponse(parseJson(text))); } catch {}
            return response;
        };
    }

    function initPanel() {
        if (W.document.getElementById("sr-loadout-panel")) return true;
        const labelsContainer = W.document.querySelector("[class*='labelsContainer']");
        if (!labelsContainer) return false;

        console.log(`[S&R Loadout Aggregator] Script loaded v${SCRIPT_VERSION}`);

        const { host, panel, toastHost } = createPanel();
        labelsContainer.insertBefore(host, labelsContainer.firstChild);
        W.document.body.appendChild(toastHost);

        const apiKey = getAPIKey();
        if (!apiKey) {
            panel.style.display = "block";
            toast("Please enter your API Key (Public Only) to authenticate!");
        }
        return true;
    }

    if (!initPanel()) {
        const waitForPanel = W.setInterval(() => {
            if (initPanel()) W.clearInterval(waitForPanel);
        }, 200);
    }
})();
