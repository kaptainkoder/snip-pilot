const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, clipboard, nativeImage, dialog, Menu, Tray, session, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Jimp, rgbaToInt } = require('jimp');

const isMac = process.platform === 'darwin';
const shortcut = 'Command+2';
const captureDir = process.env.SNIP_PILOT_STORAGE_DIR || path.join(app.getPath('documents'), 'SnipPilotSnips');
const pendingDir = path.join(captureDir, 'Pending');
const copiedDir = path.join(captureDir, 'Copied');

let mainWindow;
let overlayWindow;
let shelfWindow;
let editorWindow;
let editorForceClose = false;
let tray;
let shortcutRegistered = false;
let lastShortcutAt = 0;
let shortcutModeTimer = null;

function handleCaptureShortcut() {
  const now = Date.now();
  if (now - lastShortcutAt < 900) {
    clearTimeout(shortcutModeTimer);
    shortcutModeTimer = null;
    lastShortcutAt = 0;
    startScrollSnip();
    return;
  }
  lastShortcutAt = now;
  shortcutModeTimer = setTimeout(() => {
    shortcutModeTimer = null;
    lastShortcutAt = 0;
    startSnip();
  }, 280);
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

async function ensureStorage() {
  await Promise.all([captureDir, pendingDir, copiedDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.rm(path.join(captureDir, 'Discarded'), { recursive: true, force: true });
  await fs.rm(path.join(captureDir, 'Saved'), { recursive: true, force: true });
  await cleanupSidecars();
}

async function cleanupSidecars() {
  for (const dir of [pendingDir, copiedDir]) {
    const files = await fs.readdir(dir).catch(() => []);
    await Promise.all(files.filter((file) => file.endsWith('.json') || file.endsWith('.md')).map((file) => fs.unlink(path.join(dir, file)).catch(() => {})));
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: 'Snip Pilot',
    backgroundColor: '#f6f4ee',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  hardenWindow(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (isMac && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

async function capturePrimaryDisplay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor)
    }
  });

  const source = sources.find((item) => item.display_id === String(primaryDisplay.id)) || sources[0];
  if (!source) {
    throw new Error('No display source was available. macOS may need Screen Recording permission for this app.');
  }

  return {
    dataUrl: source.thumbnail.toDataURL(),
    display: {
      bounds: primaryDisplay.bounds,
      size: primaryDisplay.size,
      scaleFactor
    }
  };
}

async function startSnip() {
  try {
    await ensureStorage();
    const id = `snip-${timestamp()}`;
    const paths = snipPaths('pending', id);
    await runNativeSnip(paths.imagePath);
    const stat = await fs.stat(paths.imagePath).catch(() => null);
    if (!stat || stat.size === 0) {
      await fs.unlink(paths.imagePath).catch(() => {});
      return { ok: false, cancelled: true };
    }
    const metadata = await recordFromPath('pending', paths.imagePath);
    await refreshSnipViews();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.send('editor:new-snip', {
        ...metadata,
        imageDataUrl: nativeImage.createFromPath(paths.imagePath).toDataURL()
      });
    }
    return { ok: true, metadata };
  } catch (error) {
    const message = `${error.message}\n\nThis build uses macOS native screencapture. If it still fails, quit and reopen Snip Pilot after granting Screen Recording permission.`;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', `Capture failed: ${error.message}`);
    dialog.showErrorBox('Capture failed', message);
    return { ok: false, error: error.message };
  }
}

async function startScrollSnip() {
  try {
    const capture = await capturePrimaryDisplay();
    createOverlayWindow(capture, 'scroll');
    return { ok: true };
  } catch (error) {
    const message = `${error.message}\n\nScrolling capture needs Screen Recording permission for the region picker.`;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', `Scroll snip failed: ${error.message}`);
    dialog.showErrorBox('Scroll capture failed', message);
    return { ok: false, error: error.message };
  }
}

function runNativeSnip(outputPath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', outputPath], (error) => {
      if (error && error.code !== 1) reject(error);
      else resolve();
    });
  });
}

function createOverlayWindow(capture, mode = 'snip') {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }

  const { bounds } = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreenable: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  hardenWindow(overlayWindow);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('overlay:capture', { ...capture, mode });
  });
}

function createShelfWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  shelfWindow = new BrowserWindow({
    x: bounds.x + 12,
    y: bounds.y + 92,
    width: 340,
    height: Math.min(680, bounds.height - 160),
    minWidth: 340,
    maxWidth: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  hardenWindow(shelfWindow);
  shelfWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  shelfWindow.loadFile(path.join(__dirname, 'renderer', 'shelf.html'));
}

function createEditorWindow(record) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.close();
  }
  editorForceClose = false;

  editorWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Edit Snip',
    backgroundColor: '#111418',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  hardenWindow(editorWindow);
  editorWindow.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
  editorWindow.webContents.once('did-finish-load', async () => {
    editorWindow.webContents.send('editor:init', {
      ...record,
      imageDataUrl: nativeImage.createFromPath(record.imagePath).toDataURL()
    });
  });
  editorWindow.once('ready-to-show', () => editorWindow.show());
  editorWindow.on('close', (event) => {
    if (!editorForceClose) {
      event.preventDefault();
      editorWindow.webContents.send('editor:request-finish');
    }
  });
  editorWindow.on('closed', () => {
    editorWindow = null;
    editorForceClose = false;
    refreshSnipViews().catch(() => {});
  });
}

function ensureMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveDataUrl(filePath, dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function captureRegionToFile(rect, filePath) {
  const region = [rect.left, rect.top, rect.width, rect.height].map((value) => Math.max(0, Math.round(value))).join(',');
  await runFile('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', region, filePath]);
}

async function sendPageDown() {
  await runFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 121']);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pixelBrightness(image, x, y) {
  const index = (image.bitmap.width * y + x) * 4;
  const data = image.bitmap.data;
  return (data[index] + data[index + 1] + data[index + 2]) / 3;
}

function rowDifference(previous, next, overlap, sampleStep) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  const heightA = previous.bitmap.height;
  let diff = 0;
  let count = 0;
  for (let y = 0; y < overlap; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      diff += Math.abs(pixelBrightness(previous, x, heightA - overlap + y) - pixelBrightness(next, x, y));
      count += 1;
    }
  }
  return count ? diff / count : Number.MAX_VALUE;
}

function findOverlap(previous, next) {
  const maxOverlap = Math.floor(Math.min(previous.bitmap.height, next.bitmap.height) * 0.55);
  const minOverlap = Math.floor(Math.min(previous.bitmap.height, next.bitmap.height) * 0.12);
  const sampleStep = Math.max(8, Math.floor(previous.bitmap.width / 90));
  let bestOverlap = Math.floor(Math.min(previous.bitmap.height, next.bitmap.height) * 0.22);
  let bestScore = Number.MAX_VALUE;
  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += sampleStep) {
    const score = rowDifference(previous, next, overlap, sampleStep);
    if (score < bestScore) {
      bestScore = score;
      bestOverlap = overlap;
    }
  }
  return bestOverlap;
}

async function stitchScrollFrames(framePaths, outputPath) {
  const frames = await Promise.all(framePaths.map((filePath) => Jimp.read(filePath)));
  if (!frames.length) throw new Error('No scroll frames were captured.');
  const pieces = [frames[0]];
  for (let index = 1; index < frames.length; index += 1) {
    const overlap = findOverlap(frames[index - 1], frames[index]);
    const height = Math.max(1, frames[index].bitmap.height - overlap);
    pieces.push(frames[index].clone().crop({ x: 0, y: overlap, w: frames[index].bitmap.width, h: height }));
  }
  const width = Math.max(...pieces.map((piece) => piece.bitmap.width));
  const height = pieces.reduce((sum, piece) => sum + piece.bitmap.height, 0);
  const output = new Jimp({ width, height, color: rgbaToInt(255, 255, 255, 255) });
  let y = 0;
  pieces.forEach((piece) => {
    output.composite(piece, 0, y);
    y += piece.bitmap.height;
  });
  await output.write(outputPath);
}

