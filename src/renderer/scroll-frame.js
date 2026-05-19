const topHandle = document.getElementById('topHandle');
const bottomHandle = document.getElementById('bottomHandle');
const doneBtn = document.getElementById('doneBtn');
const cancelBtn = document.getElementById('cancelBtn');
const frameStatus = document.getElementById('frameStatus');
const segmentCount = document.getElementById('segmentCount');
const controls = document.querySelector('.controls');

const edgeZone = 46;
const dragThreshold = 14;
let interactive = false;
let dragging = null;
let busy = false;

function setInteractive(next) {
  if (interactive === next) return;
  interactive = next;
  window.snipPilot.setScrollFrameInteractive(next);
}

function setStatus(message) {
  frameStatus.textContent = message;
}

function edgeForEvent(event) {
  if (event.clientY <= edgeZone) return 'up';
  if (event.clientY >= window.innerHeight - edgeZone) return 'down';
  return null;
}

function wantsInteraction(event) {
  return Boolean(edgeForEvent(event) || controls.contains(event.target));
}

async function addSegment(direction) {
  if (busy) return;
  busy = true;
  setStatus(direction === 'down' ? 'Capturing the next lower view...' : 'Capturing the next upper view...');
  try {
    const result = await window.snipPilot.captureScrollSegment(direction);
    if (result?.ok) {
      segmentCount.textContent = `${result.count} frames`;
      setStatus(direction === 'down'
        ? 'Added below. Scroll farther down, then drag the bottom edge again, or click Done.'
        : 'Added above. Scroll farther up, then drag the top edge again, or click Done.');
    } else {
      setStatus(result?.error || 'Could not add that view yet.');
    }
  } finally {
    busy = false;
  }
}

function beginDrag(direction, event) {
  event.preventDefault();
  event.stopPropagation();
  dragging = {
    direction,
    startY: event.clientY
  };
  setInteractive(true);
  (direction === 'up' ? topHandle : bottomHandle).classList.add('dragging');
  setStatus(direction === 'down' ? 'Release after dragging down to add below.' : 'Release after dragging up to add above.');
}

function endDrag(event) {
  if (!dragging) return;
  const delta = event.clientY - dragging.startY;
  const direction = dragging.direction;
  topHandle.classList.remove('dragging');
  bottomHandle.classList.remove('dragging');
  dragging = null;

  if ((direction === 'down' && delta >= dragThreshold) || (direction === 'up' && delta <= -dragThreshold)) {
    addSegment(direction).finally(() => setInteractive(wantsInteraction(event)));
    return;
  }

  setStatus('Scroll the page, then drag the bottom edge down or top edge up to add that view.');
  setInteractive(wantsInteraction(event));
}

window.addEventListener('mousemove', (event) => {
  if (dragging) {
    event.preventDefault();
    return;
  }
  setInteractive(wantsInteraction(event));
});

window.addEventListener('mouseup', endDrag);

window.addEventListener('mouseleave', () => {
  if (!dragging) setInteractive(false);
});

topHandle.addEventListener('mousedown', (event) => beginDrag('up', event));
bottomHandle.addEventListener('mousedown', (event) => beginDrag('down', event));

doneBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  setStatus('Finishing scrolling snip...');
  await window.snipPilot.finishScrollCapture();
});

cancelBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  setStatus('Cancelling scrolling snip...');
  await window.snipPilot.cancelScrollCapture();
});

window.snipPilot.onScrollFrameState((state) => {
  if (state?.count) segmentCount.textContent = `${state.count} ${state.count === 1 ? 'frame' : 'frames'}`;
  if (state?.message) setStatus(state.message);
});

setInteractive(false);
