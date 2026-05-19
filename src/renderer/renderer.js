const statusEl = document.getElementById('status');
const shortcutText = document.getElementById('shortcutText');
const storagePath = document.getElementById('storagePath');
const previewImage = document.getElementById('previewImage');
const emptyState = document.getElementById('emptyState');
const pendingList = document.getElementById('pendingList');
const copiedList = document.getElementById('copiedList');
const editBtn = document.getElementById('editBtn');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const discardBtn = document.getElementById('discardBtn');

let currentSnip = null;
let currentBucket = null;
let latestSnips = { pending: [], copied: [] };
let activeRange = 'all';

function setStatus(message) {
  statusEl.textContent = message;
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek() {
  const date = startOfToday();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date;
}

function startOfMonth() {
  const date = startOfToday();
  date.setDate(1);
  return date;
}

function dateLabel(value) {
  const date = new Date(value);
  const today = startOfToday();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function inRange(snip) {
  const value = new Date(snip.updatedAt || snip.createdAt);
  if (activeRange === 'today') return value >= startOfToday();
  if (activeRange === 'week') return value >= startOfWeek();
  if (activeRange === 'month') return value >= startOfMonth();
  return true;
}

function setActionState() {
  const hasSelection = Boolean(currentSnip);
  const isPending = currentBucket === 'pending';
  editBtn.disabled = !hasSelection;
  copyBtn.disabled = !hasSelection;
  saveBtn.disabled = !isPending;
  discardBtn.disabled = !isPending;
}

async function selectSnip(snip, bucket) {
  currentSnip = snip;
  currentBucket = bucket;
  previewImage.src = await window.snipPilot.loadSnipImage(snip.imagePath);
  previewImage.style.display = 'block';
  emptyState.style.display = 'none';
  setActionState();
  setStatus(`${bucket[0].toUpperCase() + bucket.slice(1)} snip selected: ${snip.imagePath}`);
  renderLibrary(latestSnips);
}

function createThumb(snip, bucket) {
  const item = document.createElement('button');
  item.className = `thumb ${currentSnip?.id === snip.id ? 'active' : ''}`;
  item.title = snip.imagePath;
  item.addEventListener('click', () => selectSnip(snip, bucket));

  const image = document.createElement('img');
  image.alt = snip.title || 'Snip';
  window.snipPilot.loadSnipImage(snip.imagePath).then((dataUrl) => {
    image.src = dataUrl;
  });

  const text = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = snip.title || 'Snip';
  const date = document.createElement('span');
  date.textContent = formatTime(snip.createdAt);
  text.append(title, date);

  item.append(image, text);
  return item;
}

function renderList(container, items, bucket) {
  container.innerHTML = '';
  const filtered = items.filter(inRange);
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'None';
    container.appendChild(empty);
    return;
  }

  const grouped = new Map();
  filtered.slice(0, 60).forEach((snip) => {
    const label = dateLabel(snip.updatedAt || snip.createdAt);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(snip);
  });

  grouped.forEach((groupItems, label) => {
    const group = document.createElement('section');
    group.className = 'group';
    const title = document.createElement('div');
    title.className = 'groupTitle';
    title.textContent = label;
    group.appendChild(title);
    groupItems.forEach((snip) => group.appendChild(createThumb(snip, bucket)));
    container.appendChild(group);
  });
}

function renderLibrary(snips) {
  latestSnips = snips || latestSnips;
  renderList(pendingList, latestSnips.pending || [], 'pending');
  renderList(copiedList, latestSnips.copied || [], 'copied');
  setActionState();
}

async function refreshLibrary(selectNewest = false) {
  const snips = await window.snipPilot.listSnips();
  renderLibrary(snips);
  if (selectNewest && snips.pending?.[0]) {
    await selectSnip(snips.pending[0], 'pending');
  }
}

document.getElementById('captureBtn').addEventListener('click', async () => {
  setStatus('Starting macOS snip selector...');
  const result = await window.snipPilot.startSnip();
  if (result?.ok) {
    await refreshLibrary(true);
    setStatus('Snip saved locally to Pending.');
  } else if (result?.cancelled) {
    setStatus('Snip cancelled.');
  } else if (result?.error) {
    setStatus(`Snip failed: ${result.error}`);
  }
});

document.getElementById('scrollCaptureBtn').addEventListener('click', async () => {
  setStatus('Select the fixed scroll area. Scroll normally, then press Cmd+2 to finish.');
  const result = await window.snipPilot.startScrollSnip();
  if (result?.error) setStatus(`Scroll snip failed: ${result.error}`);
});

document.getElementById('refreshBtn').addEventListener('click', () => refreshLibrary(false));
document.getElementById('openFolderBtn').addEventListener('click', () => window.snipPilot.openFolder());
document.getElementById('quitBtn').addEventListener('click', () => window.snipPilot.quit());
editBtn.addEventListener('click', () => {
  if (!currentSnip) return;
  window.snipPilot.openEditor({ id: currentSnip.id, bucket: currentBucket });
});

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    activeRange = button.dataset.range;
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
    renderLibrary(latestSnips);
  });
});

copyBtn.addEventListener('click', async () => {
  if (!currentSnip) return;
  if (currentBucket === 'pending') {
    await window.snipPilot.copyPending(currentSnip.id);
    setStatus('Snip copied to clipboard and moved to Copied.');
    currentSnip = null;
    currentBucket = null;
    previewImage.style.display = 'none';
    emptyState.style.display = 'block';
  } else {
    await window.snipPilot.copyImageByPath(currentSnip.imagePath);
    setStatus('Snip copied to clipboard.');
  }
  await refreshLibrary(false);
});

saveBtn.addEventListener('click', async () => {
  if (!currentSnip || currentBucket !== 'pending') return;
  await window.snipPilot.savePending(currentSnip.id);
  setStatus('Snip moved to Copied.');
  currentSnip = null;
  currentBucket = null;
  previewImage.style.display = 'none';
  emptyState.style.display = 'block';
  await refreshLibrary(false);
});

discardBtn.addEventListener('click', async () => {
  if (!currentSnip || currentBucket !== 'pending') return;
  await window.snipPilot.discardPending(currentSnip.id);
  setStatus('Snip deleted locally.');
  currentSnip = null;
  currentBucket = null;
  previewImage.style.display = 'none';
  emptyState.style.display = 'block';
  await refreshLibrary(false);
});

window.snipPilot.onLibrarySnips((snips) => {
  renderLibrary(snips);
  if (!currentSnip && snips.pending?.[0]) selectSnip(snips.pending[0], 'pending');
});

window.snipPilot.onNewSnip(async () => {
  await refreshLibrary(true);
});

window.snipPilot.onStatus(setStatus);

window.snipPilot.getInfo().then((info) => {
  shortcutText.textContent = info.shortcut;
  storagePath.textContent = info.captureDir;
  setStatus(info.shortcutRegistered ? `Ready. Press ${info.shortcut} anywhere while Snip Pilot is running.` : `Ready, but ${info.shortcut} could not be registered.`);
});

refreshLibrary(false);
setActionState();
