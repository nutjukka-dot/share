/* LocalSend Web — peer-to-peer file / link / text sharing in the browser.
 *
 * How it works
 *  - Every open tab is a PeerJS peer (WebRTC). Data goes device → device, encrypted.
 *  - Devices that share a "room" find each other through a tiny "hub" peer whose ID is
 *    derived from the room code. The first device in the room hosts the hub; if it leaves,
 *    another device takes over automatically.
 *  - Room code: automatic (hash of public IP from /api/room → same Wi-Fi) or manual (?room=CODE).
 */
(() => {
  'use strict';

  // ---------- constants ----------
  const PREFIX = 'lsweb2-';
  const BLOCK = 1024 * 1024;           // file read block
  const HIGH_WATER = 4 * 1024 * 1024;  // pause sending above this buffered amount
  const LOW_WATER = 512 * 1024;
  const MAX_INLINE_TEXT = 12000;       // larger texts are sent as .txt files
  // Optional: point to your own PeerServer by defining window.LSW_PEER_OPTS before app.js loads
  const PEER_OPTS = Object.assign({ debug: 1 }, window.LSW_PEER_OPTS || {});

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const rand = (n, chars = 'abcdefghijkmnpqrstuvwxyz23456789') => {
    const a = new Uint32Array(n); crypto.getRandomValues(a);
    return Array.from(a, x => chars[x % chars.length]).join('');
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = b => {
    if (!isFinite(b)) return '';
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return (b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
  };
  const fmtTime = t => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const isUrl = s => { try { const u = new URL(s.trim()); return (u.protocol === 'http:' || u.protocol === 'https:') && !/\s/.test(s.trim()); } catch { return false; } };
  const safeHref = s => isUrl(s) ? s.trim() : null;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const linkify = text => esc(text).replace(/https?:\/\/[^\s<]+/g, m => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);

  const ICONS = {
    phone: '<svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
  };
  const fileIcon = type => ICONS[(type || '').startsWith('image/') ? 'image' : (type || '').startsWith('video/') ? 'video' : (type || '').startsWith('audio/') ? 'audio' : 'file'];
  const AVATAR_COLORS = ['#0e8f7e', '#2f6fde', '#8a4fd6', '#d6573a', '#c98a12', '#1f9d55', '#d23f86', '#3a8fb7'];
  const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };

  // ---------- device identity ----------
  function detectDevice() {
    const ua = navigator.userAgent;
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    const type = /iPad|Tablet/i.test(ua) || iPadOS || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'tablet'
      : /Mobi|iPhone|iPod|Android/i.test(ua) ? 'phone' : 'desktop';
    const os = /iPhone|iPad|iPod/.test(ua) || iPadOS ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
    return { type, os, browser };
  }
  function randomName() {
    const animals = ['แมว', 'นาก', 'เสือ', 'ช้าง', 'นกฮูก', 'กระต่าย', 'ปลาวาฬ', 'จิ้งจอก', 'แพนด้า', 'เต่า', 'โลมา', 'เพนกวิน', 'หมีขาว', 'กระรอก', 'ยีราฟ'];
    const adjs = ['ใจดี', 'ว่องไว', 'สดใส', 'อารมณ์ดี', 'ช่างฝัน', 'กล้าหาญ', 'สุขุม', 'ขยัน', 'ร่าเริง', 'เท่', 'น่ารัก', 'ฉลาด'];
    return animals[Math.floor(Math.random() * animals.length)] + adjs[Math.floor(Math.random() * adjs.length)];
  }

  const dev = detectDevice();
  const me = {
    id: PREFIX + 'd-' + rand(12),
    name: lsGet('lsw.name', null) || (() => { const n = randomName(); lsSet('lsw.name', n); return n; })(),
    type: dev.type, os: dev.os, browser: dev.browser,
  };
  const settings = { autoAccept: lsGet('lsw.autoAccept', false), autoSave: lsGet('lsw.autoSave', false) };

  // ---------- state ----------
  let peer = null;
  let room = { code: '', mode: 'auto' };
  let hubPeer = null, hubState = null;   // when this tab hosts the hub
  let hubConn = null, hubPingTimer = null, lastPong = 0, rejoinTimer = null, joining = false;
  let members = [];                      // [{id,name,type,os,browser}]
  const conns = new Map();               // peerId -> DataConnection (raw)
  const connWaiters = new Map();         // peerId -> Promise<DataConnection>
  const selection = [];                  // {kind:'file'|'text'|'link', file?, text?, id}
  const transfers = new Map();           // key -> transfer
  const offerQueue = [];
  let currentOffer = null;
  let sendCounter = 0;
  let quickTarget = null;
  let unseen = 0;

  // ---------- UI: status ----------
  function setStatus(kind, text) {
    const el = $('#status');
    el.classList.remove('online', 'offline');
    if (kind) el.classList.add(kind);
    $('#statusText').textContent = text;
  }
  function toast(msg, err = false, ms = 2600) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
  }
  function deviceLabel(d) { return [d.browser, d.os].filter(Boolean).join(' · '); }
  function renderMe() {
    $('#myName').textContent = me.name;
    $('#myDevice').textContent = deviceLabel(me);
    const av = $('#myAvatar'); av.innerHTML = ICONS[me.type]; av.style.background = colorFor(me.id);
  }

  // ---------- room ----------
  function normCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
  const hubIdFor = code => PREFIX + 'hub-' + code.toLowerCase();

  async function resolveRoom() {
    const q = normCode(new URLSearchParams(location.search).get('room'));
    if (q) return { code: q, mode: 'manual' };
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch('/api/room', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) { const j = await r.json(); if (j.room) return { code: normCode(j.room), mode: 'auto' }; }
    } catch { }
    // No API (e.g. opened as plain static files) → a private room you can share by QR
    let code = sessionStorage.getItem('lsw.fallbackRoom');
    if (!code) { code = rand(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'); sessionStorage.setItem('lsw.fallbackRoom', code); }
    return { code, mode: 'fallback' };
  }
  function roomLink(code) { return location.origin + location.pathname + '?room=' + code; }
  function goRoom(code) {
    const u = new URL(location.href);
    if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
    location.href = u.toString();
  }
  function renderRoom() {
    $('#roomLabel').textContent = room.mode === 'auto' ? 'Wi‑Fi นี้' : room.code;
    $('#roomCode').textContent = room.code;
    $('#roomMode').textContent = room.mode === 'auto'
      ? 'โหมดอัตโนมัติ: อุปกรณ์ที่ใช้อินเทอร์เน็ตเดียวกัน (Wi‑Fi เดียวกัน) จะเห็นกันเอง'
      : 'ห้องส่วนตัว: เฉพาะอุปกรณ์ที่ใส่รหัสนี้หรือสแกน QR เท่านั้นที่จะเห็นกัน';
    $('#autoRoom').hidden = room.mode === 'auto';
    try {
      const qr = qrcode(0, 'M'); qr.addData(roomLink(room.code)); qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) { $('#qr').textContent = ''; }
  }

  // ---------- peer ----------
  function startPeer() {
    peer = new Peer(me.id, PEER_OPTS);
    peer.on('open', () => { joinRoom(); });
    peer.on('connection', c => { if (c.serialization === 'raw') setupConn(c); else c.close(); });
    peer.on('disconnected', () => {
      setStatus('offline', 'หลุดการเชื่อมต่อ กำลังเชื่อมใหม่…');
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch { } }, 1500);
    });
    peer.on('error', err => {
      const t = err && err.type;
      if (t === 'peer-unavailable') {
        const m = String(err.message || '');
        if (m.includes(hubIdFor(room.code))) {
          const hc = hubConn;
          if (hc && !hc.open) { try { hc.close(); } catch { } onHubLost(hc); } else scheduleRejoin(200);
        }
        else for (const [id] of connWaiters) if (m.includes(id)) failConn(id, 'ไม่พบอุปกรณ์ (อาจปิดหน้าเว็บไปแล้ว)');
        return;
      }
      if (t === 'unavailable-id') { me.id = PREFIX + 'd-' + rand(12); peer.destroy(); setTimeout(startPeer, 300); return; }
      if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
        setStatus('offline', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่…');
        setTimeout(() => { if (peer.destroyed) { startPeer(); } else if (peer.disconnected) try { peer.reconnect(); } catch { } }, 3000);
        return;
      }
      if (t === 'browser-incompatible') { setStatus('offline', 'เบราว์เซอร์นี้ไม่รองรับ WebRTC'); return; }
      console.warn('peer error', t, err);
    });
  }

  // ---------- discovery (hub) ----------
  function scheduleRejoin(delay) {
    clearTimeout(rejoinTimer);
    rejoinTimer = setTimeout(joinRoom, delay ?? (400 + Math.random() * 1600));
  }

  function joinRoom() {
    if (joining || !peer || peer.destroyed || !peer.open) return;
    if (hubConn && hubConn.open) return;
    joining = true;
    setStatus(null, 'กำลังค้นหาอุปกรณ์…');
    if (hubPeer) { connectHub(); return; } // we already host it
    const hp = new Peer(hubIdFor(room.code), PEER_OPTS);
    let settled = false;
    const done = fn => { if (!settled) { settled = true; fn(); } };
    const timeout = setTimeout(() => done(() => { try { hp.destroy(); } catch { } joining = false; scheduleRejoin(2000); }), 10000);
    hp.on('open', () => done(() => { clearTimeout(timeout); hubPeer = hp; becomeHub(hp); connectHub(); }));
    hp.on('error', err => {
      if (err.type === 'unavailable-id') done(() => { clearTimeout(timeout); try { hp.destroy(); } catch { } connectHub(); });
      else if (!settled) done(() => { clearTimeout(timeout); try { hp.destroy(); } catch { } joining = false; scheduleRejoin(2500); });
      else if (hubPeer === hp && ['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        // lost our hub registration – let everyone re-elect
        dropHub();
      }
    });
  }

  function becomeHub(hp) {
    hubState = { members: new Map(), sweep: null };
    hp.on('connection', c => {
      c.on('data', d => {
        if (!d || typeof d !== 'object') return;
        const m = hubState && hubState.members;
        if (!m) return;
        if (d.t === 'hello' && d.info && d.info.id === c.peer) {
          m.set(c.peer, { info: sanitizeInfo(d.info), conn: c, last: Date.now() });
          hubBroadcast();
        } else if (d.t === 'ping') {
          const e = m.get(c.peer); if (e) e.last = Date.now();
          try { c.send({ t: 'pong' }); } catch { }
        } else if (d.t === 'bye') {
          if (m.delete(c.peer)) hubBroadcast();
        }
      });
      const gone = () => { if (hubState && hubState.members.get(c.peer)?.conn === c) { hubState.members.delete(c.peer); hubBroadcast(); } };
      c.on('close', gone); c.on('error', gone);
    });
    hp.on('disconnected', () => { setTimeout(() => { if (hubPeer === hp && hp.disconnected && !hp.destroyed) try { hp.reconnect(); } catch { } }, 1000); });
    hubState.sweep = setInterval(() => {
      if (!hubState) return;
      let changed = false; const now = Date.now();
      for (const [id, e] of hubState.members) if (now - e.last > 20000) { hubState.members.delete(id); try { e.conn.close(); } catch { } changed = true; }
      if (changed) hubBroadcast();
    }, 5000);
  }
  function hubBroadcast() {
    if (!hubState) return;
    const list = [...hubState.members.values()].map(e => e.info);
    for (const e of hubState.members.values()) { try { if (e.conn.open) e.conn.send({ t: 'members', list }); } catch { } }
  }
  function dropHub() {
    if (hubState) { clearInterval(hubState.sweep); hubState = null; }
    if (hubPeer) { try { hubPeer.destroy(); } catch { } hubPeer = null; }
  }
  function sanitizeInfo(i) {
    return { id: String(i.id).slice(0, 64), name: String(i.name || 'อุปกรณ์').slice(0, 32), type: ['phone', 'tablet', 'desktop'].includes(i.type) ? i.type : 'desktop', os: String(i.os || '').slice(0, 16), browser: String(i.browser || '').slice(0, 16) };
  }

  function connectHub() {
    const c = peer.connect(hubIdFor(room.code), { reliable: true, serialization: 'json' });
    hubConn = c;
    const openTimeout = setTimeout(() => { if (!c.open) { try { c.close(); } catch { } if (hubConn === c) { hubConn = null; joining = false; scheduleRejoin(); } } }, 9000);
    c.on('open', () => {
      clearTimeout(openTimeout); joining = false;
      c.send({ t: 'hello', info: me });
      lastPong = Date.now();
      clearInterval(hubPingTimer);
      hubPingTimer = setInterval(() => {
        if (!c.open) return;
        if (Date.now() - lastPong > 16000) { try { c.close(); } catch { } onHubLost(c); return; }
        try { c.send({ t: 'ping' }); } catch { }
      }, 5000);
      updateStatusOnline();
    });
    c.on('data', d => {
      if (!d) return;
      if (d.t === 'pong') lastPong = Date.now();
      else if (d.t === 'members' && Array.isArray(d.list)) { lastPong = Date.now(); setMembers(d.list.map(sanitizeInfo)); }
    });
    c.on('close', () => onHubLost(c));
    c.on('error', () => onHubLost(c));
  }
  function onHubLost(c) {
    if (hubConn !== c) return;
    hubConn = null; joining = false;
    clearInterval(hubPingTimer);
    if (hubPeer && hubPeer.destroyed) dropHub();
    setStatus(null, 'กำลังเชื่อมต่อใหม่…');
    scheduleRejoin();
  }
  function updateStatusOnline() {
    if (hubConn && hubConn.open) setStatus('online', room.mode === 'auto' ? 'ออนไลน์ · Wi‑Fi เดียวกัน' : 'ออนไลน์ · ห้อง ' + room.code);
  }

  // ---------- device list ----------
  function setMembers(list) {
    members = list.filter(m => m.id !== me.id);
    renderDevices();
  }
  function renderDevices() {
    const box = $('#devices');
    $('#devCount').textContent = members.length;
    $('#radar').hidden = members.length > 0;
    box.innerHTML = members.map(m => `
      <button class="device" data-id="${esc(m.id)}" title="ส่งให้ ${esc(m.name)}">
        <div class="avatar" style="background:${colorFor(m.id)}">${ICONS[m.type] || ICONS.desktop}</div>
        <div class="d-main"><div class="device-name">${esc(m.name)}</div><div class="device-sub">${esc(deviceLabel(m))}</div></div>
        <span class="send-hint">${ICONS.send}</span>
      </button>`).join('');
  }
  const memberName = id => (members.find(m => m.id === id) || {}).name;

  // ---------- selection ----------
  function addFiles(files) {
    for (const f of files) selection.push({ kind: 'file', file: f, id: rand(8) });
    renderSelection();
  }
  function addTextOrLink(s) {
    s = String(s || '').trim();
    if (!s) return;
    if (isUrl(s)) selection.push({ kind: 'link', text: s, id: rand(8) });
    else if (s.length > MAX_INLINE_TEXT) selection.push({ kind: 'file', file: new File([s], 'ข้อความ-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt', { type: 'text/plain' }), id: rand(8) });
    else selection.push({ kind: 'text', text: s, id: rand(8) });
    renderSelection();
  }
  function renderSelection() {
    const box = $('#selection');
    $('#clearSel').hidden = !selection.length;
    if (!selection.length) { box.innerHTML = '<div class="empty-sel">ลากไฟล์มาวาง หรือกด Ctrl/⌘+V เพื่อวาง</div>'; return; }
    const total = selection.reduce((a, s) => a + (s.file ? s.file.size : 0), 0);
    box.innerHTML = selection.map(s => {
      let thumb, title, meta;
      if (s.kind === 'file') {
        thumb = s.file.type.startsWith('image/') && s.file.size < 30e6 ? `<img data-thumb="${s.id}" alt="">` : fileIcon(s.file.type);
        title = esc(s.file.name); meta = fmtSize(s.file.size);
      } else if (s.kind === 'link') { thumb = ICONS.link; title = esc(s.text); meta = 'ลิงก์'; }
      else { thumb = ICONS.text; title = esc(s.text.slice(0, 120)); meta = 'ข้อความ · ' + s.text.length + ' ตัวอักษร'; }
      return `<div class="sel-item"><div class="sel-thumb">${thumb}</div><div class="sel-main"><div class="sel-title">${title}</div><div class="sel-meta">${meta}</div></div><button class="x-btn" data-remove="${s.id}" title="เอาออก">${ICONS.x}</button></div>`;
    }).join('') + `<div class="sel-summary">${selection.length} รายการ${total ? ' · ' + fmtSize(total) : ''} — <b>แตะอุปกรณ์ด้านล่างเพื่อส่ง</b></div>`;
    for (const s of selection) {
      const img = box.querySelector(`img[data-thumb="${s.id}"]`);
      if (img) { const u = URL.createObjectURL(s.file); img.onload = () => URL.revokeObjectURL(u); img.src = u; }
    }
  }

  // ---------- connections between devices ----------
  function setupConn(c) {
    c.on('open', () => { conns.set(c.peer, c); });
    if (c.open) conns.set(c.peer, c);
    c.on('data', d => onData(c, d));
    const closed = () => {
      if (conns.get(c.peer) === c) conns.delete(c.peer);
      for (const tr of transfers.values()) {
        if (tr.peerId === c.peer && tr.conn === c && ['waiting', 'sending', 'receiving', 'pending'].includes(tr.status)) {
          tr.status = 'failed'; tr.error = 'การเชื่อมต่อขาด'; freeTransfer(tr); renderTransfer(tr);
          if (currentOffer === tr) closeOfferDialog();
        }
      }
    };
    c.on('close', closed);
    c.on('error', e => { console.warn('conn error', e); });
  }
  function failConn(id, msg) { const w = connWaiters.get(id); if (w) w.reject(new Error(msg)); }
  function getConn(id) {
    const ex = conns.get(id);
    if (ex && ex.open) return Promise.resolve(ex);
    if (connWaiters.has(id)) return connWaiters.get(id).promise;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const w = { promise, resolve, reject };
    connWaiters.set(id, w);
    const c = peer.connect(id, { reliable: true, serialization: 'raw' });
    setupConn(c);
    const timer = setTimeout(() => reject(new Error('เชื่อมต่อไม่สำเร็จ (หมดเวลา)')), 20000);
    c.on('open', () => { clearTimeout(timer); conns.set(id, c); resolve(c); });
    promise.catch(() => { clearTimeout(timer); try { c.close(); } catch { } }).finally(() => connWaiters.delete(id));
    return promise;
  }
  function sendJSON(c, obj) { c.send(JSON.stringify(obj)); }
  function bufferedOf(c) { return (c.dataChannel ? c.dataChannel.bufferedAmount : 0) + (c.bufferSize || 0); }
  function waitDrain(c) {
    return new Promise(resolve => {
      const dc = c.dataChannel;
      if (!dc || bufferedOf(c) < HIGH_WATER) return resolve();
      try { dc.bufferedAmountLowThreshold = LOW_WATER; } catch { }
      let done = false;
      const fin = () => { if (done) return; done = true; dc.removeEventListener('bufferedamountlow', check); clearInterval(poll); resolve(); };
      const check = () => { if (bufferedOf(c) < HIGH_WATER || !c.open) fin(); };
      dc.addEventListener('bufferedamountlow', check);
      const poll = setInterval(check, 60);
    });
  }
  function chunkSize(c) {
    const mms = c.peerConnection && c.peerConnection.sctp && c.peerConnection.sctp.maxMessageSize;
    return Math.max(16 * 1024, Math.min(64 * 1024, (mms || 65536)) - 64);
  }

  // ---------- sending ----------
  async function sendTo(targetId, items) {
    items = items || selection.slice();
    if (!items.length) { openQuick(targetId); return; }
    const files = items.filter(s => s.kind === 'file').map(s => s.file);
    const texts = [];
    let budget = 40000; // keep the offer message small enough for every browser's WebRTC limit
    const enc = new TextEncoder();
    for (const s of items) {
      if (s.kind === 'file') continue;
      const bytes = enc.encode(s.text).length;
      if (bytes <= budget) { texts.push({ kind: s.kind, text: s.text }); budget -= bytes; }
      else files.push(new File([s.text], 'ข้อความ-' + (texts.length + files.length + 1) + '.txt', { type: 'text/plain' }));
    }
    const n = ++sendCounter;
    const tr = {
      key: 'out:' + targetId + ':' + n, n, dir: 'out', peerId: targetId, peerName: memberName(targetId) || 'อุปกรณ์',
      files: files.map(f => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' })), fileObjs: files, texts,
      total: files.reduce((a, f) => a + f.size, 0), done: 0, status: 'connecting', time: Date.now(), speed: 0,
    };
    transfers.set(tr.key, tr); renderTransfer(tr);
    try {
      const c = await getConn(targetId);
      tr.conn = c; tr.status = 'waiting'; renderTransfer(tr);
      const offer = JSON.stringify({ t: 'offer', n, from: { name: me.name, type: me.type, os: me.os, browser: me.browser }, texts, files: tr.files, total: tr.total });
      if (offer.length > 60000) throw new Error('เลือกไฟล์มากเกินไปในครั้งเดียว ลองแบ่งส่ง');
      c.send(offer);
    } catch (e) {
      tr.status = 'failed'; tr.error = e.message; renderTransfer(tr);
      toast('ส่งไม่สำเร็จ: ' + e.message, true);
    }
  }

  async function streamFiles(tr) {
    const c = tr.conn; tr.status = 'sending'; tr.start = Date.now(); renderTransfer(tr);
    const cs = chunkSize(c);
    try {
      for (let i = 0; i < tr.fileObjs.length; i++) {
        const f = tr.fileObjs[i];
        for (let off = 0; off < f.size; off += BLOCK) {
          if (tr.status !== 'sending' || !c.open) return;
          const buf = new Uint8Array(await f.slice(off, Math.min(off + BLOCK, f.size)).arrayBuffer());
          for (let p = 0; p < buf.length; p += cs) {
            if (tr.status !== 'sending' || !c.open) return;
            if (bufferedOf(c) >= HIGH_WATER) await waitDrain(c);
            const part = buf.subarray(p, Math.min(p + cs, buf.length));
            const frame = new Uint8Array(8 + part.length);
            const dv = new DataView(frame.buffer);
            dv.setUint32(0, tr.n); dv.setUint32(4, i);
            frame.set(part, 8);
            c.send(frame.buffer);
            tr.done += part.length;
            progress(tr);
          }
        }
        sendJSON(c, { t: 'file-end', n: tr.n, i });
      }
      sendJSON(c, { t: 'done', n: tr.n });
      tr.status = 'finishing'; renderTransfer(tr);
    } catch (e) {
      console.error(e);
      tr.status = 'failed'; tr.error = 'อ่านไฟล์ไม่สำเร็จ'; renderTransfer(tr);
      try { sendJSON(c, { t: 'cancel', n: tr.n }); } catch { }
    }
  }

  function cancelTransfer(tr) {
    if (!['connecting', 'waiting', 'sending', 'receiving', 'pending', 'finishing'].includes(tr.status)) return;
    const prev = tr.status;
    tr.status = 'cancelled';
    try { if (tr.conn && tr.conn.open && prev !== 'connecting') sendJSON(tr.conn, { t: 'cancel', n: tr.n, dir: tr.dir }); } catch { }
    freeTransfer(tr); renderTransfer(tr);
  }
  function freeTransfer(tr) { if (tr.chunks) tr.chunks = null; }

  // ---------- receiving ----------
  function onData(c, d) {
    if (typeof d === 'string') {
      let m; try { m = JSON.parse(d); } catch { return; }
      handleMsg(c, m);
    } else if (d instanceof ArrayBuffer) {
      handleChunk(c, d);
    } else if (d && d.buffer instanceof ArrayBuffer) {
      handleChunk(c, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    } else if (d instanceof Blob) {
      d.arrayBuffer().then(b => handleChunk(c, b)); // older Safari fallback (order-safe enough for rare case)
    }
  }
  function inKey(c, n) { return 'in:' + c.peer + ':' + n; }
  function outKey(c, n) { return 'out:' + c.peer + ':' + n; }

  function handleMsg(c, m) {
    if (!m || typeof m !== 'object') return;
    const n = Number(m.n);
    switch (m.t) {
      case 'offer': {
        const files = Array.isArray(m.files) ? m.files.slice(0, 1000).map(f => ({ name: String(f.name || 'file').slice(0, 255), size: Math.max(0, Number(f.size) || 0), type: String(f.type || 'application/octet-stream').slice(0, 100) })) : [];
        const texts = Array.isArray(m.texts) ? m.texts.slice(0, 100).map(t => ({ kind: t.kind === 'link' && isUrl(String(t.text)) ? 'link' : 'text', text: String(t.text || '').slice(0, MAX_INLINE_TEXT) })) : [];
        const from = sanitizeInfo({ ...(m.from || {}), id: c.peer });
        const tr = {
          key: inKey(c, n), n, dir: 'in', peerId: c.peer, peerName: from.name, from, conn: c, files, texts,
          total: files.reduce((a, f) => a + f.size, 0), done: 0, status: 'pending', time: Date.now(),
          results: [], cur: -1, chunks: [], speed: 0,
        };
        transfers.set(tr.key, tr); renderTransfer(tr);
        if (settings.autoAccept) acceptOffer(tr);
        else { offerQueue.push(tr); showNextOffer(); }
        notify(`${from.name} ต้องการส่ง ${summarize(tr)}`);
        break;
      }
      case 'accept': {
        const tr = transfers.get(outKey(c, n)); if (!tr || tr.status !== 'waiting') return;
        if (!tr.fileObjs.length) { tr.status = 'done'; renderTransfer(tr); toast('ส่งให้ ' + tr.peerName + ' แล้ว'); }
        else streamFiles(tr);
        break;
      }
      case 'decline': {
        const tr = transfers.get(outKey(c, n)); if (!tr) return;
        tr.status = 'declined'; renderTransfer(tr); toast(tr.peerName + ' ปฏิเสธการรับ', true);
        break;
      }
      case 'received': {
        const tr = transfers.get(outKey(c, n)); if (!tr) return;
        tr.status = 'done'; tr.done = tr.total; renderTransfer(tr); toast('ส่งให้ ' + tr.peerName + ' สำเร็จ');
        break;
      }
      case 'file-end': {
        const tr = transfers.get(inKey(c, n)); if (!tr || tr.status !== 'receiving') return;
        const i = Number(m.i); const meta = tr.files[i]; if (!meta) return;
        const parts = tr.cur === i ? tr.chunks : [];
        const blob = new Blob(parts, { type: meta.type });
        tr.chunks = []; tr.cur = -1;
        const url = URL.createObjectURL(blob);
        tr.results[i] = { ...meta, url, size: blob.size };
        if (settings.autoSave) download(url, meta.name);
        renderTransfer(tr);
        break;
      }
      case 'done': {
        const tr = transfers.get(inKey(c, n)); if (!tr || tr.status !== 'receiving') return;
        tr.status = 'done'; tr.done = tr.total; renderTransfer(tr);
        sendJSON(c, { t: 'received', n });
        toast('ได้รับไฟล์จาก ' + tr.peerName + ' แล้ว');
        break;
      }
      case 'cancel': {
        // m.dir is the *sender's* view of the transfer direction
        const tr = transfers.get(m.dir === 'in' ? outKey(c, n) : inKey(c, n)) || transfers.get(inKey(c, n)) || transfers.get(outKey(c, n));
        if (!tr || ['done', 'cancelled', 'failed', 'declined'].includes(tr.status)) return;
        tr.status = 'cancelled'; tr.error = 'อีกฝ่ายยกเลิก'; freeTransfer(tr); renderTransfer(tr);
        if (currentOffer === tr) closeOfferDialog();
        const qi = offerQueue.indexOf(tr); if (qi >= 0) offerQueue.splice(qi, 1);
        toast(tr.peerName + ' ยกเลิกการส่ง', true);
        break;
      }
    }
  }

  function handleChunk(c, buf) {
    if (buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const n = dv.getUint32(0), i = dv.getUint32(4);
    const tr = transfers.get(inKey(c, n));
    if (!tr || tr.status !== 'receiving') return;
    if (tr.cur !== i) { tr.cur = i; tr.chunks = []; }
    tr.chunks.push(new Uint8Array(buf, 8));
    tr.done += buf.byteLength - 8;
    progress(tr);
  }

  function acceptOffer(tr) {
    if (tr.status !== 'pending') return;
    tr.status = tr.files.length ? 'receiving' : 'done';
    tr.start = Date.now();
    sendJSON(tr.conn, { t: 'accept', n: tr.n });
    if (!tr.files.length) toast('ได้รับจาก ' + tr.peerName + ' แล้ว');
    renderTransfer(tr);
  }
  function declineOffer(tr) {
    if (tr.status !== 'pending') return;
    tr.status = 'declined';
    try { sendJSON(tr.conn, { t: 'decline', n: tr.n }); } catch { }
    renderTransfer(tr);
  }

  function summarize(tr) {
    const parts = [];
    if (tr.files.length) parts.push(tr.files.length === 1 ? tr.files[0].name : tr.files.length + ' ไฟล์');
    const links = tr.texts.filter(t => t.kind === 'link').length, texts = tr.texts.length - links;
    if (links) parts.push(links + ' ลิงก์');
    if (texts) parts.push(texts + ' ข้อความ');
    return parts.join(', ') + (tr.total ? ' (' + fmtSize(tr.total) + ')' : '');
  }

  // ---------- offer dialog ----------
  function showNextOffer() {
    if (currentOffer) return;
    while (offerQueue.length && offerQueue[0].status !== 'pending') offerQueue.shift();
    const tr = offerQueue.shift(); if (!tr) return;
    currentOffer = tr;
    const av = $('#offerAvatar'); av.innerHTML = ICONS[tr.from.type] || ICONS.desktop; av.style.background = colorFor(tr.peerId);
    $('#offerFrom').textContent = tr.peerName;
    $('#offerSummary').textContent = 'ต้องการส่ง ' + summarize(tr);
    $('#offerList').innerHTML = tr.texts.map(t => `<div class="tr-text"><div class="text-box">${t.kind === 'link' ? linkify(t.text) : esc(t.text.length > 400 ? t.text.slice(0, 400) + '…' : t.text)}</div></div>`).join('')
      + tr.files.map(f => `<div class="tr-item"><div class="sel-thumb">${fileIcon(f.type)}</div><div class="sel-main"><div class="sel-title">${esc(f.name)}</div><div class="sel-meta">${fmtSize(f.size)}</div></div></div>`).join('');
    const dlg = $('#offerDlg');
    if (!dlg.open) dlg.showModal();
  }
  function closeOfferDialog() {
    currentOffer = null;
    const dlg = $('#offerDlg'); if (dlg.open) dlg.close();
    setTimeout(showNextOffer, 150);
  }

  // ---------- history rendering ----------
  const STATUS = {
    connecting: ['wait', 'กำลังเชื่อมต่อ'], waiting: ['wait', 'รอการตอบรับ'], pending: ['wait', 'รอคุณตอบรับ'],
    sending: ['wait', 'กำลังส่ง'], receiving: ['wait', 'กำลังรับ'], finishing: ['wait', 'กำลังส่ง'],
    done: ['ok', 'สำเร็จ'], declined: ['err', 'ถูกปฏิเสธ'], cancelled: ['err', 'ยกเลิก'], failed: ['err', 'ล้มเหลว'],
  };
  function transferEl(tr) {
    let el = document.querySelector(`[data-tr="${CSS.escape(tr.key)}"]`);
    if (!el) {
      el = document.createElement('div'); el.className = 'tr'; el.dataset.tr = tr.key;
      $('#history').prepend(el);
      $('#emptyHistory').hidden = true; $('#clearHistory').hidden = false;
    }
    return el;
  }
  function renderTransfer(tr) {
    const el = transferEl(tr);
    const [cls, label] = STATUS[tr.status] || ['wait', tr.status];
    const active = ['sending', 'receiving', 'finishing'].includes(tr.status);
    const showBar = tr.total > 0 && (active || tr.status === 'done');
    const dirIcon = tr.dir === 'in' ? ICONS.down : ICONS.up;
    const who = tr.dir === 'in' ? `จาก <b>${esc(tr.peerName)}</b>` : `ถึง <b>${esc(tr.peerName)}</b>`;

    let items = '';
    const showContent = tr.dir === 'out' || ['receiving', 'done'].includes(tr.status) || (tr.status === 'pending');
    if (showContent && !(tr.dir === 'in' && tr.status === 'pending')) {
      items += tr.texts.map((t, k) => {
        const href = t.kind === 'link' ? safeHref(t.text) : null;
        return `<div class="tr-text"><div class="text-box">${href ? linkify(t.text) : esc(t.text)}</div>
          <div class="row-actions">
            <button class="mini" data-copy="${k}">${ICONS.copy}คัดลอก</button>
            ${href ? `<a class="mini primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${ICONS.open}เปิดลิงก์</a>` : ''}
          </div></div>`;
      }).join('');
      items += tr.files.map((f, i) => {
        const r = tr.dir === 'in' ? tr.results[i] : null;
        const thumb = r && f.type.startsWith('image/') ? `<img class="preview-img" src="${r.url}" alt="">` : `<div class="sel-thumb">${fileIcon(f.type)}</div>`;
        const btn = r ? `<a class="mini primary" href="${r.url}" download="${esc(f.name)}">${ICONS.save}บันทึก</a>` : '';
        const openBtn = r && /^(image|video|audio)\/|^application\/pdf$|^text\/plain$/.test(f.type) ? `<a class="mini" href="${r.url}" target="_blank" rel="noopener">${ICONS.open}</a>` : '';
        return `<div class="tr-item">${thumb}<div class="sel-main"><div class="sel-title">${esc(f.name)}</div><div class="sel-meta">${fmtSize(f.size)}</div></div>${openBtn}${btn}</div>`;
      }).join('');
    } else {
      items = `<div class="sub">${esc(summarize(tr))}</div>`;
    }

    const results = tr.dir === 'in' ? tr.results.filter(Boolean) : [];
    const actions = [];
    if (tr.dir === 'in' && tr.status === 'pending') actions.push(`<button class="mini" data-act="decline">ปฏิเสธ</button><button class="mini primary" data-act="accept">รับ</button>`);
    if (['connecting', 'waiting', 'sending', 'receiving'].includes(tr.status)) actions.push(`<button class="mini" data-act="cancel">ยกเลิก</button>`);
    if (results.length > 1) actions.push(`<button class="mini primary" data-act="saveall">${ICONS.save}บันทึกทั้งหมด</button>`);
    if (tr.dir === 'out' && ['failed', 'declined', 'cancelled'].includes(tr.status) && members.some(m => m.id === tr.peerId)) actions.push(`<button class="mini" data-act="retry">ส่งอีกครั้ง</button>`);

    el.innerHTML = `
      <div class="tr-head">
        <div class="dir ${tr.dir}">${dirIcon}</div>
        <div class="tr-title">${who}<div class="tr-time">${fmtTime(tr.time)}${tr.error ? ' · ' + esc(tr.error) : ''}</div></div>
        <span class="badge ${cls}">${label}</span>
      </div>
      ${showBar ? `<div class="progress"><div class="bar"><i style="width:${pct(tr)}%"></i></div><div class="p-meta"><span class="p-left">${fmtSize(tr.done)} / ${fmtSize(tr.total)}</span><span class="p-right">${active ? speedText(tr) : ''}</span></div></div>` : ''}
      ${items ? `<div class="tr-items">${items}</div>` : ''}
      ${actions.length ? `<div class="tr-actions">${actions.join('')}</div>` : ''}`;
  }
  const pct = tr => tr.total ? Math.min(100, (tr.done / tr.total) * 100).toFixed(1) : 100;
  function speedText(tr) {
    const secs = (Date.now() - (tr.start || Date.now())) / 1000;
    if (secs < 0.5 || !tr.done) return '';
    const sp = tr.done / secs; const left = (tr.total - tr.done) / sp;
    return fmtSize(sp) + '/s · เหลือ ' + (left < 60 ? Math.ceil(left) + ' วิ' : Math.ceil(left / 60) + ' นาที');
  }
  function progress(tr) {
    const now = performance.now();
    if (tr._lp && now - tr._lp < 120 && tr.done < tr.total) return;
    tr._lp = now;
    const el = document.querySelector(`[data-tr="${CSS.escape(tr.key)}"]`); if (!el) return;
    const bar = el.querySelector('.bar i'); if (!bar) { renderTransfer(tr); return; }
    bar.style.width = pct(tr) + '%';
    el.querySelector('.p-left').textContent = fmtSize(tr.done) + ' / ' + fmtSize(tr.total);
    el.querySelector('.p-right').textContent = speedText(tr);
  }

  function download(url, name) {
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); toast('คัดลอกแล้ว'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('คัดลอกแล้ว'); } catch { toast('คัดลอกไม่ได้', true); } ta.remove();
    }
  }
  function notify(msg) {
    if (document.hidden) { unseen++; document.title = `(${unseen}) LocalSend Web`; }
    try { if (navigator.vibrate) navigator.vibrate(60); } catch { }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('LocalSend Web', { body: msg, icon: 'icon.svg', tag: 'lsw' }); } catch { }
    }
  }

  // ---------- quick send / compose ----------
  let composeMode = 'text', composeTarget = null;
  function openCompose(mode, target) {
    composeMode = mode; composeTarget = target || null;
    $('#composeTitle').textContent = (mode === 'link' ? 'ลิงก์' : 'ข้อความ') + (target ? ' → ' + (memberName(target) || '') : '');
    $('#composeText').hidden = mode !== 'text';
    $('#composeLink').hidden = mode !== 'link';
    $('#composeText').value = ''; $('#composeLink').value = '';
    $('#composeOk').textContent = target ? 'ส่ง' : 'เพิ่ม';
    $('#composeDlg').showModal();
    setTimeout(() => (mode === 'link' ? $('#composeLink') : $('#composeText')).focus(), 50);
  }
  function openQuick(id) {
    quickTarget = id;
    $('#quickName').textContent = memberName(id) || 'อุปกรณ์';
    $('#quickDlg').showModal();
  }
  async function readClipboardInto(target) {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read();
          const files = [];
          for (const it of items) {
            const imgType = it.types.find(t => t.startsWith('image/'));
            if (imgType) { const b = await it.getType(imgType); files.push(new File([b], 'clipboard-' + Date.now() + '.' + (imgType.split('/')[1] || 'png'), { type: imgType })); }
          }
          if (files.length) { return deliver(target, files.map(f => ({ kind: 'file', file: f, id: rand(8) }))); }
        } catch { }
      }
      const t = await navigator.clipboard.readText();
      if (!t || !t.trim()) { toast('คลิปบอร์ดว่าง', true); return; }
      const s = t.trim();
      const item = isUrl(s) ? { kind: 'link', text: s, id: rand(8) } : { kind: 'text', text: s, id: rand(8) };
      deliver(target, [item]);
    } catch { toast('เบราว์เซอร์ไม่อนุญาตให้อ่านคลิปบอร์ด ลองกด Ctrl/⌘+V แทน', true, 3500); }
  }
  function deliver(target, items) {
    if (target) sendTo(target, items);
    else { selection.push(...items); renderSelection(); }
  }
  function pickFiles(kind, target) {
    const input = kind === 'media' ? $('#mediaInput') : $('#fileInput');
    input.dataset.target = target || '';
    input.value = '';
    input.click();
  }

  // ---------- event wiring ----------
  function wire() {
    document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.pick;
      if (k === 'file' || k === 'media') pickFiles(k);
      else if (k === 'paste') readClipboardInto(null);
      else openCompose(k);
    }));
    document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.quick, t = quickTarget;
      $('#quickDlg').close();
      if (k === 'file' || k === 'media') pickFiles(k, t);
      else if (k === 'paste') readClipboardInto(t);
      else openCompose(k, t);
    }));
    for (const inp of [$('#fileInput'), $('#mediaInput')]) inp.addEventListener('change', () => {
      const files = [...inp.files]; if (!files.length) return;
      const t = inp.dataset.target;
      if (t) sendTo(t, files.map(f => ({ kind: 'file', file: f, id: rand(8) })));
      else addFiles(files);
    });
    $('#composeForm').addEventListener('submit', e => {
      const v = composeMode === 'link' ? $('#composeLink').value.trim() : $('#composeText').value;
      if (!v.trim()) { e.preventDefault(); return; }
      if (composeMode === 'link' && !isUrl(v)) {
        const fixed = 'https://' + v.replace(/^\/+/, '');
        if (!isUrl(fixed)) { e.preventDefault(); toast('ลิงก์ไม่ถูกต้อง', true); return; }
        $('#composeLink').value = fixed;
      }
      const val = composeMode === 'link' ? $('#composeLink').value.trim() : v;
      let item;
      if (composeMode === 'link') item = { kind: 'link', text: val, id: rand(8) };
      else if (val.length > MAX_INLINE_TEXT) item = { kind: 'file', file: new File([val], 'ข้อความ.txt', { type: 'text/plain' }), id: rand(8) };
      else item = { kind: 'text', text: val, id: rand(8) };
      deliver(composeTarget, [item]);
    });
    $('#composeText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composeForm').requestSubmit(); });

    $('#selection').addEventListener('click', e => {
      const b = e.target.closest('[data-remove]'); if (!b) return;
      const i = selection.findIndex(s => s.id === b.dataset.remove); if (i >= 0) selection.splice(i, 1);
      renderSelection();
    });
    $('#clearSel').addEventListener('click', () => { selection.length = 0; renderSelection(); });
    $('#devices').addEventListener('click', e => { const d = e.target.closest('.device'); if (d) sendTo(d.dataset.id); });

    $('#history').addEventListener('click', e => {
      const card = e.target.closest('[data-tr]'); if (!card) return;
      const tr = transfers.get(card.dataset.tr); if (!tr) return;
      const cp = e.target.closest('[data-copy]');
      if (cp) { copyText(tr.texts[Number(cp.dataset.copy)].text); return; }
      const act = e.target.closest('[data-act]'); if (!act) return;
      const a = act.dataset.act;
      if (a === 'accept') { acceptOffer(tr); if (currentOffer === tr) closeOfferDialog(); }
      else if (a === 'decline') { declineOffer(tr); if (currentOffer === tr) closeOfferDialog(); }
      else if (a === 'cancel') cancelTransfer(tr);
      else if (a === 'saveall') tr.results.forEach((r, i) => r && setTimeout(() => download(r.url, r.name), i * 350));
      else if (a === 'retry') sendTo(tr.peerId, [...tr.texts.map(t => ({ ...t, id: rand(8) })), ...tr.fileObjs.map(f => ({ kind: 'file', file: f, id: rand(8) }))]);
    });
    $('#clearHistory').addEventListener('click', () => {
      for (const [k, tr] of transfers) {
        if (['done', 'declined', 'cancelled', 'failed'].includes(tr.status)) {
          (tr.results || []).forEach(r => r && URL.revokeObjectURL(r.url));
          transfers.delete(k);
          document.querySelector(`[data-tr="${CSS.escape(k)}"]`)?.remove();
        }
      }
      if (!transfers.size) { $('#emptyHistory').hidden = false; $('#clearHistory').hidden = true; }
    });

    $('#offerAccept').addEventListener('click', () => { const tr = currentOffer; if (tr) acceptOffer(tr); closeOfferDialog(); });
    $('#offerDecline').addEventListener('click', () => { const tr = currentOffer; if (tr) declineOffer(tr); closeOfferDialog(); });
    $('#offerDlg').addEventListener('cancel', e => e.preventDefault()); // must choose

    // generic close buttons + click on backdrop
    document.querySelectorAll('dialog').forEach(d => {
      d.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) { d.close(); return; }
        if (e.target === d && d.id !== 'offerDlg') d.close();
      });
    });

    // settings
    const openSettings = () => {
      $('#nameInput').value = me.name;
      $('#autoAccept').checked = settings.autoAccept;
      $('#autoSave').checked = settings.autoSave;
      $('#settingsDlg').showModal();
    };
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#myName').addEventListener('click', openSettings);
    $('#settingsForm').addEventListener('submit', () => {
      const n = $('#nameInput').value.trim().slice(0, 32);
      if (n && n !== me.name) {
        me.name = n; lsSet('lsw.name', n); renderMe();
        if (hubConn && hubConn.open) hubConn.send({ t: 'hello', info: me });
      }
      settings.autoAccept = $('#autoAccept').checked; lsSet('lsw.autoAccept', settings.autoAccept);
      settings.autoSave = $('#autoSave').checked; lsSet('lsw.autoSave', settings.autoSave);
      if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch { } }
    });

    // room
    $('#roomBtn').addEventListener('click', () => { renderRoom(); $('#joinInput').value = ''; $('#roomDlg').showModal(); });
    $('#copyRoomLink').addEventListener('click', () => copyText(roomLink(room.code)));
    $('#joinForm').addEventListener('submit', e => {
      e.preventDefault();
      const c = normCode($('#joinInput').value);
      if (c.length < 4) { toast('รหัสห้องต้องมีอย่างน้อย 4 ตัว', true); return; }
      goRoom(c);
    });
    $('#newRoom').addEventListener('click', () => goRoom(rand(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')));
    $('#autoRoom').addEventListener('click', () => goRoom(null));

    // drag & drop
    let dragDepth = 0;
    const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').classList.remove('show'); });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
      const files = [...e.dataTransfer.files]; if (files.length) { addFiles(files); toast('เพิ่ม ' + files.length + ' ไฟล์ แตะอุปกรณ์เพื่อส่ง'); }
    });

    // paste
    document.addEventListener('paste', e => {
      if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
      const cd = e.clipboardData; if (!cd) return;
      const files = [...cd.files];
      if (files.length) { e.preventDefault(); addFiles(files); toast('วาง ' + files.length + ' ไฟล์แล้ว'); return; }
      const t = cd.getData('text'); if (t && t.trim()) { e.preventDefault(); addTextOrLink(t); toast('วางแล้ว แตะอุปกรณ์เพื่อส่ง'); }
    });

    // tab visibility
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      unseen = 0; document.title = 'LocalSend Web';
      if (!peer) return;
      if (peer.destroyed) startPeer();
      else if (peer.disconnected) try { peer.reconnect(); } catch { }
      else if (!hubConn || !hubConn.open) scheduleRejoin(100);
    });
    window.addEventListener('online', () => { if (peer && peer.disconnected && !peer.destroyed) try { peer.reconnect(); } catch { } scheduleRejoin(500); });
    window.addEventListener('pagehide', () => {
      try { if (hubConn && hubConn.open) hubConn.send({ t: 'bye' }); } catch { }
      try { dropHub(); } catch { }
      try { peer && peer.destroy(); } catch { }
    });
    window.addEventListener('beforeunload', e => {
      const busy = [...transfers.values()].some(t => ['sending', 'receiving'].includes(t.status));
      if (busy) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ---------- boot ----------
  async function boot() {
    renderMe(); renderSelection(); renderDevices(); wire();
    if (typeof Peer === 'undefined' || !window.RTCPeerConnection) {
      setStatus('offline', 'เบราว์เซอร์นี้ไม่รองรับ WebRTC'); return;
    }
    room = await resolveRoom();
    renderRoom();
    startPeer();
  }
  boot();
})();
