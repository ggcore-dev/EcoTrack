/* EcoTrack — app.js
 * Vanilla JS (ES6+). Veriler yalnızca tarayıcının localStorage alanında tutulur.
 * Kullanıcı girdileri asla innerHTML ile yazılmaz; yalnızca textContent kullanılır.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Sabitler                                                            */
  /* ------------------------------------------------------------------ */
  const STORAGE_KEY = 'ecotrack:v1';
  const SCHEMA_VERSION = 1;
  const LIMITS = { water: 1000000, energy: 100000 }; // L ve kWh üst sınırları (makul değer denetimi)
  const MAX_RECORDS = 20000;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const PAGE_SIZE = 50;
  const TASK_POINTS = 10; // yalnızca oyunlaştırma puanı

  const TASKS = [
    { id: 'isik', cat: 'enerji', title: 'Kullanılmayan ışıkları kapat', desc: 'Odadan çıkarken ışığı söndür.' },
    { id: 'dis-fircasi', cat: 'su', title: 'Diş fırçalarken musluğu kapalı tut', desc: 'Suyu yalnızca durulamak için aç.' },
    { id: 'su-azalt', cat: 'su', title: 'Gereksiz su kullanımını azalt', desc: 'Örneğin sabunlanırken suyu kapat; ihtiyacın olan suyu kısıtlama.' },
    { id: 'cihaz', cat: 'enerji', title: 'Kullanılmayan elektronik cihazları kapat', desc: 'Şarj aletlerini ve bekleme modundaki cihazları kontrol et.' },
    { id: 'sise', cat: 'atik', title: 'Yeniden kullanılabilir su şişesi kullan', desc: 'Tek kullanımlık şişe yerine kendi şişeni doldur.' },
    { id: 'ayristir', cat: 'atik', title: 'Atıkları uygun şekilde ayrıştır', desc: 'Kâğıt, plastik, cam ve metali ayrı biriktir.' },
    { id: 'yuru', cat: 'ulasim', title: 'Kısa mesafelerde yürümeyi veya bisikleti değerlendir', desc: 'Güvenli ve uygunsa arabaya binmeden git.' },
    { id: 'tek-kullanim', cat: 'atik', title: 'Tek kullanımlık ürün tüketimini azalt', desc: 'Poşet, pipet, bardak gibi ürünlere alternatif bul.' }
  ];
  const CAT_LABELS = { su: 'Su', enerji: 'Enerji', atik: 'Atık', ulasim: 'Ulaşım' };

  const CFG = {
    water: { label: 'Su', goalDaily: 'waterDaily', goalWeekly: 'waterWeekly', limit: LIMITS.water, unitLabel: 'L', chartClass: 'bar-water' },
    energy: { label: 'Enerji', goalDaily: 'energyDaily', goalWeekly: 'energyWeekly', limit: LIMITS.energy, unitLabel: 'kWh', chartClass: 'bar-energy' }
  };
  const ROUTES = ['home', 'dashboard', 'water', 'energy', 'tasks', 'info', 'settings'];

  /* ------------------------------------------------------------------ */
  /* Yardımcılar: DOM                                                    */
  /* ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, String(attrs[k])));
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }
  function iconEl(name) {
    const s = svgEl('svg', { 'class': 'icon icon-stroke', 'aria-hidden': 'true', focusable: 'false' });
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ------------------------------------------------------------------ */
  /* Yardımcılar: tarih, sayı, biçim                                     */
  /* ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  function toDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return toDateStr(new Date()); }
  function parseDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const p = s.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    if (d.getFullYear() !== p[0] || d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) return null;
    if (p[0] < 2000 || p[0] > 2100) return null;
    return d;
  }
  function addDays(s, n) { const d = parseDateStr(s); d.setDate(d.getDate() + n); return toDateStr(d); }
  function weekStart(s) { const d = parseDateStr(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toDateStr(d); } // Pazartesi
  function weekDates(s) { const st = weekStart(s); return Array.from({ length: 7 }, (_, i) => addDays(st, i)); }
  function lastDays(s, n) { return Array.from({ length: n }, (_, i) => addDays(s, i - (n - 1))); }
  const round6 = (n) => Math.round(n * 1e6) / 1e6;

  /** Türkçe ve nokta ondalıklı sayıları ayrıştırır. Geçersizse NaN döner. */
  function parseNumber(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
    if (typeof input !== 'string') return NaN;
    let s = input.trim().replace(/\s/g, '');
    if (!s) return NaN;
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') { s = s.slice(1); }
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, '');
    else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
  }
  const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
  const fmtNum = (n) => nf.format(round6(n));
  const fmtWater = (l) => (l >= 1000 ? fmtNum(l) + ' L (' + fmtNum(l / 1000) + ' m³)' : fmtNum(l) + ' L');
  const fmtEnergy = (k) => fmtNum(k) + ' kWh';
  const fmtFor = (kind, v) => (kind === 'water' ? fmtWater(v) : fmtEnergy(v));
  function fmtDate(s) {
    const d = parseDateStr(s);
    return d ? new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(d) : s;
  }
  function fmtDayShort(s) { return new Intl.DateTimeFormat('tr-TR', { weekday: 'short' }).format(parseDateStr(s)); }
  function fmtDayMonth(s) { return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(parseDateStr(s)); }
  const inputNum = (n) => String(n).replace('.', ',');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

  /* ------------------------------------------------------------------ */
  /* Veri şeması, doğrulama                                              */
  /* ------------------------------------------------------------------ */
  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      water: [],
      energy: [],
      goals: { waterDaily: null, waterWeekly: null, energyDaily: null, energyWeekly: null, tasksWeekly: null },
      tasks: {},
      settings: { theme: 'system' }
    };
  }

  /** Form girdisini doğrular. { ok, errors, value } döner. */
  function validateRecord(kind, input, today) {
    const errors = {};
    const out = {};
    const date = String(input.date || '').trim();
    if (!date) errors.date = 'Tarih seçmelisin.';
    else if (!parseDateStr(date)) errors.date = 'Geçerli bir tarih gir (2000 ile 2100 arasında).';
    else if (date > (today || todayStr())) errors.date = 'Gelecekteki bir tarih için kayıt eklenemez.';
    else out.date = date;

    const type = String(input.type || '').trim();
    if (!type) errors.type = 'Kullanım türünü seç.';
    else if (type.length > 60) errors.type = 'Kullanım türü en fazla 60 karakter olabilir.';
    else out.type = type;

    const unit = kind === 'water' ? (input.unit === 'm3' ? 'm3' : 'L') : 'kWh';
    const raw = typeof input.amount === 'number' ? input.amount : parseNumber(String(input.amount == null ? '' : input.amount));
    if (input.amount === '' || input.amount == null || String(input.amount).trim() === '') errors.amount = 'Miktar girmelisin.';
    else if (!Number.isFinite(raw)) errors.amount = 'Miktar geçerli bir sayı olmalı (örn. 45 veya 4,5).';
    else if (raw < 0) errors.amount = 'Miktar negatif olamaz.';
    else if (raw === 0) errors.amount = 'Miktar sıfırdan büyük olmalı.';
    else {
      const canonical = round6(kind === 'water' && unit === 'm3' ? raw * 1000 : raw);
      if (canonical > LIMITS[kind]) errors.amount = 'Bu değer gerçekçi görünmüyor. Birimi kontrol et (en fazla ' + fmtNum(LIMITS[kind]) + ' ' + CFG[kind].unitLabel + ').';
      else { out.amount = canonical; out.enteredAmount = round6(raw); out.enteredUnit = unit; }
    }

    const note = String(input.note || '').trim();
    if (note.length > 200) errors.note = 'Açıklama en fazla 200 karakter olabilir.';
    else out.note = note;

    out.estimated = !!input.estimated;
    return { ok: Object.keys(errors).length === 0, errors: errors, value: out };
  }

  function sanitizeRecord(kind, r, usedIds) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.date !== 'string' || !parseDateStr(r.date)) return null;
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || !(r.amount > 0) || r.amount > LIMITS[kind]) return null;
    const allowedUnits = kind === 'water' ? ['L', 'm3'] : ['kWh'];
    let enteredUnit = allowedUnits.indexOf(r.enteredUnit) >= 0 ? r.enteredUnit : null;
    let enteredAmount = typeof r.enteredAmount === 'number' && Number.isFinite(r.enteredAmount) && r.enteredAmount > 0 ? r.enteredAmount : null;
    const unitFactor = kind === 'water' && enteredUnit === 'm3' ? 1000 : 1;
    if (!enteredUnit || enteredAmount === null || Math.abs(enteredAmount * unitFactor - r.amount) > 1e-6 * Math.max(1, r.amount)) {
      enteredUnit = kind === 'water' ? 'L' : 'kWh';
      enteredAmount = r.amount;
    }
    let id = typeof r.id === 'string' && r.id && r.id.length <= 64 ? r.id : uid();
    while (usedIds.has(id)) id = uid();
    usedIds.add(id);
    const type = typeof r.type === 'string' && r.type.trim() ? r.type.trim().slice(0, 60) : 'Diğer';
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : '';
    const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
    return { id: id, date: r.date, type: type, amount: round6(r.amount), enteredAmount: enteredAmount, enteredUnit: enteredUnit, estimated: r.estimated === true, note: note, createdAt: createdAt };
  }

  /** Bilinmeyen kaynaktan gelen veriyi temizler. { ok, data, dropped, error } döner. */
  function sanitizeData(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'Dosya beklenen EcoTrack yedek biçiminde değil.' };
    if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) return { ok: false, error: 'Sürüm bilgisi eksik veya geçersiz.' };
    if (obj.version > SCHEMA_VERSION) return { ok: false, error: 'Bu yedek EcoTrack\'in daha yeni bir sürümünden. Lütfen uygulamayı güncelle.' };
    const data = defaultState();
    let dropped = 0;
    ['water', 'energy'].forEach((kind) => {
      const list = obj[kind];
      if (list === undefined) return;
      if (!Array.isArray(list)) { dropped += 1; return; }
      const used = new Set();
      list.slice(0, MAX_RECORDS).forEach((r) => {
        const c = sanitizeRecord(kind, r, used);
        if (c) data[kind].push(c); else dropped += 1;
      });
      if (list.length > MAX_RECORDS) dropped += list.length - MAX_RECORDS;
    });
    const g = obj.goals && typeof obj.goals === 'object' && !Array.isArray(obj.goals) ? obj.goals : {};
    ['waterDaily', 'waterWeekly'].forEach((k) => { if (typeof g[k] === 'number' && g[k] > 0 && g[k] <= LIMITS.water) data.goals[k] = round6(g[k]); else if (g[k] != null) dropped += 1; });
    ['energyDaily', 'energyWeekly'].forEach((k) => { if (typeof g[k] === 'number' && g[k] > 0 && g[k] <= LIMITS.energy) data.goals[k] = round6(g[k]); else if (g[k] != null) dropped += 1; });
    if (Number.isInteger(g.tasksWeekly) && g.tasksWeekly >= 1 && g.tasksWeekly <= TASKS.length * 7) data.goals.tasksWeekly = g.tasksWeekly;
    else if (g.tasksWeekly != null) dropped += 1;
    const ids = new Set(TASKS.map((t) => t.id));
    if (obj.tasks && typeof obj.tasks === 'object' && !Array.isArray(obj.tasks)) {
      Object.keys(obj.tasks).forEach((d) => {
        const arr = obj.tasks[d];
        if (!parseDateStr(d) || !Array.isArray(arr)) { dropped += 1; return; }
        const clean = Array.from(new Set(arr.filter((x) => typeof x === 'string' && ids.has(x))));
        if (clean.length) data.tasks[d] = clean;
        if (clean.length !== arr.length) dropped += arr.length - clean.length;
      });
    } else if (obj.tasks != null) dropped += 1;
    const th = obj.settings && typeof obj.settings === 'object' ? obj.settings.theme : null;
    data.settings.theme = th === 'light' || th === 'dark' || th === 'system' ? th : 'system';
    return { ok: true, data: data, dropped: dropped };
  }

  /* ------------------------------------------------------------------ */
  /* Depolama                                                            */
  /* ------------------------------------------------------------------ */
  let state = defaultState();
  let storageOk = true;

  function showBanner(msg) { const b = $('storageBanner'); if (!b) return; b.textContent = msg; b.hidden = false; }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch (e) {
      storageOk = false;
      showBanner('Tarayıcı depolaması kullanılamıyor. Kayıtların yalnızca bu sekme açıkken tutulur; sayfayı kapatınca kaybolur.');
      return defaultState();
    }
    if (raw === null) return defaultState();
    try {
      const res = sanitizeData(JSON.parse(raw));
      if (!res.ok) throw new Error(res.error);
      if (res.dropped > 0) showBanner(res.dropped + ' bozuk veya geçersiz öğe kayıtlardan çıkarıldı; diğer verilerin korundu.');
      return res.data;
    } catch (e) {
      try { localStorage.setItem(STORAGE_KEY + ':corrupt-backup', raw); } catch (_) { /* yoksay */ }
      showBanner('Kaydedilmiş veriler okunamadı, bu yüzden boş bir başlangıç yapıldı. Bozuk veri silinmedi; yedek anahtarında saklandı.');
      return defaultState();
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
    catch (e) {
      storageOk = false;
      toast('Kayıt cihaza yazılamadı (depolama dolu veya kapalı olabilir). Yedek almanı öneririz.', 'error');
      return false;
    }
  }

  function buildExport() {
    return JSON.stringify(Object.assign({ app: 'EcoTrack', exportedAt: new Date().toISOString() }, state), null, 2);
  }

  /* ------------------------------------------------------------------ */
  /* Bildirim ve onay penceresi                                          */
  /* ------------------------------------------------------------------ */
  function toast(msg, type) {
    const region = $('toastRegion');
    if (!region) return;
    const t = el('div', { 'class': 'toast' + (type ? ' ' + type : ''), text: msg });
    region.appendChild(t);
    while (region.children.length > 3) region.removeChild(region.firstChild);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
  }

  let confirmResolve = null;
  function confirmAction(opts) {
    return new Promise((resolve) => {
      if (confirmResolve) confirmResolve(false);
      confirmResolve = resolve;
      $('confirmTitle').textContent = opts.title;
      $('confirmMessage').textContent = opts.message;
      $('confirmOk').textContent = opts.okLabel || 'Onayla';
      const d = $('confirmDialog');
      if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
      $('confirmCancel').focus();
    });
  }
  function closeConfirm(value) {
    const d = $('confirmDialog');
    if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open');
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(value);
  }

  /* ------------------------------------------------------------------ */
  /* Hesaplamalar                                                        */
  /* ------------------------------------------------------------------ */
  function sumRange(list, dates) {
    const set = new Set(dates);
    let total = 0, count = 0;
    list.forEach((r) => { if (set.has(r.date)) { total += r.amount; count += 1; } });
    return { total: round6(total), count: count };
  }
  function tasksDoneOn(date) { return (state.tasks[date] || []).length; }
  function tasksDoneInWeek(date) { return weekDates(date).reduce((s, d) => s + tasksDoneOn(d), 0); }

  /* ------------------------------------------------------------------ */
  /* İlerleme çubukları                                                  */
  /* ------------------------------------------------------------------ */
  /** item: { label, current, goal, hasData, kind: 'limit'|'target', fmt, unitText } */
  function renderProgress(container, items) {
    clear(container);
    items.forEach((it) => {
      const wrap = el('div', { 'class': 'progress-item' });
      if (!it.goal) {
        wrap.appendChild(el('div', { 'class': 'progress-head' }, [el('span', { text: it.label })]));
        wrap.appendChild(el('p', { 'class': 'progress-note', text: 'Hedef belirlenmedi.' }));
        container.appendChild(wrap);
        return;
      }
      const pct = it.hasData === false ? 0 : (it.current / it.goal) * 100;
      const shown = Math.round(pct);
      let status = '';
      let cls = '';
      if (it.hasData === false) status = 'Henüz kayıt yok.';
      else if (it.kind === 'target') status = pct >= 100 ? 'Hedef tamamlandı.' : 'Hedefe ' + fmtNum(Math.max(0, it.goal - it.current)) + ' ' + (it.unitText || '') + ' kaldı.';
      else if (pct > 100) { status = 'Hedefi aştın (' + fmtNum(it.current - it.goal) + ' ' + it.unitText + ' fazla).'; cls = ' over'; }
      else if (pct >= 80) { status = 'Hedefe yaklaştın.'; cls = ' near'; }
      else status = 'Hedefin altındasın.';
      const text = it.label + ': ' + it.fmt(it.current) + ' / ' + it.fmt(it.goal) + ' (%' + shown + '). ' + status;
      const bar = el('div', {
        'class': 'progress-bar' + cls, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100,
        'aria-valuenow': Math.min(100, shown), 'aria-valuetext': text, 'aria-label': it.label
      });
      bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
      wrap.appendChild(el('div', { 'class': 'progress-head' }, [
        el('span', { text: it.label }),
        el('span', { text: it.hasData === false ? '—' : it.fmt(it.current) + ' / ' + it.fmt(it.goal) + ' · %' + shown })
      ]));
      wrap.appendChild(el('div', { 'class': 'progress' }, [bar]));
      wrap.appendChild(el('p', { 'class': 'progress-note', text: status }));
      container.appendChild(wrap);
    });
  }

  function limitItem(kind, period, t) {
    const cfg = CFG[kind];
    const dates = period === 'day' ? [t] : weekDates(t);
    const r = sumRange(state[kind], dates);
    return {
      label: (period === 'day' ? 'Bugün' : 'Bu hafta') + ' · ' + cfg.label,
      current: r.total, goal: state.goals[period === 'day' ? cfg.goalDaily : cfg.goalWeekly],
      hasData: r.count > 0, kind: 'limit', fmt: (v) => fmtFor(kind, v), unitText: cfg.unitLabel
    };
  }
  function taskWeekItem(t) {
    return { label: 'Bu hafta · Görevler', current: tasksDoneInWeek(t), goal: state.goals.tasksWeekly, hasData: true, kind: 'target', fmt: (v) => fmtNum(v) + ' görev', unitText: 'görev' };
  }

  /* ------------------------------------------------------------------ */
  /* Grafik                                                              */
  /* ------------------------------------------------------------------ */
  function renderBarChart(container, kind, t) {
    clear(container);
    const days = lastDays(t, 7);
    const cfg = CFG[kind];
    const values = days.map((d) => sumRange(state[kind], [d]).total);
    const count = sumRange(state[kind], days).count;
    if (!count) { container.appendChild(el('p', { 'class': 'empty-chart', text: 'Son 7 günde ' + cfg.label.toLowerCase() + ' kaydı yok.' })); return; }
    const max = Math.max.apply(null, values);
    const W = 420, H = 224, base = 170, maxH = 120;
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', focusable: 'false' });
    const summary = days.map((d, i) => fmtDayMonth(d) + ': ' + fmtFor(kind, values[i])).join('; ');
    svg.setAttribute('aria-label', cfg.label + ' tüketimi, son 7 gün. ' + summary);
    svg.appendChild(svgEl('line', { x1: 4, y1: base, x2: W - 4, y2: base, 'class': 'axis' }));
    days.forEach((d, i) => {
      const x = 12 + i * 58;
      const h = max > 0 ? Math.max(values[i] > 0 ? 3 : 0, (values[i] / max) * maxH) : 0;
      if (values[i] > 0) {
        const rect = svgEl('rect', { x: x, y: base - h, width: 40, height: h, rx: 5, 'class': cfg.chartClass + (d === t ? ' bar-today' : '') });
        rect.appendChild(svgEl('title', {}, [document.createTextNode(fmtDayMonth(d) + ': ' + fmtFor(kind, values[i]))]));
        svg.appendChild(rect);
      }
      const label = svgEl('text', { x: x + 20, y: base - h - 6, 'text-anchor': 'middle' });
      label.textContent = values[i] > 0 ? new Intl.NumberFormat('tr-TR', { maximumFractionDigits: values[i] >= 100 ? 0 : 1 }).format(values[i]) : '–';
      svg.appendChild(label);
      const wd = svgEl('text', { x: x + 20, y: base + 18, 'text-anchor': 'middle' });
      wd.textContent = fmtDayShort(d);
      svg.appendChild(wd);
      const dm = svgEl('text', { x: x + 20, y: base + 33, 'text-anchor': 'middle', 'class': 'dim' });
      dm.textContent = fmtDayMonth(d);
      svg.appendChild(dm);
    });
    const unit = svgEl('text', { x: 4, y: 14, 'class': 'dim' });
    unit.textContent = 'Birim: ' + cfg.unitLabel + ' (günlük toplam)';
    svg.appendChild(unit);
    container.appendChild(svg);
  }

  function compareText(kind, t) {
    const cur = sumRange(state[kind], lastDays(t, 7));
    const prev = sumRange(state[kind], lastDays(addDays(t, -7), 7));
    if (!cur.count) return '';
    if (!prev.count) return 'Önceki 7 gün için kayıt olmadığından karşılaştırma yapılamıyor.';
    const change = ((cur.total - prev.total) / prev.total) * 100;
    const word = change > 0 ? 'daha fazla' : change < 0 ? 'daha az' : 'aynı';
    const base = 'Son 7 gün toplamı ' + fmtFor(kind, cur.total) + '; önceki 7 gün ' + fmtFor(kind, prev.total) + '.';
    return change === 0 ? base + ' Değişim yok.' : base + ' Önceki 7 güne göre %' + fmtNum(Math.abs(change)) + ' ' + word + '.';
  }

  /* ------------------------------------------------------------------ */
  /* Kontrol paneli                                                      */
  /* ------------------------------------------------------------------ */
  function renderDashboard() {
    const t = todayStr();
    const hasAny = state.water.length > 0 || state.energy.length > 0 || Object.keys(state.tasks).length > 0;
    $('dashEmpty').hidden = hasAny;
    $('dashContent').hidden = !hasAny;
    if (!hasAny) return;

    ['water', 'energy'].forEach((kind) => {
      const cap = kind === 'water' ? 'Water' : 'Energy';
      const r = sumRange(state[kind], [t]);
      $('dash' + cap + 'Today').textContent = r.count ? fmtFor(kind, r.total) : 'Kayıt yok';
      $('dash' + cap + 'TodayNote').textContent = r.count ? r.count + ' kayıt' : 'Bugün için ' + CFG[kind].label.toLowerCase() + ' kaydı eklenmedi.';
      renderBarChart($(kind === 'water' ? 'chartWater' : 'chartEnergy'), kind, t);
      $(kind + 'Compare').textContent = compareText(kind, t);
    });
    const done = tasksDoneOn(t);
    $('dashTasksToday').textContent = done + ' / ' + TASKS.length;
    $('dashTasksTodayNote').textContent = done ? 'Bugün tamamlanan görev sayısı.' : 'Bugün henüz görev tamamlanmadı.';

    renderProgress($('dashProgress'), [
      limitItem('water', 'day', t), limitItem('water', 'week', t),
      limitItem('energy', 'day', t), limitItem('energy', 'week', t),
      taskWeekItem(t)
    ]);

    const all = [];
    state.water.forEach((r) => all.push({ kind: 'water', r: r }));
    state.energy.forEach((r) => all.push({ kind: 'energy', r: r }));
    all.sort((a, b) => b.r.createdAt - a.r.createdAt);
    const list = $('recentList');
    clear(list);
    if (!all.length) list.appendChild(el('li', { 'class': 'muted', text: 'Henüz su veya enerji kaydı yok.' }));
    all.slice(0, 6).forEach((x) => {
      list.appendChild(el('li', { 'class': 'record' }, [el('div', { 'class': 'record-main' }, [
        el('div', { 'class': 'record-title' }, [
          iconEl(x.kind === 'water' ? 'water' : 'bolt'),
          document.createTextNode(' ' + CFG[x.kind].label + ' · ' + x.r.type + ' · ' + fmtFor(x.kind, x.r.amount)),
          x.r.estimated ? el('span', { 'class': 'badge est', text: 'Tahmin' }) : null
        ]),
        el('div', { 'class': 'record-meta', text: fmtDate(x.r.date) + (x.r.note ? ' — ' + x.r.note : '') })
      ])]));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Su / Enerji modülleri                                               */
  /* ------------------------------------------------------------------ */
  const editing = { water: null, energy: null };
  const shown = { water: PAGE_SIZE, energy: PAGE_SIZE };

  function fieldName(kind, f) { return kind + f; }
  function setError(kind, field, msg) {
    const input = $(fieldName(kind, field));
    const err = $(fieldName(kind, field) + 'Error');
    if (err) err.textContent = msg || '';
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }
  function clearErrors(kind) { ['Date', 'Type', 'Amount', 'Note'].forEach((f) => setError(kind, f, '')); }

  function resetForm(kind) {
    editing[kind] = null;
    $(kind + 'Form').reset();
    $(kind + 'Date').value = todayStr();
    $(kind + 'Date').max = todayStr();
    $(kind + 'Submit').textContent = 'Kaydı ekle';
    $(kind + 'FormTitle').textContent = 'Yeni ' + CFG[kind].label.toLowerCase() + ' kaydı';
    $(kind + 'Cancel').hidden = true;
    clearErrors(kind);
  }

  function startEdit(kind, id) {
    const r = state[kind].find((x) => x.id === id);
    if (!r) return;
    editing[kind] = id;
    clearErrors(kind);
    $(kind + 'Date').value = r.date;
    const sel = $(kind + 'Type');
    if (!Array.prototype.some.call(sel.options, (o) => o.value === r.type || o.text === r.type)) sel.appendChild(el('option', { text: r.type }));
    sel.value = r.type;
    $(kind + 'Amount').value = inputNum(r.enteredAmount);
    if (kind === 'water') $('waterUnit').value = r.enteredUnit === 'm3' ? 'm3' : 'L';
    $(kind + 'Estimated').checked = !!r.estimated;
    $(kind + 'Note').value = r.note || '';
    $(kind + 'Submit').textContent = 'Kaydı güncelle';
    $(kind + 'FormTitle').textContent = CFG[kind].label + ' kaydını düzenle';
    $(kind + 'Cancel').hidden = false;
    $(kind + 'Form').scrollIntoView({ block: 'center' });
    $(kind + 'Amount').focus();
  }

  function handleSubmit(kind, e) {
    e.preventDefault();
    const input = {
      date: $(kind + 'Date').value, type: $(kind + 'Type').value, amount: $(kind + 'Amount').value,
      unit: kind === 'water' ? $('waterUnit').value : 'kWh', estimated: $(kind + 'Estimated').checked, note: $(kind + 'Note').value
    };
    const res = validateRecord(kind, input, todayStr());
    clearErrors(kind);
    const order = ['date', 'type', 'amount', 'note'];
    order.forEach((f) => setError(kind, f.charAt(0).toUpperCase() + f.slice(1), res.errors[f] || ''));
    if (!res.ok) {
      const first = order.find((f) => res.errors[f]);
      $(kind + first.charAt(0).toUpperCase() + first.slice(1)).focus();
      return;
    }
    const v = res.value;
    if (editing[kind]) {
      const r = state[kind].find((x) => x.id === editing[kind]);
      if (r) Object.assign(r, { date: v.date, type: v.type, amount: v.amount, enteredAmount: v.enteredAmount, enteredUnit: v.enteredUnit, estimated: v.estimated, note: v.note });
      toast('Kayıt güncellendi.', 'success');
    } else {
      state[kind].push({ id: uid(), date: v.date, type: v.type, amount: v.amount, enteredAmount: v.enteredAmount, enteredUnit: v.enteredUnit, estimated: v.estimated, note: v.note, createdAt: Date.now() });
      toast('Kayıt eklendi.', 'success');
    }
    save();
    resetForm(kind);
    renderModule(kind);
    $(kind + 'Amount').focus();
  }

  async function deleteRecord(kind, id) {
    const r = state[kind].find((x) => x.id === id);
    if (!r) return;
    const ok = await confirmAction({
      title: 'Kaydı sil', okLabel: 'Sil',
      message: fmtDate(r.date) + ' tarihli "' + r.type + '" kaydı (' + fmtFor(kind, r.amount) + ') silinecek. Bu işlem geri alınamaz.'
    });
    if (!ok) return;
    state[kind] = state[kind].filter((x) => x.id !== id);
    if (editing[kind] === id) resetForm(kind);
    save();
    renderModule(kind);
    toast('Kayıt silindi.');
  }

  function renderModule(kind) {
    const t = todayStr();
    const cfg = CFG[kind];
    const today = sumRange(state[kind], [t]);
    const week = sumRange(state[kind], weekDates(t));
    $(kind + 'Today').textContent = today.count ? fmtFor(kind, today.total) : 'Kayıt yok';
    $(kind + 'Week').textContent = week.count ? fmtFor(kind, week.total) : 'Kayıt yok';
    $(kind + 'Count').textContent = String(state[kind].length);
    renderProgress($(kind + 'GoalStatus'), [limitItem(kind, 'day', t), limitItem(kind, 'week', t)]);

    const gd = state.goals[cfg.goalDaily], gw = state.goals[cfg.goalWeekly];
    if (document.activeElement !== $(kind + 'GoalDaily')) $(kind + 'GoalDaily').value = gd ? inputNum(gd) : '';
    if (document.activeElement !== $(kind + 'GoalWeekly')) $(kind + 'GoalWeekly').value = gw ? inputNum(gw) : '';

    const sorted = state[kind].slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    $(kind + 'Empty').hidden = sorted.length > 0;
    const list = $(kind + 'List');
    clear(list);
    sorted.slice(0, shown[kind]).forEach((r) => {
      const desc = fmtDate(r.date) + ' · ' + r.type + ' · ' + fmtFor(kind, r.amount);
      const amountText = r.enteredUnit === 'm3' ? fmtNum(r.enteredAmount) + ' m³ (= ' + fmtNum(r.amount) + ' L)' : fmtFor(kind, r.amount);
      list.appendChild(el('li', { 'class': 'record', 'data-id': r.id }, [
        el('div', { 'class': 'record-main' }, [
          el('div', { 'class': 'record-title' }, [document.createTextNode(r.type + ' · ' + amountText), r.estimated ? el('span', { 'class': 'badge est', text: 'Tahmin' }) : null]),
          el('div', { 'class': 'record-meta', text: fmtDate(r.date) + (r.note ? ' — ' + r.note : '') })
        ]),
        el('div', { 'class': 'record-actions' }, [
          el('button', { type: 'button', 'class': 'btn btn-ghost btn-sm', 'aria-label': 'Düzenle: ' + desc, 'data-act': 'edit', onclick: () => startEdit(kind, r.id) }, [iconEl('edit'), document.createTextNode('Düzenle')]),
          el('button', { type: 'button', 'class': 'btn btn-ghost btn-sm', 'aria-label': 'Sil: ' + desc, 'data-act': 'delete', onclick: () => deleteRecord(kind, r.id) }, [iconEl('trash'), document.createTextNode('Sil')])
        ])
      ]));
    });
    $(kind + 'More').hidden = sorted.length <= shown[kind];
  }

  function handleGoalSubmit(kind, e) {
    e.preventDefault();
    const cfg = CFG[kind];
    const errEl = $(kind + 'GoalError');
    const parse = (s) => (String(s).trim() === '' ? null : parseNumber(s));
    const d = parse($(kind + 'GoalDaily').value), w = parse($(kind + 'GoalWeekly').value);
    let msg = '';
    [d, w].forEach((v) => {
      if (v === null || msg) return;
      if (!Number.isFinite(v)) msg = 'Hedef geçerli bir sayı olmalı.';
      else if (v <= 0) msg = 'Hedef sıfırdan büyük olmalı.';
      else if (v > cfg.limit) msg = 'Hedef gerçekçi görünmüyor; en fazla ' + fmtNum(cfg.limit) + ' ' + cfg.unitLabel + ' girebilirsin.';
    });
    if (!msg && d !== null && w !== null && w < d) msg = 'Haftalık hedef, günlük hedeften küçük olamaz.';
    errEl.textContent = msg;
    [$(kind + 'GoalDaily'), $(kind + 'GoalWeekly')].forEach((i) => { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); });
    if (msg) { $(kind + 'GoalDaily').focus(); return; }
    state.goals[cfg.goalDaily] = d === null ? null : round6(d);
    state.goals[cfg.goalWeekly] = w === null ? null : round6(w);
    save();
    renderModule(kind);
    toast('Hedefler kaydedildi.', 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Görevler                                                            */
  /* ------------------------------------------------------------------ */
  let taskFilter = 'all';

  function toggleTask(id) {
    const t = todayStr();
    const list = (state.tasks[t] || []).slice();
    const idx = list.indexOf(id);
    const weekBefore = tasksDoneInWeek(t);
    let completed = false;
    if (idx >= 0) list.splice(idx, 1); else { list.push(id); completed = true; }
    if (list.length) state.tasks[t] = list; else delete state.tasks[t];
    save();
    renderTasks();
    const btn = document.querySelector('#taskList [data-task="' + id + '"] .task-check');
    if (btn) btn.focus();
    if (completed) {
      const goal = state.goals.tasksWeekly;
      const weekAfter = weekBefore + 1;
      if (goal && weekBefore < goal && weekAfter >= goal) toast('Tebrikler! Haftalık görev hedefine ulaştın (' + goal + ' görev).', 'success');
      else if (list.length === TASKS.length) toast('Bugünkü tüm görevleri tamamladın!', 'success');
    }
  }

  function renderTasks() {
    const t = todayStr();
    const doneIds = new Set(state.tasks[t] || []);
    const list = $('taskList');
    clear(list);
    TASKS.filter((k) => taskFilter === 'all' || k.cat === taskFilter).forEach((k) => {
      const done = doneIds.has(k.id);
      const btn = el('button', {
        type: 'button', 'class': 'task-check', 'aria-pressed': done ? 'true' : 'false',
        'aria-label': k.title + (done ? ' — tamamlandı, geri almak için seç' : ' — tamamlandı olarak işaretle'), onclick: () => toggleTask(k.id)
      }, [iconEl('check')]);
      list.appendChild(el('li', { 'class': 'task' + (done ? ' done' : ''), 'data-task': k.id }, [
        btn,
        el('div', { 'class': 'task-body' }, [
          el('p', { 'class': 'task-title', text: k.title }),
          el('p', { 'class': 'task-meta', text: CAT_LABELS[k.cat] + ' · ' + k.desc + (done ? ' · Tamamlandı' : '') })
        ])
      ]));
    });
    const done = doneIds.size;
    renderProgress($('taskProgress'), [{ label: 'Bugün · Görevler', current: done, goal: TASKS.length, hasData: true, kind: 'target', fmt: (v) => fmtNum(v) + ' görev', unitText: 'görev' }]);
    renderProgress($('taskWeekly'), [taskWeekItem(t)]);
    const wk = tasksDoneInWeek(t);
    $('taskPoints').textContent = 'Oyunlaştırma puanı — bugün: ' + done * TASK_POINTS + ', bu hafta: ' + wk * TASK_POINTS + '.';
    if (document.activeElement !== $('taskGoalInput')) $('taskGoalInput').value = state.goals.tasksWeekly ? String(state.goals.tasksWeekly) : '';
    document.querySelectorAll('#taskFilters .chip').forEach((c) => c.setAttribute('aria-pressed', c.getAttribute('data-filter') === taskFilter ? 'true' : 'false'));
  }

  function handleTaskGoal(e) {
    e.preventDefault();
    const raw = $('taskGoalInput').value.trim();
    let msg = '';
    let val = null;
    if (raw !== '') {
      const n = parseNumber(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) msg = 'Hedef tam sayı olmalı (örn. 20).';
      else if (n < 1) msg = 'Hedef en az 1 olmalı.';
      else if (n > TASKS.length * 7) msg = 'Haftada en fazla ' + TASKS.length * 7 + ' görev tamamlanabilir.';
      else val = n;
    }
    $('taskGoalError').textContent = msg;
    if (msg) { $('taskGoalInput').setAttribute('aria-invalid', 'true'); $('taskGoalInput').focus(); return; }
    $('taskGoalInput').removeAttribute('aria-invalid');
    state.goals.tasksWeekly = val;
    save();
    renderTasks();
    toast(val ? 'Haftalık görev hedefi kaydedildi.' : 'Haftalık görev hedefi kaldırıldı.', 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Tema ve ayarlar                                                     */
  /* ------------------------------------------------------------------ */
  function systemDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function isDark() { const p = state.settings.theme; return p === 'dark' || (p === 'system' && systemDark()); }
  function applyTheme() {
    const dark = isDark();
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const btn = $('themeToggle');
    btn.setAttribute('aria-label', dark ? 'Açık temaya geç' : 'Koyu temaya geç');
    btn.removeAttribute('aria-pressed');
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1a11' : '#14532d');
    document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === state.settings.theme; });
  }
  function setTheme(pref) { state.settings.theme = pref; save(); applyTheme(); }

  function renderSettings() {
    const n = state.water.length, m = state.energy.length, k = Object.keys(state.tasks).length;
    let text = 'Bu tarayıcıda şu an ' + n + ' su kaydı, ' + m + ' enerji kaydı ve ' + k + ' güne ait görev durumu saklanıyor. Tarayıcı verileri temizlenirse bu kayıtlar silinebilir; düzenli yedek almanı öneririz.';
    if (!storageOk) text += ' Dikkat: depolama şu anda kullanılamıyor, kayıtlar kalıcı olmayabilir.';
    $('storageInfo').textContent = text;
    document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === state.settings.theme; });
  }

  function setImportResult(msg, ok) {
    const n = $('importResult');
    n.textContent = msg;
    n.className = 'status-line ' + (ok ? 'ok' : 'err');
  }

  function doExport() {
    try {
      const blob = new Blob([buildExport()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'ecotrack-yedek-' + todayStr() + '.json' });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Yedek dosyası indirildi.', 'success');
    } catch (e) {
      toast('Dışa aktarma başarısız oldu.', 'error');
    }
  }

  function handleImportFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setImportResult('Dosya çok büyük (en fazla 5 MB).', false); return; }
    const reader = new FileReader();
    reader.onerror = () => setImportResult('Dosya okunamadı.', false);
    reader.onload = () => importText(String(reader.result));
    reader.readAsText(file);
  }

  async function importText(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { setImportResult('Dosya geçerli bir JSON değil. İçe aktarma yapılmadı; mevcut verilerin korundu.', false); return false; }
    const res = sanitizeData(parsed);
    if (!res.ok) { setImportResult(res.error + ' Mevcut verilerin korundu.', false); return false; }
    const d = res.data;
    const ok = await confirmAction({
      title: 'Yedekten içe aktar', okLabel: 'İçe aktar',
      message: 'Mevcut kayıtlarının yerine ' + d.water.length + ' su kaydı, ' + d.energy.length + ' enerji kaydı ve ' + Object.keys(d.tasks).length + ' günlük görev durumu gelecek.' + (res.dropped ? ' ' + res.dropped + ' geçersiz öğe atlanacak.' : '') + ' Bu işlem geri alınamaz.'
    });
    if (!ok) { setImportResult('İçe aktarma iptal edildi.', false); return false; }
    state = d;
    save();
    applyTheme();
    renderAll();
    setImportResult('İçe aktarma tamamlandı: ' + d.water.length + ' su, ' + d.energy.length + ' enerji kaydı.' + (res.dropped ? ' ' + res.dropped + ' geçersiz öğe atlandı.' : ''), true);
    toast('Veriler içe aktarıldı.', 'success');
    return true;
  }

  async function deleteAll() {
    const ok = await confirmAction({
      title: 'Tüm verileri sil', okLabel: 'Evet, hepsini sil',
      message: 'Bu cihazdaki tüm su ve enerji kayıtların, hedeflerin ve görev durumların kalıcı olarak silinecek. Tema tercihin korunur. Emin misin?'
    });
    if (!ok) return false;
    const theme = state.settings.theme;
    state = defaultState();
    state.settings.theme = theme;
    resetForm('water'); resetForm('energy');
    shown.water = PAGE_SIZE; shown.energy = PAGE_SIZE;
    save();
    renderAll();
    setImportResult('', true);
    toast('Tüm veriler silindi.');
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Yönlendirme                                                         */
  /* ------------------------------------------------------------------ */
  function currentRoute() {
    const h = decodeURIComponent((location.hash || '').replace(/^#\/?/, ''));
    if (h === 'how') return { view: 'home', anchor: 'how' };
    return { view: ROUTES.indexOf(h) >= 0 ? h : 'home' };
  }

  function renderView(view) {
    if (view === 'dashboard') renderDashboard();
    else if (view === 'water') { renderModule('water'); }
    else if (view === 'energy') { renderModule('energy'); }
    else if (view === 'tasks') renderTasks();
    else if (view === 'settings') renderSettings();
  }
  function renderAll() { renderDashboard(); renderModule('water'); renderModule('energy'); renderTasks(); renderSettings(); }

  function route(initial) {
    const r = currentRoute();
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + r.view; });
    document.querySelectorAll('#mainNav a').forEach((a) => {
      if (a.getAttribute('data-route') === r.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const sec = $('view-' + r.view);
    document.title = sec.getAttribute('data-title') + ' — EcoTrack';
    renderView(r.view);
    setMenu(false);
    if (r.anchor && $(r.anchor)) $(r.anchor).scrollIntoView();
    else window.scrollTo(0, 0);
    if (!initial) {
      const h = $(r.view + 'Title');
      if (h) h.focus({ preventScroll: true });
    }
  }

  function setMenu(open) {
    const nav = $('mainNav'), btn = $('menuToggle');
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Menüyü kapat' : 'Menüyü aç');
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', open ? '#i-x' : '#i-menu');
  }

  /* ------------------------------------------------------------------ */
  /* Başlatma                                                            */
  /* ------------------------------------------------------------------ */
  function init() {
    state = load();
    applyTheme();

    ['water', 'energy'].forEach((kind) => {
      $(kind + 'Date').value = todayStr();
      $(kind + 'Date').max = todayStr();
      $(kind + 'Form').addEventListener('submit', (e) => handleSubmit(kind, e));
      $(kind + 'Cancel').addEventListener('click', () => resetForm(kind));
      $(kind + 'GoalForm').addEventListener('submit', (e) => handleGoalSubmit(kind, e));
      $(kind + 'More').addEventListener('click', () => { shown[kind] += PAGE_SIZE; renderModule(kind); });
    });
    $('taskGoalForm').addEventListener('submit', handleTaskGoal);
    $('taskFilters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      taskFilter = b.getAttribute('data-filter');
      renderTasks();
    });

    $('themeToggle').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));
    document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) setTheme(r.value); }));
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (state.settings.theme === 'system') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }

    $('exportBtn').addEventListener('click', doExport);
    $('importBtn').addEventListener('click', () => $('importInput').click());
    $('importInput').addEventListener('change', (e) => { handleImportFile(e.target.files && e.target.files[0]); e.target.value = ''; });
    $('deleteAllBtn').addEventListener('click', deleteAll);

    $('confirmOk').addEventListener('click', () => closeConfirm(true));
    $('confirmCancel').addEventListener('click', () => closeConfirm(false));
    $('confirmDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeConfirm(false); });

    $('menuToggle').addEventListener('click', () => setMenu($('menuToggle').getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('menuToggle').getAttribute('aria-expanded') === 'true') { setMenu(false); $('menuToggle').focus(); }
    });
    document.addEventListener('click', (e) => {
      if ($('menuToggle').getAttribute('aria-expanded') === 'true' && !e.target.closest('.site-header')) setMenu(false);
    });

    window.addEventListener('hashchange', () => route(false));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        $('waterDate').max = todayStr(); $('energyDate').max = todayStr();
        renderView(currentRoute().view);
      }
    });
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) { state = load(); applyTheme(); renderView(currentRoute().view); }
    });

    route(true);
  }

  window.EcoTrack = {
    parseNumber: parseNumber, parseDateStr: parseDateStr, weekStart: weekStart, weekDates: weekDates,
    validateRecord: validateRecord, sanitizeData: sanitizeData, buildExport: buildExport, importText: importText,
    getState: () => state, TASKS: TASKS, STORAGE_KEY: STORAGE_KEY, todayStr: todayStr
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
