// Dev-only Scriptable simulator: runs ios/core.js in Node with a fake Scriptable API and writes the
// resulting widget as HTML (drawn images become inline SVG). Not a perfect replica of iOS layout —
// it is here to catch runtime errors and to eyeball what the drawing code produces.
//
//   node scripts/ios-sim.js --now 2026-11-24T14:05:00+02:00 --data data.json --param "" --dark --out widget.html
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const NOW = new Date(opt('now', new Date().toISOString()));
const DARK = !!opt('dark', false);
const OUT = opt('out', 'widget.html');
const DATA = opt('data', null);
const PARAM = opt('param', '');
const CONFIG = opt('config', JSON.stringify({ queues: [{ name: 'Дім', id: '6.2' }], active: 0 }));
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'svitlo-sim-'));

// ---------- fake API ----------
class Color { constructor(hex, alpha) { this.hex = hex; this.alpha = alpha == null ? 1 : alpha; }
  static dynamic(l, d) { return DARK ? d : l; } css() { return hexA(this.hex, this.alpha); } }
function hexA(hex, a) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
const Font = new Proxy({}, { get: (_, name) => (size) => ({ name, size }) });
class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Size { constructor(w, h) { this.width = w; this.height = h; } }
class Rect { constructor(x, y, w, h) { Object.assign(this, { x, y, width: w, height: h }); } }
class Path { constructor() { this.d = ''; }
  move(p) { this.d += `M${p.x} ${p.y}`; } addLine(p) { this.d += `L${p.x} ${p.y}`; }
  addLines(ps) { ps.forEach((p, i) => (i ? this.addLine(p) : this.move(p))); } closeSubpath() { this.d += 'Z'; }
  addRect(r) { this.d += `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}Z`; }
  addEllipse(r) { const rx = r.width / 2, ry = r.height / 2, cx = r.x + rx, cy = r.y + ry; this.d += `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`; }
  addRoundedRect(r, cw, ch) { const x = r.x, y = r.y, w = r.width, h = r.height;
    this.d += `M${x + cw} ${y}H${x + w - cw}Q${x + w} ${y} ${x + w} ${y + ch}V${y + h - ch}Q${x + w} ${y + h} ${x + w - cw} ${y + h}H${x + cw}Q${x} ${y + h} ${x} ${y + h - ch}V${y + ch}Q${x} ${y} ${x + cw} ${y}Z`; } }
