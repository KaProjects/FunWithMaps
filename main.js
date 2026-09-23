'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { extractPoints } = require('./parse');

const NAMES = ['Timeline.json', 'timeline.json'];

/**
 * The one place we look for the data file: the folder containing the app. On macOS
 * the executable sits inside Foo.app/Contents/MacOS, so the folder the user actually
 * sees is three levels up from process.execPath.
 */
function dataDir() {
  if (!app.isPackaged) return __dirname;
  const exeDir = path.dirname(process.execPath);
  const bundle = exeDir.match(/^(.*)[/\\][^/\\]+\.app[/\\]Contents[/\\]MacOS$/);
  return bundle ? bundle[1] : exeDir;
}

function findTimeline() {
  const dir = dataDir();
  for (const name of NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not there */ }
  }
  return null;
}

function load(file) {
  console.log(`[timeline] reading ${file}`);
  const started = Date.now();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pts = extractPoints(doc);
  if (!pts.total) throw new Error('No GPS points found in that file.');
  return {
    file,
    counts: pts.counts,
    total: pts.total,
    ms: Date.now() - started,
    // Transferred as ArrayBuffers via structured clone -- cheap even at 250k points.
    lat: pts.lat.buffer,
    lng: pts.lng.buffer,
    kind: pts.kind.buffer,
    time: pts.time.buffer,
  };
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (!app.isPackaged) {
    // Surface renderer errors in the terminal during development.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') {
        console.log(`[renderer:${e.level}] ${e.message}`);
      }
    });
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('timeline:load', (_e, explicitPath) => {
  const file = explicitPath || findTimeline();
  if (!file) {
    return { error: 'notfound', searched: dataDir() };
  }
  try {
    return load(file);
  } catch (err) {
    return { error: 'parse', message: err.message, file };
  }
});

ipcMain.handle('timeline:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose your Timeline export',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  try {
    return load(filePaths[0]);
  } catch (err) {
    return { error: 'parse', message: err.message, file: filePaths[0] };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
