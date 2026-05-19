const addAboveBtn = document.getElementById('addAboveBtn');
const addBelowBtn = document.getElementById('addBelowBtn');
const autoBtn = document.getElementById('autoBtn');
const doneBtn = document.getElementById('doneBtn');
const cancelBtn = document.getElementById('cancelBtn');
const frameStatus = document.getElementById('frameStatus');
const segmentCount = document.getElementById('segmentCount');

let busy = false;
let autoTimer = null;
let autoDirection = 'down';

function setStatus(message) {
  frameStatus.textContent = message;
}

function setBusy(next) {
  busy = next;
  addAboveBtn.disabled = next;
  addBelowBtn.disabled = next;
  doneBtn.disabled = next;
  cancelBtn.disabled = next;
}

function stopAuto(message = 'Auto capture stopped.') {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  autoBtn.classList.remove('active');
  autoBtn.textContent = 'Auto capture';
  if (message) setStatus(message);
}

async function addSegment(direction, auto = false) {
  if (busy) return;
  setBusy(true);
  setStatus(direction === 'down' ? 'Capturing below...' : 'Capturing above...');
  try {
    const result = await window.snipPilot.captureScrollSegment(direction);
    if (result?.ok) {
      segmentCount.textContent = `${result.count} ${result.count === 1 ? 'frame' : 'frames'}`;
      autoDirection = result.direction || direction;
      setStatus(auto
        ? 'Auto capture is running. Scroll slowly, then click Done when ready.'
        : direction === 'down'
          ? 'Added below. Scroll farther down, then Add below again.'
          : 'Added above. Scroll farther up, then Add above again.');
    } else {
      stopAuto('');
      setStatus(result?.error || 'Could not add that view.');
    }
  } finally {
    setBusy(false);
  }
}

addAboveBtn.addEventListener('click', () => addSegment('up'));
addBelowBtn.addEventListener('click', () => addSegment('down'));

autoBtn.addEventListener('click', () => {
  if (autoTimer) {
    stopAuto();
    return;
  }
  autoBtn.classList.add('active');
  autoBtn.textContent = 'Stop auto';
  setStatus('Auto capture is running. Scroll slowly, then click Done when ready.');
  autoTimer = setInterval(() => {
    addSegment(autoDirection, true);
  }, 1200);
});

doneBtn.addEventListener('click', async () => {
  if (busy) return;
  stopAuto('');
  setBusy(true);
  setStatus('Finishing scrolling snip...');
  await window.snipPilot.finishScrollCapture();
});

cancelBtn.addEventListener('click', async () => {
  stopAuto('');
  setBusy(true);
  setStatus('Cancelling scrolling snip...');
  await window.snipPilot.cancelScrollCapture();
});

window.snipPilot.onScrollFrameState((state) => {
  if (state?.count) segmentCount.textContent = `${state.count} ${state.count === 1 ? 'frame' : 'frames'}`;
  if (state?.direction) autoDirection = state.direction;
  if (state?.message) setStatus(state.message);
});
