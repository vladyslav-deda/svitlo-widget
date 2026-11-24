// Pure schedule logic shared by the main process (Node) and the popover (browser).
// No Electron / DOM / Node APIs in here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Schedule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCE_URL = 'https://raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia/main/data/Vinnytsiaoblenerho.json';
  var QUEUE_IDS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
  var STALE_MS = 3 * 60 * 60 * 1000;
  var TZ = 'Europe/Kyiv';

  var partsFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  // { date: 'YYYY-MM-DD', minutes: 0..1439 } for an instant, in Kyiv wall-clock time
  function kyivClock(date) {
    var p = {};
    partsFmt.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: (+p.hour % 24) * 60 + (+p.minute) };
  }

  function addDays(isoDate, n) {
    var d = new Date(isoDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // The mirror keys each day by "Kyiv midnight" computed with a fixed UTC+2 offset.
  // Shifting by +2h and reading the UTC date recovers the calendar date in any season.
  function keyToDate(key) {
    return new Date((Number(key) + 7200) * 1000).toISOString().slice(0, 10);
  }

  // Slot "k" (1..24) covers hour k-1..k. Values (verified against the mirror's parser/renderer):
  //   yes = power on, no = off all hour, first = off in the FIRST half, second = off in the SECOND half.
  // Returns merged off-intervals in minutes: [[start, end], ...]
  function slotsToIntervals(slots) {
    var halves = [];
    for (var k = 1; k <= 24; k++) {
      var v = slots ? slots[String(k)] : 'yes';
      if (v === 'no') halves.push(true, true);
      else if (v === 'first') halves.push(true, false);
      else if (v === 'second') halves.push(false, true);
      else halves.push(false, false);
    }
    var out = [], start = -1;
    for (var i = 0; i <= 48; i++) {
      var off = i < 48 && halves[i];
      if (off && start < 0) start = i;
      if (!off && start >= 0) { out.push([start * 30, i * 30]); start = -1; }
    }
    return out;
  }

  // Parse the mirror JSON into calendar days.
  // => { updatedAt (ms|null), sourceOk, days: { 'YYYY-MM-DD': { published, queues: { '3.1': [[s,e],..] } } } }
  function parseSource(json) {
    var fact = (json && json.fact) || {};
    var data = fact.data || {};
    var days = {};
    Object.keys(data).forEach(function (key) {
      var day = data[key] || {};
      var queues = {}, published = false;
      QUEUE_IDS.forEach(function (id) {
        var slots = day['GPV' + id];
        if (!slots) return;
        queues[id] = slotsToIntervals(slots);
        if (queues[id].length) published = true;
      });
      days[keyToDate(key)] = { published: published, queues: queues };
    });
    var status = json && json.lastUpdateStatus;
    return {
      updatedAt: json && typeof json.lastUpdated === 'number' ? json.lastUpdated * 1000 : null,
      sourceOk: !status || status.ok !== false,
      days: days
    };
  }

  // Status of one day's intervals at minute m.
  // => { off, until (minute or null = no more changes today), start, end }
  function statusAt(intervals, m) {
    var iv = intervals || [];
    for (var i = 0; i < iv.length; i++) {
      if (m >= iv[i][0] && m < iv[i][1]) return { off: true, until: iv[i][1], start: iv[i][0], end: iv[i][1] };
    }
    for (var j = 0; j < iv.length; j++) {
      if (iv[j][0] > m) return { off: false, until: iv[j][0], start: iv[j][0], end: iv[j][1] };
    }
    return { off: false, until: null };
  }

  // Everything the UI and the tray need for one queue, at instant `now`.
  // today === null  -> no data for today (unknown)
  // tomorrow === null -> tomorrow not published yet
  function queueView(parsed, id, now) {
    var clock = kyivClock(now);
    var today = parsed && parsed.days[clock.date];
    var tom = parsed && parsed.days[addDays(clock.date, 1)];
    var todayIv = today ? (today.queues[id] || []) : null;
    var tomIv = tom && tom.published ? (tom.queues[id] || []) : null;
    var status = todayIv ? statusAt(todayIv, clock.minutes) : null;
    // look across midnight: next outage tomorrow, or an outage that runs on past 24:00
    if (status && tomIv && tomIv.length) {
      if (!status.off && status.until == null) {
        status = { off: false, until: 1440 + tomIv[0][0], start: 1440 + tomIv[0][0], end: 1440 + tomIv[0][1], tomorrow: true };
      } else if (status.off && status.until === 1440 && tomIv[0][0] === 0) {
        status = { off: true, until: 1440 + tomIv[0][1], start: status.start, end: 1440 + tomIv[0][1], tomorrow: true };
      }
    }
    return {
      id: id,
      minutes: clock.minutes,
      date: clock.date,
      today: todayIv,
      todayPublished: !!(today && today.published),
      tomorrow: tomIv,
      status: status
    };
  }

  // Minute-resolution set difference of two interval lists: parts of `a` not covered by `b`.
  function minusIntervals(a, b) {
    var mask = new Array(1441).join('0').split('').map(Number);
    (a || []).forEach(function (iv) { for (var m = iv[0]; m < iv[1]; m++) mask[m] = 1; });
    (b || []).forEach(function (iv) { for (var m = iv[0]; m < iv[1]; m++) mask[m] = 0; });
    var out = [], start = -1;
    for (var i = 0; i <= 1440; i++) {
      var on = i < 1440 && mask[i] === 1;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([start, i]); start = -1; }
    }
    return out;
  }

  function sameIntervals(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // What changed between two parsed sources for the given queues, from the point of view of `now`.
  // Only today (from now on) and tomorrow are compared; outages that already ended are ignored,
  // so the mirror rewriting history never triggers anything. A day missing from `next` is ignored too.
  // => [{ kind: 'published'|'changed', id, date, today, intervals, added, removed }]
  function scheduleChanges(prev, next, ids, now) {
    var clock = kyivClock(now);
    var out = [];
    [clock.date, addDays(clock.date, 1)].forEach(function (date, di) {
      var p = prev && prev.days[date];
      var n = next && next.days[date];
      if (!n) return;
      var from = di === 0 ? clock.minutes : 0;
      var ahead = function (iv) { return (iv || []).filter(function (x) { return x[1] > from; }); };
      ids.forEach(function (id) {
        var nIv = n.published ? ahead(n.queues[id]) : [];
        if (!p || !p.published) {
          if (n.published) out.push({ kind: 'published', id: id, date: date, today: di === 0, intervals: nIv, added: nIv, removed: [] });
          return;
        }
        var pIv = ahead(p.queues[id]);
        if (sameIntervals(pIv, nIv)) return;
        out.push({
          kind: 'changed', id: id, date: date, today: di === 0, intervals: nIv,
          added: minusIntervals(nIv, pIv), removed: minusIntervals(pIv, nIv)
        });
      });
    });
    return out;
  }

  function isStale(parsed, now) {
    if (!parsed || !parsed.updatedAt) return true;
    return !parsed.sourceOk || now.getTime() - parsed.updatedAt > STALE_MS;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(m) { if (m === 1440) return '24:00'; m = m % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function hShort(m) { return Math.floor(m / 60) + ':' + pad(m % 60); }
  function durLong(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    if (h && mm) return h + ' год ' + mm + ' хв';
    if (h) return h + ' год';
    return mm + ' хв';
  }

  return {
    SOURCE_URL: SOURCE_URL, QUEUE_IDS: QUEUE_IDS, STALE_MS: STALE_MS,
    kyivClock: kyivClock, addDays: addDays, keyToDate: keyToDate,
    slotsToIntervals: slotsToIntervals, parseSource: parseSource,
    statusAt: statusAt, queueView: queueView, isStale: isStale,
    minusIntervals: minusIntervals, scheduleChanges: scheduleChanges,
    hm: hm, hShort: hShort, durLong: durLong
  };
});
