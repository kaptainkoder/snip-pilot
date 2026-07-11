const { app, BrowserWindow, globalShortcut, ipcMain, screen, clipboard, nativeImage, dialog, Menu, Tray, session, shell, systemPreferences, powerMonitor } = require('electron');
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { stitchScrollFrames } = require('./scroll-stitch');

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
let shelfWatchdog = null;
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
  storageDir: null,
  clipboardClearMinutes: 0
};
let clipboardClearTimer = null;

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
  return process.env.SNIP_PILOT_STORAGE_DIR || path.join(app.getPath('documents'), 'SnipPilotSnips');
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function applyConfig(config) {
  appConfig = {
    configured: Boolean(config.configured),
    shortcut: config.shortcut || defaultShortcut,
    storageDir: config.storageDir || defaultCaptureDir(),
    clipboardClearMinutes: Number.isFinite(Number(config.clipboardClearMinutes)) ? Math.max(0, Number(config.clipboardClearMinutes)) : 0
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
    storageDir: defaultCaptureDir(),
    clipboardClearMinutes: 0
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
    copiedDir,
    clipboardClearMinutes: appConfig.clipboardClearMinutes,
    screenRecording: screenRecordingStatus()
  };
}

function notifyConfig() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:config', appInfo());
}

// If the user enabled clipboard auto-clear, wipe the system clipboard after the
// configured number of minutes. Best-effort: a later copy reschedules this.
function scheduleClipboardClear() {
  if (clipboardClearTimer) {
    clearTimeout(clipboardClearTimer);
    clipboardClearTimer = null;
  }
  const minutes = Number(appConfig.clipboardClearMinutes) || 0;
  if (minutes <= 0) return;
  clipboardClearTimer = setTimeout(() => {
    clipboardClearTimer = null;
    try { clipboard.clear(); } catch { /* clipboard may be unavailable */ }
  }, minutes * 60_000);
}

function registerCaptureShortcut() {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  shortcutRegistered = globalShortcut.register(shortcut, handleCaptureShortcut);
  registeredShortcut = shortcutRegistered ? shortcut : null;
  if (!shortcutRegistered) {
    console.error(`Failed to register shortcut ${shortcut}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:status', `Could not register the ${shortcut} shortcut — another app may already use it. Pick a different shortcut in Settings.`);
    }
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
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  const { width, height } = primaryDisplay.bounds;
  const outputPath = path.join(os.tmpdir(), `snip-pilot-display-${timestamp()}.png`);
  const region = [0, 0, width, height].map((value) => Math.max(0, Math.round(value * scaleFactor))).join(',');

  try {
    await runFile('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', region, outputPath]);
    const image = nativeImage.createFromPath(outputPath);
    if (image.isEmpty()) {
      throw new Error('macOS returned an empty display capture.');
    }

    return {
      dataUrl: image.toDataURL(),
      display: {
        bounds: primaryDisplay.bounds,
        size: primaryDisplay.size,
        scaleFactor
      }
    };
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

function screenRecordingStatus() {
  if (!isMac || !systemPreferences?.getMediaAccessStatus) return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

function screenRecordingHelp(action) {
  const status = screenRecordingStatus();
  return [
    `${action} needs macOS Screen Recording access for Snip Pilot.`,
    `macOS currently reports Screen Recording status: ${status}.`,
    'Open System Settings > Privacy & Security > Screen & System Audio Recording, enable Snip Pilot, then fully quit and reopen Snip Pilot.'
  ].join('\n\n');
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
    const message = `${error.message}\n\n${screenRecordingHelp('Taking a snip')}`;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', `Capture failed: ${error.message}`);
    dialog.showErrorBox('Capture failed', message);
    return { ok: false, error: error.message };
  }
}

async function startScrollSnip() {
  try {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const primary = screen.getPrimaryDisplay();
    if (cursorDisplay.id !== primary.id) {
      const message = 'Scrolling snip currently supports your primary display only. Move the window you want to capture to the main display, then try again.';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', message);
      dialog.showMessageBox({ type: 'info', title: 'Scrolling snip', message: 'Primary display only', detail: message });
      return { ok: false, error: message };
    }
    const capture = await capturePrimaryDisplay();
    createOverlayWindow(capture, 'scroll');
    return { ok: true };
  } catch (error) {
    const message = `${error.message}\n\n${screenRecordingHelp('Scrolling snip')}`;
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
  const { workArea } = screen.getPrimaryDisplay();
  const shelfBounds = shelfWindowBounds(workArea);
  shelfWindow = new BrowserWindow({
    ...shelfBounds,
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
  shelfWindow.setContentProtection(true);
  keepShelfAvailableOnCurrentWorkspace();
  shelfWindow.loadFile(path.join(__dirname, 'renderer', 'shelf.html'));
}

function shelfWindowBounds(workArea) {
  const width = 340;
  const height = Math.max(220, Math.min(680, workArea.height - 48));
  return {
    x: workArea.x + 12,
    y: workArea.y + 24,
    width,
    height
  };
}

function keepShelfAvailableOnCurrentWorkspace(reposition = false) {
  if (!shelfWindow || shelfWindow.isDestroyed()) return;
  if (reposition || !shelfWindow.isVisible()) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    shelfWindow.setBounds(shelfWindowBounds(display.workArea), false);
  }
  shelfWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  shelfWindow.setAlwaysOnTop(false);
  shelfWindow.setAlwaysOnTop(true, 'screen-saver');
}

function showShelfWindow() {
  if (!shelfWindow || shelfWindow.isDestroyed()) return;
  keepShelfAvailableOnCurrentWorkspace(true);
  if (!shelfWindow.isVisible()) shelfWindow.show();
  else shelfWindow.showInactive();
  shelfWindow.moveTop();
}

function startShelfWatchdog() {
  if (shelfWatchdog) return;
  shelfWatchdog = setInterval(() => {
    if (shelfWindow && !shelfWindow.isDestroyed() && shelfWindow.isVisible()) {
      keepShelfAvailableOnCurrentWorkspace();
      shelfWindow.moveTop();
    }
  }, 3000);
}

function stopShelfWatchdog() {
  if (!shelfWatchdog) return;
  clearInterval(shelfWatchdog);
  shelfWatchdog = null;
}

async function reassertShelfWindow() {
  const snips = await listSnips().catch(() => null);
  if (snips?.pending?.length) showShelfWindow();
}

function reassertShelfWindowSoon() {
  for (const delay of [100, 750, 2000]) {
    setTimeout(() => {
      reassertShelfWindow().catch(() => {});
    }, delay);
  }
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
  editorWindow.setContentProtection(true);
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
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) {
        error.message = [error.message, stderr].filter(Boolean).join('\n');
        reject(error);
      }
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
    if (snips.pending.length) {
      showShelfWindow();
      startShelfWatchdog();
    } else {
      stopShelfWatchdog();
      shelfWindow.hide();
    }
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

function trayImage() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  if (image.isEmpty()) return nativeImage.createEmpty();
  image.setTemplateImage(true);
  return image;
}

const UPDATE_FEED = 'https://api.github.com/repos/kaptainkoder/SnipPilot---macOS/releases/latest';
const RELEASES_PAGE = 'https://github.com/kaptainkoder/SnipPilot---macOS/releases/latest';
let updateCheckInFlight = false;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(UPDATE_FEED, {
      headers: { 'User-Agent': 'SnipPilot-UpdateCheck', Accept: 'application/vnd.github+json' },
      timeout: 8000
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GitHub returned HTTP ${res.statusCode}.`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error('Update response too large.'));
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Update check timed out.')));
    req.on('error', reject);
  });
}

