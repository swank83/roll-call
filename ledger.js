/* Ledger logic for the Portland Takedown roll call.
   Pure functions only: no screen and no database, so the app and the tests share one set of rules.

   Rules, straight from the build brief:
   - Every person has their own ledger. Nothing is shared between people, siblings included.
   - Entries are never edited. A mistake is fixed by adding a "reverse" entry that points at it.
   - Free lessons, credits and what is owed are always worked out from the entries, never typed over.

   Entry types (all carry personId and at):
     attend   a lesson: classId, cover = free | credit | owed, priceCents (only when owed)
     pack     credits bought: size, amountCents, method
     settle   closes an owed lesson: ref = attend id, how = paid | comp | credit | free (+ amountCents, method, note)
     reverse  undoes any entry: ref = the entry id
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Ledger = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RATES = ['adult', 'junior', 'concession'];
  var SOURCES = ['parent', 'cross-trainer', 'teen', 'other'];
  var METHODS = ['cash', 'bank', 'card'];
  var COVERS = ['free', 'credit', 'owed'];
  var HOWS = ['paid', 'comp', 'credit', 'free'];
  var TYPES = ['attend', 'pack', 'settle', 'reverse'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var DEFAULT_SETTINGS = {
    freeLessons: 2,
    prices: {
      adult: { sessionCents: 2500, packs: { 5: 11000, 10: 20000 } },
      junior: { sessionCents: 1500, packs: { 5: 6600, 10: 12000, 20: 21000 } },
      concession: { sessionCents: 1500, packs: {} }
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function fail(reason, extra) {
    var r = { ok: false, reason: reason };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /* ---------- settings, money, dates ---------- */
  function normaliseSettings(raw) {
    var s = clone(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    if (isInt(raw.freeLessons) && raw.freeLessons >= 0) s.freeLessons = raw.freeLessons;
    RATES.forEach(function (r) {
      var src = raw.prices && raw.prices[r];
      if (!src) return;
      if (isInt(src.sessionCents) && src.sessionCents >= 0) s.prices[r].sessionCents = src.sessionCents;
      Object.keys(s.prices[r].packs).forEach(function (k) {
        var v = src.packs && src.packs[k];
        if (isInt(v) && v >= 0) s.prices[r].packs[k] = v;
      });
    });
    return s;
  }
  function sessionPrice(settings, rate) {
    var p = settings && settings.prices && settings.prices[rate];
    return p ? p.sessionCents : 0;
  }
  function packPrice(settings, rate, size) {
    var p = settings && settings.prices && settings.prices[rate];
    var v = p && p.packs ? p.packs[size] : undefined;
    return isInt(v) ? v : null;
  }
  function packSizes(settings, rate) {
    var p = settings && settings.prices && settings.prices[rate];
    return p && p.packs ? Object.keys(p.packs).map(Number).sort(function (a, b) { return a - b; }) : [];
  }
  function money(cents) {
    var neg = cents < 0;
    var c = Math.abs(Math.round(cents || 0));
    var d = Math.floor(c / 100), r = c % 100;
    return (neg ? '-' : '') + '$' + d + (r ? '.' + (r < 10 ? '0' : '') + r : '');
  }
  function parseDollars(text) {
    var t = String(text == null ? '' : text).trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(parseFloat(t) * 100);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) ? d : null;
  }
  function dateLabel(s) {
    var d = parseDate(s);
    return d ? DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] : String(s || '');
  }

  /* ---------- working out the balances ---------- */
  function byId(list) {
    var o = {};
    (list || []).forEach(function (x) { o[x.id] = x; });
    return o;
  }
  function groupByPerson(ledger) {
    var o = {};
    (ledger || []).forEach(function (e) { (o[e.personId] = o[e.personId] || []).push(e); });
    return o;
  }

  function summarise(person, entries, classesById) {
    classesById = classesById || {};
    var sorted = (entries || []).slice().sort(function (a, b) { return a.id - b.id; });
    var reversed = {};
    sorted.forEach(function (e) { if (e.type === 'reverse') reversed[e.ref] = true; });
    var active = sorted.filter(function (e) { return e.type !== 'reverse' && !reversed[e.id]; });

    var attends = active.filter(function (e) { return e.type === 'attend'; });
    var packs = active.filter(function (e) { return e.type === 'pack'; });
    var settles = active.filter(function (e) { return e.type === 'settle'; });

    var settleByAttend = {};
    settles.forEach(function (s) { settleByAttend[s.ref] = s; });
    var attendByClass = {};
    attends.forEach(function (a) { attendByClass[a.classId] = a; });

    var freeUsed = (person.freeUsedBefore || 0)
      + attends.filter(function (a) { return a.cover === 'free'; }).length
      + settles.filter(function (s) { return s.how === 'free'; }).length;
    var freeAllowed = isInt(person.freeAllowed) ? person.freeAllowed : DEFAULT_SETTINGS.freeLessons;
    var freeLeft = Math.max(0, freeAllowed - freeUsed);

    var bought = packs.reduce(function (n, p) { return n + p.size; }, 0);
    var used = attends.filter(function (a) { return a.cover === 'credit'; }).length
      + settles.filter(function (s) { return s.how === 'credit'; }).length;
    var credits = bought - used;

    var owed = attends
      .filter(function (a) { return a.cover === 'owed' && !settleByAttend[a.id]; })
      .map(function (a) {
        var c = classesById[a.classId];
        return { attendId: a.id, classId: a.classId, date: c ? c.date : '', priceCents: a.priceCents || 0 };
      });
    var owedCents = owed.reduce(function (n, o) { return n + o.priceCents; }, 0);

    var lastDate = '';
    attends.forEach(function (a) {
      var c = classesById[a.classId];
      if (c && c.date > lastDate) lastDate = c.date;
    });

    return {
      freeUsed: freeUsed, freeAllowed: freeAllowed, freeLeft: freeLeft,
      credits: credits, owed: owed, owedCents: owedCents,
      attendedCount: attends.length, lastDate: lastDate,
      attendByClass: attendByClass, settleByAttend: settleByAttend,
      active: active, reversed: reversed, sorted: sorted
    };
  }

  /* ---------- planners: each returns the entries to add, or a reason it cannot ---------- */
  function planTap(person, entries, classId, classesById, settings, confirmed, now) {
    var cls = classesById[classId];
    if (!cls) return fail('That class does not exist.');
    if (cls.cancelled) return fail('That class is cancelled.');
    var s = summarise(person, entries, classesById);
    var existing = s.attendByClass[classId];
    if (existing) {
      var settle = s.settleByAttend[existing.id] || null;
      if (settle && !confirmed) {
        return fail('This lesson was already settled. Undoing it also undoes that.', { needsConfirm: true, settle: settle });
      }
      var add = [];
      if (settle) add.push({ personId: person.id, type: 'reverse', ref: settle.id, at: now, note: 'lesson undone' });
      add.push({ personId: person.id, type: 'reverse', ref: existing.id, at: now });
      return { ok: true, add: add, info: { action: 'untap', attendId: existing.id } };
    }
    var cover = s.freeLeft > 0 ? 'free' : (s.credits > 0 ? 'credit' : 'owed');
    var price = cover === 'owed' ? sessionPrice(settings, person.rate) : 0;
    return {
      ok: true,
      add: [{ personId: person.id, type: 'attend', classId: classId, cover: cover, priceCents: price, at: now }],
      info: { action: 'attend', cover: cover, priceCents: price }
    };
  }

  function planPack(person, entries, size, amountCents, method, settings, now) {
    if (packPrice(settings, person.rate, size) === null) return fail('There is no ' + size + '-pack for the ' + person.rate + ' rate.');
    if (!isInt(amountCents) || amountCents < 0) return fail('Enter the amount paid.');
    if (METHODS.indexOf(method) < 0) return fail('Choose cash, bank or card.');
    var add = [{ personId: person.id, type: 'pack', size: size, amountCents: amountCents, method: method, at: now }];
    var after = summarise(person, (entries || []).concat([{ id: 1e12, personId: person.id, type: 'pack', size: size }]), {});
    return { ok: true, add: add, info: { creditsAfter: after.credits, owedCount: after.owed.length } };
  }

  function planSettle(person, entries, attendId, how, opts, classesById, now) {
    opts = opts || {};
    var s = summarise(person, entries, classesById);
    var owed = null;
    s.owed.forEach(function (o) { if (o.attendId === attendId) owed = o; });
    if (!owed) return fail('That lesson is not owing any more.');
    if (HOWS.indexOf(how) < 0) return fail('Choose how this lesson is settled.');
    var e = { personId: person.id, type: 'settle', ref: attendId, how: how, at: now };
    if (how === 'credit' && s.credits < 1) return fail('There are no pack credits left.');
    if (how === 'free' && s.freeLeft < 1) return fail('There are no free lessons left.');
    if (how === 'comp') {
      var note = String(opts.note || '').trim();
      if (!note) return fail('Add a short reason for comping this lesson.');
      e.note = note;
    }
    if (how === 'paid') {
      var amt = opts.amountCents == null ? owed.priceCents : opts.amountCents;
      if (!isInt(amt) || amt < 0) return fail('Enter the amount paid.');
      if (METHODS.indexOf(opts.method) < 0) return fail('Choose cash, bank or card.');
      e.amountCents = amt;
      e.method = opts.method;
    }
    return { ok: true, add: [e], info: { how: how } };
  }

  /* After a pack is bought, the coach can choose to let it pay off lessons that are owed (oldest first). */
  function planCoverOwed(person, entries, classesById, now) {
    var s = summarise(person, entries, classesById);
    var n = Math.min(s.credits, s.owed.length);
    var add = s.owed.slice().sort(function (a, b) { return a.attendId - b.attendId; }).slice(0, n).map(function (o) {
      return { personId: person.id, type: 'settle', ref: o.attendId, how: 'credit', at: now };
    });
    return { ok: true, add: add, info: { covered: n } };
  }

  function planReverse(person, entries, targetId, classesById, now) {
    var s = summarise(person, entries, classesById);
    var target = null;
    s.active.forEach(function (e) { if (e.id === targetId) target = e; });
    if (!target) return fail('That entry is already undone, or does not exist.');
    var add = [];
    if (target.type === 'attend') {
      var settle = s.settleByAttend[target.id];
      if (settle) add.push({ personId: person.id, type: 'reverse', ref: settle.id, at: now, note: 'lesson undone' });
      add.push({ personId: person.id, type: 'reverse', ref: target.id, at: now });
      return { ok: true, add: add, info: { alsoUndidSettle: settle || null } };
    }
    if (target.type === 'settle') {
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    if (target.type === 'pack') {
      if (s.credits - target.size < 0) {
        return fail('Credits from this pack have already been used, so it cannot be undone. Undo those lessons first.');
      }
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    return fail('That entry cannot be undone.');
  }

  /* Cancelling a class undoes everyone who was marked present, so nobody is charged or counted. */
  function planCancelClass(classId, people, entriesByPerson, classesById, now) {
    var add = [];
    var count = 0;
    people.forEach(function (p) {
      var s = summarise(p, entriesByPerson[p.id] || [], classesById);
      var a = s.attendByClass[classId];
      if (!a) return;
      count++;
      var settle = s.settleByAttend[a.id];
      if (settle) add.push({ personId: p.id, type: 'reverse', ref: settle.id, at: now, note: 'class cancelled' });
      add.push({ personId: p.id, type: 'reverse', ref: a.id, at: now, note: 'class cancelled' });
    });
    return { ok: true, add: add, info: { people: count } };
  }

  /* ---------- history lines, for the person card ---------- */
  function lessonLabel(att, classesById) {
    var c = att && classesById ? classesById[att.classId] : null;
    return c ? dateLabel(c.date) : 'a class';
  }
  function describe(e, entriesById, classesById) {
    switch (e.type) {
      case 'attend':
        return {
          title: 'Present ' + lessonLabel(e, classesById),
          detail: e.cover === 'free' ? 'Free lesson' : e.cover === 'credit' ? 'Used a pack credit' : 'Owes ' + money(e.priceCents)
        };
      case 'pack':
        return { title: e.size + '-pack added', detail: money(e.amountCents) + ' by ' + e.method };
      case 'settle': {
        var att = entriesById[e.ref];
        var base = 'Lesson ' + lessonLabel(att, classesById);
        if (e.how === 'paid') return { title: base + ' paid', detail: money(e.amountCents) + ' by ' + e.method };
        if (e.how === 'comp') return { title: base + ' comped', detail: e.note || '' };
        if (e.how === 'credit') return { title: base + ' covered', detail: 'Used a pack credit' };
        return { title: base + ' covered', detail: 'Used a free lesson' };
      }
      case 'reverse': {
        var t = entriesById[e.ref];
        var d = t ? describe(t, entriesById, classesById) : { title: 'an entry' };
        return { title: 'Undone: ' + d.title, detail: e.note || '' };
      }
    }
    return { title: String(e.type), detail: '' };
  }
  function history(person, entries, classesById) {
    var s = summarise(person, entries, classesById);
    var idx = byId(s.sorted);
    return s.sorted.slice().reverse().map(function (e) {
      var d = describe(e, idx, classesById);
      var undone = !!s.reversed[e.id];
      return {
        entry: e, title: d.title, detail: d.detail,
        undone: undone, isReverse: e.type === 'reverse',
        canUndo: e.type !== 'reverse' && !undone
      };
    });
  }

  /* ---------- backup file check ---------- */
  function validateBackup(o) {
    if (!o || typeof o !== 'object' || o.app !== 'portland-takedown-roll-call') return fail('That file is not a backup from this app.');
    if (o.schema !== 1) return fail('That backup is from a different version of the app.');
    if (!Array.isArray(o.people) || !Array.isArray(o.classes) || !Array.isArray(o.ledger)) return fail('The backup is missing parts, so nothing was restored.');
    var ids = { people: {}, classes: {}, ledger: {} };
    var bad = null;
    o.people.forEach(function (p) {
      if (!p || !isInt(p.id) || typeof p.name !== 'string' || RATES.indexOf(p.rate) < 0) bad = bad || 'A person in the backup is damaged.';
      else ids.people[p.id] = true;
    });
    o.classes.forEach(function (c) {
      if (!c || !isInt(c.id) || !parseDate(c.date)) bad = bad || 'A class in the backup is damaged.';
      else ids.classes[c.id] = true;
    });
    o.ledger.forEach(function (e) {
      if (!e || !isInt(e.id) || !isInt(e.personId) || TYPES.indexOf(e.type) < 0 || !isFinite(e.at)) { bad = bad || 'A ledger entry in the backup is damaged.'; return; }
      ids.ledger[e.id] = true;
    });
    if (bad) return fail(bad + ' Nothing was restored.');
    o.ledger.forEach(function (e) {
      if (!ids.people[e.personId]) bad = bad || 'A ledger entry points at a person who is not in the backup.';
      if (e.type === 'attend' && (!ids.classes[e.classId] || COVERS.indexOf(e.cover) < 0)) bad = bad || 'A lesson in the backup is damaged.';
      if (e.type === 'pack' && (!isInt(e.size) || !isInt(e.amountCents))) bad = bad || 'A pack in the backup is damaged.';
      if ((e.type === 'settle' || e.type === 'reverse') && !ids.ledger[e.ref]) bad = bad || 'A ledger entry points at an entry that is missing.';
      if (e.type === 'settle' && HOWS.indexOf(e.how) < 0) bad = bad || 'A settled lesson in the backup is damaged.';
    });
    if (bad) return fail(bad + ' Nothing was restored.');
    return { ok: true, counts: { people: o.people.length, classes: o.classes.length, ledger: o.ledger.length } };
  }

  return {
    RATES: RATES, SOURCES: SOURCES, METHODS: METHODS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normaliseSettings: normaliseSettings, sessionPrice: sessionPrice, packPrice: packPrice, packSizes: packSizes,
    money: money, parseDollars: parseDollars, localDate: localDate, parseDate: parseDate, dateLabel: dateLabel,
    byId: byId, groupByPerson: groupByPerson, summarise: summarise,
    planTap: planTap, planPack: planPack, planSettle: planSettle, planCoverOwed: planCoverOwed,
    planReverse: planReverse, planCancelClass: planCancelClass,
    describe: describe, history: history, validateBackup: validateBackup
  };
});
