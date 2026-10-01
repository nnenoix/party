/* Пати: аналог Jackbox. Экран ведущего + телефоны гостей. Связь через публичный MQTT-брокер. */
(() => {
const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const NS = 'nnx-party-v1/';
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.random() * CODE_CHARS.length | 0]).join('');
const joinUrl = code => location.origin + location.pathname + '?r=' + code;

function makeClient() {
  return new Promise(res => {
    let idx = 0;
    const attempt = () => {
      const url = BROKERS[idx % BROKERS.length];
      const c = mqtt.connect(url, { connectTimeout: 7000, reconnectPeriod: 1500, keepalive: 20, clean: true });
      let ok = false;
      const t = setTimeout(() => { if (!ok) { c.end(true); idx++; attempt(); } }, 9000);
      c.once('connect', () => { ok = true; clearTimeout(t); res(c); });
    };
    attempt();
  });
}

/* ---------------- routing ---------------- */
const params = new URLSearchParams(location.search);
const roomParam = (params.get('r') || '').toUpperCase().replace(/[^A-Z]/g, '');
if (location.hash === '#host') host();
else if (roomParam) player(roomParam);
else landing();

function landing() {
  app.innerHTML = `<div class="center fade">
    <div class="logo">ПАТИ</div>
    <p class="sub">Как Jackbox: один экран, гости играют с телефонов. Допиши, Враньё, Нарисуй.</p>
    <div class="row"><button class="big" id="mk">Создать комнату</button></div>
    <p class="mute">Или введи код комнаты</p>
    <div style="width:240px"><input id="code" class="code" maxlength="4" placeholder="ABCD" autocomplete="off"></div>
    <button class="ghost" id="go">Войти</button>
  </div>`;
  document.getElementById('mk').onclick = () => { location.hash = '#host'; location.reload(); };
  const go = () => { const v = document.getElementById('code').value.toUpperCase().replace(/[^A-Z]/g, ''); if (v.length === 4) location.href = joinUrl(v); };
  document.getElementById('go').onclick = go;
  document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

/* ================= HOST ================= */
async function host() {
  const code = genCode();
  const base = NS + code;
  app.innerHTML = `<div class="center"><div class="spin"></div><p>Подключаюсь…</p></div>`;
  const client = await makeClient();
  client.subscribe(base + '/h');
  const players = {};           // pid -> {name, score, total, on, view, seen}
  let collector = null;         // {pids:Set, got:{}, resolve}
  let skipFn = null;
  let timerUntil = 0;
  let inLobby = true;
  let gameIds = [];

  const send = (pid, view) => { const p = players[pid]; if (!p) return; p.view = view; client.publish(base + '/p/' + pid, JSON.stringify(view)); };
  const sendAll = fn => { for (const pid of Object.keys(players)) send(pid, typeof fn === 'function' ? fn(pid) : fn); };
  const waitView = (pid, text) => ({ screen: 'wait', text, score: players[pid]?.score || 0, name: players[pid]?.name });
  const onIds = () => Object.keys(players).filter(p => players[p].on);

  client.on('message', (t, m) => {
    let msg; try { msg = JSON.parse(m.toString()); } catch { return; }
    const pid = msg.pid; if (!pid) return;
    if (msg.t === 'join' || msg.t === 'hello') {
      const name = String(msg.name || '').trim().slice(0, 16) || 'Гость';
      if (!players[pid]) {
        players[pid] = { name, score: 0, total: 0, on: true, view: null };
        send(pid, inLobby ? { screen: 'lobby', text: 'Ты в игре. Жди старта на экране.', name } : waitView(pid, 'Игра уже идёт. Ты войдёшь в следующую.'));
      } else {
        players[pid].on = true; players[pid].name = name;
        if (players[pid].view) send(pid, players[pid].view); else send(pid, waitView(pid, 'Смотри на экран'));
      }
      players[pid].seen = Date.now();
      if (inLobby) renderLobby();
      return;
    }
    if (msg.t === 'act' && collector && collector.pids.has(pid) && !(pid in collector.got)) {
      collector.got[pid] = msg.v;
      send(pid, waitView(pid, 'Принято. Жди остальных'));
      updateStatus();
      if (Object.keys(collector.got).length >= collector.pids.size) collector.resolve();
    }
    if (msg.t === 'bye') { if (players[pid]) players[pid].on = false; if (inLobby) renderLobby(); }
  });

  /* ---- host rendering ---- */
  function shell(stageHtml, foot = true) {
    app.innerHTML = `<div class="h">
      <div class="bar"><div>Пати · <span class="code">${code}</span> · ${esc(location.host + location.pathname)}</div><div class="status" id="st"></div></div>
      <div class="stage fade" id="stage">${stageHtml}</div>
      ${foot ? `<div class="foot"><div class="tm" id="tm"></div><div><button class="ghost" id="skip">Дальше ▸</button></div></div>` : ''}
    </div>`;
    const sk = document.getElementById('skip'); if (sk) sk.onclick = () => skipFn && skipFn();
    updateStatus();
  }
  function stage(html) { const s = document.getElementById('stage'); if (s) { s.innerHTML = html; s.classList.remove('fade'); void s.offsetWidth; s.classList.add('fade'); } else shell(html); }
  function updateStatus() {
    const st = document.getElementById('st'); if (!st) return;
    if (collector) st.textContent = `Ответили ${Object.keys(collector.got).length} из ${collector.pids.size}`;
    else st.textContent = `${onIds().length} игроков`;
  }
  setInterval(() => {
    const tm = document.getElementById('tm'); if (!tm) return;
    const left = Math.max(0, Math.ceil((timerUntil - Date.now()) / 1000));
    tm.textContent = timerUntil ? left : '';
  }, 250);

  /* ---- primitives ---- */
  function wait(secs) {
    timerUntil = Date.now() + secs * 1000;
    return new Promise(res => { const t = setTimeout(done, secs * 1000); function done() { clearTimeout(t); skipFn = null; timerUntil = 0; res(); } skipFn = done; });
  }
  function collect(pids, viewFor, secs) {
    pids = pids.filter(p => players[p]);
    if (!pids.length) return Promise.resolve({});
    const until = Date.now() + secs * 1000;
    timerUntil = until;
    return new Promise(res => {
      collector = { pids: new Set(pids), got: {}, resolve: finish };
      const t = setTimeout(finish, secs * 1000 + 1500);
      function finish() { clearTimeout(t); const got = collector.got; collector = null; skipFn = null; timerUntil = 0; updateStatus(); res(got); }
      skipFn = finish;
      for (const pid of pids) { const v = viewFor(pid); v.until = until; v.score = players[pid].score; v.name = players[pid].name; send(pid, v); }
      updateStatus();
    });
  }
  const addScore = (pid, n) => { if (players[pid]) { players[pid].score += n; players[pid].total += n; } };
  const nameOf = pid => esc(players[pid]?.name || '?');

  function scoreboardHtml(key, title) {
    const ids = Object.keys(players).filter(p => players[p][key] > 0 || gameIds.includes(p));
    const sorted = ids.sort((a, b) => players[b][key] - players[a][key]);
    return `<h1>${title}</h1><div class="score">${sorted.map((p, i) => `<div class="sc ${i === 0 ? 'first' : ''}"><span class="n">${i + 1}</span><span>${nameOf(p)}</span><span class="v">${players[p][key]}</span></div>`).join('')}</div>`;
  }

  /* ---- lobby / menu ---- */
  function renderLobby() {
    inLobby = true;
    const ids = Object.keys(players);
    shell(`<div class="lobby">
      <div class="qr" id="qr"></div>
      <div>
        <div class="mute">Заходи с телефона</div>
        <div class="big" style="font-size:clamp(28px,4vw,48px)">${esc(location.host + location.pathname)}</div>
        <div class="mute" style="margin-top:14px">Код комнаты</div>
        <div class="big">${code}</div>
      </div>
    </div>
    <div class="players">${ids.length ? ids.map(p => `<span class="pl ${players[p].on ? '' : 'off'}">${nameOf(p)}</span>`).join('') : '<span class="mute">Пока никого. Нужно минимум 3 игрока.</span>'}</div>
    <div class="row"><button class="big" id="start" ${onIds().length < 3 ? 'disabled' : ''}>Выбрать игру</button></div>`, false);
    try { new QRCode(document.getElementById('qr'), { text: joinUrl(code), width: 220, height: 220 }); } catch { }
    document.getElementById('start').onclick = menu;
  }
  function menu() {
    inLobby = false;
    for (const p of Object.keys(players)) players[p].score = 0;
    gameIds = onIds();
    sendAll(pid => waitView(pid, 'Ведущий выбирает игру'));
    shell(`<h1>Во что играем?</h1>
      <div class="menu">
        <button class="game g1" data-g="quip"><b>Допиши</b><span>Фраза с пропуском, все дописывают, зал голосует за смешнее. Как Quiplash.</span></button>
        <button class="game g2" data-g="fib"><b>Враньё</b><span>Настоящий факт про свадьбы в мире. Все пишут враньё, потом ищут правду. Как Fibbage.</span></button>
        <button class="game g3" data-g="draw"><b>Нарисуй</b><span>Каждый рисует своё задание на телефоне, остальные угадывают. Как Drawful.</span></button>
      </div>
      <div class="row"><button class="ghost" id="back">◂ В лобби</button><span class="pill">${gameIds.length} игроков</span></div>`, false);
    document.querySelectorAll('.game').forEach(b => b.onclick = () => runGame(b.dataset.g));
    document.getElementById('back').onclick = () => { sendAll(pid => ({ screen: 'lobby', text: 'Ждём остальных', name: players[pid].name })); renderLobby(); };
  }
  async function runGame(g) {
    gameIds = onIds();
    if (gameIds.length < 3) return menu();
    shell('');
    if (g === 'quip') await quip(); else if (g === 'fib') await fib(); else await draw();
    stage(scoreboardHtml('score', 'Итоги игры'));
    sendAll(pid => ({ screen: 'score', text: 'Игра окончена', points: players[pid].score, total: players[pid].total, name: players[pid].name, score: players[pid].score }));
    await wait(15);
    stage(scoreboardHtml('total', 'Итого за вечер'));
    await wait(10);
    menu();
  }
  function title(h1, sub) { stage(`<h1>${h1}</h1>${sub ? `<h2 class="mute">${sub}</h2>` : ''}`); }

  /* ---- Допиши (Quiplash) ---- */
  async function quip() {
    const ids = gameIds;
    const pool = shuffle(CONTENT.quip);
    title('Допиши', 'Каждому придёт две фразы с пропуском. Допиши смешно. Потом зал голосует.');
    sendAll(pid => waitView(pid, 'Сейчас придут фразы'));
    await wait(6);
    for (let r = 1; r <= 2; r++) {
      const n = ids.length, order = shuffle(ids), prompts = pool.splice(0, n), mult = r;
      const mine = {}; order.forEach((p, i) => { mine[p] = [i, (i - 1 + n) % n]; });
      title(`Раунд ${r}`, 'Отвечайте на телефоне');
      const ans = await collect(ids, pid => ({ screen: 'text', title: `Раунд ${r}. Допиши`, prompts: mine[pid].map(i => ({ id: String(i), text: prompts[i] })) }), 90);
      for (let i = 0; i < n; i++) {
        const p1 = order[i], p2 = order[(i + 1) % n];
        const a1 = (ans[p1]?.answers?.[String(i)] || '').trim() || '…молчание…';
        const a2 = (ans[p2]?.answers?.[String(i)] || '').trim() || '…молчание…';
        const voters = ids.filter(p => p !== p1 && p !== p2);
        stage(`<h2>${esc(prompts[i])}</h2><div class="answers"><div class="ans">${esc(a1)}</div><div class="ans">${esc(a2)}</div></div><p class="mute">Голосуйте на телефоне</p>`);
        send(p1, waitView(p1, 'Это твоя фраза. Болей за себя')); send(p2, waitView(p2, 'Это твоя фраза. Болей за себя'));
        const votes = await collect(voters, () => ({ screen: 'vote', title: prompts[i], options: [{ id: 'a', text: a1 }, { id: 'b', text: a2 }] }), 25);
        let va = 0, vb = 0; for (const v of Object.values(votes)) { if (v?.vote === 'a') va++; else if (v?.vote === 'b') vb++; }
        const tot = va + vb || 1; let pa = va * 100 * mult, pb = vb * 100 * mult;
        if (tot >= 2 && (va === tot || vb === tot)) { if (va) pa += 150 * mult; else pb += 150 * mult; }
        addScore(p1, pa); addScore(p2, pb);
        stage(`<h2>${esc(prompts[i])}</h2><div class="answers">
          <div class="ans ${va >= vb && va ? 'win' : ''}"><span class="pts">+${pa}</span>${esc(a1)}<span class="who">${nameOf(p1)} · ${va} гол.</span><i class="bar2" style="width:${va / tot * 100}%"></i></div>
          <div class="ans ${vb > va ? 'win' : ''}"><span class="pts">+${pb}</span>${esc(a2)}<span class="who">${nameOf(p2)} · ${vb} гол.</span><i class="bar2" style="width:${vb / tot * 100}%"></i></div></div>`);
        await wait(6);
      }
      stage(scoreboardHtml('score', `После раунда ${r}`)); await wait(6);
    }
    // финал: одна фраза на всех
    const fp = pool.shift();
    title('Финал', 'Одна фраза на всех. Голос стоит 250.');
    const ans = await collect(ids, () => ({ screen: 'text', title: 'Финал', prompts: [{ id: 'f', text: fp }] }), 60);
    const entries = ids.map(p => ({ pid: p, text: (ans[p]?.answers?.f || '').trim() || '…молчание…' }));
    stage(`<h2>${esc(fp)}</h2><div class="opts">${shuffle(entries).map(e => `<div class="opt">${esc(e.text)}</div>`).join('')}</div><p class="mute">Выбирайте любимый ответ, кроме своего</p>`);
    const votes = await collect(ids, pid => ({ screen: 'vote', title: fp, options: shuffle(entries.filter(e => e.pid !== pid)).map(e => ({ id: e.pid, text: e.text })) }), 30);
    const cnt = {}; for (const v of Object.values(votes)) if (v?.vote) cnt[v.vote] = (cnt[v.vote] || 0) + 1;
    for (const e of entries) addScore(e.pid, (cnt[e.pid] || 0) * 250);
    stage(`<h2>${esc(fp)}</h2><div class="opts">${entries.sort((a, b) => (cnt[b.pid] || 0) - (cnt[a.pid] || 0)).map(e => `<div class="opt ${cnt[e.pid] ? '' : ''}">${esc(e.text)}<span class="who">${nameOf(e.pid)} · ${cnt[e.pid] || 0} гол. · +${(cnt[e.pid] || 0) * 250}</span></div>`).join('')}</div>`);
    await wait(8);
  }

  /* ---- Враньё (Fibbage) ---- */
  async function fib() {
    const ids = gameIds;
    const facts = shuffle(CONTENT.fib).slice(0, 5);
    title('Враньё', 'Факт с пропуском. Каждый пишет правдоподобное враньё. Потом все ищут правду.');
    sendAll(pid => waitView(pid, 'Сейчас придёт факт'));
    await wait(6);
    for (let k = 0; k < facts.length; k++) {
      const f = facts[k];
      stage(`<div class="mute">Факт ${k + 1} из ${facts.length}</div><h1>${esc(f.q)}</h1><p class="mute">Пишите враньё на телефоне</p>`);
      const lies = await collect(ids, () => ({ screen: 'text', title: 'Напиши враньё, в которое поверят', prompts: [{ id: 'l', text: f.q }] }), 60);
      const opts = [{ id: 'T', text: f.a, authors: [] }];
      const guessed = [];
      for (const p of ids) {
        const t = (lies[p]?.answers?.l || '').trim(); if (!t) continue;
        if (norm(t) === norm(f.a)) { guessed.push(p); continue; }
        const same = opts.find(o => o.id !== 'T' && norm(o.text) === norm(t));
        if (same) same.authors.push(p); else opts.push({ id: uid(), text: t, authors: [p] });
      }
      const shown = shuffle(opts);
      stage(`<h2>${esc(f.q)}</h2><div class="opts">${shown.map(o => `<div class="opt">${esc(o.text)}</div>`).join('')}</div><p class="mute">Где правда? Голосуйте</p>`);
      const voters = ids.filter(p => !guessed.includes(p));
      for (const p of guessed) { addScore(p, 500); send(p, waitView(p, 'Ты угадал правду сразу: +500')); }
      const votes = await collect(voters, pid => ({ screen: 'vote', title: f.q, options: shown.filter(o => !o.authors.includes(pid)).map(o => ({ id: o.id, text: o.text })) }), 30);
      const picked = {}; for (const [p, v] of Object.entries(votes)) { if (v?.vote) (picked[v.vote] ||= []).push(p); }
      for (const p of picked.T || []) addScore(p, 1000);
      for (const o of opts) if (o.id !== 'T') for (const a of o.authors) addScore(a, 500 * (picked[o.id] || []).length);
      stage(`<h2>${esc(f.q)}</h2><div class="opts">${shown.map(o => `<div class="opt ${o.id === 'T' ? 'truth' : ''}">${esc(o.text)}<span class="who">${o.id === 'T' ? 'ПРАВДА' : 'врёт ' + o.authors.map(nameOf).join(', ')}${(picked[o.id] || []).length ? ' · поверили: ' + picked[o.id].map(nameOf).join(', ') : ''}</span></div>`).join('')}</div>`);
      await wait(8);
    }
  }

  /* ---- Нарисуй (Drawful) ---- */
  async function draw() {
    const ids = gameIds;
    const prompts = shuffle(CONTENT.draw);
    const mine = {}; ids.forEach((p, i) => mine[p] = prompts[i]);
    title('Нарисуй', 'Каждому придёт задание. Рисуй на телефоне. Остальные будут угадывать.');
    sendAll(pid => waitView(pid, 'Сейчас придёт задание'));
    await wait(5);
    title('Рисуем', 'Две минуты');
    const imgs = await collect(ids, pid => ({ screen: 'draw', title: 'Нарисуй это', prompt: mine[pid] }), 120);
    const artists = ids.filter(p => imgs[p]?.img);
    if (!artists.length) { title('Никто ничего не нарисовал', 'Ну и ладно'); await wait(4); return; }
    for (const art of shuffle(artists)) {
      const img = imgs[art].img, truth = mine[art];
      const others = ids.filter(p => p !== art);
      stage(`<div class="pic"><img src="${img}"></div><p class="mute">Что это? Пишите на телефоне</p>`);
      send(art, waitView(art, 'Это твой рисунок. Молчи и наслаждайся'));
      const titles = await collect(others, () => ({ screen: 'text', title: 'Что нарисовано?', prompts: [{ id: 't', text: 'Смотри на экран и напиши, что это' }] }), 45);
      const opts = [{ id: 'T', text: truth, authors: [] }];
      const guessed = [];
      for (const p of others) {
        const t = (titles[p]?.answers?.t || '').trim(); if (!t) continue;
        if (norm(t) === norm(truth)) { guessed.push(p); continue; }
        const same = opts.find(o => o.id !== 'T' && norm(o.text) === norm(t));
        if (same) same.authors.push(p); else opts.push({ id: uid(), text: t, authors: [p] });
      }
      const shown = shuffle(opts);
      stage(`<div class="pic" style="width:min(40vh,360px)"><img src="${img}"></div><div class="opts">${shown.map(o => `<div class="opt">${esc(o.text)}</div>`).join('')}</div>`);
      for (const p of guessed) { addScore(p, 1000); addScore(art, 500); send(p, waitView(p, 'Угадал сразу: +1000')); }
      const voters = others.filter(p => !guessed.includes(p));
      const votes = await collect(voters, pid => ({ screen: 'vote', title: 'Что это?', options: shown.filter(o => !o.authors.includes(pid)).map(o => ({ id: o.id, text: o.text })) }), 30);
      const picked = {}; for (const [p, v] of Object.entries(votes)) { if (v?.vote) (picked[v.vote] ||= []).push(p); }
      for (const p of picked.T || []) { addScore(p, 1000); addScore(art, 500); }
      for (const o of opts) if (o.id !== 'T') for (const a of o.authors) addScore(a, 500 * (picked[o.id] || []).length);
      stage(`<div class="pic" style="width:min(36vh,320px)"><img src="${img}"></div><h2>${nameOf(art)} рисовал: ${esc(truth)}</h2><div class="opts">${shown.map(o => `<div class="opt ${o.id === 'T' ? 'truth' : ''}">${esc(o.text)}<span class="who">${o.id === 'T' ? 'ПРАВДА' : o.authors.map(nameOf).join(', ')}${(picked[o.id] || []).length ? ' · выбрали: ' + picked[o.id].map(nameOf).join(', ') : ''}</span></div>`).join('')}</div>`);
      await wait(8);
    }
  }

  renderLobby();
}

/* ================= PLAYER ================= */
async function player(room) {
  const base = NS + room;
  let pid = localStorage.getItem('nnx-pid'); if (!pid) { pid = uid(); localStorage.setItem('nnx-pid', pid); }
  let name = localStorage.getItem('nnx-name') || '';
  const dev = params.get('p'); if (dev) { pid = 'dev-' + norm(dev).replace(/\s+/g, '-'); name = dev; }
  if (!name) {
    await new Promise(res => {
      app.innerHTML = `<div class="center fade"><div class="logo" style="font-size:40px">ПАТИ</div><p class="sub">Комната <b>${esc(room)}</b>. Как тебя зовут?</p>
        <div style="width:min(320px,100%)"><input id="nm" maxlength="16" placeholder="Имя" autocomplete="off"></div><button class="big" id="ok">Войти</button></div>`;
      const inp = document.getElementById('nm'); inp.focus();
      const go = () => { const v = inp.value.trim(); if (!v) return; name = v; localStorage.setItem('nnx-name', v); res(); };
      document.getElementById('ok').onclick = go; inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }
  app.innerHTML = `<div class="center"><div class="spin"></div><p>Подключаюсь к комнате ${esc(room)}…</p></div>`;
  const client = await makeClient();
  client.subscribe(base + '/p/' + pid);
  const act = v => client.publish(base + '/h', JSON.stringify({ t: 'act', pid, v }));
  const hello = t => client.publish(base + '/h', JSON.stringify({ t, pid, name }));
  hello('join');
  client.on('connect', () => hello('hello'));
  let view = null, score = 0;
  let joinedTimer = setTimeout(() => { if (!view) app.innerHTML = `<div class="center"><p class="sub">Комната ${esc(room)} не отвечает. Проверь код на экране и обнови страницу.</p><button class="ghost" onclick="location.href='${location.pathname}'">Другой код</button></div>`; }, 12000);
  client.on('message', (t, m) => { let v; try { v = JSON.parse(m.toString()); } catch { return; } clearTimeout(joinedTimer); view = v; if (typeof v.score === 'number') score = v.score; render(v); });
  window.addEventListener('beforeunload', () => { try { client.publish(base + '/h', JSON.stringify({ t: 'bye', pid })); } catch { } });

  function top() { return `<div class="top"><span><b>${esc(name)}</b> · ${esc(room)}</span><span>${score} очк.</span></div>`; }
  function timerHtml(v) { if (!v.until) return ''; const left = Math.max(0, v.until - Date.now()); const total = Math.max(left, 1000); return `<div class="timer"><i style="animation:tmr ${left}ms linear forwards"></i></div><style>@keyframes tmr{from{transform:scaleX(${Math.min(1, left / (v.dur || left || 1))})}to{transform:scaleX(0)}}</style>`; }
  function render(v) {
    const s = v.screen;
    if (s === 'lobby' || s === 'wait') {
      app.innerHTML = `<div class="p fade">${top()}<div class="wait"><div class="logo" style="font-size:34px">ПАТИ</div><div>${esc(v.text || '')}</div></div></div>`;
    } else if (s === 'score') {
      app.innerHTML = `<div class="p fade">${top()}<div class="wait"><div>${esc(v.text || '')}</div><div class="res">+${v.points}</div><div class="mute">Всего за вечер: ${v.total}</div></div></div>`;
    } else if (s === 'text') {
      app.innerHTML = `<div class="p fade">${top()}${timerHtml(v)}<h2>${esc(v.title || '')}</h2>
        ${v.prompts.map(p => `<div class="prompt">${esc(p.text)}</div><textarea data-id="${esc(p.id)}" maxlength="90" placeholder="Твой вариант"></textarea>`).join('')}
        <button class="big" id="send">Отправить</button></div>`;
      const first = app.querySelector('textarea'); if (first) first.focus();
      document.getElementById('send').onclick = () => {
        const answers = {}; app.querySelectorAll('textarea').forEach(t => answers[t.dataset.id] = t.value.trim());
        act({ answers }); render({ screen: 'wait', text: 'Отправлено. Жди остальных' });
      };
    } else if (s === 'vote') {
      app.innerHTML = `<div class="p fade">${top()}${timerHtml(v)}<h2>${esc(v.title || '')}</h2>
        ${v.options.map(o => `<button class="opt" data-id="${esc(o.id)}">${esc(o.text)}</button>`).join('')}</div>`;
      app.querySelectorAll('.opt').forEach(b => b.onclick = () => { b.classList.add('sel'); act({ vote: b.dataset.id }); setTimeout(() => render({ screen: 'wait', text: 'Голос принят' }), 300); });
    } else if (s === 'draw') {
      app.innerHTML = `<div class="p fade">${top()}${timerHtml(v)}<div class="prompt">${esc(v.prompt)}</div>
        <canvas class="pad" id="pad" width="360" height="360"></canvas>
        <div class="tools">${['#111', '#e63946', '#2a9d8f', '#f4a261', '#4361ee', '#9b5de5'].map((c, i) => `<button class="sw ${i === 0 ? 'on' : ''}" style="background:${c}" data-c="${c}"></button>`).join('')}<button class="ghost" id="clr" style="margin-left:auto">Стереть</button></div>
        <button class="big" id="send">Готово</button></div>`;
      const cv = document.getElementById('pad'), ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 7; ctx.strokeStyle = '#111';
      const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
      let drawing = false;
      cv.addEventListener('pointerdown', e => { drawing = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .1, y); ctx.stroke(); });
      cv.addEventListener('pointermove', e => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
      const up = () => { drawing = false; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      app.querySelectorAll('.sw').forEach(b => b.onclick = () => { app.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); ctx.strokeStyle = b.dataset.c; });
      document.getElementById('clr').onclick = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); };
      document.getElementById('send').onclick = () => {
        const small = document.createElement('canvas'); small.width = small.height = 240; small.getContext('2d').drawImage(cv, 0, 0, 240, 240);
        act({ img: small.toDataURL('image/jpeg', 0.7) }); render({ screen: 'wait', text: 'Шедевр отправлен' });
      };
    }
  }
}
})();