async function captureScrollingRegion(rect) {
  await ensureStorage();
  const id = `scroll-${timestamp()}`;
  const paths = snipPaths('pending', id);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-pilot-scroll-'));
  const framePaths = [];
  try {
    if (shelfWindow && !shelfWindow.isDestroyed()) shelfWindow.hide();
    await sleep(350);
    const frameCount = 5;
    for (let index = 0; index < frameCount; index += 1) {
      const framePath = path.join(tempDir, `frame-${index}.png`);
      await captureRegionToFile(rect, framePath);
      framePaths.push(framePath);
      if (index < frameCount - 1) {
        await sendPageDown();
        await sleep(650);
      }
    }
    await stitchScrollFrames(framePaths, paths.imagePath);
    const metadata = await recordFromPath('pending', paths.imagePath);
    await refreshSnipViews();
    return metadata;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function snipPaths(bucket, id) {
  const dir = bucket === 'copied' ? copiedDir : pendingDir;
  return {
    dir,
    imagePath: path.join(dir, `${id}.png`)
  };
}

async function writeSnipRecord(bucket, record) {
  const paths = snipPaths(bucket, record.id);
  await fs.mkdir(paths.dir, { recursive: true });
  await saveDataUrl(paths.imagePath, record.imageDataUrl);
  return recordFromPath(bucket, paths.imagePath);
}

async function recordFromPath(bucket, imagePath) {
  const stat = await fs.stat(imagePath);
  const id = path.basename(imagePath, '.png');
  return {
    id,
    status: bucket,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    title: id,
    imagePath
  };
}

async function listBucket(bucket, dir) {
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.png')).map((file) => recordFromPath(bucket, path.join(dir, file)).catch(() => null)));
  return records.filter(Boolean).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

async function listSnips() {
  const [pending, copied] = await Promise.all([
    listBucket('pending', pendingDir),
    listBucket('copied', copiedDir)
  ]);
  return { pending, copied };
}

async function refreshSnipViews() {
  const snips = await listSnips();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:snips', snips);
  if (shelfWindow && !shelfWindow.isDestroyed()) {
    shelfWindow.webContents.send('shelf:snips', snips.pending);
    if (snips.pending.length) shelfWindow.showInactive();
    else shelfWindow.hide();
  }
  return snips;
}

async function moveRecord(id, fromBucket, toBucket, patch = {}) {
  const fromPaths = snipPaths(fromBucket, id);
  await fs.access(fromPaths.imagePath);
  const toPaths = snipPaths(toBucket, id);
  await fs.mkdir(toPaths.dir, { recursive: true });
  await fs.rename(fromPaths.imagePath, toPaths.imagePath);
  const updated = await recordFromPath(toBucket, toPaths.imagePath);
  await refreshSnipViews();
  return updated;
}

function createTray() {
  const trayImage = nativeImage.createEmpty();
  tray = new Tray(trayImage);
  tray.setToolTip('Snip Pilot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New snip', click: startSnip },
    { label: 'Open library', click: ensureMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(async () => {
  await ensureStorage();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ['file:', 'data:', 'devtools:'].some((protocol) => details.url.startsWith(protocol));
    callback({ cancel: !allowed });
  });
  createMainWindow();
  createShelfWindow();
  createTray();
  shortcutRegistered = globalShortcut.register(shortcut, handleCaptureShortcut);
  if (!shortcutRegistered) {
    console.error(`Failed to register shortcut ${shortcut}`);
  }
  await refreshSnipViews();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    ensureMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

ipcMain.handle('app:start-snip', startSnip);

ipcMain.handle('app:start-scroll-snip', startScrollSnip);

ipcMain.handle('app:get-info', () => ({
  shortcut,
  shortcutRegistered,
  captureDir,
  pendingDir,
  copiedDir
}));

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.on('overlay:cancel', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

ipcMain.on('overlay:snip', (_event, payload) => {
  (async () => {
    const id = `snip-${timestamp()}`;
    const metadata = await writeSnipRecord('pending', {
      id,
      imageDataUrl: payload.imageDataUrl,
      createdAt: new Date().toISOString(),
      title: 'Pending snip',
      notes: '',
      steps: [],
      markers: []
    });
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    await refreshSnipViews();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.send('editor:new-snip', { ...payload, ...metadata });
    }
  })().catch((error) => dialog.showErrorBox('Save failed', error.message));
});

ipcMain.on('overlay:scroll-region', (_event, payload) => {
  (async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', 'Capturing scrolling snip...');
    await captureScrollingRegion(payload.rect);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', 'Scrolling snip saved locally to Pending.');
  })().catch((error) => {
    dialog.showErrorBox('Scroll capture failed', `${error.message}\n\nScrolling capture may require Accessibility permission so Snip Pilot can send Page Down to the active app.`);
  });
});

ipcMain.handle('capture:save', async (_event, payload) => {
  const id = payload.id || `snip-${timestamp()}`;
  const metadata = await writeSnipRecord('copied', {
    id,
    imageDataUrl: payload.imageDataUrl,
    createdAt: payload.createdAt || new Date().toISOString(),
    title: payload.title,
    notes: payload.notes,
    steps: payload.steps,
    markers: payload.markers
  });
  if (payload.fromBucket === 'pending') {
    const pendingPaths = snipPaths('pending', id);
    await fs.unlink(pendingPaths.imagePath).catch(() => {});
  }
  await refreshSnipViews();
  return metadata;
});

ipcMain.handle('capture:copy-image', (_event, dataUrl) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
});

ipcMain.handle('snips:list', listSnips);

ipcMain.handle('snips:open-library', () => ensureMainWindow());

ipcMain.handle('snips:open-folder', () => shell.openPath(captureDir));

ipcMain.handle('snips:load-image', async (_event, filePath) => nativeImage.createFromPath(filePath).toDataURL());

ipcMain.handle('snips:copy-pending', async (_event, id) => {
  const paths = snipPaths('pending', id);
  clipboard.writeImage(nativeImage.createFromPath(paths.imagePath));
  return moveRecord(id, 'pending', 'copied');
});

ipcMain.handle('snips:copy-image-by-path', async (_event, filePath) => {
  clipboard.writeImage(nativeImage.createFromPath(filePath));
  return { ok: true };
});

ipcMain.handle('snips:save-pending', async (_event, id) => {
  const paths = snipPaths('pending', id);
  clipboard.writeImage(nativeImage.createFromPath(paths.imagePath));
  return moveRecord(id, 'pending', 'copied');
});

ipcMain.handle('snips:discard-pending', async (_event, id) => {
  await fs.unlink(snipPaths('pending', id).imagePath).catch(() => {});
  await refreshSnipViews();
  return { ok: true };
});

ipcMain.handle('snips:update-pending-image', async (_event, payload) => {
  const paths = snipPaths('pending', payload.id);
  await saveDataUrl(paths.imagePath, payload.imageDataUrl);
  const updated = await recordFromPath('pending', paths.imagePath);
  await refreshSnipViews();
  return updated;
});

ipcMain.handle('snips:open-editor', async (_event, payload) => {
  const bucket = payload.bucket === 'copied' ? 'copied' : 'pending';
  const paths = snipPaths(bucket, payload.id);
  await fs.access(paths.imagePath);
  createEditorWindow(await recordFromPath(bucket, paths.imagePath));
  return { ok: true };
});

ipcMain.handle('editor:save-image', async (_event, payload) => {
  const bucket = payload.bucket === 'copied' ? 'copied' : 'pending';
  const paths = snipPaths(bucket, payload.id);
  await saveDataUrl(paths.imagePath, payload.imageDataUrl);
  const updated = await recordFromPath(bucket, paths.imagePath);
  await refreshSnipViews();
  return updated;
});

ipcMain.handle('editor:finish', async (_event, payload) => {
  const bucket = payload.bucket === 'copied' ? 'copied' : 'pending';
  const paths = snipPaths(bucket, payload.id);
  await saveDataUrl(paths.imagePath, payload.imageDataUrl);
  clipboard.writeImage(nativeImage.createFromDataURL(payload.imageDataUrl));
  const updated = await recordFromPath(bucket, paths.imagePath);
  await refreshSnipViews();
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorForceClose = true;
    editorWindow.close();
  }
  return updated;
});

ipcMain.handle('editor:close', () => {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorForceClose = true;
    editorWindow.close();
  }
});

ipcMain.handle('capture:copy-agent-prompt', (_event, payload) => {
  const prompt = [
    'Use this screenshot context to help me modify or review the work.',
    '',
    `Title: ${payload.title || 'Untitled snip'}`,
    payload.imagePath ? `Image path: ${payload.imagePath}` : '',
    '',
    'Notes:',
    payload.notes || 'No notes provided.',
    '',
    'Steps / segments:',
    ...(payload.steps?.length ? payload.steps.map((step, index) => `${index + 1}. ${step}`) : ['No steps provided.']),
    '',
    'Markers:',
    ...(payload.markers?.length ? payload.markers.map((marker) => `- ${marker.type}: ${marker.text}`) : ['No markers provided.']),
    '',
    'Ask me clarifying questions if anything is ambiguous before making changes.'
  ].filter(Boolean).join('\n');
  clipboard.writeText(prompt);
  return prompt;
});