// User-initiated only. Snip Pilot makes no background network calls; this runs
// exclusively when the user clicks "Check for Updates…".
async function checkForUpdates(interactive = true) {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const release = await fetchLatestRelease();
    const latest = release.tag_name || release.name || '';
    const current = app.getVersion();
    if (latest && compareVersions(latest, current) > 0) {
      const choice = dialog.showMessageBoxSync({
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Snip Pilot ${latest.replace(/^v/, '')} is available.`,
        detail: `You have ${current}. Open the download page in your browser?`
      });
      if (choice === 0) shell.openExternal(release.html_url || RELEASES_PAGE);
    } else if (interactive) {
      dialog.showMessageBox({
        type: 'info',
        title: 'You are up to date',
        message: `Snip Pilot ${current} is the latest version.`
      });
    }
  } catch (error) {
    if (interactive) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: `${error.message}\n\nThis is the only time Snip Pilot uses the network, and only when you ask it to.`
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Snip Pilot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New snip', click: startSnip },
    { label: 'Open library', click: ensureMainWindow },
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(async () => {
  await loadConfig();
  await ensureStorage();
  const allowedProtocols = app.isPackaged
    ? ['file:', 'data:']
    : ['file:', 'data:', 'devtools:'];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = allowedProtocols.some((protocol) => details.url.startsWith(protocol));
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
    reassertShelfWindowSoon();
  });

  powerMonitor.on('resume', reassertShelfWindowSoon);
  powerMonitor.on('unlock-screen', reassertShelfWindowSoon);
  screen.on('display-added', reassertShelfWindowSoon);
  screen.on('display-removed', reassertShelfWindowSoon);
  screen.on('display-metrics-changed', reassertShelfWindowSoon);
});

app.on('will-quit', () => {
  stopShelfWatchdog();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

ipcMain.handle('app:start-snip', startSnip);

ipcMain.handle('app:start-scroll-snip', startScrollSnip);

ipcMain.handle('app:get-info', () => appInfo());

ipcMain.handle('app:open-screen-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));

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
  storageDir: payload.storageDir || captureDir,
  clipboardClearMinutes: typeof payload.clipboardClearMinutes === 'number'
    ? Math.max(0, payload.clipboardClearMinutes)
    : appConfig.clipboardClearMinutes
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
  scheduleClipboardClear();
});

ipcMain.handle('snips:list', listSnips);

ipcMain.handle('snips:open-library', () => ensureMainWindow());

ipcMain.handle('snips:open-folder', () => shell.openPath(captureDir));

ipcMain.handle('snips:load-image', async (_event, filePath) => nativeImage.createFromPath(filePath).toDataURL());

ipcMain.handle('snips:copy-pending', async (_event, id) => {
  const paths = snipPaths('pending', id);
  clipboard.writeImage(nativeImage.createFromPath(paths.imagePath));
  scheduleClipboardClear();
  return moveRecord(id, 'pending', 'copied');
});

ipcMain.handle('snips:copy-image-by-path', async (_event, filePath) => {
  clipboard.writeImage(nativeImage.createFromPath(filePath));
  scheduleClipboardClear();
  return { ok: true };
});

ipcMain.handle('snips:save-pending', async (_event, id) => {
  const paths = snipPaths('pending', id);
  clipboard.writeImage(nativeImage.createFromPath(paths.imagePath));
  scheduleClipboardClear();
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
  scheduleClipboardClear();
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
