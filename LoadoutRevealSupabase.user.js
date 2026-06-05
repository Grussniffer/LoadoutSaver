// ==UserScript==
// @name         Askelads Loadout Loader
// @namespace    askelads.loadout.loader
// @version      3.7.14
// @description  Captures Torn attack data and renders saved loadouts through the Askelads backend.
// @author       Sneip
// @match        https://www.torn.com/page.php?sid=attack&user2ID=*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      loadout.grusmedia.no
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.meta.js
// ==/UserScript==

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const SCRIPT_VERSION = "3.7.14";
    const PDA_KEY = "###PDA-APIKEY###";
    const IS_PDA = !PDA_KEY.includes("#");

    const CFG = {
        apiBaseUrl: "https://loadout.grusmedia.no/loader-api",
        historyLimit: 10,
        cacheMaxAgeMs: 24 * 60 * 60 * 1000,
        latestRevalidateAfterMs: 5 * 60 * 1000,
        historyRevalidateAfterMs: 10 * 60 * 1000,
        tokenRefreshWindowMs: 10 * 60 * 1000,
        requestTimeoutMs: 15000,
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
        authErrorMessage: null,
        authPromise: null,
        historyOpen: false,
        backendWarningsShown: new Set(),
        backendRequestsInFlight: new Map(),
        latestRevalidateInFlight: new Set(),
        historyRevalidateInFlight: new Set(),
        renderIntegrityTimers: []
    };

    function getLocalStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function setLocalStorage(key, v) {
        try { localStorage.setItem(key, v); } catch {}
    }

    function removeLocalStorage(key) {
        try { localStorage.removeItem(key); } catch {}
    }

    function hasUserscriptStorage() {
        return !IS_PDA && typeof GM_getValue === "function" && typeof GM_setValue === "function";
    }

    function getStoredValue(key) {
        if (hasUserscriptStorage()) {
            try {
                const value = GM_getValue(key, null);
                if (value !== null && value !== undefined) return value;

                const legacy = getLocalStorage(key);
                if (legacy !== null && legacy !== undefined) {
                    GM_setValue(key, legacy);
                    removeLocalStorage(key);
                    return legacy;
                }
            } catch {}
        }

        return getLocalStorage(key);
    }

    function setStoredValue(key, v) {
        if (hasUserscriptStorage()) {
            try {
                GM_setValue(key, v);
                removeLocalStorage(key);
                return;
            } catch {}
        }

        setLocalStorage(key, v);
    }

    function getAPIKey() {
        return IS_PDA ? PDA_KEY : getStoredValue(CFG.store.apiKey);
    }

    function getBackendToken() {
        return getStoredValue(CFG.store.backendToken);
    }

    function setBackendToken(token) {
        setStoredValue(CFG.store.backendToken, token || "");
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

    function sessionCacheGetEntry(key) {
        try {
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || !parsed.cachedAt || !("data" in parsed)) {
                sessionStorage.removeItem(key);
                return null;
            }

            return parsed;
        } catch {
            try { sessionStorage.removeItem(key); } catch {}
            return null;
        }
    }

    function sessionCacheGet(key, maxAgeMs) {
        const entry = sessionCacheGetEntry(key);
        if (!entry) return null;

        if (Date.now() - entry.cachedAt > maxAgeMs) {
            try { sessionStorage.removeItem(key); } catch {}
            return null;
        }

        return entry.data;
    }

    function sessionCacheSet(key, data) {
        try {
            sessionStorage.setItem(key, JSON.stringify({
                cachedAt: Date.now(),
                data
            }));
        } catch {}
    }

    function clearSessionCachePrefix(prefix) {
        try {
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith(prefix)) {
                    sessionStorage.removeItem(key);
                }
            }
        } catch {}
    }

    function latestCacheKey(defenderId) {
        return `askelads:latest:${defenderId}`;
    }

    function historyCacheKey(defenderId, limit) {
        return `askelads:history:${defenderId}:${limit}`;
    }

    function lastReportCacheKey(defenderId) {
        return `askelads:last-report:${defenderId}`;
    }

    function clearDefenderSessionCache(defenderId) {
        clearSessionCachePrefix(`askelads:latest:${defenderId}`);
        clearSessionCachePrefix(`askelads:history:${defenderId}:`);
    }

    function resetAuthorizationState() {
        STATE.authChecked = false;
        STATE.isAuthorized = false;
        STATE.userInfo = null;
        STATE.authErrorMessage = null;
        STATE.authPromise = null;
        setBackendToken("");
    }

    function resetAttackState() {
        STATE.uploaded = false;
        STATE.loadoutRendered = false;
        clearRenderIntegrityTimers();
        cleanupScriptOverlays();
    }

    function cleanupScriptOverlays() {
        W.document
            .querySelectorAll(".ll-slot-overlay, .ll-armor-overlay, .ll-armor-layer, .ll-armor-map")
            .forEach(el => el.remove());
    }

    function clearRenderIntegrityTimers() {
        STATE.renderIntegrityTimers.forEach(timer => W.clearTimeout(timer));
        STATE.renderIntegrityTimers = [];
    }

    function parseJwtPayload(token) {
        try {
            const parts = String(token || "").split(".");
            if (parts.length < 2) return null;
            const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
            return JSON.parse(atob(padded));
        } catch {
            return null;
        }
    }

    function parseJwtExpMs(token) {
        const payload = parseJwtPayload(token);
        return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
    }

    function tokenNeedsRefresh(token) {
        const expMs = parseJwtExpMs(token);
        if (!expMs) return true;
        return Date.now() >= (expMs - CFG.tokenRefreshWindowMs);
    }

    function tokenLooksUsable(token) {
        return !!token && !tokenNeedsRefresh(token);
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
        if (getStoredValue(CFG.store.quietToasts) === "1") return;
        toast(message, duration);
    }

    const API_ERRORS = {
        INVALID_API_KEY: "Invalid Torn public API key.",
        INVALID_TORN_API_KEY: "Invalid Torn public API key.",
        API_KEY_REQUIRED: "Please add your Torn public API key.",
        NOT_AUTHORIZED: "You are not authorized to use this backend.",
        UNAUTHORIZED: "Your backend session expired. Please authenticate again.",
        FACTION_DENIED: "Your faction is not allowed to use this backend.",
        BLACKLISTED: "You have been blocked from using this backend.",
        SCRIPT_DEPRECATED: "This script version is deprecated. Please update.",
        SCRIPT_EXPIRED: "This script version has expired. Please update.",
        INVALID_LOADOUT: "The loadout data was not accepted by the backend.",
        UNKNOWN_ITEM: "The backend did not recognize one of the uploaded items.",
        1: "Invalid Torn public API key.",
        4: "Please add your Torn public API key.",
        5: "The loadout data was not accepted by the backend.",
        6: "This script version has expired. Please update.",
        8: "You have been blocked from using this backend.",
        9: "The backend did not recognize one of the uploaded items."
    };

    function apiErrorMessage(data, fallback = "Backend request failed.") {
        const err = data?.error;
        const code = err?.code ?? data?.code ?? err;
        const message = err?.message ?? data?.message;

        return API_ERRORS[code] || message || (typeof err === "string" ? err : "") || fallback;
    }

    function handleBackendWarning(data) {
        const warning = data?._warning || data?.warning;
        const code = warning?.code;
        if (!code || STATE.backendWarningsShown.has(code)) return;

        STATE.backendWarningsShown.add(code);

        if (code === "SCRIPT_DEPRECATED" || code === "SCRIPT_EXPIRED") {
            const expiresAt = warning.expiresAt || warning.expires_at;
            const msLeft = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
            const suffix = Number.isFinite(msLeft) && msLeft > 0
                ? ` It may stop working in ${relativeTime(msLeft).replace(" ago", "")}.`
                : "";
            toast(`${API_ERRORS[code]}${suffix}`, 12000);
            return;
        }

        toast(warning.message || API_ERRORS[code] || `Backend warning: ${code}`, 10000);
    }

    function wrapApiResponse(status, text) {
        const data = parseJson(text);
        handleBackendWarning(data);

        return {
            ok: status >= 200 && status < 300,
            status,
            data
        };
    }

    function buildApiUrl(path) {
        const base = CFG.apiBaseUrl.replace(/\/+$/, "");
        const suffix = String(path || "").replace(/^\/+/, "");
        return `${base}/${suffix}`;
    }

    function failedRequest(error = "Request failed") {
        return { ok: false, status: 0, data: { error } };
    }

    function requestTimeout() {
        return failedRequest("Request timed out");
    }

    function withRequestTimeout(promise) {
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = W.setTimeout(() => resolve(requestTimeout()), CFG.requestTimeoutMs);
        });

        return Promise.race([promise, timeout])
            .finally(() => {
                if (timer) W.clearTimeout(timer);
            });
    }

    function fetchWithTimeout(url, options) {
        const Abort = W.AbortController || (typeof AbortController !== "undefined" ? AbortController : null);
        if (!Abort) return withRequestTimeout(W.fetch(url, options));

        const controller = new Abort();
        const timer = W.setTimeout(() => controller.abort(), CFG.requestTimeoutMs);

        return W.fetch(url, { ...options, signal: controller.signal })
            .finally(() => W.clearTimeout(timer));
    }

    function apiRequest(method, path, body, { auth = false } = {}) {
        const url = buildApiUrl(path);
        const bridge = W.flutter_inappwebview;

        const headers = {
            "Content-Type": "application/json",
            "X-Script-Version": SCRIPT_VERSION
        };

        if (auth) {
            const token = getBackendToken();
            if (token) {
                headers.Authorization = `Bearer ${token}`;
                headers["X-Loadout-Token"] = token;
            }

            const apiKey = getAPIKey();
            if (apiKey) headers["X-Torn-Api-Key"] = apiKey;
        }

        if (bridge?.callHandler) {
            const handler = method === "GET" ? "PDA_httpGet" : "PDA_httpPost";
            const call = method === "GET"
                ? bridge.callHandler(handler, url, headers)
                : bridge.callHandler(handler, url, headers, body ? JSON.stringify(body) : "");

            return withRequestTimeout(call
                .then(r => wrapApiResponse(Number(r?.status || 0), String(r?.responseText || "")))
                .catch(() => failedRequest()));
        }

        if (typeof GM_xmlhttpRequest === "function") {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    timeout: CFG.requestTimeoutMs,
                    ...(body ? { data: JSON.stringify(body) } : {}),
                    onload: (r) => resolve(wrapApiResponse(r.status, r.responseText)),
                    onerror: () => resolve(failedRequest()),
                    ontimeout: () => resolve(requestTimeout())
                });
            });
        }

        return fetchWithTimeout(url, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {})
        })
            .then(async (r) => wrapApiResponse(r.status, await r.text()))
            .catch(() => failedRequest());
    }

    async function authorizedRequest(method, path, body) {
        let authorized = await ensureAuthorized(false);
        updateAuthStatus();
        if (!authorized) return { ok: false, status: 401, data: { error: "Not authorized" } };

        let res = await apiRequest(method, path, body, { auth: true });

        if (res.status === 401) {
            resetAuthorizationState();
            authorized = await ensureAuthorized(true);
            updateAuthStatus();
            if (!authorized) return res;
            res = await apiRequest(method, path, body, { auth: true });
        }

        return res;
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

    function normalizeBonusIconKey(bonus) {
        const rawKey = String(bonus?.bonus_key || "").trim();
        if (rawKey && isNaN(Number(rawKey))) return rawKey;

        const name = String(bonus?.name || "").trim().toLowerCase();

        const byName = {
            "specialist": "specialist",
            "warlord": "warlord",
            "bleed": "bleed",
            "impenetrable": "impenetrable",
            "quicken": "quicken",
            "puncture": "puncture",
            "deadeye": "deadeye",
            "freeze": "freeze",
            "burn": "burn",
            "empower": "empower",
            "execute": "execute",
            "focus": "focus",
            "rage": "rage",
            "slow": "slow",
            "smurf": "smurf",
            "suppress": "suppress",
            "motivation": "motivation",
            "storage": "storage",
            "home": "home",
            "vanguard": "vanguard",
            "irresistible": "irresistible",
            "irrepressible": "vanguard"
        };

        return byName[name] || "blank-bonus-25";
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

    function firstNumeric(...values) {
        for (const value of values) {
            if (value == null || value === "") continue;
            const numberValue = typeof value === "string"
                ? Number(value.replace("%", "").trim())
                : Number(value);
            if (Number.isFinite(numberValue)) return numberValue;
        }
        return undefined;
    }

    function normalizeBonuses(bonuses) {
        if (!bonuses) return [];
        const arr = Array.isArray(bonuses)
            ? bonuses
            : Object.entries(bonuses).map(([key, value]) => ({
                bonus_key: key,
                ...(value || {})
            }));

        return arr.map(b => {
            const value = firstNumeric(b?.value, b?.bonus_value, b?.bonusValue, b?.amount);
            const percent = firstNumeric(b?.percent, b?.percentage, b?.bonus_percent, b?.bonusPercent);
            const normalized = {
                bonus_key: b?.icon || normalizeBonusIconKey({
                    bonus_key: b?.bonus_key || b?.key,
                    name: b?.title || b?.name || b?.label || ""
                }),
                name: b?.title || b?.name || b?.label || "",
                description: b?.desc || b?.description || b?.text || b?.hoverover || ""
            };

            if (value !== undefined) {
                normalized.value = value;
                normalized.bonus_value = value;
            }
            if (percent !== undefined) {
                normalized.percent = percent;
                normalized.percentage = percent;
                normalized.bonus_percent = percent;
            }

            return normalized;
        });
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
            clip_size: raw?.clip_size ?? raw?.clipSize ?? raw?.clipsize ?? raw?.clip ?? null,
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
            STATE.authErrorMessage = null;
            return false;
        }

        const res = await apiRequest("POST", "/auth/torn", { apiKey }, { auth: false });

        if (!res.ok || !res.data?.ok || !res.data?.token) {
            STATE.authChecked = true;
            STATE.isAuthorized = false;
            STATE.userInfo = null;
            setBackendToken("");
            const detail = apiErrorMessage(res.data, `HTTP ${res.status || 0}`);
            STATE.authErrorMessage = detail;
            toast(`Backend auth failed: ${detail}`, 8000);
            return false;
        }

        setBackendToken(res.data.token);
        STATE.userInfo = res.data.player || null;
        STATE.authErrorMessage = null;
        STATE.authChecked = true;
        STATE.isAuthorized = true;
        return true;
    }

    async function ensureAuthorized(forceRefresh = false) {
        if (!forceRefresh && STATE.authChecked && STATE.isAuthorized) {
            const existing = getBackendToken();
            if (tokenLooksUsable(existing)) return true;
        }

        if (!forceRefresh) {
            const existing = getBackendToken();
            if (tokenLooksUsable(existing)) {
                STATE.authChecked = true;
                STATE.isAuthorized = true;
                return true;
            }
        }

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

        const token = getBackendToken();
        if (tokenLooksUsable(token)) {
            statusEl.textContent = "Authorization: Session active";
            statusEl.style.color = "#9fd09c";
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

    function urlTargetId() {
        try {
            const id = new URL(W.location.href).searchParams.get("user2ID");
            return id && /^\d+$/.test(id) ? Number(id) : null;
        } catch {
            return null;
        }
    }

    function sameTargetId(a, b) {
        return a != null && b != null && String(a) === String(b);
    }

    function currentTargetId() {
        return extractUserId(STATE.attackData?.defenderUser) || urlTargetId();
    }

    function currentTargetName() {
        return extractUserName(STATE.attackData?.defenderUser) || getPageDefenderName() || "Unknown";
    }

    function deepEqualJson(a, b) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    function loadoutFingerprint(loadout) {
        try {
            return stableStringify(loadout);
        } catch {
            return JSON.stringify(loadout);
        }
    }

    function getKnownReportState(defenderId, loadout) {
        const fingerprint = loadoutFingerprint(loadout);
        const lastReport = sessionCacheGet(lastReportCacheKey(defenderId), CFG.cacheMaxAgeMs);
        const latest = sessionCacheGet(latestCacheKey(defenderId), CFG.cacheMaxAgeMs);
        const latestFingerprint = latest?.loadout ? loadoutFingerprint(latest.loadout) : null;

        return {
            fingerprint,
            isKnownDuplicate: lastReport?.fingerprint === fingerprint || latestFingerprint === fingerprint
        };
    }

    function rememberReportedLoadout(defenderId, fingerprint) {
        sessionCacheSet(lastReportCacheKey(defenderId), { fingerprint });
    }

    function dedupeBackendRequest(key, fn) {
        if (STATE.backendRequestsInFlight.has(key)) {
            return STATE.backendRequestsInFlight.get(key);
        }

        const request = Promise.resolve()
            .then(fn)
            .finally(() => STATE.backendRequestsInFlight.delete(key));

        STATE.backendRequestsInFlight.set(key, request);
        return request;
    }

    function getCachedHistoryEntry(targetId, limit) {
        const entry = sessionCacheGetEntry(historyCacheKey(targetId, limit));
        if (entry && (Date.now() - entry.cachedAt) <= CFG.cacheMaxAgeMs && Array.isArray(entry.data)) {
            return entry;
        }

        return null;
    }

    function getCachedHistory(targetId, limit) {
        return getCachedHistoryEntry(targetId, limit)?.data || null;
    }

    function getNewestCachedHistoryRow(targetId) {
        const single = getCachedHistory(targetId, 1);
        if (single?.[0]?.loadout) return single[0];

        const full = getCachedHistory(targetId, CFG.historyLimit);
        if (full?.[0]?.loadout) return full[0];

        return null;
    }

    async function fetchLatestFromBackend(targetId) {
        return dedupeBackendRequest(`latest:${targetId}`, async () => {
            const res = await authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/latest`, null);
            updateAuthStatus();
            if (!res.ok || !res.data?.ok || !res.data?.loadout) return null;
            return res.data.loadout;
        });
    }

    async function fetchLatestFallbackFromHistory(targetId) {
        const row = getNewestCachedHistoryRow(targetId) || (await fetchHistoryForTarget(targetId, 1))[0];
        if (!row?.loadout) return null;

        return {
            loadout: row.loadout,
            inserted_at: row.observed_at || row.inserted_at
        };
    }

    async function fetchLatestOrHistoryFallback(targetId) {
        return await fetchLatestFromBackend(targetId) || await fetchLatestFallbackFromHistory(targetId);
    }

    async function silentRevalidateLatest(targetId, renderedCacheEntry = null) {
        const id = String(targetId);
        if (STATE.latestRevalidateInFlight.has(id)) return;
        STATE.latestRevalidateInFlight.add(id);

        try {
            const fresh = await fetchLatestOrHistoryFallback(targetId);
            if (!fresh?.loadout) return;

            const currentCached = renderedCacheEntry || sessionCacheGetEntry(latestCacheKey(targetId));
            const previousData = currentCached?.data || null;

            sessionCacheSet(latestCacheKey(targetId), fresh);

            if (!previousData || !deepEqualJson(previousData, fresh)) {
                if (sameTargetId(currentTargetId(), id)) {
                    STATE.loadoutRendered = false;
                    renderLoadout(fresh.loadout, fresh.inserted_at, true);
                }
            }
        } finally {
            STATE.latestRevalidateInFlight.delete(id);
        }
    }

    async function fetchAndRenderLoadout(force = false, forceRefresh = false) {
        const authorized = await ensureAuthorized(false);
        updateAuthStatus();
        if (!authorized) return;

        const targetId = currentTargetId();
        if (!targetId) return;

        const cacheKey = latestCacheKey(targetId);

        if (!forceRefresh) {
            const entry = sessionCacheGetEntry(cacheKey);
            if (entry && (Date.now() - entry.cachedAt) <= CFG.cacheMaxAgeMs && entry.data?.loadout) {
                renderLoadout(entry.data.loadout, entry.data.inserted_at, force);

                if ((Date.now() - entry.cachedAt) >= CFG.latestRevalidateAfterMs) {
                    void silentRevalidateLatest(targetId, entry);
                }
                return;
            }
        }

        const fresh = await fetchLatestOrHistoryFallback(targetId);
        if (fresh?.loadout) {
            sessionCacheSet(cacheKey, fresh);
            renderLoadout(fresh.loadout, fresh.inserted_at, force);
        }
    }

    async function fetchHistoryFromBackend(targetId, limit = CFG.historyLimit) {
        return dedupeBackendRequest(`history:${targetId}:${limit}`, async () => {
            const res = await authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/history?limit=${encodeURIComponent(limit)}`, null);
            updateAuthStatus();
            if (!res.ok || !res.data?.ok || !Array.isArray(res.data.history)) return [];
            return res.data.history;
        });
    }

    async function fetchHistoryForTarget(targetId, limit = CFG.historyLimit, { forceRefresh = false } = {}) {
        const cacheKey = historyCacheKey(targetId, limit);

        if (!forceRefresh) {
            const entry = getCachedHistoryEntry(targetId, limit);
            if (entry) {
                if ((Date.now() - entry.cachedAt) >= CFG.historyRevalidateAfterMs) {
                    void silentRevalidateHistory(targetId, limit);
                }
                return entry.data;
            }
        }

        const fresh = await fetchHistoryFromBackend(targetId, limit);
        if (Array.isArray(fresh)) {
            sessionCacheSet(cacheKey, fresh);
            return fresh;
        }

        return [];
    }

    async function silentRevalidateHistory(targetId, limit = CFG.historyLimit) {
        const key = `${targetId}:${limit}`;
        if (STATE.historyRevalidateInFlight.has(key)) return;
        STATE.historyRevalidateInFlight.add(key);

        try {
            const fresh = await fetchHistoryFromBackend(targetId, limit);
            if (!Array.isArray(fresh)) return;
            sessionCacheSet(historyCacheKey(targetId, limit), fresh);
        } finally {
            STATE.historyRevalidateInFlight.delete(key);
        }
    }

    async function fetchHistoryForCurrentTarget({ forceRefresh = false } = {}) {
        const authorized = await ensureAuthorized(false);
        updateAuthStatus();
        if (!authorized) return [];

        const targetId = currentTargetId();
        if (!targetId) {
            toast("No defender detected on this page.", 4000);
            return [];
        }

        return fetchHistoryForTarget(targetId, CFG.historyLimit, { forceRefresh });
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
        return `<div class="container___dxksw" title="${tooltip}"><i class="bonus-attachment-${safeIcon}" title="${tooltip}"></i></div>`;
    }

    function buildSlotIcons(arr, key, name, desc) {
        return [0, 1].map(i => {
            if (!arr?.[i]) return buildIconHtml(null, "", "");

            const item = arr[i];
            const iconValue = key === "bonus_key"
                ? normalizeBonusIconKey(item)
                : item[key];

            return buildIconHtml(iconValue, item[name], item[desc]);
        }).join("");
    }

    const SILHOUETTES = {
        1: "primary",
        2: "secondary",
        3: "melee",
        5: "temporary"
    };

    const ARMOR_LAYER_ORDER = {
        8: 10,
        7: 11,
        9: 12,
        6: 13,
        4: 14
    };

    const ARMOR_SLOT_AREAS = {
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

    const INFINITY_SVG = `<span class="eternity___zfACp"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="10" viewBox="0 0 17 10"><g><path d="M 12.3399 1.5 C 10.6799 1.5 9.64995 2.76 8.50995 3.95 C 7.35995 2.76 6.33995 1.5 4.66995 1.5 C 2.89995 1.51 1.47995 2.95 1.48995 4.72 C 1.48995 4.81 1.48995 4.91 1.49995 5 C 1.32995 6.76 2.62995 8.32 4.38995 8.49 C 4.47995 8.49 4.57995 8.5 4.66995 8.5 C 6.32995 8.5 7.35995 7.24 8.49995 6.05 C 9.64995 7.24 10.67 8.5 12.33 8.5 C 14.0999 8.49 15.5199 7.05 15.5099 5.28 C 15.5099 5.19 15.5099 5.09 15.4999 5 C 15.6699 3.24 14.3799 1.68 12.6199 1.51 C 12.5299 1.51 12.4299 1.5 12.3399 1.5 Z M 4.66995 7.33 C 3.52995 7.33 2.61995 6.4 2.61995 5.26 C 2.61995 5.17 2.61995 5.09 2.63995 5 C 2.48995 3.87 3.27995 2.84 4.40995 2.69 C 4.49995 2.68 4.57995 2.67 4.66995 2.67 C 6.01995 2.67 6.83995 3.87 7.79995 5 C 6.83995 6.14 6.01995 7.33 4.66995 7.33 Z M 12.3399 7.33 C 10.99 7.33 10.17 6.13 9.20995 5 C 10.17 3.86 10.99 2.67 12.3399 2.67 C 13.48 2.67 14.3899 3.61 14.3899 4.74 C 14.3899 4.83 14.3899 4.91 14.3699 5 C 14.5199 6.13 13.7299 7.16 12.5999 7.31 C 12.5099 7.32 12.4299 7.33 12.3399 7.33 Z" stroke-width="0"></path></g></svg></span>`;

    function renderEmptySlot(wrapper, slot) {
        if (!wrapper || !SILHOUETTES[slot]) return;

        wrapper.querySelector(".ll-slot-overlay")?.remove();
        wrapper.style.position = "relative";

        const overlay = wrapper.cloneNode(true);
        overlay.classList.add("ll-slot-overlay");
        overlay.classList.remove(...[...overlay.classList].filter(c => /^glow-/.test(c) || /emptySlot/i.test(c)));
        overlay.style.cssText += ";position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;box-sizing:border-box;";

        const border = queryFirst(overlay, ["[class*='itemBorder']"]);
        if (border) border.className = "itemBorder___u_Tpv glow-default___RmCvA";

        const img = queryFirst(overlay, ["[class*='weaponImage'] img", "img"]);
        if (img) {
            img.src = `/images/items/silhouettes/${SILHOUETTES[slot]}.svg`;
            img.srcset = "";
            img.classList.add("blank___W6Kh5");
            img.style.objectFit = "";
        }

        queryFirst(overlay, ["[class*='top___']"])?.replaceChildren();
        queryFirst(overlay, ["[class*='bottom___']"])?.replaceChildren();
        overlay.querySelector(".ll-weapon-name")?.remove();

        wrapper.appendChild(overlay);
    }

    function renderSlot(wrapper, item, slotLabel, includeLabel = true, slot = 0) {
        if (!wrapper || !item) return;

        wrapper.querySelector(".ll-slot-overlay")?.remove();

        const overlay = wrapper.cloneNode(true);
        overlay.classList.add("ll-slot-overlay");
        overlay.classList.remove(...[...overlay.classList].filter(c => /^glow-/.test(c) || /emptySlot/i.test(c)));
        overlay.style.cssText += ";position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;box-sizing:border-box;";
        wrapper.style.position = "relative";
        wrapper.appendChild(overlay);
        wrapper = overlay;

        const rarityGlow = {
            yellow: "glow-yellow",
            orange: "glow-orange",
            red: "glow-red"
        };

        const glow = rarityGlow[item.rarity] || "glow-default___RmCvA";
        wrapper.classList.remove(...[...wrapper.classList].filter(c => /^glow-/.test(c)));
        wrapper.classList.add(glow);

        const border = queryFirst(wrapper, ["[class*='itemBorder']"]);
        if (border) border.className = `itemBorder___u_Tpv ${glow}-border`;

        const img = queryFirst(wrapper, ["[class*='weaponImage'] img", "img"]);
        if (img && item.item_id) {
            const base = `https://www.torn.com/images/items/${item.item_id}/large`;
            img.src = `${base}.png`;
            img.srcset = `${base}.png 1x, ${base}@2x.png 2x, ${base}@3x.png 3x, ${base}@4x.png 4x`;
            img.alt = item.item_name || "";
            img.classList.remove("blank___W6Kh5");
            img.style.objectFit = "contain";
        }

        const top = queryFirst(wrapper, ["[class*='top___']"]);
        if (top) {
            const modIcons = buildSlotIcons(item.mods, "icon", "name", "description");
            const bonusIcons = buildSlotIcons(item.bonuses, "bonus_key", "name", "description");

            top.innerHTML = includeLabel
                ? `<div class="props___O2Xnr">${modIcons}</div>
                   <div class="topMarker___sECip"><span class="markerText___fXCwg">${escapeHtml(slotLabel)}</span></div>
                   <div class="props___O2Xnr">${bonusIcons}</div>`
                : `<div class="props___O2Xnr">${modIcons}</div>
                   <div class="props___O2Xnr">${bonusIcons}</div>`;
        }

        const bottom = queryFirst(wrapper, ["[class*='bottom___']"]);
        if (bottom) {
            const ammoColorKey = (item.ammo_type || "").toLowerCase().replace(/\s+/g, "-");
            const ammoColor = `var(--attack-ammo-color-${ammoColorKey}, #ddd)`;
            const spareMags = item.mods?.some(m => m.name === "Extra Magazines x2") ? 4 : item.mods?.some(m => m.name === "Extra Magazine") ? 3 : 2;
            const clipSize = item.clip_size ?? "?";

            const ammoInner = slot === 3
                ? INFINITY_SVG
                : slot === 5
                    ? `<span class="markerText___fXCwg standard___HC4M1">1</span>`
                    : item.clip_size
                        ? `<span class="markerText___fXCwg" style="color:${ammoColor}">${escapeHtml(clipSize)}/${escapeHtml(clipSize)} (${spareMags})</span>`
                        : `<span class="markerText___fXCwg" style="color:${ammoColor}">${escapeHtml(item.ammo_type || "Unknown")}</span>`;

            bottom.innerHTML = `
                <div class="props___O2Xnr">
                    <i class="bonus-attachment-item-damage-bonus" aria-label="Damage"></i>
                    <span class="bonusInfo___tXGYA">${formatFixed2(item.damage)}</span>
                </div>
                <div class="bottomMarker___K5saZ">${ammoInner}</div>
                <div class="props___O2Xnr">
                    <i class="bonus-attachment-item-accuracy-bonus" aria-label="Accuracy"></i>
                    <span class="bonusInfo___tXGYA">${formatFixed2(item.accuracy)}</span>
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
        const bodyImg =
            queryFirst(defenderArea, [
                "[class*='bodyImage']",
                "img[src*='body-m']",
                "img[src*='body-f']",
                "img[src*='model']"
            ]) ||
            queryFirst(W.document, [
                "[class*='defender'] [class*='bodyImage']",
                "[class*='defender'] img[src*='body-m']",
                "[class*='defender'] img[src*='body-f']",
                "[class*='playerArea']:nth-of-type(2) [class*='bodyImage']",
                "[class*='playerArea']:nth-of-type(2) img[src*='body-m']",
                "[class*='playerArea']:nth-of-type(2) img[src*='body-f']",
                "[class*='bodyImage']",
                "img[src*='body-m']",
                "img[src*='body-f']",
                "img[src*='model']"
            ]);

        if (!bodyImg) return;

        const modelRoot =
            bodyImg.closest("[class*='modelLayers'], [class*='model'], [class*='playerArea'], [class*='player___']") ||
            defenderArea ||
            W.document;

        let armoursWrap =
            queryFirst(modelRoot, ["[class*='armoursWrap']"]) ||
            queryFirst(defenderArea, ["[class*='armoursWrap']"]);

        if (!armoursWrap) {
            const wraps = Array.from(W.document.querySelectorAll("[class*='armoursWrap']"));
            armoursWrap = wraps[1] || wraps[0] || null;
        }

        if (!armoursWrap) return;

        const src = bodyImg.getAttribute("src") || "";
        const gender = /body-f[.@/]/.test(src) || src.includes("body-f") ? "f" : "m";

        armoursWrap.querySelectorAll(".ll-armor-layer").forEach(el => el.remove());
        W.document.querySelector(".ll-armor-map")?.remove();

        const frag = W.document.createDocumentFragment();

        for (const slot of [8, 7, 9, 6, 4]) {
            const item = loadout[slot];
            if (!item) continue;

            const container = W.document.createElement("div");
            container.className = "armourContainer___ftMzt ll-armor-layer ll-slot-overlay";
            container.style.zIndex = String(ARMOR_LAYER_ORDER[slot]);

            const armor = W.document.createElement("div");
            armor.className = "armour___wqLa7";

            const img = W.document.createElement("img");
            img.className = "itemImg___r9DqK";
            img.src = `https://www.torn.com/images/v2/user_model/items/${item.item_id}${gender}.webp`;
            img.alt = "";

            img.onerror = () => {
                if (img.dataset.fallbackTried === "1") return;
                img.dataset.fallbackTried = "1";
                img.src = `https://www.torn.com/images/v2/items/model-items/${item.item_id}m.png`;
            };

            armor.appendChild(img);
            container.appendChild(armor);
            frag.appendChild(container);
        }

        armoursWrap.appendChild(frag);

        const MAP_NAME = "ll-armor-map";
        const map = W.document.createElement("map");
        map.name = MAP_NAME;
        map.className = "ll-armor-map ll-slot-overlay";

        for (const slot of [4, 6, 7, 8, 9]) {
            const item = loadout[slot];
            if (!item || !ARMOR_SLOT_AREAS[slot]) continue;

            for (const { coords } of ARMOR_SLOT_AREAS[slot]) {
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

    function expectedArmorOverlayCount(loadout) {
        return [4, 6, 7, 8, 9].filter(slot => !!loadout?.[slot]).length;
    }

    function hasRenderedArmorOverlays(loadout) {
        const expected = expectedArmorOverlayCount(loadout);
        if (!expected) return true;

        const defenderArea = getDefenderArea();
        if (!defenderArea) return true;

        return defenderArea.querySelectorAll(".ll-armor-layer").length >= expected;
    }

    function scheduleRenderIntegrityChecks(loadout, inserted) {
        clearRenderIntegrityTimers();

        for (const delay of [250, 750, 1500, 3000]) {
            const timer = W.setTimeout(() => {
                if (!STATE.loadoutRendered) return;
                if (hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;
                if (hasRenderedArmorOverlays(loadout)) return;

                STATE.loadoutRendered = false;
                renderLoadout(loadout, inserted, true, false);
            }, delay);

            STATE.renderIntegrityTimers.push(timer);
        }
    }

    function renderLoadout(loadout, inserted, force = false, scheduleIntegrity = true) {
        if (!loadout || (STATE.loadoutRendered && !force) || hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;

        waitForElement("#defender_Primary, #defender_Secondary, #defender_Melee, #defender_Temporary, #attacker_Primary, [class*='playerArea']", () => {
            const defenderArea = getDefenderArea();
            if (!defenderArea) return;

            cleanupScriptOverlays();

            const hasDefender = !!defenderArea.querySelector("#defender_Primary");
            const hasAttacker = !!defenderArea.querySelector("#attacker_Primary");
            const includeLabel = hasDefender || hasAttacker;
            const prefix = hasDefender ? "defender" : hasAttacker ? "attacker" : null;

            const slotMappings = [
                { slot: 1, label: "Primary", fallback: "#weapon_main" },
                { slot: 2, label: "Secondary", fallback: "#weapon_second" },
                { slot: 3, label: "Melee", fallback: "#weapon_melee" },
                { slot: 5, label: "Temporary", fallback: "#weapon_temp" }
            ].map(({ slot, label, fallback }) => ({
                selector: prefix ? `#${prefix}_${label}` : fallback,
                slot,
                label
            }));

            for (const { selector, slot, label } of slotMappings) {
                const marker = defenderArea.querySelector(selector);
                const wrapper = marker?.closest("[class*='weaponWrapper'], [class*='weapon']");
                if (wrapper && loadout[slot]) {
                    renderSlot(wrapper, loadout[slot], label, includeLabel, slot);
                } else if (wrapper) {
                    renderEmptySlot(wrapper, slot);
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
            if (scheduleIntegrity) scheduleRenderIntegrityChecks(loadout, inserted);
        });
    }

    async function reportLoadout(raw) {
        const attackerId = extractUserId(raw?.attackerUser);
        const defenderId = extractUserId(raw?.defenderUser);
        const attackerName = extractUserName(raw?.attackerUser) || getPageAttackerName();
        const defenderName = extractUserName(raw?.defenderUser) || getPageDefenderName();
        const defenderFactionId = raw?.defenderUser?.factionID ?? null;
        const loadout = extractLoadoutFromAttackData(raw);

        if (!attackerId || !defenderId || !loadout) return;

        const reportState = getKnownReportState(defenderId, loadout);
        const payload = {
            defender_id: defenderId,
            attacker_id: attackerId,
            defender_name: defenderName,
            attacker_name: attackerName,
            defender_faction_id: defenderFactionId,
            loadout
        };

        const res = await authorizedRequest("POST", "/loadouts/report", payload);
        updateAuthStatus();

        if (res.ok && res.data?.ok) {
            clearDefenderSessionCache(defenderId);
            if (res.data.latest) {
                sessionCacheSet(latestCacheKey(defenderId), res.data.latest);
            }

            rememberReportedLoadout(defenderId, reportState.fingerprint);

            const backendSaysDuplicate = res.data?.duplicate === true
                || res.data?.unchanged === true
                || res.data?.created === false
                || res.data?.inserted === false;

            if (!reportState.isKnownDuplicate && !backendSaysDuplicate) {
                toastInfo("Loadout saved to the war chest.");
            }
        } else {
            toast(apiErrorMessage(res.data, "Failed to save defender loadout."));
        }
    }

    async function showHistoryModal(forceRefresh = false) {
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

        const controls = W.document.createElement("div");
        controls.style.cssText = "display:flex;gap:6px;";

        const refreshBtn = W.document.createElement("button");
        refreshBtn.textContent = "Refresh";
        refreshBtn.style.cssText = askeladsButtonStyle("steel");
        refreshBtn.onclick = () => {
            closeHistoryModal();
            showHistoryModal(true);
        };

        const closeBtn = W.document.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.style.cssText = askeladsButtonStyle("red");
        closeBtn.onclick = closeHistoryModal;

        controls.appendChild(refreshBtn);
        controls.appendChild(closeBtn);
        header.appendChild(controls);

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

        const rows = await fetchHistoryForCurrentTarget({ forceRefresh });

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

    function openTornPublicApiKeyPage() {
        W.open("https://www.torn.com/preferences.php#tab=api", "_blank", "noopener,noreferrer");
    }

    function maskApiKey(key) {
        return key ? `${String(key).slice(0, 6)}**********` : "";
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
            `width:${IS_PDA ? "min(320px, 92vw)" : "390px"}`,
            "max-width:92vw",
            `max-height:${IS_PDA ? "70vh" : "80vh"}`,
            "overflow:auto",
            "z-index:2147483647",
            "border:1px solid rgba(191,145,63,0.22)",
            "background:linear-gradient(180deg, rgba(23,19,16,0.985), rgba(12,10,8,0.985))",
            "color:#f1e6c9",
            "padding:12px",
            "border-radius:14px",
            "box-shadow:0 18px 38px rgba(0,0,0,0.5)"
        ].join(";");

        if (IS_PDA) {
            panel.style.position = "fixed";
            panel.style.top = "10px";
            panel.style.left = "10px";
            panel.style.right = "10px";
            panel.style.bottom = "auto";
            panel.style.width = "auto";
            panel.style.maxWidth = "none";
            panel.style.maxHeight = "75vh";
            panel.style.transform = "none";
            panel.style.padding = "10px";
            panel.style.margin = "0";
        }

        const savedKey = getAPIKey();
        const maskedKey = maskApiKey(savedKey);

        const pdaKeyControls = IS_PDA
            ? `<div style="margin-bottom:8px;color:#9fd09c;font-size:11px;">Torn-PDA detected. API key is loaded automatically.</div>
               ${getApiKeyHelpHtml()}`
            : `<div style="margin-bottom:5px;color:#d7b46a;font-size:11px;font-weight:700;letter-spacing:.25px;text-transform:uppercase;">Torn Public API Key</div>
               <input id="loadout-key-input" type="password" placeholder="Enter your Torn public API key" value="${escapeHtml(maskedKey)}" data-saved-mask="${escapeHtml(maskedKey)}"
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
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
                <div>
                    <div style="font-weight:800;font-size:16px;color:#f4e7c2;letter-spacing:.35px;">Askelads Loadout</div>
                    <div style="font-size:11px;color:#b8a786;">War-room viewer and recorder</div>
                </div>

                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <div style="font-size:11px;color:#8f836f;">v${SCRIPT_VERSION}</div>
                    <button id="loadout-close-panel-btn" style="${askeladsButtonStyle("red")}padding:4px 8px;font-size:11px;">
                        Close
                    </button>
                </div>
            </div>

            ${pdaKeyControls}

            <label style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;color:#d8ceb9;font-size:12px;">
                <input id="loadout-quiet-chk" type="checkbox" ${getStoredValue(CFG.store.quietToasts) === "1" ? "checked" : ""}>
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
            if (panelOpen && !host.contains(e.target) && !panel.contains(e.target)) {
                panelOpen = false;
                panel.style.display = "none";
            }
        });

        panel.querySelector("#loadout-close-panel-btn").onclick = () => {
            panelOpen = false;
            panel.style.display = "none";
        };

        panel.querySelector("#loadout-quiet-chk").onchange = (e) => {
            setStoredValue(CFG.store.quietToasts, e.target.checked ? "1" : "0");
        };

        panel.querySelector("#loadout-show-history-btn").onclick = () => {
            showHistoryModal(false);
        };

        panel.querySelector("#loadout-show-latest-btn").onclick = () => {
            fetchAndRenderLoadout(true, true);
        };

        if (!IS_PDA) {
            const input = panel.querySelector("#loadout-key-input");

            input.onfocus = () => {
                const savedMask = input.dataset.savedMask || "";
                if (input.value === savedMask) input.value = "";
            };

            panel.querySelector("#loadout-save-btn").onclick = async () => {
                const rawKey = input.value.trim();
                const savedMask = input.dataset.savedMask || "";
                const key = rawKey === savedMask ? getAPIKey() : rawKey;
                if (!key) {
                    toast("Please enter a key.");
                    return;
                }

                setStoredValue(CFG.store.apiKey, key);
                resetAuthorizationState();

                const ok = await ensureAuthorized(true);
                updateAuthStatus();

                if (ok) {
                    const nextMask = maskApiKey(key);
                    input.value = nextMask;
                    input.dataset.savedMask = nextMask;
                    toastInfo("Key saved. Welcome back to the war room.");
                    fetchAndRenderLoadout(true, true);
                } else {
                    toast(STATE.authErrorMessage || "Failed to authenticate with backend.");
                }
            };

            panel.querySelector("#loadout-clear-btn").onclick = () => {
                input.value = "";
                input.dataset.savedMask = "";
                setStoredValue(CFG.store.apiKey, "");
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
        const ok = await ensureAuthorized(true);
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
        return authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/latest`, null);
    }

    W.testBackendLatest = testBackendLatest;

    async function testBackendHistory() {
        const targetId = currentTargetId();
        if (!targetId) {
            toast("No defender detected.");
            return null;
        }
        return authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/history?limit=5`, null);
    }

    W.testBackendHistory = testBackendHistory;

    function slotHasItemId(slot) {
        const raw = slot?.item?.[0] || slot?.item || slot?.weapon || slot;
        return !!extractItemId(raw);
    }

    function hasNativeDefenderLoadout(defenderItems) {
        if (!defenderItems || typeof defenderItems !== "object") return false;

        const nativeMarker = defenderItems?.["999"] || defenderItems?.[999];
        return slotHasItemId(nativeMarker);
    }

    function processResponse(data) {
        if (!data || typeof data !== "object") return;
        if (!data.attackerUser && !data.DB?.attackerUser) return;

        const db = data.DB || data;
        const newDefenderId = extractUserId(db?.defenderUser);
        const oldDefenderId = extractUserId(STATE.attackData?.defenderUser);
        const hadFightID = !!STATE.attackData?.fightID;
        const isFirstData = !STATE.attackData;
        const hasNativeLoadout = hasNativeDefenderLoadout(db?.defenderItems);

        if (newDefenderId && oldDefenderId && newDefenderId !== oldDefenderId) {
            resetAttackState();
        }

        STATE.attackData = db;
        W.attackDataDebug = db;

        if (!hadFightID && db.fightID && hasNativeLoadout) {
            cleanupScriptOverlays();
        }

        if (hasNativeLoadout && !STATE.uploaded) {
            STATE.uploaded = true;
            whenVisible(() => reportLoadout(db));
        } else if (isFirstData && !STATE.loadoutRendered) {
            fetchAndRenderLoadout(true, false);
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

    function initPanel(fallback = false) {
        if (W.document.getElementById("loadout-panel")) return true;

        const labelsContainer = W.document.querySelector("[class*='labelsContainer']");
        if (!labelsContainer && !fallback) return false;
        if (!labelsContainer && !W.document.body) return false;

        const { host, panel, toastHost } = createPanel();

        if (labelsContainer) {
            labelsContainer.insertBefore(host, labelsContainer.firstChild);
        } else {
            host.style.cssText += ";position:fixed;top:10px;right:10px;z-index:2147483646;";
            W.document.body.appendChild(host);
        }

        W.document.body.appendChild(toastHost);

        const apiKey = getAPIKey();
        if (!apiKey) {
            panel.style.display = "block";
            toast("Enter your Public API key to join the war room.");
        } else {
            fetchAndRenderLoadout(true, false);
        }

        updateAuthStatus();
        return true;
    }

    const startPanelInit = () => {
        if (initPanel()) return;
        waitForElement("[class*='players___eKiHL'], [class*='labelsContainer']", () => initPanel());
        waitForElement("#defender_Primary, #defender_Secondary, #defender_Melee, [class*='playerArea']", () => {
            if (!W.document.getElementById("loadout-panel")) initPanel(true);
        });
    };

    if (W.document.readyState === "loading") {
        W.document.addEventListener("DOMContentLoaded", startPanelInit, { once: true });
    } else {
        startPanelInit();
    }
})();
