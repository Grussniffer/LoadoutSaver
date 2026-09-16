# LoadoutSaver
Tampermonkey script to load / upload Enemy loadout to DB

Backend: https://loadout.grusmedia.no/loader-api

## 3.8.0

- Optional saved-equipment panel on Torn profiles: collapse, recent older/newer loadouts, copy.
- Bonus labels and independent profile/attack display preferences.
- Read-only attack response inspection; no response rewriting or private React actions.
- Stable image reuse and scoped recovery when Torn replaces the defender panel.
- Captures remain pending until acknowledged. Transient failures retry four times with backoff
  and Retry-After support; exhausted saves have a manual Retry save button.
- Synthetic responses are not uploaded. This detects common response rewriting, not malicious
  tampering by another extension.

### Enemy faction preloading

Enabled by default; configurable in Askelads settings. **No additional Torn API calls.**
On your faction's ranked-war page, the script reads up to 100 player IDs from Torn's already
loaded native enemy panel. One authenticated POST /loadouts/batch retrieves their saved
equipment from our backend cache. It never fetches wars, rosters or player profiles to preload.
Only equipment already captured in our database can be preloaded; it is not live equipment.

The roster IDs are shared with attack/profile tabs on the same browser/account for ten
minutes after last seeing the roster. Missing/expired/unsupported rosters simply skip
preloading; normal individual saved-loadout lookups remain available. The full faction can
only be warmed if Torn has actually rendered all its members; filtered/partial DOM lists
only preload those present. No broad sidebar or own-faction scanning is used.

An unchanged roster refreshes from our own backend every five minutes while visible.
New roster IDs can warm sooner. A cross-tab lease avoids ordinary duplicate requests,
and the equipment cache is bounded to 200 targets. Background preloading neither signs
in nor renews expired sessions (including on HTTP 401); normal sign-in is unchanged.
Custom keys need user profile only, not faction wars/members permissions.

### Deployment

1. Apply loadoutbackend/sql/20260916_atomic_loadout_captures.sql to the existing loadout DB.
2. Deploy the updated loadout backend.
3. Publish both userscript and metadata files together.

Do not publish the new backend before the migration. Existing history is retained.

### Tests

    node --check LoadoutRevealSupabase.user.js
    node --test tests/loader.test.cjs

For isolated browser fixtures, set LOADOUT_PLAYWRIGHT_MODULE to an installed Playwright
module and run node tests/browser.cjs. Defaults to installed Edge in headless mode;
LOADOUT_BROWSER_CHANNEL can select another installed channel. All external traffic is mocked.
