'use strict';

// Макроквиз Live: сервер живой викторины.
// Вся игра хранится в памяти; результаты по ходу игры пишутся в папку results/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// ---------- Настройки ----------

const PORT = Number(process.env.PORT) || 3000;
// Название переменной ищем без учёта регистра и лишних пробелов: так проще вписать его в панели хостинга.
const PIN_ENV_KEY = Object.keys(process.env).find((k) => k.trim().toUpperCase() === 'HOST_PIN');
const PIN_FROM_ENV = PIN_ENV_KEY ? String(process.env[PIN_ENV_KEY]).trim() : '';
const HOST_PIN = PIN_FROM_ENV || '1234';
const PIN_IS_DEFAULT = !PIN_FROM_ENV;
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'questions.txt');
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(__dirname, 'results');
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const MAX_PLAYERS = 300;
const GRACE_MS = 300; // запас на задержку сети; такой ответ засчитывается как данный в последнюю секунду
const ALLOWED_SECONDS = [15, 20, 30];
const ALLOWED_COUNTS = [8, 12, 0]; // 0 = все вопросы из файла
const ALLOWED_AUTO = [0, 10, 15, 20]; // через сколько секунд после итога вопроса начинать следующий; 0 = вручную
const ALLOWED_MODES = ['self', 'live']; // self — каждый в своём темпе, live — все вместе по экрану ведущего
const FEEDBACK_MS = 3000; // в режиме «в своём темпе»: сколько показывать «верно/неверно» перед следующим вопросом
const PROBE_MS = 2000; // сколько ждать ответа от старого подключения при повторном входе
const HEARTBEAT_MS = 15000; // как часто проверять, что страницы на связи
const PIN_MAX_FAILS = 8;
const PIN_LOCK_MS = 60 * 1000;

// ---------- Вопросы ----------

function loadQuestions() {
  let raw;
  try {
    raw = fs.readFileSync(QUESTIONS_FILE, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return { list: [], badLines: [], error: 'Не найден файл с вопросами: ' + path.basename(QUESTIONS_FILE) };
  }
  const list = [];
  const badLines = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split('|').map((x) => x.trim());
    if (parts.length < 5 || parts.slice(0, 5).some((x) => !x)) {
      badLines.push(i + 1);
      return;
    }
    list.push({
      text: parts[0],
      correct: parts[1],
      wrong: parts.slice(2, 5),
      explanation: parts.slice(5).join(' | '),
    });
  });
  return { list, badLines, error: null };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Состояние игры ----------

const game = {
  id: null,
  phase: 'lobby', // lobby | question | reveal | self | finished  (self — идёт игра «в своём темпе»)
  settings: { seconds: 20, count: 12, auto: 15, mode: 'self' },
  questions: [], // { text, options[4], correct, explanation }
  qIndex: -1,
  asked: 0, // сколько вопросов уже завершено
  qStartedAt: 0,
  qDeadline: 0,
  timer: null, // таймер вопроса, а во время итога вопроса — таймер автоперехода
  autoAt: 0, // когда сработает автопереход (0 — не запланирован)
  autoPaused: false,
  joinUrl: '',
  qrSvg: '',
  savedAt: null,
  saveError: false,
  qInfo: loadQuestions(),
};

const players = new Map(); // ключ имени -> игрок
const playersById = new Map();
let hostWs = null;

function newPlayer(name, key) {
  const p = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    key,
    name,
    ws: null,
    connected: false,
    score: 0,
    rank: 0,
    answers: [], // по номеру вопроса: { choice, correct, points, ms }
    // Режим «в своём темпе»: свой порядок вопросов, позиция, шаг и таймер у каждого студента
    order: null,
    pos: 0,
    step: null, // question | feedback | pending (ждёт возвращения связи) | done
    qStartedAt: 0,
    qDeadline: 0,
    feedbackUntil: 0,
    timer: null,
  };
  players.set(key, p);
  playersById.set(p.id, p);
  return p;
}

function removePlayer(p) {
  clearTimeout(p.timer);
  players.delete(p.key);
  playersById.delete(p.id);
}

function resetSelf(p) {
  clearTimeout(p.timer);
  p.order = null;
  p.pos = 0;
  p.step = null;
}

