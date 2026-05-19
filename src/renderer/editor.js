const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.querySelector('.stage');
const colorInput = document.getElementById('colorInput');
const sizeInput = document.getElementById('sizeInput');
canvas.tabIndex = 0;

let snip = null;
let baseImage = null;
let tool = 'pen';
let drawing = false;
let start = null;
let last = null;
let activeObject = null;
let objects = [];
let undoStack = [];
let finishing = false;
let selectedObjectIndex = -1;
let movingObjectIndex = -1;
let moveOffset = { x: 0, y: 0 };

function cloneObjects(value = objects) {
  return JSON.parse(JSON.stringify(value));
}

function setTool(nextTool) {
  tool = nextTool;
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === nextTool);
  });
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function pushUndo() {
  undoStack.push(cloneObjects());
  if (undoStack.length > 40) undoStack.shift();
}

function distanceToSegment(pointValue, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(pointValue.x - a.x, pointValue.y - a.y);
  const t = Math.max(0, Math.min(1, ((pointValue.x - a.x) * dx + (pointValue.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(pointValue.x - (a.x + t * dx), pointValue.y - (a.y + t * dy));
}

function drawArrow(from, to, color, size) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(14, size * 3);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawObject(object) {
  ctx.save();
  if (object.type === 'pen' || object.type === 'highlight') {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = object.size;
    ctx.strokeStyle = object.color;
    ctx.globalAlpha = object.type === 'highlight' ? 0.28 : 1;
    ctx.beginPath();
    object.points.forEach((item, index) => {
      if (index === 0) ctx.moveTo(item.x, item.y);
      else ctx.lineTo(item.x, item.y);
    });
    ctx.stroke();
  }

  if (object.type === 'arrow') {
    drawArrow(object.from, object.to, object.color, object.size);
  }

  if (object.type === 'line') {
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(object.from.x, object.from.y);
    ctx.lineTo(object.to.x, object.to.y);
    ctx.stroke();
  }

  if (object.type === 'rect') {
    const x = Math.min(object.from.x, object.to.x);
    const y = Math.min(object.from.y, object.to.y);
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.size;
    ctx.strokeRect(x, y, Math.abs(object.to.x - object.from.x), Math.abs(object.to.y - object.from.y));
  }

  if (object.type === 'ellipse') {
    const x = Math.min(object.from.x, object.to.x);
    const y = Math.min(object.from.y, object.to.y);
    const width = Math.abs(object.to.x - object.from.x);
    const height = Math.abs(object.to.y - object.from.y);
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.size;
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, Math.max(width / 2, 1), Math.max(height / 2, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (object.type === 'redact') {
    const x = Math.min(object.from.x, object.to.x);
    const y = Math.min(object.from.y, object.to.y);
    ctx.fillStyle = '#050505';
    ctx.fillRect(x, y, Math.abs(object.to.x - object.from.x), Math.abs(object.to.y - object.from.y));
  }

  if (object.type === 'number') {
    ctx.fillStyle = object.color;
    ctx.beginPath();
    ctx.arc(object.x, object.y, object.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${object.radius + 4}px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(object.value), object.x, object.y + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  if (object.type === 'text') {
    ctx.font = `${object.fontSize}px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
    ctx.fillStyle = object.color;
    ctx.fillRect(object.x, object.y, object.width, object.height);
    const lines = object.text.split('\n');
    ctx.fillStyle = object.text ? '#fff' : 'rgba(255,255,255,0.72)';
    lines.forEach((line, index) => {
      ctx.fillText(line || (object.editing ? 'Type...' : ''), object.x + 10, object.y + object.fontSize + 8 + index * (object.fontSize + 6));
    });
    if (object.editing) {
      const currentLine = lines[lines.length - 1] || '';
      const caretX = object.x + 10 + ctx.measureText(currentLine).width + 2;
      const caretTop = object.y + 10 + (lines.length - 1) * (object.fontSize + 6);
      ctx.fillStyle = '#fff';
      ctx.fillRect(caretX, caretTop, 2, object.fontSize + 4);
    }
  }
  ctx.restore();
}

function drawSelection(object) {
  if (!object) return;
  let x;
  let y;
  let width;
  let height;
  if (object.type === 'text') {
    x = object.x;
    y = object.y;
    width = object.width;
    height = object.height;
  } else if (object.from && object.to) {
    x = Math.min(object.from.x, object.to.x);
    y = Math.min(object.from.y, object.to.y);
    width = Math.abs(object.to.x - object.from.x);
    height = Math.abs(object.to.y - object.from.y);
  } else {
    return;
  }
  ctx.save();
  ctx.strokeStyle = '#2f9bd3';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x - 5, y - 5, width + 10, height + 10);
  ctx.restore();
}

function render() {
  if (!baseImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  const highlights = objects.filter((item) => item.type === 'highlight');
  const rest = objects.filter((item) => item.type !== 'highlight');
  highlights.forEach(drawObject);
  rest.forEach(drawObject);
  if (activeObject) drawObject(activeObject);
  if (selectedObjectIndex >= 0 && !activeObject) drawSelection(objects[selectedObjectIndex]);
}

function objectHit(object, item) {
  const tolerance = Math.max(10, object.size || 8);
  if (object.type === 'pen' || object.type === 'highlight') {
    return object.points.some((pointValue, index) => index > 0 && distanceToSegment(item, object.points[index - 1], pointValue) <= tolerance + object.size / 2);
  }
  if (object.type === 'arrow' || object.type === 'line') return distanceToSegment(item, object.from, object.to) <= tolerance + object.size;
  if (object.type === 'rect' || object.type === 'ellipse' || object.type === 'redact') {
    const x = Math.min(object.from.x, object.to.x);
    const y = Math.min(object.from.y, object.to.y);
    const width = Math.abs(object.to.x - object.from.x);
    const height = Math.abs(object.to.y - object.from.y);
    return item.x >= x - tolerance && item.x <= x + width + tolerance && item.y >= y - tolerance && item.y <= y + height + tolerance;
  }
  if (object.type === 'number') return Math.hypot(item.x - object.x, item.y - object.y) <= object.radius + tolerance;
  if (object.type === 'text') {
    return item.x >= object.x && item.x <= object.x + object.width && item.y >= object.y && item.y <= object.y + object.height;
  }
  return false;
}

function eraseAt(item) {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (objectHit(objects[index], item)) {
      pushUndo();
      objects.splice(index, 1);
      selectedObjectIndex = -1;
      render();
      return true;
    }
  }
  return false;
}

function findTopmostObject(item, predicate = () => true) {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (predicate(objects[index]) && objectHit(objects[index], item)) return index;
  }
  return -1;
}

function measureTextObject(object) {
  const fontSize = Math.max(18, Number(sizeInput.value) * 4);
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
  const lines = (object.text || 'Type...').split('\n');
  const width = Math.max(120, ...lines.map((line) => ctx.measureText(line).width + 24));
  const height = lines.length * (fontSize + 6) + 16;
  object.fontSize = fontSize;
  object.width = width;
  object.height = height;
}

function startTextObject(at) {
  pushUndo();
  activeObject = {
    type: 'text',
    x: at.x,
    y: at.y,
    width: 140,
    height: 42,
    text: '',
    fontSize: Math.max(18, Number(sizeInput.value) * 4),
    color: colorInput.value,
    editing: true
  };
  measureTextObject(activeObject);
  render();
}

function commitActiveText() {
  if (!activeObject || activeObject.type !== 'text') return;
  const text = activeObject.text.trim();
  if (text) {
    activeObject.text = text;
    activeObject.editing = false;
    measureTextObject(activeObject);
    objects.push(activeObject);
  } else {
    undoStack.pop();
  }
  activeObject = null;
  render();
}

function cancelActiveText() {
  if (!activeObject || activeObject.type !== 'text') return;
  undoStack.pop();
  activeObject = null;
  render();
}

async function finishAndClose() {
  if (finishing || !snip || !baseImage) return;
  finishing = true;
  if (activeObject?.type === 'text') commitActiveText();
  selectedObjectIndex = -1;
  render();
  await window.snipPilot.finishEditor({
    id: snip.id,
    bucket: snip.status,
    imageDataUrl: canvas.toDataURL('image/png')
  });
}

document.querySelectorAll('[data-tool]').forEach((button) => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

canvas.addEventListener('mousedown', (event) => {
  if (!baseImage) return;
  start = point(event);
  last = start;
  canvas.focus();

  if (tool === 'text') {
    if (activeObject?.type === 'text') commitActiveText();
    const hitIndex = findTopmostObject(start, (object) => object.type === 'text');
    if (hitIndex >= 0) {
      pushUndo();
      selectedObjectIndex = hitIndex;
      movingObjectIndex = hitIndex;
      moveOffset = {
        x: start.x - objects[hitIndex].x,
        y: start.y - objects[hitIndex].y
      };
      drawing = true;
      render();
      return;
    }
    selectedObjectIndex = -1;
    startTextObject(start);
    return;
  }

  selectedObjectIndex = -1;

  if (tool === 'number') {
    pushUndo();
    const previousNumbers = objects.filter((item) => item.type === 'number').map((item) => item.value);
    objects.push({
      type: 'number',
      x: start.x,
      y: start.y,
      radius: Math.max(15, Number(sizeInput.value) * 3),
      value: previousNumbers.length ? Math.max(...previousNumbers) + 1 : 1,
      color: colorInput.value
    });
    render();
    return;
  }

  if (tool === 'eraser') {
    eraseAt(start);
    drawing = true;
    return;
  }

  drawing = true;
  if (tool === 'pen' || tool === 'highlight') {
    pushUndo();
    activeObject = {
      type: tool,
      color: tool === 'highlight' ? '#ffe066' : colorInput.value,
      size: tool === 'highlight' ? Math.max(18, Number(sizeInput.value) * 4) : Number(sizeInput.value),
      points: [start]
    };
  }
  if (['arrow', 'rect', 'line', 'ellipse', 'redact'].includes(tool)) {
    pushUndo();
    activeObject = {
      type: tool,
      color: colorInput.value,
      size: Number(sizeInput.value),
      from: start,
      to: start
    };
  }
});

canvas.addEventListener('mousemove', (event) => {
  if (!drawing) return;
  const next = point(event);
  if (tool === 'text' && movingObjectIndex >= 0) {
    objects[movingObjectIndex].x = next.x - moveOffset.x;
    objects[movingObjectIndex].y = next.y - moveOffset.y;
    selectedObjectIndex = movingObjectIndex;
    render();
    return;
  }
  if (tool === 'eraser') {
    eraseAt(next);
    return;
  }
  if (activeObject?.points) activeObject.points.push(next);
  if (activeObject?.to) activeObject.to = next;
  last = next;
  render();
});

canvas.addEventListener('mouseup', () => {
  if (!drawing) return;
  drawing = false;
  if (movingObjectIndex >= 0) {
    selectedObjectIndex = movingObjectIndex;
    movingObjectIndex = -1;
    render();
    return;
  }
  if (activeObject) {
    objects.push(activeObject);
    activeObject = null;
    render();
  }
});

document.getElementById('undoBtn').addEventListener('click', () => {
  const previous = undoStack.pop();
  if (!previous) return;
  objects = previous;
  activeObject = null;
  selectedObjectIndex = -1;
  movingObjectIndex = -1;
  render();
});

document.getElementById('resetBtn').addEventListener('click', () => {
  pushUndo();
  objects = [];
  activeObject = null;
  selectedObjectIndex = -1;
  movingObjectIndex = -1;
  render();
});

document.getElementById('closeBtn').addEventListener('click', finishAndClose);
window.snipPilot.onEditorFinishRequest(finishAndClose);

window.addEventListener('keydown', (event) => {
  if (!activeObject || activeObject.type !== 'text') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    cancelActiveText();
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    commitActiveText();
    return;
  }

  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    activeObject.text += '\n';
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    activeObject.text = activeObject.text.slice(0, -1);
  } else if (event.key.length === 1) {
    event.preventDefault();
    activeObject.text += event.key;
  } else {
    return;
  }

  measureTextObject(activeObject);
  render();
});

window.snipPilot.onEditorInit((payload) => {
  snip = payload;
  baseImage = new Image();
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    objects = [];
    undoStack = [];
    render();
    setTool('pen');
  };
  baseImage.src = payload.imageDataUrl;
});
