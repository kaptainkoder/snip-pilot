const { Jimp, rgbaToInt } = require('jimp');

const STABLE_EDGE_THRESHOLD = 10;
const STABLE_EDGE_STEP = 4;
const MIN_STABLE_EDGE = 24;

function colorDifference(imageA, xA, yA, imageB, xB, yB) {
  const indexA = (imageA.bitmap.width * yA + xA) * 4;
  const indexB = (imageB.bitmap.width * yB + xB) * 4;
  const dataA = imageA.bitmap.data;
  const dataB = imageB.bitmap.data;
  return (
    Math.abs(dataA[indexA] - dataB[indexB]) +
    Math.abs(dataA[indexA + 1] - dataB[indexB + 1]) +
    Math.abs(dataA[indexA + 2] - dataB[indexB + 2])
  ) / 3;
}

function rowDifferenceAt(previous, next, previousY, nextY, sampleStep) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  let diff = 0;
  let count = 0;
  for (let x = 0; x < width; x += sampleStep) {
    diff += colorDifference(previous, x, previousY, next, x, nextY);
    count += 1;
  }
  return count ? diff / count : Number.MAX_VALUE;
}

function detectStableEdge(previous, next, edge) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  const height = Math.min(previous.bitmap.height, next.bitmap.height);
  const sampleStep = Math.max(8, Math.floor(width / 90));
  const maxBand = Math.min(Math.floor(height * 0.28), 180);
  let band = 0;
  let misses = 0;

  for (let offset = 0; offset < maxBand; offset += STABLE_EDGE_STEP) {
    const previousY = edge === 'top' ? offset : previous.bitmap.height - 1 - offset;
    const nextY = edge === 'top' ? offset : next.bitmap.height - 1 - offset;
    const score = rowDifferenceAt(previous, next, previousY, nextY, sampleStep);
    if (score <= STABLE_EDGE_THRESHOLD) {
      band = offset + STABLE_EDGE_STEP;
      misses = 0;
    } else {
      misses += 1;
      if (misses >= 2) break;
    }
  }

  return band >= Math.min(MIN_STABLE_EDGE, Math.floor(height * 0.16)) ? Math.min(band, maxBand) : 0;
}

function detectStableEdges(previous, next) {
  return {
    top: detectStableEdge(previous, next, 'top'),
    bottom: detectStableEdge(previous, next, 'bottom')
  };
}

function frameDifference(previous, next) {
  const width = Math.min(previous.bitmap.width, next.bitmap.width);
  const height = Math.min(previous.bitmap.height, next.bitmap.height);
  const sampleStep = Math.max(10, Math.floor(width / 80));
  let diff = 0;
  let count = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      diff += colorDifference(previous, x, y, next, x, y);
      count += 1;
    }
  }
  return count ? diff / count : 0;
}

function contentHeight(frame, crop) {
  return Math.max(1, frame.bitmap.height - crop.top - crop.bottom);
}

function overlapDifference(previous, next, overlap, sampleStep, direction, previousCrop, nextCrop) {
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
      diff += colorDifference(previous, x, previousY, next, x, nextY);
      count += 1;
    }
  }

  return count ? diff / count : Number.MAX_VALUE;
}

function findOverlap(previous, next, direction, previousCrop = { top: 0, bottom: 0 }, nextCrop = { top: 0, bottom: 0 }) {
  const available = Math.min(contentHeight(previous, previousCrop), contentHeight(next, nextCrop));
  if (available < 2) return { overlap: 0, score: Number.MAX_VALUE, direction };

  const maxOverlap = Math.max(1, Math.floor(available * 0.92));
  const minOverlap = Math.max(1, Math.floor(available * 0.05));
  const sampleStep = Math.max(8, Math.floor(Math.min(previous.bitmap.width, next.bitmap.width) / 90));
  let bestOverlap = minOverlap;
  let bestScore = Number.MAX_VALUE;

  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += sampleStep) {
    const score = overlapDifference(previous, next, overlap, sampleStep, direction, previousCrop, nextCrop);
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

function clampCrop(frame, crop) {
  const height = frame.bitmap.height;
  const maxCrop = Math.max(0, height - 1);
  let top = Math.max(0, Math.min(crop.top, maxCrop));
  let bottom = Math.max(0, Math.min(crop.bottom, maxCrop));
  if (top + bottom > maxCrop) {
    const scale = maxCrop / (top + bottom);
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  return { top, bottom };
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

function cropFramePiece(frame, y, height) {
  const cropY = Math.max(0, Math.min(frame.bitmap.height - 1, Math.round(y)));
  const cropHeight = Math.max(1, Math.min(frame.bitmap.height - cropY, Math.round(height)));
  return frame.clone().crop({ x: 0, y: cropY, w: frame.bitmap.width, h: cropHeight });
}

function chooseDirection(transitions) {
  const downScore = transitions
    .filter((item) => item.direction === 'down')
    .reduce((sum, item) => sum + Math.max(1, 255 - item.score), 0);
  const upScore = transitions
    .filter((item) => item.direction === 'up')
    .reduce((sum, item) => sum + Math.max(1, 255 - item.score), 0);
  return upScore > downScore ? 'up' : 'down';
}

async function stitchScrollFrames(framePaths, outputPath) {
  const rawFrames = await Promise.all(framePaths.map((filePath) => Jimp.read(filePath)));
  const frames = [];
  rawFrames.forEach((frame) => {
    const previous = frames[frames.length - 1];
    if (!previous || frameDifference(previous, frame) > 2) frames.push(frame);
  });
  if (!frames.length) throw new Error('No scroll frames were captured.');

  if (frames.length === 1) {
    await frames[0].write(outputPath);
    return { direction: 'single', frameCount: 1 };
  }

  const transitions = [];
  for (let index = 1; index < frames.length; index += 1) {
    transitions.push(compareFramePair(frames[index - 1], frames[index]));
  }

  const direction = chooseDirection(transitions);
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
      if (height > 0) pieces.push(cropFramePiece(frames[index], y, height));
    }
  } else {
    for (let index = 0; index < frames.length; index += 1) {
      const crop = crops[index];
      const transition = index > 0
        ? findOverlap(frames[index - 1], frames[index], direction, crops[index - 1], crop)
        : { overlap: 0 };
      const height = frames[index].bitmap.height - crop.top - crop.bottom - transition.overlap;
      if (height > 0) pieces.unshift(cropFramePiece(frames[index], crop.top, height));
    }
  }

  const width = Math.max(...pieces.map((piece) => piece.bitmap.width));
  const height = pieces.reduce((sum, piece) => sum + piece.bitmap.height, 0);
  const output = new Jimp({ width, height, color: rgbaToInt(255, 255, 255, 255) });
  let y = 0;
  pieces.forEach((piece) => {
    output.composite(piece, 0, y);
    y += piece.bitmap.height;
  });
  await output.write(outputPath);

  return {
    direction,
    frameCount: frames.length,
    crops
  };
}

module.exports = {
  stitchScrollFrames,
  detectStableEdges,
  findOverlap,
  compareFramePair
};
