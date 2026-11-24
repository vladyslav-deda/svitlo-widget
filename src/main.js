// Svitlo — main process: data fetching, schedule maths, tray, notifications, popover window.
// The popover (src/ui) is a pure view: it renders the model pushed from here.
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell,
  Notification, powerMonitor, nativeTheme,
} = require('electron');
const fs = require('fs');
const path = require('path');
const S = require('./schedule');

const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', 'assets');
const FETCH_EVERY_MS = 5 * 60 * 1000;
const TICK_MS = 20 * 1000;
const WARN_MIN = 15;
const PANEL_W = 368;
const SHADOW = 18; // transparent margin around the panel for its CSS shadow
const VOE_URL = 'https://disconnection.voe.com.ua';

let tray = null;
let win = null;
let parsed = null;         // parsed source
let lastFetch = { ok: false, at: 0, error: null };
let config = { queues: [], active: 0, autostart: true, notifyChanges: true };
let panelHeight = 600; // full window height incl. shadow margin, reported by the popover
let lastHideAt = 0;
const notified = new Set();
const liveNotes = new Set(); // keep shown notifications referenced so their click handlers survive GC

// ---------- persistence ----------
const userFile = (n) => path.join(app.getPath('userData'), n);

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(userFile('config.json'), 'utf8'));
    if (Array.isArray(c.queues)) config = { ...config, ...c };
  } catch (_) { /* first run */ }
  config.queues = config.queues.filter((q) => q && S.QUEUE_IDS.includes(q.id));
  if (config.active >= config.queues.length) config.active = 0;
}
function saveConfig() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(userFile('config.json'), JSON.stringify(config, null, 2));
  } catch (e) { console.error('saveConfig', e); }
}
function loadCache() {
  try { parsed = S.parseSource(JSON.parse(fs.readFileSync(userFile('cache.json'), 'utf8'))); } catch (_) { /* none */ }
}

// ---------- data ----------
let fetching = null;
async function fetchData() {
  if (fetching) return fetching;
  fetching = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(S.SOURCE_URL + '?t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.fact || !json.fact.data) throw new Error('unexpected format');
      const prev = parsed;
      parsed = S.parseSource(json);
      notifyChanges(prev, parsed);
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(userFile('cache.json'), text);
      lastFetch = { ok: true, at: Date.now(), error: null };
    } catch (e) {
      lastFetch = { ok: false, at: Date.now(), error: String(e.message || e) };
    } finally {
      clearTimeout(t);
      fetching = null;
      refresh();
    }
  })();
  return fetching;
}

// ---------- model ----------
// test hooks: SVITLO_NOW (ISO instant) fakes the clock
const nowDate = () => (process.env.SVITLO_NOW ? new Date(process.env.SVITLO_NOW) : new Date());

function buildModel() {
  const now = nowDate();
  const queues = config.queues.map((q) => ({ name: q.name, ...S.queueView(parsed, q.id, now) }));
  return {
    platform: IS_MAC ? 'mac' : 'win',
    queues,
    active: config.active,
    hasData: !!parsed,
    stale: S.isStale(parsed, now),
    sourceUpdatedAt: parsed && parsed.updatedAt,
    fetchError: lastFetch.ok ? null : lastFetch.error,
    autostart: config.autostart,
  };
}

// ---------- tray ----------
const icons = {};
function loadIcons() {
  const f = (n) => nativeImage.createFromPath(path.join(ASSETS, n));
  if (IS_MAC) {
    icons.on = f('trayOnTemplate.png'); icons.on.setTemplateImage(true);
    icons.off = f('trayOffTemplate.png'); icons.off.setTemplateImage(true);
  } else {
    icons.on = f('trayOn.png');
    icons.off = f('trayOff.png');
  }
}

