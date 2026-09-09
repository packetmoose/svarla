// One-off asset fix: the app icon PNGs (icon-192, icon-512, apple-touch-icon)
// were exported as RGB with no alpha, so the area outside the rounded tile is
// solid white. On the dark-theme web UI that white shows as a bright ring in
// the rounded corners.
//
// Fix, in two passes over an RGBA copy of each icon:
//   1. Flood-fill the exterior background from the four corners across
//      near-white pixels and make it transparent. This precisely targets the
//      connected outside region and never touches the tile interior or the
//      light-colored bird glyph.
//   2. Clean the boundary: any pixel still opaque but whitish (the leftover
//      anti-aliased white->purple ramp of the old corner) that borders the
//      now-transparent region is recolored to the tile's purple and, if very
//      light, faded. This removes the thin white ring the flood fill leaves at
//      the tile edge so nothing bright survives against a dark background.
//
// Run: node scripts/round-icon-alpha.mjs
import sharp from "sharp";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

const files = ["icon-192.png", "icon-512.png", "apple-touch-icon.png"];

// The solid tile color, sampled from the icon center. Used to repaint the
// leftover white ramp along the boundary.
const TILE = [75, 35, 140];

function isBackground(data, o) {
  return data[o] >= 244 && data[o + 1] >= 244 && data[o + 2] >= 244;
}

async function processFile(name) {
  const path = resolve(publicDir, name);
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  if (c !== 4) throw new Error(`expected RGBA, got ${c}`);

  const idx = (x, y) => (y * w + x) * c;

  // --- Pass 1: flood fill exterior background -> transparent ---
  const clear = new Uint8Array(w * h);
  const queue = [];
  for (const [sx, sy] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ]) {
    const o = idx(sx, sy);
    const flat = sy * w + sx;
    if (isBackground(data, o) && !clear[flat]) {
      clear[flat] = 1;
      queue.push(sx, sy);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const x = queue[head++];
    const y = queue[head++];
    const nb = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const flat = ny * w + nx;
      if (clear[flat]) continue;
      if (isBackground(data, idx(nx, ny))) {
        clear[flat] = 1;
        queue.push(nx, ny);
      }
    }
  }
  for (let flat = 0; flat < w * h; flat++) {
    if (clear[flat]) data[flat * c + 3] = 0;
  }

  // --- Pass 2: repaint the leftover white ramp along the boundary ---
  // Iterate a few times so the ramp (a couple px wide) is fully cleaned.
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = idx(x, y);
        if (data[o + 3] < 200) continue; // only (near) opaque pixels
        const minc = Math.min(data[o], data[o + 1], data[o + 2]);
        if (minc <= 200) continue; // only whitish pixels
        const touchesT =
          (x > 0 && data[idx(x - 1, y) + 3] < 200) ||
          (x < w - 1 && data[idx(x + 1, y) + 3] < 200) ||
          (y > 0 && data[idx(x, y - 1) + 3] < 200) ||
          (y < h - 1 && data[idx(x, y + 1) + 3] < 200);
        if (!touchesT) continue;
        // Repaint to tile purple; fade alpha for the lightest fringe so the
        // edge stays smooth against transparency.
        data[o] = TILE[0];
        data[o + 1] = TILE[1];
        data[o + 2] = TILE[2];
        if (minc > 245) data[o + 3] = 140;
        changed++;
      }
    }
    if (!changed) break;
  }

  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(path);
  console.log(`${name}: ${w}x${h} — exterior cleared + boundary cleaned`);
}

for (const f of files) {
  await processFile(f);
}
console.log("Done. Icons now have transparent, clean rounded corners.");
