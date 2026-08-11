/**
 * Turn each recorded feature clip into its own GIF.
 *
 *   CLIP_DIR=.rec npx playwright test clips --config playwright.local.config.ts
 *   node scripts/readme-clips.mjs
 *
 * One palette per clip, not one for the whole demo. That single global
 * palette was why the old README video shifted colour: 256 slots had to
 * cover a terminal's syntax highlighting, the four status hues and the
 * diff's red and green all at once, so everything drifted toward whatever
 * dominated. A clip only shows one feature, so its palette only has to
 * hold one feature's colours.
 *
 * `stats_mode=diff` weights the palette toward what actually changes
 * between frames — the moving part is what a reader is looking at.
 * Bayer dithering rather than the default error-diffusion: on a flat dark
 * field error diffusion crawls between frames, which reads as noise and
 * costs a lot of bytes; an ordered matrix is stable frame to frame.
 *
 * The recordings land under CLIP_DIR/<locale>/<clip>/*.webm, which is how
 * the two language sets stay apart without either one having to be renamed
 * by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rec = join(here, '..', process.env.CLIP_DIR ?? '.rec');
const out = join(here, '..', '..', 'docs', 'media', 'clips');

const FPS = 9;
// 800 keeps terminal and diff text legible at README width. Wider costs
// bytes a reader does not read: a GIF has no keyframes, so every extra
// column is paid for on every frame.
const WIDTH = 800;
// 64 slots is enough for one feature's colours, measured rather than
// assumed — at 96 and 128 the same frames come out visually identical and
// half again as large.
const COLORS = 64;

if (!existsSync(rec)) {
  console.error(`no recordings at ${rec} — record first with CLIP_DIR set`);
  process.exit(1);
}

const locales = readdirSync(rec).filter((d) => statSync(join(rec, d)).isDirectory());
let made = 0;
let total = 0;

for (const locale of locales) {
  const tag = locale === 'en' ? 'en' : 'zh';
  const dest = join(out, tag);
  mkdirSync(dest, { recursive: true });

  for (const name of readdirSync(join(rec, locale))) {
    const dir = join(rec, locale, name);
    if (!statSync(dir).isDirectory()) continue;
    const webm = readdirSync(dir).find((f) => f.endsWith('.webm'));
    if (!webm) {
      console.warn(`  ${locale}/${name}: no webm, skipped`);
      continue;
    }
    const gif = join(dest, `${name}.gif`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', join(dir, webm),
      '-vf',
      // mpdecimate drops frames the encoder only *thinks* changed: webm
      // decode leaves a little noise on a still screen, and without this
      // every held beat is paid for in full. `vfr` then keeps the timing
      // honest by lengthening the delay of the frame that was kept.
      `fps=${FPS},mpdecimate=hi=64*8:lo=64*3:frac=0.02,` +
        `scale=${WIDTH}:-1:flags=lanczos,split[a][b];` +
        `[a]palettegen=max_colors=${COLORS}:stats_mode=diff[p];` +
        `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-fps_mode:v', 'vfr',
      '-loop', '0',
      gif,
    ]);
    const kb = Math.round(statSync(gif).size / 1024);
    total += kb;
    made += 1;
    console.log(`${tag}/${name}.gif  ${kb} KB`);
  }
}

if (made === 0) {
  console.error('no clip recordings found');
  process.exit(1);
}
console.log(`\n${made} clips, ${(total / 1024).toFixed(1)} MB total`);