function trayText(m) {
  const q = m.queues[m.active];
  if (!q) return { off: false, title: ' Оберіть чергу', tip: 'Світло: оберіть чергу' };
  const head = q.name + ' · ' + q.id;
  if (!q.status) return { off: false, title: ' —', tip: head + ': немає даних на сьогодні' };
  const s = q.status;
  if (s.off) return { off: true, title: ' до ' + S.hm(s.until), tip: head + ': світла немає до ' + (s.tomorrow ? 'завтра ' : '') + S.hm(s.until) };
  if (s.until == null) return { off: false, title: ' до кінця дня', tip: head + ': сьогодні відключень більше немає, графік на завтра ще не опубліковано' };
  const when = (s.tomorrow ? 'завтра ' : '') + S.hm(s.until);
  return { off: false, title: ' до ' + S.hm(s.until), tip: head + ': світло є до ' + when };
}

function updateTray(m) {
  if (!tray) return;
  const t = trayText(m);
  tray.setImage(t.off ? icons.off : icons.on);
  if (IS_MAC) tray.setTitle(t.title, { fontType: 'monospacedDigit' });
  tray.setToolTip(t.tip + (m.stale ? ' (дані застаріли)' : ''));
}

function maybeNotify(m) {
  if (!Notification.isSupported()) return;
  m.queues.forEach((q) => {
    const s = q.status;
    if (!s || s.off || s.until == null) return;
    const left = s.until - q.minutes;
    if (left <= 0 || left > WARN_MIN) return;
    const key = q.id + '|' + q.date + '|' + s.start;
    if (notified.has(key)) return;
    notified.add(key);
    notify({
      title: 'Через ' + left + ' хв вимкнуть світло',
      body: q.name + ' · черга ' + q.id + ' · ' + S.hm(s.start) + '–' + S.hm(s.end),
    }, () => showWindow());
  });
}

function notify(opts, onClick) {
  if (!Notification.isSupported()) return;
  if (process.env.SVITLO_LOG) console.log('[notify]', JSON.stringify(opts));
  const n = new Notification({ silent: false, ...opts });
  liveNotes.add(n);
  const drop = () => liveNotes.delete(n);
  n.on('click', () => { drop(); if (onClick) onClick(); });
  n.on('close', drop);
  n.show();
}

const rangeList = (iv) => iv.map(([a, b]) => S.hm(a) + '–' + S.hm(b)).join(', ');

// Tomorrow got published, or today's / tomorrow's outages changed for one of my queues.
// The baseline is whatever we had before this fetch (on launch: the cache from the previous run),
// so a change that happened while the computer slept is reported once it wakes up.
function notifyChanges(prev, next) {
  if (!prev || !config.notifyChanges) return;
  const ids = config.queues.map((q) => q.id);
  const changes = S.scheduleChanges(prev, next, ids, nowDate());
  changes.slice(0, 4).forEach((c) => {
    const qi = config.queues.findIndex((q) => q.id === c.id);
    const q = config.queues[qi];
    const day = c.today ? 'сьогодні' : 'завтра';
    let title, body;
    if (c.kind === 'published') {
      title = 'Графік на ' + day + ' · ' + q.name;
      body = c.intervals.length ? 'Без світла: ' + rangeList(c.intervals) : 'Відключень для черги ' + c.id + ' немає';
    } else {
      title = 'Графік на ' + day + ' змінився · ' + q.name;
      const lines = [];
      if (c.added.length) lines.push('Додали: ' + rangeList(c.added));
      if (c.removed.length) lines.push('Скасували: ' + rangeList(c.removed));
      const onlyAdded = !c.removed.length && JSON.stringify(c.added) === JSON.stringify(c.intervals);
      if (!onlyAdded) lines.push(c.intervals.length ? (c.today ? 'Далі без світла: ' : 'Без світла: ') + rangeList(c.intervals) : 'Більше відключень ' + day + ' немає');
      body = lines.join('\n');
    }
    notify({ title, body }, () => {
      if (qi >= 0) { config.active = qi; saveConfig(); }
      showWindow();
    });
  });
}

function refresh() {
  const m = buildModel();
  updateTray(m);
  maybeNotify(m);
  if (win && !win.isDestroyed()) win.webContents.send('model', m);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Відкрити', click: () => showWindow() },
    { label: 'Оновити дані', click: () => fetchData() },
    { type: 'separator' },
    {
      label: 'Запускати при вході', type: 'checkbox', checked: config.autostart,
      click: (item) => setAutostart(item.checked),
    },
    {
      label: 'Сповіщати про зміни графіка', type: 'checkbox', checked: config.notifyChanges,
      click: (item) => { config.notifyChanges = item.checked; saveConfig(); },
    },
    { type: 'separator' },
    ...updaterMenu(),
    { label: 'Вийти', click: () => app.quit() },
  ]);
}

