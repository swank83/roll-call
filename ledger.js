/* Ledger logic for the Portland Takedown roll call.
   Pure functions only: no screen and no database, so the app and the tests share one set of rules.

   This app records attendance. It does not record prices or payments.

   Rules:
   - Every person has their own ledger. Nothing is shared between people, siblings included.
   - Entries are never edited. A mistake is fixed by adding a "reverse" entry that points at it.
   - Free lessons and pack classes left are always worked out from the entries, never typed over.

   Entry types (all carry personId and at):
     attend   a lesson: classId, cover = free | credit | plain | waived
              free = used one of their free lessons, credit = used one class from their pack,
              waived = the person is "Free forever" (a tick on their record), plain = none of those, they just attended
     pack     classes added to a pack: size
     reverse  undoes any entry: ref = the entry id
     hire     gi hire at a lesson: classId (a tick, no price)
     grade    a judo grading: date, from, to, note
     gift     free lessons given to one person: count, note. Adds to their free lesson allowance; used up as they attend

   Older versions of the app also recorded money: cover = owed, settle entries, pack amounts, gi hire prices.
   Those records are kept and still restore from a backup, but nothing shows or adds money any more.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Ledger = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RATES = ['adult', 'junior', 'concession'];      // older records carry a rate; new people are saved as 'adult'
  var SOURCES = ['parent', 'cross-trainer', 'teen', 'other'];
  var METHODS = ['cash', 'bank', 'card'];             // only to read older records
  var COVERS = ['free', 'credit', 'plain', 'owed', 'waived'];
  var HOWS = ['paid', 'comp', 'credit', 'free'];      // only to read older records
  var TYPES = ['attend', 'pack', 'settle', 'reverse', 'hire', 'grade', 'gift'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var DEFAULT_SETTINGS = {
    freeLessons: 2,
    membership: { sambo: { month: 12, day: 31 }, vaju: { month: 6, day: 30 } }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function fail(reason, extra) {
    var r = { ok: false, reason: reason };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /* ---------- settings, dates ---------- */
  function normaliseSettings(raw) {
    var s = clone(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    if (isInt(raw.freeLessons) && raw.freeLessons >= 0) s.freeLessons = raw.freeLessons;
    ['sambo', 'vaju'].forEach(function (k) {
      var m = raw.membership && raw.membership[k];
      if (m && isInt(m.month) && m.month >= 1 && m.month <= 12 && isInt(m.day) && m.day >= 1 && m.day <= new Date(2024, m.month, 0).getDate()) {
        s.membership[k] = { month: m.month, day: m.day };
      }
    });
    return s;
  }
  /* Only used to describe older records that carry money. */
  function money(cents) {
    var neg = cents < 0;
    var c = Math.abs(Math.round(cents || 0));
    var d = Math.floor(c / 100), r = c % 100;
    return (neg ? '-' : '') + '$' + d + (r ? '.' + (r < 10 ? '0' : '') + r : '');
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
    var settles = active.filter(function (e) { return e.type === 'settle'; });   // older records only
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

    var lastDate = '';
    attends.forEach(function (a) {
      var c = classesById[a.classId];
      if (c && c.date > lastDate) lastDate = c.date;
    });

    /* gi hire: a tick against a lesson, never touches free lessons or pack classes */
    var hireByClass = {};
    hires.forEach(function (x) { hireByClass[x.classId] = { entry: x }; });

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
      credits: credits,
      attendedCount: attends.length, lastDate: lastDate,
      attendByClass: attendByClass, settleByAttend: settleByAttend,
      hireByClass: hireByClass, hireCount: hires.length,
      grades: gradesSorted, lastGrade: lastGrade, sinceGrade: sinceGrade,
      active: active, reversed: reversed, sorted: sorted
    };
  }

  /* ---------- planners: each returns the entries to add, or a reason it cannot ---------- */

  /* Undoing a lesson also undoes its gi hire (and anything older versions settled against either). */
  function undoAttend(person, s, attend, now, settleNote, attendNote) {
    var add = [];
    function rev(ref, note) {
      var r = { personId: person.id, type: 'reverse', ref: ref, at: now };
      if (note) r.note = note;
      add.push(r);
    }
    var hire = s.hireByClass[attend.classId] || null;
    if (hire) {
      var hs = s.settleByAttend[hire.entry.id];
      if (hs) rev(hs.id, settleNote);
      rev(hire.entry.id, settleNote);
    }
    var settle = s.settleByAttend[attend.id] || null;
    if (settle) rev(settle.id, settleNote);
    rev(attend.id, attendNote);
    return { add: add, settle: settle, hire: hire ? hire.entry : null };
  }

  /* One tap marks someone present, the next tap undoes it.
     Free lessons are used first, then pack classes. */
  function planTap(person, entries, classId, classesById, now) {
    var cls = classesById[classId];
    if (!cls) return fail('That class does not exist.');
    if (cls.cancelled) return fail('That class is cancelled.');
    var s = summarise(person, entries, classesById);
    var existing = s.attendByClass[classId];
    if (existing) {
      var u = undoAttend(person, s, existing, now, 'lesson undone', null);
      return { ok: true, add: u.add, info: { action: 'untap', attendId: existing.id } };
    }
    var cover = person.trainsFree ? 'waived' : (s.freeLeft > 0 ? 'free' : (s.credits > 0 ? 'credit' : 'plain'));
    return {
      ok: true,
      add: [{ personId: person.id, type: 'attend', classId: classId, cover: cover, at: now }],
      info: { action: 'attend', cover: cover }
    };
  }

  /* Add a pack: just a number of classes. */
  function planPack(person, entries, size, now) {
    if (!isInt(size) || size < 1) return fail('Enter how many classes are in the pack, as a whole number of 1 or more.');
    if (size > 100) return fail('That is a big pack. Keep it to 100 classes or fewer.');
    var add = [{ personId: person.id, type: 'pack', size: size, at: now }];
    var after = summarise(person, (entries || []).concat([{ id: 1e12, personId: person.id, type: 'pack', size: size }]), {});
    return { ok: true, add: add, info: { creditsAfter: after.credits } };
  }

  /* Give a person some free lessons. They are used up in order as the person attends, then it is back to normal.
     Free lessons are used before pack classes, so a gift never wastes a pack. */
  function planGift(person, entries, count, note, classesById, now) {
    if (!isInt(count) || count < 1) return fail('Enter how many free lessons, as a whole number of 1 or more.');
    if (count > 100) return fail('That is a lot of free lessons. Keep it to 100 or fewer.');
    var n = String(note || '').trim();
    if (n.length > 200) return fail('Keep the reason to 200 characters or fewer.');
    var e = { personId: person.id, type: 'gift', count: count, at: now };
    if (n) e.note = n;
    var after = summarise(person, (entries || []).concat([{ id: 1e12, personId: person.id, type: 'gift', count: count }]), classesById || {});
    return { ok: true, add: [e], info: { freeLeftAfter: after.freeLeft } };
  }

  /* Gi hire is one tick per lesson attended. */
  function planHire(person, entries, classId, classesById, now) {
    var cls = classesById[classId];
    if (!cls) return fail('That class does not exist.');
    if (cls.cancelled) return fail('That class is cancelled.');
    var s = summarise(person, entries, classesById);
    if (!s.attendByClass[classId]) return fail('Mark them present first. Gi hire goes against a lesson they attend.');
    if (s.hireByClass[classId]) return fail('Gi hire is already recorded for this class.');
    return { ok: true, add: [{ personId: person.id, type: 'hire', classId: classId, at: now }], info: {} };
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

  function planReverse(person, entries, targetId, classesById, now) {
    var s = summarise(person, entries, classesById);
    var target = null;
    s.active.forEach(function (e) { if (e.id === targetId) target = e; });
    if (!target) return fail('That entry is already undone, or does not exist.');
    var add = [];
    if (target.type === 'attend') {
      var u = undoAttend(person, s, target, now, 'lesson undone', null);
      return { ok: true, add: u.add, info: { alsoUndidHire: u.hire } };
    }
    if (target.type === 'hire') {
      var hs = s.settleByAttend[target.id];
      if (hs) add.push({ personId: person.id, type: 'reverse', ref: hs.id, at: now, note: 'gi hire undone' });
      add.push({ personId: person.id, type: 'reverse', ref: target.id, at: now });
      return { ok: true, add: add, info: {} };
    }
    if (target.type === 'grade' || target.type === 'settle') {
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    if (target.type === 'gift') {
      if (s.freeAllowed - (target.count || 0) < s.freeUsed) {
        return fail('Some of those free lessons have already been used, so this cannot be undone. Undo those lessons first.');
      }
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    if (target.type === 'pack') {
      if (s.credits - target.size < 0) {
        return fail('Classes from this pack have already been used, so it cannot be undone. Undo those lessons first.');
      }
      return { ok: true, add: [{ personId: person.id, type: 'reverse', ref: target.id, at: now }], info: {} };
    }
    return fail('That entry cannot be undone.');
  }

  /* Cancelling a class undoes everyone who was marked present, so nobody is counted. */
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
          detail: e.cover === 'free' ? 'Free lesson' : e.cover === 'waived' ? 'Free forever' : e.cover === 'credit' ? 'Used a pack class' : ''
        };
      case 'pack':
        return { title: 'Pack of ' + e.size + ' added', detail: e.amountCents != null ? money(e.amountCents) + (e.method ? ' by ' + e.method : '') : '' };
      case 'hire':
        return { title: 'Gi hire ' + lessonLabel(e, classesById), detail: '' };
      case 'gift':
        return { title: 'Gave ' + e.count + ' free ' + (e.count === 1 ? 'lesson' : 'lessons'), detail: e.note || '' };
      case 'grade':
        return {
          title: 'Graded ' + (e.from ? e.from + ' to ' : 'to ') + e.to,
          detail: dateLong(e.date) + (e.note ? ' · ' + e.note : '')
        };
      case 'settle': {
        var att = entriesById[e.ref];
        var base = (att && att.type === 'hire' ? 'Gi hire ' : 'Lesson ') + lessonLabel(att, classesById);
        if (e.how === 'paid') return { title: base + ' paid', detail: money(e.amountCents) + ' by ' + e.method };
        if (e.how === 'comp') return { title: base + ' comped', detail: e.note || '' };
        if (e.how === 'credit') return { title: base + ' covered', detail: 'Used a pack class' };
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
      if (e.type === 'pack' && (!isInt(e.size) || (e.amountCents != null && !isInt(e.amountCents)))) bad = bad || 'A pack in the backup is damaged.';
      if (e.type === 'hire' && (!ids.classes[e.classId] || (e.priceCents != null && !isInt(e.priceCents)) || (e.payMethod && METHODS.indexOf(e.payMethod) < 0))) bad = bad || 'A gi hire entry in the backup is damaged.';
      if (e.type === 'grade' && (!parseDate(e.date) || typeof e.to !== 'string')) bad = bad || 'A grading in the backup is damaged.';
      if (e.type === 'gift' && (!isInt(e.count) || e.count < 1)) bad = bad || 'A free lesson entry in the backup is damaged.';
      if ((e.type === 'settle' || e.type === 'reverse') && !ids.ledger[e.ref]) bad = bad || 'A ledger entry points at an entry that is missing.';
      if (e.type === 'settle' && HOWS.indexOf(e.how) < 0) bad = bad || 'A settled lesson in the backup is damaged.';
    });
    if (bad) return fail(bad + ' Nothing was restored.');
    return { ok: true, counts: { people: o.people.length, classes: o.classes.length, ledger: o.ledger.length } };
  }

  return {
    RATES: RATES, SOURCES: SOURCES, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normaliseSettings: normaliseSettings,
    money: money, localDate: localDate, parseDate: parseDate, dateLabel: dateLabel,
    dateLong: dateLong, nextOccurrence: nextOccurrence,
    byId: byId, groupByPerson: groupByPerson, summarise: summarise,
    planTap: planTap, planPack: planPack, planGift: planGift, planHire: planHire, planGrade: planGrade,
    planReverse: planReverse, planCancelClass: planCancelClass,
    describe: describe, history: history, validateBackup: validateBackup
  };
});
