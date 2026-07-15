// Options page: edit base URL + token (stored in browser.storage.local via
// setConfig). The token field starts blank and is only written if you type into
// it, so re-saving after a URL change won't wipe an existing token.
const $ = (id) => document.getElementById(id);

function result(text, cls) {
  const el = $("result");
  el.textContent = text;
  el.className = cls || "";
}

async function load() {
  const stored = await browser.storage.local.get(["baseUrl", "token"]);
  const cfg = await getConfig();
  $("baseUrl").value = cfg.baseUrl;
  // Show a placeholder if a token is already set; never render it in the field.
  $("token").placeholder = stored.token ? "•••••• (saved — leave blank to keep)" : "(required — must match SERVICE_TOKEN in the server .env)";
}

// localhost/127.0.0.1 are covered by the static host_permissions; any other
// server origin must be granted at runtime (optional_host_permissions). Must be
// called from a user gesture (a click) -- Firefox requires that for requests.
async function ensureOriginPermission(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (e) { return true; }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  try { return await browser.permissions.request({ origins: [url.origin + "/*"] }); }
  catch (e) { return false; }
}

$("save").addEventListener("click", async () => {
  const baseUrl = $("baseUrl").value.trim();
  const granted = await ensureOriginPermission(baseUrl);
  const token = $("token").value;               // blank = keep existing
  const patch = { baseUrl };
  if (token) patch.token = token;
  await setConfig(patch);
  $("token").value = "";
  await load();
  result(granted ? "Saved." : "Saved — but you didn't allow access to that server, so the extension can't reach it until you do.", granted ? "ok" : "err");
});

$("test").addEventListener("click", async () => {
  // Test against the values currently typed, not just what's saved, so you can
  // verify before committing. Temporarily compose a direct fetch.
  const baseUrl = ($("baseUrl").value.trim() || (await getConfig()).baseUrl).replace(/\/+$/, "");
  await ensureOriginPermission(baseUrl);   // grant access to a non-loopback server first
  const typed = $("token").value;
  const token = typed || (await getConfig()).token;
  result("Testing…");
  try {
    const res = await fetch(`${baseUrl}/staging`, { headers: { "x-service-token": token } });
    if (res.status === 401) return result("Reached the server, but the token was rejected (401).", "err");
    if (!res.ok) return result(`Server responded HTTP ${res.status}.`, "err");
    const n = ((await res.json()).items || []).length;
    result(`Connected — ${n} staged item${n === 1 ? "" : "s"}.`, "ok");
  } catch (e) {
    result("Couldn't reach the server. Running? Cert trusted in Firefox?", "err");
  }
});

load();
