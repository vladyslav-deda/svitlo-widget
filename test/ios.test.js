// iOS core (ios/core.js, built by scripts/build-ios.js): parts that do not need the Scriptable API
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sb = { module: { exports: {} }, Intl, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ios/core.js'), 'utf8'), sb);
const T = sb.module.exports._test;
const cfg = { queues: [{ name: 'Дім', id: '6.2' }, { name: 'Батьки', id: '3.1' }], active: 0, styles: { small: 'tile' } };
const pp = (p, fam = 'small') => { const r = T.parseParam(cfg, p, fam); return [r.queue && r.queue.name, r.style]; };

test('widget Parameter: empty -> active queue and saved style', () => assert.deepStrictEqual(pp(''), ['Дім', 'tile']));
test('widget Parameter: queue by name, style word, any order and case', () => {
  assert.deepStrictEqual(pp('Батьки, таймер'), ['Батьки', 'timer']);
  assert.deepStrictEqual(pp('ТАЙМЕР батьки'), ['Батьки', 'timer']);
  assert.deepStrictEqual(pp('кільце 6.2'), ['Дім', 'ring']);
});
test('widget Parameter: unknown saved queue id still works', () => assert.deepStrictEqual(pp('4,1'), ['Черга', 'tile']));
test('widget Parameter: style words are per size; default style when none saved', () => {
  assert.deepStrictEqual(pp('', 'medium'), ['Дім', 'line']);
  assert.deepStrictEqual(pp('далі', 'medium'), ['Дім', 'next']);
  assert.deepStrictEqual(pp('', 'large'), ['Дім', 'mac']);
});
test('core bundle ends with the completeness marker the loader checks', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'ios/core.js'), 'utf8').trimEnd().endsWith('// SVITLO_CORE_END'));
});
