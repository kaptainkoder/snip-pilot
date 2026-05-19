const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const selection = document.getElementById('selection');

let image;
let dataUrl;
let mode = 'snip';
let dragging = false;
let start = { x: 0, y: 0 };
let current = { x: 0, y: 0 };

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function draw() {
  if (!image) return;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.drawImage(image, 0, 0, window.innerWidth, window.innerHeight);
}

function updateSelection() {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  selection.style.display = width > 2 && height > 2 ? 'block' : 'none';
  selection.style.left = `${left}px`;
  selection.style.top = `${top}px`;
  selection.style.width = `${width}px`;
  selection.style.height = `${height}px`;
}

function cropSelection(rect) {
  const ratio = window.devicePixelRatio || 1;
  const output = document.createElement('canvas');
  output.width = Math.round(rect.width * ratio);
  output.height = Math.round(rect.height * ratio);
  const outputCtx = output.getContext('2d');
  outputCtx.drawImage(
    image,
    Math.round(rect.left * ratio),
    Math.round(rect.top * ratio),
    Math.round(rect.width * ratio),
    Math.round(rect.height * ratio),
    0,
    0,
    output.width,
    output.height
  );
  return output.toDataURL('image/png');
}

window.snipPilot.onOverlayCapture((payload) => {
  dataUrl = payload.dataUrl;
  mode = payload.mode || 'snip';
  image = new Image();
  image.onload = resizeCanvas;
  image.src = dataUrl;
});

window.addEventListener('resize', resizeCanvas);

window.addEventListener('mousedown', (event) => {
  dragging = true;
  start = { x: event.clientX, y: event.clientY };
  current = { ...start };
  updateSelection();
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  current = { x: event.clientX, y: event.clientY };
  updateSelection();
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  const rect = {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
  };
  if (rect.width < 8 || rect.height < 8) return;
  if (mode === 'scroll') {
    window.snipPilot.finishScrollRegion({ rect });
    return;
  }
  window.snipPilot.finishOverlaySnip({
    imageDataUrl: cropSelection(rect),
    sourceDataUrl: dataUrl,
    rect
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.snipPilot.cancelOverlay();
  }
});
