// Leon's Ledger — Electron main process
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { /* dev without deps */ }

let win;
const dataDir = () => app.getPath('userData');            // %APPDATA%\Leon's Ledger on Windows
const dataFile = () => path.join(dataDir(), 'ledger.json');
const backupDir = () => path.join(dataDir(), 'backups');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#fbd9e6',
    title: "Leon's Ledger",
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- Data storage (local JSON, atomic writes, daily backups) ----------
function readData() {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch (_) { return null; }
}

function writeData(state) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, dataFile());
  // one backup per day, keep the last 30
  try {
    fs.mkdirSync(backupDir(), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const b = path.join(backupDir(), `ledger-${today}.json`);
    fs.copyFileSync(dataFile(), b);
    const files = fs.readdirSync(backupDir()).filter((f) => f.startsWith('ledger-')).sort();
    files.slice(0, Math.max(0, files.length - 30)).forEach((f) => fs.unlinkSync(path.join(backupDir(), f)));
  } catch (_) { /* backups are best-effort */ }
  return true;
}

ipcMain.handle('data:load', () => readData());
ipcMain.handle('data:save', (_e, state) => writeData(state));
ipcMain.handle('data:openFolder', () => shell.openPath(dataDir()));

ipcMain.handle('data:export', async (_e, state) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export backup',
    defaultPath: `leons-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Ledger backup', extensions: ['json'] }]
  });
  if (canceled || !filePath) return false;
  const copy = JSON.parse(JSON.stringify(state));
  if (copy.settings) copy.settings.apiKey = ''; // never put the API key in a backup file
  fs.writeFileSync(filePath, JSON.stringify(copy, null, 2), 'utf8');
  return filePath;
});

ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import backup', properties: ['openFile'],
    filters: [{ name: 'Ledger backup', extensions: ['json'] }]
  });
  if (canceled || !filePaths.length) return null;
  return JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
});

// ---------- AI advisor (Anthropic Messages API) ----------
ipcMain.handle('ai:ask', async (_e, { apiKey, model, system, messages }) => {
  if (!apiKey) return { ok: false, error: 'No API key set.' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: model || 'claude-sonnet-5-5', max_tokens: 1200, system, messages })
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: (json.error && json.error.message) || `HTTP ${res.status}` };
    const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: 'Could not reach the AI service (' + err.message + '). Check your internet connection.' };
  }
});

// ---------- Updates ----------
function sendUpdate(status, extra) { if (win) win.webContents.send('update:status', Object.assign({ status }, extra || {})); }

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', (i) => sendUpdate('available', { version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('none'));
  autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate('ready', { version: i.version }));
  autoUpdater.on('error', (err) => sendUpdate('error', { message: String(err && err.message || err).split('\n')[0] }));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) { sendUpdate('dev'); return false; }
  try { await autoUpdater.checkForUpdates(); return true; } catch (e) { sendUpdate('error', { message: e.message }); return false; }
});
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

// ---------- App lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); setupUpdater(); });
  app.on('window-all-closed', () => app.quit());
}
