'use strict';

/* Duolat — прототип тренажёра латышского языка.
   Без сервера и без регистрации: прогресс хранится в localStorage телефона.
   Тексты уроков — в content.json. */

const STORAGE_KEY = 'duolat:v1';
const INSTALL_DISMISS_KEY = 'duolat:installDismissed';
const XP_PER_LESSON = 10;
const SPEAK_PASS = 0.65;            // насколько распознанная фраза должна совпасть с образцом (0..1)
const SPEAK_TRIES_BEFORE_ACCEPT = 3; // после стольких попыток можно засчитать фразу вручную
const VOICE_MIN_MS = 500;           // сколько миллисекунд голоса нужно в режиме «без распознавания»

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');

let content = null;
let progress = loadProgress();
let lesson = null;
let deferredInstall = null;

/* ---------- мелкие помощники ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function plural(n, forms) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

function stripPunct(w) {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Для сравнения речи: без регистра, знаков препинания и диакритики (ā → a, š → s).
function normalizeLoose(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Для сборки фразы: без регистра и знаков препинания, но диакритика важна.
function wordsStrict(s) {
  return String(s).toLowerCase().split(/\s+/).map(stripPunct).filter(Boolean);
}

function similarity(a, b) {
  a = normalizeLoose(a);
  b = normalizeLoose(b);
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

/* ---------- прогресс и серия дней ---------- */

function defaultProgress() {
  return { completed: {}, xp: 0, streak: 0, lastDay: null, days: [] };
}

function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (p && typeof p === 'object') return Object.assign(defaultProgress(), p);
  } catch (e) { /* пустое или битое хранилище — начинаем заново */ }
  return defaultProgress();
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    toast('Не получилось сохранить прогресс на телефоне.');
  }
}

function currentStreak() {
  if (!progress.lastDay) return 0;
  return daysBetween(progress.lastDay, dayKey()) <= 1 ? progress.streak : 0;
}

function markLessonDone(id, stats) {
  const today = dayKey();
  const prev = progress.lastDay;
  if (prev !== today) {
    progress.streak = prev && daysBetween(prev, today) === 1 ? progress.streak + 1 : 1;
    progress.lastDay = today;
    if (!progress.days.includes(today)) progress.days.push(today);
    if (progress.days.length > 400) progress.days = progress.days.slice(-400);
  }
  const c = progress.completed[id] || { times: 0, spoken: 0 };
  c.times += 1;
  c.spoken = (c.spoken || 0) + stats.spoken;
  c.lastAt = new Date().toISOString();
  progress.completed[id] = c;
  progress.xp += XP_PER_LESSON;
  saveProgress();
}

function isUnlocked(l) {
  const i = content.lessons.indexOf(l);
  return i === 0 || !!progress.completed[content.lessons[i - 1].id];
}

/* ---------- что умеет этот телефон ---------- */

const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
const caps = {
  recognition: !!Rec,
  mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  synth: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  lvVoice: null,
  voicesReady: false,
};
const NO_REC_KEY = 'duolat:noRecognition';

function recognitionBlocked() {
  // На iPhone распознавание латышского не работает: микрофон включается, но ответа нет.
  if (isIOS()) return true;
  try { return localStorage.getItem(NO_REC_KEY) === '1'; } catch (e) { return false; }
}

// recognition — проверяем произношение; voice — только слышим голос; none — микрофона нет.
let speechMode = caps.recognition && !recognitionBlocked() ? 'recognition' : caps.mic ? 'voice' : 'none';

// Распознавание на этом телефоне не работает — дальше засчитываем по голосу (и запоминаем).
function disableRecognition(remember) {
  speechMode = caps.mic ? 'voice' : 'none';
  if (remember) { try { localStorage.setItem(NO_REC_KEY, '1'); } catch (e) { /* нет хранилища */ } }
}

function findLvVoice() {
  if (!caps.synth) return null;
  return speechSynthesis.getVoices().find((v) => /^lv([-_]|$)/i.test(v.lang)) || null;
}

function loadVoices() {
  return new Promise((resolve) => {
    if (!caps.synth) { caps.voicesReady = true; resolve(); return; }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      caps.lvVoice = findLvVoice();
      caps.voicesReady = true;
      resolve();
    };
    speechSynthesis.addEventListener('voiceschanged', () => { caps.lvVoice = findLvVoice(); done(); });
    if (speechSynthesis.getVoices().length) done();
    setTimeout(done, 1500);
  });
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/* ---------- озвучка ---------- */

let currentAudio = null;

function hasRecording(text) {
  return !!(content && content.audio && content.audio[text]);
}

function canSpeak(text) {
  return hasRecording(text) || !!caps.lvVoice;
}

function speakLv(text, slow = false) {
  stopSpeaking();
  if (hasRecording(text)) {
    currentAudio = new Audio(content.audio[text]);
    currentAudio.playbackRate = slow ? 0.75 : 1;
    currentAudio.play().catch(() => {});
    return true;
  }
  if (!caps.lvVoice) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.voice = caps.lvVoice;
  u.lang = caps.lvVoice.lang || 'lv-LV';
  u.rate = slow ? 0.6 : 0.9;
  speechSynthesis.speak(u);
  return true;
}

function stopSpeaking() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (caps.synth) speechSynthesis.cancel();
}

// iPhone разрешает звук только после нажатия — «разогреваем» синтезатор при нажатии «Начать».
function unlockAudio() {
  if (!caps.synth) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (e) { /* не страшно */ }
}