function setAutostart(on) {
  config.autostart = !!on;
  saveConfig();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.autostart });
}

// ---------- self-update (Windows only) ----------
// Releases live on GitHub (see "publish" in package.json). The NSIS build checks them on launch and
// every few hours, downloads in the background and installs on quit or when the user clicks restart.
// macOS is skipped on purpose: Squirrel.Mac refuses updates for apps without an Apple Developer ID.
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
const upd = { enabled: false, state: 'idle', version: null }; // idle | checking | downloading | ready | latest | error

function startUpdater() {
  if (IS_MAC || !app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('updater', e); return; }
  upd.enabled = true;
  upd.au = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { upd.state = 'checking'; });
  autoUpdater.on('update-not-available', () => { upd.state = 'latest'; });
  autoUpdater.on('update-available', (i) => { upd.state = 'downloading'; upd.version = i.version; });
  autoUpdater.on('error', (e) => { upd.state = 'error'; console.error('updater', e && e.message); });
  autoUpdater.on('update-downloaded', (i) => {
    const first = upd.state !== 'ready';
    upd.state = 'ready'; upd.version = i.version;
    if (first) notify({ title: 'Svitlo ' + i.version + ' готовий', body: 'Натисніть, щоб перезапустити й оновити. Або оновлення встановиться саме при наступному запуску.' }, installUpdate);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* reported via 'error' */ });
  setTimeout(check, 10 * 1000);
  setInterval(check, UPDATE_EVERY_MS);
}

function installUpdate() {
  if (upd.state !== 'ready') return;
  setImmediate(() => upd.au.quitAndInstall(true, true)); // silent install, relaunch after
}

function updaterMenu() {
  const ver = { label: 'Svitlo ' + app.getVersion(), enabled: false };
  if (!upd.enabled) return [ver, { type: 'separator' }];
  let item;
  if (upd.state === 'ready') item = { label: 'Перезапустити й оновити до ' + upd.version, click: installUpdate };
  else if (upd.state === 'downloading') item = { label: 'Завантажую оновлення ' + (upd.version || '') + '…', enabled: false };
  else if (upd.state === 'checking') item = { label: 'Перевіряю оновлення…', enabled: false };
  else item = { label: upd.state === 'latest' ? 'Перевірити оновлення (у вас остання)' : 'Перевірити оновлення', click: () => upd.au.checkForUpdates().catch(() => {}) };
  return [ver, item, { type: 'separator' }];
}

// ---------- popover window ----------
function createWindow() {
  win = new BrowserWindow({
    width: PANEL_W + SHADOW * 2,
    height: panelHeight,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) hideWindow(); });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });
}

function placeWindow() {
  const W = PANEL_W + SHADOW * 2;
  const H = panelHeight;
  const tb = tray.getBounds();
  const anchor = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
  const disp = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const wa = disp.workArea;
  const below = anchor.y < disp.bounds.y + disp.bounds.height / 2; // menu bar / top taskbar
  let x = IS_MAC ? tb.x + tb.width - (W - SHADOW) : Math.round(anchor.x - W / 2);
  let y = below ? tb.y + tb.height + 6 - SHADOW : tb.y - H - 6 + SHADOW;
  if (!tb.width && !tb.height) { // tray bounds unavailable: bottom-right / top-right corner
    x = wa.x + wa.width - W;
    y = IS_MAC ? wa.y : wa.y + wa.height - H;
  }
  x = Math.max(wa.x - SHADOW, Math.min(x, wa.x + wa.width - W + SHADOW));
  y = Math.max(wa.y - SHADOW, Math.min(y, wa.y + wa.height - H + SHADOW));
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H });
}

function showWindow() {
  if (!win) return;
  placeWindow();
  win.show();
  win.focus();
  refresh();
  win.webContents.send('open');
}

