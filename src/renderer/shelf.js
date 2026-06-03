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

const MAX_SHELF_ITEMS = 6;

async function renderSnips(snips) {
  shelf.innerHTML = '';
  const visible = snips.slice(0, MAX_SHELF_ITEMS);
  for (let index = 0; index < visible.length; index += 1) {
    const snip = visible[index];
    const item = document.createElement('article');
    item.className = 'snip';
    item.style.animationDelay = `${index * 45}ms`;
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

  if (snips.length > MAX_SHELF_ITEMS) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `+${snips.length - MAX_SHELF_ITEMS} more in Pending`;
    shelf.appendChild(more);
  }
}

window.snipPilot.onShelfSnips(renderSnips);
window.snipPilot.listSnips().then((snips) => renderSnips(snips.pending || []));