function speakerButtons(text) {
  if (!canSpeak(text)) return '';
  return `<div class="speak-row">
    <button class="sound-btn" data-say="${esc(text)}" aria-label="Послушать">🔊 Послушать</button>
    <button class="sound-btn slow" data-say-slow="${esc(text)}" aria-label="Послушать медленно">🐢 Медленно</button>
  </div>`;
}

function bindSpeakerButtons(root) {
  root.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', () => speakLv(b.dataset.say)));
  root.querySelectorAll('[data-say-slow]').forEach((b) => b.addEventListener('click', () => speakLv(b.dataset.saySlow, true)));
}

/* ---------- микрофон ---------- */

let activeRec = null;
let activeVoice = null;

// Ошибки, после которых распознавание на этом телефоне не пробуем.
const REC_BROKEN = ['timeout', 'language-not-supported', 'service-not-allowed', 'not-supported', 'start-failed', 'bad-grammar'];

function recognizeOnce() {
  return new Promise((resolve, reject) => {
    let rec;
    try { rec = new Rec(); } catch (e) { reject('not-supported'); return; }
    rec.lang = 'lv-LV';
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.continuous = false;
    const finals = [];
    let interim = '';
    let error = null;
    let settled = false;
    let graceTimer = 0;

    // reason === 'timeout': распознавание так и не ответило (бывает на iPhone и во встроенных браузерах).
    const settle = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      activeRec = null;
      const results = finals.length ? finals : interim ? [interim] : [];
      if (results.length) resolve(results);
      else if (reason === 'timeout') reject('timeout');
      else if (error && error !== 'no-speech' && error !== 'aborted') reject(error);
      else resolve([]);
    };

    const stopTimer = setTimeout(() => { try { rec.stop(); } catch (e) { /* уже остановлен */ } }, 8000);
    const hardTimer = setTimeout(() => { try { rec.abort(); } catch (e) { /* уже остановлен */ } settle('timeout'); }, 11000);

    rec.onresult = (e) => {
      let now = '';
      for (let r = e.resultIndex || 0; r < e.results.length; r++) {
        const res = e.results[r];
        if (res.isFinal) { for (let i = 0; i < res.length; i++) finals.push(res[i].transcript); }
        else now += res[0].transcript;
      }
      interim = now;
    };
    rec.onerror = (e) => { error = e.error || 'error'; };
    rec.onend = () => settle();

    activeRec = {
      // «Я закончил»: ждём ответ ещё 2 секунды, потом считаем, что распознавание зависло.
      stop() {
        try { rec.stop(); } catch (e) { /* уже остановлен */ }
        graceTimer = setTimeout(() => settle('timeout'), 2000);
      },
      abort() {
        try { rec.abort(); } catch (e) { /* уже остановлен */ }
        settle();
      },
    };
    try { rec.start(); } catch (e) { settled = true; clearTimeout(stopTimer); clearTimeout(hardTimer); activeRec = null; reject('start-failed'); }
  });
}

