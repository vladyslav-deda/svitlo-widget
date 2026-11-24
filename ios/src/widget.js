// Svitlo for Scriptable (iOS). Built into ios/core.js together with src/schedule.js (as `S`).
// Entry point: module.exports.run({ fm, dir, scriptName }) — called by the loader ios/Svitlo.js.

const VERSION = '0.1.0';

// ---------- palette (same tokens as the desktop popover) ----------
const C = {
  amber: '#F5B83D',
  bg: ['#FBFBFD', '#1F2024'], fg: ['#15171B', '#F2F3F5'], muted: ['#5B616C', '#A9AEB6'],
  off: '#2A2D33', marker: '#E5484D',
};
const dyn = (pair) => Color.dynamic(new Color(pair[0]), new Color(pair[1]));

// ---------- storage ----------
function store(ctx) {
  const local = FileManager.local();
  const cacheFile = local.joinPath(local.cacheDirectory(), 'svitlo-data.json');
  const cfgFile = ctx.fm.joinPath(ctx.dir, 'config.json');
  return {
    async loadConfig() {
      const def = { queues: [], active: 0 };
      try {
        if (!ctx.fm.fileExists(cfgFile)) return def;
        if (!ctx.fm.isFileDownloaded(cfgFile)) await ctx.fm.downloadFileFromiCloud(cfgFile);
        const c = JSON.parse(ctx.fm.readString(cfgFile));
        c.queues = (c.queues || []).filter((q) => q && S.QUEUE_IDS.includes(q.id));
        if (!(c.active >= 0 && c.active < c.queues.length)) c.active = 0;
        return Object.assign(def, c);
      } catch (e) { return def; }
    },
    saveConfig(c) { ctx.fm.writeString(cfgFile, JSON.stringify(c, null, 2)); },
    async loadData() {
      let json = null, fresh = false;
      try {
        const r = new Request(S.SOURCE_URL + '?t=' + Date.now());
        r.timeoutInterval = 12;
        const text = await r.loadString();
        const j = JSON.parse(text);
        if (j && j.fact && j.fact.data) { json = j; fresh = true; local.writeString(cacheFile, text); }
      } catch (e) { /* offline -> cache */ }
      if (!json && local.fileExists(cacheFile)) { try { json = JSON.parse(local.readString(cacheFile)); } catch (e) { /* broken cache */ } }
      return { parsed: json ? S.parseSource(json) : null, fresh: fresh };
    },
  };
}

// Widget parameter: queue name or id, in any case, e.g. "Батьки" / "3.1"
function pickQueue(cfg, param) {
  const p = String(param || '').trim().toLowerCase();
  if (p) {
    const byName = cfg.queues.find((q) => q.name.toLowerCase() === p);
    if (byName) return byName;
    const id = (p.match(/\b([1-6])[.,]([12])\b/) || []).slice(1).join('.');
    if (S.QUEUE_IDS.includes(id)) return cfg.queues.find((q) => q.id === id) || { name: 'Черга', id: id };
  }
  return cfg.queues[cfg.active] || null;
}

// ---------- drawing ----------
function boltPoints(x, y, s) { // 24x24 design grid -> rect at (x,y) of size s
  const k = s / 24;
  return [[13.5, 2], [4, 13.5], [11, 13.5], [10, 22], [19.5, 10.5], [12.5, 10.5]].map((p) => new Point(x + p[0] * k, y + p[1] * k));
}

function drawIcon(off, size) {
  const d = new DrawContext();
  d.size = new Size(size, size); d.opaque = false; d.respectScreenScale = true;
  d.setFillColor(new Color(off ? C.off : C.amber));
  d.fillEllipse(new Rect(0, 0, size, size));
  const p = new Path(); p.addLines(boltPoints(size * 0.2, size * 0.2, size * 0.6)); p.closeSubpath();
  d.addPath(p); d.setFillColor(new Color(off ? '#FFFFFF' : '#15171B')); d.fillPath();
  if (off) { // slash
    const s = new Path(); s.move(new Point(size * 0.24, size * 0.24)); s.addLine(new Point(size * 0.76, size * 0.76));
    d.addPath(s); d.setStrokeColor(new Color(C.off)); d.setLineWidth(size * 0.16); d.strokePath();
    d.addPath(s); d.setStrokeColor(new Color('#FFFFFF')); d.setLineWidth(size * 0.07); d.strokePath();
  }
  return d.getImage();
}

// Diagonal hatch lines inside a rect (no clipping in DrawContext, so intersect each line with the rect by hand)
function hatch(d, r, step, color, width) {
  d.setStrokeColor(color); d.setLineWidth(width);
  for (let c = r.x - r.height; c < r.x + r.width; c += step) {
    // line x = c + (y - r.y), y in [r.y, r.y+h]  -> clip x to [r.x, r.x+w]
    let y0 = r.y, y1 = r.y + r.height, x0 = c, x1 = c + r.height;
    if (x0 < r.x) { y0 += r.x - x0; x0 = r.x; }
    if (x1 > r.x + r.width) { y1 -= x1 - (r.x + r.width); x1 = r.x + r.width; }
    if (y1 - y0 < 0.5) continue;
    const p = new Path(); p.move(new Point(x0, y1)); p.addLine(new Point(x1, y0));
    d.addPath(p); d.strokePath();
  }
}

