// Экран ведущего
(function () {
  'use strict';

  var LETTERS = ['А', 'Б', 'В', 'Г'];
  var $ = function (id) { return document.getElementById(id); };

  var ws = null;
  var retry = 0;
  var pin = '';
  try { pin = sessionStorage.getItem('mq_pin') || ''; } catch (e) {}
  var authed = false;
  var replaced = false;
  var st = null; // последнее состояние от сервера
  var timerEnd = 0;
  var timerId = null;

  function show(id) {
    var list = document.querySelectorAll('.view');
    for (var i = 0; i < list.length; i++) list[i].hidden = list[i].id !== id;
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function cmd(t, extra) {
    if (!ws || ws.readyState !== 1 || !authed) return;
    var m = extra || {};
    m.t = t;
    ws.send(JSON.stringify(m));
  }

  // ---------- Тема ----------

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function updateThemeBtn() {
    $('theme').textContent = currentTheme() === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }
  $('theme').addEventListener('click', function () {
    var t = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('mq_theme', t); } catch (e) {}
    updateThemeBtn();
    this.blur();
  });
  updateThemeBtn();

  // ---------- Таймер ----------

  function stopTimer() { clearInterval(timerId); timerId = null; }
  function startTimer(ms) {
    stopTimer();
    timerEnd = Date.now() + ms;
    tick();
    timerId = setInterval(tick, 200);
  }
  function tick() {
    var left = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    var t = $('q-timer');
    t.textContent = left;
    t.classList.toggle('low', left <= 5);
    if (left <= 0) stopTimer();
  }

  // ---------- Отрисовка ----------

  function renderLobby(s) {
    stopTimer();
    $('top-info').textContent = 'Ожидание участников';
    $('short-url').textContent = s.shortUrl;
    var qr = $('qr');
    if (qr.getAttribute('data-url') !== s.joinUrl) {
      qr.innerHTML = s.qrSvg || ''; // SVG строит сервер из адреса игры
      qr.setAttribute('data-url', s.joinUrl);
      qr.setAttribute('aria-label', 'QR-код: ' + s.joinUrl);
    }
    $('count').textContent = s.players.length;
    $('count-word').textContent = plural(s.players.length, 'участник', 'участника', 'участников');
    var ul = $('names');
    ul.textContent = '';
    s.players.forEach(function (p) {
      var li = el('li', p.connected ? '' : 'off');
      li.appendChild(el('span', '', p.name));
      var x = el('button', '', '×');
      x.type = 'button';
      x.title = 'Убрать из игры';
      x.onclick = function () {
        if (confirm('Убрать «' + p.name + '» из игры?')) cmd('kick', { id: p.id });
      };
      li.appendChild(x);
      ul.appendChild(li);
    });
    markSeg('set-seconds', s.settings.seconds);
    markSeg('set-count', s.settings.count);
    var info;
    if (s.questionsError) info = s.questionsError;
    else {
      info = 'В файле вопросов: ' + s.questionsAvailable + '.';
      if (s.questionsBadLines.length) info += ' Пропущены строки с ошибками: ' + s.questionsBadLines.join(', ') + '.';
    }
    $('q-info').textContent = info;
    var warn = $('lobby-warn');
    warn.hidden = !s.pinIsDefault;
    warn.textContent = 'PIN ведущего стандартный (1234). Задайте свой PIN в настройках сервера (HOST_PIN).';
    $('start').disabled = !s.questionsAvailable;
    show('v-lobby');
  }

  function markSeg(id, value) {
    var b = $(id).querySelectorAll('button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', Number(b[i].getAttribute('data-v')) === value);
  }

  function renderQuestion(s) {
    var q = s.question;
    var isReveal = s.phase === 'reveal';
    $('top-info').textContent = isReveal ? 'Итоги вопроса' : 'Идёт вопрос';
    $('q-num').textContent = 'Вопрос ' + (q.index + 1) + ' из ' + q.total;
    $('q-answered').textContent = 'Ответили ' + s.answered + ' из ' + s.expected;
    $('q-text').textContent = q.text;

    var box = $('q-options');
    box.textContent = '';
    box.classList.toggle('revealed', isReveal);
    var hist = isReveal ? s.reveal.histogram : null;
    var max = hist ? Math.max(1, Math.max.apply(null, hist)) : 1;
    q.options.forEach(function (text, i) {
      var d = el('div', 'opt opt-' + i);
      if (hist) {
        d.classList.add(i === s.reveal.correct ? 'right' : 'wrong');
        var bar = el('span', 'bar');
        bar.style.width = Math.round((hist[i] / max) * 100) + '%';
        d.appendChild(bar);
      }
      d.appendChild(el('span', 'letter', LETTERS[i]));
      d.appendChild(el('span', 'txt', text));
      if (hist) {
        if (i === s.reveal.correct) d.appendChild(el('span', 'mark', '✓'));
        d.appendChild(el('span', 'cnt', String(hist[i])));
      }
      box.appendChild(d);
    });

    $('reveal').hidden = !isReveal;
    $('skip').hidden = isReveal;
    $('next').hidden = !isReveal;
    if (isReveal) {
      stopTimer();
      $('q-timer').textContent = '0';
      $('q-timer').classList.remove('low');
      $('r-expl').textContent = s.reveal.explanation || 'Пояснения нет.';
      var ol = $('r-top');
      ol.textContent = '';
      if (!s.reveal.top.length) ol.appendChild(el('li', 'muted', 'Пока нет участников'));
      s.reveal.top.forEach(function (p) {
        var li = el('li');
        li.appendChild(el('span', '', p.rank + '. ' + p.name));
        li.appendChild(el('b', '', String(p.score)));
        ol.appendChild(li);
      });
      $('next').firstChild.textContent = s.reveal.isLast ? 'Итоги игры ' : 'Дальше ';
    } else if (!st || st.phase !== 'question' || st.question.index !== q.index || !timerId) {
      startTimer(q.remainingMs);
    }
    show('v-question');
  }

  function renderFinal(s) {
    stopTimer();
    $('top-info').textContent = 'Игра окончена · ' + s.ranking.length + ' ' + plural(s.ranking.length, 'участник', 'участника', 'участников') + ' · вопросов: ' + s.asked;
    var tb = $('rank-body');
    tb.textContent = '';
    s.ranking.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', '', String(p.rank)));
      tr.appendChild(el('td', '', p.name));
      tr.appendChild(el('td', '', String(p.score)));
      tr.appendChild(el('td', '', p.correct + ' из ' + s.asked));
      tb.appendChild(tr);
    });
    if (s.saveError) $('saved').textContent = 'Не удалось сохранить файл на сервере — обязательно скачайте результаты кнопкой выше.';
    else if (s.savedAt) $('saved').textContent = 'Копия результатов сохранена на сервере в ' + new Date(s.savedAt).toLocaleTimeString('ru-RU') + '.';
    else $('saved').textContent = '';
    show('v-final');
  }

  function render(s) {
    if (s.phase === 'lobby') renderLobby(s);
    else if (s.phase === 'question' || s.phase === 'reveal') renderQuestion(s);
    else if (s.phase === 'finished') renderFinal(s);
    st = s;
  }

  // ---------- Кнопки и клавиша Пробел ----------

  function spaceAction() {
    if (!st) return;
    if (st.phase === 'lobby') { if (!$('start').disabled) cmd('start'); }
    else if (st.phase === 'question') cmd('skip');
    else if (st.phase === 'reveal') cmd('next');
  }

  $('start').onclick = function () { this.blur(); cmd('start'); };
  $('skip').onclick = function () { this.blur(); cmd('skip'); };
  $('next').onclick = function () { this.blur(); cmd('next'); };
  $('end').onclick = function () {
    this.blur();
    if (confirm('Завершить игру сейчас? Результаты сохранятся по уже заданным вопросам.')) cmd('end');
  };
  $('reset').onclick = function () {
    this.blur();
    if (confirm('Начать новую игру? Текущие результаты пропадут с экрана. Вы их скачали?')) cmd('reset');
  };
  $('download').onclick = download;

  ['set-seconds', 'set-count'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !st) return;
      b.blur();
      var v = Number(b.getAttribute('data-v'));
      cmd('settings', {
        seconds: id === 'set-seconds' ? v : st.settings.seconds,
        count: id === 'set-count' ? v : st.settings.count,
      });
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (e.repeat) return;
    spaceAction();
  });

  function download() {
    var btn = $('download');
    btn.disabled = true;
    fetch('/api/results.csv', { headers: { 'X-Host-Pin': pin }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'Результатов пока нет.' : 'Не удалось скачать результаты.');
        var cd = r.headers.get('Content-Disposition') || '';
        var m = /filename="([^"]+)"/.exec(cd);
        return r.blob().then(function (b) { return { blob: b, name: m ? m[1] : 'makroquiz.csv' }; });
      })
      .then(function (f) {
        var url = URL.createObjectURL(f.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      })
      .catch(function (err) { alert(err.message); })
      .then(function () { btn.disabled = false; });
  }

  // ---------- Вход и связь ----------

  $('pin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    pin = $('pin').value.trim();
    $('pin-error').textContent = '';
    replaced = false;
    auth();
  });

  $('take-back').onclick = function () {
    replaced = false;
    $('replaced').hidden = true;
    auth();
  };

  function auth() {
    if (ws && ws.readyState === 1 && pin) ws.send(JSON.stringify({ t: 'hostAuth', pin: pin }));
  }

  function handle(m) {
    switch (m.t) {
      case 'hb': // сервер проверяет, что страница на связи
        if (ws && ws.readyState === 1) ws.send('{"t":"hb"}');
        break;
      case 'authOk':
        authed = true;
        try { sessionStorage.setItem('mq_pin', pin); } catch (e) {}
        $('replaced').hidden = true;
        break;
      case 'authError':
        authed = false;
        try { sessionStorage.removeItem('mq_pin'); } catch (e) {}
        $('pin-error').textContent = m.msg;
        show('v-pin');
        break;
      case 'host':
        if (authed) render(m);
        break;
      case 'hostReplaced':
        authed = false;
        replaced = true;
        $('replaced').hidden = false;
        break;
      case 'error':
        alert(m.msg);
        break;
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = function () {
      retry = 0;
      $('conn').hidden = true;
      if (pin && !replaced) auth();
    };
    ws.onmessage = function (e) {
      try { handle(JSON.parse(e.data)); } catch (err) {}
    };
    ws.onclose = function () {
      ws = null;
      authed = false;
      $('conn').hidden = false;
      setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
    };
  }

  show('v-pin');
  connect();
})();
