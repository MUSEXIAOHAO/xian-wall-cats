/* 3D 像素西安城墙夜游世界 V3 · Three.js 体素世界 */
(function () {
  'use strict';
  var LS_KEY = 'xian-wall-world-v2';   // 沿用 V2 存档（36 件风物）
  var LS_CAT_KEY = 'xian-wall-cats-v1';
  var CELL = 20, GRID_W = 80, GRID_H = 60;
  var S = 0.06;                        // 世界坐标 -> Three.js 坐标缩放
  var PROX_CLOUD = 70, PROX_REAL_M = 100;

  var DATA = null, CATS = null;
  var state = {
    skin: 'classic', mode: 'cloud', view: 'third',
    collection: {}, catCollection: {}, highlighted: {},
    pendingLandmark: null, currentItem: null, currentCat: null
  };

  /* ---------- 工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;
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
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
  function gpsToWorld(lat, lng) {
    var g = DATA.meta.gpsToWorld;
    return { x: g.xRef + (lng - g.lngRef) * g.xPerLng, y: g.yRef - (lat - g.latRef) * g.yPerLat };
  }

  /* ---------- 世界（沿用 V2 坐标系） ---------- */
  var WALL_POLY = [], MOAT_POLY = [], MOAT_CX = 790, MOAT_CY = 600, MOAT_K = 1.07;
  var blocked = [];
  function nearGate(x, y, r) {
    return DATA.landmarks.some(function (lm) { return Math.hypot(x - lm.x, y - lm.y) < r; });
  }
  function isBlocked(x, y) {
    if (x < 0 || y < 0 || x >= 1600 || y >= 1200) return true;
    for (var i = 0; i < WALL_POLY.length; i++) {
      var a = WALL_POLY[i], b = WALL_POLY[(i + 1) % WALL_POLY.length];
      if (distPtSeg(x, y, a[0], a[1], b[0], b[1]) < 26) return !nearGate(x, y, 46);
    }
    if (pointInPoly(x, y, MOAT_POLY) && !pointInPoly(x, y, WALL_POLY)) return !nearGate(x, y, 52);
    return false;
  }
  function buildGrid() {
    blocked = [];
    for (var gy = 0; gy < GRID_H; gy++) {
      blocked.push([]);
      for (var gx = 0; gx < GRID_W; gx++) blocked[gy][gx] = isBlocked(gx * CELL + CELL / 2, gy * CELL + CELL / 2);
    }
  }
  function cellBlocked(x, y) {
    var gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return true;
    return blocked[gy][gx];
  }
  function to3(x, y) { return { x: (x - 800) * S, z: (y - 600) * S }; }

  /* ---------- 像素纹理 ---------- */
  function pxCanvas(w, h, fn) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    fn(c.getContext('2d'), w, h);
    return c;
  }
  function makeTex(canvas, repeat) {
    var t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    else { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
    return t;
  }
  var TEX = {};
  function buildTextures() {
    var rand = mulberry32(20261122);
    TEX.brick = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#8a8378'; g.fillRect(0, 0, 32, 32);
      for (var row = 0; row < 4; row++) {
        for (var col = 0; col < 4; col++) {
          var sh = 118 + Math.floor(rand() * 30);
          g.fillStyle = 'rgb(' + sh + ',' + (sh - 6) + ',' + (sh - 18) + ')';
          g.fillRect(col * 8 + (row % 2 ? 4 : 0) - (row % 2 && col === 3 ? 8 : 0), row * 8, 7, 7);
        }
      }
      g.fillStyle = 'rgba(60,52,44,0.85)';
      for (var y = 0; y < 4; y++) g.fillRect(0, y * 8 + 7, 32, 1);
    }), true);
    TEX.stone = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#7d7468'; g.fillRect(0, 0, 32, 32);
      for (var i = 0; i < 16; i++) {
        var sh = 130 + Math.floor(rand() * 40);
        g.fillStyle = 'rgb(' + sh + ',' + (sh - 4) + ',' + (sh - 12) + ')';
        g.fillRect(Math.floor(rand() * 4) * 8, Math.floor(rand() * 4) * 8, 7, 7);
      }
      g.fillStyle = 'rgba(50,44,38,0.9)';
      g.fillRect(0, 15, 32, 1); g.fillRect(15, 0, 1, 32);
    }), true);
    TEX.grass = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#5d8a48'; g.fillRect(0, 0, 32, 32);
      for (var i = 0; i < 90; i++) {
        var v = rand();
        g.fillStyle = v < 0.5 ? '#4c7a3c' : (v < 0.85 ? '#6b9a52' : '#7fae62');
        g.fillRect(Math.floor(rand() * 32), Math.floor(rand() * 32), 2, 2);
      }
      g.fillStyle = '#e8d44d';
      for (var f = 0; f < 4; f++) g.fillRect(Math.floor(rand() * 30) + 1, Math.floor(rand() * 30) + 1, 2, 2);
      g.fillStyle = '#f2f2f2';
      g.fillRect(Math.floor(rand() * 30) + 1, Math.floor(rand() * 30) + 1, 2, 2);
    }), true);
    TEX.water = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#2a6b9c'; g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#4a97c4';
      for (var y = 0; y < 4; y++) for (var x = 0; x < 3; x++) g.fillRect(x * 12 + (y % 2) * 6, y * 8 + 3, 7, 2);
      g.fillStyle = '#7fb8d8';
      for (var y2 = 0; y2 < 4; y2++) g.fillRect(((y2 * 9) % 28), y2 * 8 + 6, 4, 1);
    }), true);
    TEX.lantern = makeTex(pxCanvas(16, 16, function (g) {
      g.fillStyle = '#c0392b'; g.fillRect(0, 0, 16, 16);
      g.fillStyle = '#e74c3c'; g.fillRect(2, 3, 12, 10);
      g.fillStyle = '#ffd97a'; g.fillRect(5, 5, 6, 6);
      g.fillStyle = '#f2c14e'; g.fillRect(0, 0, 16, 2); g.fillRect(0, 14, 16, 2);
    }), false);
    TEX.wood = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#8a5a30'; g.fillRect(0, 0, 32, 32);
      for (var x = 0; x < 4; x++) {
        g.fillStyle = x % 2 ? '#7a4e28' : '#96683a';
        g.fillRect(x * 8, 0, 7, 32);
        g.fillStyle = 'rgba(60,35,15,0.7)';
        g.fillRect(x * 8 + 7, 0, 1, 32);
      }
      g.fillStyle = 'rgba(60,35,15,0.5)';
      g.fillRect(3, 10, 2, 12); g.fillRect(19, 4, 2, 10);
    }), true);
    TEX.glass = makeTex(pxCanvas(16, 16, function (g) {
      g.fillStyle = '#1d3a55'; g.fillRect(0, 0, 16, 16);
      g.fillStyle = '#ffd97a'; g.fillRect(0, 11, 16, 5);
      g.fillStyle = '#9fd4ff';
      g.fillRect(3, 0, 2, 10); g.fillRect(8, 0, 2, 10);
      g.fillStyle = '#2f5a80'; g.fillRect(0, 7, 16, 1);
    }), false);
    TEX.redwall = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#a83226'; g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#8e2818';
      for (var y = 0; y < 8; y++) g.fillRect(0, y * 4 + 3, 32, 1);
      g.fillStyle = '#d4a017'; g.fillRect(0, 0, 32, 3);
      g.fillStyle = '#c0392b';
      for (var x = 0; x < 4; x++) g.fillRect(x * 8 + 2, 8, 4, 4);
    }), true);
    TEX.goldroof = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#d4a017'; g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#a87e10';
      for (var y = 0; y < 4; y++) g.fillRect(0, y * 8 + 6, 32, 2);
      g.fillStyle = '#f2c14e';
      for (var x = 0; x < 4; x++) g.fillRect(x * 8 + 2, 0, 2, 32);
    }), true);
    TEX.star = makeTex(pxCanvas(32, 32, function (g) {
      g.clearRect(0, 0, 32, 32);
      g.fillStyle = '#ffd94a';
      g.beginPath();
      var cx = 16, cy = 17;
      for (var i = 0; i < 10; i++) {
        var r = i % 2 ? 6 : 14, a = -Math.PI / 2 + i * Math.PI / 5;
        var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
      g.fillStyle = '#fff3b0'; g.fillRect(13, 10, 4, 4);
    }), false);
    TEX.clock = makeTex(pxCanvas(32, 32, function (g) {
      g.fillStyle = '#f8f2dd'; g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#2b2b2b';
      for (var i = 0; i < 12; i++) {
        var a = i * Math.PI / 6;
        g.fillRect(16 + Math.cos(a) * 12 - 1, 16 + Math.sin(a) * 12 - 1, 2, 2);
      }
      g.fillRect(15, 8, 2, 9);
      g.fillRect(16, 16, 8, 2);
      g.fillStyle = '#c0392b'; g.fillRect(15, 15, 2, 2);
    }), false);
  }

  /* ---------- 3D 场景 ---------- */
  var scene, camera, renderer, clock;
  var player, playerGroup;
  var yaw = Math.PI, pitch = 0;
  var joy = { x: 0, y: 0 };
  var camDrag = null;
  var raycaster;
  var markers = {};        // landmarkId -> { mesh, baseY }
  var landmarkHit = [];    // 可点中的地标包围盒
  var catMeshes = [];
  var cats = [];
  var waterTex, neonMats = [], lanternMats = [], prayerWheel = null;
  var moonLight, lampLights = [];
  var gps = { pos: null, simulated: false, watchId: null };

  var SKINS = {
    classic: { sky: 0x1b2740, fog: 0x1b2740, fogDensity: 0.011, moon: 0xffd9a0, lamp: 0xffb347, neon: 0xff6b9d, label: '古风夜游' },
    night:   { sky: 0x0a1024, fog: 0x0a1024, fogDensity: 0.015, moon: 0xbdd8ff, lamp: 0xcfe6ff, neon: 0x7fb2ff, label: '现代夜色' },
    cyber:   { sky: 0x180a33, fog: 0x180a33, fogDensity: 0.013, moon: 0xff9de2, lamp: 0x00f0ff, neon: 0xff2e88, label: '赛博霓虹' }
  };

  function mat(tex, opts) {
    var o = { map: tex };
    if (opts) for (var k in opts) o[k] = opts[k];
    return new THREE.MeshLambertMaterial(o);
  }
  function box(w, h, d, material, x, y, z, ry) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    return m;
  }
  function addTo(parent, mesh) { parent.add(mesh); return mesh; }

  function buildWorld() {
    buildTextures();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(SKINS[state.skin].sky);
    scene.fog = new THREE.FogExp2(SKINS[state.skin].fog, SKINS[state.skin].fogDensity);
    camera = new THREE.PerspectiveCamera(62, 1, 0.1, 500);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    $('sceneBox').appendChild(renderer.domElement);
    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    moonLight = new THREE.DirectionalLight(SKINS[state.skin].moon, 0.75);
    moonLight.position.set(30, 45, 20);
    scene.add(moonLight);

    var groundMat = mat(TEX.grass);
    TEX.grass.repeat.set(26, 20);
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 170), groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 主干道（石板路）
    var roadMat = mat(TEX.stone);
    TEX.stone.repeat.set(30, 1);
    var roadEW = new THREE.Mesh(new THREE.PlaneGeometry(200, 2.2), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    var r1 = to3(800, 610); roadEW.position.set(0, 0.02, r1.z);
    scene.add(roadEW);
    var roadNS = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 160), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    var r2 = to3(700, 600); roadNS.position.set(r2.x, 0.02, 0);
    scene.add(roadNS);

    // 护城河：外圈减城墙圈的环形
    var shape = new THREE.Shape();
    MOAT_POLY.forEach(function (p, i) {
      var q = to3(p[0], p[1]);
      if (i === 0) shape.moveTo(q.x, -q.z); else shape.lineTo(q.x, -q.z);
    });
    shape.closePath();
    var hole = new THREE.Path();
    WALL_POLY.forEach(function (p, i) {
      var q = to3(p[0], p[1]);
      if (i === 0) hole.moveTo(q.x, -q.z); else hole.lineTo(q.x, -q.z);
    });
    hole.closePath();
    shape.holes.push(hole);
    waterTex = TEX.water;
    TEX.water.repeat.set(18, 14);
    var moat = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ map: waterTex, transparent: true, opacity: 0.94 }));
    moat.rotation.x = -Math.PI / 2;
    moat.position.y = -0.12;
    scene.add(moat);

    buildWall();
    buildDecor();
    buildLandmarks();
    buildPlayer();
    buildCats();
    applySkin3D();
    resize();
  }

  function instanced(geo, material, transforms) {
    // 批量实例化：把大量重复体素压成一次绘制调用（手机帧率关键）
    var im = new THREE.InstancedMesh(geo, material, transforms.length);
    var m = new THREE.Matrix4();
    var q = new THREE.Quaternion();
    var pos = new THREE.Vector3();
    var sc = new THREE.Vector3(1, 1, 1);
    transforms.forEach(function (t, i) {
      q.setFromEuler(new THREE.Euler(0, t.ry || 0, 0));
      pos.set(t.x, t.y, t.z);
      sc.set(t.sx || 1, t.sy || 1, t.sz || 1);
      m.compose(pos, q, sc);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    return im;
  }

  function buildWall() {
    var wallMat = mat(TEX.brick);
    var topMat = new THREE.MeshLambertMaterial({ color: 0xc9c2b8 });
    var segs = [], tops = [];
    for (var e = 0; e < WALL_POLY.length; e++) {
      var a = WALL_POLY[e], b = WALL_POLY[(e + 1) % WALL_POLY.length];
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var angle = Math.atan2(-(b[1] - a[1]) * S, (b[0] - a[0]) * S);
      var n = Math.floor(len / 4);
      for (var k = 0; k < n; k++) {
        var t = (k + 0.5) / n;
        var wx = a[0] + (b[0] - a[0]) * t, wy = a[1] + (b[1] - a[1]) * t;
        if (nearGate(wx, wy, 7)) continue; // 城门洞留空
        var p = to3(wx, wy);
        segs.push({ x: p.x, y: 1.1, z: p.z, ry: angle });
        if (k % 2 === 0) tops.push({ x: p.x, y: 2.36, z: p.z, ry: angle });
      }
    }
    scene.add(instanced(new THREE.BoxGeometry(4 * S + 0.02, 2.2, 1.05), wallMat, segs));
    scene.add(instanced(new THREE.BoxGeometry(0.28, 0.32, 1.05), topMat, tops));
  }

  function gateArch(gate, opts) {
    // 在城门处搭真正能穿过去的拱形门洞 + 城楼（返回相对坐标的组，由调用方定位）
    opts = opts || {};
    var edge = nearestEdge(gate);
    var dir = edge.dir; // 墙沿方向（世界单位向量）
    var g = new THREE.Group();
    g.rotation.y = Math.atan2(-dir.y * S, dir.x * S);
    var stoneMat = mat(TEX.stone);
    var wallMat = mat(TEX.brick);
    var roofMat = mat(opts.roofTex || TEX.goldroof);
    // 两根门柱（洞口宽约 10 世界单位）
    [-1, 1].forEach(function (s) {
      g.add(box(0.14, 2.6, 1.1, stoneMat, s * 0.36, 1.3, 0));
    });
    // 门楣
    g.add(box(0.86, 0.8, 1.1, wallMat, 0, 3.0, 0));
    // 城楼
    var towerH = opts.big ? 3.6 : 2.8;
    g.add(box(0.95, towerH, 0.62, wallMat, 0, 3.4 + towerH / 2, 0));
    // 飞檐金顶（四棱锥）
    var roof = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.5, 4), roofMat);
    roof.position.set(0, 3.4 + towerH + 0.75, 0);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    // 红灯笼
    var lampMat = new THREE.MeshBasicMaterial({ map: TEX.lantern });
    lanternMats.push(lampMat);
    [-1, 1].forEach(function (s) {
      var lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), lampMat);
      lamp.position.set(s * 0.42, 3.1, 0.36);
      g.add(lamp);
    });
    if (opts.big) {
      [-0.5, 0.5].forEach(function (s) {
        var lamp2 = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), lampMat);
        lamp2.position.set(s * 0.7, 2.6, 0.36);
        g.add(lamp2);
      });
    }
    return g;
  }
  function nearestEdge(gate) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < WALL_POLY.length; i++) {
      var a = WALL_POLY[i], b = WALL_POLY[(i + 1) % WALL_POLY.length];
      var d = distPtSeg(gate.x, gate.y, a[0], a[1], b[0], b[1]);
      if (d < bestD) {
        bestD = d;
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        best = { dir: { x: (b[0] - a[0]) / len, y: (b[1] - a[1]) / len } };
      }
    }
    return best;
  }

  function buildDecor() {
    var rand = mulberry32(20261122);
    var trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
    var leafMat = new THREE.MeshLambertMaterial({ color: 0x2f6b34 });
    var trunkT = [], leafT = [];
    var tries = 0, placed = 0;
    while (placed < 30 && tries < 300) {
      tries++;
      var x = rand() * 1600, y = rand() * 1200;
      if (pointInPoly(x, y, MOAT_POLY)) continue;
      if (Math.abs(y - 610) < 45 || Math.abs(x - 700) < 45) continue;
      if (DATA.landmarks.some(function (lm) { return Math.hypot(x - lm.x, y - lm.y) < 75; })) continue;
      var p = to3(x, y);
      trunkT.push({ x: p.x, y: 0.35, z: p.z });
      leafT.push({ x: p.x, y: 1.35, z: p.z });
      placed++;
    }
    scene.add(instanced(new THREE.CylinderGeometry(0.12, 0.16, 0.7, 6), trunkMat, trunkT));
    scene.add(instanced(new THREE.ConeGeometry(0.65, 1.5, 7), leafMat, leafT));
    // 路灯（灯柱 + 暖光球；其中 4 盏带真实点光源）
    var poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    var lampPositions = [[400, 610], [1000, 610], [700, 400], [700, 850], [300, 950], [1200, 950]];
    var litGates = ['yongningmen', 'chaoyangmen', 'anyuanmen', 'changlemen'];
    lampPositions.forEach(function (lp) {
      var p = to3(lp[0], lp[1]);
      var lamp = new THREE.Group();
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), poleMat);
      pole.position.y = 0.8; lamp.add(pole);
      var bulbMat = new THREE.MeshBasicMaterial({ map: TEX.lantern });
      lanternMats.push(bulbMat);
      var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), bulbMat);
      bulb.position.y = 1.7; lamp.add(bulb);
      lamp.position.set(p.x, 0, p.z);
      scene.add(lamp);
    });
    litGates.forEach(function (id) {
      var lm = DATA.landmarks.find(function (l) { return l.id === id; });
      var p = to3(lm.x, lm.y);
      var pl = new THREE.PointLight(SKINS[state.skin].lamp, 0.9, 16, 2);
      pl.position.set(p.x, 3.2, p.z);
      scene.add(pl);
      lampLights.push(pl);
    });
  }

  function buildLandmarks() {
    DATA.landmarks.forEach(function (lm) {
      var p = to3(lm.x, lm.y);
      var group = new THREE.Group();
      group.position.set(p.x, 0, p.z);
      var isGate = WALL_POLY.some(function (v) { return v[0] === lm.x && v[1] === lm.y; });
      if (isGate) {
        var big = lm.id === 'yongningmen';
        var roofTex = lm.id === 'changlemen' ? null : TEX.goldroof;
        var arch = gateArch(lm, { big: big, roofTex: roofTex });
        group.add(arch);
        // 差异化点缀
        if (lm.id === 'zhuquemen') {
          for (var i = -2; i <= 2; i++) {
            var lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ map: TEX.lantern }));
            lamp.position.set(i * 0.3, 2.9, 0.4);
            group.add(lamp);
          }
        }
        if (lm.id === 'hanguangmen') {
          group.add(box(0.5, 0.5, 0.5, new THREE.MeshLambertMaterial({ color: 0x7a5a38 }), 1.2, 0.25, 0.8));
        }
        if (lm.id === 'andingmen') {
          var glass = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.1), new THREE.MeshBasicMaterial({ map: TEX.glass }));
          glass.position.set(-1.1, 0.9, 0.7); glass.rotation.y = 0.4;
          group.add(glass);
        }
        if (lm.id === 'anyuanmen') {
          [-1, 1].forEach(function (s) {
            group.add(box(0.32, 0.42, 0.5, new THREE.MeshLambertMaterial({ color: 0x9a938a }), s * 0.9, 0.21, 1.0));
          });
        }
        if (lm.id === 'jiefangmen') {
          // 火车站站房 + 钟楼 + 绿皮车厢（在城内一侧）
          var station = new THREE.Group();
          station.add(box(3.2, 1.1, 1.0, mat(TEX.brick), 0, 0.55, 0));
          var tower = box(0.55, 2.2, 0.55, mat(TEX.brick), 0, 1.1, 0);
          station.add(tower);
          var clockFace = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), new THREE.MeshBasicMaterial({ map: TEX.clock }));
          clockFace.position.set(0, 1.9, 0.29);
          station.add(clockFace);
          station.position.set(0, 0, 2.2); // 城内一侧（南，+z）
          group.add(station);
          var railMat = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
          [-0.35, 0.35].forEach(function (off) {
            var rail = box(9, 0.06, 0.08, railMat, 0, 0.03, 3.4 + off);
            group.add(rail);
          });
          var carMat = new THREE.MeshLambertMaterial({ color: 0x2f6b34 });
          for (var c = 0; c < 3; c++) {
            var car = box(1.7, 0.75, 0.55, carMat, -3.2 + c * 1.9, 0.45, 3.4);
            group.add(car);
            group.add(box(1.7, 0.1, 0.6, new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }), -3.2 + c * 1.9, 0.86, 3.4));
          }
        }
        if (lm.id === 'wenchangmen') {
          group.add(box(0.3, 0.8, 0.12, new THREE.MeshLambertMaterial({ color: 0x4a4a4a }), 1.3, 0.4, 0.6));
        }
      } else if (lm.id === 'chaoyang-coffee') {
        // 街角咖啡馆：木屋 + 暖光橱窗 + 遮阳伞
        group.add(box(1.5, 1.0, 1.1, mat(TEX.wood), 0, 0.5, 0));
        var roof = new THREE.Mesh(new THREE.ConeGeometry(1.15, 0.6, 4), mat(TEX.goldroof));
        roof.position.y = 1.3; roof.rotation.y = Math.PI / 4;
        group.add(roof);
        var win = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshBasicMaterial({ map: TEX.glass }));
        win.position.set(0, 0.55, 0.56);
        group.add(win);
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
        pole.position.set(1.1, 0.45, 0.9); group.add(pole);
        var umb = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.35, 8), new THREE.MeshLambertMaterial({ color: 0xc0392b }));
        umb.position.set(1.1, 0.95, 0.9); group.add(umb);
      } else if (lm.id === 'yuxiangmen') {
        // 广仁寺：红墙金顶 + 转经筒
        group.add(box(2.2, 1.0, 0.3, mat(TEX.redwall), 0, 0.5, 0));
        var roof2 = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.8, 4), mat(TEX.goldroof));
        roof2.position.y = 1.4; roof2.rotation.y = Math.PI / 4;
        group.add(roof2);
        prayerWheel = new THREE.Group();
        var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.55, 8), mat(TEX.goldroof));
        prayerWheel.add(wheel);
        var axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 6), new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
        prayerWheel.add(axle);
        prayerWheel.position.set(1.5, 0.45, 0.6);
        group.add(prayerWheel);
      }
      // 旋转发光像素标记（高亮时可见）
      var marker = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.9),
        new THREE.MeshBasicMaterial({ map: TEX.star, transparent: true, side: THREE.DoubleSide })
      );
      marker.position.y = 5.6;
      marker.visible = false;
      group.add(marker);
      markers[lm.id] = { mesh: marker, baseY: 5.6 };
      // 隐形点选盒
      var hit = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 6, 2.4),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.position.y = 2.2;
      hit.userData.landmarkId = lm.id;
      group.add(hit);
      landmarkHit.push(hit);
      scene.add(group);
    });
    // 顺城巷小酒馆霓虹牌（建国门地标上的附加物）
    var jg = DATA.landmarks.find(function (l) { return l.id === 'jianguomen'; });
    var jp = to3(jg.x, jg.y);
    var neonMat = new THREE.MeshBasicMaterial({ color: SKINS[state.skin].neon });
    neonMats.push(neonMat);
    var sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), neonMat);
    sign.position.set(jp.x + 1.6, 1.6, jp.z + 0.8);
    sign.rotation.y = 0.5;
    scene.add(sign);
    var crateMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3a });
    for (var i = 0; i < 3; i++) scene.add(box(0.4, 0.4, 0.4, crateMat, jp.x - 1.2 + i * 0.45, 0.2, jp.z + 1.1));
  }

  function buildPlayer() {
    playerGroup = new THREE.Group();
    var skinMat = new THREE.MeshLambertMaterial({ color: 0xf2c9a0 });
    var blueMat = new THREE.MeshLambertMaterial({ color: 0x2f6fb2 });
    var darkMat = new THREE.MeshLambertMaterial({ color: 0x274b73 });
    var redMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    playerGroup.add(box(0.16, 0.32, 0.16, darkMat, -0.11, 0.16, 0));
    playerGroup.add(box(0.16, 0.32, 0.16, darkMat, 0.11, 0.16, 0));
    playerGroup.add(box(0.5, 0.55, 0.3, blueMat, 0, 0.6, 0));
    playerGroup.add(box(0.38, 0.36, 0.36, skinMat, 0, 1.05, 0));
    playerGroup.add(box(0.5, 0.14, 0.5, redMat, 0, 1.3, 0));
    // 影子
    var shadow = new THREE.Mesh(new THREE.CircleGeometry(0.32, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    playerGroup.add(shadow);
    scene.add(playerGroup);
    player = { x: 700, y: 1050, moving: false, bob: 0 };
    syncPlayerMesh();
  }
  function syncPlayerMesh() {
    var p = to3(player.x, player.y);
    playerGroup.position.set(p.x, 0, p.z);
  }
  function buildCats() {
    cats = [];
    catMeshes = [];
    var spots = [[700, 1080], [500, 700], [1100, 500]];
    var whiteMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    var darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    spots.forEach(function (s) {
      var g = new THREE.Group();
      g.add(box(0.5, 0.26, 0.26, whiteMat, 0, 0.2, 0));
      g.add(box(0.24, 0.24, 0.24, whiteMat, 0.32, 0.32, 0));
      g.add(box(0.08, 0.1, 0.05, darkMat, 0.26, 0.48, 0.06));
      g.add(box(0.08, 0.1, 0.05, darkMat, 0.38, 0.48, 0.06));
      var p = to3(s[0], s[1]);
      g.position.set(p.x, 0, p.z);
      g.userData.isCat = true;
      scene.add(g);
      catMeshes.push(g);
      cats.push({ x: s[0], y: s[1], homeX: s[0], homeY: s[1], target: null, mesh: g });
    });
  }

  /* ---------- 皮肤 / 光影 ---------- */
  function applySkin3D() {
    var sk = SKINS[state.skin];
    if (!scene) return;
    scene.background = new THREE.Color(sk.sky);
    scene.fog.color.set(sk.fog);
    scene.fog.density = sk.fogDensity;
    moonLight.color.set(sk.moon);
    lampLights.forEach(function (pl) { pl.color.set(sk.lamp); });
    neonMats.forEach(function (m) { m.color.set(sk.neon); });
  }
  function applySkin() {
    document.body.dataset.skin = state.skin;
    document.querySelectorAll('.skin-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.skin === state.skin); });
    applySkin3D();
  }

  /* ---------- 掉落（沿用 V2 规则） ---------- */
  function rollTier(mode) {
    var r = Math.random();
    if (mode === 'cloud') return r < 0.7 ? 3 : 2;
    return r < 0.55 ? 3 : (r < 0.85 ? 2 : 1);
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
      if (state.mode === 'cloud') toast('第 1 档传说风物仅限线下实景触发，今晚云逛只能遇见 3 / 2 档', 3600);
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

  /* ---------- 卡片 / 明信片 / 抽屉 ---------- */
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

  /* ---------- 高光 ---------- */
  function updateHighlights() {
    var changed = false;
    DATA.landmarks.forEach(function (lm) {
      var on = false;
      if (state.mode === 'cloud') on = Math.hypot(player.x - lm.x, player.y - lm.y) < PROX_CLOUD;
      else if (gps.pos) on = haversine(gps.pos.lat, gps.pos.lng, lm.lat, lm.lng) < PROX_REAL_M;
      if (!!state.highlighted[lm.id] !== on) { state.highlighted[lm.id] = on; changed = true; }
      if (markers[lm.id]) markers[lm.id].mesh.visible = on;
    });
    if (changed) {
      var near = DATA.landmarks.filter(function (lm) { return state.highlighted[lm.id]; });
      if (near.length) {
        near.sort(function (a, b) { return Math.hypot(player.x - a.x, player.y - a.y) - Math.hypot(player.x - b.x, player.y - b.y); });
        var lm0 = near[0];
        $('exploreBtn').hidden = false;
        $('exploreBtn').textContent = '🔍 探索：' + lm0.name;
        $('exploreBtn').dataset.landmark = lm0.id;
        $('locText').textContent = '✨ ' + near.map(function (l) { return l.name; }).join('、') + ' 可以探索了，点下面大按钮！';
      } else {
        $('exploreBtn').hidden = true;
        $('locText').textContent = state.mode === 'cloud' ? '云逛模式 · 走到地标旁点亮高光' : '实景模式 · 走近地标 100 米内点亮金色高光';
      }
    }
  }

  /* ---------- 相机 ---------- */
  function updateCamera() {
    var pp = to3(player.x, player.y);
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    if (state.view === 'third') {
      var dist = 9, h = 5.4 + pitch * 3;
      camera.position.set(pp.x - fx * dist, h, pp.z - fz * dist);
      camera.lookAt(pp.x + fx * 1.5, 1.4, pp.z + fz * 1.5);
    } else {
      var py = 1.55;
      camera.position.set(pp.x, py, pp.z);
      var cp = clamp(pitch, -0.9, 0.9);
      camera.lookAt(pp.x + fx * Math.cos(cp), py + Math.sin(cp), pp.z + fz * Math.cos(cp));
    }
  }

  /* ---------- 主循环 ---------- */
  var lastT = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    var now = t / 1000;
    // 摇杆移动
    if ((joy.x || joy.y) && state.mode === 'cloud') {
      var fx = Math.sin(yaw), fz = Math.cos(yaw);
      var rx = Math.cos(yaw), rz = -Math.sin(yaw);
      var mx = fx * (-joy.y) + rx * joy.x;
      var mz = fz * (-joy.y) + rz * joy.x;
      var step = 150 * dt; // 世界坐标速度：150 单位/秒
      var nx = player.x + mx * step;
      var ny = player.y + mz * step;
      if (!blockedAt(nx, ny)) {
        player.x = nx; player.y = ny; player.moving = true;
        playerGroup.rotation.y = Math.atan2(mx, mz);
      }
      syncPlayerMesh();
    } else if (player.moving) player.moving = false;
    // 走路起伏
    if (player.moving) {
      player.bob += dt * 10;
      playerGroup.position.y = Math.abs(Math.sin(player.bob)) * 0.08;
    } else playerGroup.position.y = 0;
    // 猫游走
    cats.forEach(function (c) {
      if (!c.target || Math.hypot(c.target.x - c.x, c.target.y - c.y) < 6) {
        c.target = { x: c.homeX + (Math.random() - 0.5) * 220, y: c.homeY + (Math.random() - 0.5) * 160 };
      }
      var dx = c.target.x - c.x, dy = c.target.y - c.y, d = Math.hypot(dx, dy);
      if (d > 0.5) { c.x += dx / d * 22 * dt; c.y += dy / d * 22 * dt; }
      var cp = to3(c.x, c.y);
      c.mesh.position.set(cp.x, 0, cp.z);
      c.mesh.rotation.y = Math.atan2(dx, dy);
    });
    // 转经筒旋转
    if (prayerWheel) prayerWheel.rotation.y += dt * 1.2;
    // 水波纹流动
    if (waterTex) { waterTex.offset.x = (now * 0.02) % 1; waterTex.offset.y = (now * 0.013) % 1; }
    // 高光标记旋转浮动
    DATA.landmarks.forEach(function (lm) {
      var m = markers[lm.id];
      if (m && m.mesh.visible) {
        m.mesh.rotation.y += dt * 1.5;
        m.mesh.position.y = m.baseY + Math.sin(now * 2.2) * 0.25;
      }
    });
    updateHighlights();
    updateCamera();
    renderer.render(scene, camera);
  }
  function blockedAt(x, y) {
    // 玩家半径 8 世界单位：中心 + 四个方向采样
    if (cellBlocked(x, y)) return true;
    return cellBlocked(x + 8, y) || cellBlocked(x - 8, y) || cellBlocked(x, y + 8) || cellBlocked(x, y - 8);
  }

  /* ---------- 输入：摇杆 + 右半屏转镜头 + 点选 ---------- */
  function bindInput() {
    var joyEl = $('joystick'), knob = $('joyKnob');
    var joyId = null, joyCenter = null;
    function joyVec(e) {
      var dx = e.clientX - joyCenter.x, dy = e.clientY - joyCenter.y;
      var len = Math.hypot(dx, dy), max = 40;
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      joy.x = dx / max; joy.y = dy / max;
    }
    joyEl.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      joyId = e.pointerId;
      joyEl.setPointerCapture(e.pointerId);
      var r = joyEl.getBoundingClientRect();
      joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      joyVec(e);
    });
    joyEl.addEventListener('pointermove', function (e) { if (e.pointerId === joyId) joyVec(e); });
    function joyEnd(e) {
      if (e.pointerId !== joyId) return;
      joyId = null; joy.x = 0; joy.y = 0;
      knob.style.transform = '';
    }
    joyEl.addEventListener('pointerup', joyEnd);
    joyEl.addEventListener('pointercancel', joyEnd);

    var cvs = renderer.domElement;
    var downPos = null, downTime = 0, moved = 0;
    cvs.addEventListener('pointerdown', function (e) {
      camDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      downPos = { x: e.clientX, y: e.clientY }; downTime = Date.now(); moved = 0;
    });
    cvs.addEventListener('pointermove', function (e) {
      if (!camDrag || camDrag.id !== e.pointerId) return;
      var dx = e.clientX - camDrag.x, dy = e.clientY - camDrag.y;
      camDrag.x = e.clientX; camDrag.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      yaw -= dx * 0.005;
      pitch = clamp(pitch + dy * 0.003, -0.9, 0.9);
    });
    function cvsUp(e) {
      if (camDrag && camDrag.id === e.pointerId) camDrag = null;
      if (downPos && moved < 10 && Date.now() - downTime < 400) handleTap(e);
      downPos = null;
    }
    cvs.addEventListener('pointerup', cvsUp);
    cvs.addEventListener('pointercancel', function (e) { camDrag = null; downPos = null; });
  }
  function handleTap(e) {
    var rect = renderer.domElement.getBoundingClientRect();
    var ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1
    };
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(catMeshes.concat(landmarkHit), true);
    if (!hits.length) return;
    var obj = hits[0].object;
    var group = obj;
    while (group && !group.userData.isCat && !group.userData.landmarkId) group = group.parent;
    if (!group) return;
    if (group.userData.isCat) {
      if (Math.random() < 0.3 && CATS) {
        var cat = CATS.cats[Math.floor(Math.random() * CATS.cats.length)];
        openCatPostcard(cat, null);
        toast('🐱 抓到一只流浪猫！它允许你摸一下头');
      } else toast('🐱 猫猫跑开了… 下次手速快一点');
      return;
    }
    if (group.userData.landmarkId) {
      var lm = DATA.landmarks.find(function (l) { return l.id === group.userData.landmarkId; });
      if (lm && state.highlighted[lm.id]) triggerDrop(lm);
      else if (lm) toast('先走到「' + lm.name + '」旁边，亮起标记后再点它');
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
      player.x = gps.pos.x; player.y = gps.pos.y;
      syncPlayerMesh();
      $('gpsLine').textContent = 'GPS · ' + p.coords.latitude.toFixed(4) + ', ' + p.coords.longitude.toFixed(4);
    }, function (err) {
      $('gpsLine').textContent = '定位失败：' + err.message + '，可用室内测试';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
  }
  function stopGps() {
    if (gps.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null;
  }

  /* ---------- 模式 / 视角 ---------- */
  function applyMode() {
    document.body.dataset.mode = state.mode;
    document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === state.mode); });
    $('joystick').style.display = state.mode === 'cloud' ? 'block' : 'none';
    $('debugBtn').hidden = state.mode !== 'real';
    $('gpsLine').hidden = state.mode !== 'real';
    $('mapHint').textContent = state.mode === 'cloud'
      ? '左摇杆走路 · 右半屏滑动转镜头'
      : '实景模式 · 小人跟随你的真实位置移动';
    $('locText').textContent = state.mode === 'cloud' ? '云逛模式 · 走到地标旁点亮高光' : '实景模式 · 走近地标 100 米内点亮金色高光';
    if (state.mode === 'real') startGps(); else stopGps();
  }
  function applyView() {
    document.body.dataset.view = state.view;
    $('viewBtn').textContent = state.view === 'third' ? '🎥 第三人称' : '👁️ 第一人称';
    if (playerGroup) playerGroup.visible = state.view === 'third';
  }

  /* ---------- 尺寸 ---------- */
  function resize() {
    var wrap = $('mapWrap');
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  /* ---------- 启动 ---------- */
  function init(data, catsData) {
    DATA = data; CATS = catsData;
    var order = ['anyuanmen', 'jiefangmen', 'chaoyangmen', 'changlemen', 'jianguomen', 'wenchangmen', 'yongningmen', 'zhuquemen', 'hanguangmen', 'andingmen', 'yuxiangmen'];
    WALL_POLY = order.map(function (id) {
      var lm = DATA.landmarks.find(function (l) { return l.id === id; });
      return [lm.x, lm.y];
    });
    MOAT_POLY = WALL_POLY.map(function (p) {
      return [MOAT_CX + (p[0] - MOAT_CX) * MOAT_K, MOAT_CY + (p[1] - MOAT_CY) * MOAT_K];
    });
    loadState();
    buildGrid();
    if (typeof THREE === 'undefined') {
      $('mapHint').textContent = 'Three.js CDN 加载失败，请检查网络后刷新页面。';
      return;
    }
    try {
      buildWorld();
    } catch (err) {
      $('mapHint').textContent = 'WebGL 初始化失败：' + err.message + '，请换个支持 WebGL 的浏览器打开。';
      console.error('[xian-wall-3d] WebGL 初始化失败', err);
      return;
    }
    applySkin(); applyMode(); applyView();
    renderProgress(); renderDrawer();
    window.addEventListener('resize', resize);
    bindInput();
    $('viewBtn').addEventListener('click', function () {
      state.view = state.view === 'third' ? 'first' : 'third';
      applyView();
      toast(state.view === 'third' ? '已切换第三人称追尾视角' : '已切换第一人称沉浸视角');
    });
    document.querySelectorAll('.skin-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.skin = b.dataset.skin; saveState(); applySkin(); toast('已切换「' + b.textContent.trim() + '」'); });
    });
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.mode = b.dataset.mode; saveState(); applyMode(); });
    });
    $('exploreBtn').addEventListener('click', function () {
      var id = $('exploreBtn').dataset.landmark;
      var lm = DATA.landmarks.find(function (l) { return l.id === id; });
      if (lm) triggerDrop(lm);
    });
    $('debugBtn').addEventListener('click', function () {
      var lm = DATA.landmarks.find(function (l) { return l.id === 'chaoyangmen'; });
      gps.pos = { x: lm.x, y: lm.y, lat: lm.lat, lng: lm.lng };
      gps.simulated = true;
      player.x = lm.x; player.y = lm.y;
      syncPlayerMesh();
      $('gpsLine').textContent = '室内测试 · 已模拟到朝阳门';
      toast('已模拟瞬移到朝阳门，看看它亮起金色高光了没');
    });
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
    requestAnimationFrame(loop);
  }

  Promise.all([
    fetch('items.json').then(function (r) { if (!r.ok) throw new Error('items.json HTTP ' + r.status); return r.json(); }),
    fetch('cats.json').then(function (r) { if (!r.ok) throw new Error('cats.json HTTP ' + r.status); return r.json(); }).catch(function () { return null; })
  ]).then(function (res) { init(res[0], res[1]); })
  .catch(function (err) {
    document.getElementById('mapHint').textContent = '数据加载失败：' + err.message + '，请用 HTTP 服务打开本站。';
    console.error('[xian-wall-3d] 数据加载失败', err);
  });

  // 供无头自测调用
  window.__xwcc = {
    get state() { return state; },
    get DATA() { return DATA; },
    get scene() { return scene; },
    get player() { return player; },
    get yaw() { return yaw; },
    set yaw(v) { yaw = v; },
    get joy() { return joy; },
    get cats() { return cats; },
    rollTier: rollTier,
    gpsToWorld: gpsToWorld,
    isBlocked: isBlocked,
    triggerDrop: triggerDrop,
    updateHighlights: updateHighlights,
    applyView: applyView,
    updateCamera: updateCamera
  };
})();
