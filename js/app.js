/* e-SIM Wali Asuh SR — Klien SPA statis (GitHub Pages) + GAS REST API. Prinsip gas-instant-ux:
   1) SPA: semua tampilan di DOM, pindah menu = show/hide (tanpa reload / ?page=)
   2) Optimistic UI: tulis lokal dulu, antrean (outbox) di localStorage, sinkron di latar
   3) Cache: data terakhir disimpan lokal => buka aplikasi langsung tampil, lalu pull berversi
   4) Batch: satu panggilan sync.push untuk banyak item */
(function () {
'use strict';
var CLIENT_V = '1.3.0';
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var LS = {
  g: function (k, d) { try { var v = localStorage.getItem('esim:v3:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  s: function (k, v) { try { localStorage.setItem('esim:v3:' + k, JSON.stringify(v)); } catch (e) {} },
  r: function (k) { try { localStorage.removeItem('esim:v3:' + k); } catch (e) {} }
};
var EMPTY = function () { return { siswa: [], absensi: [], bimbingan: [], wali: [], pengaturan: { kegiatan: [], topik: [] } }; };
var S = { tok: LS.g('tok', null), user: LS.g('user', null), srv: EMPTY(), ver: {}, box: [], pref: LS.g('pref', { hemat: false, dark: false }),
  online: navigator.onLine !== false, syncing: false, view: '', stack: [], d: EMPTY(), by: {}, last: null, hari: null, ses: null, q: '', tlSeg: 'Terbuka', tlFil: 'semua', tlSort: 'tenggat', pv: 'dash', lap: { tipe: 'individu' }, kj: { fotos: [], jenis: 'Kunjungan Rumah' }, ofs: 0, retry: 0 };

/* ---------- util ---------- */
var HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'], BLN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function tz() { return (S.srv.pengaturan && S.srv.pengaturan.zona_waktu) || 'Asia/Jayapura'; }
function today() { try { return new Date().toLocaleDateString('sv-SE', { timeZone: tz() }); } catch (e) { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); } }
function nowHM() { try { return new Date().toLocaleTimeString('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }); } catch (e) { return new Date().toTimeString().slice(0, 5); } }
function pd(iso) { var p = String(iso || '').split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function fTgl(iso, mode) { if (!iso) return '-'; var d = pd(iso); if (mode === 'long') return HARI[d.getDay()] + ', ' + d.getDate() + ' ' + BLN[d.getMonth()] + ' ' + d.getFullYear(); if (mode === 'mid') return d.getDate() + ' ' + BLN[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear(); return d.getDate() + ' ' + BLN[d.getMonth()].slice(0, 3); }
function diff(a, b) { return Math.round((pd(a) - pd(b)) / 86400000); }
function addD(iso, n) { var d = pd(iso); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function ini(n) { var p = String(n || '?').trim().split(/\s+/); return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
function ic(n, c) { return '<span class="ms ' + (c || '') + '" aria-hidden="true">' + n + '</span>'; }
function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function nick(n) { return String(n || '').replace(/\s*\(.*\)/, ''); }
var ST_CLS = { 'Hadir': 'ok', 'Terlambat': '', 'Izin': 'info', 'Sakit': '', 'Tidak Hadir': 'bad' };
function pill(t, c) { return '<span class="pill ' + (c || '') + '">' + esc(t) + '</span>'; }
function greet() { var h = +nowHM().slice(0, 2); return h < 11 ? 'Pagi Cerah' : h < 15 ? 'Siang Terang' : h < 18 ? 'Sore Tenang' : 'Malam Tenang'; }
function persist() {
  if (!S.user) return; var id = S.user.id;
  LS.s('ver:' + id, S.ver); LS.s('box:' + id, S.box); LS.s('last:' + id, S.last);
  if (S.user.peran === 'WaliAsuh') LS.s('srv:' + id, S.srv);
}
function download(name, mime, content) {
  var b = content instanceof Blob ? content : new Blob([content], { type: mime });
  var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { no({ message: 'Gagal memuat pustaka. Periksa koneksi.' }); }; document.head.appendChild(s); }); }

/* ---------- IndexedDB (foto) ---------- */
var IDB = { db: null, mem: {},
  open: function () { var me = this; return new Promise(function (ok) { try { var r = indexedDB.open('esim-foto', 1); r.onupgradeneeded = function () { r.result.createObjectStore('f'); }; r.onsuccess = function () { me.db = r.result; ok(); }; r.onerror = function () { ok(); }; } catch (e) { ok(); } }); },
  put: function (k, v) { var me = this; me.mem[k] = v; return new Promise(function (ok) { if (!me.db) return ok(); try { var t = me.db.transaction('f', 'readwrite'); t.objectStore('f').put(v, k); t.oncomplete = ok; t.onerror = ok; } catch (e) { ok(); } }); },
  get: function (k) { var me = this; return new Promise(function (ok) { if (me.mem[k]) return ok(me.mem[k]); if (!me.db) return ok(null); try { var q = me.db.transaction('f').objectStore('f').get(k); q.onsuccess = function () { ok(q.result || null); }; q.onerror = function () { ok(null); }; } catch (e) { ok(null); } }); },
  del: function (k) { var me = this; delete me.mem[k]; return new Promise(function (ok) { if (!me.db) return ok(); try { var t = me.db.transaction('f', 'readwrite'); t.objectStore('f').delete(k); t.oncomplete = ok; t.onerror = ok; } catch (e) { ok(); } }); }
};

/* ---------- API (satu pintu: api(req)) ---------- */
function call(action, data, o) {
  o = o || {};
  var cfg = window.ESIM_CONFIG || {}, url = cfg.GAS_URL;
  if (!url || /GANTI_DENGAN/.test(url)) return Promise.reject({ code: 'CONFIG', message: 'URL backend belum diisi di js/config.js.' });
  var ac = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(function () { if (ac) ac.abort(); }, o.timeout || 40000);
  /* text/plain => "simple request": tidak memicu preflight CORS yang tidak didukung GAS */
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: action, data: data || {}, token: S.tok, cv: CLIENT_V }), redirect: 'follow', signal: ac ? ac.signal : undefined })
    .then(function (r) { return r.json(); })
    .catch(function (e) { throw { code: 'NET', message: e && e.name === 'AbortError' ? 'Server lambat merespons.' : 'Tidak dapat terhubung ke server.' }; })
    .then(function (r) {
      clearTimeout(to);
      if (r && r.ok) return r.data;
      var e = (r && r.error) || { code: 'SERVER', message: 'Respons tidak valid.' };
      if ((e.code === 'AUTH_INVALID' || e.code === 'AUTH_EXPIRED') && action !== 'auth.login') { if (S.tok) logout(e.message); }
      if (e.code === 'CLIENT_OUTDATED') banner('Versi aplikasi usang. <button class="btn-s" data-act="reload">Muat ulang</button>', 'bad');
      throw e;
    }, function (e) { clearTimeout(to); throw e; });
}

/* ---------- UI dasar ---------- */
function toast(msg, type, label, fn) {
  var w = $('#toasts'), t = document.createElement('div'); t.className = 'toast ' + (type || ''); t.setAttribute('role', 'status');
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (label ? '<button>' + esc(label) + '</button>' : '');
  if (label) t.querySelector('button').onclick = function () { fn && fn(); t.remove(); };
  w.appendChild(t); setTimeout(function () { t.remove(); }, label ? 6000 : 3200);
}
function banner(html, cls) { var b = $('#banner'); b.className = 'alert ' + (cls || ''); b.innerHTML = html; b.hidden = false; }
function sheet(html, center) { var o = $('#ov'); o.className = 'ov on' + (center ? ' c' : ''); $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet').scrollTop = 0; }
function closeSheet() { $('#ov').className = 'ov'; $('#sheet').innerHTML = ''; }
function apply() { var h = document.documentElement; h.dataset.theme = S.pref.dark ? 'dark' : 'light'; document.body.classList.toggle('hemat', !!S.pref.hemat); }
function busy(btn, on, txt) { if (!btn) return; if (on) { btn.dataset.t = btn.innerHTML; btn.disabled = true; btn.innerHTML = txt || 'Memproses…'; } else { btn.disabled = false; if (btn.dataset.t) btn.innerHTML = btn.dataset.t; } }
function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }

/* ---------- Data: server + antrean => tampilan ---------- */
function rebuild() {
  var s = S.srv, d = { siswa: s.siswa, absensi: s.absensi.slice(), bimbingan: s.bimbingan.slice(), wali: s.wali, pengaturan: s.pengaturan };
  var ia = {}, ib = {}; d.absensi.forEach(function (a, i) { ia[a.id] = i; }); d.bimbingan.forEach(function (b, i) { ib[b.id] = i; });
  S.box.forEach(function (it) {
    if (it.st === 'Ditolak' || it.st === 'Konflik') return;
    var k = it.type + '.' + it.op, x = it.data;
    if (k === 'sesi_absensi.create') x.rows.forEach(function (r) {
      var id = x.id_sesi + '-' + r.id_siswa; if (ia[id] != null) return;
      ia[id] = d.absensi.push({ id: id, sesi: x.id_sesi, tgl: x.tanggal, jam: x.jam, id_siswa: r.id_siswa, id_wali: S.user.id, kegiatan: x.kegiatan, jenis: 'Presensi', status: r.status, catatan: r.catatan || '', rev: 0, _p: 1 }) - 1;
    });
    else if (k === 'kunjungan.create') { if (ia[x.id_absen] == null) ia[x.id_absen] = d.absensi.push({ id: x.id_absen, tgl: x.tanggal, jam: x.jam, id_siswa: x.id_siswa, id_wali: S.user.id, kegiatan: 'Kunjungan Khusus', jenis: 'Kunjungan', jenis_kunjungan: x.jenis_kunjungan, catatan: x.catatan, lat: x.lat, lng: x.lng, akurasi: x.akurasi, f1: x.nfoto > 0, f2: x.nfoto > 1, f3: x.nfoto > 2, rev: 0, _p: 1 }) - 1; }
    else if (k === 'absen.update') { var i = ia[x.id]; if (i != null) { var o = Object.assign({}, d.absensi[i], { _p: 1 }); if (x.status != null) o.status = x.status; if (x.catatan != null) o.catatan = x.catatan; d.absensi[i] = o; } }
    else if (k === 'bimbingan.create') { if (ib[x.id] == null) ib[x.id] = d.bimbingan.push({ id: x.id, tgl: x.tanggal, id_siswa: x.id_siswa, id_wali: S.user.id, kategori: x.topik_kategori, detail: x.topik_detail, catatan: x.catatan_progres, tl: x.tindak_lanjut, target: x.tgl_target_tl, status: x.tindak_lanjut ? 'Terbuka' : '', rev: 0, _p: 1 }) - 1; }
    else if (k === 'bimbingan.status' || k === 'bimbingan.update') { var j = ib[x.id]; if (j != null) { var b = Object.assign({}, d.bimbingan[j], { _p: 1 }); if (x.status_tl) { b.status = x.status_tl; if (x.status_tl === 'Selesai') { b.selesai = today(); b.evaluasi = x.catatan_evaluasi; } else b.selesai = ''; } if (x.catatan_progres != null) b.catatan = x.catatan_progres; if (x.tindak_lanjut != null) b.tl = x.tindak_lanjut; if (x.tgl_target_tl != null) b.target = x.tgl_target_tl; d.bimbingan[j] = b; } }
  });
  var by = {}; d.siswa.forEach(function (x) { by[x.id] = x; });
  S.d = d; S.by = by;
}
function pending() { return S.box.filter(function (i) { return i.st !== 'Ditolak' && i.st !== 'Konflik'; }).length; }
function problems() { return S.box.filter(function (i) { return i.st === 'Ditolak' || i.st === 'Konflik'; }); }
function enqueue(type, op, data, extra) {
  var it = Object.assign({ reqId: rid(), type: type, op: op, data: data, st: 'Menunggu', n: 0, ts: Date.now() }, extra || {});
  S.box.push(it); persist(); rebuild(); markDirty(); renderNow(); setSync(); schedSync(250); return it;
}
var tmS = null; function schedSync(ms) { clearTimeout(tmS); tmS = setTimeout(trySync, ms || 0); }
function trySync() {
  if (S.syncing || !S.tok || !S.online) { setSync(); return Promise.resolve(); }
  var items = S.box.filter(function (i) { return i.st === 'Menunggu' || i.st === 'Gagal'; });
  var data = items.filter(function (i) { return i.type !== 'foto'; }).slice(0, 50);
  S.syncing = true; setSync();
  var p = data.length ? call('sync.push', { items: data.map(function (i) { return { reqId: i.reqId, type: i.type, op: i.op, data: i.data, base_rev: i.base_rev }; }) }).then(function (r) {
    (r.hasil || []).forEach(function (h) {
      var it = S.box.filter(function (x) { return x.reqId === h.reqId; })[0]; if (!it) return;
      if (h.status === 'ok') { S.box = S.box.filter(function (x) { return x !== it; }); }
      else if (h.code === 'CONFLICT') { it.st = 'Konflik'; it.err = h.message; it.server = h.extra && h.extra.server; }
      else if (h.code === 'SERVER') { it.n++; it.st = it.n > 4 ? 'Ditolak' : 'Gagal'; it.err = h.message; it.kode = 'E-500'; }
      else { it.st = 'Ditolak'; it.err = h.message; it.kode = h.code === 'VALIDATION' ? 'E-422' : h.code; }
    });
    S.retry = 0;
  }) : Promise.resolve();
  return p.then(function () { return pushFoto(); }).then(function () { return pull(true); }).catch(function (e) {
    if (e && e.code === 'NET') { data.forEach(function (i) { if (i.st === 'Menunggu') i.st = 'Gagal'; i.n++; i.err = 'Jaringan'; i.kode = 'NET'; }); S.retry++; schedSync(Math.min(60000, 5000 * Math.pow(2, S.retry))); }
  }).then(function () { S.syncing = false; persist(); rebuild(); markDirty(); renderNow(); setSync(); });
}
function pushFoto() {
  var fs = S.box.filter(function (i) { return i.type === 'foto' && (i.st === 'Menunggu' || i.st === 'Gagal'); });
  var chain = Promise.resolve();
  fs.forEach(function (it) {
    chain = chain.then(function () {
      if (S.box.some(function (x) { return x.type === 'kunjungan' && x.data.id_absen === it.data.id_absen; })) return;
      return IDB.get(it.data.id_absen + '_' + it.data.n).then(function (img) {
        if (!img) { S.box = S.box.filter(function (x) { return x !== it; }); return; }
        return call('foto.upload', { id_absen: it.data.id_absen, n: it.data.n, data: img }, { timeout: 60000 }).then(function () { S.box = S.box.filter(function (x) { return x !== it; }); IDB.del(it.data.id_absen + '_' + it.data.n); }).catch(function (e) { if (e.code === 'NET') throw e; it.n++; it.err = e.message; it.st = (it.n > 3 || e.code === 'QUOTA' || e.code === 'VALIDATION') ? 'Ditolak' : 'Gagal'; it.kode = e.code; });
      });
    });
  });
  return chain;
}
function pull(silent) {
  if (!S.tok || !S.online) return Promise.resolve();
  return call('sync.pull', { ver: S.ver }).then(function (r) {
    if (r.tidak_berubah) { S.last = Date.now(); return; }
    ['siswa', 'absensi', 'bimbingan'].forEach(function (k) { if (r[k]) S.srv[k] = r[k]; });
    if (r.pengaturan) { S.srv.pengaturan = r.pengaturan; S.srv.wali = r.wali || S.srv.wali; }
    S.ver = r.ver; S.hari = r.hari_ini; S.last = Date.now(); persist(); rebuild(); markDirty(); if (!silent) renderNow();
  }).catch(function (e) { if (!silent && e.code === 'NET') toast('Offline — memakai data tersimpan.'); });
}
function setSync() {
  var el = $('#sync'); if (!el) return; var n = pending(), pr = problems().length, t;
  el.className = 'sync' + (!S.online ? ' off' : S.syncing ? ' busy' : '');
  t = !S.online ? 'Offline' : S.syncing ? 'Menyinkronkan…' : 'Online';
  var hm = S.last ? new Date(S.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  $('#sync-t').textContent = t + (hm && S.online && !S.syncing ? ' · ' + hm : '');
  var q = $('#sync-q'); q.hidden = !(n + pr); q.className = 'pill' + (pr ? ' bad' : ''); q.textContent = pr ? pr + ' bermasalah' : n + ' antre';
  var b = $('#bdg-lain'); if (b) { b.hidden = !pr; b.textContent = pr; }
  var dot = $('#bell-dot'); if (dot) dot.hidden = !(pr || attention().length);
}

/* ---------- Turunan data ---------- */
function activeTL() { return S.d.bimbingan.filter(function (b) { return b.tl && b.status !== 'Selesai' && b.status; }); }
function tlState(b) { if (b.status === 'Selesai') return 'ok'; var d = diff(b.target, today()); return d < 0 ? 'bad' : d <= 1 ? 'warn' : b.status === 'Proses' ? 'info' : ''; }
function tlLabel(b) { if (b.status === 'Selesai') return 'Selesai'; var d = diff(b.target, today()); return d < 0 ? 'Terlambat ' + (-d) + ' hari' : d === 0 ? 'Hari ini' : 'H-' + d; }
function sesToday() { var td = today(); return S.d.absensi.filter(function (a) { return a.tgl === td && a.jenis === 'Presensi'; }); }
function attention() {
  var o = [], td = today(), tt = sesToday();
  if (S.user && S.user.peran === 'WaliAsuh') {
    if (!tt.length && S.d.siswa.length) o.push({ ic: 'event_busy', t: 'Presensi hari ini belum dilakukan', s: S.d.siswa.length + ' siswa menunggu', go: 'absensi' });
    var late = activeTL().filter(function (b) { return diff(b.target, td) < 0; }).length; if (late) o.push({ ic: 'assignment_late', t: late + ' tindak lanjut terlambat', s: 'Segera tindaklanjuti', go: 'bimbingan' });
    var nc = S.d.siswa.filter(function (s) { return s.consent === 'Belum' || !s.consent; }).length; if (nc) o.push({ ic: 'shield', t: nc + ' siswa belum memiliki consent foto', s: 'Hubungi koordinator', go: 'siswa' });
  }
  return o;
}

/* ---------- Navigasi & render (show/hide, tanpa reload) ---------- */
var V = {}, AFTER = {}, dirty = {}, TAB_OF = { detail: 'siswa', kunjungan: 'beranda', bform: 'bimbingan', laporan: 'lainnya', perhatian: 'lainnya' };
var VIEWS = ['login', 'ganti', 'beranda', 'siswa', 'detail', 'absensi', 'kunjungan', 'bimbingan', 'bform', 'lainnya', 'laporan', 'perhatian', 'p'];
function markDirty() { VIEWS.forEach(function (v) { dirty[v] = 1; }); }
function renderView(v) {
  var el = $('#v-' + v); if (!el || !V[v]) return; var st = el.scrollTop;
  el.innerHTML = V[v](S.vp || {}); dirty[v] = 0; if (AFTER[v]) AFTER[v](el); el.scrollTop = st;
}
function renderNow() { if (S.view && dirty[S.view]) renderView(S.view); }
function go(v, p, push) {
  if (push !== false && S.view && S.view !== v && S.view !== 'login' && S.view !== 'ganti') S.stack.push({ v: S.view, p: S.vp });
  S.vp = p || {}; show(v);
}
function back() { var b = S.stack.pop(); if (b) { S.vp = b.p; show(b.v); } else go(S.user && S.user.peran === 'WaliAsuh' ? 'beranda' : 'p', {}, false); }
function show(v) {
  if (S.view === 'kunjungan' && v !== 'kunjungan') stopCam();
  S.view = v; $$('.view').forEach(function (e) { e.classList.toggle('on', e.id === 'v-' + v); });
  if (dirty[v] !== 0 || TAKE_FRESH[v]) renderView(v);
  var tab = TAB_OF[v] || v; $$('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.go === tab); t.setAttribute('aria-current', t.dataset.go === tab ? 'page' : 'false'); });
  var m = $('#v-' + v); if (m && !TAKE_FRESH[v]) m.scrollTop = m.scrollTop;
  var inApp = v !== 'login' && v !== 'ganti'; $('#hdr').hidden = !inApp; $('#dock').hidden = !inApp;
  var fab = v === 'bimbingan'; $('#fab').hidden = !fab;
  closeSheet(); setSync();
}
var TAKE_FRESH = { detail: 1, bform: 1, kunjungan: 1, laporan: 1, perhatian: 1, ganti: 1, login: 1, absensi: 1, lainnya: 1, p: 1, bimbingan: 0 };
function vh(t, bk, right) { return '<div class="row" style="margin-bottom:12px">' + (bk ? '<button class="ib" data-act="back" aria-label="Kembali">' + ic('arrow_back') + '</button>' : '') + '<h2 style="flex:1;font-size:20px">' + esc(t) + '</h2>' + (right || '') + '</div>'; }
function empty(i, t, s) { return '<div class="empty">' + ic(i) + '<p class="b">' + esc(t) + '</p>' + (s ? '<p class="sm">' + esc(s) + '</p>' : '') + '</div>'; }
function stPill(s) { return s ? pill(s, ST_CLS[s]) : pill('—', 'mut'); }

/* ---------- Login ---------- */
V.login = function () {
  var P = S.srv.pengaturan || {};
  return '<div class="login-h"><div class="logo">' + ic('diversity_3', 'l') + '</div><h1>e-SIM Wali Asuh SR</h1><p>' + esc(P.nama_lembaga || 'Sekolah Rakyat') + '</p></div>' +
    '<form class="card" id="f-login" autocomplete="on" novalidate><h3 style="font-size:20px">Masuk</h3><p class="mut sm" style="margin:0 0 4px">Gunakan akun yang diberikan koordinator.</p>' +
    '<label class="f" for="lg-email">Email</label><input class="in" id="lg-email" type="email" inputmode="email" autocomplete="username" placeholder="nama@sekolah.id">' +
    '<label class="f" for="lg-pass">Kata sandi</label><div style="position:relative"><input class="in" id="lg-pass" type="password" autocomplete="current-password" style="padding-right:52px"><button type="button" class="ib" data-act="eye" style="position:absolute;right:2px;top:2px" aria-label="Tampilkan sandi">' + ic('visibility') + '</button></div>' +
    '<div class="ferr" id="lg-err" role="alert" hidden></div><div class="sp16"></div><button class="btn cta" id="lg-btn" type="submit">Masuk</button></form>' +
    '<p class="mut xs" style="text-align:center">Lupa sandi? Hubungi Admin untuk reset.</p>';
};
V.ganti = function () {
  return '<div class="login-h"><div class="logo">' + ic('lock_reset', 'l') + '</div><h1>Ganti Kata Sandi</h1><p>Wajib sebelum melanjutkan</p></div>' +
    '<form class="card" id="f-ganti" novalidate><label class="f" for="gp-lama">Kata sandi saat ini</label><input class="in" id="gp-lama" type="password" autocomplete="current-password">' +
    '<label class="f" for="gp-baru">Kata sandi baru</label><input class="in" id="gp-baru" type="password" autocomplete="new-password"><div class="xs mut" style="margin-top:4px">Minimal 8 karakter, memuat huruf dan angka.</div>' +
    '<label class="f" for="gp-ulang">Ulangi kata sandi baru</label><input class="in" id="gp-ulang" type="password" autocomplete="new-password">' +
    '<div class="ferr" id="gp-err" role="alert" hidden></div><div class="sp16"></div><div class="row">' + (S.user && S.user.must_change ? '' : '<button class="btn" type="button" data-act="back">Batal</button>') + '<button class="btn cta" id="gp-btn" type="submit">Simpan &amp; Lanjut</button></div></form>';
};

/* ---------- Beranda ---------- */
V.beranda = function () {
  var u = S.user, d = S.d, td = today(), tt = sesToday(), hs = {}; tt.forEach(function (a) { if (a.status === 'Hadir' || a.status === 'Terlambat') hs[a.id_siswa] = 1; });
  var nh = Object.keys(hs).length, n = d.siswa.length, tl = activeTL(), late = tl.filter(function (b) { return diff(b.target, td) < 0; });
  var asr = ((d.siswa[0] && d.siswa[0].kamar) || '').split(' / ')[0] || (S.srv.pengaturan.nama_unit || '');
  var att = attention(), pr = problems().length, dueAll = tl.filter(function (b) { return diff(b.target, td) <= 3; }).sort(function (a, b) { return a.target < b.target ? -1 : 1; }).slice(0, 4);
  if (pr) att.push({ ic: 'sync_problem', t: pr + ' data gagal terkirim', s: 'Periksa dan kirim ulang', go: 'perhatian' });
  return '<section class="hero"><div class="row w">' + (asr ? '<span class="chip">' + ic('apartment', 's') + esc(asr) + '</span>' : '') + '<span class="chip">' + ic('wb_twilight', 's') + greet() + '</span></div><h2>Halo, ' + esc(nick(u.nama)) + '</h2><p>' + fTgl(td, 'long') + '</p></section>' +
    '<div class="grid2"><button class="stat fill" data-act="go" data-v="siswa">' + ic('groups') + '<div class="v">' + n + '</div><div class="l">Siswa Binaan</div></button>' +
    '<button class="stat" data-act="go" data-v="absensi">' + ic('how_to_reg') + '<div class="v">' + (tt.length ? nh + '/' + n : '—') + '</div><div class="l">Hadir Hari Ini</div></button>' +
    '<button class="stat" data-act="go" data-v="bimbingan">' + ic('assignment') + '<div class="v">' + tl.length + '</div><div class="l">TL Aktif</div></button>' +
    '<button class="stat' + (late.length ? ' red' : '') + '" data-act="go" data-v="bimbingan" data-fil="terlambat">' + ic('alarm') + '<div class="v">' + late.length + '</div><div class="l">TL Terlambat</div></button></div>' +
    '<button class="btn cta" data-act="go" data-v="absensi">' + ic('how_to_reg') + 'Mulai Absensi Hari Ini</button><div class="sp8"></div>' +
    '<div class="row"><button class="btn sm" data-act="newb">' + ic('edit_note') + 'Catat Bimbingan</button><button class="btn sm" data-act="go" data-v="kunjungan">' + ic('home_pin') + 'Kunjungan Khusus</button></div>' +
    (att.length ? '<div class="sec">Perlu Perhatian (' + att.length + ' Item)</div><div class="card flat" style="padding:4px 12px">' + att.slice(0, 4).map(function (a) { return '<button class="item" style="border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0;padding:12px 0;background:none" data-act="go" data-v="' + a.go + '">' + ic(a.ic) + '<span class="m"><b>' + esc(a.t) + '</b><small>' + esc(a.s) + '</small></span>' + ic('chevron_right') + '</button>'; }).join('') + '</div>' : '') +
    '<div class="sec">Tindak Lanjut Jatuh Tempo</div>' + (dueAll.length ? dueAll.map(tlCard).join('') + '<button class="btn sm" data-act="go" data-v="bimbingan">Lihat Semua</button>' : empty('task_alt', 'Tidak ada TL yang jatuh tempo', 'Kerja bagus!')) + '<div class="pad-b"></div>';
};
function tlCard(b) {
  var s = S.by[b.id_siswa] || {}, c = tlState(b);
  return '<button class="item edge ' + c + '" data-act="tl" data-id="' + esc(b.id) + '"><span class="ava">' + esc(ini(s.nama)) + '</span><span class="m"><b>' + esc(s.nama || b.id_siswa) + '</b><small>' + esc(b.tl) + '</small><small>' + esc(b.kategori) + ' · target ' + fTgl(b.target) + (b._p ? ' · menunggu sinkron' : '') + '</small></span>' + pill(tlLabel(b), c === 'bad' ? 'bad' : c === 'ok' ? 'ok' : c === 'info' ? 'info' : '') + '</button>';
}

/* ---------- Siswa ---------- */
function listSiswa() {
  var q = S.q.toLowerCase(), td = today(), tt = sesToday(), m = {}; tt.forEach(function (a) { m[a.id_siswa] = a.status; });
  var r = S.d.siswa.filter(function (s) { return !q || (s.nama + ' ' + s.nis + ' ' + s.kelas + ' ' + s.kamar).toLowerCase().indexOf(q) >= 0; });
  if (!r.length) return empty('search_off', 'Tidak ada siswa', q ? 'Coba kata kunci lain.' : 'Belum ada siswa binaan.');
  return r.map(function (s) { var n = activeTL().filter(function (b) { return b.id_siswa === s.id; }).length; return '<button class="item" data-act="detail" data-id="' + esc(s.id) + '"><span class="ava">' + esc(ini(s.nama)) + '</span><span class="m"><b>' + esc(s.nama) + '</b><small>' + esc(s.kelas) + ' · ' + esc((s.kamar || '').replace(/^.*\/\s*/, 'Kamar ')) + '</small></span>' + (n ? pill(n + ' TL', 'info') : '') + stPill(m[s.id]) + '</button>'; }).join('');
}
V.siswa = function () {
  return '<div style="position:relative;margin-bottom:12px"><span class="ms" style="position:absolute;left:12px;top:12px;color:var(--mut)">search</span><input id="q" data-in="q" class="in" style="padding-left:44px" placeholder="Cari nama, NIS, kelas…" value="' + esc(S.q) + '"></div><div class="xs mut" style="margin:0 4px 8px">' + S.d.siswa.length + ' siswa binaan</div><div id="siswa-list">' + listSiswa() + '</div>';
};
V.detail = function (p) {
  var s = S.by[p.id]; if (!s) return vh('Siswa', true) + empty('person_off', 'Siswa tidak ditemukan');
  var td = today(), dari = addD(td, -30), ab = S.d.absensi.filter(function (a) { return a.id_siswa === s.id && a.jenis === 'Presensi' && a.tgl >= dari; });
  var hd = ab.filter(function (a) { return a.status === 'Hadir' || a.status === 'Terlambat'; }).length, pc = ab.length ? Math.round(hd * 100 / ab.length) : null;
  var bm = S.d.bimbingan.filter(function (b) { return b.id_siswa === s.id; }).sort(function (a, b) { return a.tgl < b.tgl ? 1 : -1; });
  return vh('Detail Siswa', true) + '<div class="card"><div class="row" style="gap:14px"><span class="ava" style="width:60px;height:60px;font-size:20px">' + esc(ini(s.nama)) + '</span><div><h3 style="font-size:18px">' + esc(s.nama) + '</h3><div class="mut sm">' + esc(s.id) + ' · NIS ' + esc(s.nis || '-') + '</div><div class="mut sm">' + esc(s.kelas) + ' · ' + esc(s.kamar) + '</div></div></div>' +
    '<div class="sp12"></div><div class="row w">' + pill('Consent: ' + (s.consent || 'Belum'), s.consent === 'Disetujui' ? 'ok' : 'bad') + pill('Kehadiran 30 hari: ' + (pc == null ? '—' : pc + '%'), pc != null && pc < 80 ? 'bad' : 'ok') + '</div>' +
    '<div class="sp12"></div><div class="sm"><b>Wali murid:</b> ' + esc(s.wali_murid || '-') + (s.kontak ? ' · <a href="tel:' + esc(s.kontak) + '">' + esc(s.kontak) + '</a>' : '') + '</div></div>' +
    '<div class="row"><button class="btn sm" data-act="newb" data-id="' + esc(s.id) + '">' + ic('edit_note') + 'Catat Bimbingan</button><button class="btn sm" data-act="kj" data-id="' + esc(s.id) + '">' + ic('home_pin') + 'Kunjungan</button></div><div class="sp8"></div>' +
    '<button class="btn sm" data-act="lap" data-id="' + esc(s.id) + '">' + ic('description') + 'Laporan Individu</button>' +
    '<div class="sec">Riwayat Bimbingan</div>' + (bm.length ? bm.slice(0, 8).map(function (b) { return '<div class="card flat"><div class="row"><b class="hd" style="flex:1">' + esc(b.kategori) + '</b><span class="xs mut">' + fTgl(b.tgl, 'mid') + '</span></div><p class="sm" style="margin:6px 0">' + esc(b.catatan) + '</p>' + (b.tl ? '<div class="row w">' + pill('TL: ' + b.status, b.status === 'Selesai' ? 'ok' : '') + '<span class="xs mut">' + esc(b.tl) + '</span></div>' : '') + '</div>'; }).join('') : empty('forum', 'Belum ada catatan bimbingan')) +
    '<div class="sec">Presensi Terakhir</div>' + (ab.length ? '<div class="card flat">' + ab.sort(function (a, b) { return a.tgl < b.tgl ? 1 : -1; }).slice(0, 8).map(function (a) { return '<div class="row" style="padding:4px 0"><span class="sm" style="flex:1">' + fTgl(a.tgl, 'mid') + ' · ' + esc(a.kegiatan) + '</span>' + stPill(a.status) + '</div>'; }).join('') + '</div>' : empty('event', 'Belum ada presensi'));
};

/* ---------- Absensi ---------- */
var SS = ['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Tidak Hadir'], SL = { 'Hadir': 'Hadir', 'Terlambat': 'T', 'Izin': 'Izin', 'Sakit': 'Sakit', 'Tidak Hadir': 'Alpa' };
function sesKey(a) { return a.tgl + '|' + a.kegiatan + '|' + a.id_siswa; }
function sesLoad() {
  var s = S.ses, ex = {}; S.d.absensi.forEach(function (a) { if (a.jenis === 'Presensi') ex[sesKey(a)] = a; });
  s.ex = {}; s.st = {}; s.cat = {};
  S.d.siswa.forEach(function (x) { var a = ex[s.tgl + '|' + s.kegiatan + '|' + x.id]; if (a) { s.ex[x.id] = a; s.st[x.id] = a.status; s.cat[x.id] = a.catatan || ''; } else s.st[x.id] = s.all ? 'Hadir' : ''; });
}
function sesInit() {
  var P = S.srv.pengaturan || {}; if (!S.ses) { S.ses = { id: 'SES-' + rid(), tgl: today(), jam: nowHM(), kegiatan: (P.kegiatan || [])[0] || '', all: true }; }
  if (!S.ses.kegiatan) S.ses.kegiatan = (P.kegiatan || [])[0] || '';
  sesLoad();
}
V.absensi = function () {
  if (!S.ses || !S.ses.st) sesInit();
  var s = S.ses, P = S.srv.pengaturan || {}, c = {}; SS.forEach(function (k) { c[k] = 0; }); S.d.siswa.forEach(function (x) { if (s.st[x.id]) c[s.st[x.id]]++; });
  var kosong = S.d.siswa.filter(function (x) { return !s.st[x.id]; }).length, sudah = Object.keys(s.ex).length, old = diff(today(), s.tgl) > 3;
  var g = S.gps;
  return vh('Presensi') + '<div class="row w" style="margin-bottom:12px"><span class="pill info">' + ic('schedule', 's') + 'Presensi Terjadwal</span><span class="pill ok">' + ic('touch_app', 's') + 'Target ≤3 Ketuk</span>' + (sudah ? '<span class="pill">Sesi ini sudah ada (' + sudah + ')</span>' : '') + '</div>' +
    '<div class="card"><div class="row"><div style="flex:1"><label class="f" style="margin-top:0" for="ab-tgl">Tanggal</label><input class="in" type="date" id="ab-tgl" data-in="ab-tgl" max="' + today() + '" value="' + esc(s.tgl) + '"></div><div style="flex:1"><label class="f" style="margin-top:0" for="ab-jam">Jam</label><input class="in" type="time" id="ab-jam" data-in="ab-jam" value="' + esc(s.jam) + '"></div></div>' +
    '<label class="f" for="ab-keg">Kegiatan</label><select class="in" id="ab-keg" data-in="ab-keg">' + (P.kegiatan || []).map(function (k) { return '<option' + (k === s.kegiatan ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select>' +
    (old ? '<label class="f" for="ab-alasan">Alasan input terlambat (&gt;3 hari)</label><input class="in" id="ab-alasan" data-in="ab-alasan" value="' + esc(s.alasan || '') + '" maxlength="200">' : '') + '</div>' +
    '<div class="card flat row" id="gps-card">' + ic('my_location') + '<div style="flex:1"><b class="sm">Lokasi GPS</b><div class="xs mut">' + (g && g.ok ? esc(g.lat) + ', ' + esc(g.lng) + ' · akurasi ' + g.acc + ' m' : g && g.err ? 'Tidak tersedia (' + esc(g.err) + ')' : 'Mencari lokasi…') + '</div></div>' + (g && g.ok ? pill('Aktif', 'ok') : pill(g && g.err ? 'Nonaktif' : '…', 'mut')) + '</div>' +
    '<div class="card flat row"><div style="flex:1"><b class="sm">Tandai Semua Hadir</b><div class="xs mut">Lalu ubah hanya yang tidak hadir</div></div><label class="sw"><input type="checkbox" data-act="allhadir"' + (s.all ? ' checked' : '') + ' aria-label="Tandai semua hadir"><i></i></label></div>' +
    S.d.siswa.map(function (x) {
      var st = s.st[x.id]; return '<div class="arow" data-sid="' + esc(x.id) + '"><div class="top"><span class="ava" style="width:38px;height:38px;font-size:13px">' + esc(ini(x.nama)) + '</span><div style="flex:1;min-width:0"><b class="hd" style="font-size:14px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.nama) + '</b><span class="xs mut">' + esc(x.kelas) + '</span></div></div><div class="sg" role="group" aria-label="Status ' + esc(x.nama) + '">' +
        SS.map(function (k) { return '<button data-act="st" data-id="' + esc(x.id) + '" data-s="' + k + '" class="' + (st === k ? 'on' : '') + '" aria-pressed="' + (st === k) + '">' + SL[k] + '</button>'; }).join('') + '</div>' +
        (st === 'Izin' || st === 'Sakit' || st === 'Tidak Hadir' ? '<input class="in" style="margin-top:8px;min-height:44px" data-in="cat" data-id="' + esc(x.id) + '" maxlength="300" placeholder="Keterangan ' + (st === 'Tidak Hadir' ? '(opsional)' : '(wajib)') + '" value="' + esc(s.cat[x.id] || '') + '">' : '') + '</div>';
    }).join('') +
    '<div class="row w" style="margin-top:8px">' + SS.map(function (k) { return pill(SL[k === 'Terlambat' ? 'Terlambat' : k].replace('T', 'Terlambat') + ' ' + c[k], ST_CLS[k]); }).join('') + '</div>' +
    '<div class="savebar">' + (kosong ? '<div class="ferr" style="margin:0 0 6px">' + kosong + ' siswa belum dipilih statusnya</div>' : '') + '<button class="btn cta" data-act="savesesi"' + (S.d.siswa.length ? '' : ' disabled') + '>' + ic('save') + (sudah ? 'Perbarui Sesi Absensi' : 'Simpan Sesi Absensi') + ' (' + S.d.siswa.length + ' Siswa)</button></div>';
};
AFTER.absensi = function () { if (!S.gps) getGPS(); };
function getGPS(cb) {
  S.gps = null; if (!navigator.geolocation) { S.gps = { err: 'tidak didukung' }; return; }
  navigator.geolocation.getCurrentPosition(function (p) { S.gps = { ok: 1, lat: p.coords.latitude.toFixed(5), lng: p.coords.longitude.toFixed(5), acc: Math.round(p.coords.accuracy) }; gpsUI(); cb && cb(); }, function (e) { S.gps = { err: e.code === 1 ? 'izin ditolak' : 'gagal' }; gpsUI(); cb && cb(); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function gpsUI() { var g = S.gps, c = $('#gps-card'); if (c) c.querySelector('.xs').textContent = g && g.ok ? g.lat + ', ' + g.lng + ' · akurasi ' + g.acc + ' m' : g && g.err ? 'Tidak tersedia (' + g.err + ')' : 'Mencari lokasi…'; var k = $('#kj-gps'); if (k) k.innerHTML = kjGps(); }

/* ---------- Bimbingan (TL) ---------- */
V.bimbingan = function () {
  var td = today(), all = S.d.bimbingan.filter(function (b) { return b.tl && b.status; }), cnt = { Terbuka: 0, Proses: 0, Selesai: 0 }; all.forEach(function (b) { cnt[b.status]++; });
  var f = S.tlFil, r = all.filter(function (b) { return b.status === S.tlSeg; });
  if (f === 'terlambat') r = r.filter(function (b) { return diff(b.target, td) < 0; }); else if (f === 'minggu') r = r.filter(function (b) { var d = diff(b.target, td); return d >= 0 && d <= 7; });
  r.sort(function (a, b) { return S.tlSort === 'tenggat' ? (a.target < b.target ? -1 : 1) : (a.tgl < b.tgl ? 1 : -1); });
  var chip = function (k, t) { return '<button class="fc' + (f === k ? ' on' : '') + '" data-act="tlfil" data-k="' + k + '">' + t + '</button>'; };
  return vh('Tindak Lanjut') + '<div class="hs">' + chip('semua', 'Semua') + chip('terlambat', 'Terlambat') + chip('minggu', '7 Hari Ke Depan') + '<button class="fc" data-act="tlsort">' + ic('swap_vert', 's') + (S.tlSort === 'tenggat' ? 'Tenggat terdekat' : 'Terbaru') + '</button></div>' +
    '<div class="seg" role="tablist">' + ['Terbuka', 'Proses', 'Selesai'].map(function (k) { return '<button role="tab" class="' + (S.tlSeg === k ? 'on' : '') + '" data-act="tlseg" data-k="' + k + '">' + k + ' (' + cnt[k] + ')</button>'; }).join('') + '</div>' +
    (r.length ? r.map(tlCard).join('') : empty('assignment_turned_in', 'Tidak ada TL ' + S.tlSeg.toLowerCase(), 'Gunakan tombol Catat TL Baru.')) + '<div style="height:80px"></div>';
};
function tlSheet(id) {
  var b = S.d.bimbingan.filter(function (x) { return x.id === id; })[0]; if (!b) return; var s = S.by[b.id_siswa] || {}, c = tlState(b);
  sheet('<h3>' + esc(s.nama) + '</h3><div class="row w" style="margin:6px 0 12px">' + pill(b.kategori, 'info') + pill(b.status, b.status === 'Selesai' ? 'ok' : '') + pill(tlLabel(b), c === 'bad' ? 'bad' : '') + '</div>' +
    '<div class="sec" style="margin-top:0">Tindak lanjut</div><p style="margin:0">' + esc(b.tl) + '</p><div class="xs mut">Target ' + fTgl(b.target, 'mid') + '</div>' +
    '<div class="sec">Catatan progres · ' + fTgl(b.tgl, 'mid') + '</div><p class="sm" style="margin:0">' + esc(b.catatan) + '</p>' + (b.evaluasi ? '<div class="sec">Evaluasi</div><p class="sm" style="margin:0">' + esc(b.evaluasi) + '</p>' : '') + '<div class="sp16"></div>' +
    '<div class="row">' + (b.status === 'Terbuka' ? '<button class="btn sm" data-act="tlproses" data-id="' + esc(b.id) + '">Mulai Proses</button>' : '') + (b.status !== 'Selesai' ? '<button class="btn sm pri" data-act="tlselesai" data-id="' + esc(b.id) + '">' + ic('check_circle') + 'Selesaikan</button>' : '<button class="btn sm" data-act="tlbuka" data-id="' + esc(b.id) + '">Buka Kembali</button>') + '</div><div class="sp8"></div><button class="btn sm" data-act="close">Tutup</button>');
}
function tlDone(id) {
  var b = S.d.bimbingan.filter(function (x) { return x.id === id; })[0], s = S.by[b.id_siswa] || {};
  sheet('<h3>Konfirmasi Penyelesaian TL</h3><p class="mut sm" style="margin:0 0 4px">' + esc(s.nama) + ' — ' + esc(b.tl) + '</p><label class="f" for="ev">Catatan evaluasi (wajib)</label><textarea class="in" id="ev" maxlength="500" data-in="cnt" data-c="ev-c" placeholder="Apa hasil dari tindak lanjut ini?"></textarea><div class="cnt" id="ev-c">0/500</div><div class="sp12"></div><div class="row"><button class="btn sm" data-act="close">Batal</button><button class="btn sm pri" data-act="tldone2" data-id="' + esc(id) + '">Konfirmasi Selesai</button></div>');
}

/* ---------- Form bimbingan ---------- */
V.bform = function (p) {
  var f = S.bf = S.bf || { topik: '', id: p.id || '' }; if (p.id && !f.id) f.id = p.id;
  var P = S.srv.pengaturan || {}, td = today();
  return vh('Catat Bimbingan', true) + '<div class="stepper" aria-hidden="true"><div class="s on" id="stp1"><b>1</b>Identitas</div><hr><div class="s" id="stp2"><b>2</b>Catatan</div><hr><div class="s" id="stp3"><b>3</b>Target TL</div></div>' +
    '<div class="card"><label class="f" style="margin-top:0" for="bf-s">Siswa</label><select class="in" id="bf-s" data-in="stp"><option value="">Pilih siswa…</option>' + S.d.siswa.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === f.id ? ' selected' : '') + '>' + esc(s.nama) + ' — ' + esc(s.kelas) + '</option>'; }).join('') + '</select>' +
    '<label class="f" for="bf-t">Tanggal bimbingan</label><input class="in" type="date" id="bf-t" max="' + td + '" value="' + td + '"></div>' +
    '<div class="card"><label class="f" style="margin-top:0">Topik</label><div class="chips" id="bf-topik">' + (P.topik || []).map(function (t) { return '<button type="button" class="fc' + (f.topik === t ? ' on' : '') + '" data-act="topik" data-k="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div>' +
    '<label class="f" for="bf-d">Detail topik (opsional)</label><input class="in" id="bf-d" maxlength="200">' +
    '<label class="f" for="bf-c">Catatan progres</label><textarea class="in" id="bf-c" maxlength="2000" data-in="cnt" data-c="bf-cc" placeholder="Tuliskan perkembangan dan hasil percakapan…"></textarea><div class="cnt" id="bf-cc">0/2000</div></div>' +
    '<div class="card"><label class="f" style="margin-top:0" for="bf-tl">Tindak lanjut (opsional)</label><textarea class="in" id="bf-tl" style="min-height:80px" maxlength="500" data-in="cnt" data-c="bf-tc" placeholder="Langkah yang akan dilakukan"></textarea><div class="cnt" id="bf-tc">0/500</div>' +
    '<label class="f" for="bf-g">Tanggal target TL</label><input class="in" type="date" id="bf-g" min="' + td + '" value="' + addD(td, 7) + '">' +
    '<div class="row" style="margin-top:14px"><div style="flex:1"><b class="sm">Pengingat Telegram</b><div class="xs mut">' + (S.user.telegram ? 'Terhubung — pengingat harian jatuh tempo' : 'Belum terhubung. Hubungkan di menu Lainnya.') + '</div></div><label class="sw"><input type="checkbox" data-act="tgtoggle"' + (S.user.telegram ? ' checked' : '') + ' aria-label="Pengingat Telegram"><i></i></label></div></div>' +
    '<div class="ferr" id="bf-err" role="alert" hidden></div><div class="row"><button class="btn" data-act="back">Batal</button><button class="btn cta" data-act="savebf">' + ic('save') + 'Simpan Catatan</button></div><div class="pad-b"></div>';
};

/* ---------- Kunjungan khusus ---------- */
function kjGps() { var g = S.gps; return ic('location_on') + '<div style="flex:1"><b class="sm">' + (g && g.ok ? esc(g.lat) + ', ' + esc(g.lng) : 'Mencari lokasi…') + '</b><div class="xs mut">' + (g && g.ok ? 'Akurasi ' + g.acc + ' m' : g && g.err ? 'GPS: ' + esc(g.err) : 'Mohon izinkan lokasi') + '</div></div>' + (g && g.ok ? pill('Terkunci', 'ok') : pill('Menunggu', 'mut')); }
V.kunjungan = function (p) {
  var k = S.kj; if (p.id) k.id = p.id; var P = S.srv.pengaturan || {}, max = P.batas_foto || 3;
  return vh('Kunjungan Khusus', true) + '<div class="row w" style="margin-bottom:12px"><span class="pill ok">' + ic('my_location', 's') + 'Geotagging Aktif</span><span class="pill info">' + ic('photo_camera', 's') + 'Foto Langsung</span></div>' +
    '<div class="card"><label class="f" style="margin-top:0" for="kj-s">Siswa</label><select class="in" id="kj-s"><option value="">Pilih siswa…</option>' + S.d.siswa.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === k.id ? ' selected' : '') + '>' + esc(s.nama) + ' — ' + esc(s.kelas) + '</option>'; }).join('') + '</select>' +
    '<label class="f">Jenis kunjungan</label><div class="chips">' + ['Kunjungan Rumah', 'Rumah Sakit', 'Sekolah', 'Lainnya'].map(function (t) { return '<button type="button" class="fc' + (k.jenis === t ? ' on' : '') + '" data-act="kjjenis" data-k="' + t + '">' + t + '</button>'; }).join('') + '</div></div>' +
    '<div class="card flat row" id="kj-gps">' + kjGps() + '</div>' +
    '<div class="cam" id="cam"><video id="camv" playsinline muted autoplay></video><div id="cam-msg" class="sm" style="position:absolute;padding:20px;text-align:center" hidden></div></div>' +
    '<div class="row" style="margin-top:8px"><button class="btn sm pri" data-act="shoot" id="shootb">' + ic('photo_camera') + 'Ambil Foto</button><button class="btn sm" data-act="redo">' + ic('restart_alt') + 'Ulangi</button></div><input type="file" id="camf" accept="image/*" capture="environment" hidden>' +
    '<div class="slots" id="slots">' + slotsHtml(max) + '</div><div class="xs mut" style="margin-top:6px">Foto otomatis diberi cap lokasi &amp; waktu. Maks. ' + max + ' foto.</div>' +
    '<label class="f" for="kj-c">Catatan</label><textarea class="in" id="kj-c" maxlength="500" style="min-height:80px"></textarea><div class="ferr" id="kj-err" role="alert" hidden></div><div class="sp12"></div>' +
    '<div class="row"><button class="btn" data-act="back">Batal</button><button class="btn cta" data-act="savekj">' + ic('save') + 'Simpan Kunjungan</button></div><div class="pad-b"></div>';
};
function slotsHtml(max) { var f = S.kj.fotos, h = ''; for (var i = 0; i < max; i++) h += '<div class="slot">' + (f[i] ? '<img alt="Foto ' + (i + 1) + '" src="' + f[i] + '"><button class="x" data-act="delfoto" data-i="' + i + '" aria-label="Hapus foto">×</button>' : '<span class="xs">' + (i + 1) + '/' + max + '</span>') + '</div>'; return h; }
AFTER.kunjungan = function () { if (!S.gps) getGPS(); startCam(); };
var cam = { stream: null };
function startCam() {
  var v = $('#camv'); if (!v) return;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return camFb();
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }).then(function (s) { stopCam(); cam.stream = s; v.srcObject = s; var m = $('#cam-msg'); if (m) m.hidden = true; var pl = v.play(); if (pl && pl.catch) pl.catch(function () {}); }).catch(camFb);
}
function stopCam() { if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; } }
function camFb() { S.kj.fb = true; var m = $('#cam-msg'); if (m) { m.hidden = false; m.textContent = 'Kamera langsung tidak tersedia. Tekan “Ambil Foto” untuk memakai kamera perangkat.'; } }
function wmText() {
  var s = S.by[val('kj-s')] || {}, g = S.gps, init = String(s.nama || '').split(/\s+/).map(function (x) { return x[0] ? x[0].toUpperCase() + '.' : ''; }).join('');
  return ['ID: ' + (s.id || '-') + ' | ' + init + ' (' + (s.kelas || '-') + ') | ' + (g && g.ok ? g.lat + ', ' + g.lng + ' · Acc: ' + g.acc + 'm' : 'GPS tidak tersedia'), today() + ' ' + nowHM() + ' | e-SIM Wali Asuh SR'];
}
function shootFrom(src) {
  var W = 1280, w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight; if (!w) return toast('Kamera belum siap.', 'bad');
  var r = Math.min(1, W / w), c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r); var x = c.getContext('2d'); x.drawImage(src, 0, 0, c.width, c.height);
  var L = wmText(), fs = Math.max(14, Math.round(c.width / 46)), bh = fs * 3.1; x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, c.height - bh, c.width, bh); x.fillStyle = '#fff'; x.font = '500 ' + fs + 'px sans-serif'; x.textBaseline = 'top';
  x.fillText(L[0], fs * .6, c.height - bh + fs * .45); x.fillText(L[1], fs * .6, c.height - bh + fs * 1.6);
  var q = .82, d; do { d = c.toDataURL('image/jpeg', q); q -= .08; } while (d.length * .75 > 580000 && q > .3); return d;
}

/* ---------- Lainnya ---------- */
V.lainnya = function () {
  var u = S.user, pr = problems().length, row = function (i, t, s, act, extra) { return '<button class="item" data-act="' + act + '">' + ic(i) + '<span class="m"><b>' + t + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</span>' + (extra || ic('chevron_right')) + '</button>'; };
  var sw = function (a, on, l) { return '<label class="sw"><input type="checkbox" data-act="' + a + '"' + (on ? ' checked' : '') + ' aria-label="' + l + '"><i></i></label>'; };
  return vh('Lainnya') + '<div class="card row" style="gap:14px"><span class="ava" style="width:56px;height:56px;font-size:18px">' + esc(ini(u.nama)) + '</span><div><b class="hd">' + esc(u.nama) + '</b><div class="mut sm">' + esc(u.email) + '</div>' + pill(u.peran === 'WaliAsuh' ? 'Wali Asuh' : u.peran, 'ok') + '</div></div>' +
    '<div class="sec">Menu</div>' + row('description', 'Laporan', 'Lembar individu &amp; rekap bulanan', 'golap') + row('sync_problem', 'Perlu Perhatian', pr ? pr + ' data bermasalah' : 'Antrean sinkron &amp; galat', 'goperh', pr ? pill(String(pr), 'bad') : ic('chevron_right')) +
    row('send', 'Hubungkan Telegram', u.telegram ? 'Terhubung' : 'Belum terhubung — pengingat TL', 'tgpair', u.telegram ? pill('Aktif', 'ok') : ic('chevron_right')) +
    '<div class="sec">Tampilan</div><div class="item" style="cursor:default">' + ic('bolt') + '<span class="m"><b>Mode Hemat</b><small>Tanpa efek blur &amp; animasi (HP lawas)</small></span>' + sw('hemat', S.pref.hemat, 'Mode hemat') + '</div>' +
    '<div class="item" style="cursor:default">' + ic('dark_mode') + '<span class="m"><b>Tema Gelap</b></span>' + sw('dark', S.pref.dark, 'Tema gelap') + '</div>' +
    '<div class="sec">Akun</div>' + row('lock', 'Ganti Kata Sandi', '', 'gantipw') + row('logout', 'Keluar', '', 'logout') +
    '<p class="mut xs" style="text-align:center;margin-top:20px">e-SIM Wali Asuh SR v' + CLIENT_V + '<br>' + esc((S.srv.pengaturan || {}).nama_lembaga || '') + '</p>';
};

/* ---------- Laporan ---------- */
function lapInit() { var L = S.lap, td = today(); if (!L.dari) { L.dari = td.slice(0, 8) + '01'; L.sampai = td; L.bulan = td.slice(0, 7); } if (!L.id && S.d.siswa[0]) L.id = S.d.siswa[0].id; }
function lapData(id, dari, sampai) {
  var s = S.by[id]; if (!s) return null;
  var ab = S.d.absensi.filter(function (a) { return a.id_siswa === id && a.jenis === 'Presensi' && a.tgl >= dari && a.tgl <= sampai; }), c = { Hadir: 0, Terlambat: 0, Izin: 0, Sakit: 0, 'Tidak Hadir': 0 }; ab.forEach(function (a) { if (c[a.status] != null) c[a.status]++; });
  var bm = S.d.bimbingan.filter(function (b) { return b.id_siswa === id && b.tgl >= dari && b.tgl <= sampai; }).sort(function (a, b) { return a.tgl < b.tgl ? -1 : 1; });
  var w = S.srv.wali.filter(function (x) { return x.id === s.id_wali; })[0];
  return { s: s, c: c, n: ab.length, bm: bm, dari: dari, sampai: sampai, wali: w ? w.nama : S.user.nama, pct: ab.length ? Math.round((c.Hadir + c.Terlambat) * 100 / ab.length) : 0 };
}
function paperHtml(D) {
  var P = S.srv.pengaturan || {}; if (!D) return empty('description', 'Pilih siswa');
  return '<div class="paper" id="paper"><h4>' + esc(P.nama_lembaga) + '</h4><div style="text-align:center">' + esc(P.nama_unit || '') + (P.alamat_lembaga ? '<br>' + esc(P.alamat_lembaga) : '') + '</div><hr><h4 style="margin:6px 0">Lembar Pembinaan Siswa</h4><div style="text-align:center">Periode ' + fTgl(D.dari, 'mid') + ' – ' + fTgl(D.sampai, 'mid') + '</div>' +
    '<table><tr><th style="width:28%">Nama</th><td>' + esc(D.s.nama) + '</td></tr><tr><th>NIS / Kelas</th><td>' + esc(D.s.nis) + ' / ' + esc(D.s.kelas) + '</td></tr><tr><th>Wali Asuh</th><td>' + esc(D.wali) + '</td></tr></table>' +
    '<b>A. Rekap Kehadiran</b> (' + D.n + ' sesi · ' + D.pct + '% hadir)<table><tr><th>Hadir</th><th>Terlambat</th><th>Izin</th><th>Sakit</th><th>Alpa</th></tr><tr>' + ['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Tidak Hadir'].map(function (k) { return '<td style="text-align:center">' + D.c[k] + '</td>'; }).join('') + '</tr></table>' +
    '<b>B. Catatan Bimbingan</b>' + (D.bm.length ? '<table><tr><th>Tgl</th><th>Topik</th><th>Catatan</th><th>TL / Status</th></tr>' + D.bm.map(function (b) { return '<tr><td>' + fTgl(b.tgl) + '</td><td>' + esc(b.kategori) + '</td><td>' + esc(b.catatan) + '</td><td>' + esc(b.tl || '-') + (b.status ? ' (' + esc(b.status) + ')' : '') + '</td></tr>'; }).join('') + '</table>' : '<p>Tidak ada catatan pada periode ini.</p>') +
    '<div class="ttd"><div>Orang Tua/Wali<div class="ln"></div>(................)</div><div>Wali Asuh<div class="ln"></div>' + esc(D.wali) + '</div></div></div>';
}
function rekapBulan(bulan, kelas) {
  var rs = S.d.siswa.filter(function (s) { return !kelas || s.kelas === kelas; }).map(function (s) {
    var r = { s: s, hadir: 0, terlambat: 0, izin: 0, sakit: 0, alpa: 0, total: 0, bim: 0 };
    S.d.absensi.forEach(function (a) { if (a.id_siswa === s.id && a.jenis === 'Presensi' && a.tgl.slice(0, 7) === bulan) { r.total++; if (a.status === 'Hadir') r.hadir++; else if (a.status === 'Terlambat') r.terlambat++; else if (a.status === 'Izin') r.izin++; else if (a.status === 'Sakit') r.sakit++; else r.alpa++; } });
    S.d.bimbingan.forEach(function (b) { if (b.id_siswa === s.id && b.tgl.slice(0, 7) === bulan) r.bim++; }); r.pct = r.total ? Math.round((r.hadir + r.terlambat) * 100 / r.total) : null; return r;
  }); return rs;
}
function lapOut() {
  var L = S.lap;
  if (L.tipe === 'individu') return '<div class="alert info">' + ic('straighten') + '<span>Ukuran kertas <b>A4 ' + ((S.srv.pengaturan || {}).paper_w || 210) + '×' + ((S.srv.pengaturan || {}).paper_h || 297) + ' mm</b></span></div>' + paperHtml(lapData(L.id, L.dari, L.sampai)) +
    '<button class="btn cta" data-act="pdf">' + ic('picture_as_pdf') + 'Unduh Lembar PDF (A4)</button><div class="sp8"></div><button class="btn" data-act="kirimwali">' + ic('send') + 'Kirim ke Wali</button>';
  var rs = rekapBulan(L.bulan, L.kelas);
  return '<div class="tw"><table class="t"><thead><tr><th>Nama</th><th>Kelas</th><th>H</th><th>T</th><th>I</th><th>S</th><th>A</th><th>%</th><th>Bim</th></tr></thead><tbody>' + rs.map(function (r) { return '<tr><td>' + esc(r.s.nama) + '</td><td>' + esc(r.s.kelas) + '</td><td>' + r.hadir + '</td><td>' + r.terlambat + '</td><td>' + r.izin + '</td><td>' + r.sakit + '</td><td>' + r.alpa + '</td><td>' + (r.pct == null ? '—' : r.pct + '%') + '</td><td>' + r.bim + '</td></tr>'; }).join('') + '</tbody></table></div><div class="sp12"></div><button class="btn cta" data-act="csv">' + ic('table_view') + 'Rekap (.CSV)</button><p class="xs mut">Data presensi tersedia untuk ±100 hari terakhir.</p>';
}
V.laporan = function () {
  lapInit(); var L = S.lap, kls = Object.keys(S.d.siswa.reduce(function (m, s) { m[s.kelas] = 1; return m; }, {}));
  return vh('Laporan', true) + '<div class="seg"><button class="' + (L.tipe === 'individu' ? 'on' : '') + '" data-act="laptipe" data-k="individu">Laporan Individu</button><button class="' + (L.tipe === 'rekap' ? 'on' : '') + '" data-act="laptipe" data-k="rekap">Rekap Bulanan</button></div>' +
    (L.tipe === 'individu' ? '<div class="card"><label class="f" style="margin-top:0" for="lp-s">Siswa</label><select class="in" id="lp-s" data-in="lap" data-k="id">' + S.d.siswa.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === L.id ? ' selected' : '') + '>' + esc(s.nama) + '</option>'; }).join('') + '</select><div class="row"><div style="flex:1"><label class="f" for="lp-a">Dari</label><input class="in" type="date" id="lp-a" data-in="lap" data-k="dari" value="' + L.dari + '"></div><div style="flex:1"><label class="f" for="lp-b">Sampai</label><input class="in" type="date" id="lp-b" data-in="lap" data-k="sampai" value="' + L.sampai + '"></div></div></div>' :
      '<div class="card"><div class="row"><div style="flex:1"><label class="f" style="margin-top:0" for="lp-m">Bulan</label><input class="in" type="month" id="lp-m" data-in="lap" data-k="bulan" value="' + L.bulan + '"></div><div style="flex:1"><label class="f" style="margin-top:0" for="lp-k">Kelas</label><select class="in" id="lp-k" data-in="lap" data-k="kelas"><option value="">Semua</option>' + kls.map(function (k) { return '<option' + (k === L.kelas ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></div></div></div>') +
    '<div id="lap-out">' + lapOut() + '</div><div class="pad-b"></div>';
};
var JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
function makePDF(D) {
  return loadScript(JSPDF).then(function () {
    var J = window.jspdf.jsPDF, P = S.srv.pengaturan || {}, W = P.paper_w || 210, H = P.paper_h || 297, m = 15, doc = new J({ unit: 'mm', format: [W, H] }), y = 18, mw = W - 2 * m;
    var need = function (h) { if (y + h > H - 15) { doc.addPage([W, H]); y = 18; } }, tx = function (t, x, o) { doc.text(String(t), x, y, o); };
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); tx(String(P.nama_lembaga || '').toUpperCase(), W / 2, { align: 'center' }); y += 5.5; doc.setFont('helvetica', 'normal'); doc.setFontSize(10); tx(P.nama_unit || '', W / 2, { align: 'center' }); y += 5; if (P.alamat_lembaga) { tx(P.alamat_lembaga, W / 2, { align: 'center' }); y += 5; }
    doc.setLineWidth(.6); doc.line(m, y, W - m, y); y += 8; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); tx('LEMBAR PEMBINAAN SISWA', W / 2, { align: 'center' }); y += 5.5; doc.setFont('helvetica', 'normal'); doc.setFontSize(10); tx('Periode ' + fTgl(D.dari, 'mid') + ' s.d. ' + fTgl(D.sampai, 'mid'), W / 2, { align: 'center' }); y += 9;
    [['Nama', D.s.nama], ['NIS / Kelas', (D.s.nis || '-') + ' / ' + (D.s.kelas || '-')], ['Kamar', D.s.kamar || '-'], ['Wali Asuh', D.wali]].forEach(function (r) { tx(r[0], m); tx(': ' + r[1], m + 32); y += 5.5; }); y += 3;
    doc.setFont('helvetica', 'bold'); tx('A. Rekap Kehadiran (' + D.n + ' sesi, ' + D.pct + '% hadir)', m); y += 5; doc.setFont('helvetica', 'normal');
    var cw = mw / 5; ['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa'].forEach(function (k, i) { doc.rect(m + i * cw, y, cw, 7); doc.rect(m + i * cw, y + 7, cw, 7); doc.text(k, m + i * cw + cw / 2, y + 4.8, { align: 'center' }); doc.text(String(D.c[k === 'Alpa' ? 'Tidak Hadir' : k]), m + i * cw + cw / 2, y + 11.8, { align: 'center' }); }); y += 22;
    doc.setFont('helvetica', 'bold'); tx('B. Catatan Bimbingan', m); y += 5; doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    var cols = [[m, 20, 'Tanggal'], [m + 20, 28, 'Topik'], [m + 48, 70, 'Catatan'], [m + 118, mw - 118, 'TL / Status']];
    var rowDraw = function (cells, bold) { var lines = cells.map(function (c, i) { return doc.splitTextToSize(String(c || ''), cols[i][1] - 3); }), n = Math.max.apply(null, lines.map(function (l) { return l.length; })), h = n * 4 + 3; need(h); if (bold) doc.setFont('helvetica', 'bold'); cols.forEach(function (c, i) { doc.rect(c[0], y, c[1], h); doc.text(lines[i], c[0] + 1.5, y + 4.2); }); doc.setFont('helvetica', 'normal'); y += h; };
    rowDraw(cols.map(function (c) { return c[2]; }), true);
    if (!D.bm.length) { tx('Tidak ada catatan pada periode ini.', m); y += 6; } D.bm.forEach(function (b) { rowDraw([fTgl(b.tgl, 'mid'), b.kategori, b.catatan, (b.tl || '-') + (b.status ? ' (' + b.status + ')' : '')]); });
    need(45); y += 14; doc.setFontSize(10); tx('Orang Tua/Wali', m + 20, { align: 'center' }); tx('Wali Asuh', W - m - 30, { align: 'center' }); y += 26; tx('(.......................)', m + 20, { align: 'center' }); tx(D.wali, W - m - 30, { align: 'center' });
    doc.save('Lembar_' + String(D.s.nama).replace(/\W+/g, '_') + '_' + D.dari + '.pdf');
  });
}
function csvEsc(v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

/* ---------- Perlu Perhatian ---------- */
function itemLabel(it) {
  var x = it.data, nm = function (id) { return (S.by[id] || {}).nama || id; };
  if (it.type === 'sesi_absensi') return 'Sesi absensi ' + x.kegiatan + ' (' + x.rows.length + ' siswa)';
  if (it.type === 'kunjungan') return 'Kunjungan ' + nm(x.id_siswa);
  if (it.type === 'foto') return 'Foto kunjungan #' + x.n;
  if (it.type === 'bimbingan') return it.op === 'create' ? 'Catatan bimbingan ' + nm(x.id_siswa) : 'Perubahan TL';
  return 'Perubahan absensi';
}
V.perhatian = function () {
  var pr = S.box.filter(function (i) { return i.st === 'Ditolak' || i.st === 'Konflik'; }), jr = S.box.filter(function (i) { return i.st === 'Gagal'; }), aq = S.box.filter(function (i) { return i.st === 'Menunggu'; });
  var card = function (n, l, c, i) { return '<div class="stat ' + c + '" style="cursor:default">' + ic(i) + '<div class="v">' + n + '</div><div class="l">' + l + '</div></div>'; };
  return vh('Perlu Perhatian', true) + '<div class="grid2" style="grid-template-columns:repeat(3,1fr)">' + card(pr.length, 'Ditolak', pr.length ? 'red' : '', 'block') + card(jr.length, 'Jaringan', '', 'wifi_off') + card(aq.length, 'Antre', '', 'schedule') + '</div>' +
    '<div class="row" style="margin-bottom:12px"><button class="btn sm" data-act="syncnow">' + ic('sync') + 'Sinkron Sekarang</button></div>' +
    (S.box.length ? S.box.map(function (it) {
      var bad = it.st === 'Ditolak' || it.st === 'Konflik';
      return '<div class="card edge ' + (bad ? 'bad' : 'warn') + '"><div class="row"><b class="hd" style="flex:1">' + esc(itemLabel(it)) + '</b>' + pill(it.st === 'Konflik' ? 'E-409' : (it.kode || (it.st === 'Menunggu' ? 'Antre' : 'Jaringan')), bad ? 'bad' : '') + '</div><p class="sm mut" style="margin:6px 0">' + esc(it.err || (it.st === 'Menunggu' ? 'Menunggu dikirim.' : '')) + '</p><div class="row w">' +
        (it.st === 'Konflik' ? '<button class="btn sm inl" data-act="bandingkan" data-id="' + it.reqId + '">Bandingkan &amp; Timpa</button>' : '') + (it.st === 'Ditolak' && it.type !== 'foto' ? '<button class="btn sm inl" data-act="perbaiki" data-id="' + it.reqId + '">Perbaiki Data</button>' : '') + (it.st !== 'Konflik' && (it.st === 'Gagal' || it.st === 'Ditolak') ? '<button class="btn sm inl" data-act="retry" data-id="' + it.reqId + '">Coba Kirim Ulang</button>' : '') + '<button class="btn sm inl bad" data-act="buang" data-id="' + it.reqId + '">Buang</button></div></div>';
    }).join('') : empty('verified', 'Semua data tersinkron', 'Tidak ada antrean maupun galat.')) +
    '<div class="alert info">' + ic('shield') + '<span>Data yang belum terkirim tetap aman di perangkat ini dan akan dikirim otomatis begitu koneksi pulih.</span></div>';
};

/* ============================ PANEL (Koordinator / Admin) ============================ */
V.p = function () { return '<div id="p-body"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>'; };
AFTER.p = function () { PANEL[S.pv] && PANEL[S.pv](); };
function pnav() {
  var k = S.user.peran === 'Admin' ? [['dash', 'Dasbor', 'dashboard'], ['siswa', 'Siswa', 'groups'], ['consent', 'Consent', 'verified_user'], ['pengguna', 'Pengguna', 'manage_accounts'], ['pengaturan', 'Pengaturan', 'settings'], ['status', 'Status', 'monitor_heart']] : [['dash', 'Dasbor', 'dashboard'], ['siswa', 'Siswa', 'groups'], ['tl', 'Bimbingan', 'forum'], ['consent', 'Consent', 'verified_user'], ['rekap', 'Rekap', 'bar_chart'], ['status', 'Status', 'monitor_heart']];
  $('#side').innerHTML = '<div class="sb"><div class="logo" style="background:rgba(255,255,255,.14)">' + ic('diversity_3') + '</div><span>e-SIM Wali Asuh</span></div>' + k.map(function (x) { return '<button class="nv' + (S.pv === x[0] ? ' on' : '') + '" data-act="pnav" data-k="' + x[0] + '">' + ic(x[2]) + '<span class="t">' + x[1] + '</span></button>'; }).join('') + '<div style="flex:1"></div><button class="nv" data-act="avatar">' + ic('account_circle') + '<span class="t">' + esc(nick(S.user.nama)) + '</span></button>';
}
function pbody(h) { var b = $('#p-body'); if (b) b.innerHTML = h; }
function perr(e) { pbody('<div class="alert bad">' + ic('error') + '<span>' + esc(e.message || 'Gagal memuat.') + (e.code === 'NET' ? ' Periksa koneksi.' : '') + '</span></div>'); }
function swr(key, action, data, render) {
  var k = 'swr:' + S.user.id + ':' + key, c = LS.g(k, null), cur = S.pv;
  if (c) render(c); else pbody('<div class="sk"></div><div class="sk"></div><div class="sk"></div>');
  return call(action, data).then(function (r) { var same = c && JSON.stringify(c) === JSON.stringify(r); LS.s(k, r); if (!same && S.pv === cur && S.view === 'p') render(r); }).catch(function (e) { if (!c) perr(e); });
}
var PANEL = {};
PANEL.dash = function () {
  swr('dash', 'dashboard.ringkasan', {}, function (r) {
    var pct = r.absen_hari_ini ? Math.round(r.hadir_hari_ini * 100 / r.absen_hari_ini) : null, mx = Math.max.apply(null, r.tren.map(function (t) { return t.total; }).concat([1]));
    var st = function (v, l, i, c) { return '<div class="stat ' + (c || '') + '" style="cursor:default">' + ic(i) + '<div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; };
    pbody(vh('Dasbor') + '<p class="mut sm" style="margin:-6px 0 12px">' + fTgl(r.hari, 'long') + '</p><div class="pcard-g">' + st(r.siswa, 'Siswa aktif', 'groups', 'fill') + st(r.wali, 'Wali asuh', 'badge') + st(pct == null ? '—' : pct + '%', 'Kehadiran hari ini', 'how_to_reg') + (r.tl_terbuka == null ? '' : st(r.tl_terbuka, 'TL aktif', 'assignment') + st(r.tl_terlambat, 'TL terlambat', 'alarm', r.tl_terlambat ? 'red' : '')) + '</div>' +
      '<div class="card"><h3>Kehadiran 7 hari</h3><div class="bars">' + r.tren.map(function (t) { var h = Math.round(t.total / mx * 100); return '<div class="bw" title="' + t.hadir + '/' + t.total + '"><span class="xs b">' + (t.total ? Math.round(t.hadir * 100 / t.total) + '%' : '') + '</span><div class="bb" style="height:' + h + '%"></div><span class="bl">' + fTgl(t.tgl) + '</span></div>'; }).join('') + '</div></div>' +
      '<div class="card"><h3>Wali asuh belum presensi hari ini</h3>' + (r.belum_absen.length ? r.belum_absen.map(function (n) { return pill(n, 'bad'); }).join(' ') : pill('Semua sudah presensi', 'ok')) + '</div>' +
      '<div class="card"><h3>Status consent foto</h3><div class="row w">' + Object.keys(r.consent).map(function (k) { return pill(k + ': ' + r.consent[k], k === 'Disetujui' ? 'ok' : k === 'Belum' ? 'bad' : ''); }).join('') + '</div></div>');
  });
};
function waliName(id) { var w = (S.srv.wali || []).filter(function (x) { return x.id === id; })[0]; return w ? w.nama : '-'; }
PANEL.siswa = function () {
  var q = (S.pq || '').toLowerCase(), r = S.srv.siswa.filter(function (s) { return !q || (s.nama + s.nis + s.kelas).toLowerCase().indexOf(q) >= 0; });
  pbody(vh('Data Siswa', false, '<button class="btn sm inl" data-act="csvimp">' + ic('upload_file') + 'Impor CSV</button><button class="btn sm inl cta" data-act="sedit" style="margin-left:6px">' + ic('add') + 'Tambah</button>') + '<input type="file" id="csvf" accept=".csv,text/csv" hidden><input class="in" id="pq" data-in="pq" placeholder="Cari nama / NIS / kelas" value="' + esc(S.pq || '') + '" style="margin-bottom:12px"><div class="xs mut" style="margin:0 4px 6px">' + r.length + ' siswa</div><div class="tw"><table class="t"><thead><tr><th>Nama</th><th>NIS</th><th>Kelas</th><th>Wali Asuh</th><th>Consent</th></tr></thead><tbody id="ptb">' + r.slice(0, 300).map(function (s) { return '<tr data-act="sedit" data-id="' + esc(s.id) + '" style="cursor:pointer"><td><b>' + esc(s.nama) + '</b></td><td>' + esc(s.nis) + '</td><td>' + esc(s.kelas) + '</td><td>' + esc(waliName(s.id_wali)) + '</td><td>' + pill(s.consent || 'Belum', s.consent === 'Disetujui' ? 'ok' : 'bad') + '</td></tr>'; }).join('') + '</tbody></table></div>');
  var q2 = $('#pq'); if (q2 && document.activeElement !== q2 && S.pq) { }
};
function sForm(id) {
  var s = id ? S.by[id] || S.srv.siswa.filter(function (x) { return x.id === id; })[0] : {}, J = (S.srv.pengaturan.jenjang || []), f = function (i, l, k, t) { return '<label class="f" for="' + i + '">' + l + '</label><input class="in" id="' + i + '" type="' + (t || 'text') + '" value="' + esc(s[k] || '') + '" maxlength="100">'; };
  sheet('<h3>' + (id ? 'Ubah Siswa' : 'Tambah Siswa') + '</h3>' + f('sf-nama', 'Nama lengkap', 'nama') + '<div class="row"><div style="flex:1">' + f('sf-nis', 'NIS', 'nis') + '</div><div style="flex:1">' + f('sf-nisn', 'NISN', 'nisn') + '</div></div><div class="row"><div style="flex:1"><label class="f" for="sf-jk">Jenis kelamin</label><select class="in" id="sf-jk"><option value="L"' + (s.jk === 'L' ? ' selected' : '') + '>Laki-laki</option><option value="P"' + (s.jk === 'P' ? ' selected' : '') + '>Perempuan</option></select></div><div style="flex:1">' + f('sf-tl', 'Tgl lahir', 'tgl_lahir', 'date') + '</div></div>' +
    '<div class="row"><div style="flex:1"><label class="f" for="sf-jj">Jenjang</label><select class="in" id="sf-jj">' + J.map(function (j) { return '<option' + (j === s.jenjang ? ' selected' : '') + '>' + esc(j) + '</option>'; }).join('') + '</select></div><div style="flex:1">' + f('sf-kls', 'Kelas', 'kelas') + '</div></div>' + f('sf-kmr', 'Kamar / Asrama', 'kamar') + f('sf-wm', 'Nama wali murid', 'wali_murid') + f('sf-kon', 'Kontak wali murid', 'kontak', 'tel') +
    '<label class="f" for="sf-w">Wali asuh</label><select class="in" id="sf-w"><option value="">— Belum ditugaskan —</option>' + (S.srv.wali || []).map(function (w) { return '<option value="' + esc(w.id) + '"' + (w.id === s.id_wali ? ' selected' : '') + '>' + esc(w.nama) + '</option>'; }).join('') + '</select>' + f('sf-al', 'Alamat', 'alamat') + '<div class="ferr" id="sf-err" hidden></div><div class="sp16"></div><div class="row"><button class="btn sm" data-act="close">Batal</button><button class="btn sm cta" data-act="ssave" data-id="' + esc(id || '') + '" data-rev="' + (s.rev || '') + '">Simpan</button></div>' + (id ? '<div class="sp8"></div><button class="btn sm bad" data-act="snon" data-id="' + esc(id) + '">Nonaktifkan siswa</button>' : ''));
}
PANEL.tl = function () {
  var r = S.srv.bimbingan.filter(function (b) { return b.tl; }).sort(function (a, b) { return (a.target || '') < (b.target || '') ? -1 : 1; });
  pbody(vh('Tindak Lanjut Bimbingan') + '<div class="tw"><table class="t"><thead><tr><th>Siswa</th><th>Wali Asuh</th><th>Topik</th><th>Target</th><th>Status</th></tr></thead><tbody>' + r.slice(0, 300).map(function (b) { var s = S.by[b.id_siswa] || {}; return '<tr><td><b>' + esc(s.nama || b.id_siswa) + '</b></td><td>' + esc(waliName(b.id_wali)) + '</td><td>' + esc(b.kategori) + '</td><td>' + fTgl(b.target, 'mid') + '</td><td>' + pill(b.status === 'Selesai' ? 'Selesai' : tlLabel(b), tlState(b) === 'bad' ? 'bad' : b.status === 'Selesai' ? 'ok' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>');
};
PANEL.consent = function () {
  swr('consent', 'admin.consentList', {}, function (r) {
    pbody(vh('Consent Foto Siswa') + '<div class="tw"><table class="t"><thead><tr><th>Siswa</th><th>Kelas</th><th>Status</th><th>Verifikasi</th><th></th></tr></thead><tbody>' + r.map(function (c) { return '<tr><td><b>' + esc(c.nama) + '</b></td><td>' + esc(c.kelas) + '</td><td>' + pill(c.status, c.status === 'Disetujui' ? 'ok' : c.status === 'Ditolak' ? 'bad' : '') + '</td><td>' + (c.verif ? pill('Terverifikasi', 'ok') : '—') + '</td><td style="white-space:nowrap"><button class="btn-s" data-act="cset" data-id="' + esc(c.id) + '" data-s="Disetujui">Setujui</button> ' + (c.status !== 'Belum' && !c.verif ? '<button class="btn-s" data-act="cver" data-id="' + esc(c.id) + '">Verifikasi</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table></div>');
  });
};
PANEL.rekap = function () {
  var bln = S.prekap || today().slice(0, 7); S.prekap = bln;
  swr('rekap:' + bln, 'rekap.bulanan', { bulan: bln }, function (r) {
    S.rekapRows = r.baris;
    pbody(vh('Rekap Bulanan') + '<div class="row w" style="margin-bottom:12px"><input class="in" type="month" id="pm" data-in="pm" value="' + bln + '" style="max-width:200px"><button class="btn sm inl" data-act="pcsv">' + ic('table_view') + 'Unduh .CSV</button></div><div class="tw"><table class="t"><thead><tr><th>Nama</th><th>Kelas</th><th>H</th><th>T</th><th>I</th><th>S</th><th>A</th><th>Sesi</th><th>Bim</th><th>TL aktif</th></tr></thead><tbody>' + r.baris.map(function (x) { return '<tr><td>' + esc(x.nama) + '</td><td>' + esc(x.kelas) + '</td><td>' + x.hadir + '</td><td>' + x.terlambat + '</td><td>' + x.izin + '</td><td>' + x.sakit + '</td><td>' + x.alpa + '</td><td>' + x.total + '</td><td>' + x.bim + '</td><td>' + x.tl_terbuka + '</td></tr>'; }).join('') + '</tbody></table></div>');
  });
};
PANEL.pengguna = function () {
  swr('users', 'admin.userList', {}, function (r) {
    S.users = r; pbody(vh('Pengguna', false, '<button class="btn sm inl cta" data-act="uedit">' + ic('person_add') + 'Tambah</button>') + '<div class="tw"><table class="t"><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>' + r.map(function (u) { return '<tr><td><b>' + esc(u.nama) + '</b></td><td>' + esc(u.email) + '</td><td>' + esc(u.peran) + '</td><td>' + pill(u.terkunci ? 'Terkunci' : u.status, u.status === 'Aktif' && !u.terkunci ? 'ok' : 'bad') + '</td><td style="white-space:nowrap"><button class="btn-s" data-act="uedit" data-id="' + esc(u.id) + '">Ubah</button> <button class="btn-s" data-act="ureset" data-id="' + esc(u.id) + '">Reset PIN</button></td></tr>'; }).join('') + '</tbody></table></div>');
  });
};
PANEL.pengaturan = function () {
  pbody('<div class="sk"></div><div class="sk"></div>');
  call('pengaturan.get').then(function (r) {
    var f = function (k, l, ta) { return '<label class="f" for="pg-' + k + '">' + l + '</label>' + (ta ? '<textarea class="in" id="pg-' + k + '" style="min-height:90px">' + esc(lines(r[k])) + '</textarea>' : '<input class="in" id="pg-' + k + '" value="' + esc(r[k]) + '">'); };
    pbody(vh('Pengaturan') + '<div class="card">' + f('nama_lembaga', 'Nama lembaga') + f('nama_unit', 'Nama unit') + f('alamat_lembaga', 'Alamat (kop laporan)') + f('tahun_ajaran', 'Tahun ajaran') + f('daftar_kegiatan', 'Daftar kegiatan (satu per baris)', 1) + f('topik_bimbingan', 'Topik bimbingan (satu per baris)', 1) + f('jenjang_aktif', 'Jenjang aktif (satu per baris)', 1) + '<div class="row"><div style="flex:1">' + f('batas_foto_harian', 'Kuota foto/hari/pengguna') + '</div><div style="flex:1">' + f('min_client_version', 'Versi klien minimum') + '</div></div><div class="sp12"></div><button class="btn cta" data-act="pgsave">Simpan Pengaturan</button></div>' +
      '<div class="card"><h3>Telegram Bot</h3><p class="sm mut" style="margin:0 0 8px">Token disimpan aman di Script Properties — tidak pernah ditampilkan lagi.</p><input class="in" id="tg-tok" type="password" placeholder="123456:ABC… (token dari @BotFather)" autocomplete="off"><div class="sp8"></div><button class="btn sm" data-act="tgsave">Simpan Token</button></div>' +
      '<div class="card"><h3>Keamanan</h3><p class="sm mut" style="margin:0 0 8px">Rotasi rahasia sesi akan memaksa semua pengguna masuk ulang.</p><button class="btn sm bad" data-act="rotasi">Rotasi Secret Sesi</button></div>');
  }).catch(perr);
};
function lines(v) { try { var a = JSON.parse(v); if (Array.isArray(a)) return a.join('\n'); } catch (e) {} return v; }
PANEL.status = function () {
  swr('status', 'status.sistem', {}, function (r) {
    pbody(vh('Status Sistem', false, S.user.peran === 'Admin' ? '<button class="btn sm inl" data-act="backup">' + ic('backup') + 'Backup Sekarang</button>' : '') + '<div class="pcard-g"><div class="stat fill" style="cursor:default"><div class="l">Versi</div><div class="v">' + esc(r.versi) + '</div></div>' + ['pengguna', 'siswa', 'absensi', 'bimbingan'].map(function (k) { return '<div class="stat" style="cursor:default"><div class="l">' + k + '</div><div class="v">' + r.jumlah[k] + '</div></div>'; }).join('') + '</div><div class="card"><h3>Komponen</h3><div class="row w">' + pill('Telegram: ' + (r.telegram ? 'siap' : 'belum'), r.telegram ? 'ok' : '') + pill('Folder foto: ' + (r.foto_folder ? 'siap' : 'belum'), r.foto_folder ? 'ok' : 'bad') + r.trigger.map(function (t) { return pill(t, 'info'); }).join('') + '</div></div><div class="card"><h3>Galat terakhir</h3>' + (r.log_terakhir.length ? r.log_terakhir.map(function (l) { return '<div class="sm" style="padding:4px 0;border-bottom:1px solid var(--line)"><b>' + esc(l.aksi) + '</b> · ' + esc(l.kode) + ' · <span class="mut">' + esc(l.waktu) + '</span><br><span class="xs mut">' + esc(l.info) + '</span></div>'; }).join('') : '<p class="mut sm" style="margin:0">Tidak ada galat tercatat.</p>') + '</div>');
  });
};

/* ---------- Aksi (event delegation) ---------- */
var A = {};
function csvParse(t) {
  var rows = [], r = [], c = '', q = false, i, ch; t = t.replace(/^﻿/, ''); var sep = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (i = 0; i < t.length; i++) { ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === sep) { r.push(c); c = ''; } else if (ch === '\n') { r.push(c); rows.push(r); r = []; c = ''; } else if (ch !== '\r') c += ch; }
  if (c || r.length) { r.push(c); rows.push(r); } return rows.filter(function (x) { return x.join('').trim(); });
}
A.reload = function () { location.reload(); };
A.go = function (el) { if (el.dataset.fil) S.tlFil = el.dataset.fil; if (el.dataset.v === 'bimbingan' && !el.dataset.fil) S.tlFil = 'semua'; go(el.dataset.v, {}, true); };
A.back = function () { back(); };
A.close = closeSheet;
A.eye = function () { var i = $('#lg-pass'); i.type = i.type === 'password' ? 'text' : 'password'; };
A.newb = function (el) { S.bf = null; go('bform', { id: el.dataset.id || '' }); renderView('bform'); };
A.kj = function (el) { S.kj = { fotos: [], jenis: 'Kunjungan Rumah' }; go('kunjungan', { id: el.dataset.id }); };
A.detail = function (el) { go('detail', { id: el.dataset.id }); };
A.lap = function (el) { S.lap = { tipe: 'individu', id: el.dataset.id }; go('laporan'); };
A.golap = function () { go('laporan'); }; A.goperh = function () { go('perhatian'); };
A.avatar = function () { if (S.user.peran === 'WaliAsuh') go('lainnya'); else sheet('<h3>' + esc(S.user.nama) + '</h3><p class="mut sm">' + esc(S.user.email) + ' · ' + esc(S.user.peran) + '</p><div class="row"><button class="btn sm" data-act="dark">' + ic('dark_mode') + 'Tema</button><button class="btn sm" data-act="hemat">' + ic('bolt') + 'Hemat</button></div><div class="sp8"></div><button class="btn sm" data-act="gantipw">Ganti Kata Sandi</button><div class="sp8"></div><button class="btn sm bad" data-act="logout">Keluar</button>'); };
A.bell = function () { if (S.user.peran === 'WaliAsuh') go('perhatian'); else { S.pv = 'status'; go('p'); pnav(); } };
A.hemat = function (el) { S.pref.hemat = el.type === 'checkbox' ? el.checked : !S.pref.hemat; LS.s('pref', S.pref); apply(); };
A.dark = function (el) { S.pref.dark = el.type === 'checkbox' ? el.checked : !S.pref.dark; LS.s('pref', S.pref); apply(); };
A.gantipw = function () { closeSheet(); go('ganti'); };
A.logout = function () { if (pending() && !confirm('Ada ' + pending() + ' data belum terkirim. Keluar akan menyimpannya di perangkat sampai Anda masuk lagi. Lanjutkan?')) return; logout(); };
A.allhadir = function (el) { var s = S.ses; s.all = el.checked; S.d.siswa.forEach(function (x) { if (!s.ex[x.id]) s.st[x.id] = s.all ? 'Hadir' : ''; }); renderView('absensi'); };
A.st = function (el) { var s = S.ses, id = el.dataset.id; s.st[id] = el.dataset.s; renderView('absensi'); };
A.savesesi = function (el) {
  var s = S.ses, i, x, rows = [], ups = [];
  var kos = S.d.siswa.filter(function (x) { return !s.st[x.id]; }); if (kos.length) return toast('Pilih status untuk ' + kos.length + ' siswa.', 'bad');
  var wajib = S.d.siswa.filter(function (x) { return (s.st[x.id] === 'Izin' || s.st[x.id] === 'Sakit') && !String(s.cat[x.id] || '').trim(); }); if (wajib.length) return toast('Isi keterangan untuk ' + wajib[0].nama + '.', 'bad');
  if (diff(today(), s.tgl) > 3 && !String(s.alasan || '').trim()) return toast('Alasan input terlambat wajib diisi.', 'bad');
  if (!s.kegiatan) return toast('Pilih kegiatan.', 'bad');
  S.d.siswa.forEach(function (x) {
    var ex = s.ex[x.id]; if (ex) { if (ex.status !== s.st[x.id] || (ex.catatan || '') !== (s.cat[x.id] || '')) ups.push({ id: ex.id, status: s.st[x.id], catatan: s.cat[x.id] || '', rev: ex.rev }); }
    else rows.push({ id_siswa: x.id, status: s.st[x.id], catatan: s.cat[x.id] || '' });
  });
  if (!rows.length && !ups.length) { toast('Tidak ada perubahan.'); return; }
  var g = S.gps && S.gps.ok ? S.gps : {};
  if (rows.length) enqueue('sesi_absensi', 'create', { id_sesi: s.id, tanggal: s.tgl, jam: s.jam, kegiatan: s.kegiatan, lat: g.lat || '', lng: g.lng || '', akurasi: g.acc || '', gps_status: g.ok ? 'OK' : 'Tidak tersedia', alasan_backdate: s.alasan || '', dibuat_klien: new Date().toISOString(), rows: rows });
  ups.forEach(function (u) { enqueue('absen', 'update', { id: u.id, status: u.status, catatan: u.catatan }, u.rev ? { base_rev: u.rev } : {}); });
  S.ses = null; S.stack = []; go('beranda', {}, false); toast('Sesi absensi tersimpan (' + (rows.length + ups.length) + ' siswa)', 'ok');
};
A.tlfil = function (el) { S.tlFil = el.dataset.k; dirty.bimbingan = 1; renderView('bimbingan'); };
A.tlseg = function (el) { S.tlSeg = el.dataset.k; renderView('bimbingan'); };
A.tlsort = function () { S.tlSort = S.tlSort === 'tenggat' ? 'baru' : 'tenggat'; renderView('bimbingan'); };
A.tl = function (el) { tlSheet(el.dataset.id); };
function bimRev(id) { var b = S.d.bimbingan.filter(function (x) { return x.id === id; })[0]; return b && b.rev ? { base_rev: b.rev } : {}; }
A.tlproses = function (el) { enqueue('bimbingan', 'status', { id: el.dataset.id, status_tl: 'Proses' }, bimRev(el.dataset.id)); closeSheet(); toast('TL diproses', 'ok'); };
A.tlbuka = function (el) { enqueue('bimbingan', 'status', { id: el.dataset.id, status_tl: 'Terbuka' }, bimRev(el.dataset.id)); closeSheet(); toast('TL dibuka kembali'); };
A.tlselesai = function (el) { tlDone(el.dataset.id); };
A.tldone2 = function (el) { var t = val('ev').trim(); if (t.length < 3) return toast('Catatan evaluasi wajib diisi.', 'bad'); enqueue('bimbingan', 'status', { id: el.dataset.id, status_tl: 'Selesai', catatan_evaluasi: t }, bimRev(el.dataset.id)); closeSheet(); toast('Tindak lanjut selesai', 'ok'); };
A.topik = function (el) { S.bf = S.bf || {}; S.bf.topik = el.dataset.k; $$('#bf-topik .fc').forEach(function (b) { b.classList.toggle('on', b.dataset.k === S.bf.topik); }); updStp(); };
function updStp() {
  var a = !!val('bf-s'), b = !!(S.bf && S.bf.topik) && val('bf-c').trim().length >= 3, c = !!val('bf-tl').trim(), set = function (i, on, cur) { var e = $('#stp' + i); if (e) { e.classList.toggle('done', on); e.classList.toggle('on', cur); } };
  set(1, a, !a); set(2, a && b, a && !b); set(3, a && b && c, a && b && !c);
}
A.tgtoggle = function (el) { if (!S.user.telegram) { el.checked = false; A.tgpair(); } };
A.savebf = function (el) {
  var id = val('bf-s'), top = S.bf && S.bf.topik, cat = val('bf-c').trim(), tl = val('bf-tl').trim(), tgt = val('bf-g'), e = $('#bf-err'), msg = !id ? 'Pilih siswa.' : !top ? 'Pilih topik bimbingan.' : cat.length < 3 ? 'Catatan progres wajib diisi.' : (tl && !tgt) ? 'Tanggal target TL wajib bila ada tindak lanjut.' : '';
  if (msg) { e.textContent = msg; e.hidden = false; return; } e.hidden = true;
  var bid = 'B-' + rid();
  enqueue('bimbingan', 'create', { id: bid, client_uuid: bid, tanggal: val('bf-t'), id_siswa: id, topik_kategori: top, topik_detail: val('bf-d').trim(), catatan_progres: cat, tindak_lanjut: tl, tgl_target_tl: tl ? tgt : '' });
  S.bf = null; back(); toast('Catatan tersimpan', 'ok');
};
A.kjjenis = function (el) { S.kj.jenis = el.dataset.k; $$('.fc[data-act="kjjenis"]').forEach(function (b) { b.classList.toggle('on', b.dataset.k === S.kj.jenis); }); };
A.shoot = function () {
  var max = S.srv.pengaturan.batas_foto || 3; if (S.kj.fotos.length >= max) return toast('Maksimal ' + max + ' foto.', 'bad');
  if (!val('kj-s')) return toast('Pilih siswa dulu agar cap foto sesuai.', 'bad');
  var v = $('#camv'); if (cam.stream && v && v.videoWidth) { var d = shootFrom(v); if (d) { S.kj.fotos.push(d); S.kj.src = 'kamera'; $('#slots').innerHTML = slotsHtml(max); } } else $('#camf').click();
};
A.redo = function () { S.kj.fotos.pop(); $('#slots').innerHTML = slotsHtml(S.srv.pengaturan.batas_foto || 3); };
A.delfoto = function (el) { S.kj.fotos.splice(+el.dataset.i, 1); $('#slots').innerHTML = slotsHtml(S.srv.pengaturan.batas_foto || 3); };
A.savekj = function () {
  var id = val('kj-s'), e = $('#kj-err'), k = S.kj, msg = !id ? 'Pilih siswa.' : !k.fotos.length ? 'Ambil minimal 1 foto bukti.' : '';
  if (msg) { e.textContent = msg; e.hidden = false; return; } e.hidden = true;
  var aid = 'K-' + rid().slice(0, 8), g = S.gps && S.gps.ok ? S.gps : {};
  Promise.all(k.fotos.map(function (f, i) { return IDB.put(aid + '_' + (i + 1), f); })).then(function () {
    enqueue('kunjungan', 'create', { id_absen: aid, client_uuid: aid, id_siswa: id, tanggal: today(), jam: nowHM(), jenis_kunjungan: k.jenis, catatan: val('kj-c').trim(), lat: g.lat || '', lng: g.lng || '', akurasi: g.acc || '', gps_status: g.ok ? 'OK' : 'Tidak tersedia', sumber_foto: k.src || 'kamera', nfoto: k.fotos.length, dibuat_klien: new Date().toISOString() });
    k.fotos.forEach(function (f, i) { enqueue('foto', 'upload', { id_absen: aid, n: i + 1 }); });
    S.kj = { fotos: [], jenis: 'Kunjungan Rumah' }; back(); toast('Kunjungan tersimpan', 'ok');
  });
};
A.laptipe = function (el) { S.lap.tipe = el.dataset.k; renderView('laporan'); };
A.pdf = function (el) { var D = lapData(S.lap.id, S.lap.dari, S.lap.sampai); if (!D) return; busy(el, true, 'Menyusun PDF…'); makePDF(D).catch(function (e) { toast(e.message || 'Gagal membuat PDF', 'bad'); }).then(function () { busy(el, false); }); };
A.kirimwali = function () {
  var D = lapData(S.lap.id, S.lap.dari, S.lap.sampai); if (!D) return; var P = S.srv.pengaturan || {};
  var t = 'Assalamualaikum, berikut ringkasan pembinaan ' + D.s.nama + ' (' + fTgl(D.dari, 'mid') + ' – ' + fTgl(D.sampai, 'mid') + '):\n• Kehadiran: ' + D.pct + '% dari ' + D.n + ' sesi\n• Catatan bimbingan: ' + D.bm.length + '\n' + (D.bm.length ? '• Terakhir: ' + D.bm[D.bm.length - 1].catatan.slice(0, 140) + '\n' : '') + '— Wali Asuh ' + D.wali + ', ' + (P.nama_lembaga || '');
  if (navigator.share) navigator.share({ text: t }).catch(function () {}); else { var n = String(D.s.kontak || '').replace(/\D/g, '').replace(/^0/, '62'); if (n) { var a = document.createElement('a'); a.href = 'https://wa.me/' + n + '?text=' + encodeURIComponent(t); a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); } else if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('Ringkasan disalin.'); }); }
};
A.csv = function () { var rs = rekapBulan(S.lap.bulan, S.lap.kelas), h = ['Nama', 'Kelas', 'Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa', 'Sesi', '% Hadir', 'Bimbingan']; download('rekap_' + S.lap.bulan + '.csv', 'text/csv;charset=utf-8', '﻿' + [h].concat(rs.map(function (r) { return [r.s.nama, r.s.kelas, r.hadir, r.terlambat, r.izin, r.sakit, r.alpa, r.total, r.pct == null ? '' : r.pct, r.bim]; })).map(function (r) { return r.map(csvEsc).join(','); }).join('\r\n')); };
A.syncnow = function () { S.box.forEach(function (i) { if (i.st === 'Gagal') i.st = 'Menunggu'; }); trySync(); toast('Menyinkronkan…'); };
function boxItem(id) { return S.box.filter(function (x) { return x.reqId === id; })[0]; }
A.retry = function (el) { var it = boxItem(el.dataset.id); if (it) { it.st = 'Menunggu'; it.n = 0; it.err = ''; persist(); trySync(); renderView('perhatian'); } };
A.buang = function (el) { if (!confirm('Buang data ini? Tidak dapat dikembalikan.')) return; var it = boxItem(el.dataset.id); S.box = S.box.filter(function (x) { return x !== it; }); if (it && it.type === 'foto') IDB.del(it.data.id_absen + '_' + it.data.n); persist(); rebuild(); markDirty(); renderNow(); setSync(); };
A.perbaiki = function (el) {
  var it = boxItem(el.dataset.id); if (!it) return; var x = it.data; S.box = S.box.filter(function (z) { return z !== it; }); persist(); rebuild();
  if (it.type === 'bimbingan' && it.op === 'create') { S.bf = { topik: x.topik_kategori, id: x.id_siswa }; go('bform', { id: x.id_siswa }); renderView('bform'); $('#bf-c').value = x.catatan_progres || ''; $('#bf-tl').value = x.tindak_lanjut || ''; $('#bf-d').value = x.topik_detail || ''; if (x.tgl_target_tl) $('#bf-g').value = x.tgl_target_tl; updStp(); }
  else if (it.type === 'sesi_absensi') { S.ses = { id: x.id_sesi, tgl: x.tanggal, jam: x.jam, kegiatan: x.kegiatan, all: false, alasan: x.alasan_backdate }; sesLoad(); x.rows.forEach(function (r) { S.ses.st[r.id_siswa] = r.status; S.ses.cat[r.id_siswa] = r.catatan; }); go('absensi'); renderView('absensi'); }
  else { go('beranda'); toast('Ulangi input data ini dari menu terkait.'); }
};
A.bandingkan = function (el) {
  var it = boxItem(el.dataset.id), sv = it.server || {}, x = it.data, row = function (l, a, b) { return '<tr><th>' + l + '</th><td>' + esc(a || '-') + '</td><td>' + esc(b || '-') + '</td></tr>'; };
  sheet('<h3>Bandingkan &amp; Timpa</h3><p class="mut sm">Data ini sudah diubah di tempat lain.</p><div class="tw"><table class="t"><thead><tr><th></th><th>Server</th><th>Perubahan Anda</th></tr></thead><tbody>' + (it.type === 'bimbingan' ? row('Status TL', sv.status, x.status_tl) + row('Catatan', sv.catatan, x.catatan_progres) + row('Evaluasi', sv.evaluasi, x.catatan_evaluasi) : row('Status', sv.status, x.status) + row('Catatan', sv.catatan, x.catatan)) + '</tbody></table></div><div class="sp16"></div><div class="row"><button class="btn sm" data-act="pakaiserver" data-id="' + it.reqId + '">Pakai Server</button><button class="btn sm pri" data-act="timpa" data-id="' + it.reqId + '">Timpa</button></div>');
};
A.pakaiserver = function (el) { A.buang2(el.dataset.id); };
A.buang2 = function (id) { var it = boxItem(id); S.box = S.box.filter(function (x) { return x !== it; }); persist(); closeSheet(); rebuild(); markDirty(); pull().then(function () { renderNow(); }); };
A.timpa = function (el) { var it = boxItem(el.dataset.id); if (!it) return; it.base_rev = it.server && it.server.rev; it.st = 'Menunggu'; it.err = ''; persist(); closeSheet(); trySync(); renderView('perhatian'); toast('Dikirim ulang dengan versi terbaru'); };
A.tgpair = function () {
  sheet('<h3>Hubungkan Telegram</h3><div class="sk"></div>');
  call('notif.pairStart').then(function (r) { sheet('<h3>Hubungkan Telegram</h3><ol class="sm" style="padding-left:18px"><li>Buka Telegram, cari bot ' + (r.bot ? '<b>@' + esc(r.bot) + '</b>' : 'sekolah Anda') + '.</li><li>Kirim kode berikut dalam 15 menit:</li></ol><div class="hero" style="text-align:center;margin:12px 0"><div style="font:800 34px var(--hf);letter-spacing:.2em">' + esc(r.kode) + '</div></div><p class="xs mut">Setelah bot membalas, tutup jendela ini. Status akan diperbarui otomatis.</p><button class="btn sm" data-act="close">Tutup</button>'); setTimeout(function () { call('auth.refresh').then(function (x) { S.user = x.user; LS.s('user', S.user); dirty.lainnya = 1; }); }, 30000); }).catch(function (e) { sheet('<h3>Telegram</h3><div class="alert bad">' + esc(e.message) + '</div><button class="btn sm" data-act="close">Tutup</button>'); });
};
/* --- panel --- */
A.pnav = function (el) { S.pv = el.dataset.k; pnav(); go('p', {}, false); renderView('p'); };
A.sedit = function (el) { sForm(el.dataset.id || ''); };
A.ssave = function (el) {
  var d = { id: el.dataset.id || undefined, base_rev: el.dataset.rev || undefined, nama: val('sf-nama'), nis: val('sf-nis'), nisn: val('sf-nisn'), jk: val('sf-jk'), tgl_lahir: val('sf-tl'), jenjang: val('sf-jj'), kelas: val('sf-kls'), kamar: val('sf-kmr'), wali_murid: val('sf-wm'), kontak: val('sf-kon'), id_wali: val('sf-w'), alamat: val('sf-al') };
  busy(el, true); call('siswa.save', d).then(function () { closeSheet(); toast('Siswa tersimpan', 'ok'); return pull(); }).then(function () { PANEL.siswa(); }).catch(function (e) { busy(el, false); var x = $('#sf-err'); x.textContent = e.message; x.hidden = false; });
};
A.snon = function (el) { var a = prompt('Alasan menonaktifkan siswa ini?'); if (!a) return; call('siswa.deactivate', { id: el.dataset.id, alasan: a }).then(function () { closeSheet(); toast('Siswa dinonaktifkan'); return pull(); }).then(function () { PANEL.siswa(); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.csvimp = function () { $('#csvf').click(); };
function csvImport(text) {
  var t = csvParse(text); if (t.length < 2) return toast('CSV kosong.', 'bad'); var h = t[0].map(function (x) { return x.trim().toLowerCase().replace(/\s+/g, '_'); }), rows = t.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = (r[i] || '').trim(); }); return o; });
  call('siswa.import', { rows: rows, dryrun: true }, { timeout: 60000 }).then(function (r) {
    sheet('<h3>Pratinjau Impor</h3><div class="row w">' + pill(r.valid + ' valid', 'ok') + pill(r.gagal.length + ' gagal', r.gagal.length ? 'bad' : 'mut') + '</div>' + (r.gagal.length ? '<div class="sp12"></div><div class="tw" style="max-height:200px;overflow:auto"><table class="t">' + r.gagal.slice(0, 50).map(function (g) { return '<tr><td>Baris ' + g.baris + '</td><td>' + esc(g.alasan) + '</td></tr>'; }).join('') + '</table></div>' : '') + '<p class="xs mut">Kolom: nis, nisn, nama, jk, tgl_lahir, jenjang, kelas, kamar, alamat, wali_murid, kontak, email_wali_asuh.</p><div class="sp12"></div><div class="row"><button class="btn sm" data-act="close">Batal</button><button class="btn sm pri" id="imp-go"' + (r.valid ? '' : ' disabled') + '>Impor ' + r.valid + ' Siswa</button></div>');
    var g = $('#imp-go'); if (g) g.onclick = function () { busy(g, true); call('siswa.import', { rows: rows, dryrun: false }, { timeout: 90000 }).then(function (x) { closeSheet(); toast(x.dibuat + ' siswa diimpor', 'ok'); return pull(); }).then(function () { PANEL.siswa(); }).catch(function (e) { busy(g, false); toast(e.message, 'bad'); }); };
  }).catch(function (e) { toast(e.message, 'bad'); });
}
A.cset = function (el) { call('consent.simpan', { id: el.dataset.id, status: el.dataset.s }).then(function () { LS.r('swr:' + S.user.id + ':consent'); PANEL.consent(); pull(); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.cver = function (el) { call('consent.verifikasi', { id: el.dataset.id }).then(function () { toast('Terverifikasi', 'ok'); PANEL.consent(); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.pcsv = function () { var h = ['Nama', 'Kelas', 'Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa', 'Sesi', 'Bimbingan', 'TL aktif']; download('rekap_' + S.prekap + '.csv', 'text/csv;charset=utf-8', '﻿' + [h].concat((S.rekapRows || []).map(function (x) { return [x.nama, x.kelas, x.hadir, x.terlambat, x.izin, x.sakit, x.alpa, x.total, x.bim, x.tl_terbuka]; })).map(function (r) { return r.map(csvEsc).join(','); }).join('\r\n')); };
A.uedit = function (el) {
  var u = el.dataset.id ? (S.users || []).filter(function (x) { return x.id === el.dataset.id; })[0] : {};
  sheet('<h3>' + (u.id ? 'Ubah Pengguna' : 'Tambah Pengguna') + '</h3><label class="f" for="u-n">Nama</label><input class="in" id="u-n" value="' + esc(u.nama || '') + '"><label class="f" for="u-e">Email</label><input class="in" id="u-e" type="email" value="' + esc(u.email || '') + '"><label class="f" for="u-p">Peran</label><select class="in" id="u-p">' + ['WaliAsuh', 'Koordinator', 'Admin'].map(function (p) { return '<option' + (p === u.peran ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select><label class="f" for="u-s">Status</label><select class="in" id="u-s">' + ['Aktif', 'Nonaktif'].map(function (p) { return '<option' + (p === u.status ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select><label class="f" for="u-pw">Sandi ' + (u.id ? '(kosongkan = tidak diubah)' : '(kosongkan = dibuat acak)') + '</label><input class="in" id="u-pw" type="text" autocomplete="off" placeholder="Min. 8 karakter, huruf + angka"><div class="ferr" id="u-err" hidden></div><div class="sp16"></div><div class="row"><button class="btn sm" data-act="close">Batal</button><button class="btn sm cta" data-act="usave" data-id="' + esc(u.id || '') + '">Simpan</button></div>');
};
function showPass(t, p) { sheet('<h3>' + t + '</h3><p class="sm">Sandi (catat dan berikan ke pengguna; juga tercatat di Sheet Pengguna):</p><div class="hero" style="text-align:center;margin:12px 0"><div style="font:800 26px var(--hf);letter-spacing:.06em;user-select:all">' + esc(p) + '</div></div><p class="xs mut">Sandi acak wajib diganti saat masuk pertama; sandi yang Anda tentukan langsung berlaku.</p><button class="btn sm" data-act="close">Selesai</button>'); }
A.usave = function (el) { call('admin.userSave', { id: el.dataset.id || undefined, nama: val('u-n'), email: val('u-e'), peran: val('u-p'), status: val('u-s'), sandi: val('u-pw').trim() || undefined }).then(function (r) { LS.r('swr:' + S.user.id + ':users'); PANEL.pengguna(); pull(); if (r.sandi_awal) showPass('Pengguna dibuat', r.sandi_awal); else { closeSheet(); toast('Tersimpan', 'ok'); } }).catch(function (e) { var x = $('#u-err'); x.textContent = e.message; x.hidden = false; }); };
A.ureset = function (el) { var pw = prompt('Sandi baru untuk pengguna ini (kosongkan = dibuat acak, min. 8 karakter huruf+angka):'); if (pw === null) return; call('admin.resetPin', { id: el.dataset.id, sandi: pw.trim() || undefined }).then(function (r) { showPass('Sandi direset', r.sandi_awal); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.pgsave = function (el) {
  var ls = function (k) { return JSON.stringify(val('pg-' + k).split('\n').map(function (x) { return x.trim(); }).filter(Boolean)); };
  busy(el, true); call('pengaturan.save', { nilai: { nama_lembaga: val('pg-nama_lembaga'), nama_unit: val('pg-nama_unit'), alamat_lembaga: val('pg-alamat_lembaga'), tahun_ajaran: val('pg-tahun_ajaran'), daftar_kegiatan: ls('daftar_kegiatan'), topik_bimbingan: ls('topik_bimbingan'), jenjang_aktif: ls('jenjang_aktif'), batas_foto_harian: val('pg-batas_foto_harian'), min_client_version: val('pg-min_client_version') } }).then(function () { busy(el, false); toast('Pengaturan tersimpan', 'ok'); pull(); }).catch(function (e) { busy(el, false); toast(e.message, 'bad'); });
};
A.tgsave = function () { var t = val('tg-tok').trim(); if (!t) return; call('rahasia.simpan', { kunci: 'TELEGRAM_BOT_TOKEN', nilai: t }).then(function (r) { $('#tg-tok').value = ''; toast('Token tersimpan (' + r.tampil + ')', 'ok'); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.rotasi = function () { if (!confirm('Semua pengguna akan keluar dan harus direset sandinya. Lanjutkan?')) return; call('admin.rotasiSecret').then(function (r) { alert(r.catatan); logout(); }).catch(function (e) { toast(e.message, 'bad'); }); };
A.backup = function (el) { busy(el, true); call('backup', {}, { timeout: 60000 }).then(function (r) { busy(el, false); toast(r.ok ? 'Backup dibuat: ' + r.nama : 'Folder backup belum disiapkan', r.ok ? 'ok' : 'bad'); }).catch(function (e) { busy(el, false); toast(e.message, 'bad'); }); };

var IN = {
  q: function (v) { S.q = v; var l = $('#siswa-list'); if (l) l.innerHTML = listSiswa(); },
  pq: function (v) { S.pq = v; var c = $('#p-body'), pos = $('#pq').selectionStart; PANEL.siswa(); var n = $('#pq'); n.focus(); n.setSelectionRange(pos, pos); },
  pm: function (v) { if (v) { S.prekap = v; PANEL.rekap(); } },
  'ab-tgl': function (v) { if (!v) return; S.ses.tgl = v; sesLoad(); renderView('absensi'); }, 'ab-jam': function (v) { S.ses.jam = v; }, 'ab-keg': function (v) { S.ses.kegiatan = v; sesLoad(); renderView('absensi'); }, 'ab-alasan': function (v) { S.ses.alasan = v; },
  cat: function (v, el) { S.ses.cat[el.dataset.id] = v; },
  cnt: function (v, el) { var c = $('#' + el.dataset.c); if (c) c.textContent = v.length + '/' + el.maxLength; updStp(); },
  stp: function () { updStp(); },
  lap: function (v, el) { S.lap[el.dataset.k] = v; var o = $('#lap-out'); if (o) o.innerHTML = lapOut(); }
};

/* ---------- Auth & siklus aplikasi ---------- */
function loadCache() {
  var id = S.user.id; S.ver = LS.g('ver:' + id, {}); S.box = LS.g('box:' + id, []); S.last = LS.g('last:' + id, null);
  var c = S.user.peran === 'WaliAsuh' ? LS.g('srv:' + id, null) : null; S.srv = c || EMPTY();
  if (!c) S.ver = {};
}
function applyBoot(r) { S.srv = { siswa: r.siswa, absensi: r.absensi, bimbingan: r.bimbingan, wali: r.wali, pengaturan: r.pengaturan }; S.ver = r.ver; S.hari = r.hari_ini; S.last = Date.now(); S.user = Object.assign(S.user, r.user); LS.s('user', S.user); persist(); rebuild(); markDirty(); }
function tokExp() { try { var p = S.tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(p + '==='.slice((p.length + 3) % 4))).exp; } catch (e) { return 0; } }
var timers = [];
function enter(fresh) {
  var staff = S.user.peran !== 'WaliAsuh'; document.body.classList.toggle('panel', staff); apply();
  $('#av').textContent = ini(S.user.nama); $('#brand-s').textContent = (S.srv.pengaturan && S.srv.pengaturan.nama_lembaga) || 'Sekolah Rakyat';
  S.stack = []; if (staff) { S.pv = S.pv || 'dash'; pnav(); }
  rebuild(); markDirty(); go(staff ? 'p' : 'beranda', {}, false);
  var have = S.srv.siswa.length || S.srv.pengaturan.kegiatan.length;
  var p = (fresh || !have) ? call('bootstrap').then(applyBoot) : pull(true);
  p.then(function () { $('#brand-s').textContent = S.srv.pengaturan.nama_lembaga || 'Sekolah Rakyat'; renderNow(); if (S.view === 'p') renderView('p'); setSync(); trySync(); }).catch(function (e) { if (e.code === 'NET') toast('Offline — memakai data tersimpan.'); });
  if (tokExp() - Date.now() < 7 * 86400000) call('auth.refresh').then(function (r) { S.tok = r.token; LS.s('tok', S.tok); }).catch(function () {});
  timers.forEach(clearInterval); timers = [setInterval(function () { if (!document.hidden && S.online && S.tok) { pull(true).then(function () { renderNow(); setSync(); }); trySync(); } }, 60000)];
  setSync();
}
function logout(msg) {
  var id = S.user && S.user.id; if (id) { LS.r('srv:' + id); LS.r('swr:' + id + ':dash'); }
  S.tok = null; LS.r('tok'); LS.r('user'); S.user = null; S.srv = EMPTY(); S.box = S.box; S.stack = []; S.ses = null; stopCam(); timers.forEach(clearInterval); document.body.classList.remove('panel'); closeSheet();
  go('login', {}, false); renderView('login'); if (msg) { var e = $('#lg-err'); if (e) { e.textContent = msg; e.hidden = false; } }
}
function bind() {
  document.addEventListener('click', function (ev) { var el = ev.target.closest('[data-act]'); if (!el || el.tagName === 'INPUT' && el.type === 'checkbox') return; var f = A[el.dataset.act]; if (f) { ev.preventDefault(); f(el, ev); } });
  document.addEventListener('change', function (ev) { var el = ev.target; if (el.type === 'checkbox' && el.dataset.act && A[el.dataset.act]) return A[el.dataset.act](el, ev); if (el.id === 'camf' && el.files && el.files[0]) { var r = new FileReader(); r.onload = function () { var im = new Image(); im.onload = function () { var d = shootFrom(im), max = S.srv.pengaturan.batas_foto || 3; if (d && S.kj.fotos.length < max) { S.kj.fotos.push(d); S.kj.src = 'input'; $('#slots').innerHTML = slotsHtml(max); } el.value = ''; }; im.src = r.result; }; r.readAsDataURL(el.files[0]); return; } if (el.id === 'csvf' && el.files && el.files[0]) { var rd = new FileReader(); rd.onload = function () { csvImport(String(rd.result)); el.value = ''; }; rd.readAsText(el.files[0]); return; } var k = el.dataset.in; if (k && IN[k] && !(el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'search')) IN[k](el.value, el); });
  document.addEventListener('input', function (ev) { var el = ev.target, k = el.dataset && el.dataset.in; if (k && IN[k] && (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'search')) IN[k](el.value, el); });
  document.addEventListener('submit', function (ev) {
    ev.preventDefault(); var f = ev.target.id;
    if (f === 'f-login') { var b = $('#lg-btn'), e = $('#lg-err'); e.hidden = true; var em = val('lg-email').trim(), pw = val('lg-pass'); if (!em || !pw) { e.textContent = 'Email dan kata sandi wajib diisi.'; e.hidden = false; return; } busy(b, true, 'Masuk…');
      call('auth.login', { email: em, password: pw }).then(function (r) { var other = S.user && S.user.id !== r.user.id; S.tok = r.token; S.user = r.user; LS.s('tok', S.tok); LS.s('user', S.user); loadCache(); if (r.user.must_change) { busy(b, false); go('ganti', {}, false); renderView('ganti'); return; } return enter(true); }).catch(function (x) { busy(b, false); e.textContent = x.message || 'Gagal masuk.'; e.hidden = false; }); }
    else if (f === 'f-ganti') { var b2 = $('#gp-btn'), e2 = $('#gp-err'); e2.hidden = true; var n = val('gp-baru'); if (n !== val('gp-ulang')) { e2.textContent = 'Kata sandi baru tidak sama.'; e2.hidden = false; return; } busy(b2, true);
      call('auth.changePin', { lama: val('gp-lama'), baru: n }).then(function (r) { S.tok = r.token; S.user = r.user; LS.s('tok', S.tok); LS.s('user', S.user); toast('Kata sandi diganti', 'ok'); return enter(true); }).catch(function (x) { busy(b2, false); e2.textContent = x.message; e2.hidden = false; }); }
  });
  $('#ov').addEventListener('click', function (ev) { if (ev.target.id === 'ov') closeSheet(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeSheet(); });
  $$('.tab').forEach(function (t) { t.addEventListener('click', function () { S.stack = []; if (t.dataset.go === 'absensi') { S.ses = S.ses && S.ses.st ? S.ses : null; } if (t.dataset.go === 'bimbingan') S.tlFil = S.tlFil || 'semua'; go(t.dataset.go, {}, false); }); });
  window.addEventListener('online', function () { S.online = true; setSync(); schedSync(300); });
  window.addEventListener('offline', function () { S.online = false; setSync(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.tok) { pull(true).then(function () { renderNow(); setSync(); }); trySync(); } });
  window.addEventListener('error', function (e) { try { if (S.tok) call('klien.lapor', { kode: 'JS', pesan: String(e.message).slice(0, 150) }).catch(function () {}); } catch (x) {} });
}
function init() {
  apply(); bind(); IDB.open();
  if ('serviceWorker' in navigator && window.isSecureContext) { try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) {} }
  try { call('ping').catch(function () {}); } catch (e) {} /* pemanasan server GAS */
  if (S.tok && S.user) { loadCache(); $('#splash').remove(); enter(false); }
  else { $('#splash').remove(); go('login', {}, false); renderView('login'); }
}
window.__esim = { S: S, A: A, go: go, pull: pull, trySync: trySync, call: call };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
