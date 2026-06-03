const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Jimp } = require('jimp');
const { findOverlap, frameDifference, stitchScrollFrames } = require('../src/scroll-stitch');

// Build a frame whose every row encodes its absolute position in a tall virtual
// document, so a known scroll offset produces a known, detectable overlap.
function makeFrame(width, height, startRow) {
  const image = new Jimp({ width, height, color: 0x000000ff });
  const data = image.bitmap.data;
  for (let y = 0; y < height; y += 1) {
    const v = (startRow + y) % 256;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = (v * 2) % 256;
      data[i + 2] = (v * 3) % 256;
      data[i + 3] = 255;
    }
  }
  return image;
}

test('findOverlap detects a known downward scroll offset', () => {
  const frameA = makeFrame(100, 160, 0);    // rows 0..159
  const frameB = makeFrame(100, 160, 80);   // rows 80..239 (scrolled down 80)
  const result = findOverlap(frameA, frameB, 'down');
  assert.ok(Math.abs(result.overlap - 80) <= 8, `expected overlap ~80, got ${result.overlap}`);
  assert.ok(result.score < 5, `expected a low match score, got ${result.score}`);
});

test('frameDifference is ~0 for identical frames and large for shifted frames', () => {
  const a = makeFrame(100, 160, 0);
  const same = makeFrame(100, 160, 0);
  const shifted = makeFrame(100, 160, 80);
  assert.ok(frameDifference(a, same) < 1, 'identical frames should barely differ');
  assert.ok(frameDifference(a, shifted) > 2, 'shifted frames should differ enough to be kept');
});

test('stitchScrollFrames joins two overlapping frames into one taller image', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-stitch-test-'));
  try {
    const f0 = path.join(dir, 'f0.png');
    const f1 = path.join(dir, 'f1.png');
    const out = path.join(dir, 'out.png');
    await makeFrame(100, 160, 0).write(f0);
    await makeFrame(100, 160, 80).write(f1);

    await stitchScrollFrames([f0, f1], out, 'down');

    const result = await Jimp.read(out);
    assert.strictEqual(result.bitmap.width, 100);
    // 160 (first frame) + (160 - 80 overlap) = 240, allow small rounding slack.
    assert.ok(Math.abs(result.bitmap.height - 240) <= 4, `expected stitched height ~240, got ${result.bitmap.height}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
