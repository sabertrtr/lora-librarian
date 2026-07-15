// LoRA Librarian background -- works as a Firefox event page (background.scripts:
// [config.js, background.js]) AND a Chrome MV3 service worker (service_worker:
// background.js). In Chrome the SW only loads THIS file, so pull in config.js via
// importScripts; in Firefox's page context importScripts is undefined and
// config.js is already loaded by the scripts array, so the guard skips it.
if (typeof importScripts === "function") importScripts("config.js");

// `browser` + apiFetch/getConfig/pageUrl/deriveNameFromRaw come from config.js.
// Firefox has the richer browser.menus (onShown/refresh); Chrome only has
// contextMenus and no onShown -- we detect and fall back below.
const menus = browser.menus || browser.contextMenus;

const MENU_ROOT = "ll-root";
const MENU_ADD = "ll-add";
const MENU_REPLACE = "ll-replace";
const MENU_REPLACE_PREFIX = "ll-replace:";
const MENU_REPLACE_EMPTY = "ll-replace-empty";

// menuId -> flagged entry. Persisted to storage.session because a Chrome MV3
// service worker is torn down between events and would otherwise lose it before
// the click handler runs.
let flaggedByMenuId = {};

async function saveFlagged() {
  try { await browser.storage.session.set({ flaggedByMenuId }); } catch (e) { /* session storage absent */ }
}
async function loadFlagged() {
  try { const s = await browser.storage.session.get("flaggedByMenuId"); if (s && s.flaggedByMenuId) flaggedByMenuId = s.flaggedByMenuId; }
  catch (e) { /* ignore */ }
}

// Full rebuild: removeAll (so it's safe after a SW restart -- no duplicate ids)
// then recreate the skeleton + the live "replace flagged" children.
async function refreshMenus() {
  try { await menus.removeAll(); } catch (e) { /* ignore */ }
  menus.create({ id: MENU_ROOT, title: "LoRA Librarian", contexts: ["link"] });
  menus.create({ id: MENU_ADD, parentId: MENU_ROOT, title: "Add new LoRA", contexts: ["link"] });
  menus.create({ id: MENU_REPLACE, parentId: MENU_ROOT, title: "Replace a flagged entry", contexts: ["link"] });

  let flagged = [];
  try {
    const res = await apiFetch("/flagged");
    if (res.ok) flagged = (await res.json()).flagged || [];
  } catch (e) { console.error("lora-librarian: /flagged fetch failed:", e); }

  flaggedByMenuId = {};
  if (!flagged.length) {
    menus.create({ id: MENU_REPLACE_EMPTY, parentId: MENU_REPLACE, title: "No flagged entries", enabled: false, contexts: ["link"] });
  } else {
    flagged.forEach((f, i) => {
      const id = `${MENU_REPLACE_PREFIX}${i}`;
      flaggedByMenuId[id] = f;
      menus.create({ id, parentId: MENU_REPLACE, title: `${deriveNameFromRaw(f.rawLine)}${f.category ? "  ·  " + f.category : ""}`, contexts: ["link"] });
    });
  }
  await saveFlagged();
  if (menus.refresh) menus.refresh();   // Firefox: repaint an already-open menu
}

// Build on install/startup (both browsers).
browser.runtime.onInstalled.addListener(refreshMenus);
browser.runtime.onStartup.addListener(refreshMenus);

// Firefox: refresh right before the menu shows (always current). Chrome lacks
// onShown, so instead poll on an alarm to keep the flagged list reasonably fresh.
if (menus.onShown) {
  menus.onShown.addListener((info) => { if (info.contexts.includes("link")) refreshMenus(); });
} else if (browser.alarms) {
  browser.alarms.create("ll-refresh-flagged", { periodInMinutes: 3 });
  browser.alarms.onAlarm.addListener((a) => { if (a.name === "ll-refresh-flagged") refreshMenus(); });
}

menus.onClicked.addListener(async (info) => {
  const linkUrl = info.linkUrl;
  if (!linkUrl) return;
  const id = String(info.menuItemId);
  if (id === MENU_ADD) { await stageLink(linkUrl, null); return; }
  if (id.startsWith(MENU_REPLACE_PREFIX)) {
    if (!flaggedByMenuId[id]) await loadFlagged();     // SW may have restarted
    const entry = flaggedByMenuId[id];
    if (!entry) { notify("Replace failed", "That flagged entry is no longer available -- reopen the menu."); return; }
    await stageLink(linkUrl, entry);
  }
});

// Staging collects nothing up front; name/source/type/category/tags are edited
// later on the gallery card. Replace mode pins the flagged entry so accept
// rewrites it in place instead of appending.
async function stageLink(linkUrl, replaceEntry) {
  const body = { civitaiUrl: linkUrl };
  if (replaceEntry) {
    body.replaceLineIndex = replaceEntry.lineIndex;
    body.replaceLineText = replaceEntry.rawLine;
    body.replaceCategory = replaceEntry.category;
    body.replaceName = deriveNameFromRaw(replaceEntry.rawLine);
  }
  try {
    const res = await apiFetch("/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify("Staging failed", data.error || `HTTP ${res.status}`); return { ok: false, error: data.error || `HTTP ${res.status}` }; }
    const verb = replaceEntry ? "Staged (replaces " + deriveNameFromRaw(replaceEntry.rawLine) + ")" : "Staged ✓";
    notify(verb, `${data.name || "unnamed LoRA"} — click to open the gallery`);
    return { ok: true, record: data };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    notify("Staging failed", msg);
    return { ok: false, error: msg };
  }
}

// Reuse an already-open gallery/library tab (focus + reload) rather than
// spawning a new one. Query all tabs and match by URL prefix -- Chrome's
// tabs.query url match patterns reject a :port in the host, so filter manually.
async function openServicePage(routePath) {
  const url = await pageUrl(routePath);
  try {
    const cfg = await getConfig();
    const prefix = `${cfg.baseUrl}${routePath}`;
    const tabs = await browser.tabs.query({});
    const hit = (tabs || []).find((t) => t.url && t.url.startsWith(prefix));
    if (hit) {
      await browser.tabs.update(hit.id, { active: true, url });
      if (hit.windowId != null) await browser.windows.update(hit.windowId, { focused: true });
      return;
    }
  } catch (e) { /* fall through to opening a new tab */ }
  try { await browser.tabs.create({ url }); } catch (e) { console.error("lora-librarian: open tab failed:", e); }
}

const openGallery = () => openServicePage("/gallery");
const openLibrary = () => openServicePage("/library");

browser.notifications.onClicked.addListener(() => openGallery());

function notify(title, message) {
  try {
    browser.notifications.create({
      type: "basic",
      // Chrome REQUIRES an iconUrl for basic notifications; Firefox is fine with it too.
      iconUrl: browser.runtime.getURL("icons/icon-128.png"),
      title: `LoRA Librarian: ${title}`,
      message: message || ""
    });
  } catch (err) { console.warn("lora-librarian: notify failed:", err); }
}

// Popup -> background actions. Use sendResponse + `return true` so it works in
// BOTH Chrome (which ignores a returned Promise) and Firefox.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const cmd = msg && msg.cmd;
  const p = cmd === "openGallery" ? openGallery()
          : cmd === "openLibrary" ? openLibrary()
          : cmd === "stage" ? stageLink(msg.url, null)
          : Promise.resolve({ ok: false, error: "unknown command" });
  Promise.resolve(p).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
