/* 西安城墙夜游猫猫图鉴 · 逻辑 */
(function () {
  'use strict';
  var LS_KEY = 'xian-wall-cats-v1';
  var COOLDOWN_MS = 5000;
  var ENCOUNTER_RADIUS_M = 80;

  var DATA = null;
  var state = {
    skin: 'classic',
    mode: 'cloud',
    collection: {},      // catId -> { time, gate, note }
    pos: null,          // { lat, lng, simulated }
    nearestGate: null,
    nearestDist: Infinity,
    coolingUntil: 0,
    currentCat: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;

  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        state.skin = s.skin || 'classic';
        state.mode = s.mode || 'cloud';
        state.collection = s.collection || {};
      }
    } catch (e) { /* 忽略损坏的存档 */ }
  }
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        skin: state.skin, mode: state.mode, collection: state.collection
      }));
    } catch (e) { /* 隐私模式等情况下静默失败 */ }
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  /* ---------- 距离 ---------- */
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function fmtDist(m) {
    if (!isFinite(m)) return '—';
    if (m < 1000) return Math.round(m) + ' 米';
    return (m / 1000).toFixed(2) + ' 公里';
  }

  /* ---------- 掉落 ---------- */
  /* 先按稀有度档位抽（常见 60% / 稀有 30% / 传说 10%），再在档内按皮肤、城门加权挑猫 */
  function pickCat(gateId) {
    var roll = Math.random();
    var tier = roll < 0.6 ? 'common' : (roll < 0.9 ? 'rare' : 'legendary');
    var pool = DATA.cats
      .filter(function (c) { return c.rarity === tier; })
      .map(function (cat) {
        var w = 1;
        if (cat.skin === state.skin) w *= 1.5;      // 皮肤气质加成
        if (cat.gate === gateId) w *= 1.6;          // 城门归属加成
        return { cat: cat, w: w };
      });
    var total = pool.reduce(function (s, p) { return s + p.w; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) return pool[i].cat;
    }
    return pool[pool.length - 1].cat;
  }

  function encounter(gateId) {
    var gate = DATA.gates.find(function (g) { return g.id === gateId; });
    var cat = pickCat(gateId);
    var isNew = !state.collection[cat.id];
    state.collection[cat.id] = {
      time: new Date().toISOString(),
      gate: gateId,
      note: (state.collection[cat.id] || {}).note || ''
    };
    saveState();
    renderDex();
    renderProgress();
    toast(isNew
      ? '🎉 在' + gate.name + '偶遇了「' + cat.name + '」！图鉴 +1'
      : '🐱 又在' + gate.name + '碰到「' + cat.name + '」了，老朋友了');
    openPostcard(cat.id);
  }

  function startCooldown() {
    state.coolingUntil = Date.now() + COOLDOWN_MS;
    renderWall();
    var left = COOLDOWN_MS;
    var timer = setInterval(function () {
      left -= 500;
      var hint = $('wallHint');
      if (left <= 0) {
        clearInterval(timer);
        hint.textContent = '冷却好了，继续云散步 →';
        renderWall();
      } else {
        hint.textContent = '猫猫们散开了，冷却中 ' + Math.ceil(left / 1000) + ' 秒…';
      }
    }, 500);
  }

  /* ---------- 渲染 ---------- */
  function renderProgress() {
    var n = Object.keys(state.collection).length;
    $('progressFill').style.width = (n / DATA.cats.length * 100) + '%';
    $('progressText').textContent = '图鉴 ' + n + ' / ' + DATA.cats.length;
  }

  function renderWall() {
    var wall = $('wall');
    wall.innerHTML = '';
    var cooling = Date.now() < state.coolingUntil;
    DATA.gates.forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'gate' + (cooling ? ' cooling' : '');
      b.type = 'button';
      var dist = '';
      if (state.mode === 'real' && state.pos) {
        dist = fmtDist(haversine(state.pos.lat, state.pos.lng, g.lat, g.lng));
      }
      b.innerHTML = '<span class="g-emoji">' + g.emoji + '</span>' +
        '<span class="g-name">' + g.name + '</span>' +
        '<span class="g-dist">' + (dist || g.alias) + '</span>';
      b.addEventListener('click', function () {
        if (state.mode === 'cloud') {
          if (Date.now() < state.coolingUntil) { toast('冷却中，再等一会儿～'); return; }
          $('wallHint').textContent = '在' + g.name + '散步中… 有猫在附近！';
          setTimeout(function () { encounter(g.id); startCooldown(); }, 600);
        } else {
          toast(g.name + '：' + g.desc);
        }
      });
      wall.appendChild(b);
    });
  }

  function renderDex() {
    var grid = $('dexGrid');
    grid.innerHTML = '';
    DATA.cats.forEach(function (cat) {
      var got = state.collection[cat.id];
      var r = DATA.rarity[cat.rarity];
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'dex-item' + (got ? '' : ' locked') + (cat.rarity === 'legendary' ? ' legendary' : '');
      d.innerHTML = '<span class="d-emoji">' + (got ? cat.emoji : '❓') + '</span>' +
        '<span class="d-name">' + (got ? cat.name : '？？？') + '</span>' +
        '<span class="d-rarity">' + r.stars + ' ' + r.label + ' · ' + cat.color.split('，')[0] + '</span>';
      if (got) d.addEventListener('click', function () { openPostcard(cat.id); });
      grid.appendChild(d);
    });
  }

  /* ---------- 明信片 ---------- */
  function fmtTime(iso) {
    var d = new Date(iso);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function openPostcard(catId) {
    var cat = DATA.cats.find(function (c) { return c.id === catId; });
    var rec = state.collection[catId];
    if (!cat || !rec) return;
    var gate = DATA.gates.find(function (g) { return g.id === rec.gate; });
    var r = DATA.rarity[cat.rarity];
    state.currentCat = catId;
    $('cardEmoji').textContent = cat.emoji;
    $('cardName').textContent = cat.name;
    $('cardRarity').textContent = r.stars + ' ' + r.label + ' · ' + cat.color;
    $('cardMeta').textContent = (gate ? gate.name : '') + ' · ' + fmtTime(rec.time);
    $('cardStory').textContent = cat.story;
    $('cardNote').value = rec.note || '';
    $('modalMask').hidden = false;
  }
  function closePostcard() { $('modalMask').hidden = true; state.currentCat = null; }

  /* ---------- 实景定位 ---------- */
  function updateNearest() {
    if (!state.pos) return;
    var best = null, bestD = Infinity;
    DATA.gates.forEach(function (g) {
      var d = haversine(state.pos.lat, state.pos.lng, g.lat, g.lng);
      if (d < bestD) { bestD = d; best = g; }
    });
    state.nearestGate = best;
    state.nearestDist = bestD;
    $('nearestGate').textContent = best.name + '（' + best.alias + '）';
    $('nearestDist').textContent = '约 ' + fmtDist(bestD);
    var btn = $('encounterBtn');
    if (bestD < ENCOUNTER_RADIUS_M) {
      btn.disabled = false;
      btn.textContent = '🐱 偶遇猫猫！' + best.name + '就在 ' + Math.round(bestD) + ' 米内';
    } else {
      btn.disabled = true;
      btn.textContent = '🐱 偶遇猫猫（需走近 80 米内）';
    }
    renderWall();
  }

  function locate() {
    if (!navigator.geolocation) { $('locStatus').textContent = '此浏览器不支持定位'; return; }
    $('locStatus').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(function (p) {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, simulated: false };
      $('locStatus').textContent = '已定位（' + state.pos.lat.toFixed(4) + ', ' + state.pos.lng.toFixed(4) + '）';
      updateNearest();
    }, function (err) {
      $('locStatus').textContent = '定位失败：' + err.message + '（可用下方室内测试）';
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---------- 模式 / 皮肤 ---------- */
  function applySkin() {
    document.body.dataset.skin = state.skin;
    document.querySelectorAll('.skin-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.skin === state.skin);
    });
  }
  function applyMode() {
    document.body.dataset.mode = state.mode;
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
    $('realPanel').hidden = state.mode !== 'real';
    $('modeDesc').textContent = state.mode === 'cloud'
      ? '云逛模式：点下面的城门节点，随时随地触发猫猫掉落（每次冷却 5 秒）。'
      : '实景模式：先点「获取我的位置」，走近任意城门 80 米内，亮起偶遇按钮；在家可用「室内测试」模拟。';
    $('wallHint').textContent = state.mode === 'cloud' ? '点一扇城门，云散步出发 →' : '实景模式：城门只显示距离，点城门看它的介绍。';
    renderWall();
  }

  /* ---------- 启动 ---------- */
  function init(data) {
    DATA = data;
    loadState();
    applySkin();
    applyMode();
    renderProgress();
    renderDex();

    document.querySelectorAll('.skin-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.skin = b.dataset.skin;
        saveState();
        applySkin();
        toast('已切换「' + b.textContent.trim() + '」，对应气质猫掉率小幅提升');
      });
    });
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.mode;
        saveState();
        applyMode();
      });
    });

    $('locBtn').addEventListener('click', locate);
    $('encounterBtn').addEventListener('click', function () {
      if (state.nearestGate && state.nearestDist < ENCOUNTER_RADIUS_M) encounter(state.nearestGate.id);
    });
    $('debugBtn').addEventListener('click', function () {
      var target = state.nearestGate;
      if (!target) target = DATA.gates[0]; // 默认永宁门
      state.pos = { lat: target.lat, lng: target.lng, simulated: true };
      $('locStatus').textContent = '室内测试：已模拟到' + target.name + '门口';
      updateNearest();
      toast('已模拟走近' + target.name + '，可以点偶遇按钮啦');
    });

    $('modalClose').addEventListener('click', closePostcard);
    $('modalMask').addEventListener('click', function (e) { if (e.target === $('modalMask')) closePostcard(); });
    $('saveNoteBtn').addEventListener('click', function () {
      if (!state.currentCat) return;
      state.collection[state.currentCat].note = $('cardNote').value.trim();
      saveState();
      toast('笔记已保存到这张明信片上 💾');
    });
  }

  fetch('cats.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(init)
    .catch(function (err) {
      document.getElementById('dexGrid').innerHTML =
        '<p style="grid-column:1/-1;font-size:.85rem;line-height:1.6">cats.json 加载失败：' + err.message +
        '。请用 HTTP 服务打开本站（如 python3 -m http.server），不要直接双击文件。</p>';
      console.error('[xian-wall-cats] cats.json 加载失败', err);
    });
})();