// 24h bar: on = amber, off = dark + hatch (+ thin light outline so it reads on a dark widget too); now marker
function drawBar(list, minutes, isToday, w, h) {
  const pad = 4; // room for the marker dot
  const d = new DrawContext();
  d.size = new Size(w, h + pad * 2); d.opaque = false; d.respectScreenScale = true;
  const segs = []; let cur = 0;
  (list || []).forEach((iv) => { if (iv[0] > cur) segs.push([cur, iv[0], false]); segs.push([iv[0], iv[1], true]); cur = iv[1]; });
  if (cur < 1440) segs.push([cur, 1440, false]);
  const rad = Math.min(3, h / 2);
  segs.forEach((s) => {
    const x = s[0] / 1440 * w + 1, sw = (s[1] - s[0]) / 1440 * w - 2;
    if (sw <= 0) return;
    const past = isToday && s[1] <= minutes, a = past ? 0.38 : 1;
    const r = new Rect(x, pad, sw, h);
    const p = new Path(); p.addRoundedRect(r, Math.min(rad, sw / 2), Math.min(rad, sw / 2));
    d.addPath(p); d.setFillColor(new Color(s[2] ? C.off : C.amber, a)); d.fillPath();
    if (s[2]) {
      hatch(d, new Rect(x + 1, pad + 1, sw - 2, h - 2), 5, new Color('#FFFFFF', 0.16 * a), 1.5);
      d.addPath(p); d.setStrokeColor(new Color('#FFFFFF', 0.14 * a)); d.setLineWidth(1); d.strokePath();
    }
  });
  if (isToday) {
    const mx = minutes / 1440 * w;
    d.setFillColor(new Color(C.marker));
    d.fillRect(new Rect(mx - 1, 1, 2, h + pad * 2 - 2));
    d.fillEllipse(new Rect(mx - 3.5, 0, 7, 7));
  }
  return d.getImage();
}

// ---------- model ----------
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function cd(m) { return Math.floor(m / 60) + ':' + pad2(m % 60); }

function model(parsed, q, now) {
  const v = S.queueView(parsed, q.id, now);
  if (!v.today || !v.status) return { v: v, unknown: true };
  const s = v.status, m = v.minutes;
  const until = s.until; // minutes from today's midnight, may exceed 1440, null = no more changes known
  const at = until == null ? null : new Date(now.getTime() + (until - m) * 60000 - now.getSeconds() * 1000);
  return {
    v: v, off: s.off, until: until, at: at, left: until == null ? null : until - m,
    title: s.off ? 'Світла немає' : 'Світло є',
    sub: until == null ? 'сьогодні більше без відключень' : (s.off ? 'увімкнуть ' : 'вимкнуть ') + (s.tomorrow ? 'завтра ' : '') + 'о ' + S.hm(until),
    cdl: s.off ? 'до увімкнення' : 'до вимкнення',
  };
}

// ---------- widgets ----------
function baseWidget(ctx) {
  const w = new ListWidget();
  w.backgroundColor = dyn(C.bg);
  w.setPadding(14, 14, 14, 14);
  w.url = URLScheme.forRunningScript();
  return w;
}
function text(stack, str, size, weight, color) {
  const t = stack.addText(str);
  t.font = weight === 'heavy' ? Font.heavyRoundedSystemFont(size) : weight === 'bold' ? Font.boldSystemFont(size) : weight === 'semibold' ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color || dyn(C.fg);
  t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}

function messageWidget(ctx, title, body) {
  const w = baseWidget(ctx);
  text(w, title, 15, 'bold');
  w.addSpacer(4);
  const b = text(w, body, 12, 'semibold', dyn(C.muted)); b.lineLimit = 4;
  w.addSpacer();
  return w;
}

function smallCountdown(ctx, q, md, now) {
  const w = baseWidget(ctx);
  const top = w.addStack(); top.layoutHorizontally(); top.centerAlignContent();
  top.addImage(drawIcon(md.off, 26)).imageSize = new Size(26, 26);
  top.addSpacer();
  text(top, q.name + ' · ' + q.id, 11, 'bold', dyn(C.muted));
  w.addSpacer();
  if (md.at) {
    const dt = w.addDate(md.at); dt.applyTimerStyle();
    dt.font = Font.heavyRoundedSystemFont(34); dt.textColor = dyn(C.fg); dt.lineLimit = 1; dt.minimumScaleFactor = 0.5;
    text(w, md.cdl, 12, 'semibold', dyn(C.muted));
  } else {
    text(w, md.title, 22, 'heavy');
  }
  w.addSpacer();
  text(w, md.sub, 12.5, 'bold');
  w.addSpacer(6);
  w.addImage(drawBar(md.v.today, md.v.minutes, true, 142, 8)).imageSize = new Size(142, 16);
  return w;
}

