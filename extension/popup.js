// Popup: live counts + quick actions. Reads go through apiFetch (config.js);
// actions (open gallery/library, stage) are delegated to the background page so
// tab-reuse + notifications stay in one place.
const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

function setMsg(text) { $("msg").textContent = text || ""; }

async function refresh() {
  setStatus("Checking service…");
  try {
    const [stagingRes, flaggedRes] = await Promise.all([
      apiFetch("/staging"),
      apiFetch("/flagged")
    ]);

    if (stagingRes.status === 401 || flaggedRes.status === 401) {
      setStatus("Unauthorized — check the token in Settings", "err");
      return;
    }
    if (!stagingRes.ok) { setStatus(`Service error (HTTP ${stagingRes.status})`, "err"); return; }

    const items = (await stagingRes.json()).items || [];
    const flagged = flaggedRes.ok ? ((await flaggedRes.json()).flagged || []) : [];

    const done = items.filter(i => i.downloaded).length;
    $("c-review").textContent = items.length - done;
    $("c-done").textContent = done;
    $("c-flagged").textContent = flagged.length;

    const cfg = await getConfig();
    setStatus(`Connected · ${cfg.baseUrl.replace(/^https?:\/\//, "")}`, "ok");
  } catch (e) {
    setStatus("Can't reach the service — is it running / cert trusted?", "err");
  }
}

$("open-gallery").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "openGallery" });
  window.close();
});
$("open-library").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "openLibrary" });
  window.close();
});
$("refresh").addEventListener("click", refresh);
$("options").addEventListener("click", () => browser.runtime.openOptionsPage());

async function stageManual() {
  const url = $("url").value.trim();
  if (!url) { setMsg("Paste a URL first."); return; }
  $("stage").disabled = true;
  setMsg("Staging…");
  try {
    const resp = await browser.runtime.sendMessage({ cmd: "stage", url });
    if (resp && resp.ok) {
      setMsg(`Staged: ${resp.record && resp.record.name ? resp.record.name : "ok"}`);
      $("url").value = "";
      refresh();
    } else {
      setMsg("Failed: " + ((resp && resp.error) || "unknown error"));
    }
  } catch (e) {
    setMsg("Failed: " + e.message);
  } finally {
    $("stage").disabled = false;
  }
}
$("stage").addEventListener("click", stageManual);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") stageManual(); });

refresh();
