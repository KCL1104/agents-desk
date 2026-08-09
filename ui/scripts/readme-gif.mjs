/**
 * Assemble docs/media/demo.gif from the recording the shots spec leaves in
 * docs/media/.rec/demo.webm.
 *
 * Playwright's bundled ffmpeg decodes webm and encodes PNG — and nothing
 * else — so it dumps frames and this script does the GIF: one global
 * palette (the UI is a stable dark field; a per-frame palette would
 * shimmer and triple the size), indexed frames at 8fps.
 *
 *   node scripts/readme-gif.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import gifenc from 'gifenc';

const { PNG } = pngjs;
const { GIFEncoder, quantize, applyPalette } = gifenc;

const here = dirname(fileURLToPath(import.meta.url));
const media = join(here, '..', '..', 'docs', 'media');
const src = join(media, '.rec', 'demo.webm');
const out = join(media, 'demo.gif');
const FF = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';
const FPS = 8;
const WIDTH = 960;

const frames = mkdtempSync(join(tmpdir(), 'agentdesk-gif-'));
try {
  // This ffmpeg is Playwright's minimal build: scale is the only filter
  // it ships, so the frame rate is set at the output (-r) instead of a
  // fps filter.
  execFileSync(FF, [
    '-y', '-i', src,
    '-vf', `scale=${WIDTH}:-1:flags=lanczos`,
    '-r', String(FPS),
    join(frames, 'f%04d.png'),
  ], { stdio: 'pipe' });

  const files = readdirSync(frames).filter((f) => f.endsWith('.png')).sort();
  if (files.length === 0) throw new Error('ffmpeg produced no frames');

  // Palette from a mid-flow frame — the busiest one, colors-wise —
  // with the last slot reserved for "unchanged since the previous frame".
  const mid = PNG.sync.read(readFileSync(join(frames, files[Math.floor(files.length / 2)])));
  const palette = quantize(
    new Uint8Array(mid.data.buffer, mid.data.byteOffset, mid.data.length),
    255,
  );
  palette.push([255, 0, 255]);
  const CLEAR = palette.length - 1;

  // Inter-frame differencing: a screen recording of a dark UI is mostly
  // pixels that did not move. Unchanged pixels become the transparent
  // index (dispose=1 keeps the previous frame under them), and a frame
  // with no changes at all just lends its delay to the one before it.
  const gif = GIFEncoder();
  const STEP = Math.round(1000 / FPS);
  let prev = null;
  let pendingDelay = 0;
  for (const f of files) {
    const png = PNG.sync.read(readFileSync(join(frames, f)));
    const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
    const indexed = applyPalette(rgba, palette);
    if (prev === null) {
      gif.writeFrame(indexed, png.width, png.height, { palette, delay: STEP, dispose: 1 });
      prev = indexed;
      continue;
    }
    const masked = new Uint8Array(indexed.length);
    let changed = 0;
    for (let i = 0; i < indexed.length; i++) {
      if (indexed[i] === prev[i]) masked[i] = CLEAR;
      else {
        masked[i] = indexed[i];
        changed += 1;
      }
    }
    if (changed === 0) {
      pendingDelay += STEP;
      continue;
    }
    gif.writeFrame(masked, png.width, png.height, {
      palette,
      delay: STEP + pendingDelay,
      transparent: true,
      transparentIndex: CLEAR,
      dispose: 1,
    });
    pendingDelay = 0;
    prev = indexed;
  }
  gif.finish();
  writeFileSync(out, gif.bytes());
  console.log(`wrote ${out} (${files.length} frames)`);
} finally {
  rmSync(frames, { recursive: true, force: true });
}
