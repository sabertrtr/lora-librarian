// LoRA Librarian desktop app: bundles + runs the Node service on loopback and
// opens the management UI in its own window. The browser extension talks to the
// SAME loopback server (http://127.0.0.1:PORT), so capture-from-Civitai still
// happens in the browser while review/manage lives here.
//
// Config (Civitai token, generated service token, download folder, port) lives
// in <userData>/config.json. Library data lives in <userData>/data/library.yaml.
const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const locations = require('../src/locations');

const DEFAULT_PORT = 8420;
let mainWin = null;

function userData() { return app.getPath('userData'); }
function configPath() { return path.join(userData(), 'config.json'); }
function loadConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; } }
function saveConfig(c) { fs.mkdirSync(userData(), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); }
function baseUrl(cfg) { return `http://127.0.0.1:${cfg.port || DEFAULT_PORT}`; }
function galleryUrl(cfg, route) { return `${baseUrl(cfg)}${route || '/collection'}?k=${encodeURIComponent(cfg.serviceToken)}`; }

// The app's two locations: its own data dir under userData, and the loras folder
// the user picked at setup (or the app's own downloads dir if they picked none).
function appLocations(cfg) {
  return locations.resolve({
    WILDCARDS_DIR: path.join(userData(), 'data'),
    DOWNLOAD_DIR: cfg.downloadDir || path.join(userData(), 'downloads'),
  });
}

// The install step, run ONLY from first-run setup (installed-locations audit
// 2026-10-04, electron/main.js:28): it used to mkdir and seed on every start,
// so a typo in the user-picked loras folder became a new empty folder Forge
// never scans. A picked folder must already exist; only the app's own default
// downloads dir is created. Throws a LocationError naming the path.
function installAppData(cfg) {
  return locations.install(appLocations(cfg), { createDownloadDir: !cfg.downloadDir });
}

// Point the server at userData paths + loopback plain-HTTP, then boot it. Env
// MUST be set before require('../src/server') because that module computes its
// paths at load time. Nothing is created here: the server checks the installed
// locations and refuses a missing one, and that refusal is shown to the user
// with the way back (setup again) instead of an empty library.
function startServer(cfg) {
  const locs = appLocations(cfg);
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(cfg.port || DEFAULT_PORT);
  process.env.WILDCARDS_DIR = locs.wildcardsDir;
  process.env.DOWNLOAD_DIR = locs.downloadDir;
  process.env.CIVITAI_TOKEN = cfg.civitaiToken || '';
  process.env.SERVICE_TOKEN = cfg.serviceToken;
  // Force plain HTTP on loopback (no cert): point TLS paths at a nonexistent file.
  process.env.TLS_KEY = path.join(userData(), '__no_cert__');
  process.env.TLS_CERT = path.join(userData(), '__no_cert__');

  try {
    require('../src/server').start();
    return true;
  } catch (e) {
    const r = dialog.showMessageBoxSync({
      type: 'error', title: 'LoRA Librarian cannot start',
      message: 'LoRA Librarian did not start because a data location is missing or wrong.',
      detail: `${e.message}\n\nRun setup again to install the missing location (existing files are kept), or Quit.`,
      buttons: ['Run setup again', 'Quit'], defaultId: 0, cancelId: 1
    });
    if (r === 0) openSetup(cfg); else app.quit();
    return false;
  }
}

function openMainWindow(cfg) {
  mainWin = new BrowserWindow({
    width: 1320, height: 880, title: 'LoRA Librarian', autoHideMenuBar: true,
    backgroundColor: '#14161a',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  buildMenu(cfg);
  // give the server a beat to bind before loading
  setTimeout(() => mainWin.loadURL(galleryUrl(cfg, '/collection')), 400);
}

function buildMenu(cfg) {
  const nav = (route) => () => mainWin && mainWin.loadURL(galleryUrl(cfg, route));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Pages', submenu: [
      { label: 'Collection', click: nav('/collection') },
      { label: 'Library', click: nav('/library') },
      { label: 'Curate', click: nav('/curate') },
      { label: 'Staging gallery', click: nav('/gallery') },
      { label: 'Categories', click: nav('/category-setup') },
      { label: 'Scan folder', click: nav('/setup') },
      { type: 'separator' },
      { label: 'Reload', role: 'reload' }, { label: 'DevTools', role: 'toggleDevTools' },
    ]},
    { label: 'Extension', submenu: [
      { label: 'Show browser-extension connection info…', click: () => showConnInfo(cfg) },
    ]},
  ]));
}

function showConnInfo(cfg) {
  const url = baseUrl(cfg);
  const r = dialog.showMessageBoxSync(mainWin, {
    type: 'info', title: 'Connect your browser extension',
    message: 'In the LoRA Librarian browser extension → Options, enter:',
    detail: `Service URL:\n  ${url}\n\nService token:\n  ${cfg.serviceToken}`,
    buttons: ['Copy token', 'Copy URL', 'Close'], defaultId: 2, cancelId: 2
  });
  if (r === 0) clipboard.writeText(cfg.serviceToken);
  else if (r === 1) clipboard.writeText(url);
}

// First-run: collect the Civitai token + download folder in a small window.
function openSetup(cfg) {
  const win = new BrowserWindow({
    width: 620, height: 560, title: 'LoRA Librarian — Setup', resizable: false, backgroundColor: '#14161a',
    webPreferences: { preload: path.join(__dirname, 'setup-preload.js'), contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'setup.html'));

  // Setup can be reopened after a failed start; a handler may only be registered once.
  for (const ch of ['setup:defaults', 'setup:pickFolder', 'setup:save']) ipcMain.removeHandler(ch);
  ipcMain.handle('setup:defaults', () => ({ serviceToken: cfg.serviceToken, baseUrl: baseUrl(cfg),
    downloadDir: cfg.downloadDir || '', hasCivitaiToken: !!cfg.civitaiToken }));
  ipcMain.handle('setup:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick your Stable Diffusion loras folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('setup:save', (_e, { civitaiToken, downloadDir }) => {
    // Reopened setup (after a refused start) may leave the token blank to keep it.
    cfg.civitaiToken = (civitaiToken || '').trim() || cfg.civitaiToken || '';
    if (downloadDir) cfg.downloadDir = downloadDir;
    // First-run install: the ONLY place the app creates its data locations.
    try { installAppData(cfg); }
    catch (e) { return { ok: false, error: e.message }; }
    saveConfig(cfg);
    if (startServer(cfg)) openMainWindow(cfg);
    win.close();
    return { ok: true };
  });
}

app.whenReady().then(() => {
  const cfg = loadConfig();
  if (!cfg.serviceToken) { cfg.serviceToken = crypto.randomBytes(16).toString('hex'); saveConfig(cfg); }
  if (!cfg.port) cfg.port = DEFAULT_PORT;
  if (!cfg.civitaiToken) openSetup(cfg);
  else if (startServer(cfg)) openMainWindow(cfg);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