let hideTimer = null;
function hideWindow() {
  if (!win || !win.isVisible()) return;
  lastHideAt = Date.now();
  win.webContents.send('close');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.hide(); }, 150);
}

function toggleWindow() {
  if (win.isVisible()) return hideWindow();
  if (Date.now() - lastHideAt < 300) return; // the click that blurred us
  clearTimeout(hideTimer);
  showWindow();
}

function openExternal(url) {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
}

// ---------- IPC ----------
function wireIpc() {
  ipcMain.handle('model', () => buildModel());
  ipcMain.on('set-active', (_e, i) => {
    if (Number.isInteger(i) && i >= 0 && i < config.queues.length) { config.active = i; saveConfig(); refresh(); }
  });
  ipcMain.on('add-queue', (_e, q) => {
    if (!q || !S.QUEUE_IDS.includes(q.id) || config.queues.some((x) => x.id === q.id)) return;
    const name = String(q.name || '').trim().slice(0, 24) || 'Черга';
    config.queues.push({ name, id: q.id });
    config.active = config.queues.length - 1;
    saveConfig(); refresh();
  });
  ipcMain.on('remove-queue', (_e, i) => {
    if (!Number.isInteger(i) || i < 0 || i >= config.queues.length) return;
    config.queues.splice(i, 1);
    if (config.active >= config.queues.length || i < config.active) config.active = Math.max(0, config.active - 1);
    saveConfig(); refresh();
  });
  ipcMain.handle('refresh', () => fetchData().then(() => buildModel()));
  ipcMain.on('open-voe', () => openExternal(VOE_URL));
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('hide', () => hideWindow());
  ipcMain.on('height', (_e, h) => {
    if (typeof h !== 'number' || h < 100 || h > 1200) return;
    const nh = Math.ceil(h);
    if (nh === panelHeight) return;
    panelHeight = nh;
    if (win && win.isVisible()) placeWindow();
  });
}

// ---------- lifecycle ----------
if (process.env.SVITLO_USERDATA) app.setPath('userData', process.env.SVITLO_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  if (!IS_MAC) app.setAppUserModelId('ua.svitlo.widget');

  app.whenReady().then(() => {
    if (IS_MAC && app.dock) app.dock.hide();
    loadConfig();
    loadCache();
    loadIcons();
    wireIpc();
    createWindow();

    tray = new Tray(icons.on);
    tray.on('click', () => toggleWindow());
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
    if (!IS_MAC) tray.on('double-click', () => showWindow());

    const firstRun = !fs.existsSync(userFile('config.json'));
    if (firstRun) { saveConfig(); setAutostart(true); }

    refresh();
    fetchData();
    startUpdater();
    setInterval(fetchData, FETCH_EVERY_MS);
    setInterval(refresh, TICK_MS);
    powerMonitor.on('resume', () => { refresh(); fetchData(); });
    powerMonitor.on('unlock-screen', () => { refresh(); fetchData(); });
    nativeTheme.on('updated', refresh);

    if (process.env.SVITLO_THEME) nativeTheme.themeSource = process.env.SVITLO_THEME;
    if (process.env.SVITLO_SHOT) {
      // dev: open the popover, save a screenshot, quit
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        showWindow();
        setTimeout(async () => {
          if (process.env.SVITLO_HOVER) {
            // dev: simulate the mouse over the day line at minute N
            await win.webContents.executeJavaScript(`(() => { const b = document.getElementById('bar'), r = b.getBoundingClientRect();
              b.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * ${Number(process.env.SVITLO_HOVER)} / 1440, clientY: r.top + 5, bubbles: true })); })()`);
            await new Promise((res) => setTimeout(res, 400));
          }
          const img = await win.capturePage();
          fs.writeFileSync(process.env.SVITLO_SHOT, img.toPNG());
          app.exit(0);
        }, Number(process.env.SVITLO_SHOT_DELAY || 2200));
      }, 1500));
      return;
    }

    // first run: nobody knows their queue yet -> open straight on "add queue"
    if (!config.queues.length) win.webContents.once('did-finish-load', () => setTimeout(showWindow, 400));
  });

  app.on('window-all-closed', (e) => e.preventDefault());
}
