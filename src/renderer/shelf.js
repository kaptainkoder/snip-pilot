const shelf = document.getElementById('shelf');
let renderToken = 0;

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
  const token = ++renderToken;
  const entries = await Promise.all(snips.slice(0, 6).map(async (snip) => {
    try {
      return {
        snip,
        dataUrl: await window.snipPilot.loadSnipImage(snip.imagePath)
      };
    } catch {
      return null;
    }
  }));
  if (token !== renderToken) return;

  const fragment = document.createDocumentFragment();
  for (const entry of entries.filter(Boolean)) {
    const { snip, dataUrl } = entry;
    const item = document.createElement('article');
    item.className = 'snip';
    item.addEventListener('click', () => window.snipPilot.openEditor({ id: snip.id, bucket: 'pending' }));

    const close = makeButton('x', 'close', () => window.snipPilot.savePending(snip.id));
    close.title = 'Move to Copied';

    const image = document.createElement('img');
    image.alt = snip.title || 'Pending snip';
    image.src = dataUrl;

    item.append(close, image);
    fragment.appendChild(item);
  }
  shelf.replaceChildren(fragment);
}

window.snipPilot.onShelfSnips(renderSnips);
window.snipPilot.listSnips().then((snips) => renderSnips(snips.pending || []));