class DrawContext { constructor() { this.ops = []; this.cur = ''; this.fillC = 'black'; this.strokeC = 'black'; this.lw = 1; }
  setFillColor(c) { this.fillC = c.css(); } setStrokeColor(c) { this.strokeC = c.css(); } setLineWidth(w) { this.lw = w; }
  addPath(p) { this.cur += p.d; }
  fillPath() { this.ops.push(`<path d="${this.cur}" fill="${this.fillC}"/>`); this.cur = ''; }
  strokePath() { this.ops.push(`<path d="${this.cur}" fill="none" stroke="${this.strokeC}" stroke-width="${this.lw}"/>`); this.cur = ''; }
  fillRect(r) { this.ops.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.fillC}"/>`); }
  fillEllipse(r) { this.ops.push(`<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="${this.fillC}"/>`); }
  strokeEllipse(r) { this.ops.push(`<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="none" stroke="${this.strokeC}" stroke-width="${this.lw}"/>`); }
  setFont(f) { this.font = f; } setFontSize(n) { this.font = { name: 'regular', size: n }; } setTextColor(c) { this.textC = c.css(); }
  setTextAlignedLeft() { this.ta = 'start'; } setTextAlignedCenter() { this.ta = 'middle'; } setTextAlignedRight() { this.ta = 'end'; }
  drawTextInRect(t, r) { const f = this.font || { size: 12 }, ta = this.ta || 'start', x = ta === 'middle' ? r.x + r.width / 2 : ta === 'end' ? r.x + r.width : r.x;
    this.ops.push(`<text x="${x}" y="${r.y + f.size}" font-size="${f.size}" font-weight="${/bold|heavy/i.test(f.name) ? 700 : 400}" font-family="-apple-system,sans-serif" text-anchor="${ta}" fill="${this.textC || 'black'}">${t}</text>`); }
  getImage() { const s = this.size; return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}">${this.ops.join('')}</svg>`, size: s }; } }

class Node { constructor(kind) { this.kind = kind; this.items = []; this.vertical = kind !== 'stack'; }
  addText(t) { const n = { kind: 'text', text: t, centerAlignText() { this.ta = 'center'; }, rightAlignText() { this.ta = 'right'; }, leftAlignText() { this.ta = 'left'; } }; this.items.push(n); return n; }
  addDate(d) { const n = { kind: 'date', date: d, style: 'date', applyTimerStyle() { this.style = 'timer'; }, applyRelativeStyle() { this.style = 'relative'; }, centerAlignText() { this.ta = 'center'; }, rightAlignText() { this.ta = 'right'; }, leftAlignText() { this.ta = 'left'; } }; this.items.push(n); return n; }
  addImage(img) { const n = { kind: 'image', image: img }; this.items.push(n); return n; }
  addSpacer(len) { this.items.push({ kind: 'spacer', len }); }
  addStack() { const s = new Node('stack'); this.items.push(s); return s; }
  layoutHorizontally() { this.vertical = false; } layoutVertically() { this.vertical = true; }
  centerAlignContent() { this.align = 'center'; } topAlignContent() { this.align = 'flex-start'; } bottomAlignContent() { this.align = 'flex-end'; }
  setPadding(t, l, b, r) { this.padding = [t, r, b, l]; } }
let shown = null;
class ListWidget extends Node { constructor() { super('widget'); }
  async presentSmall() { shown = { w: this, fam: 'small' }; } async presentMedium() { shown = { w: this, fam: 'medium' }; } async presentLarge() { shown = { w: this, fam: 'large' }; }
  async presentAccessoryCircular() { shown = { w: this, fam: 'accessoryCircular' }; } }

const files = {};
const fmImpl = { joinPath: (a, b) => path.join(a, b), fileExists: (p) => fs.existsSync(p), readString: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
  writeString: (p, s) => fs.writeFileSync(p, s), cacheDirectory: () => tmp, documentsDirectory: () => tmp, isFileDownloaded: () => true,
  downloadFileFromiCloud: async () => {}, isFileStoredIniCloud: () => false, createDirectory: (p) => fs.mkdirSync(p, { recursive: true }), modificationDate: (p) => fs.statSync(p).mtime };
const FileManager = { local: () => fmImpl, iCloud: () => fmImpl };
class Request { constructor(url) { this.url = url; this.response = { statusCode: 200 }; }
  async loadString() { if (DATA) return fs.readFileSync(DATA, 'utf8'); const r = await fetch(this.url); this.response.statusCode = r.status; return r.text(); } }
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } }

