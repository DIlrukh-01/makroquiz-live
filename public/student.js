// Экран студента
(function () {
  'use strict';

  var LETTERS = ['А', 'Б', 'В', 'Г'];
  var $ = function (id) { return document.getElementById(id); };

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  var ws = null;
  var retry = 0;
  var wantJoin = false; // хотим быть в игре (переподключаться автоматически)
  var name = store.get('mq_name') || '';
  var token = store.get('mq_token') || '';
  var current = null; // последнее состояние от сервера
  var timerEnd = 0;
  var timerId = null;

  // ---------- Экраны ----------

  function show(id) {
    var list = document.querySelectorAll('.screen');
    for (var i = 0; i < list.length; i++) list[i].hidden = list[i].id !== id;
    window.scrollTo(0, 0);
  }

  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function setWho(text) {
    var list = document.querySelectorAll('.who');
    for (var i = 0; i < list.length; i++) list[i].textContent = text;
  }

  function showJoin(error) {
    wantJoin = false;
    stopTimer();
    $('name').value = name || $('name').value;
    $('join-error').textContent = error || '';
    $('join-btn').disabled = false;
    show('s-join');
  }

  function showMessage(text, btnText, onClick) {
    stopTimer();
    $('m-text').textContent = text;
    $('m-btn').textContent = btnText;
    $('m-btn').onclick = onClick;
    show('s-message');
  }

  // ---------- Таймер ----------

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
  }

  function startTimer(remainingMs) {
    stopTimer();
    timerEnd = Date.now() + remainingMs;
    tick();
    timerId = setInterval(tick, 200);
  }

  function tick() {
    var left = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    var els = [$('q-timer'), $('a-timer')];
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = left;
      els[i].classList.toggle('low', left <= 5);
    }
    if (left <= 0) {
      stopTimer();
      if (current && current.phase === 'question' && !current.answered) {
        disableOptions();
        $('q-status').textContent = 'Время вышло';
      }
    }
  }

  // ---------- Отрисовка состояния ----------

  function disableOptions() {
    var b = $('q-options').querySelectorAll('button');
    for (var i = 0; i < b.length; i++) b[i].disabled = true;
  }

  function render(st) {
    current = st;
    setWho(st.name);
    if (st.phase === 'lobby') {
      stopTimer();
      show('s-wait');
      return;
    }
    if (st.phase === 'question') {
      var num = 'Вопрос ' + (st.index + 1) + ' из ' + st.total;
      if (st.answered) {
        $('a-num').textContent = num;
        var c = $('a-choice');
        c.textContent = LETTERS[st.choice];
        c.className = 'chosen opt-' + st.choice;
        show('s-answered');
      } else {
        $('q-num').textContent = num;
        $('q-text').textContent = st.text;
        $('q-status').textContent = '';
        var box = $('q-options');
        box.textContent = '';
        st.options.forEach(function (text, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'opt opt-' + i;
          var l = document.createElement('span');
          l.className = 'letter';
          l.textContent = LETTERS[i];
          var s = document.createElement('span');
          s.textContent = text;
          b.appendChild(l);
          b.appendChild(s);
          b.onclick = function () { answer(st.index, i); };
          box.appendChild(b);
        });
        show('s-question');
      }
      startTimer(st.remainingMs);
      return;
    }
    if (st.phase === 'reveal') {
      stopTimer();
      var v = $('r-verdict');
      if (st.choice === null) {
        v.textContent = 'Нет ответа';
        v.className = 'verdict muted';
        $('r-points').textContent = '0 баллов';
      } else if (st.isCorrect) {
        v.textContent = 'Верно!';
        v.className = 'verdict ok';
        $('r-points').textContent = '+' + st.points + ' баллов';
      } else {
        v.textContent = 'Неверно';
        v.className = 'verdict bad';
        $('r-points').textContent = '0 баллов';
      }
      $('r-correct').textContent = LETTERS[st.correct] + '. ' + st.options[st.correct];
      $('r-expl').textContent = st.explanation || '';
      $('r-score').textContent = 'Всего: ' + st.score + ' баллов · место ' + st.rank + ' из ' + st.players;
      show('s-result');
      return;
    }
    if (st.phase === 'finished') {
      stopTimer();
      $('f-rank').textContent = st.rank + ' из ' + st.players;
      $('f-score').textContent = st.score + ' баллов';
      $('f-correct').textContent = 'Верных ответов: ' + st.correctCount + ' из ' + st.total;
      show('s-final');
    }
  }

  function answer(qIndex, choice) {
    if (!ws || ws.readyState !== 1) {
      toast('Нет связи. Подождите секунду и нажмите ещё раз.');
      return;
    }
    disableOptions();
    $('q-status').textContent = 'Отправляем…';
    ws.send(JSON.stringify({ t: 'answer', q: qIndex, choice: choice }));
  }

  // ---------- Связь с сервером ----------

  function sendJoin() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'join', name: name, token: token }));
  }

  function handle(msg) {
    switch (msg.t) {
      case 'hb': // сервер проверяет, что страница на связи
        if (ws && ws.readyState === 1) ws.send('{"t":"hb"}');
        break;
      case 'welcome':
        name = msg.name;
        token = msg.token;
        store.set('mq_name', name);
        store.set('mq_token', token);
        break;
      case 'state':
        if (wantJoin) render(msg);
        break;
      case 'joinError':
        store.del('mq_token');
        token = '';
        showJoin(msg.msg);
        break;
      case 'notice':
        toast(msg.msg);
        if (current && current.phase === 'question') $('q-status').textContent = msg.msg;
        break;
      case 'kicked':
        store.del('mq_token');
        store.del('mq_name');
        token = '';
        name = '';
        showJoin('Преподаватель убрал это имя из игры. Войдите с правильными фамилией и именем.');
        break;
      case 'replaced':
        wantJoin = false;
        showMessage('Вы вошли в игру с другой вкладки или телефона.', 'Продолжить здесь', function () {
          wantJoin = true;
          sendJoin();
        });
        break;
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = function () {
      retry = 0;
      $('conn').hidden = true;
      if (wantJoin && name) sendJoin();
    };
    ws.onmessage = function (e) {
      try { handle(JSON.parse(e.data)); } catch (err) {}
    };
    ws.onclose = function () {
      ws = null;
      if (wantJoin) $('conn').hidden = false;
      setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
    };
  }

  // Телефон проснулся или вкладка снова открыта — сразу проверяем связь.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && ws && ws.readyState === 1 && wantJoin) sendJoin();
  });

  $('join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = $('name').value.replace(/\s+/g, ' ').trim();
    if (value.split(' ').length < 2) {
      $('join-error').textContent = 'Нужны фамилия и имя — минимум два слова.';
      return;
    }
    if (value.toLowerCase() !== (name || '').toLowerCase()) {
      token = '';
      store.del('mq_token');
    }
    name = value;
    wantJoin = true;
    $('join-error').textContent = '';
    $('join-btn').disabled = true;
    if (ws && ws.readyState === 1) sendJoin();
    else $('join-error').textContent = 'Подключаемся к серверу…';
  });

  $('change-name').addEventListener('click', function () {
    store.del('mq_token');
    token = '';
    $('name').value = '';
    showJoin('');
  });

  // Если студент уже входил с этого телефона, возвращаем его в игру автоматически.
  if (name && token) {
    wantJoin = true;
    showMessage('Возвращаемся в игру…', 'Войти под другим именем', function () {
      store.del('mq_token');
      token = '';
      showJoin('');
    });
  } else {
    $('name').value = name;
    show('s-join');
  }
  connect();
})();