// Режим без распознавания: слушаем микрофон и проверяем, что голос действительно звучал.
// Вызывать прямо из нажатия: iPhone «будит» звук только в момент нажатия, иначе микрофон слышит тишину.
async function startVoiceSession(onLevel) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const resumed = ctx.resume ? ctx.resume().catch(() => {}) : Promise.resolve();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    ctx.close().catch(() => {});
    throw e;
  }
  await resumed;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  let recorder = null;
  const chunks = [];
  if (window.MediaRecorder) {
    try {
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start();
    } catch (e) { recorder = null; }
  }

  let stopFn;
  const done = new Promise((resolve) => {
    const THRESH = 0.03;
    const start = performance.now();
    let last = start, voiced = 0, lastVoiceAt = 0, raf = 0, stopped = false;

    const finish = () => {
      const close = (url) => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        activeVoice = null;
        resolve({ voicedMs: voiced, url });
      };
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = () => close(chunks.length ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' })) : null);
        recorder.stop();
      } else {
        close(null);
      }
    };

    stopFn = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      finish();
    };

    const tick = (now) => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const dt = now - last;
      last = now;
      if (rms > THRESH) { voiced += dt; lastVoiceAt = now; }
      if (onLevel) onLevel(Math.min(1, rms / 0.2));
      const elapsed = now - start;
      if (elapsed > 8000 || (voiced > VOICE_MIN_MS && now - lastVoiceAt > 1300)) { stopFn(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  activeVoice = { stop: () => stopFn() };
  return { done, stop: () => stopFn() };
}

function stopMic() {
  if (activeRec) { try { activeRec.abort(); } catch (e) { /* уже остановлен */ } activeRec = null; }
  if (activeVoice) { activeVoice.stop(); }
}

function stopAll() {
  stopSpeaking();
  stopMic();
}

const MIC_HELP = `
  <div class="help-box">
    <b>Как разрешить микрофон</b>
    <p><b>iPhone:</b> Настройки → Safari → Микрофон → «Разрешить». Или нажми «аА» слева от адреса → «Настройки веб-сайта» → Микрофон.</p>
    <p><b>Android (Chrome):</b> нажми на значок слева от адреса → «Разрешения» → Микрофон → «Разрешить». Если приложение установлено: Настройки телефона → Приложения → Chrome → Разрешения → Микрофон.</p>
    <p>Потом закрой и снова открой Duolat.</p>
  </div>`;

/* ---------- маршруты ---------- */

function route() {
  stopAll();
  closeModal();
  const h = location.hash || '#/';
  if (h.startsWith('#/lesson/')) {
    const id = decodeURIComponent(h.slice('#/lesson/'.length));
    const l = content.lessons.find((x) => x.id === id);
    if (l && isUnlocked(l)) { startLesson(l); return; }
    location.replace('#/');
    return;
  }
  if (h === '#/check') { renderCheck(); return; }
  renderHome();
}

/* ---------- главный экран: путь из уроков ---------- */

function supportNotices() {
  const n = [];
  if (speechMode === 'none') n.push('Микрофон в этом браузере недоступен — задание «Скажи вслух» не пройти.');
  else if (speechMode === 'voice') n.push('Произношение здесь не проверяется — засчитывается голос.');
  if (caps.voicesReady && !caps.lvVoice) n.push('Нет латышского голоса для озвучки — где-то вместо звука будет текст.');
  return n;
}

function installCard() {
  if (isStandalone()) return '';
  let dismissed = false;
  try { dismissed = localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch (e) { /* нет хранилища */ }
  if (dismissed) return '';
  if (deferredInstall) {
    return `<div class="card install">
      <p><b>Поставь Duolat на телефон</b> — будет открываться как обычное приложение.</p>
      <button class="btn btn-primary" id="install-btn">📲 Установить</button>
      <button class="link-btn" id="install-dismiss">Не сейчас</button>
    </div>`;
  }
  if (isIOS()) {
    return `<div class="card install">
      <p><b>Поставь Duolat на экран «Домой»:</b></p>
      <ol class="steps">
        <li>Внизу Safari нажми <b>«Поделиться»</b> (квадрат со стрелкой ⬆️).</li>
        <li>Пролистай и выбери <b>«На экран „Домой“»</b>.</li>
        <li>Нажми <b>«Добавить»</b>.</li>
      </ol>
      <button class="link-btn" id="install-dismiss">Понятно</button>
    </div>`;
  }
  return '';
}

function renderHome() {
  lesson = null;
  const streak = currentStreak();
  const doneToday = progress.lastDay === dayKey();
  const notices = supportNotices();
  const nextIdx = content.lessons.findIndex((l) => !progress.completed[l.id]);

  $app.innerHTML = `
    <header class="topbar">
      <div class="logo"><span class="logo-mark">Ā</span> Duolat</div>
      <div class="chip" aria-label="Опыт">⭐ ${progress.xp}</div>
    </header>
    <section class="screen home">
      <div class="card streak ${doneToday ? 'on' : ''}">
        <div class="streak-fire" aria-hidden="true">🔥</div>
        <div>
          <div class="streak-num">${streak} ${plural(streak, ['день', 'дня', 'дней'])} подряд</div>
          <div class="streak-sub">${doneToday ? 'Сегодня урок уже пройден ✓' : streak ? 'Пройди урок сегодня, чтобы серия не прервалась' : 'Пройди первый урок — начнётся серия'}</div>
        </div>
      </div>

      ${installCard()}

      ${notices.length ? `<a class="notice" href="#/check">⚠️ ${notices.map(esc).join(' ')} <u>Подробнее</u></a>` : ''}

      <h1 class="section-title">Латышский · A1</h1>
      <p class="section-sub">Уроки по 3–5 минут. В каждом нужно сказать фразу вслух.</p>

      <ol class="path">
        ${content.lessons.map((l, i) => {
          const done = !!progress.completed[l.id];
          const open = isUnlocked(l);
          const state = done ? 'done' : open ? 'current' : 'locked';
          const sub = done ? 'Пройден ✓ · можно повторить' : open ? esc(l.subtitle) : 'Откроется после предыдущего';
          return `<li class="node ${state} ${i === nextIdx ? 'next' : ''}">
            <button class="node-btn" data-lesson="${esc(l.id)}" ${open ? '' : 'aria-disabled="true"'}>
              <span class="node-circle" aria-hidden="true">${done ? '✓' : open ? l.icon : '🔒'}</span>
              <span class="node-text">
                <span class="node-step">Урок ${i + 1}</span>
                <span class="node-title">${esc(l.title)}</span>
                <span class="node-sub">${sub}</span>
              </span>
            </button>
          </li>`;
        }).join('')}
      </ol>

      <p class="draft-note">Прототип. Латышские тексты ещё не проверены носителем языка.</p>
      <a class="link-btn block" href="#/check">🎙️ Проверить звук и микрофон</a>
    </section>`;

  $app.querySelectorAll('[data-lesson]').forEach((b) => b.addEventListener('click', () => {
    const l = content.lessons.find((x) => x.id === b.dataset.lesson);
    if (!isUnlocked(l)) {
      const prev = content.lessons[content.lessons.indexOf(l) - 1];
      toast(`Сначала пройди урок «${prev.title}»`);
      return;
    }
    openLessonSheet(l);
  }));

  const ib = document.getElementById('install-btn');
  if (ib) ib.addEventListener('click', async () => {
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) { /* закрыли окно */ }
    deferredInstall = null;
    renderHome();
  });
  const idm = document.getElementById('install-dismiss');
  if (idm) idm.addEventListener('click', () => {
    try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch (e) { /* нет хранилища */ }
    renderHome();
  });
}

/* ---------- модальные окна ---------- */

function openModal(html, onMount) {
  $modal.innerHTML = `<div class="modal-back"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = $modal.querySelector('.modal-back');
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  if (onMount) onMount($modal.querySelector('.sheet'));
}

function closeModal() {
  $modal.innerHTML = '';
}

function openLessonSheet(l) {
  const speakCount = l.tasks.filter((t) => t.type === 'speak').length;
  openModal(`
    <div class="sheet-icon">${l.icon}</div>
    <h2 class="sheet-title">${esc(l.title)}</h2>
    <p class="sheet-sub">${l.tasks.length} ${plural(l.tasks.length, ['задание', 'задания', 'заданий'])} · около 4 минут · вслух: ${speakCount}</p>
    ${l.tip ? `<div class="tip"><b>Совет.</b> ${esc(l.tip)}</div>` : ''}
    <button class="btn btn-primary" id="start">Начать</button>
    <button class="link-btn block" id="later">Не сейчас</button>
  `, (sheet) => {
    sheet.querySelector('#start').addEventListener('click', () => {
      unlockAudio();
      closeModal();
      location.hash = '#/lesson/' + encodeURIComponent(l.id);
    });
    sheet.querySelector('#later').addEventListener('click', closeModal);
    sheet.querySelector('#start').focus();
  });
}

/* ---------- урок ---------- */

function startLesson(l) {
  lesson = {
    data: l,
    queue: l.tasks.map((t) => Object.assign({}, t)),
    total: l.tasks.length,
    done: 0,
    mistakes: 0,
    spoken: 0,
    current: null,
    view: null,
  };
  nextTask();
}

function nextTask() {
  stopAll();
  if (!lesson.queue.length) { finishLesson(); return; }
  lesson.current = lesson.queue.shift();
  renderTask();
}

function renderTask() {
  const t = lesson.current;
  const view = ({ choose: taskChoose, listen: taskListen, build: taskBuild, speak: taskSpeak }[t.type] || taskUnknown)(t);
  lesson.view = view;
  const pct = Math.round((lesson.done / lesson.total) * 100);

  $app.innerHTML = `
    <section class="lesson">
      <div class="lesson-top">
        <button class="icon-btn" id="quit" aria-label="Выйти из урока">✕</button>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="task">${view.html}</div>
      <footer class="lesson-foot" id="foot">
        ${view.checkable ? '<button class="btn btn-primary" id="check" disabled>Проверить</button>' : ''}
      </footer>
    </section>`;

  document.getElementById('quit').addEventListener('click', confirmQuit);
  const root = $app.querySelector('.task');
  bindSpeakerButtons(root);
  const checkBtn = document.getElementById('check');
  if (checkBtn) checkBtn.addEventListener('click', () => checkAnswer());
  view.mount(root, (ready) => { if (checkBtn) checkBtn.disabled = !ready; });
}

function setProgressBar() {
  const pct = Math.round((lesson.done / lesson.total) * 100);
  const fill = $app.querySelector('.bar-fill');
  if (fill) fill.style.width = pct + '%';
  const bar = $app.querySelector('.bar');
  if (bar) bar.setAttribute('aria-valuenow', pct);
}

const PRAISE = ['Верно!', 'Отлично!', 'Так держать!', 'Правильно!', 'Хорошо идёшь!'];

function checkAnswer() {
  const res = lesson.view.check();
  lesson.view.lock();
  if (res.ok) {
    lesson.done += 1;
    setProgressBar();
    showFeedback(true, pick(PRAISE), res.detail || '');
  } else {
    lesson.mistakes += 1;
    lesson.queue.push(lesson.current); // задание вернётся в конце урока
    showFeedback(false, 'Почти. Правильно так:',
      `<span lang="lv" class="fb-answer">${esc(res.correct)}</span>
       ${res.say && canSpeak(res.say) ? `<button class="sound-btn small" data-say="${esc(res.say)}">🔊</button>` : ''}
       <div class="fb-note">Это задание вернётся в конце урока.</div>`);
  }
}

function showFeedback(ok, title, detailHtml) {
  const foot = document.getElementById('foot');
  foot.className = 'lesson-foot ' + (ok ? 'ok' : 'bad');
  foot.innerHTML = `
    <div class="fb" role="status">
      <div class="fb-title">${ok ? '✓ ' : ''}${esc(title)}</div>
      ${detailHtml ? `<div class="fb-detail">${detailHtml}</div>` : ''}
    </div>
    <button class="btn ${ok ? 'btn-ok' : 'btn-warn'}" id="next">Дальше</button>`;
  bindSpeakerButtons(foot);
  const next = document.getElementById('next');
  next.addEventListener('click', nextTask);
  next.focus();
}

function confirmQuit() {
  openModal(`
    <h2 class="sheet-title">Выйти из урока?</h2>
    <p class="sheet-sub">Этот урок придётся начать заново. Уже пройденные уроки сохранены.</p>
    <button class="btn btn-primary" id="stay">Продолжить урок</button>
    <button class="link-btn block" id="leave">Выйти</button>
  `, (sheet) => {
    sheet.querySelector('#stay').addEventListener('click', closeModal);
    sheet.querySelector('#leave').addEventListener('click', () => { closeModal(); location.hash = '#/'; });
  });
}

function finishLesson() {
  const l = lesson.data;
  markLessonDone(l.id, { spoken: lesson.spoken });
  const streak = currentStreak();
  const clean = lesson.mistakes === 0;
  $app.innerHTML = `
    <section class="screen result">
      <div class="result-icon" aria-hidden="true">🎉</div>
      <h1 class="result-title">Урок пройден!</h1>
      <p class="result-sub">«${esc(l.title)}» — готово${clean ? ', и без единой ошибки' : ''}.</p>
      <div class="stats">
        <div class="stat"><b>+${XP_PER_LESSON}</b><span>опыта</span></div>
        <div class="stat"><b>🔥 ${streak}</b><span>${plural(streak, ['день', 'дня', 'дней'])} подряд</span></div>
        <div class="stat"><b>🎙️ ${lesson.spoken}</b><span>${plural(lesson.spoken, ['фраза', 'фразы', 'фраз'])} вслух</span></div>
      </div>
      <p class="result-msg">Фразы сказаны вслух — так язык переходит из «понимаю» в «говорю». Завтра — следующий урок, чтобы серия не прервалась.</p>
      <button class="btn btn-primary" id="continue">Продолжить</button>
    </section>`;
  const btn = document.getElementById('continue');
  btn.addEventListener('click', () => { location.hash = '#/'; });
  btn.focus();
  lesson = null;
}

/* ---------- задания: выбрать вариант (choose и listen) ---------- */

function optionsTask({ title, promptHtml, options, optionsLang, answer, correctText, say, autoSay, note }) {
  const opts = shuffle(options);
  let selected = null;
  let root = null;
  return {
    checkable: true,
    html: `
      <h2 class="task-title">${title}</h2>
      ${note ? `<p class="task-note">${note}</p>` : ''}
      ${promptHtml}
      <div class="options" role="radiogroup">
        ${opts.map((o, i) => `
          <button class="option" role="radio" aria-checked="false" data-i="${i}" lang="${optionsLang}">
            <span class="opt-num" aria-hidden="true">${i + 1}</span><span class="opt-text">${esc(o)}</span>
          </button>`).join('')}
      </div>`,
    mount(r, setReady) {
      root = r;
      root.querySelectorAll('.option').forEach((b) => b.addEventListener('click', () => {
        if (b.disabled) return;
        root.querySelectorAll('.option').forEach((x) => { x.classList.remove('selected'); x.setAttribute('aria-checked', 'false'); });
        b.classList.add('selected');
        b.setAttribute('aria-checked', 'true');
        selected = opts[Number(b.dataset.i)];
        if (optionsLang === 'lv' && caps.lvVoice && !autoSay) speakLv(selected);
        setReady(true);
      }));
      if (autoSay) setTimeout(() => speakLv(autoSay), 350);
    },
    check() {
      return { ok: selected === answer, correct: correctText || answer, say, detail: correctText && selected === answer ? esc(correctText) : '' };
    },
    lock() {
      root.querySelectorAll('.option').forEach((b) => {
        b.disabled = true;
        const val = opts[Number(b.dataset.i)];
        if (val === answer) b.classList.add('right');
        else if (val === selected) b.classList.add('wrong');
      });
    },
  };
}

function promptCard(text, lang, sub) {
  return `<div class="prompt-card">
    <p class="prompt-text ${lang === 'lv' ? 'lv' : ''}" lang="${lang}">${esc(text)}</p>
    ${sub ? `<p class="prompt-sub">${esc(sub)}</p>` : ''}
    ${lang === 'lv' ? speakerButtons(text) : ''}
  </div>`;
}

function taskChoose(t) {
  const qLv = t.questionLang === 'lv';
  return optionsTask({
    title: qLv ? 'Что это значит?' : 'Как сказать по-латышски?',
    promptHtml: promptCard(t.question, qLv ? 'lv' : 'ru'),
    options: t.options,
    optionsLang: t.optionsLang === 'lv' ? 'lv' : 'ru',
    answer: t.answer,
    say: t.optionsLang === 'lv' ? t.answer : qLv ? t.question : null,
    autoSay: qLv && canSpeak(t.question) ? t.question : null,
  });
}

function taskListen(t) {
  const optsLv = t.optionsLang === 'lv';
  if (!canSpeak(t.lv)) {
    // Озвучки нет — превращаем в задание на чтение, чтобы урок можно было пройти.
    return optionsTask({
      title: optsLv ? 'Как сказать по-латышски?' : 'Что это значит?',
      note: 'Озвучки на этом телефоне нет, поэтому здесь читаем текст.',
      promptHtml: optsLv ? promptCard(t.ru, 'ru') : promptCard(t.lv, 'lv'),
      options: t.options,
      optionsLang: optsLv ? 'lv' : 'ru',
      answer: t.answer,
      correctText: optsLv ? t.answer : `${t.lv} — ${t.answer}`,
    });
  }
  return optionsTask({
    title: optsLv ? 'Послушай и выбери, что прозвучало' : 'Послушай и выбери перевод',
    promptHtml: `<div class="listen-box">
        <button class="big-speaker" data-say="${esc(t.lv)}" aria-label="Послушать ещё раз">🔊</button>
        <button class="sound-btn slow" data-say-slow="${esc(t.lv)}">🐢 Медленно</button>
      </div>`,
    options: t.options,
    optionsLang: optsLv ? 'lv' : 'ru',
    answer: t.answer,
    correctText: `${t.lv} — ${t.ru}`,
    say: t.lv,
    autoSay: t.lv,
  });
}

/* ---------- задание: собрать фразу из слов ---------- */

function taskBuild(t) {
  const target = t.lv.split(/\s+/).map(stripPunct).filter(Boolean);
  const tiles = shuffle([...target, ...(t.extraWords || [])]).map((w, id) => ({ id, w }));
  let chosen = [];
  let root = null;
  let setReadyFn = () => {};

  function draw() {
    const answer = root.querySelector('#answer');
    answer.innerHTML = chosen.length
      ? chosen.map((id) => `<button class="tile" data-id="${id}" lang="lv">${esc(tiles[id].w)}</button>`).join('')
      : '<span class="answer-hint">Нажимай на слова ниже по порядку</span>';
    root.querySelectorAll('#bank .tile').forEach((b) => {
      const used = chosen.includes(Number(b.dataset.id));
      b.classList.toggle('used', used);
      b.disabled = used;
    });
    answer.querySelectorAll('.tile').forEach((b) => b.addEventListener('click', () => {
      chosen = chosen.filter((id) => id !== Number(b.dataset.id));
      draw();
    }));
    setReadyFn(chosen.length > 0);
  }

  return {
    checkable: true,
    html: `
      <h2 class="task-title">Собери фразу по-латышски</h2>
      ${promptCard(t.ru, 'ru')}
      <div class="answer-line" id="answer" aria-label="Твой ответ"></div>
      <div class="bank" id="bank">
        ${tiles.map((x) => `<button class="tile" data-id="${x.id}" lang="lv">${esc(x.w)}</button>`).join('')}
      </div>`,
    mount(r, setReady) {
      root = r;
      setReadyFn = setReady;
      root.querySelectorAll('#bank .tile').forEach((b) => b.addEventListener('click', () => {
        const id = Number(b.dataset.id);
        if (chosen.includes(id)) return;
        chosen.push(id);
        if (caps.lvVoice) speakLv(tiles[id].w);
        draw();
      }));
      draw();
    },
    check() {
      const got = wordsStrict(chosen.map((id) => tiles[id].w).join(' '));
      const want = wordsStrict(t.lv);
      const ok = got.length === want.length && got.every((w, i) => w === want[i]);
      return { ok, correct: t.lv, say: t.lv, detail: ok ? `<span lang="lv" class="fb-answer">${esc(t.lv)}</span>` : '' };
    },
    lock() {
      root.querySelectorAll('.tile').forEach((b) => { b.disabled = true; });
    },
  };
}

/* ---------- задание: скажи вслух ---------- */

function taskSpeak(t) {
  let root = null;
  let tries = 0;
  let emptyTries = 0;
  let busy = false;
  let passed = false;

  const modeHint = () => speechMode === 'recognition'
    ? 'Нажми на микрофон и скажи фразу'
    : speechMode === 'voice'
      ? 'Нажми на микрофон, скажи фразу и нажми ещё раз'
      : 'Микрофон недоступен';

  function setStatus(html) {
    const el = root.querySelector('#speak-status');
    el.innerHTML = html;
    if (html) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setMic(state, label) {
    const mic = root.querySelector('#mic');
    mic.classList.toggle('listening', state === 'listening');
    mic.disabled = state === 'off';
    root.querySelector('#mic-label').textContent = label;
  }

  function setLevel(v) {
    const fill = root.querySelector('.level-fill');
    if (fill) fill.style.transform = `scaleX(${v})`;
  }

  function pass(detail) {
    if (passed) return;
    passed = true;
    lesson.spoken += 1;
    lesson.done += 1;
    setProgressBar();
    setMic('off', 'Готово ✓');
    root.querySelector('#speak-extra').querySelectorAll('.accept-btn').forEach((b) => b.remove());
    showFeedback(true, pick(['Отлично! Сказано вслух.', 'Молодец! Голос — лучший тренажёр.', 'Есть! Так и качается пресс.']), detail);
  }

  function showAccept() {
    const extra = root.querySelector('#speak-extra');
    if (extra.querySelector('.accept-btn')) return;
    const b = document.createElement('button');
    b.className = 'link-btn block accept-btn';
    b.textContent = 'Засчитать: фраза сказана вслух';
    b.addEventListener('click', () => pass('Засчитано. Произношение подтянется — повторяй за образцом.'));
    extra.appendChild(b);
    b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function switchToVoiceMode(remember) {
    disableRecognition(remember);
    setMic(speechMode === 'none' ? 'off' : 'idle', modeHint());
    setStatus(speechMode === 'voice'
      ? 'Проверить произношение на этом телефоне не получается. Не страшно: нажми на микрофон ещё раз, скажи фразу и нажми снова — засчитаю по голосу.'
      : 'Микрофон в этом браузере недоступен. Открой Duolat в Chrome (Android) или Safari (iPhone).');
  }

  async function useRecognition() {
    busy = true;
    setMic('listening', 'Слушаю… говори');
    setStatus('');
    let alts;
    try {
      alts = await recognizeOnce();
    } catch (err) {
      busy = false;
      if (passed) return;
      if (err === 'not-allowed' || err === 'audio-capture') {
        setMic('idle', modeHint());
        setStatus('Нет доступа к микрофону.' + MIC_HELP);
        return;
      }
      // Распознавание латышского недоступно (нет сети, телефон не поддерживает, зависло) — переходим на проверку голоса.
      switchToVoiceMode(REC_BROKEN.includes(err));
      return;
    }
    busy = false;
    if (passed || !root.isConnected) return;
    setMic('idle', modeHint());
    if (!alts.length) {
      emptyTries += 1;
      if (emptyTries >= 2) { switchToVoiceMode(false); return; }
      setStatus('Не слышно. Нажми на микрофон и скажи чуть громче.');
      return;
    }
    tries += 1;
    let best = alts[0], bestScore = 0;
    for (const a of alts) { const s = similarity(a, t.lv); if (s > bestScore) { bestScore = s; best = a; } }
    if (bestScore >= SPEAK_PASS) {
      pass(`Услышано: «${esc(best)}»`);
    } else {
      setStatus(`Услышано: «${esc(alts[0])}». Почти! Послушай образец и скажи ещё раз, не спеша.`);
      if (tries >= SPEAK_TRIES_BEFORE_ACCEPT) showAccept();
    }
  }

  async function useVoice() {
    busy = true;
    setStatus('');
    let session;
    try {
      session = await startVoiceSession(setLevel);
    } catch (err) {
      busy = false;
      setMic('idle', modeHint());
      setStatus('Нет доступа к микрофону.' + MIC_HELP);
      return;
    }
    setMic('listening', 'Говори… потом нажми ещё раз');
    const r = await session.done;
    busy = false;
    if (passed || !root.isConnected) return;
    setLevel(0);
    setMic('idle', modeHint());
    if (r.voicedMs >= VOICE_MIN_MS) {
      const replay = r.url ? `<button class="sound-btn small" id="replay">▶ Послушать себя</button>` : '';
      pass(`Голос слышен — засчитано. Произношение здесь не проверяется: сравни себя с образцом. ${replay}`);
      const rb = document.getElementById('replay');
      if (rb) rb.addEventListener('click', () => { stopSpeaking(); currentAudio = new Audio(r.url); currentAudio.play().catch(() => {}); });
    } else {
      setStatus('Голос не слышно. Скажи громче и держи телефон ближе.');
    }
  }

  return {
    checkable: false,
    html: `
      <h2 class="task-title">Скажи вслух</h2>
      <p class="task-note">Главное задание урока: без него урок не засчитается.</p>
      ${promptCard(t.lv, 'lv', t.ru)}
      <div class="mic-wrap">
        <button class="mic-btn" id="mic" aria-label="Микрофон: нажми и скажи фразу"><span aria-hidden="true">🎙️</span></button>
        <div class="mic-label" id="mic-label"></div>
        <div class="level" aria-hidden="true"><div class="level-fill"></div></div>
      </div>
      <div class="speak-status" id="speak-status" role="status"></div>
      <div id="speak-extra"></div>`,
    mount(r) {
      root = r;
      setMic(speechMode === 'none' ? 'off' : 'idle', modeHint());
      if (speechMode === 'none') {
        setStatus('В этом браузере нет доступа к микрофону, а без голоса урок не засчитается. Открой Duolat в Chrome (Android) или Safari (iPhone).');
      }
      root.querySelector('#mic').addEventListener('click', () => {
        if (passed) return;
        if (busy) {
          // Повторное нажатие — «я закончил»: распознавание отдаёт то, что уже услышало.
          if (activeRec) activeRec.stop(); else stopMic();
          return;
        }
        stopSpeaking();
        if (speechMode === 'recognition') useRecognition();
        else if (speechMode === 'voice') useVoice();
      });
    },
    check() { return { ok: passed }; },
    lock() {},
  };
}

function taskUnknown(t) {
  return {
    checkable: false,
    html: `<h2 class="task-title">Неизвестный тип задания: ${esc(t.type)}</h2><p>Проверь content.json.</p>`,
    mount() { lesson.done += 1; showFeedback(true, 'Пропускаем', ''); },
    check() { return { ok: true }; },
    lock() {},
  };
}

/* ---------- экран «Проверить звук и микрофон» ---------- */

function validateContent() {
  const issues = [];
  content.lessons.forEach((l, li) => {
    const where = `Урок ${li + 1} «${l.title}»`;
    if (!l.tasks.some((t) => t.type === 'speak')) issues.push(`${where}: нет задания «скажи вслух».`);
    l.tasks.forEach((t, ti) => {
      if ((t.type === 'choose' || t.type === 'listen') && !t.options.includes(t.answer)) {
        issues.push(`${where}, задание ${ti + 1}: ответ «${t.answer}» не найден среди вариантов.`);
      }
    });
  });
  return issues;
}

function renderCheck() {
  lesson = null;
  const issues = validateContent();
  const recLabel = !caps.recognition ? '✗ Нет в этом браузере — засчитывается голос'
    : speechMode === 'recognition' ? '✓ Есть (проверка ниже)' : '✗ Не сработало — засчитывается голос';
  $app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Назад">←</a>
      <div class="logo">Звук и микрофон</div>
      <span></span>
    </header>
    <section class="screen check">
      <div class="card">
        <h2>🔊 Латышская озвучка</h2>
        <p>${caps.lvVoice ? `✓ Голос найден: ${esc(caps.lvVoice.name)}` : caps.synth ? '✗ Латышский голос не найден' : '✗ Озвучка в этом браузере не поддерживается'}</p>
        ${caps.lvVoice ? '<button class="btn btn-secondary" id="t-say">Послушать «Labdien!»</button>' : `
          <p class="muted"><b>Android:</b> Настройки → Специальные возможности → Синтез речи (Текст в речь) → Google → Установить голосовые данные → Латышский. Потом перезапусти Duolat.</p>
          <p class="muted"><b>iPhone:</b> латышского голоса в iPhone может не быть. Тогда в заданиях «послушай» будет текст — урок всё равно можно пройти.</p>`}
      </div>

      <div class="card">
        <h2>🎙️ Проверка произношения</h2>
        <p>${recLabel}</p>
        <p class="muted">Микрофон: ${caps.mic ? '✓ доступен' : '✗ недоступен'}</p>
        ${speechMode !== 'none' ? '<button class="btn btn-secondary" id="t-mic">Скажи «Labdien!»</button>' : ''}
        <div class="speak-status" id="t-status" role="status"></div>
      </div>

      <div class="card">
        <h2>📲 Установка на телефон</h2>
        <p>${isStandalone() ? '✓ Duolat уже установлен и открыт как приложение.' : ''}</p>
        <p class="muted"><b>iPhone (Safari):</b> «Поделиться» ⬆️ → «На экран „Домой“» → «Добавить».</p>
        <p class="muted"><b>Android (Chrome):</b> меню ⋮ → «Установить приложение» или «Добавить на главный экран».</p>
      </div>

      <div class="card">
        <h2>📄 Тексты уроков</h2>
        <p>${issues.length ? '⚠️ Найдены ошибки в content.json:' : '✓ Файл content.json прочитан без ошибок.'}</p>
        ${issues.length ? `<ul>${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        <p class="muted">Статус: ${esc(content._meta && content._meta.reviewStatus || '')}</p>
      </div>

      <div class="card">
        <h2>💾 Прогресс</h2>
        <p class="muted">Хранится только на этом телефоне. Пройдено уроков: ${Object.keys(progress.completed).length}, опыт: ${progress.xp}.</p>
        <button class="link-btn danger" id="t-reset">Сбросить прогресс</button>
      </div>
    </section>`;

  const say = document.getElementById('t-say');
  if (say) say.addEventListener('click', () => speakLv('Labdien!'));

  const mic = document.getElementById('t-mic');
  const status = document.getElementById('t-status');
  if (mic) mic.addEventListener('click', async () => {
    if (activeRec) { activeRec.stop(); return; }
    if (activeVoice) { stopMic(); return; }
    status.textContent = 'Слушаю… скажи «Labdien!»';
    if (speechMode === 'recognition') {
      try {
        const alts = await recognizeOnce();
        if (!alts.length) { status.textContent = 'Ничего не услышано. Попробуй ещё раз.'; return; }
        const s = similarity(alts[0], 'Labdien');
        status.textContent = `Услышано: «${alts[0]}» — ${s >= SPEAK_PASS ? 'отлично ✓' : 'похоже не совсем, попробуй ещё'}`;
      } catch (err) {
        if (err === 'not-allowed' || err === 'audio-capture') { status.innerHTML = 'Нет доступа к микрофону.' + MIC_HELP; return; }
        disableRecognition(REC_BROKEN.includes(err));
        status.textContent = `Распознавание не сработало (${err}). Задания «Скажи вслух» будут засчитываться по голосу.`;
      }
    } else {
      try {
        const session = await startVoiceSession();
        status.textContent = 'Говори… потом нажми кнопку ещё раз';
        const r = await session.done;
        status.textContent = r.voicedMs >= VOICE_MIN_MS ? 'Голос слышен ✓ Микрофон работает.' : 'Голос не слышно. Скажи громче.';
      } catch (e) {
        status.innerHTML = 'Нет доступа к микрофону.' + MIC_HELP;
      }
    }
  });

  document.getElementById('t-reset').addEventListener('click', () => {
    openModal(`
      <h2 class="sheet-title">Сбросить прогресс?</h2>
      <p class="sheet-sub">Пройденные уроки, опыт и серия дней будут удалены с этого телефона.</p>
      <button class="btn btn-primary" id="keep">Оставить как есть</button>
      <button class="link-btn block danger" id="wipe">Да, сбросить</button>
    `, (sheet) => {
      sheet.querySelector('#keep').addEventListener('click', closeModal);
      sheet.querySelector('#wipe').addEventListener('click', () => {
        progress = defaultProgress();
        saveProgress();
        closeModal();
        location.hash = '#/';
        toast('Прогресс сброшен');
      });
    });
  });
}

/* ---------- клавиатура (удобно на компьютере) ---------- */

document.addEventListener('keydown', (e) => {
  if (!lesson || $modal.innerHTML) return;
  if (/^[1-9]$/.test(e.key)) {
    const opt = $app.querySelectorAll('.option')[Number(e.key) - 1];
    if (opt && !opt.disabled) opt.click();
  } else if (e.key === 'Enter') {
    if (e.target.closest && e.target.closest('button, a')) return; // кнопка в фокусе нажмётся сама
    const next = document.getElementById('next');
    const check = document.getElementById('check');
    if (next) { e.preventDefault(); next.click(); } else if (check && !check.disabled) { e.preventDefault(); check.click(); }
  }
});

/* ---------- запуск ---------- */

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (content && !lesson && (location.hash || '#/') === '#/') renderHome();
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  toast('Duolat установлен на телефон');
});

async function init() {
  try {
    const res = await fetch('content.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    content = await res.json();
  } catch (e) {
    $app.innerHTML = `<section class="screen"><div class="card"><h2>Не получилось загрузить уроки</h2>
      <p>Проверь интернет и открой приложение ещё раз.</p></div></section>`;
    return;
  }
  validateContent().forEach((i) => console.warn('content.json:', i));

  window.addEventListener('hashchange', route);
  route();

  loadVoices().then(() => {
    const h = location.hash || '#/';
    if (!lesson && (h === '#/' || h === '#/check') && !$modal.innerHTML) route();
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    // Пришла новая версия приложения — один раз перезагружаемся, если не идёт урок.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || lesson) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
