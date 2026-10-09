/**
 * Zero-dependency TGA -> PNG converter.
 *
 * PMX models ship uncompressed 32-bit TGA textures (16 MB each at 2048x2048),
 * which are slow to fetch and decode at startup. PNG keeps the exact same
 * pixels (lossless, alpha preserved) at a fraction of the size.
 *
 * Supports the TGA variants MMD models actually use:
 *   type 2  - uncompressed true-color (24/32 bpp)
 *   type 10 - RLE true-color (24/32 bpp)
 *
 * Usage: node tools/tga2png.mjs <input.tga> <output.png>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Decode a TGA buffer into { width, height, rgba }. */
export function decodeTga(buf) {
  const idLength = buf.readUInt8(0);
  const colorMapType = buf.readUInt8(1);
  const imageType = buf.readUInt8(2);
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf.readUInt8(16);
  const descriptor = buf.readUInt8(17);

  if (colorMapType !== 0) throw new Error('Color-mapped TGA is not supported');
  if (imageType !== 2 && imageType !== 10) throw new Error(`Unsupported TGA image type ${imageType}`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported TGA bit depth ${bpp}`);

  const bytesPerPixel = bpp / 8;
  const pixelCount = width * height;
  // TGA stores BGR(A); we emit RGBA.
  const rgba = Buffer.alloc(pixelCount * 4);

  let src = 18 + idLength;
  let dst = 0;

  const emit = (b, g, r, a) => {
    rgba[dst++] = r;
    rgba[dst++] = g;
    rgba[dst++] = b;
    rgba[dst++] = a;
  };

  if (imageType === 2) {
    for (let i = 0; i < pixelCount; i++) {
      const b = buf[src], g = buf[src + 1], r = buf[src + 2];
      emit(b, g, r, bytesPerPixel === 4 ? buf[src + 3] : 255);
      src += bytesPerPixel;
    }
  } else {
    // RLE: each packet starts with a header byte; high bit set = run packet.
    let written = 0;
    while (written < pixelCount) {
      const header = buf[src++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        const b = buf[src], g = buf[src + 1], r = buf[src + 2];
        const a = bytesPerPixel === 4 ? buf[src + 3] : 255;
        src += bytesPerPixel;
        for (let i = 0; i < count; i++) emit(b, g, r, a);
      } else {
        for (let i = 0; i < count; i++) {
          const b = buf[src], g = buf[src + 1], r = buf[src + 2];
          emit(b, g, r, bytesPerPixel === 4 ? buf[src + 3] : 255);
          src += bytesPerPixel;
        }
      }
      written += count;
    }
  }

  // Bit 5 of the descriptor set means the first row is the top row.
  // When clear (the common case) the image is bottom-up and must be flipped.
  if (!(descriptor & 0x20)) {
    const stride = width * 4;
    const row = Buffer.alloc(stride);
    for (let y = 0; y < (height >> 1); y++) {
      const top = y * stride;
      const bottom = (height - 1 - y) * stride;
      rgba.copy(row, 0, top, top + stride);
      rgba.copy(rgba, top, bottom, bottom + stride);
      row.copy(rgba, bottom);
    }
  }

  return { width, height, rgba };
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Paeth predictor (PNG filter type 4) - best general-purpose filter for texture data. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encode RGBA pixels as a PNG buffer (8-bit, colour type 6). */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Each scanline is prefixed with its filter byte.
  const raw = Buffer.alloc((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 4; // Paeth
    const line = y * stride;
    const prev = line - stride;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[line + x];
      const a = x >= 4 ? rgba[line + x - 4] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = y > 0 && x >= 4 ? rgba[prev + x - 4] : 0;
      raw[o++] = (cur - paeth(a, b, c)) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('tga2png.mjs')) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('Usage: node tools/tga2png.mjs <input.tga> <output.png>');
    process.exit(1);
  }
  const { width, height, rgba } = decodeTga(fs.readFileSync(input));
  const png = encodePng(width, height, rgba);
  fs.writeFileSync(output, png);
  const before = fs.statSync(input).size;
  console.log(
    `${input} -> ${output}  ${width}x${height}  ${(before / 1048576).toFixed(1)}MB -> ${(png.length / 1048576).toFixed(2)}MB  (${((1 - png.length / before) * 100).toFixed(1)}% smaller)`
  );
}
