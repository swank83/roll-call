/* Portland Takedown roll call, Stage 1.
   Everything is stored on this device in IndexedDB. Nothing is sent anywhere.
   The rules for lessons, credits and what is owed live in ledger.js. */
(function () {
  'use strict';

  var L = window.Ledger;
  var APP = 'portland-takedown-roll-call';
  var BUILD = 'Stage 1, build 1';
  var EXPECTED_FILES = 8;
  var DB_NAME = 'pt-rollcall';
  var IDLE_LOCK_MS = 5 * 60 * 1000;
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var db = null;
  var S = {
    settings: L.normaliseSettings(null), people: [], classes: [], ledger: [], meta: {},
    tab: 'roll', classId: null, rollQ: '', pQ: '', pSource: '', pNoWaiver: false, pNoRelease: false,
    locked: true, hiddenAt: 0, swError: '', dbError: '', opens: 0, first: 0, prev: null
  };
  var D = { classesById: {}, entriesBy: {}, sums: {} };
  var sheets = [];
  var uid = 0;

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function labelRate(r) { return r === 'adult' ? 'Adult' : r === 'junior' ? 'Junior' : 'Concession'; }
  function labelSource(s) { return s === 'cross-trainer' ? 'Cross-trainer' : s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Not set'; }
  function labelMethod(m) { return m.charAt(0).toUpperCase() + m.slice(1); }
  function dollars(cents) { return (cents / 100).toFixed(2).replace(/\.00$/, ''); }
  function fmtDateTime(ms) {
    var d = new Date(ms);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' +
      d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  }
  function fullDate(s) {
    var d = L.parseDate(s);
    return d ? d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
  }
  function personById(id) {
    for (var i = 0; i < S.people.length; i++) if (S.people[i].id === id) return S.people[i];
    return null;
  }
  function formText(f) {
    if (!f || !f.signed) return 'Not on file';
    return 'Signed' + (f.date ? ' ' + fullDate(f.date) : '') + (f.by ? ' by ' + f.by : '');
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 7000);
  }

  /* Button actions run one at a time, in the order they were tapped. */
  var chain = Promise.resolve();
  function enqueue(fn) {
    chain = chain.then(fn).catch(function (e) { toast('Something went wrong: ' + (e && e.message || e)); });
    return chain;
  }

  /* ---------- database ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('This browser cannot store data on the device.')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
        var c = d.createObjectStore('classes', { keyPath: 'id', autoIncrement: true });
        c.createIndex('date', 'date', { unique: true });
        var l = d.createObjectStore('ledger', { keyPath: 'id', autoIncrement: true });
        l.createIndex('personId', 'personId');
        l.createIndex('classId', 'classId');
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('The database is open in another tab.')); };
    });
  }
  function loadAll() {
    return new Promise(function (res, rej) {
      var names = ['people', 'classes', 'ledger', 'meta'];
      var t = db.transaction(names, 'readonly');
      var out = {};
      names.forEach(function (n) {
        var r = t.objectStore(n).getAll();
        r.onsuccess = function () { out[n] = r.result; };
      });
      t.oncomplete = function () { res(out); };
      t.onerror = t.onabort = function () { rej(t.error || new Error('Could not read the data.')); };
    });
  }
  /* One read-and-write transaction. work(st, done, fail) uses request callbacks only. */
  function atomic(names, work) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(names, 'readwrite');
      var result, failure;
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(failure || t.error); };
      t.onabort = function () { reject(failure || t.error || new Error('Could not save.')); };
      function st(n) { return t.objectStore(n); }
      function done(r) { result = r; }
      function fail(err) { failure = err; try { t.abort(); } catch (e) { /* already closing */ } }
      try { work(st, done, fail); } catch (e) { fail(e); }
    });
  }
  function withPerson(st, personId, fail, cb) {
    var r1 = st('classes').getAll();
    r1.onsuccess = function () {
      var classesById = L.byId(r1.result);
      var r2 = st('people').get(personId);
      r2.onsuccess = function () {
        if (!r2.result) { fail(new Error('That person no longer exists.')); return; }
        var r3 = st('ledger').index('personId').getAll(personId);
        r3.onsuccess = function () { cb(r2.result, r3.result, classesById); };
      };
    };
  }
  function runPlan(plan, st, done, fail) {
    if (!plan.ok) {
      var e = new Error(plan.reason);
      e.needsConfirm = !!plan.needsConfirm;
      fail(e);
      return;
    }
    plan.add.forEach(function (x) { st('ledger').add(x); });
    done(plan);
  }

  function opTap(pid, cid, confirmed) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      withPerson(st, pid, fail, function (p, es, byId) {
        runPlan(L.planTap(p, es, cid, byId, S.settings, !!confirmed, Date.now()), st, done, fail);
      });
    });
  }
  function opPack(pid, size, cents, method) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      withPerson(st, pid, fail, function (p, es) {
        runPlan(L.planPack(p, es, size, cents, method, S.settings, Date.now()), st, done, fail);
      });
    });
  }
  function opSettle(pid, attendId, how, opts) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      withPerson(st, pid, fail, function (p, es, byId) {
        runPlan(L.planSettle(p, es, attendId, how, opts, byId, Date.now()), st, done, fail);
      });
    });
  }
  function opCover(pid) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      withPerson(st, pid, fail, function (p, es, byId) {
        runPlan(L.planCoverOwed(p, es, byId, Date.now()), st, done, fail);
      });
    });
  }
  function opReverse(pid, entryId) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      withPerson(st, pid, fail, function (p, es, byId) {
        runPlan(L.planReverse(p, es, entryId, byId, Date.now()), st, done, fail);
      });
    });
  }
  function opStartClass(date) {
    return atomic(['classes'], function (st, done) {
      var r = st('classes').index('date').get(date);
      r.onsuccess = function () {
        if (r.result) { done(r.result); return; }
        var rec = { date: date, cancelled: false, createdAt: Date.now() };
        var a = st('classes').add(rec);
        a.onsuccess = function () { rec.id = a.result; done(rec); };
      };
    });
  }
  function opCancelClass(classId) {
    return atomic(['people', 'classes', 'ledger'], function (st, done, fail) {
      var rp = st('people').getAll();
      rp.onsuccess = function () {
        var rc = st('classes').getAll();
        rc.onsuccess = function () {
          var rl = st('ledger').getAll();
          rl.onsuccess = function () {
            var byId = L.byId(rc.result);
            var cls = byId[classId];
            if (!cls) { fail(new Error('That class does not exist.')); return; }
            var plan = L.planCancelClass(classId, rp.result, L.groupByPerson(rl.result), byId, Date.now());
            plan.add.forEach(function (x) { st('ledger').add(x); });
            cls.cancelled = true;
            cls.cancelledAt = Date.now();
            st('classes').put(cls);
            done(plan);
          };
        };
      };
    });
  }
  function opReopenClass(classId) {
    return atomic(['classes'], function (st, done, fail) {
      var r = st('classes').get(classId);
      r.onsuccess = function () {
        if (!r.result) { fail(new Error('That class does not exist.')); return; }
        r.result.cancelled = false;
        st('classes').put(r.result);
        done(true);
      };
    });
  }
  function opSavePerson(p) {
    return atomic(['people'], function (st, done) {
      var r = p.id ? st('people').put(p) : st('people').add(p);
      r.onsuccess = function () { done(r.result); };
    });
  }
  function opDeletePerson(id) {
    return atomic(['people', 'ledger'], function (st, done, fail) {
      var c = st('ledger').index('personId').count(id);
      c.onsuccess = function () {
        if (c.result > 0) { fail(new Error('This person has records, so they cannot be removed.')); return; }
        st('people').delete(id);
        done(true);
      };
    });
  }
  function opMeta(items) {
    return atomic(['meta'], function (st, done) {
      items.forEach(function (i) { st('meta').put(i); });
      done(true);
    });
  }
  function opRestore(o) {
    return atomic(['people', 'classes', 'ledger', 'meta'], function (st, done) {
      ['people', 'classes', 'ledger'].forEach(function (n) { st(n).clear(); });
      o.people.forEach(function (x) { st('people').put(x); });
      o.classes.forEach(function (x) { st('classes').put(x); });
      o.ledger.forEach(function (x) { st('ledger').put(x); });
      st('meta').put({ k: 'settings', v: L.normaliseSettings(o.settings) });
      done(true);
    });
  }
  function opErase(everything) {
    var names = ['people', 'classes', 'ledger'].concat(everything ? ['meta'] : []);
    return atomic(names, function (st, done) {
      names.forEach(function (n) { st(n).clear(); });
      done(true);
    });
  }

  function metaMap(list) {
    var o = {};
    list.forEach(function (m) { o[m.k] = m; });
    return o;
  }
  function derive() {
    var classesById = L.byId(S.classes);
    var entriesBy = L.groupByPerson(S.ledger);
    var sums = {};
    S.people.forEach(function (p) { sums[p.id] = L.summarise(p, entriesBy[p.id] || [], classesById); });
    D = { classesById: classesById, entriesBy: entriesBy, sums: sums };
  }
  function reload() {
    return loadAll().then(function (d) {
      S.people = d.people.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id - b.id; });
      S.classes = d.classes;
      S.ledger = d.ledger;
      S.meta = metaMap(d.meta);
      S.settings = L.normaliseSettings(S.meta.settings && S.meta.settings.v);
      if (S.classId && !L.byId(S.classes)[S.classId]) S.classId = null;
      derive();
      if (!S.locked) { refreshSheets(); render(); }
    });
  }

  /* ---------- modals and sheets ---------- */
  function modal(opts) {
    var back = h('div', { class: 'modal-back' });
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    var buttons = h('div', { class: 'btns' });
    (opts.actions || []).forEach(function (a) {
      buttons.appendChild(h('button', {
        type: 'button', class: 'btn' + (a.kind === 'alt' ? ' alt' : a.kind === 'danger' ? ' danger' : ''),
        onclick: function () { a.onclick(close); }
      }, a.label));
    });
    var box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('h2', { class: 'mt', text: opts.title }), opts.body, buttons);
    back.appendChild(box);
    document.body.appendChild(back);
    var first = box.querySelector('input, select, textarea');
    if (first && opts.focus !== false) setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 50);
    return close;
  }
  function closeAllModals() {
    Array.prototype.slice.call(document.querySelectorAll('.modal-back')).forEach(function (m) { m.parentNode.removeChild(m); });
  }
  function confirmBox(title, message, yesLabel, onYes, danger) {
    return modal({
      title: title, body: h('p', { text: message }), focus: false,
      actions: [
        { label: yesLabel, kind: danger ? 'danger' : 'primary', onclick: function (close) { close(); onYes(); } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }
  function pushSheet(title, build, headActions) {
    var el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    var sheet = { el: el, title: title, build: build, headActions: headActions || [] };
    sheets.push(sheet);
    document.body.classList.add('noscroll');
    document.body.appendChild(el);
    fillSheet(sheet);
    return sheet;
  }
  function fillSheet(sheet) {
    var top = sheet.el.scrollTop;
    var body = sheet.build(sheet);
    sheet.el.textContent = '';
    var head = h('div', { class: 'sheet-head' }, h('h1', { text: sheet.title }),
      h('div', { class: 'acts' }, sheet.headActions.map(function (a) {
        return h('button', { type: 'button', class: 'btn small' + (a.kind === 'alt' ? ' alt' : ''), onclick: a.onclick }, a.label);
      })));
    sheet.el.appendChild(head);
    sheet.el.appendChild(h('div', { class: 'sheet-body' }, body));
    sheet.el.scrollTop = top;
  }
  function refreshSheets() {
    sheets.forEach(function (s) { if (s.live) fillSheet(s); });
  }
  function popSheet() {
    var s = sheets.pop();
    if (s && s.el.parentNode) s.el.parentNode.removeChild(s.el);
    if (!sheets.length) document.body.classList.remove('noscroll');
  }
  function closeAllSheets() { while (sheets.length) popSheet(); }

  /* ---------- PIN lock ---------- */
  function bytesToHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function hexToBytes(hex) { var a = new Uint8Array(hex.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
  function randomHex(n) { var a = new Uint8Array(n); window.crypto.getRandomValues(a); return bytesToHex(a); }
  function derivePin(pin, saltHex, iter) {
    if (!(window.crypto && window.crypto.subtle)) {
      var x = 5381, s = saltHex + pin;
      for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
      return Promise.resolve('basic:' + x);
    }
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']).then(function (key) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
    }).then(bytesToHex);
  }
  function makePin(pin) {
    var salt = randomHex(16), iter = 100000;
    return derivePin(pin, salt, iter).then(function (hash) { return { salt: salt, iter: iter, hash: hash }; });
  }
  function checkPin(pin) {
    var rec = S.meta.pin && S.meta.pin.v;
    if (!rec) return Promise.resolve(false);
    return derivePin(pin, rec.salt, rec.iter).then(function (hash) { return hash === rec.hash; });
  }

  var fails = 0, waitUntil = 0;
  function showLock() {
    S.locked = true;
    closeAllSheets();
    closeAllModals();
    $('view').textContent = '';
    $('app').hidden = true;
    $('tabs').hidden = true;
    var box = $('lock');
    box.hidden = false;
    box.textContent = '';
    var hasPin = !!(S.meta.pin && S.meta.pin.v);
    var pin = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', autocomplete: 'off', 'aria-label': hasPin ? 'PIN' : 'New PIN' });
    var pin2 = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', autocomplete: 'off', 'aria-label': 'Repeat PIN' });
    var err = h('p', { class: 'err', role: 'alert' });
    var form = h('form', { class: 'lockbox' },
      h('img', { src: 'icon-192.png', width: '96', height: '96', alt: 'Portland Takedown seal' }),
      h('h1', { text: hasPin ? 'Enter your PIN' : 'Choose a PIN' }),
      hasPin ? null : h('p', { class: 'hint', text: 'Four to eight digits. Everyone who uses this iPad shares it.' }),
      pin, hasPin ? null : pin2, err,
      h('button', { type: 'submit', class: 'btn' }, hasPin ? 'Open' : 'Save PIN'),
      hasPin ? h('button', { type: 'button', class: 'link', onclick: forgotPin }, 'Forgot the PIN?') : null);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = pin.value;
      if (!/^\d{4,8}$/.test(v)) { err.textContent = 'Use four to eight digits.'; return; }
      if (!hasPin) {
        if (pin2.value !== v) { err.textContent = 'The two PINs do not match.'; return; }
        makePin(v).then(function (rec) { return opMeta([{ k: 'pin', v: rec }]); })
          .then(reload).then(function () { unlock(); })
          .catch(function (e) { err.textContent = 'Could not save the PIN: ' + (e && e.message || e); });
        return;
      }
      if (Date.now() < waitUntil) { err.textContent = 'Too many tries. Wait a few seconds.'; return; }
      checkPin(v).then(function (ok) {
        if (ok) { fails = 0; unlock(); return; }
        fails++;
        pin.value = '';
        if (fails >= 5) { waitUntil = Date.now() + 30000; fails = 0; err.textContent = 'Too many tries. Wait 30 seconds.'; }
        else err.textContent = 'That is not the PIN.';
      });
    });
    box.appendChild(form);
    setTimeout(function () { try { pin.focus(); } catch (e) { /* ignore */ } }, 50);
  }
  function unlock() {
    S.locked = false;
    $('lock').hidden = true;
    $('lock').textContent = '';
    $('app').hidden = false;
    $('tabs').hidden = false;
    render();
  }
  function forgotPin() {
    var typed = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Type ERASE' });
    modal({
      title: 'Forgot the PIN?',
      body: h('div', { class: 'stack' },
        h('p', { text: 'The only way in is to erase everything on this iPad: students, records, prices and the PIN. Then you set a new PIN and restore your latest backup file.' }),
        h('p', { class: 'hint', text: 'If you have no backup, the records on this iPad cannot be recovered. Type ERASE to continue.' }), typed),
      actions: [
        { label: 'Erase everything', kind: 'danger', onclick: function (close) {
          if (typed.value.trim().toUpperCase() !== 'ERASE') { toast('Type ERASE to confirm.'); return; }
          close();
          opErase(true).then(reload).then(function () { S.classId = null; showLock(); toast('Erased. Choose a new PIN, then restore your backup from Settings.'); });
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }

  /* ---------- tabs and shell ---------- */
  var TABS = [['roll', 'Roll call'], ['people', 'People'], ['settings', 'Settings']];
  function buildTabs() {
    var nav = $('tabs');
    nav.textContent = '';
    TABS.forEach(function (t) {
      nav.appendChild(h('button', { type: 'button', class: 'tab', 'data-tab': t[0], onclick: function () { S.tab = t[0]; render(); window.scrollTo(0, 0); } }, t[1]));
    });
  }
  function render() {
    if (S.locked) return;
    var y = window.scrollY;
    var view = $('view');
    view.textContent = '';
    Array.prototype.forEach.call($('tabs').children, function (b) {
      if (b.getAttribute('data-tab') === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('sub').textContent = TABS.filter(function (t) { return t[0] === S.tab; })[0][1];
    view.appendChild(S.tab === 'roll' ? viewRoll() : S.tab === 'people' ? viewPeople() : viewSettings());
    window.scrollTo(0, y);
  }

  function backupText(onSettings) {
    var t = S.meta.lastBackup && S.meta.lastBackup.v;
    if (!t) return onSettings ? 'Last backup file: none yet.' : 'Last backup file: none yet. Take one from Settings.';
    var days = Math.floor((Date.now() - t) / 86400000);
    return 'Last backup file: ' + fmtDateTime(t) + (days >= 1 ? ' (' + days + (days === 1 ? ' day' : ' days') + ' ago)' : ' (today)');
  }
  function balanceText(s) {
    var parts = [];
    if (s.freeLeft > 0) parts.push('Free lessons left: ' + s.freeLeft);
    if (s.credits > 0) parts.push('Credits left: ' + s.credits);
    if (s.owedCents > 0) parts.push('Owes ' + L.money(s.owedCents));
    return parts.length ? parts.join(' · ') : 'No credits left';
  }
  function todayText(att, s) {
    if (att.cover === 'free') return 'Free lesson';
    if (att.cover === 'credit') return 'Pack credit used';
    var st = s && s.settleByAttend[att.id];
    if (!st) return 'Owes ' + L.money(att.priceCents);
    if (st.how === 'paid') return 'Paid ' + L.money(st.amountCents);
    if (st.how === 'comp') return 'Comped';
    if (st.how === 'credit') return 'Covered by a pack credit';
    return 'Covered by a free lesson';
  }
  function presentCount(classId) {
    var n = 0;
    S.people.forEach(function (p) { if (D.sums[p.id] && D.sums[p.id].attendByClass[classId]) n++; });
    return n;
  }

  /* ---------- roll call ---------- */
  function startClass(date) {
    if (!L.parseDate(date)) { toast('Pick a date for the class.'); return; }
    enqueue(function () {
      return opStartClass(date).then(function (c) { S.classId = c.id; return reload(); });
    });
  }
  var lastTap = {};
  function tapPerson(p, cls) {
    /* A fat-fingered double tap would mark someone present and straight away undo it. Ignore the second tap. */
    var now = Date.now();
    if (lastTap[p.id] && now - lastTap[p.id] < 500) return;
    lastTap[p.id] = now;
    var s = D.sums[p.id];
    var att = s && s.attendByClass[cls.id];
    function go(confirmed) {
      enqueue(function () {
        return opTap(p.id, cls.id, confirmed).then(function (plan) {
          return reload().then(function () {
            if (plan.info.action === 'attend' && plan.info.cover === 'owed') toast(p.name + ' owes ' + L.money(plan.info.priceCents) + '.');
          });
        }).catch(function (e) {
          if (e.needsConfirm) {
            confirmBox('Undo this lesson?', 'This lesson was already settled. Undoing it also undoes the payment or credit that settled it. If you took money, refund it yourself.', 'Undo lesson', function () { go(true); }, true);
            return reload();
          }
          toast(e.message);
          return reload();
        });
      });
    }
    if (att && s.settleByAttend[att.id]) {
      confirmBox('Undo this lesson?', 'This lesson was already settled. Undoing it also undoes the payment or credit that settled it. If you took money, refund it yourself.', 'Undo lesson', function () { go(true); }, true);
      return;
    }
    go(false);
  }
  function cancelClass(cls) {
    var n = presentCount(cls.id);
    confirmBox('Cancel this class?',
      n ? n + (n === 1 ? ' person is' : ' people are') + ' marked present. Cancelling undoes them, so nobody is charged or counted.' : 'Nobody is charged or counted for a cancelled class.',
      'Cancel the class', function () {
        enqueue(function () { return opCancelClass(cls.id).then(reload).then(function () { toast('Class cancelled.'); }); });
      }, true);
  }

  function viewRoll() {
    var v = h('div', { class: 'stack' });
    v.appendChild(h('p', { class: 'muted small', text: backupText() }));
    var cls = S.classId ? D.classesById[S.classId] : null;
    var dateInput = h('input', { type: 'date', value: cls ? cls.date : L.localDate(), 'aria-label': 'Class date' });
    v.appendChild(h('section', { class: 'card' },
      h('h2', { text: 'Class' }),
      h('div', { class: 'pick' }, dateInput,
        h('button', { type: 'button', class: 'btn', onclick: function () { startClass(dateInput.value); } }, 'Open class')),
      h('p', { class: 'hint', text: 'Pick the date and open it. Opening a date that already has a class just brings it back.' })));

    var recent = S.classes.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 6);
    if (recent.length) {
      v.appendChild(h('div', { class: 'chips', 'aria-label': 'Recent classes' }, recent.map(function (c) {
        return h('button', {
          type: 'button', class: 'chip', 'aria-current': c.id === S.classId ? 'true' : null,
          onclick: function () { S.classId = c.id; render(); }
        }, L.dateLabel(c.date) + (c.cancelled ? ' · cancelled' : ' · ' + presentCount(c.id)));
      })));
    }
    if (!cls) {
      v.appendChild(h('p', { class: 'muted', text: 'No class open. Pick a date above and tap Open class.' }));
      return v;
    }

    var summary = cls.cancelled ? 'Cancelled. Nobody is charged and nothing is counted.' : presentCount(cls.id) + ' present';
    v.appendChild(h('section', { class: 'card' },
      h('div', { class: 'chead' },
        h('div', {}, h('h2', { text: 'Roll call' }), h('p', { class: 'big2', text: L.dateLabel(cls.date) }), h('p', { class: 'muted', text: summary })),
        cls.cancelled
          ? h('button', { type: 'button', class: 'btn alt small', onclick: function () { enqueue(function () { return opReopenClass(cls.id).then(reload); }); } }, 'Reopen class')
          : h('button', { type: 'button', class: 'btn alt small', onclick: function () { cancelClass(cls); } }, 'Cancel this class'))));
    if (cls.cancelled) return v;

    var search = h('input', { type: 'search', placeholder: 'Find a name', value: S.rollQ, 'aria-label': 'Find a name', autocomplete: 'off' });
    var list = h('div', { class: 'rows' });
    function fill() {
      list.textContent = '';
      var q = S.rollQ.trim().toLowerCase();
      var shown = S.people.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; });
      if (!S.people.length) { list.appendChild(h('p', { class: 'muted', text: 'No students yet. Tap Add person to enter the first one.' })); return; }
      if (!shown.length) { list.appendChild(h('p', { class: 'muted', text: 'Nobody matches that name.' })); return; }
      shown.forEach(function (p) {
        var s = D.sums[p.id];
        var att = s.attendByClass[cls.id];
        list.appendChild(h('div', { class: 'row' + (att ? ' present' : '') },
          h('button', { type: 'button', class: 'rowmain', 'aria-pressed': att ? 'true' : 'false', 'data-person': p.id, onclick: function () { tapPerson(p, cls); } },
            h('span', { class: 'rname', text: p.name }),
            h('span', { class: 'rsub', text: (att ? todayText(att, s) + ' · ' : '') + balanceText(s) }),
            h('span', { class: 'badge', text: att ? 'Present' : 'Tap to mark present' })),
          h('div', { class: 'rowside' }, h('button', { type: 'button', class: 'btn alt small', onclick: function () { openPerson(p.id); } }, 'Details'))));
      });
    }
    search.addEventListener('input', function () { S.rollQ = search.value; fill(); });
    v.appendChild(h('div', { class: 'pick' }, search,
      h('button', { type: 'button', class: 'btn alt', onclick: function () { openPersonForm(null); } }, 'Add person')));
    v.appendChild(list);
    fill();
    return v;
  }

  /* ---------- people ---------- */
  function viewPeople() {
    var v = h('div', { class: 'stack' });
    var search = h('input', { type: 'search', placeholder: 'Find a name', value: S.pQ, 'aria-label': 'Find a name', autocomplete: 'off' });
    var srcSel = h('select', { 'aria-label': 'How they found the club' },
      h('option', { value: '' }, 'All sources'),
      L.SOURCES.map(function (s) { return h('option', { value: s }, labelSource(s)); }));
    srcSel.value = S.pSource;
    var noW = h('input', { type: 'checkbox', checked: S.pNoWaiver });
    var noR = h('input', { type: 'checkbox', checked: S.pNoRelease });
    var count = h('p', { class: 'muted small' });
    var list = h('div', { class: 'rows' });
    function fill() {
      list.textContent = '';
      var q = S.pQ.trim().toLowerCase();
      var shown = S.people.filter(function (p) {
        if (q && p.name.toLowerCase().indexOf(q) < 0) return false;
        if (S.pSource && p.source !== S.pSource) return false;
        if (S.pNoWaiver && p.waiver && p.waiver.signed) return false;
        if (S.pNoRelease && p.release && p.release.signed) return false;
        return true;
      });
      count.textContent = 'Showing ' + shown.length + ' of ' + S.people.length;
      if (!shown.length) list.appendChild(h('p', { class: 'muted', text: S.people.length ? 'Nobody matches those filters.' : 'No students yet.' }));
      shown.forEach(function (p) {
        var s = D.sums[p.id];
        list.appendChild(h('div', { class: 'row' },
          h('button', { type: 'button', class: 'rowmain', onclick: function () { openPerson(p.id); } },
            h('span', { class: 'rname', text: p.name }),
            h('span', { class: 'rsub', text: labelRate(p.rate) + (p.under18 ? ' · under 18' : '') + ' · ' + s.attendedCount + (s.attendedCount === 1 ? ' class' : ' classes') + (s.lastDate ? ' · last ' + L.dateLabel(s.lastDate) : '') }),
            h('span', { class: 'rsub', text: 'Injury waiver: ' + (p.waiver && p.waiver.signed ? 'yes' : 'no') + ' · Model release: ' + (p.release && p.release.signed ? 'yes' : 'no') + ' · ' + labelSource(p.source) })),
          h('span')));
      });
    }
    search.addEventListener('input', function () { S.pQ = search.value; fill(); });
    srcSel.addEventListener('change', function () { S.pSource = srcSel.value; fill(); });
    noW.addEventListener('change', function () { S.pNoWaiver = noW.checked; fill(); });
    noR.addEventListener('change', function () { S.pNoRelease = noR.checked; fill(); });
    v.appendChild(h('section', { class: 'card' },
      h('div', { class: 'pick' }, search, h('button', { type: 'button', class: 'btn', onclick: function () { openPersonForm(null); } }, 'Add person')),
      h('div', { class: 'filters' }, srcSel,
        h('label', { class: 'check' }, noW, 'No injury waiver'),
        h('label', { class: 'check' }, noR, 'No model release')),
      count));
    v.appendChild(list);
    fill();
    return v;
  }

  function openPerson(pid) {
    var sheet = pushSheet('', function (sh) {
      var p = personById(pid);
      if (!p) { sh.title = 'Not found'; return h('p', { text: 'This person no longer exists.' }); }
      sh.title = p.name;
      return personBody(p);
    }, [{ label: 'Close', kind: 'alt', onclick: popSheet }]);
    sheet.live = true;
  }

  function personBody(p) {
    var s = D.sums[p.id];
    var wrap = h('div', { class: 'stack' });
    var packSizes = L.packSizes(S.settings, p.rate);

    wrap.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Right now' }),
      h('dl', { class: 'facts' },
        fact('Free lessons left', s.freeLeft + ' of ' + s.freeAllowed),
        fact('Credits left', String(s.credits)),
        fact('Owes', s.owedCents > 0 ? L.money(s.owedCents) + ' (' + s.owed.length + (s.owed.length === 1 ? ' lesson)' : ' lessons)') : 'Nothing'),
        fact('Classes attended', String(s.attendedCount)),
        fact('Last attended', s.lastDate ? L.dateLabel(s.lastDate) : 'Not yet')),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn', disabled: packSizes.length ? null : true, onclick: function () { addPackModal(p.id); } }, 'Add a pack'),
        h('button', { type: 'button', class: 'btn alt', onclick: function () { openPersonForm(p); } }, 'Edit details')),
      packSizes.length ? null : h('p', { class: 'hint', text: 'The concession rate has no packs. It is a flat price per session.' })));

    if (s.owed.length) {
      wrap.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Owed lessons' }),
        s.owed.map(function (o) {
          return h('div', { class: 'owed' },
            h('p', {}, h('strong', { text: L.dateLabel(o.date) }), ' · owes ' + L.money(o.priceCents)),
            h('div', { class: 'acts' },
              h('button', { type: 'button', class: 'btn small', onclick: function () { paidModal(p.id, o); } }, 'Paid'),
              h('button', { type: 'button', class: 'btn alt small', onclick: function () { compModal(p.id, o); } }, 'Comp'),
              s.credits > 0 ? h('button', { type: 'button', class: 'btn alt small', onclick: function () { settleNow(p.id, o.attendId, 'credit', {}, 'Covered by a pack credit.'); } }, 'Use a pack credit') : null,
              s.freeLeft > 0 ? h('button', { type: 'button', class: 'btn alt small', onclick: function () { settleNow(p.id, o.attendId, 'free', {}, 'Covered by a free lesson.'); } }, 'Use a free lesson') : null));
        })));
    }

    wrap.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Forms' }),
      h('dl', { class: 'facts' },
        fact('Injury waiver', formText(p.waiver)),
        fact('Model release', formText(p.release)))));

    var about = [fact('Rate', labelRate(p.rate) + (p.rate === 'concession' ? (p.cardChecked ? ' (card checked)' : ' (card not checked)') : '')),
      fact('Under 18', p.under18 ? 'Yes' : 'No')];
    if (p.under18) {
      about.push(fact('Guardian', p.guardianName || 'Not recorded'));
      about.push(fact('Guardian phone', p.guardianPhone || 'Not recorded'));
    }
    about.push(fact('How they found the club', labelSource(p.source)));
    wrap.appendChild(h('section', { class: 'card' }, h('h2', { text: 'About' }), h('dl', { class: 'facts' }, about),
      p.note ? h('p', {}, h('strong', { text: 'Note: ' }), p.note) : null));

    var hist = L.history(p, D.entriesBy[p.id] || [], D.classesById);
    wrap.appendChild(h('section', { class: 'card' }, h('h2', { text: 'History, newest first' }),
      hist.length ? h('ul', { class: 'hist' }, hist.map(function (r) {
        return h('li', { class: (r.undone ? 'undone' : '') + (r.isReverse ? ' rev' : '') },
          h('div', {}, h('span', { class: 't', text: r.title }), r.detail ? h('span', { class: 'd', text: ' · ' + r.detail }) : null),
          r.canUndo ? h('button', { type: 'button', class: 'btn alt small', onclick: function () { undoEntry(p, r); } }, 'Undo') : h('span'),
          h('span', { class: 'when', text: fmtDateTime(r.entry.at) + (r.undone ? ' · undone' : '') }));
      })) : h('p', { class: 'muted', text: 'Nothing recorded yet.' })));

    if (!hist.length) {
      wrap.appendChild(h('button', { type: 'button', class: 'btn danger', onclick: function () {
        confirmBox('Remove ' + p.name + '?', 'Nothing has been recorded for this person, so they can be removed safely.', 'Remove', function () {
          enqueue(function () { return opDeletePerson(p.id).then(function () { popSheet(); return reload(); }); });
        }, true);
      } }, 'Remove this person'));
    }
    return wrap;
  }
  function fact(k, v) { return h('div', {}, h('dt', { text: k }), h('dd', { text: v })); }

  function settleNow(pid, attendId, how, opts, okMsg) {
    enqueue(function () {
      return opSettle(pid, attendId, how, opts).then(reload).then(function () { toast(okMsg); }).catch(function (e) { toast(e.message); return reload(); });
    });
  }
  function undoEntry(p, r) {
    var plan = L.planReverse(p, D.entriesBy[p.id] || [], r.entry.id, D.classesById, Date.now());
    if (!plan.ok) { toast(plan.reason); return; }
    var extra = plan.info && plan.info.alsoUndidSettle ? ' This lesson was settled, so that is undone too. If you took money, refund it yourself.' : '';
    confirmBox('Undo this entry?', r.title + '.' + extra + ' It stays in the history, marked as undone.', 'Undo it', function () {
      enqueue(function () {
        return opReverse(p.id, r.entry.id).then(reload).then(function () { toast('Undone.'); }).catch(function (e) { toast(e.message); return reload(); });
      });
    }, true);
  }

  function methodSelect() {
    var sel = h('select', { 'aria-label': 'How it was paid' }, L.METHODS.map(function (m) { return h('option', { value: m }, labelMethod(m)); }));
    sel.value = 'cash';
    return sel;
  }
  function labelled(text, control, hint) {
    var id = 'f' + (++uid);
    control.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: text }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }
  function paidModal(pid, o) {
    var amount = h('input', { type: 'text', inputmode: 'decimal', value: dollars(o.priceCents) });
    var method = methodSelect();
    modal({
      title: 'Lesson ' + L.dateLabel(o.date) + ' paid',
      body: h('div', { class: 'stack' }, labelled('Amount paid ($)', amount), labelled('How it was paid', method)),
      actions: [
        { label: 'Save payment', onclick: function (close) {
          var cents = L.parseDollars(amount.value);
          if (cents === null) { toast('Enter the amount as dollars, for example 25 or 12.50.'); return; }
          close();
          settleNow(pid, o.attendId, 'paid', { amountCents: cents, method: method.value }, 'Payment saved.');
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }
  function compModal(pid, o) {
    var note = h('input', { type: 'text', placeholder: 'For example: will buy a pack next week', autocomplete: 'off' });
    modal({
      title: 'Comp the lesson ' + L.dateLabel(o.date),
      body: h('div', { class: 'stack' }, h('p', { text: 'A comped lesson is free. It is not owed and does not use a pack credit, and it still counts as attended.' }), labelled('Short reason', note)),
      actions: [
        { label: 'Comp this lesson', onclick: function (close) {
          if (!note.value.trim()) { toast('Add a short reason first.'); return; }
          close();
          settleNow(pid, o.attendId, 'comp', { note: note.value }, 'Lesson comped.');
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }
  function addPackModal(pid) {
    var p = personById(pid);
    var sizes = L.packSizes(S.settings, p.rate);
    if (!sizes.length) { toast('There are no packs for the ' + labelRate(p.rate).toLowerCase() + ' rate.'); return; }
    var chosen = sizes.indexOf(10) >= 0 ? 10 : sizes[0];
    var amount = h('input', { type: 'text', inputmode: 'decimal', value: dollars(L.packPrice(S.settings, p.rate, chosen)) });
    var method = methodSelect();
    var chips = h('div', { class: 'chips' });
    function draw() {
      chips.textContent = '';
      sizes.forEach(function (sz) {
        chips.appendChild(h('button', {
          type: 'button', class: 'chip', 'aria-pressed': sz === chosen ? 'true' : 'false', 'data-size': sz,
          onclick: function () { chosen = sz; amount.value = dollars(L.packPrice(S.settings, p.rate, sz)); draw(); }
        }, sz + '-pack · ' + L.money(L.packPrice(S.settings, p.rate, sz))));
      });
    }
    draw();
    modal({
      title: 'Add a pack for ' + p.name,
      body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Pack size' }), chips),
        labelled('Amount paid ($)', amount, 'Starts at the listed price. Change it if they paid something different.'), labelled('How it was paid', method)),
      actions: [
        { label: 'Add pack', onclick: function (close) {
          var cents = L.parseDollars(amount.value);
          if (cents === null) { toast('Enter the amount as dollars, for example 200.'); return; }
          close();
          enqueue(function () {
            return opPack(pid, chosen, cents, method.value).then(function (plan) {
              return reload().then(function () {
                toast(chosen + '-pack added.');
                var s = D.sums[pid];
                if (s.owed.length && s.credits > 0) coverPrompt(pid);
              });
            }).catch(function (e) { toast(e.message); return reload(); });
          });
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }
  function coverPrompt(pid) {
    var p = personById(pid);
    var s = D.sums[pid];
    var n = Math.min(s.owed.length, s.credits);
    modal({
      title: 'Cover the owed lessons?',
      focus: false,
      body: h('p', { text: p.name + ' owes ' + s.owed.length + (s.owed.length === 1 ? ' lesson' : ' lessons') + ' (' + L.money(s.owedCents) + '). Covering uses ' + n + (n === 1 ? ' credit' : ' credits') + ' from the pack and clears ' + (n === s.owed.length ? 'them' : n + ' of them') + '.' }),
      actions: [
        { label: 'Cover them with the pack', onclick: function (close) {
          close();
          enqueue(function () { return opCover(pid).then(reload).then(function () { toast('Covered.'); }); });
        } },
        { label: 'Leave them owed', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }

  /* ---------- add and edit a person ---------- */
  function sel(options, value) {
    var el = h('select', {}, options.map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    el.value = value;
    return el;
  }
  function openPersonForm(existing) {
    var isNew = !existing;
    var p = existing ? JSON.parse(JSON.stringify(existing)) : {
      name: '', rate: 'adult', under18: false, guardianName: '', guardianPhone: '', source: '',
      waiver: { signed: false, date: '', by: '' }, release: { signed: false, date: '', by: '' },
      cardChecked: false, freeAllowed: S.settings.freeLessons, freeUsedBefore: 0, note: '', createdAt: Date.now()
    };
    p.waiver = p.waiver || { signed: false, date: '', by: '' };
    p.release = p.release || { signed: false, date: '', by: '' };

    var name = h('input', { type: 'text', value: p.name, autocomplete: 'off', autocapitalize: 'words' });
    var rate = sel(L.RATES.map(function (r) { return [r, labelRate(r)]; }), p.rate);
    var under = h('input', { type: 'checkbox', checked: p.under18 });
    var gName = h('input', { type: 'text', value: p.guardianName || '', autocomplete: 'off', autocapitalize: 'words' });
    var gPhone = h('input', { type: 'tel', value: p.guardianPhone || '', autocomplete: 'off' });
    var source = sel([['', 'Choose…']].concat(L.SOURCES.map(function (s) { return [s, labelSource(s)]; })), p.source || '');
    var card = h('input', { type: 'checkbox', checked: p.cardChecked });
    var gBox = h('div', { class: 'group' }, labelled('Guardian name', gName), labelled('Guardian phone', gPhone));
    var cardBox = h('label', { class: 'check' }, card, 'Concession card checked');

    function formGroup(title, f) {
      var signed = h('input', { type: 'checkbox', checked: f.signed });
      var date = h('input', { type: 'date', value: f.date || '' });
      var by = h('input', { type: 'text', value: f.by || '', autocomplete: 'off', autocapitalize: 'words' });
      var detail = h('div', { class: 'two' }, labelled('Date signed', date), labelled('Signed by', by));
      function sync() { detail.hidden = !signed.checked; if (signed.checked && !date.value) date.value = L.localDate(); }
      signed.addEventListener('change', sync);
      sync();
      return {
        el: h('div', { class: 'group' }, h('label', { class: 'check' }, signed, title + ' signed'), detail),
        read: function () { return { signed: signed.checked, date: signed.checked ? date.value : '', by: signed.checked ? by.value.trim() : '' }; }
      };
    }
    var waiver = formGroup('Injury waiver', p.waiver);
    var release = formGroup('Model release', p.release);
    var freeAllowed = h('input', { type: 'number', min: '0', step: '1', value: p.freeAllowed });
    var freeUsed = h('input', { type: 'number', min: '0', step: '1', value: p.freeUsedBefore || 0 });
    var note = h('textarea', { rows: '3', placeholder: 'Not for medical details', autocomplete: 'off' });
    note.value = p.note || '';

    function sync() { gBox.hidden = !under.checked; cardBox.hidden = rate.value !== 'concession'; }
    under.addEventListener('change', sync);
    rate.addEventListener('change', sync);
    sync();

    function save() {
      var nm = name.value.trim();
      if (!nm) { toast('Enter a name.'); return; }
      if (!source.value) { toast('Choose how they found the club.'); return; }
      var fa = parseInt(freeAllowed.value, 10), fu = parseInt(freeUsed.value, 10);
      if (!(fa >= 0) || !(fu >= 0)) { toast('Free lessons must be a whole number, zero or more.'); return; }
      var w = waiver.read(), r = release.read();
      if (under.checked && w.signed && !w.by) { toast('Say which parent or guardian signed the injury waiver.'); return; }
      if (under.checked && r.signed && !r.by) { toast('Say which parent or guardian signed the model release.'); return; }
      var out = Object.assign({}, p, {
        name: nm, rate: rate.value, under18: under.checked,
        guardianName: under.checked ? gName.value.trim() : '', guardianPhone: under.checked ? gPhone.value.trim() : '',
        source: source.value, waiver: w, release: r,
        cardChecked: rate.value === 'concession' ? card.checked : false,
        freeAllowed: fa, freeUsedBefore: fu, note: note.value.trim()
      });
      if (isNew) delete out.id;
      function commit() {
        enqueue(function () {
          return opSavePerson(out).then(function (id) {
            return reload().then(function () { popSheet(); toast(isNew ? nm + ' added.' : 'Saved.'); });
          });
        });
      }
      var dup = isNew && S.people.some(function (x) { return x.name.trim().toLowerCase() === nm.toLowerCase(); });
      if (dup) confirmBox('Same name already here', 'Someone called ' + nm + ' is already on the list. Add another one anyway?', 'Add anyway', commit);
      else commit();
    }

    pushSheet(isNew ? 'Add person' : 'Edit details', function () {
      return h('div', { class: 'stack' },
        h('section', { class: 'card' },
          labelled('Name', name), labelled('Rate', rate), h('label', { class: 'check' }, under, 'Under 18'), gBox, cardBox,
          labelled('How they found the club', source)),
        h('section', { class: 'card' }, h('h2', { text: 'Forms' }), waiver.el, release.el,
          h('p', { class: 'hint', text: 'For under-18s, a parent or guardian signs both forms and the record says who.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Free lessons' }),
          h('div', { class: 'two' }, labelled('Free lessons allowed', freeAllowed, 'Everyone gets ' + S.settings.freeLessons + ' unless you change it.'),
            labelled('Already used before this app', freeUsed, 'For people who started before today.'))),
        h('section', { class: 'card' }, labelled('Note', note)),
        h('button', { type: 'button', class: 'btn', onclick: save }, isNew ? 'Add person' : 'Save changes'));
    }, [{ label: 'Cancel', kind: 'alt', onclick: popSheet }]);
    setTimeout(function () { if (isNew) name.focus(); }, 80);
  }

  /* ---------- settings, backup and restore ---------- */
  function makeBackup() {
    return loadAll().then(function (d) {
      var payload = { app: APP, schema: 1, exportedAt: new Date().toISOString(), settings: S.settings, people: d.people, classes: d.classes, ledger: d.ledger };
      return { json: JSON.stringify(payload, null, 2), name: 'portland-takedown-backup-' + L.localDate() + '.json' };
    });
  }
  function noteBackup() { return opMeta([{ k: 'lastBackup', v: Date.now() }]).then(reload); }
  function downloadFile(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function saveBackup() {
    makeBackup().then(function (b) {
      var file = new File([b.json], b.name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: b.name }).then(function () {
          toast('Share sheet closed. If you chose your encrypted Google Drive folder, check that ' + b.name + ' is there.');
          return noteBackup();
        }, function (e) {
          if (e && e.name === 'AbortError') { toast('Cancelled. No file was saved.'); return null; }
          downloadFile(file); toast('Downloaded ' + b.name + '. Look in Downloads or the Files app.'); return noteBackup();
        });
      }
      downloadFile(file);
      toast('Downloaded ' + b.name + '. Look in Downloads or the Files app.');
      return noteBackup();
    }).catch(function (e) { toast('Backup failed: ' + (e && e.message || e)); });
  }
  function copyBackup(pasteBox, pasteDetails) {
    makeBackup().then(function (b) {
      var fallback = function () { pasteBox.value = b.json; pasteDetails.open = true; pasteBox.select(); toast('Copy did not work here. The text is in the box below: select it and copy.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(b.json).then(function () { toast('Copied. Paste it somewhere private, such as a note you lock.'); return noteBackup(); }, fallback);
      }
      fallback();
    });
  }
  function offerRestore(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { toast('That is not a backup. It could not be read.'); return; }
    var check = L.validateBackup(o);
    if (!check.ok) { toast(check.reason); return; }
    var savedAt = Date.parse(o.exportedAt);
    confirmBox('Replace everything on this iPad?',
      'This backup was saved ' + (isNaN(savedAt) ? 'on an unknown date' : fmtDateTime(savedAt)) + '. It holds ' + check.counts.people + ' people, ' + check.counts.classes + ' classes and ' + check.counts.ledger + ' ledger entries. Restoring replaces the ' + S.people.length + ' people and ' + S.ledger.length + ' entries on this iPad.',
      'Replace everything', function () {
        enqueue(function () {
          return opRestore(o).then(function () { S.classId = null; return reload(); }).then(function () { toast('Restored ' + check.counts.people + ' people.'); }).catch(function (e) { toast('Restore failed, nothing was changed: ' + (e && e.message || e)); });
        });
      }, true);
  }

  function priceInput(cents) { return h('input', { type: 'text', inputmode: 'decimal', value: dollars(cents) }); }
  function viewSettings() {
    var v = h('div', { class: 'stack' });

    var paste = h('textarea', { rows: '5', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
    var pasteDetails = h('details', {}, h('summary', { text: 'Restore from pasted text' }),
      labelled('Paste the backup text here', paste),
      h('button', { type: 'button', class: 'btn alt', onclick: function () { offerRestore(paste.value); } }, 'Check pasted text'));
    var fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'sr', id: 'restoreFile' });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { offerRestore(String(fr.result)); };
      fr.onerror = function () { toast('That file could not be read.'); };
      fr.readAsText(f);
    });
    v.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Backup and restore' }),
      h('p', { class: 'muted', text: backupText(true) }),
      h('p', { class: 'hint', text: 'A backup file holds student details. Save it only to your encrypted Google Drive folder.' }),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn', onclick: saveBackup }, 'Save backup file'),
        h('button', { type: 'button', class: 'btn alt', onclick: function () { copyBackup(paste, pasteDetails); } }, 'Copy backup as text'),
        h('label', { class: 'btn alt', for: 'restoreFile' }, 'Restore from file')),
      fileInput, pasteDetails));

    var P = S.settings.prices;
    var free = h('input', { type: 'number', min: '0', step: '1', value: S.settings.freeLessons });
    var inputs = {
      adultS: priceInput(P.adult.sessionCents), adult5: priceInput(P.adult.packs[5]), adult10: priceInput(P.adult.packs[10]),
      juniorS: priceInput(P.junior.sessionCents), junior5: priceInput(P.junior.packs[5]), junior10: priceInput(P.junior.packs[10]), junior20: priceInput(P.junior.packs[20]),
      concS: priceInput(P.concession.sessionCents)
    };
    function savePrices() {
      var out = JSON.parse(JSON.stringify(S.settings));
      var fl = parseInt(free.value, 10);
      if (!(fl >= 0)) { toast('Free lessons must be zero or more.'); return; }
      out.freeLessons = fl;
      var map = [['adult', 'sessionCents', inputs.adultS], ['adult', 5, inputs.adult5], ['adult', 10, inputs.adult10],
        ['junior', 'sessionCents', inputs.juniorS], ['junior', 5, inputs.junior5], ['junior', 10, inputs.junior10], ['junior', 20, inputs.junior20],
        ['concession', 'sessionCents', inputs.concS]];
      for (var i = 0; i < map.length; i++) {
        var c = L.parseDollars(map[i][2].value);
        if (c === null) { toast('Enter prices as dollars, for example 25 or 12.50.'); return; }
        if (map[i][1] === 'sessionCents') out.prices[map[i][0]].sessionCents = c; else out.prices[map[i][0]].packs[map[i][1]] = c;
      }
      enqueue(function () { return opMeta([{ k: 'settings', v: out }]).then(reload).then(function () { toast('Prices saved. Earlier entries keep the prices they were made at.'); }); });
    }
    v.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Prices' }),
      labelled('Free lessons for new people', free),
      h('div', { class: 'two' },
        h('div', { class: 'group' }, h('h3', { text: 'Adult' }), labelled('Per session ($)', inputs.adultS), labelled('5-class pack ($)', inputs.adult5), labelled('10-class pack ($)', inputs.adult10)),
        h('div', { class: 'group' }, h('h3', { text: 'Junior' }), labelled('Per session ($)', inputs.juniorS), labelled('5-class pack ($)', inputs.junior5), labelled('10-class pack ($)', inputs.junior10), labelled('20-class pack ($)', inputs.junior20)),
        h('div', { class: 'group' }, h('h3', { text: 'Concession' }), labelled('Flat per session ($)', inputs.concS))),
      h('button', { type: 'button', class: 'btn', onclick: savePrices }, 'Save prices')));

    var deviceBox = h('dl', { class: 'status' });
    v.appendChild(h('section', { class: 'card' }, h('h2', { text: 'This iPad' }), deviceBox,
      h('button', { type: 'button', class: 'btn alt', onclick: askPersist }, 'Ask the iPad to keep my data')));
    renderDevice(deviceBox);

    v.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Security' }),
      h('p', { class: 'muted', text: 'The PIN keeps casual eyes out. It does not scramble the data. The iPad’s own passcode is what protects it, so keep one set.' }),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn alt', onclick: changePin }, 'Change PIN'),
        h('button', { type: 'button', class: 'btn alt', onclick: showLock }, 'Lock now'))));

    v.appendChild(h('section', { class: 'card' }, h('h2', { text: 'Start fresh' }),
      h('p', { class: 'muted', text: 'Erases all students, classes and records on this iPad. Prices and the PIN stay. Use it after trying the app with made-up names, once you have a backup of anything you want to keep.' }),
      h('button', { type: 'button', class: 'btn danger', onclick: startFresh }, 'Erase all students and records')));

    v.appendChild(h('footer', { text: BUILD }));
    return v;
  }
  function changePin() {
    var cur = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', autocomplete: 'off' });
    var n1 = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', autocomplete: 'off' });
    var n2 = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', autocomplete: 'off' });
    modal({
      title: 'Change PIN',
      body: h('div', { class: 'stack' }, labelled('Current PIN', cur), labelled('New PIN (four to eight digits)', n1), labelled('Repeat the new PIN', n2)),
      actions: [
        { label: 'Save new PIN', onclick: function (close) {
          if (!/^\d{4,8}$/.test(n1.value)) { toast('Use four to eight digits.'); return; }
          if (n1.value !== n2.value) { toast('The two new PINs do not match.'); return; }
          checkPin(cur.value).then(function (ok) {
            if (!ok) { toast('The current PIN is not right.'); return null; }
            close();
            return makePin(n1.value).then(function (rec) { return opMeta([{ k: 'pin', v: rec }]); }).then(reload).then(function () { toast('PIN changed.'); });
          });
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }
  function startFresh() {
    var typed = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters' });
    modal({
      title: 'Erase all students and records?',
      body: h('div', { class: 'stack' }, h('p', { text: 'Every student, class and ledger entry on this iPad will be erased. This cannot be undone, so save a backup file first if you might want anything back.' }),
        labelled('Type ERASE to continue', typed)),
      actions: [
        { label: 'Erase', kind: 'danger', onclick: function (close) {
          if (typed.value.trim().toUpperCase() !== 'ERASE') { toast('Type ERASE to confirm.'); return; }
          close();
          enqueue(function () { return opErase(false).then(function () { S.classId = null; return reload(); }).then(function () { toast('Erased. The app is empty.'); }); });
        } },
        { label: 'Cancel', kind: 'alt', onclick: function (close) { close(); } }
      ]
    });
  }

  /* ---------- device check ---------- */
  function deviceRow(box, label, value, state, hint) {
    var dd = h('dd', { text: value });
    box.appendChild(h('div', { class: 'st', 'data-s': state || 'info' }, h('dt', { text: label }), dd, hint ? h('span', { class: 'h', text: hint }) : null));
  }
  function askPersist() {
    if (!(navigator.storage && navigator.storage.persist)) { toast('This iPad does not offer that option here. The backup file matters more.'); return; }
    navigator.storage.persist().then(function (ok) {
      toast(ok ? 'Granted. The iPad has marked this data as keep.' : 'Not granted. Keep taking backup files.');
      render();
    });
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function renderDevice(box) {
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    var rows = [];
    deviceRow(box, 'Connection', navigator.onLine ? 'Online' : 'Offline', 'info', 'As reported by the iPad.');
    deviceRow(box, 'Opened as', standalone ? 'Home screen app' : 'Safari tab', standalone ? 'ok' : 'info', standalone ? '' : 'Use the home-screen icon, so the app and its data stay in one place.');
    var swRow = h('div', { class: 'st', 'data-s': 'info' }, h('dt', { text: 'Offline files' }), h('dd', { text: 'Checking…' }));
    var keepRow = h('div', { class: 'st', 'data-s': 'info' }, h('dt', { text: 'Kept when space is low' }), h('dd', { text: 'Checking…' }));
    var spaceRow = h('div', { class: 'st', 'data-s': 'info' }, h('dt', { text: 'Space used' }), h('dd', { text: 'Checking…' }));
    box.appendChild(swRow); box.appendChild(keepRow); box.appendChild(spaceRow);
    deviceRow(box, 'Opens', S.opens ? S.opens + ' since ' + fmtDateTime(S.first) : 'Unknown');
    deviceRow(box, 'Opened before this one', S.prev ? fmtDateTime(S.prev) : 'First open');

    function set(row, text, state, hint) {
      row.setAttribute('data-s', state);
      row.querySelector('dd').textContent = text;
      if (hint) row.appendChild(h('span', { class: 'h', text: hint }));
    }
    if (!('serviceWorker' in navigator) || !('caches' in window)) {
      set(swRow, 'Not supported', 'no', 'This browser cannot save the app for offline use.');
    } else {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        var active = !!(reg && reg.active);
        return caches.keys().then(function (keys) {
          var mine = keys.filter(function (k) { return k.indexOf('pt-rollcall-') === 0; });
          return Promise.all(mine.map(function (k) { return caches.open(k).then(function (c) { return c.keys(); }); })).then(function (lists) {
            var n = lists.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
            if (active && n >= EXPECTED_FILES) set(swRow, 'Ready (' + n + ' of ' + EXPECTED_FILES + ' saved)', 'ok');
            else set(swRow, 'Not ready (' + n + ' of ' + EXPECTED_FILES + ' saved)', 'no', S.swError || 'Stay online for a few seconds, then reopen the app.');
          });
        });
      }).catch(function () { set(swRow, 'Cannot tell', 'info'); });
    }
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        if (p) set(keepRow, 'Yes', 'ok'); else set(keepRow, 'Not guaranteed', 'info', 'The iPad may clear this if it sits unused. Keep taking backup files.');
      }, function () { set(keepRow, 'Cannot tell', 'info'); });
    } else set(keepRow, 'Cannot tell', 'info', 'This iPad does not say. Keep taking backup files.');
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) { set(spaceRow, bytes(e.usage || 0) + (e.quota ? ' of ' + bytes(e.quota) : ''), 'info'); }, function () { set(spaceRow, 'Unknown', 'info'); });
    } else set(spaceRow, 'Unknown', 'info');
  }

  /* ---------- start up ---------- */
  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) toast('A new version is ready. Close the app fully and open it again to use it.');
    });
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function (e) { S.swError = String(e && e.message || e); });
  }

  function boot() {
    buildTabs();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { S.hiddenAt = Date.now(); return; }
      if (!S.locked && S.hiddenAt && Date.now() - S.hiddenAt > IDLE_LOCK_MS) showLock();
    });
    openDB().then(function (d) {
      db = d;
      return loadAll();
    }).then(function (d) {
      S.meta = metaMap(d.meta);
      var now = Date.now();
      var first = S.meta.first ? S.meta.first.v : now;
      S.first = first;
      S.prev = S.meta.last ? S.meta.last.v : null;
      S.opens = (S.meta.opens ? S.meta.opens.v : 0) + 1;
      return opMeta([{ k: 'first', v: first }, { k: 'opens', v: S.opens }, { k: 'last', v: now }]);
    }).then(reload).then(function () {
      showLock();
      registerWorker();
    }).catch(function (e) {
      S.dbError = String(e && e.message || e);
      var box = $('lock');
      box.hidden = false;
      box.textContent = '';
      box.appendChild(h('div', { class: 'lockbox' }, h('h1', { text: 'Storage is not working' }), h('p', { text: S.dbError }),
        h('p', { class: 'hint', text: 'Open this app from its home-screen icon in Safari. If it still fails, tell Claude what this message says.' })));
    });
  }
  boot();
})();
