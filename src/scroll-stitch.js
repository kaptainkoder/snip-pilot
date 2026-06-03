// Pure scroll-stitching logic, extracted from main.js so it can be unit-tested
// without booting Electron. Everything here operates on Jimp images only.
const { Jimp, rgbaToInt } = require('jimp');

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

module.exports = {
  pixelDifference,
  rowDifference,
  frameDifference,
  rowDifferenceAt,
  detectStableEdge,
  detectStableEdges,
  clampCrop,
  contentHeight,
  findOverlap,
  compareFramePair,
  chooseScrollDirection,
  buildCropPlan,
  cropPiece,
  stitchScrollFrames
};
