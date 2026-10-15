'use strict';

// Нагрузочный тест: 60 симулированных студентов проходят игру целиком.
// Запуск:   node loadtest.js [адрес] [PIN] [число студентов]
// Пример:   node loadtest.js https://makroquiz.onrender.com 4821 60
// ВНИМАНИЕ: тест сам управляет игрой как ведущий. Не запускайте его во время пары.

const WebSocket = require('ws');

const BASE = (process.argv[2] || process.env.TEST_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PIN = process.argv[3] || process.env.HOST_PIN || '1234';
const N = Number(process.argv[4] || process.env.TEST_PLAYERS || 60);
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const RECONNECTORS = 5; // столько студентов «потеряют связь» посреди игры

const SURNAMES = ['Иванов', 'Петрова', 'Смирнов', 'Кузнецова', 'Попов', 'Васильева', 'Соколов', 'Михайлова', 'Новиков', 'Фёдорова', 'Морозов', 'Волкова'];
const NAMES = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья'];
const INITIALS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
const T0 = Date.now();

const checks = [];
function check(ok, text) {
  checks.push({ ok: !!ok, text });
  console.log((ok ? '  ✔ ' : '  ✘ ') + text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// Клиент WebSocket с очередью сообщений и ожиданием нужного.
class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      const t = setTimeout(() => reject(new Error(this.label + ': нет соединения за 90 с')), 90000);
      this.ws.on('open', () => { clearTimeout(t); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(t); reject(e); });
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'hb') return this.send({ t: 'hb' }); // как настоящая страница
        m._at = Date.now();
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(m)) { clearTimeout(w.timer); w.resolve(m); return false; }
          return true;
        });
      });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  // Ждёт сообщение, удовлетворяющее условию (в том числе уже полученное после отметки since).
  wait(pred, timeoutMs = 60000, since = 0) {
    const found = this.msgs.slice(since).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(this.label + ': не дождались сообщения'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  mark() { return this.msgs.length; }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function main() {
  console.log(`Нагрузочный тест: ${N} студентов, сервер ${BASE}`);
  const t0 = Date.now();

  // 0. Будим сервер (бесплатный хостинг может спать).
  try {
    const r = await fetch(BASE + '/healthz');
    check(r.ok, 'Сервер отвечает');
  } catch (e) {
    check(false, 'Сервер отвечает: ' + e.message);
    return finish(t0);
  }

  // 1. Ведущий: неверный PIN отклоняется, верный принимается.
  const host = new Client('ведущий');
  await host.open();
  host.send({ t: 'hostAuth', pin: PIN + 'x' });
  const bad = await host.wait((m) => m.t === 'authError' || m.t === 'authOk');
  check(bad.t === 'authError', 'Неверный PIN отклонён');
  host.send({ t: 'hostAuth', pin: PIN });
  const ok = await host.wait((m) => m.t === 'authOk' || (m.t === 'authError' && m !== bad));
  check(ok.t === 'authOk', 'Верный PIN принят');
  if (ok.t !== 'authOk') return finish(t0);
  let hs = await host.wait((m) => m.t === 'host');
  if (hs.phase !== 'lobby') {
    if (hs.phase !== 'finished') { host.send({ t: 'end' }); await host.wait((m) => m.t === 'host' && m.phase === 'finished'); }
    host.send({ t: 'reset' });
    hs = await host.wait((m) => m.t === 'host' && m.phase === 'lobby');
  }
  host.send({ t: 'settings', seconds: 15, count: 12, auto: 0 });

  // 2. Студенты входят.
  const students = [];
  for (let i = 0; i < N; i++) {
    const block = Math.floor(i / (SURNAMES.length * NAMES.length));
    const suffix = block ? ' ' + INITIALS[block % INITIALS.length] + '.' + (block >= INITIALS.length ? INITIALS[Math.floor(block / INITIALS.length) % INITIALS.length] + '.' : '') : '';
    const name = `${SURNAMES[i % SURNAMES.length]} ${NAMES[Math.floor(i / SURNAMES.length) % NAMES.length]}${suffix}`;
    students.push({ name, client: new Client(name), token: null, myScore: 0, answeredQ: 0 });
  }
  const tj = Date.now();
  await Promise.all(students.map(async (s, i) => {
    await sleep(i * 30);
    await s.client.open();
    s.client.send({ t: 'join', name: s.name });
    const w = await s.client.wait((m) => m.t === 'welcome' || m.t === 'joinError');
    if (w.t === 'welcome') s.token = w.token;
  }));
  check(students.every((s) => s.token), `Все ${N} студентов вошли (за ${((Date.now() - tj) / 1000).toFixed(1)} с)`);

  // Проверка имён: дубль и одно слово.
  const dup = new Client('дубль');
  await dup.open();
  dup.send({ t: 'join', name: students[0].name.toUpperCase() });
  const dupRes = await dup.wait((m) => m.t === 'welcome' || m.t === 'joinError');
  check(dupRes.t === 'joinError', 'Повтор уже вошедшего имени отклонён (просьба добавить инициал)');
  dup.send({ t: 'join', name: 'Иванов' });
  const oneWord = await dup.wait((m) => m.t === 'joinError' && m !== dupRes);
  check(oneWord.t === 'joinError', 'Имя из одного слова отклонено');
  dup.close();

  hs = await host.wait((m) => m.t === 'host' && m.players.length === N, 10000, 0).catch(() => null);
  check(hs && hs.players.length === N, `Ведущий видит ${N} участников в лобби`);

  // 3. Второй ведущий забирает управление, первый получает уведомление.
  const host2 = new Client('ведущий-2');
  await host2.open();
  host2.send({ t: 'hostAuth', pin: PIN });
  await host2.wait((m) => m.t === 'authOk');
  const repl = await host.wait((m) => m.t === 'hostReplaced', 5000).catch(() => null);
  check(!!repl, 'Второй ведущий получил управление, первый — уведомление');
  const m1 = host.mark();
  host.send({ t: 'start' });
  const ignored = await host.wait((m) => m.t === 'hostReplaced', 5000, m1).catch(() => null);
  check(!!ignored, 'Команды старого окна ведущего не выполняются');
  host.close();
  const H = host2;

  // 4. Игра.
  let mark = H.mark();
  H.send({ t: 'start' });
  const latencies = [];
  let totalQuestions = 0;
  let q = 0;
  const dropped = students.slice(0, RECONNECTORS);
  const lateStudent = students[N - 1];
  let lateChecked = false;
  let reconnectChecked = false;

  while (true) {
    const qs = await H.wait((m) => m.t === 'host' && m.phase === 'question', 60000, mark);
    totalQuestions = qs.question.total;
    q = qs.question.index;
    mark = H.mark();

    // Студенты получают вопрос и отвечают через случайное время.
    await Promise.all(students.map(async (s) => {
      if (s === lateStudent && !lateChecked) return; // этот студент ответит после таймера
      await s.client.wait((m) => m.t === 'state' && m.phase === 'question' && m.index === q, 30000, 0);
      if (dropped.includes(s) && q === 3 && !reconnectChecked) {
        // Обрыв связи и вход заново по одному имени, без токена.
        // Чётные студенты закрывают вкладку, нечётные пропадают молча (сервер об этом не знает).
        if (dropped.indexOf(s) % 2 === 0) {
          await new Promise((r) => { s.client.ws.once('close', r); s.client.close(); });
          await sleep(rand(300, 800));
        } else {
          s.client.ws._socket.pause();
          s.frozen = s.client;
          await sleep(rand(300, 800));
        }
        s.client = new Client(s.name);
        await s.client.open();
        s.client.send({ t: 'join', name: s.name });
        const back = await s.client.wait((m) => m.t === 'state' || m.t === 'joinError');
        s.reconnectOk = back.phase === 'question' && back.index === q;
        s.scoreBack = true;
      }
      await sleep(rand(300, 6000));
      const choice = Math.floor(Math.random() * 4);
      const sent = Date.now();
      const m0 = s.client.mark();
      s.client.send({ t: 'answer', q, choice });
      const ack = await s.client.wait((m) => m.t === 'state' && m.answered === true && m.index === q, 15000, m0);
      latencies.push(ack._at - sent);
    }));

    if (!lateChecked) {
      // Ведущий завершает вопрос (кнопка «Пропустить таймер»), если он не завершился сам.
      const done = await H.wait((m) => m.t === 'host' && m.phase === 'reveal', 3000, mark).catch(() => null);
      if (!done) H.send({ t: 'skip' });
    }
    const rv = await H.wait((m) => m.t === 'host' && m.phase === 'reveal', 30000, mark);
    mark = H.mark();

    if (!lateChecked) {
      const lm = lateStudent.client.mark();
      lateStudent.client.send({ t: 'answer', q, choice: 0 });
      const n = await lateStudent.client.wait((m) => m.t === 'notice', 5000, lm).catch(() => null);
      check(n && /вышло/.test(n.msg), 'Ответ после окончания таймера не принят');
      lateChecked = true;
    }

    const sum = rv.reveal.histogram.reduce((a, b) => a + b, 0);
    const expectedAnswers = q === 0 ? N - 1 : N;
    if (sum !== expectedAnswers) check(false, `Вопрос ${q + 1}: ответов ${sum}, ожидалось ${expectedAnswers}`);

    // Все получили итог вопроса; проверяем баллы.
    await Promise.all(students.map(async (s) => {
      const r = await s.client.wait((m) => m.t === 'state' && m.phase === 'reveal' && m.index === q, 15000, 0);
      if (r.choice !== null && r.isCorrect) {
        if (r.points < 500 || r.points > 1000 || r.points % 10 !== 0) s.badPoints = true;
      } else if (r.points !== 0) s.badPoints = true;
      s.myScore += r.points;
      if (r.score !== s.myScore) s.scoreMismatch = true;
      if (r.choice !== null) s.answeredQ++;
    }));

    if (dropped.some((s) => s.scoreBack) && !reconnectChecked) {
      reconnectChecked = true;
      check(dropped.every((s) => s.reconnectOk), `${RECONNECTORS} студентов потеряли связь и вернулись по имени в тот же вопрос`);
      check(dropped.every((s) => !s.scoreMismatch), 'После возвращения баллы сохранились');
    }

    if (rv.reveal.isLast) {
      H.send({ t: 'next' });
      break;
    }
    if (q === 1) {
      // Автопереход: включаем 10 с, ставим на паузу, снимаем паузу и ждём, что вопрос начнётся сам.
      let m0 = H.mark();
      H.send({ t: 'settings', auto: 10 });
      const on = await H.wait((m) => m.t === 'host' && m.phase === 'reveal' && m.reveal.autoMs > 0, 5000, m0).catch(() => null);
      m0 = H.mark();
      H.send({ t: 'pause' });
      const paused = await H.wait((m) => m.t === 'host' && m.reveal && m.reveal.autoPaused, 5000, m0).catch(() => null);
      await sleep(1500);
      check(on && paused && H.msgs.slice(m0).every((m) => m.t !== 'host' || m.phase === 'reveal'), 'Автопереход ставится на паузу');
      m0 = H.mark();
      const t = Date.now();
      H.send({ t: 'pause' });
      const nq = await H.wait((m) => m.t === 'host' && m.phase === 'question' && m.question.index === q + 1, 20000, m0).catch(() => null);
      const dt = (Date.now() - t) / 1000;
      check(nq && dt > 9 && dt < 13, `Автопереход: следующий вопрос начался сам через ${dt.toFixed(1)} с`);
      H.send({ t: 'settings', auto: 0 });
      continue;
    }
    H.send({ t: 'next' });
  }

  const fin = await H.wait((m) => m.t === 'host' && m.phase === 'finished', 30000, mark);
  check(fin.ranking.length === N, `Итоговый рейтинг: ${fin.ranking.length} участников`);
  check(q + 1 === totalQuestions && totalQuestions === 12, `Пройдено вопросов: ${q + 1} из ${totalQuestions}`);
  check(students.every((s) => !s.badPoints), 'Баллы за каждый ответ: 0 или от 500 до 1000, кратно 10');
  check(students.every((s) => !s.scoreMismatch), 'Сумма баллов у каждого студента сходится');

  const finals = await Promise.all(students.map((s) => s.client.wait((m) => m.t === 'state' && m.phase === 'finished', 15000, 0)));
  check(finals.every((f, i) => f.score === students[i].myScore), 'Каждый студент получил итог с верными баллами и местом');
  const byName = new Map(fin.ranking.map((r) => [r.name, r]));
  check(students.every((s) => byName.get(s.name) && byName.get(s.name).score === s.myScore), 'Рейтинг ведущего совпадает с баллами студентов');

  // 5. CSV.
  const res = await fetch(BASE + '/api/results.csv', { headers: { 'X-Host-Pin': PIN } });
  const csv = await res.text();
  const raw = Buffer.from(await (await fetch(BASE + '/api/results.csv', { headers: { 'X-Host-Pin': PIN } })).arrayBuffer());
  const lines = csv.replace(/^﻿/, '').trim().split(/\r\n/);
  check(res.ok && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, 'CSV скачивается, есть BOM для Excel');
  check(lines.length === N + 1 && lines[0].split(';').length === 4 + totalQuestions, `CSV: ${lines.length - 1} строк, ${lines[0].split(';').length} колонок`);
  const noPin = await fetch(BASE + '/api/results.csv');
  check(noPin.status === 403, 'CSV без PIN не отдаётся');

  latencies.sort((a, b) => a - b);
  const p = (x) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * x))];
  console.log(`\nОтветов отправлено: ${latencies.length}`);
  console.log(`Время подтверждения ответа: медиана ${p(0.5)} мс, 95% ответов быстрее ${p(0.95)} мс, максимум ${latencies[latencies.length - 1]} мс`);

  // Убираем тестовых студентов и возвращаем сервер в лобби, чтобы не мешать настоящей игре.
  students.forEach((s) => { s.client.close(); if (s.frozen) s.frozen.ws.terminate(); });
  await sleep(1500);
  H.send({ t: 'reset' });
  await sleep(300);
  H.send({ t: 'settings', seconds: 20, count: 12, auto: 15 });
  await sleep(300);
  H.close();
  finish(t0);
}

function finish(t0) {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nПроверок: ${checks.length}, пройдено: ${checks.length - failed.length}, ошибок: ${failed.length}`);
  console.log(`Длительность: ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  console.log(failed.length ? 'ИТОГ: ЕСТЬ ОШИБКИ' : 'ИТОГ: ВСЁ В ПОРЯДКЕ');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  check(false, 'Тест прерван: ' + e.message);
  finish(T0);
});