function correctCount(p) {
  return p.answers.filter((a) => a && a.correct).length;
}

// Сортирует игроков и проставляет места (при равных баллах место одинаковое).
function ranking() {
  const arr = [...players.values()].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru')
  );
  let prevScore = null;
  let prevRank = 0;
  arr.forEach((p, i) => {
    p.rank = p.score === prevScore ? prevRank : i + 1;
    prevScore = p.score;
    prevRank = p.rank;
  });
  return arr;
}

function answeredCount() {
  let n = 0;
  for (const p of players.values()) if (p.answers[game.qIndex]) n++;
  return n;
}

function connectedCount() {
  let n = 0;
  for (const p of players.values()) if (p.connected) n++;
  return n;
}

// ---------- Имена ----------

function cleanName(raw) {
  return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function nameError(name) {
  if (!name) return 'Введите фамилию и имя.';
  if (!/^[\p{L}\-'’. ]+$/u.test(name)) return 'Используйте только буквы, пробел, дефис и точку.';
  const words = name.split(' ').filter((w) => /\p{L}/u.test(w));
  if (words.length < 2) return 'Нужны фамилия и имя — минимум два слова.';
  return null;
}

function nameKey(name) {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// ---------- Отправка сообщений ----------

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function studentView(p) {
  const v = { t: 'state', phase: game.phase, name: p.name };
  const q = game.questions[game.qIndex];
  const a = p.answers[game.qIndex];
  if (game.phase === 'question') {
    Object.assign(v, {
      index: game.qIndex,
      total: game.questions.length,
      text: q.text,
      options: q.options,
      seconds: game.settings.seconds,
      remainingMs: Math.max(0, game.qDeadline - Date.now()),
      answered: !!a,
      choice: a ? a.choice : null,
    });
  } else if (game.phase === 'reveal') {
    Object.assign(v, {
      index: game.qIndex,
      total: game.questions.length,
      text: q.text,
      options: q.options,
      correct: q.correct,
      explanation: q.explanation,
      choice: a ? a.choice : null,
      isCorrect: !!(a && a.correct),
      points: a ? a.points : 0,
      score: p.score,
      rank: p.rank,
      players: players.size,
      nextInMs: autoRemainingMs(),
    });
  } else if (game.phase === 'self') {
    const total = game.questions.length;
    Object.assign(v, { step: p.step, index: Math.min(p.pos, total), total, seconds: game.settings.seconds, score: p.score });
    const qid = p.order ? p.order[p.pos] : null;
    const sq = game.questions[qid];
    if (p.step === 'question') {
      Object.assign(v, {
        qid,
        text: sq.text,
        options: sq.options,
        remainingMs: Math.max(0, p.qDeadline - Date.now()),
      });
    } else if (p.step === 'feedback') {
      const sa = p.answers[qid];
      Object.assign(v, {
        qid,
        text: sq.text,
        options: sq.options,
        correct: sq.correct,
        explanation: sq.explanation,
        choice: sa ? sa.choice : null,
        isCorrect: !!(sa && sa.correct),
        points: sa ? sa.points : 0,
        nextInMs: Math.max(0, p.feedbackUntil - Date.now()),
        isLast: p.pos + 1 >= total,
      });
    } else if (p.step === 'done') {
      v.correctCount = correctCount(p);
    }
  } else if (game.phase === 'finished') {
    Object.assign(v, {
      score: p.score,
      rank: p.rank,
      players: players.size,
      correctCount: correctCount(p),
      total: game.asked,
    });
  }
  return v;
}

function hostView() {
  const list = [...players.values()];
  const connected = connectedCount();
  const v = {
    t: 'host',
    phase: game.phase,
    settings: game.settings,
    pinIsDefault: PIN_IS_DEFAULT,
    joinUrl: game.joinUrl,
    shortUrl: game.joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    players: list.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    connectedCount: connected,
    questionsAvailable: game.qInfo.list.length,
    questionsBadLines: game.qInfo.badLines,
    questionsError: game.qInfo.error,
    savedAt: game.savedAt,
    saveError: game.saveError,
  };
  if (game.phase === 'lobby') v.qrSvg = game.qrSvg;
  const q = game.questions[game.qIndex];
  if (game.phase === 'question' || game.phase === 'reveal') {
    v.question = {
      index: game.qIndex,
      total: game.questions.length,
      text: q.text,
      options: q.options,
      seconds: game.settings.seconds,
      remainingMs: Math.max(0, game.qDeadline - Date.now()),
    };
    v.answered = answeredCount();
    v.expected = Math.max(connected, v.answered);
  }
  if (game.phase === 'reveal') {
    const histogram = [0, 0, 0, 0];
    for (const p of players.values()) {
      const a = p.answers[game.qIndex];
      if (a) histogram[a.choice]++;
    }
    v.reveal = {
      correct: q.correct,
      explanation: q.explanation,
      histogram,
      top: ranking().slice(0, 5).map((p) => ({ rank: p.rank, name: p.name, score: p.score })),
      isLast: game.qIndex + 1 >= game.questions.length,
      autoMs: autoRemainingMs(),
      autoPaused: game.autoPaused,
    };
  }
  if (game.phase === 'self') {
    const total = game.questions.length;
    v.self = {
      total,
      done: list.filter((p) => p.step === 'done').length,
      ranking: ranking().map((p) => ({
        rank: p.rank,
        name: p.name,
        score: p.score,
        progress: Math.min(p.step === 'done' ? total : p.pos, total),
        done: p.step === 'done',
        connected: p.connected,
      })),
    };
  }
  if (game.phase === 'finished') {
    v.asked = game.asked;
    v.ranking = ranking().map((p) => ({
      rank: p.rank,
      name: p.name,
      score: p.score,
      correct: correctCount(p),
    }));
  }
  return v;
}

let hostTimer = null;
function sendHostNow() {
  clearTimeout(hostTimer);
  hostTimer = null;
  if (hostWs) send(hostWs, hostView());
}
function scheduleHost() {
  if (!hostTimer) hostTimer = setTimeout(sendHostNow, 150);
}

function broadcastAll() {
  ranking();
  for (const p of players.values()) if (p.connected) send(p.ws, studentView(p));
  sendHostNow();
}

// ---------- Ход игры ----------

function startGame() {
  game.qInfo = loadQuestions();
  const all = game.qInfo.list;
  if (!all.length) {
    send(hostWs, { t: 'error', msg: 'В файле вопросов нет ни одного правильно оформленного вопроса.' });
    return;
  }
  const count = game.settings.count ? Math.min(game.settings.count, all.length) : all.length;
  game.questions = shuffle(all)
    .slice(0, count)
    .map((src) => {
      const options = shuffle([src.correct, ...src.wrong]);
      return {
        text: src.text,
        options,
        correct: options.indexOf(src.correct),
        explanation: src.explanation,
      };
    });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  game.id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  game.asked = 0;
  game.savedAt = null;
  game.saveError = false;
  for (const p of players.values()) {
    p.score = 0;
    p.answers = [];
    resetSelf(p);
  }
  if (game.settings.mode === 'self') {
    game.phase = 'self';
    game.qIndex = -1;
    game.asked = game.questions.length; // в этом режиме все вопросы «заданы» сразу
    for (const p of players.values()) beginSelf(p);
    broadcastAll();
    return;
  }
  startQuestion(0);
}

// ---------- Режим «каждый в своём темпе» ----------

function calcPoints(left, total) {
  return Math.round((500 + (500 * left) / total) / 10) * 10;
}

// Свой порядок вопросов (чтобы быстрые не подсказывали соседям) и старт первого вопроса.
function beginSelf(p) {
  p.order = shuffle(game.questions.map((q, i) => i));
  p.pos = 0;
  if (p.connected) startPlayerQuestion(p);
  else p.step = 'pending';
}

function startPlayerQuestion(p) {
  clearTimeout(p.timer);
  const sec = game.settings.seconds;
  p.step = 'question';
  p.qStartedAt = Date.now();
  p.qDeadline = p.qStartedAt + sec * 1000;
  p.timer = setTimeout(() => {
    if (game.phase === 'self' && p.step === 'question') showFeedback(p); // время вышло без ответа
  }, sec * 1000 + GRACE_MS);
  send(p.ws, studentView(p));
}

function showFeedback(p) {
  clearTimeout(p.timer);
  p.step = 'feedback';
  p.feedbackUntil = Date.now() + FEEDBACK_MS;
  p.timer = setTimeout(() => advancePlayer(p), FEEDBACK_MS);
  send(p.ws, studentView(p));
  scheduleHost();
}

function advancePlayer(p) {
  if (game.phase !== 'self' || p.step !== 'feedback') return;
  clearTimeout(p.timer);
  p.pos++;
  if (p.pos >= game.questions.length) {
    p.step = 'done';
    saveResults();
    send(p.ws, studentView(p));
    scheduleHost();
    checkSelfFinished();
    return;
  }
  // Если связь пропала, следующий вопрос начнётся, когда студент вернётся.
  if (p.connected) startPlayerQuestion(p);
  else p.step = 'pending';
  scheduleHost();
}

// Когда все ответили на все вопросы, игра заканчивается сама.
function checkSelfFinished() {
  if (game.phase !== 'self' || !players.size) return;
  for (const p of players.values()) if (p.step !== 'done') return;
  finishGame();
}

function handleSelfAnswer(p, msg) {
  const ws = p.ws;
  const qid = p.order ? p.order[p.pos] : -1;
  const late = () => send(ws, { t: 'notice', msg: 'Время на этот вопрос вышло, ответ не засчитан.' });
  if (msg.q !== qid) return late();
  if (p.answers[qid]) return send(ws, { t: 'notice', msg: 'Ответ уже принят, изменить его нельзя.' });
  if (p.step !== 'question') return late();
  const choice = msg.choice;
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
  const now = Date.now();
  if (now > p.qDeadline + GRACE_MS) return late();
  const total = game.settings.seconds;
  const left = Math.min(total, Math.max(0, (p.qDeadline - now) / 1000));
  const correct = choice === game.questions[qid].correct;
  const points = correct ? calcPoints(left, total) : 0;
  p.answers[qid] = { choice, correct, points, ms: now - p.qStartedAt };
  p.score += points;
  showFeedback(p);
}

function startQuestion(i) {
  clearTimeout(game.timer);
  game.autoAt = 0;
  game.phase = 'question';
  game.qIndex = i;
  game.qStartedAt = Date.now();
  game.qDeadline = game.qStartedAt + game.settings.seconds * 1000;
  game.timer = setTimeout(endQuestion, game.settings.seconds * 1000 + GRACE_MS);
  broadcastAll();
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  game.phase = 'reveal';
  game.asked = game.qIndex + 1;
  game.autoPaused = false;
  saveResults();
  scheduleAuto();
  broadcastAll();
}

// Автопереход: после итога вопроса сам начинается следующий (после последнего — итоги игры).
function scheduleAuto() {
  clearTimeout(game.timer);
  game.autoAt = 0;
  const sec = game.settings.auto;
  if (game.phase !== 'reveal' || !sec || game.autoPaused) return;
  game.autoAt = Date.now() + sec * 1000;
  game.timer = setTimeout(() => {
    if (game.phase === 'reveal') nextQuestion();
  }, sec * 1000);
}

function autoRemainingMs() {
  return game.autoAt ? Math.max(0, game.autoAt - Date.now()) : null;
}

function nextQuestion() {
  if (game.qIndex + 1 < game.questions.length) startQuestion(game.qIndex + 1);
  else finishGame();
}

function finishGame() {
  if (game.phase === 'question') endQuestion();
  clearTimeout(game.timer);
  game.autoAt = 0;
  for (const p of players.values()) clearTimeout(p.timer);
  game.phase = 'finished';
  saveResults();
  broadcastAll();
}

function newGame() {
  clearTimeout(game.timer);
  game.autoAt = 0;
  for (const p of [...players.values()]) {
    if (!p.connected) removePlayer(p);
    p.score = 0;
    p.answers = [];
    resetSelf(p);
  }
  game.phase = 'lobby';
  game.questions = [];
  game.qIndex = -1;
  game.asked = 0;
  game.qInfo = loadQuestions();
  broadcastAll();
}

function handleAnswer(p, msg) {
  const ws = p.ws;
  if (game.phase === 'self') return handleSelfAnswer(p, msg);
  if (game.phase !== 'question' || msg.q !== game.qIndex) {
    send(ws, { t: 'notice', msg: 'Время на этот вопрос вышло, ответ не засчитан.' });
    return;
  }
  if (p.answers[game.qIndex]) {
    send(ws, { t: 'notice', msg: 'Ответ уже принят, изменить его нельзя.' });
    return;
  }
  const choice = msg.choice;
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
  const now = Date.now();
  if (now > game.qDeadline + GRACE_MS) {
    send(ws, { t: 'notice', msg: 'Время на этот вопрос вышло, ответ не засчитан.' });
    return;
  }
  const total = game.settings.seconds;
  const left = Math.min(total, Math.max(0, (game.qDeadline - now) / 1000));
  const q = game.questions[game.qIndex];
  const correct = choice === q.correct;
  const points = correct ? calcPoints(left, total) : 0;
  p.answers[game.qIndex] = { choice, correct, points, ms: now - game.qStartedAt };
  p.score += points;
  send(ws, studentView(p));
  const answered = answeredCount();
  if (answered >= connectedCount()) endQuestion();
  else scheduleHost();
}

// ---------- Сохранение результатов ----------

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // чтобы Excel не принял текст за формулу
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv() {
  const asked = game.questions.slice(0, game.asked);
  const header = [
    'Фамилия и имя',
    'Баллы',
    'Верных ответов',
    'Место',
    ...asked.map((q, i) => `В${i + 1}. ${q.text}`),
  ];
  const rows = ranking().map((p) => [
    p.name,
    p.score,
    correctCount(p),
    p.rank,
    ...asked.map((q, i) => {
      const a = p.answers[i];
      if (!a) return 'нет ответа';
      return a.correct ? 'верно' : 'неверно';
    }),
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function saveResults() {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const csv = buildCsv();
    writeAtomic(path.join(RESULTS_DIR, `game-${game.id}.csv`), csv);
    writeAtomic(path.join(RESULTS_DIR, 'latest.csv'), csv);
    game.savedAt = new Date().toISOString();
    game.saveError = false;
  } catch (e) {
    console.error('Не удалось сохранить результаты:', e.message);
    game.saveError = true;
  }
}

// ---------- PIN ведущего ----------

const pinFails = new Map(); // ip -> { count, lockedUntil }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

function sameText(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPin(ip, pin) {
  const now = Date.now();
  const rec = pinFails.get(ip);
  if (rec && rec.lockedUntil > now) return 'locked';
  if (sameText(String(pin || '').trim(), HOST_PIN)) {
    pinFails.delete(ip);
    return 'ok';
  }
  const count = (rec && rec.lockedUntil === 0 ? rec.count : 0) + 1;
  pinFails.set(ip, { count: count >= PIN_MAX_FAILS ? 0 : count, lockedUntil: count >= PIN_MAX_FAILS ? now + PIN_LOCK_MS : 0 });
  return 'bad';
}

// ---------- Адрес для студентов и QR-код ----------

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  let host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
  const hostname = host.replace(/:\d+$/, '');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    const ip = lanIp();
    if (ip) host = `${ip}:${PORT}`;
  }
  return `${proto}://${host}`;
}

async function setJoinUrl(url) {
  if (url === game.joinUrl && game.qrSvg) return;
  game.joinUrl = url;
  try {
    game.qrSvg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (e) {
    game.qrSvg = '';
  }
}

// ---------- Подключения ----------

function handleJoin(ws, msg) {
  const name = cleanName(msg.name);
  const err = nameError(name);
  if (err) return send(ws, { t: 'joinError', msg: err });
  const key = nameKey(name);
  const p = players.get(key);
  if (!p) {
    if (game.phase === 'finished') return send(ws, { t: 'joinError', msg: 'Игра уже закончилась.' });
    if (players.size >= MAX_PLAYERS) return send(ws, { t: 'joinError', msg: 'В игре уже слишком много участников.' });
    return attachPlayer(ws, newPlayer(name, key));
  }
  const tokenOk = typeof msg.token === 'string' && msg.token === p.token;
  if (!p.connected || p.ws === ws || tokenOk) return attachPlayer(ws, p);
  // Имя занято «живым» подключением. Но обрыв связи сервер может заметить с опозданием,
  // поэтому проверяем старое подключение: если оно не отвечает, возвращаем студента в игру.
  const old = p.ws;
  probeAlive(old, (alive) => {
    if (ws.readyState !== 1) return;
    if (alive && p.ws === old && players.get(key) === p) {
      return send(ws, {
        t: 'joinError',
        msg: 'Такое имя уже есть в игре. Добавьте инициал, например: «Иванов Иван П.»',
      });
    }
    if (players.get(key) !== p) return handleJoin(ws, msg);
    attachPlayer(ws, p);
  });
}

// Проверяет, открыта ли ещё страница на том конце. Служебный ping не годится:
// на Render на него отвечает промежуточный узел, даже если телефон уже отключился.
// Поэтому шлём сообщение самой странице и ждём от неё любого ответа.
function probeAlive(ws, cb) {
  if (!ws || ws.readyState !== 1) return cb(false);
  let done = false;
  const finish = (alive) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ws.removeListener('message', onMessage);
    cb(alive);
  };
  const onMessage = () => finish(true);
  const timer = setTimeout(() => finish(false), PROBE_MS);
  ws.on('message', onMessage);
  send(ws, { t: 'hb' });
}

function attachPlayer(ws, p) {
  if (p.ws && p.ws !== ws) {
    const old = p.ws;
    old.player = null;
    send(old, { t: 'replaced' });
    old.close();
    setTimeout(() => old.terminate(), 1000);
  }
  if (ws.player && ws.player !== p && ws.player.ws === ws) {
    ws.player.connected = false;
    ws.player.ws = null;
  }
  ws.player = p;
  p.ws = ws;
  p.connected = true;
  ranking();
  send(ws, { t: 'welcome', name: p.name, token: p.token });
  if (game.phase === 'self') {
    // Опоздавший получает свой набор вопросов; вернувшийся после обрыва продолжает с того же места.
    if (!p.order) {
      p.order = shuffle(game.questions.map((q, i) => i));
      p.pos = 0;
      p.step = 'pending';
    }
    if (p.step === 'pending') startPlayerQuestion(p);
    else send(ws, studentView(p));
  } else {
    send(ws, studentView(p));
  }
  scheduleHost();
}

async function handleHostAuth(ws, msg) {
  const res = checkPin(ws.ip, msg.pin);
  if (res === 'locked') return send(ws, { t: 'authError', msg: 'Слишком много неверных попыток. Подождите минуту.' });
  if (res === 'bad') return send(ws, { t: 'authError', msg: 'Неверный PIN.' });
  if (hostWs && hostWs !== ws) {
    hostWs.isHost = false;
    send(hostWs, { t: 'hostReplaced' });
  }
  hostWs = ws;
  ws.isHost = true;
  await setJoinUrl(baseUrl(ws.req) + '/');
  if (hostWs !== ws) return;
  game.qInfo = game.phase === 'lobby' ? loadQuestions() : game.qInfo;
  send(ws, { t: 'authOk' });
  sendHostNow();
}

function handleHostCommand(ws, msg) {
  if (ws !== hostWs) return send(ws, { t: 'hostReplaced' });
  switch (msg.t) {
    case 'settings':
      // Время и число вопросов меняются только в лобби, автопереход — в любой момент.
      if (game.phase === 'lobby') {
        if (ALLOWED_SECONDS.includes(msg.seconds)) game.settings.seconds = msg.seconds;
        if (ALLOWED_COUNTS.includes(msg.count)) game.settings.count = msg.count;
        if (ALLOWED_MODES.includes(msg.mode)) game.settings.mode = msg.mode;
      }
      if (ALLOWED_AUTO.includes(msg.auto) && msg.auto !== game.settings.auto) {
        game.settings.auto = msg.auto;
        if (game.phase === 'reveal') {
          game.autoPaused = false;
          scheduleAuto();
          return broadcastAll();
        }
      }
      sendHostNow();
      break;
    case 'pause':
      if (game.phase !== 'reveal' || !game.settings.auto) return;
      game.autoPaused = !game.autoPaused;
      scheduleAuto();
      broadcastAll();
      break;
    case 'start':
      if (game.phase === 'lobby') startGame();
      break;
    case 'next':
      if (game.phase === 'lobby') startGame();
      else if (game.phase === 'reveal') nextQuestion();
      break;
    case 'skip':
      if (game.phase === 'question') endQuestion();
      break;
    case 'end':
      if (game.phase === 'question' || game.phase === 'reveal' || game.phase === 'self') finishGame();
      break;
    case 'reset':
      if (game.phase === 'finished' || game.phase === 'lobby') newGame();
      break;
    case 'kick': {
      const p = playersById.get(msg.id);
      if (!p) return;
      removePlayer(p);
      if (p.ws) {
        p.ws.player = null;
        send(p.ws, { t: 'kicked' });
      }
      if (game.phase === 'question' && players.size && answeredCount() >= connectedCount()) endQuestion();
      else broadcastAll();
      checkSelfFinished();
      break;
    }
  }
}

// ---------- HTTP ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

app.get('/api/results.csv', (req, res) => {
  const r = checkPin(clientIp(req), req.get('x-host-pin'));
  if (r !== 'ok') return res.status(403).type('text').send('Нужен PIN ведущего');
  let csv = null;
  if (game.asked > 0) csv = buildCsv();
  else {
    try {
      csv = fs.readFileSync(path.join(RESULTS_DIR, 'latest.csv'), 'utf8');
    } catch (e) {
      csv = null;
    }
  }
  if (!csv) return res.status(404).type('text').send('Результатов пока нет');
  const stamp = game.id || new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="makroquiz-${stamp}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.send(csv);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws.req = req;
  ws.ip = clientIp(req);
  ws.isAlive = true;
  ws.player = null;
  ws.isHost = false;
  ws.on('message', (data) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'join') return handleJoin(ws, msg);
    if (msg.t === 'answer') {
      if (ws.player && ws.player.ws === ws) handleAnswer(ws.player, msg);
      return;
    }
    if (msg.t === 'hostAuth') return handleHostAuth(ws, msg);
    if (msg.t === 'hb') return; // ответ страницы на проверку связи
    if (msg.t === 'nextQ') {
      // «Дальше» на телефоне в режиме «в своём темпе»
      const p = ws.player;
      if (p && p.ws === ws && game.phase === 'self' && p.step === 'feedback') advancePlayer(p);
      return;
    }
    if (msg.t === 'ping') return send(ws, { t: 'pong' });
    if (ws.isHost || ws === hostWs) return handleHostCommand(ws, msg);
    send(ws, { t: 'hostReplaced' });
  });
  ws.on('close', () => {
    const p = ws.player;
    if (p && p.ws === ws) {
      p.connected = false;
      p.ws = null;
      scheduleHost();
    }
    if (ws === hostWs) hostWs = null;
  });
  ws.on('error', () => {});
});

// Проверка «живых» соединений: страница должна ответить на сообщение hb до следующей проверки.
// Молчащие соединения закрываем, чтобы ведущий видел студента как отключённого.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    send(ws, { t: 'hb' });
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`Макроквиз Live запущен: http://localhost:${PORT}`);
  console.log(`Экран ведущего: http://localhost:${PORT}/host`);
  if (PIN_FROM_ENV) console.log(`PIN ведущего задан (переменная ${JSON.stringify(PIN_ENV_KEY)}, символов: ${PIN_FROM_ENV.length}).`);
  else if (PIN_ENV_KEY) console.log(`Переменная ${JSON.stringify(PIN_ENV_KEY)} найдена, но пустая. Используется PIN 1234.`);
  else console.log('PIN ведущего не задан, используется 1234. Задайте переменную HOST_PIN.');
  const qi = game.qInfo;
  if (qi.error) console.log(qi.error);
  else console.log(`Вопросов в файле: ${qi.list.length}` + (qi.badLines.length ? `, строки с ошибками: ${qi.badLines.join(', ')}` : ''));
});
