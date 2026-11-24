// Generates all PNG icons (app icon, macOS template tray icons, Windows tray icons)
// with a tiny dependency-free rasterizer. Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

// ---------- PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- geometry (all shapes in a 24x24 design grid) ----------
const BOLT = [[13, 2], [4, 14], [11, 14], [10, 22], [19, 10], [12, 10]];
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function onStroke(x, y, pts, w, closed) {
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) if (distSeg(x, y, pts[i], pts[(i + 1) % pts.length]) <= w / 2) return true;
  return false;
}
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return Math.hypot(x - cx, y - cy) <= r;
}
// shrink/move the bolt around the grid centre
function xform(pts, s, ox = 0, oy = 0) {
  return pts.map(([x, y]) => [12 + (x - 12) * s + ox, 12 + (y - 12) * s + oy]);
}

// layers: [{ test(x,y) -> bool, color:[r,g,b,a] }] painted in order, 4x4 supersampling
function render(size, layers) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / size) * 24;
        const y = ((py + (sy + 0.5) / SS) / size) * 24;
        let cr = 0, cg = 0, cb = 0, ca = 0;
        for (const L of layers) {
          if (!L.test(x, y)) continue;
          const la = L.color[3] / 255;
          cr = L.color[0] * la + cr * (1 - la);
          cg = L.color[1] * la + cg * (1 - la);
          cb = L.color[2] * la + cb * (1 - la);
          ca = la + ca * (1 - la);
        }
        r += cr; g += cg; b += cb; a += ca;
      }
      const n = SS * SS, i = (py * size + px) * 4;
      const A = a / n;
      buf[i] = A ? Math.round(r / n / A) : 0;
      buf[i + 1] = A ? Math.round(g / n / A) : 0;
      buf[i + 2] = A ? Math.round(b / n / A) : 0;
      buf[i + 3] = Math.round(A * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const AMBER = [245, 184, 61, 255];
const INK = [21, 23, 27, 255];
const SLATE = [43, 47, 54, 255];
const WHITE = [255, 255, 255, 255];
const RED = [255, 107, 94, 255];
const BLACK = [0, 0, 0, 255];
const SLASH = [[3, 3], [21, 21]];

function write(name, png) {
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote', name);
}

fs.mkdirSync(OUT, { recursive: true });

// App icon (used for .icns / .ico by electron-builder)
const appBolt = xform(BOLT, 0.62, 0.3, 0);
write('icon.png', render(1024, [
  { test: (x, y) => inRoundRect(x, y, 1.5, 1.5, 22.5, 22.5, 5), color: AMBER },
  { test: (x, y) => inPoly(x, y, appBolt), color: INK },
]));

// macOS template tray icons: black + alpha only, macOS tints them for light/dark menu bars
const macOn = xform(BOLT, 0.95);
const macOff = xform(BOLT, 1.0);
for (const [suffix, size] of [['', 18], ['@2x', 36]]) {
  write(`trayOnTemplate${suffix}.png`, render(size, [{ test: (x, y) => inPoly(x, y, macOn), color: BLACK }]));
  write(`trayOffTemplate${suffix}.png`, render(size, [
    { test: (x, y) => inPoly(x, y, macOff) && distSeg(x, y, ...SLASH) > 1.45, color: [0, 0, 0, 120] },
    { test: (x, y) => distSeg(x, y, ...SLASH) <= 1.05, color: BLACK },
  ]));
}

// Windows tray icons: self-contained tiles readable on light and dark taskbars
const winOn = xform(BOLT, 0.7, 0.3, 0);
const winOff = xform(BOLT, 0.78, 0.3, 0);
for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
  write(`trayOn${suffix}.png`, render(size, [
    { test: (x, y) => inRoundRect(x, y, 0.5, 0.5, 23.5, 23.5, 5), color: AMBER },
    { test: (x, y) => inPoly(x, y, winOn), color: INK },
  ]));
  write(`trayOff${suffix}.png`, render(size, [
    { test: (x, y) => inRoundRect(x, y, 0.5, 0.5, 23.5, 23.5, 5), color: SLATE },
    { test: (x, y) => inPoly(x, y, winOff) && distSeg(x, y, [4, 4], [20, 20]) > 1.6, color: [200, 205, 212, 255] },
    { test: (x, y) => distSeg(x, y, [4, 4], [20, 20]) <= 1.15, color: RED },
  ]));
}
