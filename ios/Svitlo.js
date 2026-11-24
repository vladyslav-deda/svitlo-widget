// Svitlo — графік відключень світла (Вінницяобленерго) у віджеті iPhone.
// https://github.com/vladyslav-deda/svitlo-widget
//
// Це лише завантажувач: він бере свіжу версію віджета з GitHub і запускає її.
// Тут нічого міняти не треба — оновлення приходять самі.

const CHANNEL = 'ios-stable';
const CORE_URL = 'https://raw.githubusercontent.com/vladyslav-deda/svitlo-widget/' + CHANNEL + '/ios/core.js';
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

// keep the core (and settings) next to this script, in iCloud or locally — wherever the script itself lives
let fm = FileManager.local();
try { const ic = FileManager.iCloud(); if (ic.isFileStoredIniCloud(module.filename)) fm = ic; } catch (e) { /* iCloud off */ }
const here = module.filename.split('/').slice(0, -1).join('/');
const dir = fm.joinPath(here, 'svitlo');
const file = fm.joinPath(dir, 'core.js');
if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
if (fm.fileExists(file) && !fm.isFileDownloaded(file)) await fm.downloadFileFromiCloud(file);

const age = fm.fileExists(file) ? Date.now() - fm.modificationDate(file).getTime() : Infinity;
if (age > CHECK_EVERY_MS || (args.queryParameters || {}).update) {
  try {
    const req = new Request(CORE_URL + '?t=' + Date.now());
    req.timeoutInterval = 10;
    const code = await req.loadString();
    // replace the working copy only with a complete file
    if (req.response.statusCode === 200 && code.indexOf('SVITLO_CORE_END') > 0) fm.writeString(file, code);
    else if (fm.fileExists(file)) fm.writeString(file, fm.readString(file)); // keep the old one, check again later
  } catch (e) { /* offline: run the copy we have */ }
}

if (!fm.fileExists(file)) {
  const w = new ListWidget();
  w.addText('Svitlo: не вдалося завантажити. Перевірте інтернет і відкрийте ще раз.').font = Font.systemFont(12);
  if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
  Script.complete();
} else {
  // run the downloaded core as a CommonJS-style module
  const mod = { exports: {} };
  new Function('module', 'exports', fm.readString(file))(mod, mod.exports);
  await mod.exports.run({ fm: fm, dir: dir, scriptName: Script.name() });
}
