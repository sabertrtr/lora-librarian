// Cross-browser namespace shim. Firefox exposes `browser` (promise-based);
// Chrome exposes `chrome` (promise-based on MV3 for the APIs we use). Declared
// ONCE here -- config.js loads before every other script (FF: first in
// background.scripts + first <script> in the popup/options HTML; Chrome:
// importScripts('config.js') at the top of the service worker), so the rest of
// the extension just uses `browser`.
const browser = globalThis.browser ?? globalThis.chrome;

// Shared config + API helper for background.js, popup.js, and options.js.
//
// All config lives in browser.storage.local, set on the OPTIONS page. NO SECRET
// ships in source: the token defaults to empty and MUST be entered by the user
// (it has to match SERVICE_TOKEN in the server's .env). baseUrl defaults to a
// same-machine (loopback) server; change it on the options page for a LAN/remote
// server. The stored value always wins over these defaults.
const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8420",
  token: ""
};

async function getConfig() {
  const stored = await browser.storage.local.get(["baseUrl", "token"]);
  return {
    baseUrl: (stored.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    token: stored.token || DEFAULTS.token
  };
}

async function setConfig({ baseUrl, token }) {
  const patch = {};
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).replace(/\/+$/, "");
  if (token !== undefined) patch.token = String(token).trim();
  await browser.storage.local.set(patch);
}

// One place that attaches the base URL + token header. Every call to the
// service goes through here so the secret lives in exactly one spot.
async function apiFetch(pathAndQuery, opts = {}) {
  const cfg = await getConfig();
  const headers = Object.assign({ "x-service-token": cfg.token }, opts.headers || {});
  return fetch(`${cfg.baseUrl}${pathAndQuery}`, { ...opts, headers });
}

// The gallery/library are capability URLs: the token rides in ?k= and the page
// replays it as x-service-token (see the server auth model). Built from config
// so the token literal never appears anywhere but storage/DEFAULTS.
async function pageUrl(routePath) {
  const cfg = await getConfig();
  return `${cfg.baseUrl}${routePath}?k=${encodeURIComponent(cfg.token)}`;
}

// Derive a human label from a composed library.yaml line for menu display.
// Lines are lora-first ("<lora:Stem:1>, Name, Source, tags..."), so the name is
// field[1]; findFlaggedLines' own name field returns the <lora:..> call for
// these, which is why we parse rawLine ourselves here.
function deriveNameFromRaw(rawLine) {
  if (!rawLine) return "(unknown)";
  const m = rawLine.match(/"([^"]*)"/);          // content inside the quotes
  const inner = m ? m[1] : rawLine;
  const fields = inner.split(",").map(s => s.trim());
  const first = fields[0] || "";
  const name = /^<lora:/i.test(first) ? (fields[1] || first) : first;
  return name || "(unknown)";
}
