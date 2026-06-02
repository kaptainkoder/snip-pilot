const shelf = document.getElementById('shelf');

function makeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

async function renderSnips(snips) {
  shelf.innerHTML = '';
  for (const snip of snips.slice(0, 6)) {
    const item = document.createElement('article');
    item.className = 'snip';
    item.addEventListener('click', () => window.snipPilot.openEditor({ id: snip.id, bucket: 'pending' }));

    const close = makeButton('x', 'close', () => window.snipPilot.savePending(snip.id));
    close.title = 'Move to Copied';

    const dataUrl = await window.snipPilot.loadSnipImage(snip.imagePath);
    const image = document.createElement('img');
    image.alt = snip.title || 'Pending snip';
    image.src = dataUrl;

    item.append(close, image);
    shelf.appendChild(item);
  }
}

window.snipPilot.onShelfSnips(renderSnips);
window.snipPilot.listSnips().then((snips) => renderSnips(snips.pending || []));
