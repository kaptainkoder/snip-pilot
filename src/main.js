const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, clipboard, nativeImage, dialog, Menu, Tray, session, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Jimp, rgbaToInt } = require('jimp');

const isMac = process.platform === 'darwin';
const defaultShortcut = 'Command+2';

let mainWindow;
let overlayWindow;
let shelfWindow;
let editorWindow;
let scrollFrameWindow;
let scrollControlsWindow;
let editorForceClose = false;
let tray;
let shortcutRegistered = false;
let lastShortcutAt = 0;
let shortcutModeTimer = null;
let activeScrollSession = null;
let registeredShortcut = null;
let shortcut = defaultShortcut;
let captureDir;
let pendingDir;
let copiedDir;
let appConfig = {
  configured: false,
  shortcut: defaultShortcut,
  storageDir: null
};

function handleCaptureShortcut() {
  if (activeScrollSession) {
    finishManualScrollCapture().catch((error) => {
      dialog.showErrorBox('Scroll capture failed', error.message);
    });
    return;
  }

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

function defaultCaptureDir() {
  return process.env.SNIP_PILOT_STORAGE_DIR || path.join(app.getPath('documents'), 'Codex Projects', 'SnipPilotSnips');
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function applyConfig(config) {
  appConfig = {
    configured: Boolean(config.configured),
    shortcut: config.shortcut || defaultShortcut,
    storageDir: config.storageDir || defaultCaptureDir()
  };
  shortcut = appConfig.shortcut;
  captureDir = appConfig.storageDir;
  pendingDir = path.join(captureDir, 'Pending');
  copiedDir = path.join(captureDir, 'Copied');
}

async function loadConfig() {
  const fallback = {
    configured: false,
    shortcut: defaultShortcut,
    storageDir: defaultCaptureDir()
  };
  try {
    const data = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    applyConfig({ ...fallback, ...data });
  } catch {
    applyConfig(fallback);
  }
}

async function saveConfig(patch) {
  const next = {
    ...appConfig,
    ...patch,
    configured: patch.configured ?? true
  };
  applyConfig(next);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(configPath(), `${JSON.stringify(appConfig, null, 2)}\n`);
  await ensureStorage();
  registerCaptureShortcut();
  await refreshSnipViews();
  notifyConfig();
  return appInfo();
}

function appInfo() {
  return {
    shortcut,
    shortcutRegistered,
    setupRequired: !appConfig.configured,
    captureDir,
    pendingDir,
    copiedDir
  };
}

function notifyConfig() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:config', appInfo());
}

function registerCaptureShortcut() {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  shortcutRegistered = globalShortcut.register(shortcut, handleCaptureShortcut);
  registeredShortcut = shortcutRegistered ? shortcut : null;
  if (!shortcutRegistered) {
    console.error(`Failed to register shortcut ${shortcut}`);
  }
  notifyConfig();
  return shortcutRegistered;
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

function createScrollFrameWindow(rect) {
  if (scrollFrameWindow && !scrollFrameWindow.isDestroyed()) {
    scrollFrameWindow.close();
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = primaryDisplay.bounds;
  scrollFrameWindow = new BrowserWindow({
    x: bounds.x + Math.round(rect.left),
    y: bounds.y + Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    fullscreenable: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  hardenWindow(scrollFrameWindow);
  scrollFrameWindow.setIgnoreMouseEvents(true, { forward: true });
  scrollFrameWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  scrollFrameWindow.setContentProtection(true);
  scrollFrameWindow.loadFile(path.join(__dirname, 'renderer', 'scroll-frame.html'));
}

function createScrollControlsWindow(rect) {
  if (scrollControlsWindow && !scrollControlsWindow.isDestroyed()) {
    scrollControlsWindow.close();
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = primaryDisplay.bounds;
  const width = 520;
  const height = 94;
  const x = Math.round(Math.min(
    Math.max(bounds.x + rect.left + rect.width - width, bounds.x + 12),
    bounds.x + bounds.width - width - 12
  ));
  const belowY = bounds.y + rect.top + rect.height + 12;
  const aboveY = bounds.y + rect.top - height - 12;
  const y = Math.round(belowY + height <= bounds.y + bounds.height - 12 ? belowY : Math.max(bounds.y + 12, aboveY));

  scrollControlsWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
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

  hardenWindow(scrollControlsWindow);
  scrollControlsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  scrollControlsWindow.setContentProtection(true);
  scrollControlsWindow.loadFile(path.join(__dirname, 'renderer', 'scroll-controls.html'));
  scrollControlsWindow.webContents.once('did-finish-load', () => {
    sendScrollFrameState('Initial view captured. Scroll, then click Add below or Add above.');
  });
}

function closeScrollWindows() {
  if (scrollFrameWindow && !scrollFrameWindow.isDestroyed()) {
    scrollFrameWindow.close();
    scrollFrameWindow = null;
  }
  if (scrollControlsWindow && !scrollControlsWindow.isDestroyed()) {
    scrollControlsWindow.close();
    scrollControlsWindow = null;
  }
}

function showScrollWindows() {
  if (scrollFrameWindow && !scrollFrameWindow.isDestroyed()) {
    scrollFrameWindow.showInactive();
    scrollFrameWindow.moveTop();
  }
  if (scrollControlsWindow && !scrollControlsWindow.isDestroyed()) {
    scrollControlsWindow.show();
    scrollControlsWindow.moveTop();
    scrollControlsWindow.focus();
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pixelDifference(previous, xA, yA, next, xB, yB) {
  const previousIndex = (previous.bitmap.width * yA + xA) * 4;
  const nextIndex = (next.bitmap.width * yB + xB) * 4;
  const previousData = previous.bitmap.data;
  const nextData = next.bitmap.data;
  return (
    Math.abs(previousData[previousIndex] - nextData[nextIndex]) +
    Math.abs(previousData[previousIndex + 1] - nextData[nextIndex + 1]) +
    Math.abs(previousData[previousIndex + 2] - nextData[nextIndex + 2])
  ) / 3;
}

function rowDifference(previous, next, overlap, sampleStep, direction, previousCrop, nextCrop) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  let diff = 0;
  let count = 0;
  for (let y = 0; y < overlap; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const previousY = direction === 'up'
        ? previousCrop.top + y
        : previous.bitmap.height - previousCrop.bottom - overlap + y;
      const nextY = direction === 'up'
        ? next.bitmap.height - nextCrop.bottom - overlap + y
        : nextCrop.top + y;
      diff += pixelDifference(previous, x, previousY, next, x, nextY);
      count += 1;
    }
  }
  return count ? diff / count : Number.MAX_VALUE;
}

function frameDifference(previous, next) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  const height = Math.min(previous.bitmap.height, next.bitmap.height);
  const sampleStep = Math.max(10, Math.floor(width / 80));
  let diff = 0;
  let count = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      diff += pixelDifference(previous, x, y, next, x, y);
      count += 1;
    }
  }
  return count ? diff / count : 0;
}

function rowDifferenceAt(previous, next, previousY, nextY, sampleStep) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  let diff = 0;
  let count = 0;
  for (let x = 0; x < width; x += sampleStep) {
    diff += pixelDifference(previous, x, previousY, next, x, nextY);
    count += 1;
  }
  return count ? diff / count : Number.MAX_VALUE;
}

function detectStableEdge(previous, next, edge) {
  const height = Math.min(previous.bitmap.height, next.bitmap.height);
  const maxBand = Math.min(160, Math.floor(height * 0.24));
  const sampleStep = Math.max(8, Math.floor(Math.min(previous.bitmap.width, next.bitmap.width) / 90));
  let band = 0;
  let misses = 0;

  for (let offset = 0; offset < maxBand; offset += 4) {
    const previousY = edge === 'top' ? offset : previous.bitmap.height - 1 - offset;
    const nextY = edge === 'top' ? offset : next.bitmap.height - 1 - offset;
    const score = rowDifferenceAt(previous, next, previousY, nextY, sampleStep);
    if (score <= 8) {
      band = offset + 4;
      misses = 0;
    } else {
      misses += 1;
      if (misses >= 2) break;
    }
  }

  return band >= Math.min(16, Math.floor(height * 0.1)) ? band : 0;
}

function detectStableEdges(previous, next) {
  return {
    top: detectStableEdge(previous, next, 'top'),
    bottom: detectStableEdge(previous, next, 'bottom')
  };
}

function clampCrop(frame, crop) {
  const maxCrop = Math.max(0, frame.bitmap.height - 1);
  let top = Math.max(0, Math.min(crop.top, maxCrop));
  let bottom = Math.max(0, Math.min(crop.bottom, maxCrop));
  if (top + bottom > maxCrop) {
    const scale = maxCrop / (top + bottom);
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  return { top, bottom };
}

function contentHeight(frame, crop) {
  return Math.max(1, frame.bitmap.height - crop.top - crop.bottom);
}

function findOverlap(previous, next, direction, previousCrop = { top: 0, bottom: 0 }, nextCrop = { top: 0, bottom: 0 }) {
  const available = Math.min(contentHeight(previous, previousCrop), contentHeight(next, nextCrop));
  const maxOverlap = Math.max(1, Math.floor(available * 0.92));
  const minOverlap = Math.max(1, Math.floor(available * 0.05));
  const sampleStep = Math.max(8, Math.floor(Math.min(previous.bitmap.width, next.bitmap.width) / 90));
  let bestOverlap = minOverlap;
  let bestScore = Number.MAX_VALUE;
  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += sampleStep) {
    const score = rowDifference(previous, next, overlap, sampleStep, direction, previousCrop, nextCrop);
    if (score < bestScore) {
      bestScore = score;
      bestOverlap = overlap;
    }
  }
  return { overlap: bestOverlap, score: bestScore, direction };
}

function compareFramePair(previous, next) {
  const stable = detectStableEdges(previous, next);
  const down = findOverlap(
    previous,
    next,
    'down',
    { top: 0, bottom: stable.bottom },
    { top: stable.top, bottom: 0 }
  );
  const up = findOverlap(
    previous,
    next,
    'up',
    { top: stable.top, bottom: 0 },
    { top: 0, bottom: stable.bottom }
  );
  const winner = down.score <= up.score ? down : up;
  return { ...winner, stable };
}

function chooseScrollDirection(transitions) {
  const downScore = transitions
    .filter((item) => item.direction === 'down')
    .reduce((sum, item) => sum + Math.max(1, 255 - item.score), 0);
  const upScore = transitions
    .filter((item) => item.direction === 'up')
    .reduce((sum, item) => sum + Math.max(1, 255 - item.score), 0);
  return upScore > downScore ? 'up' : 'down';
}

function buildCropPlan(frames, transitions, direction) {
  const topStable = frames.map(() => 0);
  const bottomStable = frames.map(() => 0);

  transitions.forEach((transition, index) => {
    topStable[index] = Math.max(topStable[index], transition.stable.top);
    topStable[index + 1] = Math.max(topStable[index + 1], transition.stable.top);
    bottomStable[index] = Math.max(bottomStable[index], transition.stable.bottom);
    bottomStable[index + 1] = Math.max(bottomStable[index + 1], transition.stable.bottom);
  });

  const topmostIndex = direction === 'down' ? 0 : frames.length - 1;
  const bottommostIndex = direction === 'down' ? frames.length - 1 : 0;
  return frames.map((frame, index) => clampCrop(frame, {
    top: index === topmostIndex ? 0 : topStable[index],
    bottom: index === bottommostIndex ? 0 : bottomStable[index]
  }));
}

function cropPiece(frame, y, height) {
  const cropY = Math.max(0, Math.min(frame.bitmap.height - 1, Math.round(y)));
  const cropHeight = Math.max(1, Math.min(frame.bitmap.height - cropY, Math.round(height)));
  return frame.clone().crop({ x: 0, y: cropY, w: frame.bitmap.width, h: cropHeight });
}

async function stitchScrollFrames(framePaths, outputPath, preferredDirection = null) {
  const rawFrames = await Promise.all(framePaths.map((filePath) => Jimp.read(filePath)));
  const frames = [];
  rawFrames.forEach((frame) => {
    const previous = frames[frames.length - 1];
    if (!previous || frameDifference(previous, frame) > 2) frames.push(frame);
  });
  if (!frames.length) throw new Error('No scroll frames were captured.');

  if (frames.length === 1) {
    await frames[0].write(outputPath);
    return;
  }

  const transitions = [];
  for (let index = 1; index < frames.length; index += 1) {
    transitions.push(compareFramePair(frames[index - 1], frames[index]));
  }

  const direction = ['up', 'down'].includes(preferredDirection) ? preferredDirection : chooseScrollDirection(transitions);
  const crops = buildCropPlan(frames, transitions, direction);
  const pieces = [];

  if (direction === 'down') {
    for (let index = 0; index < frames.length; index += 1) {
      const crop = crops[index];
      let y = crop.top;
      let height = frames[index].bitmap.height - crop.top - crop.bottom;
      if (index > 0) {
        const transition = findOverlap(frames[index - 1], frames[index], direction, crops[index - 1], crop);
        y += transition.overlap;
        height -= transition.overlap;
      }
      if (height > 0) pieces.push(cropPiece(frames[index], y, height));
    }
  } else {
    for (let index = 0; index < frames.length; index += 1) {
      const crop = crops[index];
      const transition = index > 0
        ? findOverlap(frames[index - 1], frames[index], direction, crops[index - 1], crop)
        : { overlap: 0 };
      const height = frames[index].bitmap.height - crop.top - crop.bottom - transition.overlap;
      if (height > 0) pieces.unshift(cropPiece(frames[index], crop.top, height));
    }
  }

  if (!pieces.length) pieces.push(frames[0]);
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

async function startManualScrollCapture(rect) {
  await ensureStorage();
  const id = `scroll-${timestamp()}`;
  const paths = snipPaths('pending', id);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-pilot-scroll-'));

  activeScrollSession = {
    id,
    rect,
    outputPath: paths.imagePath,
    tempDir,
    framePaths: [],
    timer: null,
    direction: null,
    capturing: false,
    finishing: false
  };

  if (shelfWindow && !shelfWindow.isDestroyed()) shelfWindow.hide();
  createScrollFrameWindow(rect);
  createScrollControlsWindow(rect);
  await captureScrollFrame();
  sendScrollFrameState('Initial view captured. Scroll, then click Add below or Add above.');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', 'Scroll capture running. Scroll, then click Add below or Add above. Press Cmd+2 to finish.');
  }
}

function sendScrollFrameState(message = '') {
  if (!scrollControlsWindow || scrollControlsWindow.isDestroyed()) return;
  const count = activeScrollSession?.framePaths?.length || 0;
  scrollControlsWindow.webContents.send('scroll:state', {
    count,
    direction: activeScrollSession?.direction || null,
    message
  });
}

async function captureScrollFrame() {
  const session = activeScrollSession;
  if (!session || session.capturing || session.finishing) return null;
  session.capturing = true;
  try {
    if (scrollFrameWindow && !scrollFrameWindow.isDestroyed()) scrollFrameWindow.hide();
    if (scrollControlsWindow && !scrollControlsWindow.isDestroyed()) scrollControlsWindow.hide();
    await sleep(60);
    const framePath = path.join(session.tempDir, `frame-${String(session.framePaths.length).padStart(3, '0')}.png`);
    await captureRegionToFile(session.rect, framePath);
    session.framePaths.push(framePath);
    return framePath;
  } finally {
    showScrollWindows();
    session.capturing = false;
  }
}

async function captureScrollSegment(direction) {
  const session = activeScrollSession;
  if (!session || session.finishing) return { ok: false, error: 'No scrolling capture is active.' };
  if (!['up', 'down'].includes(direction)) return { ok: false, error: 'Choose the top or bottom edge to add a view.' };
  if (session.capturing) return { ok: false, error: 'A view is already being captured.' };
  if (session.direction && session.direction !== direction) {
    return { ok: false, error: `This capture is already extending ${session.direction}. Finish it before changing direction.` };
  }

  session.direction = direction;
  await captureScrollFrame();
  const message = direction === 'down'
    ? 'Added below. Scroll farther down, then drag the bottom edge again, or click Done.'
    : 'Added above. Scroll farther up, then drag the top edge again, or click Done.';
  sendScrollFrameState(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', `Scroll capture added ${session.framePaths.length} views.`);
  }
  return { ok: true, count: session.framePaths.length, direction: session.direction };
}

async function cancelManualScrollCapture() {
  const session = activeScrollSession;
  if (!session) return { ok: true };
  clearInterval(session.timer);
  activeScrollSession = null;
  closeScrollWindows();
  await fs.rm(session.tempDir, { recursive: true, force: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', 'Scrolling snip cancelled.');
  }
  return { ok: true };
}

async function finishManualScrollCapture() {
  const session = activeScrollSession;
  if (!session || session.finishing) return null;
  clearInterval(session.timer);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', 'Finishing scrolling snip...');
  }
  try {
    while (session.capturing) await sleep(50);
    session.finishing = true;
    closeScrollWindows();
    await stitchScrollFrames(session.framePaths, session.outputPath, session.direction);
    const metadata = await recordFromPath('pending', session.outputPath);
    await refreshSnipViews();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:status', 'Scrolling snip saved locally to Pending.');
    }
    return metadata;
  } finally {
    await fs.rm(session.tempDir, { recursive: true, force: true });
    activeScrollSession = null;
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
  await loadConfig();
  await ensureStorage();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ['file:', 'data:', 'devtools:'].some((protocol) => details.url.startsWith(protocol));
    callback({ cancel: !allowed });
  });
  createMainWindow();
  createShelfWindow();
  createTray();
  registerCaptureShortcut();
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

ipcMain.handle('app:get-info', () => appInfo());

ipcMain.handle('app:choose-storage-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose local snip storage folder',
    defaultPath: captureDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:update-config', async (_event, payload = {}) => saveConfig({
  configured: true,
  shortcut: payload.shortcut || shortcut,
  storageDir: payload.storageDir || captureDir
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
    await startManualScrollCapture(payload.rect);
  })().catch((error) => {
    dialog.showErrorBox('Scroll capture failed', `${error.message}\n\nScrolling capture records the selected region only when you drag the top or bottom edge, then stitches those selected views when you press Cmd+2 or Done.`);
  });
});

ipcMain.handle('scroll:capture-segment', (_event, direction) => captureScrollSegment(direction));

ipcMain.handle('scroll:finish', () => finishManualScrollCapture());

ipcMain.handle('scroll:cancel', () => cancelManualScrollCapture());

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
