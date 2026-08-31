// Generates the tray and window icons.
//
// They are drawn in code rather than committed as binaries so the palette stays
// in one place and nobody has to open an image editor to change a colour. Run
// with `npm run icons` after editing.

import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "icons");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A filled rounded square with a speaker-ish notch knocked out of it. */
function draw(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;
  const inset = size * 0.08;
  const max = size - inset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distance outside the rounded rect, used directly as an alpha ramp so the
      // edges come out smooth without a real rasteriser.
      const dx = Math.max(inset + radius - (x + 0.5), x + 0.5 - (max - radius), 0);
      const dy = Math.max(inset + radius - (y + 0.5), y + 0.5 - (max - radius), 0);
      const outside = Math.hypot(dx, dy) - radius;
      let alpha = Math.min(1, Math.max(0, 0.5 - outside));

      // Two vertical bars, like a level meter, punched out of the tile.
      const cx = (x + 0.5) / size;
      const cy = (y + 0.5) / size;
      const inBar =
        (cx > 0.34 && cx < 0.45 && cy > 0.3 && cy < 0.7) || (cx > 0.55 && cx < 0.66 && cy > 0.42 && cy < 0.58);
      if (inBar) alpha = 0;

      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

const ICONS = {
  "tray-live.png": [16, [158, 206, 106]], // mic reaching Discord
  "tray-live@2x.png": [32, [158, 206, 106]],
  "tray-idle.png": [16, [224, 108, 117]], // passthrough off or no output open
  "tray-idle@2x.png": [32, [224, 108, 117]],
  "app.png": [256, [122, 162, 247]],
};

await fs.mkdir(OUT, { recursive: true });
for (const [name, [size, colour]] of Object.entries(ICONS)) {
  await fs.writeFile(path.join(OUT, name), encodePng(size, draw(size, colour)));
  console.log(`wrote icons/${name} (${size}x${size})`);
}
