/* 西安城墙微缩像素世界 V2 · Canvas 2.5D 沙盘 */
(function () {
  'use strict';
  var LS_KEY = 'xian-wall-world-v2';
  var LS_CAT_KEY = 'xian-wall-cats-v1'; // 沿用 V1 猫猫存档
  var CELL = 20, GRID_W = 80, GRID_H = 60;
  var PROX_CLOUD = 70;      // 云逛：走到地标 70 世界单位内高亮
  var PROX_REAL_M = 100;    // 实景：真实距离 100 米内高亮

  var DATA = null, CATS = null;
  var state = {
    skin: 'classic', mode: 'cloud',
    collection: {},   // itemId -> { time, landmark, note }
    catCollection: {},
    highlighted: {},  // landmarkId -> true
    pendingLandmark: null,
    currentItem: null, currentCat: null
  };

  /* ---------- 世界 ---------- */
  var WORLD = { w: 1600, h: 1200 };
  var WALL_POLY = [];       // 城墙多边形顶点（按地标顺序）
  var MOAT_POLY = [];       // 护城河外圈（由城墙多边形向外放大）
  var MOAT_CX = 790, MOAT_CY = 600, MOAT_K = 1.07;
  var blocked = [];         // 寻路网格
  var TREES = [], LAMPS = [];
  var player = { x: 700, y: 1050, path: [], moving: false, bob: 0, dir: 'down' };
  var cam = { cx: 700, cy: 640, scale: 0.6 };
  var cats = [];            // 游走的流浪猫
  var gps = { pos: null, simulated: false, watchId: null };
  var dpadDir = null;

  var canvas, ctx, wrap;
  var DPR = 1, CW = 0, CH = 0;
  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;

  /* ---------- 工具 ---------- */
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2800);
  }
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function fmtTime(iso) {
    var d = new Date(iso), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function distPtSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px - qx, py - qy);
  }
  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------- 存档 ---------- */
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) { var s = JSON.parse(raw); state.skin = s.skin || 'classic'; state.mode = s.mode || 'cloud'; state.collection = s.collection || {}; }
    } catch (e) {}
    try {
      var raw2 = localStorage.getItem(LS_CAT_KEY);
      if (raw2) state.catCollection = JSON.parse(raw2).collection || {};
    } catch (e) {}
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ skin: state.skin, mode: state.mode, collection: state.collection })); } catch (e) {}
  }
  function saveCats() {
    try { localStorage.setItem(LS_CAT_KEY, JSON.stringify({ skin: state.skin, mode: state.mode, collection: state.catCollection })); } catch (e) {}
  }

  /* ---------- 坐标换算 ---------- */
  function gpsToWorld(lat, lng) {
    var g = DATA.meta.gpsToWorld;
    return { x: g.xRef + (lng - g.lngRef) * g.xPerLng, y: g.yRef - (lat - g.latRef) * g.yPerLat };
  }
  function w2s(x, y) { return { x: (x - cam.cx) * cam.scale + CW / 2, y: (y - cam.cy) * cam.scale + CH / 2 }; }
  function s2w(x, y) { return { x: (x - CW / 2) / cam.scale + cam.cx, y: (y - CH / 2) / cam.scale + cam.cy }; }

  /* ---------- 寻路 ---------- */
  function buildGrid() {
    blocked = [];
    for (var gy = 0; gy < GRID_H; gy++) {
      blocked.push([]);
      for (var gx = 0; gx < GRID_W; gx++) {
        var x = gx * CELL + CELL / 2, y = gy * CELL + CELL / 2;
        blocked[gy][gx] = isBlocked(x, y);
      }
    }
  }
  function nearGate(x, y, r) {
    return DATA.landmarks.some(function (lm) { return Math.hypot(x - lm.x, y - lm.y) < r; });
  }
  function isBlocked(x, y) {
    if (x < 0 || y < 0 || x >= WORLD.w || y >= WORLD.h) return true;
    // 城墙带：距城墙线 26 内，且不在城门附近
    for (var i = 0; i < WALL_POLY.length; i++) {
      var a = WALL_POLY[i], b = WALL_POLY[(i + 1) % WALL_POLY.length];
      if (distPtSeg(x, y, a[0], a[1], b[0], b[1]) < 26) return !nearGate(x, y, 46);
    }
    // 护城河带：在外圈内、城墙线外，且不在城门桥附近
    if (pointInPoly(x, y, MOAT_POLY) && !pointInPoly(x, y, WALL_POLY)) {
      return !nearGate(x, y, 52);
    }
    return false;
  }
  function cellBlocked(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return true;
    return blocked[gy][gx];
  }
  function findPath(sx, sy, tx, ty) {
    var sc = { x: Math.floor(sx / CELL), y: Math.floor(sy / CELL) };
    var tc = { x: Math.floor(tx / CELL), y: Math.floor(ty / CELL) };
    if (cellBlocked(tc.x, tc.y)) {
      // 目标不可达：找附近最近的可走格子
      var found = null, best = 1e9;
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var nx = tc.x + dx, ny = tc.y + dy;
        if (!cellBlocked(nx, ny)) { var d = dx * dx + dy * dy; if (d < best) { best = d; found = { x: nx, y: ny }; } }
      }
      if (!found) return null;
      tc = found;
    }
    var key = function (x, y) { return x + ',' + y; };
    var open = [{ x: sc.x, y: sc.y, g: 0, f: 0, p: null }];
    var came = {}, gScore = {};
    gScore[key(sc.x, sc.y)] = 0;
    var closed = {};
    var DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.41], [1, -1, 1.41], [-1, 1, 1.41], [-1, -1, 1.41]];
    while (open.length) {
      var bi = 0;
      for (var i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      var cur = open.splice(bi, 1)[0];
      if (cur.x === tc.x && cur.y === tc.y) {
        var path = [], n = cur;
        while (n) { path.unshift({ x: n.x * CELL + CELL / 2, y: n.y * CELL + CELL / 2 }); n = n.p; }
        return path;
      }
      closed[key(cur.x, cur.y)] = true;
      for (var d = 0; d < DIRS.length; d++) {
        var nx = cur.x + DIRS[d][0], ny = cur.y + DIRS[d][1];
        if (cellBlocked(nx, ny) || closed[key(nx, ny)]) continue;
        if (DIRS[d][2] > 1 && (cellBlocked(cur.x + DIRS[d][0], cur.y) || cellBlocked(cur.x, cur.y + DIRS[d][1]))) continue;
        var ng = cur.g + DIRS[d][2];
        if (gScore[key(nx, ny)] === undefined || ng < gScore[key(nx, ny)]) {
          gScore[key(nx, ny)] = ng;
          var h = Math.hypot(tc.x - nx, tc.y - ny);
          open.push({ x: nx, y: ny, g: ng, f: ng + h, p: cur });
        }
      }
    }
    return null;
  }
  function moveTo(wx, wy) {
    var path = findPath(player.x, player.y, wx, wy);
    if (path && path.length > 1) { player.path = path.slice(1); player.moving = true; }
    else if (path && path.length === 1) { player.path = []; player.moving = false; }
  }

  /* ---------- 掉落 ---------- */
  function rollTier(mode) {
    var r = Math.random();
    if (mode === 'cloud') return r < 0.7 ? 3 : 2;          // 云逛：3档 70% / 2档 30%，绝无 1 档
    return r < 0.55 ? 3 : (r < 0.85 ? 2 : 1);             // 实景：3档 55% / 2档 30% / 1档 15%
  }
  function pickItem(mode, landmark) {
    var tier = rollTier(mode);
    var item = landmark.items.find(function (it) { return it.tier === tier; });
    return { item: item, tier: tier };
  }
  function triggerDrop(landmark) {
    var res = pickItem(state.mode, landmark);
    var item = res.item;
    state.pendingLandmark = landmark;
    showBurst(res.tier, function () {
      var isNew = !state.collection[item.id];
      state.collection[item.id] = {
        time: new Date().toISOString(), landmark: landmark.id,
        note: (state.collection[item.id] || {}).note || ''
      };
      saveState(); renderProgress(); renderDrawer();
      openCard(item, landmark, res.tier, isNew);
      if (state.mode === 'cloud') {
        toast('第 1 档传说风物仅限线下实景触发，今晚云逛只能遇见 3 / 2 档', 3600);
      }
      maybeCatBonus();
    });
  }
  function maybeCatBonus() {
    if (!CATS || Math.random() > 0.12) return;
    var cat = CATS.cats[Math.floor(Math.random() * CATS.cats.length)];
    setTimeout(function () {
      toast('🐱 彩蛋！一只流浪猫悄悄跟了你一路…', 3200);
      openCatPostcard(cat, null);
    }, 1200);
  }

  /* ---------- 开箱动画 ---------- */
  var burstCb = null;
  function showBurst(tier, cb) {
    var color = DATA.meta.tiers[String(tier)].color;
    var mask = $('burstMask');
    mask.style.setProperty('--ray', color);
    $('burstTip').textContent = DATA.meta.tiers[String(tier)].label + ' · 点一下光芒中心，揭晓风物';
    mask.hidden = false;
    burstCb = cb;
  }
  function hideBurst() { $('burstMask').hidden = true; var cb = burstCb; burstCb = null; if (cb) cb(); }

  /* ---------- 卡片 / 明信片 ---------- */
  function openCard(item, landmark, tier, isNew) {
    state.currentItem = item.id;
    var t = DATA.meta.tiers[String(tier)];
    $('cardTier').textContent = t.label;
    $('cardTier').style.color = t.color;
    $('cardEmoji').textContent = landmark.emoji;
    $('cardName').textContent = item.name;
    $('cardMeta').textContent = landmark.name + ' · ' + fmtTime(state.collection[item.id].time);
    $('cardStory').textContent = item.desc;
    var note = state.collection[item.id].note;
    $('cardNoteLine').textContent = note ? '✎ 你的笔记：' + note : (isNew ? '🎉 新风物收入图鉴！' : '已收集过的风物');
    $('cardMask').hidden = false;
  }
  function openItemPostcard(itemId) {
    var rec = state.collection[itemId];
    if (!rec) return;
    var lm = DATA.landmarks.find(function (l) { return l.id === rec.landmark; });
    var item = lm.items.find(function (it) { return it.id === itemId; });
    var t = DATA.meta.tiers[String(item.tier)];
    state.currentItem = itemId; state.currentCat = null;
    $('pcEmoji').textContent = lm.emoji;
    $('pcName').textContent = item.name;
    $('pcRarity').textContent = t.label;
    $('pcRarity').style.color = t.color;
    $('pcMeta').textContent = lm.name + ' · ' + fmtTime(rec.time);
    $('pcStory').textContent = item.desc;
    $('pcNote').value = rec.note || '';
    $('postcardMask').hidden = false;
  }
  function openCatPostcard(cat, gateId) {
    var rec = state.catCollection[cat.id];
    if (!rec) {
      rec = { time: new Date().toISOString(), gate: gateId || 'yongningmen', note: '' };
      state.catCollection[cat.id] = rec; saveCats();
    }
    state.currentCat = cat.id; state.currentItem = null;
    var gate = DATA.landmarks.find(function (l) { return l.id === rec.gate; });
    $('pcEmoji').textContent = cat.emoji;
    $('pcName').textContent = cat.name;
    $('pcRarity').textContent = { common: '★ 常见', rare: '★★ 稀有', legendary: '★★★ 传说' }[cat.rarity] || '';
    $('pcRarity').style.color = '';
    $('pcMeta').textContent = (gate ? gate.name : '') + ' · ' + fmtTime(rec.time);
    $('pcStory').textContent = cat.story;
    $('pcNote').value = rec.note || '';
    $('postcardMask').hidden = false;
  }

  /* ---------- 图鉴抽屉 ---------- */
  function renderProgress() {
    var n = Object.keys(state.collection).length;
    $('progressFill').style.width = (n / 36 * 100) + '%';
    $('progressText').textContent = '风物 ' + n + ' / 36';
    $('dexCount').textContent = n + '/36';
  }
  function renderDrawer() {
    var body = $('drawerBody');
    body.innerHTML = '';
    DATA.landmarks.forEach(function (lm) {
      var g = document.createElement('div');
      g.className = 'drawer-group';
      var h = document.createElement('h3');
      h.textContent = lm.emoji + ' ' + lm.name;
      g.appendChild(h);
      var grid = document.createElement('div');
      grid.className = 'drawer-items';
      lm.items.forEach(function (item) {
        var got = state.collection[item.id];
        var t = DATA.meta.tiers[String(item.tier)];
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'drawer-item' + (got ? '' : ' locked');
        b.innerHTML = (got ? item.name : '？？？') + '<span class="tier-dot" style="color:' + t.color + '">' + t.label + '</span>';
        if (got) b.addEventListener('click', function () { $('drawerMask').hidden = true; openItemPostcard(item.id); });
        grid.appendChild(b);
      });
      g.appendChild(grid);
      body.appendChild(g);
    });
  }

  /* ---------- 渲染 ---------- */
  function skin() {
    var cs = getComputedStyle(document.body);
    return {
      ground: cs.getPropertyValue('--ground').trim(), ground2: cs.getPropertyValue('--ground2').trim(),
      wall: cs.getPropertyValue('--wall').trim(), wallTop: cs.getPropertyValue('--wall-top').trim(),
      moat: cs.getPropertyValue('--moat').trim(), moat2: cs.getPropertyValue('--moat2').trim(),
      road: cs.getPropertyValue('--road').trim(), tree: cs.getPropertyValue('--tree').trim(),
      lamp: cs.getPropertyValue('--lamp').trim(), ink: cs.getPropertyValue('--ink').trim(),
      card: cs.getPropertyValue('--card').trim(), accent2: cs.getPropertyValue('--accent2').trim()
    };
  }
  function drawPoly(path, close) {
    ctx.beginPath();
    path.forEach(function (p, i) { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    if (close) ctx.closePath();
  }
  function draw(now) {
    var S = skin();
    ctx.fillStyle = S.ground;
    ctx.fillRect(0, 0, CW, CH);
    // 地面棋盘格
    ctx.fillStyle = S.ground2;
    var gs = 80;
    var x0 = Math.floor((cam.cx - CW / 2 / cam.scale) / gs), x1 = Math.ceil((cam.cx + CW / 2 / cam.scale) / gs);
    var y0 = Math.floor((cam.cy - CH / 2 / cam.scale) / gs), y1 = Math.ceil((cam.cy + CH / 2 / cam.scale) / gs);
    for (var gy = y0; gy <= y1; gy++) for (var gx = x0; gx <= x1; gx++) {
      if ((gx + gy) % 2 === 0) {
        var p = w2s(gx * gs, gy * gs);
        ctx.fillRect(p.x, p.y, gs * cam.scale, gs * cam.scale);
      }
    }
    // 主干道
    ctx.strokeStyle = S.road; ctx.lineCap = 'round';
    ctx.lineWidth = 34 * cam.scale;
    ctx.beginPath();
    var a = w2s(0, 610), b = w2s(1600, 610);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    a = w2s(700, 0); b = w2s(700, 1200);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // 护城河（外圈环形：外圈多边形减去城墙多边形，一次 evenodd 填充）
    ctx.beginPath();
    MOAT_POLY.forEach(function (p, i) { var q = w2s(p[0], p[1]); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    ctx.closePath();
    WALL_POLY.forEach(function (p, i) { var q = w2s(p[0], p[1]); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = S.moat;
    ctx.fill('evenodd');
    // 水波纹
    ctx.strokeStyle = S.moat2; ctx.lineWidth = Math.max(2, 3 * cam.scale);
    ctx.setLineDash([14 * cam.scale, 18 * cam.scale]);
    ctx.lineDashOffset = -(now / 40) % 32;
    drawPoly(MOAT_POLY.map(function (p) { var q = w2s(p[0], p[1]); return [q.x, q.y]; }), true);
    ctx.stroke();
    ctx.setLineDash([]);
    // 城墙
    ctx.strokeStyle = S.wall; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = 34 * cam.scale;
    drawPoly(WALL_POLY.map(function (p) { var q = w2s(p[0], p[1]); return [q.x, q.y]; }), true);
    ctx.stroke();
    ctx.strokeStyle = S.wallTop; ctx.lineWidth = 20 * cam.scale;
    ctx.stroke();
    // 城垛
    ctx.fillStyle = S.wallTop;
    for (var i = 0; i < WALL_POLY.length; i++) {
      var p1 = WALL_POLY[i], p2 = WALL_POLY[(i + 1) % WALL_POLY.length];
      var len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var n = Math.floor(len / 26);
      for (var k = 1; k < n; k++) {
        var t = k / n;
        var q = w2s(p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t);
        var s = 7 * cam.scale;
        ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      }
    }
    // 树木
    TREES.forEach(function (tr) {
      var q = w2s(tr.x, tr.y);
      if (q.x < -30 || q.y < -30 || q.x > CW + 30 || q.y > CH + 30) return;
      var s = 16 * cam.scale;
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(q.x - 2 * cam.scale, q.y, 4 * cam.scale, 8 * cam.scale);
      ctx.fillStyle = S.tree;
      ctx.fillRect(q.x - s / 2, q.y - s, s, s * 0.9);
      ctx.fillRect(q.x - s / 3, q.y - s * 1.35, s * 0.66, s * 0.5);
    });
    // 路灯
    LAMPS.forEach(function (lp) {
      var q = w2s(lp.x, lp.y);
      if (q.x < -20 || q.y < -20 || q.x > CW + 20 || q.y > CH + 20) return;
      ctx.fillStyle = S.lamp;
      ctx.beginPath(); ctx.arc(q.x, q.y, 4 * cam.scale, 0, Math.PI * 2); ctx.fill();
      if (document.body.dataset.skin !== 'classic') {
        ctx.fillStyle = S.lamp; ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(q.x, q.y, 12 * cam.scale, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    });
    // 地标
    DATA.landmarks.forEach(function (lm) {
      var q = w2s(lm.x, lm.y);
      if (q.x < -60 || q.y < -60 || q.x > CW + 60 || q.y > CH + 60) return;
      var hl = !!state.highlighted[lm.id];
      var s = 34 * cam.scale;
      if (hl) {
        var pulse = 0.55 + 0.45 * Math.sin(now / 300);
        ctx.strokeStyle = 'rgba(242,193,78,' + pulse + ')';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(q.x, q.y - 10 * cam.scale, 30 * cam.scale, 0, Math.PI * 2); ctx.stroke();
      }
      // 城楼
      ctx.fillStyle = S.wall;
      ctx.fillRect(q.x - s / 2, q.y - s * 0.55, s, s * 0.55);
      ctx.fillStyle = S.accent2;
      ctx.beginPath();
      ctx.moveTo(q.x - s * 0.65, q.y - s * 0.55);
      ctx.lineTo(q.x, q.y - s * 1.05);
      ctx.lineTo(q.x + s * 0.65, q.y - s * 0.55);
      ctx.closePath(); ctx.fill();
      ctx.font = Math.max(14, 20 * cam.scale) + 'px serif';
      ctx.textAlign = 'center';
      ctx.fillText(lm.emoji, q.x, q.y - s * 1.15);
      ctx.font = 'bold ' + Math.max(10, 11 * cam.scale) + 'px sans-serif';
      ctx.fillStyle = S.ink;
      ctx.fillText(lm.name, q.x, q.y + s * 0.75);
      if (hl) {
        ctx.font = 'bold ' + Math.max(11, 12 * cam.scale) + 'px sans-serif';
        var label = '点击探索';
        var tw = ctx.measureText(label).width + 16;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.beginPath();
        ctx.roundRect(q.x - tw / 2, q.y - s * 1.95, tw, 20 * cam.scale + 6, 8);
        ctx.fill();
        ctx.fillStyle = '#ffe9a8';
        ctx.fillText(label, q.x, q.y - s * 1.95 + 14 * cam.scale + 2);
      }
    });
    // 游走的猫
    cats.forEach(function (c) {
      var q = w2s(c.x, c.y);
      if (q.x < -30 || q.y < -30 || q.x > CW + 30 || q.y > CH + 30) return;
      ctx.font = Math.max(14, 18 * cam.scale) + 'px serif';
      ctx.textAlign = 'center';
      ctx.fillText('🐱', q.x, q.y);
    });
    // 主角小人
    var pq = w2s(player.x, player.y);
    var bob = player.moving ? Math.sin(now / 130) * 2 * cam.scale : 0;
    var ps = 15 * cam.scale;
    ctx.fillStyle = '#2f6fb2';
    ctx.fillRect(pq.x - ps * 0.45, pq.y - ps * 0.5 + bob, ps * 0.9, ps * 0.75);
    ctx.fillStyle = '#f2c14e';
    ctx.beginPath(); ctx.arc(pq.x, pq.y - ps * 0.75 + bob, ps * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(pq.x - ps * 0.5, pq.y - ps * 1.15 + bob, ps, ps * 0.22);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(pq.x, pq.y + ps * 0.35, ps * 0.55, ps * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    // GPS 模式：真实位置圈
    if (state.mode === 'real' && gps.pos) {
      var gp = w2s(gps.pos.x, gps.pos.y);
      ctx.strokeStyle = 'rgba(242,193,78,0.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gp.x, gp.y, 10 * cam.scale, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ---------- 主循环 ---------- */
  var lastT = 0;
  function loop(t) {
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    // 方向键移动
    if (dpadDir && state.mode === 'cloud') {
      var sp = 150 * dt;
      var nx = player.x, ny = player.y;
      if (dpadDir === 'up') ny -= sp;
      if (dpadDir === 'down') ny += sp;
      if (dpadDir === 'left') nx -= sp;
      if (dpadDir === 'right') nx += sp;
      if (!isBlocked(nx, ny)) { player.x = nx; player.y = ny; player.moving = true; player.path = []; }
    }
    // 沿路径移动
    if (player.path.length) {
      var target = player.path[0];
      var dx = target.x - player.x, dy = target.y - player.y;
      var d = Math.hypot(dx, dy);
      var step = 150 * dt;
      if (d <= step) { player.x = target.x; player.y = target.y; player.path.shift(); }
      else { player.x += dx / d * step; player.y += dy / d * step; }
      player.moving = true;
      player.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (!player.path.length) player.moving = false;
    } else if (!dpadDir) player.moving = false;
    // 猫游走
    cats.forEach(function (c) {
      if (!c.target || Math.hypot(c.target.x - c.x, c.target.y - c.y) < 6) {
        c.target = { x: c.homeX + (Math.random() - 0.5) * 220, y: c.homeY + (Math.random() - 0.5) * 160 };
      }
      var dx = c.target.x - c.x, dy = c.target.y - c.y, d = Math.hypot(dx, dy);
      if (d > 0.5) { c.x += dx / d * 22 * dt; c.y += dy / d * 22 * dt; }
    });
    updateHighlights();
    // 相机跟随（仅当小人走出视野中心区域时轻跟）
    draw(t);
    requestAnimationFrame(loop);
  }
  function updateHighlights() {
    var changed = false;
    DATA.landmarks.forEach(function (lm) {
      var on = false;
      if (state.mode === 'cloud') on = Math.hypot(player.x - lm.x, player.y - lm.y) < PROX_CLOUD;
      else if (gps.pos) on = haversine(gps.pos.lat, gps.pos.lng, lm.lat, lm.lng) < PROX_REAL_M;
      if (!!state.highlighted[lm.id] !== on) { state.highlighted[lm.id] = on; changed = true; }
    });
    if (changed) {
      var names = DATA.landmarks.filter(function (lm) { return state.highlighted[lm.id]; }).map(function (lm) { return lm.name; });
      if (names.length) $('locText').textContent = '✨ ' + names.join('、') + ' 可以探索了，点它！';
      else $('locText').textContent = state.mode === 'cloud' ? '云逛模式 · 走到地标旁点亮高光' : '实景模式 · 走近地标 100 米内点亮金色高光';
    }
  }

  /* ---------- 输入 ---------- */
  function bindInput() {
    var pointers = new Map();
    var downPos = null, downTime = 0, moved = 0;
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { downPos = { x: e.clientX, y: e.clientY }; downTime = Date.now(); moved = 0; }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      var prev = pointers.get(e.pointerId);
      if (pointers.size === 1) {
        var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        moved += Math.abs(dx) + Math.abs(dy);
        cam.cx -= dx / cam.scale; cam.cy -= dy / cam.scale;
        clampCam();
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var oldDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        pts = Array.from(pointers.values());
        var newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (oldDist > 0) {
          var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          zoomAt(mid.x, mid.y, newDist / oldDist);
        }
        moved += 20;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && downPos && moved < 10 && Date.now() - downTime < 400) {
        handleTap(e.clientX, e.clientY);
      }
      downPos = null;
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
  }
  function clampCam() {
    cam.cx = Math.max(-200, Math.min(WORLD.w + 200, cam.cx));
    cam.cy = Math.max(-200, Math.min(WORLD.h + 200, cam.cy));
  }
  function zoomAt(sx, sy, factor) {
    var before = s2w(sx, sy);
    cam.scale = Math.max(0.45, Math.min(2.4, cam.scale * factor));
    var after = s2w(sx, sy);
    cam.cx += before.x - after.x;
    cam.cy += before.y - after.y;
    clampCam();
  }
  function handleTap(sx, sy) {
    var rect = canvas.getBoundingClientRect();
    var wx = sx - rect.left, wy = sy - rect.top;
    var w = s2w(wx, wy);
    // 先点猫
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i], q = w2s(c.x, c.y);
      if (Math.hypot(wx - q.x, wy - q.y) < 26) { tapCat(); return; }
    }
    // 再点地标
    for (var j = 0; j < DATA.landmarks.length; j++) {
      var lm = DATA.landmarks[j], q2 = w2s(lm.x, lm.y);
      if (Math.hypot(wx - q2.x, wy - q2.y) < 46) {
        if (state.highlighted[lm.id]) { triggerDrop(lm); return; }
        toast('先走到「' + lm.name + '」旁边，高亮亮起后再点它探索');
        moveTo(lm.x, lm.y);
        return;
      }
    }
    // 点地面：走过去
    if (state.mode === 'cloud') moveTo(w.x, w.y);
  }
  function tapCat() {
    if (!CATS) return;
    if (Math.random() < 0.3) {
      var cat = CATS.cats[Math.floor(Math.random() * CATS.cats.length)];
      openCatPostcard(cat, null);
      toast('🐱 抓到一只流浪猫！它允许你摸一下头');
    } else {
      toast('🐱 猫猫跑开了… 下次手速快一点');
    }
  }

  /* ---------- GPS ---------- */
  function startGps() {
    if (!navigator.geolocation) { $('gpsLine').textContent = '此浏览器不支持定位'; return; }
    $('gpsLine').textContent = '定位中…';
    gps.watchId = navigator.geolocation.watchPosition(function (p) {
      gps.pos = gpsToWorld(p.coords.latitude, p.coords.longitude);
      gps.pos.lat = p.coords.latitude; gps.pos.lng = p.coords.longitude;
      gps.simulated = false;
      player.x = gps.pos.x; player.y = gps.pos.y; player.path = [];
      $('gpsLine').textContent = 'GPS · ' + p.coords.latitude.toFixed(4) + ', ' + p.coords.longitude.toFixed(4);
      cam.cx = player.x; cam.cy = player.y;
    }, function (err) {
      $('gpsLine').textContent = '定位失败：' + err.message + '，可用室内测试';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
  }
  function stopGps() {
    if (gps.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null;
  }

  /* ---------- 模式 / 皮肤 ---------- */
  function applySkin() {
    document.body.dataset.skin = state.skin;
    document.querySelectorAll('.skin-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.skin === state.skin); });
  }
  function applyMode() {
    document.body.dataset.mode = state.mode;
    document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === state.mode); });
    $('dpad').style.display = state.mode === 'cloud' ? 'grid' : 'none';
    $('debugBtn').hidden = state.mode !== 'real';
    $('gpsLine').hidden = state.mode !== 'real';
    $('mapHint').textContent = state.mode === 'cloud'
      ? '拖动地图 · 双指缩放 · 点地面让小人走过去'
      : '实景模式 · 小人跟随你的真实位置移动';
    $('locText').textContent = state.mode === 'cloud' ? '云逛模式 · 走到地标旁点亮高光' : '实景模式 · 走近地标 100 米内点亮金色高光';
    if (state.mode === 'real') startGps(); else stopGps();
  }

  /* ---------- 启动 ---------- */
  function resize() {
    var r = wrap.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    CW = r.width; CH = r.height;
    canvas.width = Math.round(CW * DPR);
    canvas.height = Math.round(CH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function seedDecor() {
    var rand = mulberry32(20261122);
    TREES = [];
    var tries = 0;
    while (TREES.length < 34 && tries < 400) {
      tries++;
      var x = rand() * WORLD.w, y = rand() * WORLD.h;
      if (pointInPoly(x, y, MOAT_POLY)) continue;
      if (Math.abs(y - 610) < 40 || Math.abs(x - 700) < 40) continue;
      if (DATA.landmarks.some(function (lm) { return Math.hypot(x - lm.x, y - lm.y) < 70; })) continue;
      TREES.push({ x: x, y: y });
    }
    LAMPS = [];
    [[400, 610], [1000, 610], [700, 400], [700, 850], [300, 950], [1200, 950], [900, 300], [500, 300]].forEach(function (p) {
      LAMPS.push({ x: p[0], y: p[1] });
    });
    // 游走的猫
    cats = [];
    var spots = [[700, 1080], [500, 700], [1100, 500]];
    spots.forEach(function (s) {
      cats.push({ x: s[0], y: s[1], homeX: s[0], homeY: s[1], target: null });
    });
  }
  function init(data, catsData) {
    DATA = data; CATS = catsData;
    canvas = $('map'); ctx = canvas.getContext('2d'); wrap = $('mapWrap');
    // 城墙多边形：按环形顺序取各地标坐标（咖啡馆在墙外，不计入）
    var order = ['anyuanmen', 'jiefangmen', 'chaoyangmen', 'changlemen', 'jianguomen', 'wenchangmen', 'yongningmen', 'zhuquemen', 'hanguangmen', 'andingmen', 'yuxiangmen'];
    WALL_POLY = order.map(function (id) {
      var lm = DATA.landmarks.find(function (l) { return l.id === id; });
      return [lm.x, lm.y];
    });
    MOAT_POLY = WALL_POLY.map(function (p) {
      return [MOAT_CX + (p[0] - MOAT_CX) * MOAT_K, MOAT_CY + (p[1] - MOAT_CY) * MOAT_K];
    });
    loadState();
    applySkin(); applyMode();
    buildGrid();
    seedDecor();
    renderProgress(); renderDrawer();
    resize();
    window.addEventListener('resize', resize);
    bindInput();
    // D-pad
    document.querySelectorAll('.dpad-btn').forEach(function (b) {
      var on = function (e) { e.preventDefault(); dpadDir = b.dataset.dir; b.classList.add('held'); };
      var off = function () { if (dpadDir === b.dataset.dir) dpadDir = null; b.classList.remove('held'); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
    });
    // 缩放按钮
    $('zoomIn').addEventListener('click', function () { zoomAt(CW / 2, CH / 2, 1.3); });
    $('zoomOut').addEventListener('click', function () { zoomAt(CW / 2, CH / 2, 1 / 1.3); });
    $('recenter').addEventListener('click', function () { cam.cx = player.x; cam.cy = player.y; clampCam(); });
    // 皮肤 / 模式
    document.querySelectorAll('.skin-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.skin = b.dataset.skin; saveState(); applySkin(); toast('已切换「' + b.textContent.trim() + '」'); });
    });
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.mode = b.dataset.mode; saveState(); applyMode(); });
    });
    // 实景调试：瞬移到朝阳门
    $('debugBtn').addEventListener('click', function () {
      var lm = DATA.landmarks.find(function (l) { return l.id === 'chaoyangmen'; });
      gps.pos = { x: lm.x, y: lm.y, lat: lm.lat, lng: lm.lng };
      gps.simulated = true;
      player.x = lm.x; player.y = lm.y; player.path = [];
      cam.cx = player.x; cam.cy = player.y;
      $('gpsLine').textContent = '室内测试 · 已模拟到朝阳门';
      toast('已模拟瞬移到朝阳门，看看它亮起金色高光了没');
    });
    // 弹窗
    $('burstCore').addEventListener('click', hideBurst);
    $('cardClose').addEventListener('click', function () { $('cardMask').hidden = true; });
    $('cardPostcardBtn').addEventListener('click', function () {
      $('cardMask').hidden = true;
      if (state.currentItem) openItemPostcard(state.currentItem);
    });
    $('postcardClose').addEventListener('click', function () { $('postcardMask').hidden = true; });
    $('pcSaveBtn').addEventListener('click', function () {
      var note = $('pcNote').value.trim();
      if (state.currentItem && state.collection[state.currentItem]) {
        state.collection[state.currentItem].note = note; saveState(); renderDrawer();
      } else if (state.currentCat && state.catCollection[state.currentCat]) {
        state.catCollection[state.currentCat].note = note; saveCats();
      }
      toast('笔记已保存到这张明信片上 💾');
    });
    $('dexOpenBtn').addEventListener('click', function () { renderDrawer(); $('drawerMask').hidden = false; });
    $('drawerClose').addEventListener('click', function () { $('drawerMask').hidden = true; });
    $('drawerMask').addEventListener('click', function (e) { if (e.target === $('drawerMask')) $('drawerMask').hidden = true; });
    // 初始镜头对准主角
    cam.cx = player.x; cam.cy = player.y - 60;
    requestAnimationFrame(loop);
  }

  Promise.all([
    fetch('items.json').then(function (r) { if (!r.ok) throw new Error('items.json HTTP ' + r.status); return r.json(); }),
    fetch('cats.json').then(function (r) { if (!r.ok) throw new Error('cats.json HTTP ' + r.status); return r.json(); }).catch(function () { return null; })
  ]).then(function (res) { init(res[0], res[1]); })
  .catch(function (err) {
    document.getElementById('mapHint').textContent = '数据加载失败：' + err.message + '，请用 HTTP 服务打开本站。';
    console.error('[xian-wall-world] 数据加载失败', err);
  });

  // 供无头自测调用
  window.__xwcc = {
    get state() { return state; },
    get DATA() { return DATA; },
    rollTier: rollTier,
    findPath: findPath,
    gpsToWorld: gpsToWorld,
    isBlocked: isBlocked,
    moveTo: moveTo,
    triggerDrop: triggerDrop,
    updateHighlights: updateHighlights,
    get player() { return player; },
    get cam() { return cam; }
  };
})();