// next useful refresh: the next on/off switch (so the state flips on time), but at least every 15 min
function refreshDate(md, now) {
  let t = now.getTime() + 15 * 60000;
  if (md && md.at) t = Math.min(t, md.at.getTime() + 30000);
  return new Date(Math.max(t, now.getTime() + 60000));
}

async function buildWidget(ctx, st, cfg, family) {
  const q = pickQueue(cfg, args.widgetParameter);
  if (!q) return messageWidget(ctx, 'Svitlo', 'Натисніть, щоб обрати свою чергу.');
  const data = await st.loadData();
  const now = new Date();
  if (!data.parsed) return messageWidget(ctx, 'Немає даних', 'Не вдалося завантажити графік. Перевірте інтернет.');
  const md = model(data.parsed, q, now);
  if (md.unknown) return messageWidget(ctx, q.name + ' · ' + q.id, 'Графіка на сьогодні ще немає.');
  if (family && family !== 'small') return messageWidget(ctx, 'Svitlo', 'Цей розмір з\'явиться в наступній версії. Поки що додайте малий віджет.');
  const w = smallCountdown(ctx, q, md, now);
  w.refreshAfterDate = refreshDate(md, now);
  return w;
}

// ---------- app (tap on widget / run in Scriptable) ----------
async function askQueue(cfg) {
  const a = new Alert();
  a.title = 'Ваша черга?';
  a.message = 'Оберіть номер черги відключень для своєї адреси. Не знаєте його — оберіть «Знайти за адресою».';
  S.QUEUE_IDS.forEach((id) => a.addAction(id));
  a.addAction('Знайти за адресою ↗');
  a.addCancelAction('Скасувати');
  const i = await a.presentSheet();
  if (i < 0) return null;
  if (i === S.QUEUE_IDS.length) { Safari.open('https://disconnection.voe.com.ua'); return null; }
  const id = S.QUEUE_IDS[i];
  const n = new Alert();
  n.title = 'Назва для черги ' + id;
  n.addTextField('Дім, Робота, Батьки…', cfg.queues.length ? '' : 'Дім');
  n.addAction('Готово');
  await n.present();
  const name = (n.textFieldValue(0) || '').trim().slice(0, 24) || 'Черга ' + id;
  return { name: name, id: id };
}

async function appMenu(ctx, st, cfg) {
  for (;;) {
    if (!cfg.queues.length) {
      const q = await askQueue(cfg);
      if (!q) return;
      cfg.queues.push(q); cfg.active = 0; st.saveConfig(cfg);
    }
    const a = new Alert();
    a.title = 'Svitlo';
    a.message = 'У віджеті: ' + cfg.queues[cfg.active].name + ' · ' + cfg.queues[cfg.active].id + '\nВерсія ' + VERSION;
    a.addAction('Показати віджет');
    cfg.queues.forEach((q, i) => a.addAction((i === cfg.active ? '✓ ' : '') + q.name + ' · ' + q.id));
    a.addAction('+ Додати чергу');
    if (cfg.queues.length > 1) a.addDestructiveAction('Видалити чергу…');
    a.addCancelAction('Закрити');
    const i = await a.presentSheet();
    if (i < 0) return;
    if (i === 0) { const w = await buildWidget(ctx, st, cfg, 'small'); await w.presentSmall(); continue; }
    if (i <= cfg.queues.length) { cfg.active = i - 1; st.saveConfig(cfg); continue; }
    if (i === cfg.queues.length + 1) {
      const q = await askQueue(cfg);
      if (q && !cfg.queues.some((x) => x.id === q.id && x.name === q.name)) { cfg.queues.push(q); cfg.active = cfg.queues.length - 1; st.saveConfig(cfg); }
      continue;
    }
    const r = new Alert(); r.title = 'Яку чергу видалити?';
    cfg.queues.forEach((q) => r.addDestructiveAction(q.name + ' · ' + q.id));
    r.addCancelAction('Скасувати');
    const k = await r.presentSheet();
    if (k >= 0) { cfg.queues.splice(k, 1); cfg.active = 0; st.saveConfig(cfg); }
  }
}

module.exports.VERSION = VERSION;
module.exports.run = async function (ctx) {
  const st = store(ctx);
  let cfg;
  try {
    cfg = await st.loadConfig();
    if (config.runsInWidget) {
      Script.setWidget(await buildWidget(ctx, st, cfg, config.widgetFamily));
    } else {
      await appMenu(ctx, st, cfg);
    }
  } catch (e) {
    // show the error instead of a blank widget, so it can be screenshotted and reported
    const w = messageWidget(ctx, 'Svitlo ' + VERSION + ': помилка', String(e && e.message || e));
    if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
  }
  Script.complete();
};
module.exports._test = { pickQueue: pickQueue, model: model, refreshDate: refreshDate };