const ctxDir = path.join(tmp, 'svitlo'); fs.mkdirSync(ctxDir, { recursive: true });
fs.writeFileSync(path.join(ctxDir, 'config.json'), CONFIG);
const widgetMode = opt('app', false) ? false : true;
const sandbox = {
  Intl,
  console, Intl, JSON, Math, Promise, Object, Array, String, Number, Error, encodeURIComponent, parseInt,
  Date: FakeDate, Color, Font, Point, Size, Rect, Path, DrawContext, ListWidget, FileManager, Request,
  URLScheme: { forRunningScript: () => 'scriptable:///run/Svitlo' },
  args: { widgetParameter: PARAM || null, queryParameters: {} },
  config: { runsInWidget: widgetMode, widgetFamily: opt('family', 'small') },
  Script: { setWidget: (w) => { shown = { w, fam: opt('family', 'small') }; }, complete: () => {}, name: () => 'Svitlo' },
  Safari: { open: () => {} },
};
sandbox.module = { exports: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ios/core.js'), 'utf8'), sandbox, { filename: 'core.js' });

// ---------- render to HTML ----------
const SIZES = { small: [170, 170], medium: [364, 170], large: [364, 382], accessoryCircular: [72, 72], accessoryRectangular: [172, 76], accessoryInline: [240, 24] };
function fmtTimer(d) { let s = Math.max(0, Math.round((d - NOW) / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s %= 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); }
const fontCss = (f) => f ? `font-size:${f.size}px;font-weight:${/heavy|black/i.test(f.name) ? 800 : /bold/i.test(f.name) ? 700 : /semibold/i.test(f.name) ? 600 : 400};${/Rounded/.test(f.name) ? 'font-family:ui-rounded,-apple-system,sans-serif;' : ''}` : '';
function render(n) {
  if (n.kind === 'text' || n.kind === 'date') {
    const t = n.kind === 'text' ? n.text : n.style === 'timer' ? fmtTimer(n.date) : String(n.date);
    return `<div style="${fontCss(n.font)}${n.ta ? 'text-align:' + n.ta + ';align-self:stretch;' : ''}${n.textOpacity != null ? 'opacity:' + n.textOpacity + ';' : ''}color:${n.textColor ? n.textColor.css() : 'inherit'};white-space:${n.lineLimit === 1 ? 'nowrap' : 'normal'};overflow:hidden;text-overflow:ellipsis">${t.replace(/</g, '&lt;')}</div>`;
  }
  if (n.kind === 'spacer') return n.len == null ? '<div style="flex:1"></div>' : `<div style="flex:0 0 ${n.len}px"></div>`;
  if (n.kind === 'image') { const s = n.imageSize || n.image.size; return `<img style="width:${s.width}px;height:${s.height}px" src="data:image/svg+xml;utf8,${encodeURIComponent(n.image.svg)}">`; }
  const p = n.padding ? `padding:${n.padding.join('px ')}px;` : '';
  const sz = n.size ? `${n.size.width > 0 ? 'width:' + n.size.width + 'px;flex:none;' : ''}${n.size.height > 0 ? 'height:' + n.size.height + 'px;' : ''}box-sizing:border-box;` : '';
  const bg = (n.backgroundColor ? 'background-color:' + n.backgroundColor.css() + ';' : '') + (n.backgroundImage ? `background-image:url('data:image/svg+xml;utf8,${encodeURIComponent(n.backgroundImage.svg)}');background-size:100% 100%;` : '') + (n.cornerRadius ? 'border-radius:' + n.cornerRadius + 'px;overflow:hidden;' : '');
  const al = n.align || (n.vertical ? 'flex-start' : 'center');
  return `<div style="display:flex;flex-direction:${n.vertical ? 'column' : 'row'};align-items:${al};${p}${sz}${bg}${n.kind === 'stack' ? '' : 'flex:1;'}min-width:0">${n.items.map(render).join('')}</div>`;
}

(async () => {
  const STYLE = opt('style', null);
  if (STYLE) { // render a specific style directly (bypasses the saved choice)
    const t = sandbox.module.exports._test, st = t.store({ fm: fmImpl, dir: ctxDir });
    const fam = opt('family', 'small');
    shown = { w: await t.buildWidget(st, await st.loadConfig(), fam, STYLE), fam };
  } else await sandbox.module.exports.run({ fm: fmImpl, dir: ctxDir, scriptName: 'Svitlo' });
  if (!shown) throw new Error('no widget produced');
  const [W, H] = SIZES[shown.fam] || SIZES.small, w = shown.w;
  const html = `<body style="margin:0;padding:24px;background:${DARK ? '#3a3f4a' : '#c9d3e6'};font-family:-apple-system,sans-serif">
<div style="width:${W}px;height:${H}px;border-radius:${shown.fam === 'accessoryCircular' ? '50%' : '22px'};overflow:hidden;display:flex;flex-direction:column;background:${w.backgroundColor ? w.backgroundColor.css() : (/accessory/.test(shown.fam) ? 'rgba(255,255,255,.12)' : '#fff')};${w.backgroundImage ? `background-image:url('data:image/svg+xml;utf8,${encodeURIComponent(w.backgroundImage.svg)}');background-size:100% 100%;` : ''}${/accessory/.test(shown.fam) ? 'color:#fff;' : ''}${w.padding ? 'padding:' + w.padding.join('px ') + 'px;' : 'padding:16px;'}box-sizing:border-box">${w.items.map(render).join('')}</div>
<pre style="font-size:11px">${shown.fam} · refreshAfter ${w.refreshAfterDate ? w.refreshAfterDate.toISOString() : '-'} · url ${w.url || '-'}</pre></body>`;
  fs.writeFileSync(OUT, html);
  console.log('ok', shown.fam, OUT);
})().catch((e) => { console.error('SIM ERROR', e); process.exit(1); });
