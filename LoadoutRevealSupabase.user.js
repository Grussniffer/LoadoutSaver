// ==UserScript==
// @name         Askelads Loadout Loader
// @namespace    askelads.loadout.loader
// @version      3.8.1
// @description  Captures Torn attack data and renders saved loadouts through the Askelads backend.
// @author       Sneip
// @match        https://www.torn.com/page.php?sid=attack&user2ID=*
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      loadout.grusmedia.no
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/LoadoutSaver/main/LoadoutRevealSupabase.meta.js
// ==/UserScript==

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const SCRIPT_VERSION = "3.8.1";
    const PAGE = new URL(W.location.href);
    const IS_ATTACK = PAGE.pathname === "/page.php" && PAGE.searchParams.get("sid") === "attack";
    const IS_PROFILE = PAGE.pathname === "/profiles.php";
    const IS_FACTION = PAGE.pathname === "/factions.php" && PAGE.searchParams.get("step") === "your";
    if (!IS_ATTACK && !IS_PROFILE && !IS_FACTION) return;
    const PDA_KEY = "###PDA-APIKEY###";
    const IS_PDA = !PDA_KEY.includes("#");

    const CFG = {
        apiBaseUrl: "https://loadout.grusmedia.no/loader-api",
        historyLimit: 10,
        cacheMaxAgeMs: 24 * 60 * 60 * 1000,
        negativeCacheMaxAgeMs: 3 * 60 * 1000,
        latestRevalidateAfterMs: 5 * 60 * 1000,
        historyRevalidateAfterMs: 10 * 60 * 1000,
        tokenRefreshWindowMs: 10 * 60 * 1000,
        requestTimeoutMs: 15000,
        startupFallbackMs: 1500,
        idleWorkTimeoutMs: 750,
        sharedLatestCacheLimit: 200,
        uploadRetryDelaysMs: [2000, 5000, 15000, 30000],
        warCacheRefreshMs: 5 * 60 * 1000,
        warRosterMaxAgeMs: 10 * 60 * 1000,
        store: {
            apiKey: "loadout_loader_api_key",
            backendToken: "loadout_loader_backend_token",
            quietToasts: "loadout_loader_quiet_mode",
            profile: "loadout_loader_show_profile",
            attack: "loadout_loader_show_attack",
            warCache: "loadout_loader_war_cache",
            bonusLabels: "loadout_loader_bonus_labels"
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
        automaticLoadoutTasks: new Map(),
        latestRevalidateInFlight: new Set(),
        historyRevalidateInFlight: new Set(),
        renderIntegrityTimers: [],
        startupFallbackTimer: null,
        captures: new Map(),
        selected: null,
        inlineHistory: [],
        historyIndex: 0,
        historyBusy: false,
        viewGeneration: 0,
        renderObserver: null,
        renderFrame: null,
        warCacheTimer: null,
        warCacheBusy: false,
        warRosterObserver: null,
        warRosterTimer: null,
        nativeStyles: new Map(),
        profileMountObserver: null
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

    const elementWaiters = new Set();
    let elementWaitObserver = null;
    let elementWaitFlushPending = false;

    function stopElementWaitObserverIfIdle() {
        if (elementWaiters.size || !elementWaitObserver) return;
        elementWaitObserver.disconnect();
        elementWaitObserver = null;
    }

    function flushElementWaiters() {
        elementWaitFlushPending = false;

        for (const waiter of [...elementWaiters]) {
            const el = W.document.querySelector(waiter.selector);
            if (!el) continue;

            elementWaiters.delete(waiter);
            W.clearTimeout(waiter.timer);
            waiter.callback(el);
        }

        stopElementWaitObserverIfIdle();
    }

    function scheduleElementWaitFlush() {
        if (elementWaitFlushPending) return;
        elementWaitFlushPending = true;

        if (typeof W.requestAnimationFrame === "function") {
            W.requestAnimationFrame(flushElementWaiters);
        } else {
            W.setTimeout(flushElementWaiters, 16);
        }
    }

    function ensureElementWaitObserver() {
        if (elementWaitObserver || !W.document.documentElement) return;

        elementWaitObserver = new MutationObserver(scheduleElementWaitFlush);
        elementWaitObserver.observe(W.document.documentElement, { childList: true, subtree: true });
    }

    function waitForElement(selector, callback, timeout = 15000) {
        const found = W.document.querySelector(selector);
        if (found) {
            callback(found);
            return;
        }

        const waiter = { selector, callback, timer: null };
        waiter.timer = W.setTimeout(() => {
            elementWaiters.delete(waiter);
            stopElementWaitObserverIfIdle();
        }, timeout);

        elementWaiters.add(waiter);
        ensureElementWaitObserver();
        scheduleElementWaitFlush();
    }

    function waitForIdle(timeout = CFG.idleWorkTimeoutMs) {
        return new Promise((resolve) => {
            if (typeof W.requestIdleCallback === "function") {
                W.requestIdleCallback(() => resolve(), { timeout });
                return;
            }

            W.setTimeout(resolve, 32);
        });
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

    function sessionCacheSetEntry(key, entry) {
        try {
            sessionStorage.setItem(key, JSON.stringify(entry));
        } catch {}
    }

    function sessionCacheSet(key, data) {
        sessionCacheSetEntry(key, {
            cachedAt: Date.now(),
            data
        });
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
        return `askelads:v2:${cacheScope()}:latest:${defenderId}`;
    }

    const SHARED_LATEST_CACHE_INDEX_KEY = "loadout_loader_latest_cache_index_v1";
    const SHARED_LATEST_CACHE_PREFIX = "loadout_loader_latest_cache_v2:";

    function cacheScope() {
        const user = parseJwtPayload(getBackendToken());
        return `${user?.player_id || 0}:${user?.faction_id || 0}`;
    }

    function preference(name) { return getStoredValue(CFG.store[name]) !== "0"; }

    function sharedLatestStorageKey(defenderId) {
        return `${SHARED_LATEST_CACHE_PREFIX}${cacheScope()}:${defenderId}`;
    }

    function readSharedCacheValue(key) {
        if (hasUserscriptStorage()) {
            try {
                const value = GM_getValue(key, null);
                return typeof value === "string" ? parseJson(value) : value;
            } catch {}
        }

        const raw = getLocalStorage(key);
        return raw ? parseJson(raw) : null;
    }

    function writeSharedCacheValue(key, value) {
        if (hasUserscriptStorage()) {
            try {
                GM_setValue(key, value);
                removeLocalStorage(key);
                return;
            } catch {}
        }

        setLocalStorage(key, JSON.stringify(value));
    }

    function deleteSharedCacheValue(key) {
        if (hasUserscriptStorage()) {
            try {
                if (typeof GM_deleteValue === "function") {
                    GM_deleteValue(key);
                } else {
                    GM_setValue(key, null);
                }
            } catch {}
        }

        removeLocalStorage(key);
    }

    function readSharedLatestIndex() {
        const value = readSharedCacheValue(`${SHARED_LATEST_CACHE_INDEX_KEY}:${cacheScope()}`);
        return Array.isArray(value) ? value : [];
    }

    function writeSharedLatestIndex(entries) {
        writeSharedCacheValue(`${SHARED_LATEST_CACHE_INDEX_KEY}:${cacheScope()}`, entries);
    }

    function clearSharedLatestCache(defenderId) {
        const id = String(defenderId);
        deleteSharedCacheValue(sharedLatestStorageKey(id));

        const index = readSharedLatestIndex();
        const next = index.filter(entry => String(entry?.id) !== id);
        if (next.length !== index.length) writeSharedLatestIndex(next);
    }

    function latestCacheEntryMaxAge(entry) {
        return entry?.data?.missing === true ? CFG.negativeCacheMaxAgeMs : CFG.cacheMaxAgeMs;
    }

    function isLatestCacheEntry(entry) {
        return entry
            && typeof entry === "object"
            && Number.isFinite(Number(entry.cachedAt))
            && (entry.data?.loadout || entry.data?.missing === true);
    }

    function getSharedLatestCacheEntry(defenderId) {
        const entry = readSharedCacheValue(sharedLatestStorageKey(defenderId));

        if (!isLatestCacheEntry(entry) || Date.now() - Number(entry.cachedAt) > latestCacheEntryMaxAge(entry)) {
            if (entry) clearSharedLatestCache(defenderId);
            return null;
        }

        return entry;
    }

    function setSharedLatestCacheEntry(defenderId, entry) {
        const id = String(defenderId);
        writeSharedCacheValue(sharedLatestStorageKey(id), entry);

        const next = [
            { id, cachedAt: entry.cachedAt },
            ...readSharedLatestIndex().filter(item => String(item?.id) !== id)
        ];
        const removed = next.slice(CFG.sharedLatestCacheLimit);

        for (const item of removed) {
            if (item?.id != null) deleteSharedCacheValue(sharedLatestStorageKey(item.id));
        }

        writeSharedLatestIndex(next.slice(0, CFG.sharedLatestCacheLimit));
    }

    function getLatestCacheEntry(defenderId) {
        const key = latestCacheKey(defenderId);
        const sessionEntry = sessionCacheGetEntry(key);
        const sharedEntry = getSharedLatestCacheEntry(defenderId);
        if (sharedEntry && (!isLatestCacheEntry(sessionEntry) || sharedEntry.cachedAt > sessionEntry.cachedAt)) {
            sessionCacheSetEntry(key, sharedEntry);
            return sharedEntry;
        }
        if (isLatestCacheEntry(sessionEntry) && Date.now() - sessionEntry.cachedAt <= latestCacheEntryMaxAge(sessionEntry)) {
            return sessionEntry;
        }

        if (sessionEntry) {
            try { sessionStorage.removeItem(key); } catch {}
        }

        if (!sharedEntry) return null;

        sessionCacheSetEntry(key, sharedEntry);
        return sharedEntry;
    }

    function cacheLatestLoadout(defenderId, data) {
        if (data?.loadout) data = { ...data, inserted_at: data.captured_at || data.updated_at || data.inserted_at };
        const entry = {
            cachedAt: Date.now(),
            data
        };

        sessionCacheSetEntry(latestCacheKey(defenderId), entry);
        setSharedLatestCacheEntry(defenderId, entry);
        return entry;
    }

    function cacheMissingLoadout(defenderId) {
        cacheLatestLoadout(defenderId, { missing: true });
    }

    function historyCacheKey(defenderId, limit) {
        return `askelads:v2:${cacheScope()}:history:${defenderId}:${limit}`;
    }

    function lastReportCacheKey(defenderId) {
        return `askelads:last-report:${defenderId}`;
    }

    function clearDefenderSessionCache(defenderId) {
        try { sessionStorage.removeItem(latestCacheKey(defenderId)); } catch {}
        clearSessionCachePrefix(`askelads:v2:${cacheScope()}:history:${defenderId}:`);
        clearSharedLatestCache(defenderId);
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
        STATE.viewGeneration++;
        STATE.selected = null;
        STATE.inlineHistory = [];
        STATE.historyIndex = 0;
        STATE.historyBusy = false;
        STATE.renderObserver?.disconnect();
        STATE.renderObserver = null;
    }

    function cleanupScriptOverlays() {
        W.document
            .querySelectorAll(".ll-slot-overlay, .ll-armor-overlay, .ll-armor-layer, .ll-armor-map")
            .forEach(el => el.remove());
        for (const [element, previous] of STATE.nativeStyles) {
            for (const [key, value] of Object.entries(previous)) {
                if (key === "usemap") value === null ? element.removeAttribute(key) : element.setAttribute(key, value);
                else element.style[key] = value;
            }
        }
        STATE.nativeStyles.clear();
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

    function wrapApiResponse(status, text, headers = "") {
        const data = parseJson(text);
        handleBackendWarning(data);

        return {
            ok: status >= 200 && status < 300,
            status,
            data,
            retryAfterMs: retryAfterDelay(headers)
        };
    }

    function retryAfterDelay(headers) {
        const value = typeof headers?.get === "function" ? headers.get("retry-after")
            : typeof headers === "string" ? headers.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim() : headers?.["retry-after"];
        if (!value) return 0;
        const seconds = Number(value);
        return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) - Date.now()) || 0);
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

            const apiKey = path === "/loadouts/report" ? getAPIKey() : null;
            if (apiKey) headers["X-Torn-Api-Key"] = apiKey;
        }

        if (bridge?.callHandler) {
            const handler = method === "GET" ? "PDA_httpGet" : "PDA_httpPost";
            const call = method === "GET"
                ? bridge.callHandler(handler, url, headers)
                : bridge.callHandler(handler, url, headers, body ? JSON.stringify(body) : "");

            return withRequestTimeout(call
                .then(r => wrapApiResponse(Number(r?.status || 0), String(r?.responseText || ""), r?.responseHeaders || r?.headers))
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
                    onload: (r) => resolve(wrapApiResponse(r.status, r.responseText, r.responseHeaders)),
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
            .then(async (r) => wrapApiResponse(r.status, await r.text(), r.headers))
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
        const rawClip = raw?.clip_size ?? raw?.clipSize ?? raw?.clipsize ?? raw?.clip;
        const clipSize = rawClip != null && rawClip !== "" && Number.isSafeInteger(Number(rawClip)) && Number(rawClip) >= 0 ? Number(rawClip) : null;

        return {
            item_id: itemId,
            item_name: raw?.name || raw?.item_name || raw?.itemName || "Unknown",
            damage: raw?.dmg != null ? Number(raw.dmg) : raw?.damage != null ? Number(raw.damage) : null,
            accuracy: raw?.acc != null ? Number(raw.acc) : raw?.accuracy != null ? Number(raw.accuracy) : null,
            rarity: mapGlowClassToRarity(raw?.glowClass || raw?.rarity || ""),
            ammo_type: extractAmmoType(raw),
            clip_size: clipSize,
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
            const id = new URL(W.location.href).searchParams.get(IS_PROFILE ? "XID" : "user2ID");
            return id && /^\d+$/.test(id) ? Number(id) : null;
        } catch {
            return null;
        }
    }

    function sameTargetId(a, b) {
        return a != null && b != null && String(a) === String(b);
    }

    function currentTargetId() {
        return urlTargetId() || extractUserId(STATE.attackData?.defenderUser);
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
        const latest = getLatestCacheEntry(defenderId)?.data || null;
        const latestFingerprint = latest?.loadout ? loadoutFingerprint(latest.loadout) : null;

        return {
            fingerprint,
            isKnownDuplicate: lastReport?.fingerprint === fingerprint || latestFingerprint === fingerprint
        };
    }

    function rememberReportedLoadout(defenderId, fingerprint) {
        sessionCacheSet(lastReportCacheKey(defenderId), { fingerprint });
    }

    function dedupeBackendRequest(requestKey, fn) {
        const key = cacheScope() + ":" + requestKey;
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

    async function fetchLatestFromBackend(targetId) {
        return dedupeBackendRequest(`latest:${targetId}`, async () => {
            const res = await authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/latest`, null);
            updateAuthStatus();

            if (res.ok && res.data?.ok && savedLoadoutIsValid(res.data?.loadout, targetId)) {
                res.data.loadout.inserted_at = res.data.loadout.captured_at || res.data.loadout.updated_at || res.data.loadout.inserted_at;
                return { ok: true, loadout: res.data.loadout };
            }

            const error = String(res.data?.error || res.data?.message || "");
            const confirmedMissing = res.status === 404 && error === "No loadout found";
            return { ok: confirmedMissing, loadout: null };
        });
    }

    async function fetchLatestFallbackFromHistory(targetId) {
        const cached = getCachedHistoryEntry(targetId, 1) || getCachedHistoryEntry(targetId, CFG.historyLimit);
        const result = cached
            ? { ok: true, history: cached.data }
            : await fetchHistoryResultFromBackend(targetId, 1);
        const row = result.history[0];

        if (!savedLoadoutIsValid(row, targetId)) return { ok: result.ok, loadout: null };

        return {
            ok: true,
            loadout: {
                loadout: row.loadout,
                inserted_at: row.observed_at || row.inserted_at
            }
        };
    }

    async function fetchLatestOrHistoryFallback(targetId) {
        const latest = await fetchLatestFromBackend(targetId);
        if (latest.loadout) return latest.loadout;

        const fallback = await fetchLatestFallbackFromHistory(targetId);
        if (fallback.loadout) return fallback.loadout;

        if (latest.ok && fallback.ok) cacheMissingLoadout(targetId);
        return null;
    }

    async function silentRevalidateLatest(targetId, renderedCacheEntry = null) {
        const authKey = getAPIKey();
        const generation = STATE.viewGeneration;
        const id = String(targetId);
        if (STATE.latestRevalidateInFlight.has(id)) return;
        STATE.latestRevalidateInFlight.add(id);

        try {
            const fresh = await fetchLatestOrHistoryFallback(targetId);
            if (authKey !== getAPIKey() || generation !== STATE.viewGeneration) return;
            if (!fresh?.loadout) return;

            const currentCached = renderedCacheEntry || getLatestCacheEntry(targetId);
            const previousData = currentCached?.data || null;

            cacheLatestLoadout(targetId, fresh);

            if (!previousData || !deepEqualJson(previousData, fresh)) {
                if (sameTargetId(currentTargetId(), id) && STATE.historyIndex === 0) {
                    STATE.loadoutRendered = false;
                    renderLoadout(fresh.loadout, fresh.inserted_at, true);
                }
            }
        } finally {
            STATE.latestRevalidateInFlight.delete(id);
        }
    }

    async function fetchAndRenderLoadout(force = false, forceRefresh = false) {
        const targetId = currentTargetId();
        if (!targetId) return;
        const generation = STATE.viewGeneration;
        const key = getAPIKey();
        const authorized = await ensureAuthorized(false);
        updateAuthStatus();
        if (!authorized || key !== getAPIKey() || generation !== STATE.viewGeneration) return;

        if (!forceRefresh) {
            const entry = getLatestCacheEntry(targetId);
            if (entry?.data?.missing === true) return;

            if (entry?.data?.loadout) {
                if (sameTargetId(currentTargetId(), targetId)) {
                    renderLoadout(entry.data.loadout, entry.data.inserted_at, force);
                }

                if ((Date.now() - entry.cachedAt) >= CFG.latestRevalidateAfterMs) {
                    void silentRevalidateLatest(targetId, entry);
                }
                return;
            }
        }

        const fresh = await fetchLatestOrHistoryFallback(targetId);
        if (key !== getAPIKey() || generation !== STATE.viewGeneration) return;
        if (fresh?.loadout) {
            cacheLatestLoadout(targetId, fresh);
            if (sameTargetId(currentTargetId(), targetId)) {
                renderLoadout(fresh.loadout, fresh.inserted_at, force);
            }
        }
    }

    function fetchAndRenderAutomaticLoadout() {
        const targetId = currentTargetId();
        if (!targetId || hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) {
            return Promise.resolve();
        }

        const key = String(targetId);
        const existing = STATE.automaticLoadoutTasks.get(key);
        if (existing) return existing;

        const task = (async () => {
            await waitForIdle();
            if (!sameTargetId(currentTargetId(), targetId)) return;
            if (hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;
            await fetchAndRenderLoadout(false, false);
        })().finally(() => STATE.automaticLoadoutTasks.delete(key));

        STATE.automaticLoadoutTasks.set(key, task);
        return task;
    }

    async function fetchHistoryResultFromBackend(targetId, limit = CFG.historyLimit) {
        return dedupeBackendRequest(`history:${targetId}:${limit}`, async () => {
            const res = await authorizedRequest("GET", `/loadouts/${encodeURIComponent(targetId)}/history?limit=${encodeURIComponent(limit)}`, null);
            updateAuthStatus();
            if (!res.ok || !res.data?.ok || !Array.isArray(res.data.history)) {
                return { ok: false, history: [] };
            }

            return { ok: true, history: res.data.history };
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

        const result = await fetchHistoryResultFromBackend(targetId, limit);
        if (result.ok) {
            sessionCacheSet(cacheKey, result.history);
            return result.history;
        }

        return [];
    }

    async function silentRevalidateHistory(targetId, limit = CFG.historyLimit) {
        const scope = cacheScope();
        const key = `${targetId}:${limit}`;
        if (STATE.historyRevalidateInFlight.has(key)) return;
        STATE.historyRevalidateInFlight.add(key);

        try {
            const result = await fetchHistoryResultFromBackend(targetId, limit);
            if (!result.ok || scope !== cacheScope()) return;
            sessionCacheSet(historyCacheKey(targetId, limit), result.history);
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
        return (areas.length > 1 ? areas[1] : null) || null;
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

    function deprioritizeImage(img) {
        img.decoding = "async";
        img.setAttribute("fetchpriority", "low");
    }

    function renderEmptySlot(wrapper, slot) {
        if (!wrapper || !SILHOUETTES[slot]) return;
        const existing = wrapper.querySelector(":scope > .ll-slot-overlay");
        if (existing?.dataset.fingerprint === "empty") return;
        existing?.remove();
        rememberNativeStyle(wrapper, ["position"]);
        wrapper.style.position = "relative";

        const overlay = wrapper.cloneNode(true);
        sanitizeOverlayClone(overlay);
        overlay.dataset.fingerprint = "empty";
        overlay.classList.add("ll-slot-overlay");
        overlay.classList.remove(...[...overlay.classList].filter(c => /^glow-/.test(c) || /emptySlot/i.test(c)));
        overlay.style.cssText += ";position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;box-sizing:border-box;";

        const border = queryFirst(overlay, ["[class*='itemBorder']"]);
        if (border) border.className = "itemBorder___u_Tpv glow-default___RmCvA";

        const img = queryFirst(overlay, ["[class*='weaponImage'] img", "img"]);
        if (img) {
            deprioritizeImage(img);
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
        const fingerprint = loadoutFingerprint(item) + preference("bonusLabels");
        const existing = wrapper.querySelector(":scope > .ll-slot-overlay");
        if (existing?.dataset.fingerprint === fingerprint) return;
        const retainedImage = existing?.querySelector("img");
        existing?.remove();

        const overlay = wrapper.cloneNode(true);
        sanitizeOverlayClone(overlay);
        overlay.dataset.fingerprint = fingerprint;
        overlay.classList.add("ll-slot-overlay");
        overlay.classList.remove(...[...overlay.classList].filter(c => /^glow-/.test(c) || /emptySlot/i.test(c)));
        overlay.style.cssText += ";position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;box-sizing:border-box;";
        rememberNativeStyle(wrapper, ["position"]);
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
            deprioritizeImage(img);
            img.src = `${base}.png`;
            img.srcset = `${base}.png 1x, ${base}@2x.png 2x`;
            img.alt = item.item_name || "";
            img.classList.remove("blank___W6Kh5");
            img.style.objectFit = "contain";
            if (retainedImage?.getAttribute("src") === img.getAttribute("src")) {
                retainedImage.alt = img.alt;
                img.replaceWith(retainedImage);
            }
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
        if (preference("bonusLabels") && item.bonuses?.length) {
            const labels = W.document.createElement("span");
            labels.className = "ll-bonus-labels";
            labels.textContent = item.bonuses.map(b => b.name).filter(Boolean).join(" · ");
            labels.style.cssText = "display:block;font-size:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            labels.title = item.bonuses.map(b => [b.name, b.description].filter(Boolean).join(": ")).join("\n");
            weaponName.appendChild(labels);
        }
        wrapper.setAttribute("aria-label", item.item_name || "Unknown");
    }

    function renderArmor(defenderArea, loadout) {
        const bodyImg =
            queryFirst(defenderArea, [
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

        if (!armoursWrap || !defenderArea.contains(armoursWrap)) return;

        const src = bodyImg.getAttribute("src") || "";
        const gender = /body-f[.@/]/.test(src) || src.includes("body-f") ? "f" : "m";

        const fingerprint = loadoutFingerprint(Object.fromEntries([4, 6, 7, 8, 9].map(slot => [slot, loadout[slot] || null]))) + gender;
        if (armoursWrap.dataset.llFingerprint === fingerprint && hasRenderedArmorOverlays(loadout)) return;
        armoursWrap.dataset.llFingerprint = fingerprint;
        const retainedImages = new Map([...armoursWrap.querySelectorAll(".ll-armor-layer img")].map(img => [img.getAttribute("src"), img]));
        armoursWrap.querySelectorAll(".ll-armor-layer").forEach(el => el.remove());
        defenderArea.querySelector(".ll-armor-map")?.remove();

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
            deprioritizeImage(img);
            img.src = `https://www.torn.com/images/v2/user_model/items/${item.item_id}${gender}.webp`;
            img.alt = "";

            img.onerror = () => {
                if (img.dataset.fallbackTried === "1") return;
                img.dataset.fallbackTried = "1";
                img.src = `https://www.torn.com/images/v2/items/model-items/${item.item_id}m.png`;
            };

            armor.appendChild(retainedImages.get(img.getAttribute("src")) || img);
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
        if (!STATE.nativeStyles.has(bodyImg)) STATE.nativeStyles.set(bodyImg, { usemap: bodyImg.getAttribute("usemap") });
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

        for (const delay of [500, 1500, 3000]) {
            const timer = W.setTimeout(() => {
                if (!STATE.loadoutRendered) return;
                if (hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;
                if (hasRenderedArmorOverlays(loadout)) return;

                clearRenderIntegrityTimers();
                STATE.loadoutRendered = false;
                renderLoadout(loadout, inserted, true, false);
            }, delay);

            STATE.renderIntegrityTimers.push(timer);
        }
    }

    function savedLoadoutIsValid(row, targetId) {
        if (!row || !row.loadout || typeof row.loadout !== "object" || Array.isArray(row.loadout)) return false;
        if (row.defender_id != null && !sameTargetId(row.defender_id, targetId)) return false;
        const slots = Object.entries(row.loadout);
        return slots.length > 0 && slots.length <= 9 && slots.every(([slot, item]) =>
            /^[1-9]$/.test(slot) && Number.isSafeInteger(Number(item?.item_id)) && Number(item.item_id) > 0 &&
            typeof item.item_name === "string");
    }

    function addViewerStyles() {
        if (W.document.getElementById("ll-viewer-styles")) return;
        const style = W.document.createElement("style");
        style.id = "ll-viewer-styles";
        style.textContent = [
            "#ll-profile{position:relative;clear:both;grid-column:1/-1;min-width:0;box-sizing:border-box;margin:10px 0;border:1px solid #6666;border-radius:7px;background:var(--default-bg-panel-color,#242424);color:var(--default-color,#ddd);font:12px/1.4 Arial,sans-serif}",
            "#ll-profile>summary{padding:9px 245px 9px 10px;cursor:pointer;font-weight:bold;min-height:18px;background:linear-gradient(#8882,#0001);border-radius:6px}",
            "#ll-profile .ll-profile-head{position:absolute;right:7px;top:4px;display:flex;align-items:center;gap:6px}",
            "#ll-profile .ll-profile-head #loadout-panel{padding:0;gap:0}",
            "#ll-profile .ll-profile-head #loadout-panel>button{padding:4px 7px!important;border-radius:5px!important;font-size:11px;box-shadow:none!important}",
            "#ll-profile .ll-profile-head .ll-inline-controls button{padding:3px 7px;font-size:11px}",
            "#ll-profile .ll-profile-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;padding:0 9px 6px}",
            "#ll-profile .ll-profile-column{min-width:0}",
            "#ll-profile .ll-profile-column+.ll-profile-column{border-left:1px solid #8883;margin-left:9px;padding-left:9px}",
            "#ll-profile .ll-profile-column h3{font:600 10px/1.4 Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase;opacity:.7;margin:7px 0 2px}",
            "#ll-profile .ll-profile-item{display:flex;align-items:center;gap:9px;min-width:0;min-height:49px;box-sizing:border-box;padding:6px 0;border-bottom:1px solid #8882;--ll-rarity:#777;--ll-tint:#7771}",
            "#ll-profile .ll-profile-item:last-child{border-bottom:0}",
            "#ll-profile .ll-profile-item[data-rarity='yellow']{--ll-rarity:#c5a338;--ll-tint:#be93193b}",
            "#ll-profile .ll-profile-item[data-rarity='orange']{--ll-rarity:#d77d30;--ll-tint:#d67a2440}",
            "#ll-profile .ll-profile-item[data-rarity='red']{--ll-rarity:#c84848;--ll-tint:#be333343}",
            "#ll-profile .ll-profile-thumb{display:flex;align-items:center;justify-content:center;flex:0 0 60px;height:35px;box-sizing:border-box;border:1px solid var(--ll-rarity);border-radius:5px;background:linear-gradient(160deg,#121212 25%,var(--ll-tint));box-shadow:inset 0 -5px 12px var(--ll-tint)}",
            "#ll-profile .ll-profile-item img{display:block;width:54px;height:31px;object-fit:contain}",
            "#ll-profile .ll-profile-info{min-width:0;flex:1;overflow-wrap:anywhere}",
            "#ll-profile .ll-profile-name{font-size:12px;font-weight:600;line-height:1.35}",
            "#ll-profile .ll-profile-info small{display:block;font-size:10px;line-height:1.45;opacity:.8}",
            "#ll-profile .ll-profile-bonuses{display:flex;flex-wrap:wrap;gap:2px 7px;margin-top:2px;font-size:10px}",
            "#ll-profile .ll-profile-bonus{border-bottom:2px solid var(--ll-rarity);line-height:1.4}",
            "#ll-profile .ll-profile-empty,#ll-profile .ll-profile-message{padding:8px 0;opacity:.75}",
            "#ll-profile .ll-profile-message{grid-column:1/-1}",
            "#ll-profile .ll-profile-age{font-weight:normal;opacity:.75;margin-left:8px}",
            "@media(max-width:600px){#ll-profile>summary{padding-right:10px}#ll-profile .ll-profile-head{position:static;padding:0 9px 5px;flex-wrap:wrap}#ll-profile .ll-profile-grid{grid-template-columns:minmax(0,1fr)}#ll-profile .ll-profile-column+.ll-profile-column{border-left:0;border-top:1px solid #8883;margin-left:0;padding-left:0;margin-top:3px}}",
            ".ll-inline-controls{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}",
            ".ll-inline-controls button{border:1px solid #8887;border-radius:5px;background:#7772;color:inherit;padding:4px 7px;cursor:pointer;font:inherit}",
            ".ll-inline-controls button:disabled{opacity:.45;cursor:default}",
            "#loadout-panel{flex-wrap:wrap;max-width:100%} #loadout-panel .ll-inline-controls{color:#d7c093}",
            "#loadout-retry-save[hidden]{display:none}"
        ].join("\n");
        (W.document.head || W.document.documentElement).appendChild(style);
    }

    function profilePanelAnchor() {
        const root = W.document.querySelector(".user-profile, #profileroot");
        // The first profile row holds User Information / Actions. Basic Information
        // can be much further down the page, so it is not the preferred anchor.
        let anchor = root?.querySelector(".profile-wrapper");
        while (anchor && anchor !== root) {
            const parent = anchor.parentElement;
            if (!parent || !root.contains(parent)) break;
            const parentStyle = W.getComputedStyle(parent);
            const anchorStyle = W.getComputedStyle(anchor);
            const safeFlow = ["block", "flow-root"].includes(parentStyle.display) ||
                (parentStyle.display === "flex" && parentStyle.flexDirection === "column");
            if (safeFlow && anchorStyle.float === "none" && !["absolute", "fixed"].includes(anchorStyle.position)) return anchor;
            // Never insert a full-width panel into a row of profile cards. If the
            // first wrapper is a column, place our panel after their common row.
            anchor = parent;
        }
        // Unfamiliar top-level grid/row layout: keep the panel available below
        // the profile instead of squeezing it into Torn's card columns.
        if (root?.parentElement) {
            const parentStyle = W.getComputedStyle(root.parentElement);
            if (["block", "flow-root"].includes(parentStyle.display) ||
                (parentStyle.display === "flex" && parentStyle.flexDirection === "column")) return root;
        }
        return null;
    }

    function ensureProfilePanel() {
        let panel = W.document.getElementById("ll-profile");
        if (panel) return panel;
        const anchor = profilePanelAnchor();
        if (!anchor) return null;
        addViewerStyles();
        panel = W.document.createElement("details");
        panel.id = "ll-profile";
        panel.open = getStoredValue("loadout_loader_profile_collapsed") !== "1";
        panel.innerHTML = '<summary>Saved loadout<span class="ll-profile-age"></span></summary><div class="ll-profile-head"></div><div class="ll-profile-grid"></div>';
        panel.addEventListener("toggle", () => setStoredValue("loadout_loader_profile_collapsed", panel.open ? "0" : "1"));
        anchor.after(panel);
        const { host, toastHost } = createPanel();
        panel.querySelector(".ll-profile-head").appendChild(host);
        if (!W.document.getElementById("loadout-toast-host")) W.document.body.appendChild(toastHost);
        mountInlineControls(panel.querySelector(".ll-profile-head"));
        return panel;
    }

    function renderProfileLoadout(loadout, inserted) {
        if (!IS_PROFILE || !preference("profile")) return;
        const targetId = currentTargetId();
        if (!savedLoadoutIsValid({ loadout }, targetId)) return;
        const panel = ensureProfilePanel();
        if (!panel) return;
        STATE.selected = { loadout, inserted_at: inserted, targetId };
        const stamp = panel.querySelector(".ll-profile-age");
        const time = Date.parse(inserted);
        stamp.textContent = Number.isFinite(time) ? " · " + relativeTime(Math.max(0, Date.now() - time)) : " · time unknown";
        stamp.title = Number.isFinite(time) ? "Observed " + new Date(time).toLocaleString() : "";
        const grid = panel.querySelector(".ll-profile-grid");
        grid.querySelector(".ll-profile-message")?.remove();
        for (const [group, title, slots] of [
            ["weapons", "Weapons", [1, 2, 3, 5]],
            ["armour", "Armour", [6, 4, 7, 8, 9]]
        ]) {
            let column = grid.querySelector('[data-group="' + group + '"]');
            if (!column) {
                column = W.document.createElement("section");
                column.className = "ll-profile-column";
                column.dataset.group = group;
                column.setAttribute("aria-label", title);
                const heading = W.document.createElement("h3");
                heading.textContent = title;
                const list = W.document.createElement("div");
                list.className = "ll-profile-list";
                column.append(heading, list);
                grid.appendChild(column);
            }
            const list = column.querySelector(".ll-profile-list");
            list.querySelector(".ll-profile-empty")?.remove();
            let position = 0;
            for (const slot of slots) {
                const item = loadout[slot];
                let card = list.querySelector('[data-slot="' + slot + '"]');
                if (!item) { card?.remove(); continue; }
                if (!card) {
                    card = W.document.createElement("div");
                    card.className = "ll-profile-item";
                    card.dataset.slot = slot;
                    const thumb = W.document.createElement("span");
                    thumb.className = "ll-profile-thumb";
                    const image = W.document.createElement("img");
                    image.loading = "lazy";
                    deprioritizeImage(image);
                    thumb.appendChild(image);
                    const info = W.document.createElement("div");
                    info.className = "ll-profile-info";
                    card.append(thumb, info);
                }
                // Keep slot order across history entries without recreating images.
                if (list.children[position] !== card) list.insertBefore(card, list.children[position] || null);
                position++;
                const fingerprint = loadoutFingerprint(item) + preference("bonusLabels");
                if (card.dataset.fingerprint === fingerprint) continue;
                card.dataset.fingerprint = fingerprint;
                const rarity = mapGlowClassToRarity(item.rarity);
                card.dataset.rarity = rarity || "standard";
                const thumb = card.querySelector(".ll-profile-thumb");
                thumb.title = rarity ? rarity[0].toUpperCase() + rarity.slice(1) + " rarity" : "No recorded rarity";
                const image = thumb.querySelector("img");
                const src = "https://www.torn.com/images/items/" + Number(item.item_id) + "/large.png";
                if (image.getAttribute("src") !== src) image.src = src;
                image.alt = item.item_name;
                const info = card.querySelector(".ll-profile-info");
                info.replaceChildren();
                const name = W.document.createElement("strong");
                name.className = "ll-profile-name";
                name.textContent = item.item_name;
                const stats = W.document.createElement("small");
                stats.textContent = profileItemStats(item, slot);
                info.append(name, stats);
                const bonuses = Array.isArray(item.bonuses) ? item.bonuses.filter(Boolean) : [];
                const mods = Array.isArray(item.mods) ? item.mods.filter(Boolean) : [];
                card.title = [...bonuses, ...mods].map(b => [b.name, b.description].filter(Boolean).join(": ")).join("\n");
                if (preference("bonusLabels")) {
                    if (bonuses.length) {
                        const line = W.document.createElement("div");
                        line.className = "ll-profile-bonuses";
                        for (const bonus of bonuses) {
                            const label = W.document.createElement("span");
                            label.className = "ll-profile-bonus";
                            label.textContent = profileBonusLabel(bonus);
                            label.title = bonus.description || bonus.name || "";
                            if (label.textContent) line.appendChild(label);
                        }
                        info.appendChild(line);
                    }
                    if (mods.length) {
                        const line = W.document.createElement("small");
                        line.textContent = mods.map(mod => mod.name).filter(Boolean).join(" · ");
                        info.appendChild(line);
                    }
                }
            }
            if (!position) {
                const empty = W.document.createElement("div");
                empty.className = "ll-profile-empty";
                empty.textContent = "No saved " + title.toLowerCase() + ".";
                list.appendChild(empty);
            }
        }
        mountInlineControls(panel.querySelector(".ll-profile-head"));
    }

    function profileItemStats(item, slot) {
        const labels = { 1: "Primary", 2: "Secondary", 3: "Melee", 4: "Body", 5: "Temporary", 6: "Head", 7: "Legs", 8: "Feet", 9: "Hands" };
        const parts = [labels[slot]];
        if ([1, 2, 3, 5].includes(Number(slot))) {
            if (item.damage != null && Number.isFinite(Number(item.damage))) parts.push("DMG " + formatFixed2(item.damage));
            if (item.accuracy != null && Number.isFinite(Number(item.accuracy))) parts.push("ACC " + formatFixed2(item.accuracy));
        }
        // Armour damage/accuracy fields are placeholders, not armour protection.
        // Never fabricate a protection stat from those zeros.
        return parts.filter(Boolean).join(" · ");
    }

    function profileBonusLabel(bonus) {
        const name = String(bonus.name || "").trim();
        const percent = firstNumeric(bonus.percent, bonus.percentage, bonus.bonus_percent);
        return name && percent !== undefined && !/%/.test(name) ? percent + "% " + name : name;
    }

    function mountInlineControls(parent) {
        if (!parent || IS_FACTION) return;
        addViewerStyles();
        let controls = parent.querySelector(":scope > .ll-inline-controls");
        if (!controls) {
            controls = W.document.createElement("span");
            controls.className = "ll-inline-controls";
            for (const [action, label, title] of [["older", "‹", "Older saved loadout"], ["newer", "›", "Newer saved loadout"], ["copy", "Copy", "Copy the displayed loadout"]]) {
                const button = W.document.createElement("button");
                button.type = "button";
                button.dataset.action = action;
                button.textContent = label;
                button.title = title;
                button.setAttribute("aria-label", title);
                button.onclick = () => action === "copy" ? void copySelectedLoadout(button) : void navigateHistory(action === "older" ? 1 : -1);
                controls.appendChild(button);
            }
            parent.appendChild(controls);
        }
        const native = IS_ATTACK && hasNativeDefenderLoadout(STATE.attackData?.defenderItems);
        controls.querySelector('[data-action="older"]').disabled = !STATE.selected || STATE.historyBusy || native ||
            (STATE.inlineHistory.length > 0 && STATE.historyIndex >= STATE.inlineHistory.length - 1);
        controls.querySelector('[data-action="newer"]').disabled = STATE.historyBusy || native || STATE.historyIndex === 0;
        controls.querySelector('[data-action="copy"]').disabled = !STATE.selected;
    }

    async function navigateHistory(direction) {
        if (STATE.historyBusy || !STATE.selected) return;
        const targetId = currentTargetId();
        const generation = STATE.viewGeneration;
        STATE.historyBusy = true;
        try {
            if (!STATE.inlineHistory.length) {
                const rows = await fetchHistoryForCurrentTarget();
                if (generation !== STATE.viewGeneration || !sameTargetId(targetId, currentTargetId())) return;
                STATE.inlineHistory = [STATE.selected, ...rows.filter(row => savedLoadoutIsValid(row, targetId)).map(row =>
                    ({ ...row, inserted_at: row.observed_at || row.inserted_at }))].filter((row, index, all) =>
                        index === 0 || loadoutFingerprint(row.loadout) !== loadoutFingerprint(all[index - 1].loadout));
            }
            STATE.historyIndex = Math.max(0, Math.min(STATE.inlineHistory.length - 1, STATE.historyIndex + direction));
            const row = STATE.inlineHistory[STATE.historyIndex];
            if (row) renderLoadout(row.loadout, row.inserted_at, true);
        } finally {
            STATE.historyBusy = false;
            W.document.querySelectorAll(".ll-inline-controls").forEach(node => mountInlineControls(node.parentElement));
        }
    }

    async function copySelectedLoadout(button) {
        const selected = STATE.selected;
        if (!selected || !sameTargetId(selected.targetId, currentTargetId())) return;
        const lines = ["Saved loadout [" + selected.targetId + "]", "Observed: " + (selected.inserted_at || "Unknown")];
        for (const item of Object.values(selected.loadout)) {
            lines.push(item.item_name + (item.damage != null ? " · DMG " + formatFixed2(item.damage) : "") +
                (item.accuracy != null ? " · ACC " + formatFixed2(item.accuracy) : "") +
                (item.bonuses?.length ? " · " + item.bonuses.map(b => [b.name, b.description].filter(Boolean).join(": ")).join("; ") : ""));
        }
        try {
            await W.navigator.clipboard.writeText(lines.join("\n"));
            button.textContent = "Copied";
            W.setTimeout(() => { button.textContent = "Copy"; }, 1500);
        } catch { W.prompt("Copy saved loadout", lines.join("\n")); }
    }

    function profileMessage(text) {
        const panel = ensureProfilePanel();
        const grid = panel?.querySelector(".ll-profile-grid");
        if (!grid || STATE.selected) return;
        grid.replaceChildren();
        const message = W.document.createElement("span");
        message.className = "ll-profile-message";
        message.textContent = text;
        grid.appendChild(message);
    }

    async function initProfileView() {
        if (!IS_PROFILE) return;
        const panel = ensureProfilePanel();
        if (!panel) return;
        if (!preference("profile")) { profileMessage("Profile loadouts are off. Enable them in Askelads settings."); return; }
        if (!getAPIKey()) { profileMessage("Add your key in Askelads settings to view saved equipment."); return; }
        profileMessage("Loading saved equipment…");
        await fetchAndRenderLoadout(true);
        if (!STATE.selected) profileMessage("No saved equipment available. Use Show Latest to retry.");
    }

    function cacheWarItems(items, missing) {
        const at = Date.now();
        const entries = [];
        for (const row of items) {
            if (!savedLoadoutIsValid(row, row.defender_id)) continue;
            const id = String(row.defender_id);
            const entry = { cachedAt: at, data: { ...row, inserted_at: row.captured_at || row.updated_at || row.inserted_at } };
            const existing = getLatestCacheEntry(id);
            if (existing?.data?.loadout && Date.parse(existing.data.inserted_at) > Date.parse(entry.data.inserted_at)) continue;
            writeSharedCacheValue(sharedLatestStorageKey(id), entry);
            sessionCacheSetEntry(latestCacheKey(id), entry);
            entries.push({ id, cachedAt: at });
        }
        for (const id of missing) {
            if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || getLatestCacheEntry(id)?.data?.loadout) continue;
            const entry = { cachedAt: at, data: { missing: true } };
            writeSharedCacheValue(sharedLatestStorageKey(id), entry);
            sessionCacheSetEntry(latestCacheKey(id), entry);
            entries.push({ id: String(id), cachedAt: at });
        }
        const ids = new Set(entries.map(entry => entry.id));
        const index = [...entries, ...readSharedLatestIndex().filter(entry => !ids.has(String(entry.id)))];
        for (const entry of index.slice(CFG.sharedLatestCacheLimit)) deleteSharedCacheValue(sharedLatestStorageKey(entry.id));
        writeSharedLatestIndex(index.slice(0, CFG.sharedLatestCacheLimit));
    }

    function normalizeRosterIds(values) {
        if (!Array.isArray(values) || !values.length || values.length > 100 ||
            values.some(id => !Number.isSafeInteger(id) || id <= 0)) return [];
        return [...new Set(values)].sort((a, b) => a - b);
    }

    function readWarPageMemberIds() {
        if (!IS_FACTION || !/^#\/war\/rank(?:[/?]|$)/.test(W.location.hash)) return [];
        const rosters = [];
        // Read only Torn's native enemy panel. Never scan the sidebar, our own
        // faction or another script's target list, and never modify Torn's DOM.
        for (const war of W.document.querySelectorAll(".faction-war")) {
            if (!war.querySelector(".your-faction")) continue;
            const enemy = war.querySelector(".enemy-faction");
            if (!enemy) continue;
            const ids = new Set();
            for (const link of enemy.querySelectorAll("a[href]")) {
                try {
                    const url = new URL(link.getAttribute("href"), W.location.href);
                    if (url.origin !== W.location.origin) continue;
                    const raw = url.pathname === "/profiles.php" ? url.searchParams.get("XID") :
                        url.pathname === "/page.php" && url.searchParams.get("sid") === "attack" ? url.searchParams.get("user2ID") : null;
                    const id = Number(raw);
                    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
                } catch {}
            }
            if (ids.size) rosters.push(normalizeRosterIds([...ids]));
        }
        return rosters.length === 1 ? rosters[0] : [];
    }

    function knownWarMemberIds() {
        const key = "loadout_war_roster_v2:" + cacheScope();
        const visibleIds = readWarPageMemberIds();
        if (visibleIds.length) {
            writeSharedCacheValue(key, { memberIds: visibleIds, observedAt: Date.now() });
            return visibleIds;
        }
        const saved = readSharedCacheValue(key);
        if (!saved || !Number.isFinite(saved.observedAt) || saved.observedAt > Date.now() ||
            Date.now() - saved.observedAt >= CFG.warRosterMaxAgeMs) return [];
        // The short-lived list is shared with profiles/attack tabs. Reading it
        // does not extend its life: only seeing the native roster does.
        return normalizeRosterIds(saved.memberIds);
    }

    function observeWarRoster() {
        if (!IS_FACTION || STATE.warRosterObserver || !W.document.body) return;
        const schedule = () => {
            if (STATE.warRosterTimer) return;
            STATE.warRosterTimer = W.setTimeout(() => {
                STATE.warRosterTimer = null;
                void warmWarCache();
            }, 500);
        };
        STATE.warRosterObserver = new MutationObserver(records => {
            const selector = ".faction-war, .enemy-faction, a[href*='profiles.php'], a[href*='user2ID']";
            if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
                node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) schedule();
        });
        STATE.warRosterObserver.observe(W.document.body, { childList: true, subtree: true });
        W.addEventListener("hashchange", schedule);
    }

    async function warmWarCache() {
        if (!preference("warCache") || STATE.warCacheBusy || !getAPIKey() || W.document.visibilityState === "hidden") return;
        STATE.warCacheBusy = true;
        try {
            // Background warming MUST NOT authenticate/renew a session: that
            // would itself call Torn. Normal sign-in/on-demand use owns auth.
            if (!tokenLooksUsable(getBackendToken())) {
                showWarCacheStatus("Preloading waits for your normal loadout sign-in.");
                return;
            }
            const scope = cacheScope();
            const memberIds = knownWarMemberIds();
            if (!memberIds.length) {
                showWarCacheStatus("Open the ranked-war roster to preload enemies. No extra Torn API calls.");
                return;
            }
            const key = "loadout_war_prefetch_v2:" + scope;
            const current = readSharedCacheValue(key);
            if (current?.retryAt > Date.now() || (current?.next > Date.now() &&
                memberIds.every(id => current.memberIds?.includes(id)))) { showWarCacheStatus(current.message); return; }
            // Short best-effort cross-tab lease; every request is to our cache only.
            writeSharedCacheValue(key, { retryAt: Date.now() + 20_000, message: "Warming saved enemy loadouts…" });
            const token = getBackendToken();
            const response = await apiRequest("POST", "/loadouts/batch", { memberIds }, { auth: true });
            if (scope !== cacheScope() || token !== getBackendToken() || !getAPIKey() || !preference("warCache")) return;
            let message = "Preload unavailable; individual lookups still work.";
            let success = false;
            if (response.ok && response.data?.ok && Array.isArray(response.data.items) && Array.isArray(response.data.missing)) {
                const wanted = new Set(memberIds);
                const items = response.data.items.filter(row => row && wanted.has(row.defender_id)).slice(0, 100);
                const missing = response.data.missing.filter(id => wanted.has(id)).slice(0, 100);
                cacheWarItems(items, missing);
                message = "Enemy cache: " + items.length + "/" + memberIds.length + " saved loadouts. No extra Torn API calls.";
                success = true;
            }
            writeSharedCacheValue(key, { memberIds, next: success ? Date.now() + CFG.warCacheRefreshMs : 0,
                retryAt: success ? 0 : Date.now() + 60_000, message });
            showWarCacheStatus(message);
        } catch {
            showWarCacheStatus("War cache unavailable; individual lookups still work.");
        } finally {
            STATE.warCacheBusy = false;
            W.clearTimeout(STATE.warCacheTimer);
            STATE.warCacheTimer = W.setTimeout(() => { void warmWarCache(); }, 60_000);
        }
    }

    function showWarCacheStatus(message) {
        const node = W.document.getElementById("loadout-war-cache-status");
        if (node) node.textContent = message || "";
    }

    function renderLoadout(loadout, inserted, force = false, scheduleIntegrity = true) {
        if (!savedLoadoutIsValid({ loadout }, currentTargetId())) return;
        if (IS_PROFILE) { renderProfileLoadout(loadout, inserted); return; }
        if (!IS_ATTACK || !preference("attack")) return;
        if (!loadout || (STATE.loadoutRendered && !force) || hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;
        const targetId = currentTargetId();
        const generation = STATE.viewGeneration;
        STATE.selected = { loadout, inserted_at: inserted, targetId };
        waitForElement("#defender_Primary, #defender_Secondary, #defender_Melee, #defender_Temporary, #attacker_Primary, [class*='playerArea']", () => {
            if (!sameTargetId(currentTargetId(), targetId) || generation !== STATE.viewGeneration ||
                hasNativeDefenderLoadout(STATE.attackData?.defenderItems) || !preference("attack")) return;
            const defenderArea = getDefenderArea();
            if (!defenderArea) return;

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
                rememberNativeStyle(modal, ["background", "backdropFilter", "webkitBackdropFilter", "pointerEvents"]);
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
            mountInlineControls(W.document.getElementById("loadout-panel"));
            watchAttackMount();
            if (scheduleIntegrity) scheduleRenderIntegrityChecks(loadout, inserted);
        });
    }

    function rememberNativeStyle(element, keys) {
        const original = STATE.nativeStyles.get(element) || {};
        for (const key of keys) if (!(key in original)) original[key] = element.style[key];
        STATE.nativeStyles.set(element, original);
    }

    function sanitizeOverlayClone(element) {
        for (const node of [element, ...element.querySelectorAll("*")]) {
            node.removeAttribute("id");
            for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
        }
    }

    function watchAttackMount() {
        const root = W.document.querySelector("#attack-root") || getDefenderArea()?.parentElement;
        if (!root || STATE.renderObserver?.root === root) return;
        STATE.renderObserver?.disconnect();
        const observer = new MutationObserver(records => {
            if (!STATE.selected || STATE.renderFrame || !preference("attack") || hasNativeDefenderLoadout(STATE.attackData?.defenderItems)) return;
            const relevant = records.some(record => !record.target.closest?.(".ll-slot-overlay, .ll-armor-map, #loadout-panel") &&
                [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
                    !node.matches?.(".ll-slot-overlay, .ll-armor-map, #loadout-panel")));
            if (!relevant) return;
            STATE.renderFrame = W.requestAnimationFrame(() => {
                STATE.renderFrame = null;
                const selected = STATE.selected;
                if (selected && sameTargetId(selected.targetId, currentTargetId())) renderLoadout(selected.loadout, selected.inserted_at, true, false);
                initPanel(true);
            });
        });
        observer.root = root;
        observer.observe(root, { childList: true, subtree: true });
        STATE.renderObserver = observer;
    }

    function queueCapture(raw) {
        const attackerId = extractUserId(raw?.attackerUser);
        const defenderId = extractUserId(raw?.defenderUser);
        const attackerName = extractUserName(raw?.attackerUser) || getPageAttackerName();
        const defenderName = extractUserName(raw?.defenderUser) || getPageDefenderName();
        const defenderFactionId = raw?.defenderUser?.factionID ?? null;
        const loadout = extractLoadoutFromAttackData(raw);

        if (!attackerId || !sameTargetId(defenderId, urlTargetId()) || !loadout || !getAPIKey()) return;
        const identity = `${defenderId}:${raw.fightID || "visible"}:${loadoutFingerprint(loadout)}`;
        if (STATE.captures.has(identity)) return;
        if (STATE.captures.size >= 32) {
            const old = [...STATE.captures].find(([, entry]) => entry.done || entry.failed);
            if (!old) return;
            STATE.captures.delete(old[0]);
        }

        const reportState = getKnownReportState(defenderId, loadout);
        const payload = {
            defender_id: defenderId,
            attacker_id: attackerId,
            defender_name: defenderName,
            attacker_name: attackerName,
            defender_faction_id: defenderFactionId,
            loadout,
            capture: { id: W.crypto.randomUUID(), observed_at: new Date().toISOString(), source: "native",
                fight_id: raw.fightID == null ? null : String(raw.fightID), script_version: SCRIPT_VERSION }
        };
        const entry = { payload, reportState, key: getAPIKey(), attempts: 0, busy: false, done: false, failed: false, timer: null };
        STATE.captures.set(identity, entry);
        whenVisible(() => { void waitForIdle().then(() => uploadCapture(entry)); });
    }

    async function uploadCapture(entry) {
        if (entry.done || entry.busy || entry.timer || entry.key !== getAPIKey()) return;
        if (W.document.visibilityState === "hidden") { whenVisible(() => { void uploadCapture(entry); }); return; }
        entry.busy = true;
        entry.attempts++;
        let res;
        try { res = await authorizedRequest("POST", "/loadouts/report", entry.payload); }
        catch { res = { ok: false, status: 0, data: null }; }
        entry.busy = false;
        if (entry.key !== getAPIKey()) return;
        updateAuthStatus();
        const defenderId = entry.payload.defender_id;
        if (res.ok && res.data?.ok) {
            entry.done = true;
            entry.failed = false;
            STATE.uploaded = true;
            clearDefenderSessionCache(defenderId);
            if (res.data.latest) {
                cacheLatestLoadout(defenderId, res.data.latest);
            }

            rememberReportedLoadout(defenderId, entry.reportState.fingerprint);

            const backendSaysDuplicate = res.data?.duplicate === true
                || res.data?.unchanged === true
                || res.data?.created === false
                || res.data?.inserted === false;

            if (!entry.reportState.isKnownDuplicate && !backendSaysDuplicate) {
                toastInfo("Loadout saved to the war chest.");
            }
        } else {
            const retryable = res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500;
            const delay = CFG.uploadRetryDelaysMs[entry.attempts - 1];
            if (retryable && delay != null && (res.retryAfterMs || 0) <= 5 * 60 * 1000) {
                entry.timer = W.setTimeout(() => {
                    entry.timer = null;
                    void uploadCapture(entry);
                }, Math.max(delay + Math.random() * delay * 0.2, res.retryAfterMs || 0));
            } else {
                entry.failed = true;
                toast("Loadout not saved. Use Retry save in Loadout settings.");
            }
        }
        updateCaptureStatus();
    }

    function updateCaptureStatus() {
        const button = W.document.getElementById("loadout-retry-save");
        if (button) button.hidden = ![...STATE.captures.values()].some(entry => entry.failed && entry.key === getAPIKey());
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
                Your <b style="color:#f4e7c2;">Torn Public API key</b> identifies you and your faction. Enemy preloading reuses player IDs already on the ranked-war page and reads our saved equipment cache only.
                It does <b>not</b> require full-access account data.
                Custom keys need user profile, not faction wars/members. Preloading makes no extra Torn API calls. Keys stay on this device and are sent over HTTPS to our backend when needed; captured equipment is stored and shared with authorized factions.
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

        panel._llPosition = () => {
            const rect = btn.getBoundingClientRect();
            const width = Math.min(IS_PDA ? 344 : 414, W.innerWidth - 20);
            panel.style.position = "fixed";
            panel.style.boxSizing = "border-box";
            panel.style.width = width + "px";
            panel.style.maxWidth = "calc(100vw - 20px)";
            panel.style.left = Math.max(10, Math.min(rect.left, W.innerWidth - width - 10)) + "px";
            const top = Math.max(10, Math.min(rect.bottom + 6, W.innerHeight / 3));
            panel.style.top = top + "px";
            panel.style.right = "auto";
            panel.style.transform = "none";
            panel.style.maxHeight = Math.max(100, W.innerHeight - top - 10) + "px";
        };
        let panelOpen = false;
        btn.onclick = (e) => {
            e.stopPropagation();
            panelOpen = !panelOpen;
            panel.style.display = panelOpen ? "block" : "none";
            if (panelOpen) panel._llPosition();
        };

        if (STATE.panelDismissHandler) W.document.removeEventListener("click", STATE.panelDismissHandler);
        STATE.panelDismissHandler = (e) => {
            if (panelOpen && !host.contains(e.target) && !panel.contains(e.target)) {
                panelOpen = false;
                panel.style.display = "none";
            }
        };
        W.document.addEventListener("click", STATE.panelDismissHandler);

        panel.querySelector("#loadout-close-panel-btn").onclick = () => {
            panelOpen = false;
            panel.style.display = "none";
        };

        panel.querySelector("#loadout-quiet-chk").onchange = (e) => {
            setStoredValue(CFG.store.quietToasts, e.target.checked ? "1" : "0");
        };

        const preferences = W.document.createElement("div");
        preferences.style.cssText = "display:grid;gap:7px;margin-top:10px;font-size:12px";
        for (const [name, label] of [["attack", "Show saved equipment in attacks"], ["profile", "Show saved equipment on profiles"],
            ["warCache", "Preload enemy faction (up to 100)"], ["bonusLabels", "Show bonus labels"]]) {
            const field = W.document.createElement("label");
            field.style.cssText = "display:flex;align-items:center;gap:7px";
            const input = W.document.createElement("input");
            input.type = "checkbox";
            input.checked = preference(name);
            input.dataset.preference = name;
            input.onchange = () => {
                setStoredValue(CFG.store[name], input.checked ? "1" : "0");
                if (name === "warCache") {
                    W.clearTimeout(STATE.warCacheTimer);
                    if (input.checked) void warmWarCache();
                    else showWarCacheStatus("Enemy preloading off.");
                } else if (name === "profile" && IS_PROFILE) {
                    if (!input.checked) {
                        STATE.selected = null;
                        W.document.querySelector("#ll-profile .ll-profile-grid")?.replaceChildren();
                    }
                    void initProfileView();
                } else if (name === "attack" && !input.checked) {
                    STATE.renderObserver?.disconnect();
                    STATE.renderObserver = null;
                    cleanupScriptOverlays();
                    STATE.loadoutRendered = false;
                } else {
                    void fetchAndRenderLoadout(true);
                }
            };
            field.append(input, W.document.createTextNode(label));
            preferences.appendChild(field);
        }
        const cacheStatus = W.document.createElement("small");
        cacheStatus.id = "loadout-war-cache-status";
        preferences.appendChild(cacheStatus);
        const retry = W.document.createElement("button");
        retry.id = "loadout-retry-save";
        retry.textContent = "Retry save";
        retry.hidden = true;
        retry.style.cssText = askeladsButtonStyle("steel");
        retry.onclick = () => {
            for (const entry of STATE.captures.values()) if (entry.failed && entry.key === getAPIKey()) {
                entry.attempts = 0;
                entry.failed = false;
                void uploadCapture(entry);
            }
            updateCaptureStatus();
        };
        preferences.appendChild(retry);
        panel.appendChild(preferences);
        if (IS_FACTION) {
            panel.querySelector("#loadout-show-history-btn").hidden = true;
            panel.querySelector("#loadout-show-latest-btn").hidden = true;
        }

        panel.querySelector("#loadout-show-history-btn").onclick = () => {
            showHistoryModal(false);
        };

        panel.querySelector("#loadout-show-latest-btn").onclick = () => {
            STATE.historyIndex = 0;
            STATE.inlineHistory = [];
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
                if (getAPIKey() !== key) { toast("The browser could not save this key. Check userscript storage permissions."); return; }
                resetAttackState();
                resetAuthorizationState();

                const ok = await ensureAuthorized(true);
                updateAuthStatus();

                if (ok) {
                    const nextMask = maskApiKey(key);
                    input.value = nextMask;
                    input.dataset.savedMask = nextMask;
                    toastInfo("Key saved. Welcome back to the war room.");
                    fetchAndRenderLoadout(true, true);
                    void warmWarCache();
                } else {
                    toast(STATE.authErrorMessage || "Failed to authenticate with backend.");
                }
            };

            panel.querySelector("#loadout-clear-btn").onclick = () => {
                input.value = "";
                input.dataset.savedMask = "";
                setStoredValue(CFG.store.apiKey, "");
                for (const entry of STATE.captures.values()) W.clearTimeout(entry.timer);
                STATE.captures.clear();
                resetAttackState();
                W.document.querySelector("#ll-profile .ll-profile-grid")?.replaceChildren();
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

    function cancelStartupLoadoutFallback() {
        if (!STATE.startupFallbackTimer) return;
        W.clearTimeout(STATE.startupFallbackTimer);
        STATE.startupFallbackTimer = null;
    }

    function scheduleStartupLoadoutFallback() {
        if (STATE.startupFallbackTimer || STATE.attackData || !getAPIKey()) return;

        STATE.startupFallbackTimer = W.setTimeout(() => {
            STATE.startupFallbackTimer = null;
            if (!STATE.attackData) void fetchAndRenderAutomaticLoadout();
        }, CFG.startupFallbackMs);
    }

    function processResponse(data, nativeResponse = false) {
        if (!data || typeof data !== "object") return;
        if (!data.attackerUser && !data.DB?.attackerUser) return;

        const db = data.DB || data;
        const newDefenderId = extractUserId(db?.defenderUser);
        if (!sameTargetId(newDefenderId, urlTargetId())) return;
        const oldDefenderId = extractUserId(STATE.attackData?.defenderUser);
        const hadFightID = !!STATE.attackData?.fightID;
        const isFirstData = !STATE.attackData;
        const hasNativeLoadout = hasNativeDefenderLoadout(db?.defenderItems);
        const targetChanged = !!(newDefenderId && oldDefenderId && newDefenderId !== oldDefenderId);

        cancelStartupLoadoutFallback();

        if (targetChanged) {
            resetAttackState();
        }

        STATE.attackData = db;

        if (!hadFightID && db.fightID && hasNativeLoadout) {
            cleanupScriptOverlays();
        }

        if (hasNativeLoadout && nativeResponse) {
            cleanupScriptOverlays();
            STATE.renderObserver?.disconnect();
            STATE.renderObserver = null;
            STATE.selected = null;
            STATE.inlineHistory = [];
            STATE.historyIndex = 0;
            W.document.querySelectorAll(".ll-inline-controls").forEach(node => mountInlineControls(node.parentElement));
            queueCapture(db);
        } else if ((isFirstData || targetChanged) && !STATE.loadoutRendered) {
            void fetchAndRenderAutomaticLoadout();
        }
    }

    function isAttackDataUrl(input) {
        try {
            const url = new URL(typeof input === "string" ? input : input?.url || input?.href, W.location.href);
            return url.origin === W.location.origin && url.searchParams.get("sid") === "attackData";
        } catch { return false; }
    }

    function isNativeAttackResponse(response) {
        return response?.ok === true && ["basic", "cors"].includes(response.type) && isAttackDataUrl(response.url);
    }

    if (IS_ATTACK && typeof W.fetch === "function" && !W.__askeladsLoadoutFetchPatched) {
        W.__askeladsLoadoutFetchPatched = true;
        const origFetch = W.fetch;

        W.fetch = function (...args) {
            if (!isAttackDataUrl(args[0])) {
                return origFetch.apply(this, args);
            }

            return origFetch.apply(this, args).then(response => {
                try {
                    void response.clone().text()
                        .then(text => processResponse(parseJson(text), isNativeAttackResponse(response)))
                        .catch(() => {});
                } catch {}

                return response;
            });
        };
    }

    function initPanel(fallback = false) {
        if (W.document.getElementById("loadout-panel")) return true;

        const labelsContainer = IS_ATTACK ? W.document.querySelector("[class*='labelsContainer']") : null;
        if (!labelsContainer && !fallback) return false;
        if (!labelsContainer && !W.document.body) return false;

        const { host, panel, toastHost } = createPanel();

        if (labelsContainer) {
            labelsContainer.insertBefore(host, labelsContainer.firstChild);
        } else {
            host.style.cssText += ";position:fixed;top:10px;right:10px;z-index:2147483646;";
            W.document.body.appendChild(host);
        }

        if (!W.document.getElementById("loadout-toast-host")) W.document.body.appendChild(toastHost);

        const apiKey = getAPIKey();
        if (!apiKey && IS_ATTACK) {
            panel.style.display = "block";
            panel._llPosition();
            toast("Enter your Public API key to join the war room.");
        } else {
            if (IS_ATTACK) scheduleStartupLoadoutFallback();
        }

        updateAuthStatus();
        return true;
    }

    const startPanelInit = () => {
        addViewerStyles();
        if (IS_PROFILE) {
            waitForElement(".user-profile .profile-wrapper, #profileroot .profile-wrapper", () => {
                void initProfileView();
                const root = W.document.querySelector(".user-profile, #profileroot");
                if (root && !STATE.profileMountObserver) {
                    STATE.profileMountObserver = new MutationObserver(() => {
                        if (STATE.selected && !sameTargetId(STATE.selected.targetId, currentTargetId())) resetAttackState();
                        if (!W.document.getElementById("ll-profile")) void initProfileView();
                    });
                    STATE.profileMountObserver.observe(root, { childList: true, subtree: false });
                }
            });
        } else if (IS_FACTION) {
            initPanel(true);
            observeWarRoster();
        } else {
            if (!initPanel()) waitForElement("[class*='labelsContainer'], #defender_Primary, [class*='playerArea']", () => initPanel(true));
            // Render a warm cache immediately; the fallback still covers slow mounts.
            if (getAPIKey()) void fetchAndRenderAutomaticLoadout();
        }
        if (getAPIKey()) void waitForIdle().then(warmWarCache);
        W.document.addEventListener("visibilitychange", () => {
            if (W.document.visibilityState === "visible") void warmWarCache();
        });
        W.addEventListener("resize", () => {
            const panel = W.document.getElementById("loadout-panel-inner");
            if (panel?.style.display === "block") panel._llPosition?.();
        });
        W.addEventListener("pagehide", () => {
            STATE.renderObserver?.disconnect();
            STATE.profileMountObserver?.disconnect();
            STATE.warRosterObserver?.disconnect();
            W.clearTimeout(STATE.warRosterTimer);
            W.clearTimeout(STATE.warCacheTimer);
            for (const entry of STATE.captures.values()) W.clearTimeout(entry.timer);
        });
    };

    if (W.document.readyState === "loading") {
        W.document.addEventListener("DOMContentLoaded", startPanelInit, { once: true });
    } else {
        startPanelInit();
    }
})();
