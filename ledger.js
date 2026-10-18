/* Ledger logic for the Portland Takedown roll call.
   Pure functions only: no screen and no database, so the app and the tests share one set of rules.

   Rules, straight from the build brief:
   - Every person has their own ledger. Nothing is shared between people, siblings included.
   - Entries are never edited. A mistake is fixed by adding a "reverse" entry that points at it.
   - Free lessons, credits and what is owed are always worked out from the entries, never typed over.

   Entry types (all carry personId and at):
     attend   a lesson: classId, cover = free | credit | owed | waived, priceCents (only when owed)
              waived = the person is "Free forever" (a tick on their record, for family and the like): nothing is charged and no free lesson or credit is used
     pack     credits bought: size, amountCents, method
     settle   closes an owed lesson or unpaid gi hire: ref = attend or hire id, how = paid | comp | credit | free (+ amountCents, method, note)
     reverse  undoes any entry: ref = the entry id
     hire     gi hire at a lesson: classId, priceCents, payMethod (when paid on the spot)
     grade    a judo grading: date, from, to, note
     gift     free lessons given to one person: count, note. Adds to their free lesson allowance; used up as they attend, then normal prices apply
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Ledger = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RATES = ['adult', 'junior', 'concession'];
  var SOURCES = ['parent', 'cross-trainer', 'teen', 'other'];
  var METHODS = ['cash', 'bank', 'card'];
  var COVERS = ['free', 'credit', 'owed', 'waived'];
  var HOWS = ['paid', 'comp', 'credit', 'free'];
  var TYPES = ['attend', 'pack', 'settle', 'reverse', 'hire', 'grade', 'gift'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var DEFAULT_SETTINGS = {
    freeLessons: 2,
    giHireCents: 1000,
    giHireOnFree: true,
    membership: { sambo: { month: 12, day: 31 }, vaju: { month: 6, day: 30 } },
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
    if (isInt(raw.giHireCents) && raw.giHireCents >= 0) s.giHireCents = raw.giHireCents;
    if (typeof raw.giHireOnFree === 'boolean') s.giHireOnFree = raw.giHireOnFree;
    ['sambo', 'vaju'].forEach(function (k) {
      var m = raw.membership && raw.membership[k];
      if (m && isInt(m.month) && m.month >= 1 && m.month <= 12 && isInt(m.day) && m.day >= 1 && m.day <= new Date(2024, m.month, 0).getDate()) {
        s.membership[k] = { month: m.month, day: m.day };
      }
    });
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

  function dateLong(s) {
    var d = parseDate(s);
    return d ? DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : String(s || '');
  }
  /* The next time a month and day comes round, counting today. Used for membership expiry defaults. */
  function nextOccurrence(month, day, from) {
    var f = parseDate(from || localDate()) || new Date();
    var today = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    for (var i = 0; i < 2; i++) {
      var y = f.getFullYear() + i;
      var d = new Date(y, month - 1, Math.min(day, new Date(y, month, 0).getDate()));
      if (d >= today) return localDate(d);
    }
    return '';
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
    var hires = active.filter(function (e) { return e.type === 'hire'; });
    var grades = active.filter(function (e) { return e.type === 'grade'; });
    var gifts = active.filter(function (e) { return e.type === 'gift'; });

    var settleByAttend = {};
    settles.forEach(function (s) { settleByAttend[s.ref] = s; });
    var attendByClass = {};
    attends.forEach(function (a) { attendByClass[a.classId] = a; });

    var freeUsed = (person.freeUsedBefore || 0)
      + attends.filter(function (a) { return a.cover === 'free'; }).length
      + settles.filter(function (s) { return s.how === 'free'; }).length;
    var freeBase = isInt(person.freeAllowed) ? person.freeAllowed : DEFAULT_SETTINGS.freeLessons;
    var giftTotal = gifts.reduce(function (n, g) { return n + (isInt(g.count) ? g.count : 0); }, 0);
    var freeAllowed = freeBase + giftTotal;
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

    /* gi hire: tracked on its own, never touches free lessons or credits */
    var hireByClass = {};
    hires.forEach(function (x) {
      var st = settleByAttend[x.id];
      var status = x.priceCents === 0 ? 'nocharge' : x.payMethod ? 'paid' : st ? (st.how === 'comp' ? 'comped' : 'paid') : 'owed';
      hireByClass[x.classId] = {
        entry: x, status: status, priceCents: x.priceCents,
        method: x.payMethod || (st && st.method) || '',
        paidCents: x.payMethod ? x.priceCents : (st && st.how === 'paid' ? st.amountCents : 0)
      };
    });
    var hireOwed = [];
    Object.keys(hireByClass).forEach(function (k) {
      var hb = hireByClass[k];
      if (hb.status !== 'owed') return;
      var c = classesById[hb.entry.classId];
      hireOwed.push({ hireId: hb.entry.id, classId: hb.entry.classId, date: c ? c.date : '', priceCents: hb.priceCents });
    });
    hireOwed.sort(function (a, b) { return a.hireId - b.hireId; });
    var hireOwedCents = hireOwed.reduce(function (n, o) { return n + o.priceCents; }, 0);

    /* judo grading: classes since the last grading count only classes after that date */
    var gradesSorted = grades.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
    var lastGrade = gradesSorted.length ? gradesSorted[gradesSorted.length - 1] : null;
    var sinceGrade = null;
    if (lastGrade) {
      sinceGrade = attends.filter(function (a) {
        var c = classesById[a.classId];
        return c && c.date > lastGrade.date;
      }).length;
    }

    return {
      freeUsed: freeUsed, freeAllowed: freeAllowed, freeLeft: freeLeft, freeBase: freeBase,
      gifts: gifts, giftTotal: giftTotal,
      credits: credits, owed: owed, owedCents: owedCents,
      attendedCount: attends.length, lastDate: lastDate,
      attendByClass: attendByClass, settleByAttend: settleByAttend, settleByRef: settleByAttend,
      hireByClass: hireByClass, hireOwed: hireOwed, hireOwedCents: hireOwedCents, hireCount: hires.length,
      grades: gradesSorted, lastGrade: lastGrade, sinceGrade: sinceGrade,
      active: active, reversed: reversed, sorted: sorted
    };
  }

  /* ---------- planners: each returns the entries to add, or a reason it cannot ---------- */

  /* Undoing a lesson also undoes its gi hire and anything that settled either of them. */
  function undoAttend(person, s, attend, now, settleNote, attendNote) {
    var add = [];
    var moneyBack = false;
    function rev(ref, note) {
      var r = { personId: person.id, type: 'reverse', ref: ref, at: now };
      if (note) r.note = note;
      add.push(r);
    }
    var hire = s.hireByClass[attend.classId] || null;
    if (hire) {
      var hs = s.settleByAttend[hire.entry.id];
      if (hs) { rev(hs.id, settleNote); moneyBack = true; }
      if (hire.entry.payMethod && hire.priceCents > 0) moneyBack = true;
      rev(hire.entry.id, settleNote);
    }
    var settle = s.settleByAttend[attend.id] || null;
    if (settle) { rev(settle.id, settleNote); moneyBack = true; }
    rev(attend.id, attendNote);
    return { add: add, moneyBack: moneyBack, settle: settle, hire: hire ? hire.entry : null };
  }

  function planTap(person, entries, classId, classesById, settings, confirmed, now) {
    var cls = classesById[classId];
    if (!cls) return fail('That class does not exist.');
    if (cls.cancelled) return fail('That class is cancelled.');
    var s = summarise(person, entries, classesById);
    var existing = s.attendByClass[classId];
    if (existing) {
      var u = undoAttend(person, s, existing, now, 'lesson undone', null);
      if (u.moneyBack && !confirmed) {
        return fail('This lesson was already settled or paid. Undoing it also undoes that.', { needsConfirm: true, settle: u.settle });
      }
      return { ok: true, add: u.add, info: { action: 'untap', attendId: existing.id } };
    }
    var cover = person.trainsFree ? 'waived' : (s.freeLeft > 0 ? 'free' : (s.credits > 0 ? 'credit' : 'owed'));
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
    var isHire = false;
    if (!owed) {
      s.hireOwed.forEach(function (o) { if (o.hireId === attendId) { owed = o; isHire = true; } });
    }
    if (!owed) return fail('That is not owing any more.');
    if (HOWS.indexOf(how) < 0) return fail('Choose how this is settled.');
    if (isHire && how !== 'paid' && how !== 'comp') return fail('Gi hire can only be paid or comped.');
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

  /* Gi hire is one tap per lesson attended. method = cash | bank | card if paid on the spot, or empty to leave it owed. */
  function planHire(person, entries, classId, classesById, settings, method, now) {
    var cls = classesById[classId];
    if (!cls) return fail('That class does not exist.');
    if (cls.cancelled) return fail('That class is cancelled.');
    var s = summarise(person, entries, classesById);
    var att = s.attendByClass[classId];
    if (!att) return fail('Mark them present first. Gi hire goes against a lesson they attend.');
    if (s.hireByClass[classId]) return fail('Gi hire is already recorded for this class.');
    var price = ((att.cover === 'free' || att.cover === 'waived') && !settings.giHireOnFree) ? 0 : settings.giHireCents;
    var e = { personId: person.id, type: 'hire', classId: classId, priceCents: price, at: now };
    if (price > 0 && method) {
      if (METHODS.indexOf(method) < 0) return fail('Choose cash, bank or card.');
      e.payMethod = method;
    }
    return { ok: true, add: [e], info: { priceCents: price, paid: !!e.payMethod } };
  }

  /* Judo grading only. Mistakes are fixed by undoing the entry, like everything else. */
  function planGrade(person, entries, g, now) {
    g = g || {};
    var to = String(g.to || '').trim();
    var from = String(g.from || '').trim();
    var note = String(g.note || '').trim();
    if (!parseDate(g.date)) return fail('Pick the date of the grading.');
    if (!to) return fail('Enter the grade they were given.');
    if (to.length > 40 || from.length > 40) return fail('Grade names must be 40 characters or fewer.');
    if (note.length > 200) return fail('Keep the note to 200 characters or fewer.');
    return { ok: true, add: [{ personId: person.id, type: 'grade', date: g.date, from: from, to: to, note: note, at: now }], info: {} };
  }

  /* Give a person some free lessons. They are used up in order as the person attends, then normal prices apply again.
     Free lessons are used before pack credits, so a gift never wastes a pack. */
  function planGift(person, entries, count, note, classesById, now) {
    if (!isInt(count) || count < 1) return fail('Enter how many free lessons, as a whole number of 1 or more.');
    if (count > 100) return fail('That is a lot of free lessons. Keep it to 100 or fewer.');
    var n = String(note || '').trim();
    if (n.length > 200) return fail('Keep the reason to 200 characters or fewer.');
    var e = { personId: person.id, type: 'gift', count: count, at: now };
    if (n) e.note = n;
    var after = summarise(person, (entries || []).concat([{ id: 1e12, personId: person.id, type: 'gift', count: count }]), classesById || {});
    return { ok: true, add: [e], info: { freeLeftAfter: after.freeLeft, owedCount: after.owed.length } };
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
      var u = undoAttend(person, s, target, now, 'lesson undone', null);
      return { ok: true, add: u.add, info: { alsoUndidSettle: u.settle || null, alsoUndidHire: u.hire, moneyBack: u.moneyBack } };
    }
    if (target.type === 'hire') {
      var hs = s.settleByAttend[target.id];
      if (hs) add.push({ personId: person.id, type: 'reverse', ref: hs.id, at: now, note: 'gi hire undone' });
      add.push({ personId: person.id, type: 'reverse', ref: target.id, at: now });
      return { ok: true, add: add, info: { moneyBack: !!hs || (!!target.payMethod && target.priceCents > 0) } };
    }
    if (target.type === 'grade') {
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    if (target.type === 'gift') {
      if (s.freeAllowed - (target.count || 0) < s.freeUsed) {
        return fail('Some of those free lessons have already been used, so this cannot be undone. Undo those lessons first.');
      }
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
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
      undoAttend(p, s, a, now, 'class cancelled', 'class cancelled').add.forEach(function (x) { add.push(x); });
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
          detail: e.cover === 'free' ? 'Free lesson' : e.cover === 'waived' ? 'Free forever' : e.cover === 'credit' ? 'Used a pack credit' : 'Owes ' + money(e.priceCents)
        };
      case 'pack':
        return { title: e.size + '-pack added', detail: money(e.amountCents) + ' by ' + e.method };
      case 'hire':
        return {
          title: 'Gi hire ' + lessonLabel(e, classesById),
          detail: e.priceCents === 0 ? 'No charge' : e.payMethod ? money(e.priceCents) + ' paid by ' + e.payMethod : 'Owes ' + money(e.priceCents)
        };
      case 'gift':
        return { title: 'Gave ' + e.count + ' free ' + (e.count === 1 ? 'lesson' : 'lessons'), detail: e.note || '' };
      case 'grade':
        return {
          title: 'Graded ' + (e.from ? e.from + ' to ' : 'to ') + e.to,
          detail: dateLong(e.date) + (e.note ? ' \u00b7 ' + e.note : '')
        };
      case 'settle': {
        var att = entriesById[e.ref];
        var base = (att && att.type === 'hire' ? 'Gi hire ' : 'Lesson ') + lessonLabel(att, classesById);
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
    if (o.schema !== 1 && o.schema !== 2) return fail('That backup is from a different version of the app.');
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
      if (e.type === 'hire' && (!ids.classes[e.classId] || !isInt(e.priceCents) || (e.payMethod && METHODS.indexOf(e.payMethod) < 0))) bad = bad || 'A gi hire entry in the backup is damaged.';
      if (e.type === 'grade' && (!parseDate(e.date) || typeof e.to !== 'string')) bad = bad || 'A grading in the backup is damaged.';
      if (e.type === 'gift' && (!isInt(e.count) || e.count < 1)) bad = bad || 'A free lesson entry in the backup is damaged.';
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
    dateLong: dateLong, nextOccurrence: nextOccurrence,
    byId: byId, groupByPerson: groupByPerson, summarise: summarise,
    planTap: planTap, planPack: planPack, planSettle: planSettle, planCoverOwed: planCoverOwed,
    planHire: planHire, planGrade: planGrade, planGift: planGift,
    planReverse: planReverse, planCancelClass: planCancelClass,
    describe: describe, history: history, validateBackup: validateBackup
  };
});
