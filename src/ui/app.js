/* Popover view. Renders the model pushed by the main process; keeps DOM nodes stable so
   CSS transitions/animations only fire when something actually changes. */
(function () {
  'use strict';
  var S = window.Schedule;
  var api = window.svitlo;
  var $ = function (id) { return document.getElementById(id); };

  var model = null;
  var ui = { active: 0, tab: 'today', screen: 'main', newId: null, spin: 0 };
  var sig = { chips: '', segs: '', big: '' };

  var WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var ICON_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/><path d="M3 3l18 18"/></svg>';
  var ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_PLUS = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dayLabel(iso, add) {
    var d = new Date(S.addDays(iso, add) + 'T12:00:00Z');
    return WD[d.getUTCDay()] + ' ' + d.getUTCDate();
  }
  function kyivHM(ms) {
    if (!ms) return '—';
    var c = S.kyivClock(new Date(ms));
    return S.hm(c.minutes);
  }
  function restartAnim(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function dotCls(q) {
    if (!q.status) return 'dot unk';
    return 'dot ' + (q.status.off ? 'off' : 'on');
  }

  function lbl(m) { return S.hm(m).replace(':00', ''); }

  // hour notches inside the bar
  (function () {
    var html = '';
    for (var h = 1; h < 24; h++) html += '<span class="notch" style="left:' + (h / 24 * 100) + '%"></span>';
    $('notches').innerHTML = html;
  })();

  // only the times when power goes off / comes back, placed at the exact boundary; close ones drop to a 2nd row
  function buildMarks(list, W) {
    var pts = [];
    list.forEach(function (iv) { if (iv[0] > 0) pts.push(iv[0]); if (iv[1] < 1440) pts.push(iv[1]); });
    var xOf = function (m) { return m / 1440 * W; };
    var nearL = pts.some(function (m) { return xOf(m) < 24; }), nearR = pts.some(function (m) { return xOf(m) > W - 24; });
    var html = '', last = [-Infinity, -Infinity], two = false;
    if (!nearL) { html += '<span class="mk end first" style="left:0"><i></i><span>00</span></span>'; last[0] = 16; }
    if (!nearR) html += '<span class="mk end last" style="left:' + W + 'px"><i></i><span>24</span></span>';
    pts.forEach(function (m) {
      var x = xOf(m), txt = lbl(m), w = txt.length * 6.6 + 4;
      var row = x - w / 2 > last[0] + 3 ? 0 : (x - w / 2 > last[1] + 3 ? 1 : 0);
      if (row) two = true;
      last[row] = x + w / 2;
      html += '<span class="mk' + (row ? ' r2' : '') + '" data-m="' + m + '" style="left:' + x.toFixed(1) + 'px"><i></i><span>' + txt + '</span></span>';
    });
    $('marks').innerHTML = html;
    $('marks').classList.toggle('two', two);
  }

  // ---------- render ----------
  function render() {
    if (!model) return;
    document.body.className = model.platform;
    var queues = model.queues;
    if (!queues.length) { showScreen('add'); renderAdd(); report(); return; }
    if (ui.active >= queues.length) ui.active = model.active < queues.length ? model.active : 0;
    var q = queues[ui.active];

    renderChips(queues);
    renderHero(q);
    renderTabs(q);
    renderDay(q);
    renderFoot(q);
    if (ui.screen === 'add') renderAdd();
    report();
  }

  function renderChips(queues) {
    var box = $('chips');
    var s = queues.map(function (q) { return q.name + '|' + q.id; }).join(',') + '#' + ui.active;
    if (s !== sig.chips) {
      sig.chips = s;
      box.innerHTML = queues.map(function (q, i) {
        return '<button class="chip' + (i === ui.active ? ' on' : '') + '" data-i="' + i + '" aria-pressed="' + (i === ui.active) + '">' +
          '<span class="' + dotCls(q) + '"></span>' + esc(q.name) + ' · ' + q.id + '</button>';
      }).join('') + '<button class="chip add" id="chipAdd">' + ICON_PLUS + 'Додати</button>';
    } else {
      queues.forEach(function (q, i) {
        var dot = box.children[i] && box.children[i].firstElementChild;
        if (dot && dot.className !== dotCls(q)) dot.className = dotCls(q);
      });
    }
  }

  function renderHero(q) {
    var hero = $('hero'), st = q.status;
    var state = !st ? 'unk' : st.off ? 'off' : 'on';
    var cls = 'hero stg ' + state;
    if (hero.className !== cls) hero.className = cls;
    var title, sub, big = '', cap = '';
    if (!st) {
      title = 'Немає даних';
      sub = 'графік на сьогодні ще не завантажено';
    } else if (st.off) {
      title = 'Світла немає';
      sub = 'увімкнуть ' + (st.tomorrow ? 'завтра ' : '') + 'о <b>' + S.hm(st.until) + '</b>';
      big = S.hShort(st.until - q.minutes); cap = 'год до ввімкнення';
    } else if (st.until != null) {
      title = 'Світло є';
      sub = 'вимкнуть ' + (st.tomorrow ? 'завтра ' : '') + 'о <b>' + S.hm(st.until) + '</b>';
      big = S.hShort(st.until - q.minutes); cap = 'год до вимкнення';
    } else {
      title = 'Світло є';
      sub = q.today && q.today.length ? 'сьогодні більше без відключень' : 'сьогодні відключень немає';
    }
    $('heroTitle').textContent = title;
    $('heroSub').innerHTML = sub;
    $('heroRight').hidden = !big;
    if (big !== sig.big) {
      sig.big = big;
      var el = $('heroBig');
      el.textContent = big;
      el.className = 'hero-big ' + (el.classList.contains('tk-a') ? 'tk-b' : 'tk-a');
    }
    $('heroCap').textContent = cap;
  }

  function renderTabs(q) {
    var today = ui.tab === 'today';
    $('tabToday').textContent = 'Сьогодні · ' + dayLabel(q.date, 0);
    $('tabTom').textContent = 'Завтра · ' + dayLabel(q.date, 1);
    $('tabToday').setAttribute('aria-pressed', today);
    $('tabTom').setAttribute('aria-pressed', !today);
    $('tabsPill').style.transform = 'translateX(' + (today ? '0%' : '100%') + ')';
  }

  function renderDay(q) {
    var isToday = ui.tab === 'today';
    var list = isToday ? q.today : q.tomorrow;
    $('dayBox').hidden = !list;
    $('dayMissing').hidden = !!list;
    if (!list) {
      $('missTitle').textContent = isToday ? 'Графік на сьогодні ще не завантажено' : 'Графік ще не опубліковано';
      $('missText').textContent = isToday ? 'Перевірте інтернет або натисніть «Оновити»' : 'Зазвичай з\'являється ввечері. Віджет оновиться сам';
      sig.segs = '';
      return;
    }
    var t = q.minutes;

    // segments
    var segs = [], p = 0;
    list.forEach(function (iv) {
      if (iv[0] > p) segs.push({ from: p, to: iv[0], off: false });
      segs.push({ from: iv[0], to: iv[1], off: true });
      p = iv[1];
    });
    if (p < 1440) segs.push({ from: p, to: 1440, off: false });
    var bar = $('bar');
    var s = q.id + ui.tab + JSON.stringify(list);
    if (s !== sig.segs) {
      sig.segs = s;
      Array.prototype.slice.call(bar.querySelectorAll('.sg')).forEach(function (n) { n.remove(); });
      var frag = document.createDocumentFragment();
      segs.forEach(function (sg, i) {
        var d = document.createElement('div');
        d.className = 'sg';
        d.style.left = 'calc(' + (sg.from / 14.4) + '% + 1.5px)';
        d.style.width = 'calc(' + ((sg.to - sg.from) / 14.4) + '% - 3px)';
        d.style.setProperty('--i', i);
        d.dataset.from = sg.from; d.dataset.to = sg.to;
        frag.appendChild(d);
      });
      bar.insertBefore(frag, $('notches'));
      buildMarks(list, bar.clientWidth);
    }
    var mks = $('marks').querySelectorAll('.mk[data-m]');
    for (var li = 0; li < mks.length; li++) mks[li].classList.toggle('past', isToday && +mks[li].dataset.m <= t);
    var nodes = bar.querySelectorAll('.sg'), k = 0;
    for (var i = 0; i < nodes.length; i++) {
      var sg = segs[k++];
      if (!sg) break;
      var cls = 'sg ' + (sg.off ? 'off' : 'on') + (isToday && sg.to <= t ? ' past' : '');
      if (nodes[i].classList.contains('hl')) cls += ' hl';
      if (nodes[i].className !== cls) nodes[i].className = cls;
    }

    // now marker
    var marker = $('marker');
    marker.hidden = !isToday;
    if (isToday) {
      marker.style.transform = 'translateX(' + Math.round((t / 1440) * bar.clientWidth) + 'px)';
    }
    ui.day = { list: list, segs: segs, t: t, isToday: isToday };

    // rows
    var total = 0, nextMarked = false;
    var html = list.map(function (iv, idx) {
      total += iv[1] - iv[0];
      var kind = 'future';
      if (isToday) {
        if (iv[1] <= t) kind = 'past';
        else if (iv[0] <= t) kind = 'cur';
        else if (!nextMarked) kind = 'next';
      }
      if (kind === 'cur' || kind === 'next') nextMarked = true;
      var d = S.durLong(iv[1] - iv[0]);
      var sub = { past: 'минуло · ' + d, cur: 'зараз · ' + d, next: 'наступне · ' + d, future: d }[kind];
      var badge = kind === 'cur' ? 'ще ' + S.hShort(iv[1] - t) : kind === 'next' ? 'через ' + S.hShort(iv[0] - t) : '';
      var prog = kind === 'cur'
        ? '<span class="prog"><span class="prog-in" style="transform:scaleX(' + ((t - iv[0]) / (iv[1] - iv[0])).toFixed(3) + ')"></span></span>' : '';
      return '<div class="row ' + kind + '" data-i="' + idx + '"><span class="row-ico">' + (kind === 'past' ? ICON_CHECK : ICON_OFF) + '</span>' +
        '<span class="row-main"><span class="row-t">' + S.hm(iv[0]) + ' – ' + S.hm(iv[1]) + '</span><span class="row-s">' + sub + '</span>' + prog + '</span>' +
        (badge ? '<span class="badge">' + badge + '</span>' : '') + '</div>';
    }).join('');
    if (!list.length) html = '<div class="empty"><b>Відключень не заплановано</b>Світло має бути весь день</div>';
    else html = '<span class="sec">Відключення · ' + S.durLong(total) + '</span>' + html;
    $('rows').innerHTML = html;
    if (ui.hover != null) showAt(ui.hover);
  }

  // ---------- hover / keyboard on the day line ----------
  function relText(sg) {
    var d = ui.day;
    if (!d.isToday) return 'завтра';
    if (sg.to <= d.t) return 'минуло';
    if (sg.from <= d.t) return 'зараз · ще ' + S.hShort(sg.to - d.t);
    return 'через ' + S.hShort(sg.from - d.t);
  }
  function highlight(from, to) {
    var nodes = $('bar').querySelectorAll('.sg');
    for (var i = 0; i < nodes.length; i++) {
      var on = from != null && +nodes[i].dataset.from === from && +nodes[i].dataset.to === to;
      nodes[i].classList.toggle('hl', on);
    }
    var rows = $('rows').querySelectorAll('.row');
    for (var j = 0; j < rows.length; j++) {
      var iv = ui.day && ui.day.list[+rows[j].dataset.i];
      rows[j].classList.toggle('hl', !!iv && iv[0] === from && iv[1] === to);
    }
  }
  function showAt(m) {
    if (!ui.day) return;
    m = Math.max(0, Math.min(1439, m));
    ui.hover = m;
    var sg = ui.day.segs.filter(function (s) { return m >= s.from && m < s.to; })[0];
    if (!sg) return;
    var bar = $('bar'), W = bar.clientWidth, x = m / 1440 * W, tip = $('tip');
    tip.innerHTML = '<b>' + S.hm(sg.from) + ' – ' + S.hm(sg.to) + '</b><br>' + (sg.off ? 'Світла немає' : 'Світло є') + ' · ' + S.durLong(sg.to - sg.from) + '<br><span>' + relText(sg) + '</span>';
    var tw = tip.offsetWidth, tlW = $('tl').clientWidth, left = bar.offsetLeft + x - tw / 2;
    tip.style.left = Math.max(0, Math.min(tlW - tw, left)) + 'px';
    tip.style.bottom = ($('tl').clientHeight - bar.offsetTop + 10) + 'px';
    tip.classList.add('show');
    $('curX').style.transform = 'translateX(' + x.toFixed(1) + 'px)';
    $('curX').style.opacity = '.6';
    if (sg.off) highlight(sg.from, sg.to); else highlight(null);
  }
  function hideTip() {
    ui.hover = null;
    $('tip').classList.remove('show');
    $('curX').style.opacity = '0';
    highlight(null);
  }
  $('bar').addEventListener('pointermove', function (e) {
    var r = $('bar').getBoundingClientRect();
    showAt((e.clientX - r.left) / r.width * 1440);
  });
  $('bar').addEventListener('pointerleave', hideTip);
  $('bar').addEventListener('blur', hideTip);
  $('bar').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    var start = ui.hover != null ? ui.hover : (ui.day && ui.day.isToday ? ui.day.t : 0);
    showAt(Math.round(start / 30) * 30 + (e.key === 'ArrowRight' ? 30 : -30));
  });
  $('rows').addEventListener('pointerover', function (e) {
    var row = e.target.closest('.row');
    if (!row || !ui.day) return;
    var iv = ui.day.list[+row.dataset.i];
    if (iv) highlight(iv[0], iv[1]);
  });
  $('rows').addEventListener('pointerleave', function () { if (ui.hover == null) highlight(null); });

  function renderFoot(q) {
    $('qtag').textContent = 'Черга ' + q.id;
    var up = $('updated');
    if (!model.hasData) { up.textContent = 'немає даних'; up.className = 'warn'; up.title = model.fetchError || ''; }
    else if (model.stale) { up.textContent = 'дані застаріли · ' + kyivHM(model.sourceUpdatedAt); up.className = 'warn'; up.title = model.fetchError || 'Джерело давно не оновлювалось'; }
    else { up.textContent = 'дані на ' + kyivHM(model.sourceUpdatedAt); up.className = ''; up.title = ''; }
  }

  function renderAdd() {
    var queues = model ? model.queues : [];
    var first = !queues.length;
    $('firstRun').hidden = !first;
    $('firstRun').textContent = 'Оберіть свою чергу — і графік з\'явиться ' + (model && model.platform === 'win' ? 'в треї біля годинника.' : 'в меню-барі.');
    $('addBack').hidden = first;
    $('addCancel').hidden = first;
    $('addCancel').parentElement.className = first ? 'btns single' : 'btns';
    $('addTitle').textContent = first ? 'Вітаємо!' : 'Нова черга';
    var used = queues.map(function (q) { return q.id; });
    if (used.indexOf(ui.newId) !== -1) ui.newId = null;
    $('qgrid').innerHTML = S.QUEUE_IDS.map(function (id) {
      var u = used.indexOf(id) !== -1;
      return '<button class="qb' + (ui.newId === id ? ' sel' : '') + '" data-id="' + id + '"' + (u ? ' disabled' : '') +
        ' aria-pressed="' + (ui.newId === id) + '">' + id + '</button>';
    }).join('');
    $('savedBox').hidden = first;
    $('saved').innerHTML = queues.map(function (q, i) {
      return '<div class="saved"><span class="' + dotCls(q) + '"></span><span class="nm">' + esc(q.name) + ' · ' + q.id + '</span>' +
        '<button class="ibtn" data-rm="' + i + '" aria-label="Видалити чергу"' + (queues.length < 2 ? ' disabled' : '') + '>' + ICON_TRASH + '</button></div>';
    }).join('');
    $('addOk').disabled = !ui.newId;
  }

  // ---------- size reporting (window follows the panel height) ----------
  var lastH = 0;
  function report() {
    requestAnimationFrame(function () {
      var h = $('panel').offsetHeight + 36;
      if (h !== lastH) { lastH = h; api.reportHeight(h); }
    });
  }
  new ResizeObserver(report).observe($('panel'));

  // ---------- transitions ----------
  function swap(boxId, mutate) {
    var box = $(boxId);
    box.classList.add('out');
    setTimeout(function () {
      mutate();
      render();
      box.classList.remove('out');
      restartAnim($('bar'), 'grow');
    }, 110);
  }
  function showScreen(name) {
    ui.screen = name;
    $('scrMain').className = 'screen' + (name === 'main' ? '' : ' away-l');
    $('scrAdd').className = 'screen' + (name === 'add' ? '' : ' away-r');
    if (name === 'add') setTimeout(function () { $('newName').focus(); }, 60);
  }

  // ---------- events ----------
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'chipAdd') { ui.newId = null; $('newName').value = ''; renderAdd(); showScreen('add'); report(); return; }
    var i = +b.dataset.i;
    if (i === ui.active) return;
    swap('qFade', function () { ui.active = i; });
    api.setActive(i);
  });
  $('tabToday').addEventListener('click', function () { if (ui.tab !== 'today') swap('tabFade', function () { ui.tab = 'today'; }); });
  $('tabTom').addEventListener('click', function () { if (ui.tab !== 'tomorrow') swap('tabFade', function () { ui.tab = 'tomorrow'; }); });
  $('btnRefresh').addEventListener('click', function () {
    ui.spin += 360;
    $('spin').style.transform = 'rotate(' + ui.spin + 'deg)';
    api.refresh().then(function (m) { model = m; render(); });
  });
  $('btnSite').addEventListener('click', function () { api.openVoe(); });
  $('voeLink').addEventListener('click', function () { api.openVoe(); });
  $('btnQuit').addEventListener('click', function () { api.quit(); });
  $('addBack').addEventListener('click', function () { showScreen('main'); render(); });
  $('addCancel').addEventListener('click', function () { showScreen('main'); render(); });
  $('qgrid').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    ui.newId = b.dataset.id;
    renderAdd();
  });
  $('saved').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-rm]');
    if (!b || b.disabled) return;
    var i = +b.dataset.rm;
    if (i < ui.active) ui.active--;
    api.removeQueue(i);
  });
  $('newName').addEventListener('keydown', function (e) { if (e.key === 'Enter' && ui.newId) $('addOk').click(); });
  $('addOk').addEventListener('click', function () {
    if (!ui.newId) return;
    var name = $('newName').value.trim() || ('Черга ' + ui.newId);
    ui.active = model ? model.queues.length : 0;
    ui.tab = 'today';
    api.addQueue(name, ui.newId);
    ui.newId = null;
    showScreen('main');
    restartAnim($('bar'), 'grow');
  });

  // ---------- main-process signals ----------
  api.onModel(function (m) {
    var firstModel = !model;
    model = m;
    if (firstModel) ui.active = m.active;
    render();
  });
  api.onOpen(function () {
    ui.tab = 'today';
    sig.segs = ''; // re-measure labels with the real width
    if (model && model.queues.length) showScreen('main');
    var panel = $('panel');
    panel.classList.remove('open');
    void panel.offsetWidth;
    panel.classList.add('open');
    render();
    restartAnim($('bar'), 'grow');
  });
  api.onClose(function () { $('panel').classList.remove('open'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') api.hide(); });

  api.getModel().then(function (m) { model = m; ui.active = m.active; render(); });
})();
