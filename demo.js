import { db, ref, onValue, set, push, runTransaction, serverTimestamp, getDynamicQrState } from "./firebase-config.js";

// ============================================================================
// GEOMETRÍA CALIBRADA SOBRE imgDEMO/demoimg.jpg (1377 x 768)
// ============================================================================
const NS = "http://www.w3.org/2000/svg";

const GATE = [422, 280];
// Flechas rosadas (ENTRADA): llegan desde abajo-izquierda subiendo por la caletera y doblan a la caseta
const SPAWN = [[75, 595], [148, 515], [248, 425], [326, 355], [378, 285], GATE];
// Flechas amarillas (SALIDA): salen por la caseta y siguen subiendo hacia arriba-derecha por la caletera
const EXIT_TAIL = [GATE, [396, 255], [415, 195], [448, 145], [535, 40], [580, -25]];

// Flujo ambiental en carreteras cercanas
const HIGHWAY_LANES = [
  // Calzada izquierda (hacia abajo-izquierda)
  { pts: [[156, -20], [136, 40], [92, 150], [32, 260], [-25, 365]], speed: 195 },
  { pts: [[180, -20], [158, 40], [114, 150], [52, 260], [-15, 385]], speed: 170 },
  // Pista izquierda de calzada central (hacia abajo-izquierda, conectando con la curva)
  { pts: [[445, -20], [385, 45], [278, 155], [168, 272], [110, 322], [45, 342], [-25, 375]], speed: 190 },
  // Pista derecha de calzada central (hacia arriba-derecha)
  { pts: [[20, 565], [149, 400], [268, 260], [370, 150], [475, 40], [532, -20]], speed: 185 }
];

// Calle curva de acceso (eje central del asfalto en demoimg.jpg)
const ARC_ROAD = [
  GATE,
  [468, 294],
  [506, 282],
  [546, 240],
  [586, 200],
  [632, 179],
  [688, 178],
  [765, 189],
  [845, 201],
  [902, 211]
];
const LOT_ENTRY = ARC_ROAD[ARC_ROAD.length - 1];

// Pasillos principales del estacionamiento (inclinación real ~8.4°)
const WEST_SPINE = [LOT_ENTRY, [890, 304], [878, 390]];
const NORTH_AISLE = [LOT_ENTRY, [1165, 250]];
const MID_AISLE = [LOT_ENTRY, [890, 304], [1155, 344]];
const SOUTH_AISLE = [LOT_ENTRY, [890, 304], [878, 390], [1142, 428]];
const EAST_SPINE = [LOT_ENTRY, [1165, 250], [1142, 428]];
const SE_AISLE = [LOT_ENTRY, [890, 304], [878, 390], [1142, 428], [1180, 458], [1258, 588]];

const SPOT_LEN = 23;
const SPOT_WID = 12;

const CAR_SPEED = 165;
const SPAWN_INTERVAL = 0.4;
const CAR_COLORS = [
  "#1e293b", "#f8fafc", "#dc2626", "#2563eb", "#64748b",
  "#0f766e", "#a3a3a3", "#7c3aed", "#ca8a04", "#e2e8f0"
];

const ZONES = {
  ARC: { name: "Arco de Acceso", spots: [] },
  NORTH: { name: "Fila Norte", spots: [] },
  B1: { name: "Bloque Central 1", spots: [] },
  B2: { name: "Bloque Central 2", spots: [] },
  EAST: { name: "Borde Multicancha", spots: [] },
  SE: { name: "Patio Sur-Este", spots: [] },
  EDIF: { name: "Costado Edificio", spots: [] }
};

const JEFATURA_AREAS = [
  "Informática",
  "Salud",
  "Ingeniería",
  "Administración",
  "Jefatura 5",
  "Jefatura 6",
  "Jefatura 7",
  "Jefatura 8",
  "Jefatura 9",
  "Jefatura 10"
];

// Pista paralela para que el Docente se salte la fila cuando hay congestión
const EXPRESS_SPAWN = [[55, 585], [130, 505], [228, 412], [304, 342], [364, 276], GATE];

const spots = [];

function buildPath(points) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.01) continue;
    segs.push({
      x1, y1, x2, y2, len, start: total,
      angle: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
    });
    total += len;
  }
  return { segs, total };
}

function pointAt(path, d) {
  for (const s of path.segs) {
    if (d <= s.start + s.len) {
      const t = (d - s.start) / s.len;
      return { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t, angle: s.angle };
    }
  }
  const last = path.segs[path.segs.length - 1];
  return { x: last.x2, y: last.y2, angle: last.angle };
}

function prefixUpTo(points, d) {
  const out = [points[0]];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (acc + len >= d) {
      const t = len === 0 ? 0 : (d - acc) / len;
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
      return out;
    }
    out.push(points[i + 1]);
    acc += len;
  }
  return out;
}

function addSpot(zone, x, y, parkAngle, route, jefatura = null) {
  const path = buildPath(route);
  const spot = {
    id: spots.length,
    zone,
    x,
    y,
    parkAngle,
    route,
    jefatura,
    state: "free",
    car: null,
    el: null,
    routeLen: path.total
  };
  spots.push(spot);
  if (!jefatura && ZONES[zone]) ZONES[zone].spots.push(spot);
}

// Crea una fila lineal de calzas entre (x0,y0) y (x1,y1), con ángulo explícito y acceso desde un pasillo
function addLinearRow(zone, x0, y0, x1, y1, count, parkAngle, aislePrefix, aislePts, jefaturas = null) {
  const aislePath = buildPath(aislePts);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const sx = x0 + (x1 - x0) * t;
    const sy = y0 + (y1 - y0) * t;

    // Proyectar el punto más cercano en el pasillo para la maniobra de entrada
    let bestD = 0;
    let bestDist = Infinity;
    for (let d = 0; d <= aislePath.total; d += 6) {
      const p = pointAt(aislePath, d);
      const dist = Math.hypot(p.x - sx, p.y - sy);
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
      }
    }
    const route = [...aislePrefix, ...prefixUpTo(aislePts, bestD), [sx, sy]];
    addSpot(zone, sx, sy, parkAngle, route, jefaturas ? jefaturas[i] : null);
  }
}

// 1. ARCO DE ACCESO (22 calzas siguiendo la curva norte de demoimg.jpg)
const arcLine = [
  [544, 198],
  [566, 178],
  [593, 161],
  [625, 149],
  [664, 146],
  [725, 154],
  [795, 164],
  [880, 177]
];
const arcStallPath = buildPath(arcLine);
const arcRoadPath = buildPath(ARC_ROAD);
const ARC_COUNT = 22;
for (let i = 0; i < ARC_COUNT; i++) {
  const d = (arcStallPath.total * i) / (ARC_COUNT - 1);
  const p = pointAt(arcStallPath, d);
  const parkAngle = p.angle - 90; // perpendicular apuntando hacia el borde verde norte
  let bestD = 0;
  let bestDist = Infinity;
  for (let rd = 110; rd <= arcRoadPath.total; rd += 5) {
    const rp = pointAt(arcRoadPath, rd);
    const dist = Math.hypot(rp.x - p.x, rp.y - p.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestD = rd;
    }
  }
  const route = [...prefixUpTo(ARC_ROAD, bestD), [p.x, p.y]];
  addSpot("ARC", p.x, p.y, parkAngle, route);
}

// 1b. FILA PARALELA FRENTE A EDIFICIO CENTRAL (5 calzas paralelas al borde norte del edificio)
addLinearRow("ARC", 738, 199, 874, 220, 5, 8.5, [], ARC_ROAD);

// 2. FILA NORTE PRINCIPAL (9 calzas paralelas centradas entre cada línea amarilla)
addLinearRow("NORTH", 948, 197, 1166, 229, 9, 8.4, ARC_ROAD, NORTH_AISLE);

// 3. BLOQUE CENTRAL 1 (13 arriba + 13 abajo, eje inclinado 8.4°)
addLinearRow("B1", 949, 250, 1138, 278, 13, 98.4, ARC_ROAD, NORTH_AISLE);
addLinearRow("B1", 945, 276, 1134, 304, 13, -81.6, ARC_ROAD, MID_AISLE);

// 4. BLOQUE CENTRAL 2 (primeros 5 arriba + 5 abajo = 10 únicos cupos de JEFATURA, 1 por cada jefe; los otros 7 + 7 son generales)
const b2TopJef = Array.from({ length: 12 }, (_, i) => (i < 5 ? JEFATURA_AREAS[i] : null));
const b2BotJef = Array.from({ length: 12 }, (_, i) => (i < 5 ? JEFATURA_AREAS[i + 5] : null));
addLinearRow("B2", 942, 332, 1114, 357, 12, 98.4, ARC_ROAD, MID_AISLE, b2TopJef);
addLinearRow("B2", 938, 358, 1110, 383, 12, -81.6, ARC_ROAD, SOUTH_AISLE, b2BotJef);

// 5. BORDE MULTICANCHA / FILA ESTE (9 calzas en vertical mirando al este)
addLinearRow("EAST", 1198, 252, 1181, 376, 9, 8.4, ARC_ROAD, EAST_SPINE);

// 6. PATIO SUR-ESTE (11 calzas borde izquierdo + 10 calzas borde derecho)
addLinearRow("SE", 1146, 471, 1232, 602, 11, 146.7, ARC_ROAD, SE_AISLE);
addLinearRow("SE", 1213, 437, 1286, 553, 9, -32, ARC_ROAD, SE_AISLE);
addLinearRow("SE", 1290, 568, 1290, 568, 1, -32, ARC_ROAD, SE_AISLE);

// 7. COSTADO EDIFICIO (2 calzas generales pintadas junto al Edificio Central)
addLinearRow("EDIF", 884, 434, 901, 421, 2, 98.4, ARC_ROAD, SOUTH_AISLE);

const generalSpots = spots.filter((s) => s.jefatura === null);
const CAPACITY = generalSpots.length;

// ============================================================================
// DIBUJO DE CALZAS
// ============================================================================
const layerSpots = document.getElementById("layerSpots");
const layerAmbient = document.getElementById("layerAmbient");
const layerCars = document.getElementById("layerCars");
const barrier = document.getElementById("barrier");

function drawSpots() {
  spots.forEach((s) => {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", -SPOT_LEN / 2);
    r.setAttribute("y", -SPOT_WID / 2);
    r.setAttribute("width", SPOT_LEN);
    r.setAttribute("height", SPOT_WID);
    r.setAttribute("rx", 2);
    r.setAttribute(
      "transform",
      `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) rotate(${s.parkAngle.toFixed(1)})`
    );
    if (s.jefatura) {
      const t = document.createElementNS(NS, "title");
      t.textContent = `Cupo Jefatura · ${s.jefatura}`;
      r.appendChild(t);
    }
    s.el = r;
    renderSpot(s);
    layerSpots.appendChild(r);
  });
}

let jefaturaData = {};

function renderSpot(s) {
  if (s.jefatura) {
    const info = jefaturaData[s.jefatura];
    if (s.state === "occupied" || info?.claimedBy) {
      s.el.setAttribute("class", "spot occupied");
    } else if (s.state === "reserved") {
      s.el.setAttribute("class", "spot reserved");
    } else {
      const released = Boolean(info?.released);
      s.el.setAttribute("class", `spot ${released ? "jefe-released" : "jefe-reserved"}`);
    }
    return;
  }
  s.el.setAttribute("class", `spot ${s.state === "free" ? "" : s.state}`);
}

// ============================================================================
// VEHÍCULOS
// ============================================================================
const moving = [];

function createCarEl(targetLayer = layerCars) {
  const color = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "car");
  g.innerHTML = `
    <rect x="-10" y="-5" width="20" height="10" rx="3" fill="${color}" stroke="rgba(15,23,42,.55)" stroke-width=".8"/>
    <rect x="2" y="-3.8" width="4.5" height="7.6" rx="1.2" fill="rgba(15,23,42,.6)"/>
    <rect x="-7.5" y="-3.8" width="3" height="7.6" rx="1" fill="rgba(15,23,42,.4)"/>`;
  targetLayer.appendChild(g);
  return g;
}

// Tráfico ambiental leve en carreteras cercanas
const ambientPaths = HIGHWAY_LANES.map((l) => ({ path: buildPath(l.pts), speed: l.speed }));
const ambientCars = [];

function spawnAmbientCar(initialProgress = 0) {
  const lane = ambientPaths[Math.floor(Math.random() * ambientPaths.length)];
  const dist = lane.path.total * initialProgress;
  // Evitar superposición con otro vehículo recién aparecido en la misma pista
  if (ambientCars.some((c) => c.lane === lane && Math.abs(c.dist - dist) < 60)) return;
  const el = createCarEl(layerAmbient);
  const p = pointAt(lane.path, dist);
  placeCar(el, p.x, p.y, p.angle);
  ambientCars.push({ el, lane, dist, speed: lane.speed * (0.9 + Math.random() * 0.2) });
}

function placeCar(el, x, y, angle) {
  el.setAttribute(
    "transform",
    `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`
  );
}

function pickFreeSpot() {
  let best = null;
  let bestScore = Infinity;
  generalSpots.forEach((s) => {
    if (s.state !== "free") return;
    const score = s.routeLen + Math.random() * 280;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return best;
}

const SPAWN_PATH = buildPath(SPAWN);
const GATE_STOP_DIST = Math.max(20, SPAWN_PATH.total - 16);
const gateQueue = [];
let pendingArrivals = 0;
let autoScan = false;
let autoScanTimer = 0;
let scanOkFlashTimer = 0;
let scanErrFlashTimer = 0;
let lastRenderedQrRut = null;

// Lista de usuarios reales desde Firebase usuarios/ (sin nombres por privacidad)
let demoDrivers = [
  { rut: "201112223", rol: "Alumno" },
  { rut: "148765432", rol: "Docente" },
  { rut: "112233445", rol: "Jefe de Carrera" }
];
let driverCursor = 0;
let lastGateQrStep = null;

function pickNextDriver() {
  const d = demoDrivers[driverCursor % demoDrivers.length];
  driverCursor++;
  return d;
}

function renderGateQr(driver, force = false) {
  const box = document.getElementById("gateQrCodeBox");
  const driverEl = document.getElementById("gateQrDriver");
  const hintEl = document.getElementById("gateQrHint");
  if (!box || !driver) return;

  const q = getDynamicQrState(driver.rut);

  if (driverEl) {
    driverEl.textContent = `${driver.rol} · RUT ${driver.rut}`;
  }
  if (hintEl) {
    hintEl.textContent = `QR dinámico · ${q.remaining}s`;
  }

  if (!force && lastRenderedQrRut === driver.rut && lastGateQrStep === q.step) return;
  lastRenderedQrRut = driver.rut;
  lastGateQrStep = q.step;
  box.innerHTML = "";

  if (typeof qrcode !== "function") return;
  let qr;
  try {
    // Modo Alphanumeric: 21x21 (Versión 1) para RUT-XXXXXX (16 chars) sin overflow
    qr = qrcode(0, "M");
    qr.addData(q.payload, "Alphanumeric");
    qr.make();
  } catch (err) {
    console.error("Error generando QR en DEMO:", err);
    return;
  }

  const count = qr.getModuleCount();
  const size = 140;
  const cell = size / count;

  // Fondo blanco puro (quiet zone) para lectura instantánea de cámara
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("x", -4);
  bg.setAttribute("y", -4);
  bg.setAttribute("width", size + 8);
  bg.setAttribute("height", size + 8);
  bg.setAttribute("fill", "#ffffff");
  box.appendChild(bg);

  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", (c * cell).toFixed(2));
      rect.setAttribute("y", (r * cell).toFixed(2));
      rect.setAttribute("width", (cell + 0.15).toFixed(2));
      rect.setAttribute("height", (cell + 0.15).toFixed(2));
      rect.setAttribute("fill", "#000000");
      box.appendChild(rect);
    }
  }
}

function spawnCarToGate() {
  if (gateQueue.length >= 10) return false;
  const last = gateQueue[gateQueue.length - 1];
  if (last && last.dist < 32) return false;

  const el = createCarEl();
  const p = pointAt(SPAWN_PATH, 0);
  placeCar(el, p.x, p.y, p.angle);
  gateQueue.push({
    el,
    dist: 0,
    angle: p.angle,
    waiting: false,
    driver: pickNextDriver()
  });
  updateGateUI();
  return true;
}

function scanWaitingCar(forceFromLive = false) {
  if (!gateQueue.length) return false;
  const front = gateQueue[0];
  if (!front.waiting && !forceFromLive) return false;

  const spot = pickFreeSpot();
  if (!spot) {
    logActivity("🚫 Estacionamiento lleno (sin cupos)");
    return false;
  }

  gateQueue.shift();
  lastRenderedQrRut = null;
  spot.state = "reserved";
  renderSpot(spot);

  const curPos = pointAt(SPAWN_PATH, front.dist);
  const path = buildPath([[curPos.x, curPos.y], GATE, ...spot.route]);
  moving.push({
    el: front.el,
    path,
    dist: 0,
    type: "in",
    spot,
    angle: front.angle
  });

  scanOkFlashTimer = 0.95;
  scanErrFlashTimer = 0;
  logActivity(`✅ QR ${front.driver.rol} (${front.driver.rut}) → ${ZONES[spot.zone].name}`);
  updateGateUI();
  return true;
}

function startDirectLiveArrival() {
  if (gateQueue.length > 0) {
    return scanWaitingCar(true);
  }
  const spot = pickFreeSpot();
  if (!spot) return false;
  spot.state = "reserved";
  renderSpot(spot);

  const path = buildPath([...SPAWN, ...spot.route]);
  const el = createCarEl();
  const car = { el, path, dist: 0, type: "in", spot, angle: path.segs[0].angle };
  placeCar(el, SPAWN[0][0], SPAWN[0][1], car.angle);
  moving.push(car);
  scanOkFlashTimer = 0.95;
  return true;
}

// Auto de Docente se salta la fila por la pista paralela y entra directo al cupo prestado de Jefatura
function dispatchDocenteExpress(areaName) {
  const spot = spots.find(
    (s) => s.jefatura === areaName && s.state !== "occupied" && s.state !== "reserved"
  );
  if (!spot) {
    logActivity(`⚠️ El cupo de ${areaName} ya está ocupado`);
    return false;
  }

  spot.state = "reserved";
  renderSpot(spot);

  const path = buildPath([...EXPRESS_SPAWN, ...spot.route]);
  const el = createCarEl();
  // Destacar visualmente el auto del Docente con franja celeste/dorada
  el.innerHTML = `
    <rect x="-10" y="-5" width="20" height="10" rx="3" fill="#0284c7" stroke="#fde047" stroke-width="1.4"/>
    <rect x="2" y="-3.8" width="4.5" height="7.6" rx="1.2" fill="#e0f2fe"/>
    <rect x="-7.5" y="-3.8" width="3" height="7.6" rx="1" fill="#bae6fd"/>`;

  const car = { el, path, dist: 0, type: "in", spot, angle: path.segs[0].angle, isDocente: true };
  placeCar(el, EXPRESS_SPAWN[0][0], EXPRESS_SPAWN[0][1], car.angle);
  moving.push(car);

  scanOkFlashTimer = 1.0;
  logActivity(`⭐ Docente salta fila → Jefatura ${areaName}`);
  updateGateUI();
  return true;
}

function simulateDocenteExpress() {
  // Buscar un cupo de jefatura libre (primero alguno ya liberado, si no presta Informática)
  let targetSpot = spots.find(
    (s) => s.jefatura && jefaturaData[s.jefatura]?.released && s.state === "free"
  );
  if (!targetSpot) {
    targetSpot = spots.find((s) => s.jefatura === "Informática" && s.state === "free") ||
      spots.find((s) => s.jefatura && s.state === "free");
    if (targetSpot) {
      jefaturaData[targetSpot.jefatura] = {
        released: true,
        jefeNombre: "Jefe de Carrera"
      };
      renderSpot(targetSpot);
      updateStats();
    }
  }
  if (!targetSpot) {
    logActivity("⚠️ Todos los cupos de jefatura están ocupados");
    return;
  }
  dispatchDocenteExpress(targetSpot.jefatura);
}

function spawnLiveWaiter() {
  spawnCarToGate();
}

function toggleAutoScan() {
  autoScan = !autoScan;
  autoScanTimer = 0;
  const btn = document.getElementById("btnAutoScan");
  if (btn) {
    btn.textContent = autoScan ? "⏸ Escaneo Automático: ON" : "🤖 Escaneo Automático: OFF";
    btn.classList.toggle("active", autoScan);
  }
}

async function liveFillAll() {
  gateQueue.splice(0).forEach((c) => c.el.remove());
  updateGateUI();
  await set(ref(db, "estacionamiento/occupied"), CAPACITY);
  await push(ref(db, "estacionamiento/logs"), {
    time: new Date().toTimeString().slice(0, 5),
    timestamp: serverTimestamp(),
    title: "Llenado DEMO",
    detail: `Capacidad completa (${CAPACITY}/${CAPACITY})`,
    delta: `+${CAPACITY}`,
    kind: "plus"
  });
  logActivity(`🅿️ Estacionamiento llenado (${CAPACITY}/${CAPACITY})`);
}

async function liveEmptyAll() {
  gateQueue.splice(0).forEach((c) => c.el.remove());
  updateGateUI();
  await set(ref(db, "estacionamiento/occupied"), 0);
  await push(ref(db, "estacionamiento/logs"), {
    time: new Date().toTimeString().slice(0, 5),
    timestamp: serverTimestamp(),
    title: "Vaciado DEMO",
    detail: `Recinto vaciado (0/${CAPACITY})`,
    delta: "0",
    kind: "minus"
  });
  logActivity("🧹 Estacionamiento vaciado (0)");
}

async function performAutoScanInFirebase() {
  const front = gateQueue[0];
  if (!front || !front.waiting) return;
  if (committedCount() >= CAPACITY) {
    logActivity("🚫 Estacionamiento lleno (sin cupos)");
    return;
  }

  const driver = front.driver || { rut: "201112223", rol: "Alumno" };
  scanWaitingCar(true);

  try {
    await runTransaction(ref(db, "estacionamiento/occupied"), (cur) => {
      const val = typeof cur === "number" ? cur : 0;
      return val < CAPACITY ? val + 1 : val;
    });
    await push(ref(db, "estacionamiento/logs"), {
      time: new Date().toTimeString().slice(0, 5),
      timestamp: serverTimestamp(),
      title: `Ingreso QR (${driver.rol})`,
      detail: "Validación automática anónima",
      delta: "+1",
      kind: "plus"
    });
  } catch (e) {
    console.error("Error en escaneo automático:", e);
  }
}

function updateGateUI() {
  const popup = document.getElementById("gateQrPopup");
  const badge = document.getElementById("gateBadge");
  const badgeBg = document.getElementById("gateBadgeBg");
  const badgeText = document.getElementById("gateBadgeText");
  const btn = document.getElementById("btnScanGate");

  const waitingCount = gateQueue.length;
  const front = gateQueue[0];
  const frontReady = Boolean(front?.waiting);

  if (btn) {
    btn.textContent = `📷 Simular Escaneo (${waitingCount})`;
    btn.disabled = !frontReady;
  }

  // Mostrar el QR real encima del auto cuando está detenido en la barrera
  if (popup) {
    if (frontReady && scanOkFlashTimer <= 0) {
      renderGateQr(front.driver);
      popup.classList.remove("hidden");
    } else {
      popup.classList.add("hidden");
    }
  }

  // Mostrar flash breve de resultado (QR Válido / Inválido)
  if (!badge || !badgeBg || !badgeText) return;

  if (scanOkFlashTimer > 0) {
    badge.classList.remove("hidden", "err");
    badgeBg.setAttribute("fill", "#052e16");
    badgeBg.setAttribute("stroke", "#22c55e");
    badgeText.textContent = "✅ QR Válido";
  } else if (scanErrFlashTimer > 0) {
    badge.classList.remove("hidden");
    badge.classList.add("err");
    badgeBg.setAttribute("fill", "#450a0a");
    badgeBg.setAttribute("stroke", "#ef4444");
    badgeText.textContent = "❌ QR Inválido";
  } else {
    badge.classList.add("hidden");
  }
}

function startDeparture() {
  const parked = generalSpots.filter((s) => s.state === "occupied" && s.car);
  if (!parked.length) return false;
  const spot = parked[Math.floor(Math.random() * parked.length)];
  const { el, angle } = spot.car;
  spot.car = null;
  spot.state = "free";
  renderSpot(spot);

  const path = buildPath([...[...spot.route].reverse(), ...EXIT_TAIL]);
  moving.push({ el, path, dist: 0, type: "out", spot, angle });
  logActivity(`↩️ Salió desde ${ZONES[spot.zone].name}`);
  return true;
}

function instantFill(n) {
  for (let i = 0; i < n; i++) {
    const spot = pickFreeSpot();
    if (!spot) break;
    const el = createCarEl();
    placeCar(el, spot.x, spot.y, spot.parkAngle);
    spot.state = "occupied";
    spot.car = { el, angle: spot.parkAngle };
    renderSpot(spot);
  }
}

function committedCount() {
  return generalSpots.filter((s) => s.state === "occupied" || s.state === "reserved").length;
}

// ============================================================================
// ESTADO EN VIVO (CONECTADO A FIREBASE)
// ============================================================================
let mode = "live";
let target = 0;
let speed = 1;
let liveOccupied = null;

function clampTarget() {
  target = Math.max(0, Math.min(CAPACITY, target));
}

function resetAll() {
  gateQueue.splice(0).forEach((c) => c.el.remove());
  moving.splice(0).forEach((c) => c.el.remove());
  spots.forEach((s) => {
    if (s.car) s.car.el.remove();
    s.car = null;
    s.state = "free";
    renderSpot(s);
  });
  target = 0;
  scanOkFlashTimer = 0;
  activity.length = 0;
  renderActivity();
  updateGateUI();
}

function setSpeed(val) {
  speed = parseFloat(val) || 1;
  document.getElementById("speedLabel").textContent = `${speed}×`;
}

// ============================================================================
// ACTIVIDAD Y ESTADÍSTICAS
// ============================================================================
const activity = [];

function logActivity(text) {
  activity.unshift({
    text,
    time: new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  });
  if (activity.length > 6) activity.pop();
  renderActivity();
}

function renderActivity() {
  const list = document.getElementById("activityList");
  if (!activity.length) {
    list.innerHTML = `<li class="muted">Sin movimientos aún.</li>`;
    return;
  }
  list.innerHTML = activity.map((a) => `<li><span>${a.text}</span><span>${a.time}</span></li>`).join("");
}

function buildZoneList() {
  document.getElementById("zoneList").innerHTML = Object.entries(ZONES)
    .map(
      ([id, z]) => `
      <div class="zone-row">
        <div class="zone-head"><span>${z.name}</span><span id="zoneCount-${id}">0 / ${z.spots.length}</span></div>
        <div class="zone-track"><div class="zone-fill" id="zoneFill-${id}"></div></div>
      </div>`
    )
    .join("");
}

function colorFor(pct) {
  return pct >= 100 ? "#ef4444" : pct >= 85 ? "#f59e0b" : "#15803d";
}

function updateStats() {
  const parked = generalSpots.filter((s) => s.state === "occupied").length;
  const incoming = moving.filter((c) => c.type === "in").length + gateQueue.length;
  const leaving = moving.filter((c) => c.type === "out").length;
  const free = CAPACITY - committedCount();
  const pct = CAPACITY > 0 ? Math.round((parked / CAPACITY) * 100) : 0;

  document.getElementById("statParked").textContent = parked;
  document.getElementById("statCapacity").textContent = CAPACITY;
  document.getElementById("statFree").textContent = free;
  document.getElementById("statIncoming").textContent = incoming;
  document.getElementById("statLeaving").textContent = leaving;

  const bar = document.getElementById("statBar");
  bar.style.width = `${pct}%`;
  bar.style.background = pct >= 100 ? "#fca5a5" : pct >= 85 ? "#fcd34d" : "#4ade80";

  Object.entries(ZONES).forEach(([id, z]) => {
    const occ = z.spots.filter((s) => s.state === "occupied").length;
    const zPct = z.spots.length > 0 ? Math.round((occ / z.spots.length) * 100) : 0;
    document.getElementById(`zoneCount-${id}`).textContent = `${occ} / ${z.spots.length}`;
    const fill = document.getElementById(`zoneFill-${id}`);
    fill.style.width = `${zPct}%`;
    fill.style.background = colorFor(zPct);
  });

  updateLedBoard(free);
}

let garitaRemoteOffline = false;
let localLinkActive = false;
let lastRelayTs = null;

function handleLocalLinkMessage(msg) {
  if (!msg) return;
  localLinkActive = true;

  if (msg.action === "entry") {
    if (gateQueue.length > 0) {
      scanWaitingCar(true);
    } else {
      startDirectLiveArrival();
    }
    target = Math.min(CAPACITY, committedCount());
  } else if (msg.action === "exit") {
    startDeparture();
    target = Math.max(0, committedCount());
  } else if (msg.action === "invalid") {
    scanErrFlashTimer = 1.4;
    updateGateUI();
  } else if (msg.action === "docente_express" && msg.area) {
    dispatchDocenteExpress(msg.area);
  }

  const tag = document.getElementById("modeTag");
  if (mode === "live" && tag && msg.offline) {
    tag.textContent = "Enlace Local (Offline)";
    tag.style.background = "#fef3c7";
    tag.style.color = "#92400e";
  }
  updateStats();
}

// Actualiza la pantalla LED exterior (cupos generales + aviso cuando se libera cupo docente + estado de señal)
function updateLedBoard(freeGeneral) {
  const numEl = document.getElementById("ledFreeCount");
  const statusEl = document.getElementById("ledStatusText");
  const jefeRow = document.getElementById("ledJefeRow");
  const jefeEl = document.getElementById("ledJefeText");
  if (!numEl || !statusEl || !jefeEl) return;

  numEl.textContent = String(freeGeneral).padStart(3, "0");

  const stateCls = freeGeneral === 0 ? "full" : freeGeneral <= 15 ? "warn" : "";
  numEl.setAttribute("class", `led-number ${stateCls}`);
  statusEl.setAttribute("class", `led-status ${stateCls}`);
  statusEl.textContent =
    freeGeneral === 0
      ? "ESTACIONAMIENTO LLENO"
      : freeGeneral <= 15
        ? "ÚLTIMOS CUPOS DISPONIBLES"
        : "DISPONIBLE · INGRESO ABIERTO";

  const releasedAreas = Object.entries(jefaturaData)
    .filter(([, info]) => info && info.released)
    .map(([area]) => area.toUpperCase());

  if (releasedAreas.length > 0 && jefeRow) {
    jefeRow.classList.remove("hidden");
    jefeEl.textContent = `⭐ CUPO DOCENTE LIBRE (${releasedAreas.join(", ")})`;
  } else if (jefeRow) {
    jefeRow.classList.add("hidden");
  }
}

// ============================================================================
// BUCLE DE ANIMACIÓN
// ============================================================================
let lastTime = performance.now();
let spawnTimer = 0;
let rushTimer = 0;
let statsTimer = 0;
let ambientTimer = 0;

function frame(now) {
  const realDt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const dt = realDt * speed;

  // Mover tráfico ambiental en carreteras
  for (let i = ambientCars.length - 1; i >= 0; i--) {
    const ac = ambientCars[i];
    ac.dist += ac.speed * realDt;
    if (ac.dist >= ac.lane.path.total) {
      ac.el.remove();
      ambientCars.splice(i, 1);
    } else {
      const p = pointAt(ac.lane.path, ac.dist);
      placeCar(ac.el, p.x, p.y, p.angle);
    }
  }

  ambientTimer += realDt;
  if (ambientTimer >= 1.1) {
    ambientTimer = 0;
    if (ambientCars.length < 7) spawnAmbientCar(0);
  }

  // Avanzar la fila de autos esperando escaneo en la entrada
  for (let i = 0; i < gateQueue.length; i++) {
    const qCar = gateQueue[i];
    const maxDist = Math.max(0, GATE_STOP_DIST - i * 28);
    if (qCar.dist < maxDist) {
      qCar.dist = Math.min(maxDist, qCar.dist + CAR_SPEED * dt);
      const p = pointAt(SPAWN_PATH, qCar.dist);
      const diff = ((p.angle - qCar.angle + 540) % 360) - 180;
      qCar.angle += diff * Math.min(1, dt * 10);
      placeCar(qCar.el, p.x, p.y, qCar.angle);
    }
    const wasWaiting = qCar.waiting;
    qCar.waiting = i === 0 && qCar.dist >= GATE_STOP_DIST - 1.5;
    if (qCar.waiting && !wasWaiting) {
      updateGateUI();
    }
  }

  if (scanOkFlashTimer > 0) {
    scanOkFlashTimer = Math.max(0, scanOkFlashTimer - realDt);
    if (scanOkFlashTimer === 0) updateGateUI();
  }
  if (scanErrFlashTimer > 0) {
    scanErrFlashTimer = Math.max(0, scanErrFlashTimer - realDt);
    if (scanErrFlashTimer === 0) updateGateUI();
  }

  // Escaneo automático si está activado
  if (autoScan && gateQueue[0]?.waiting) {
    autoScanTimer += dt;
    if (autoScanTimer >= 0.85) {
      autoScanTimer = 0;
      performAutoScanInFirebase();
    }
  } else {
    autoScanTimer = 0;
  }

  let nearGate = false;
  for (let i = moving.length - 1; i >= 0; i--) {
    const car = moving[i];
    car.dist += CAR_SPEED * dt;
    const p = pointAt(car.path, car.dist);
    const diff = ((p.angle - car.angle + 540) % 360) - 180;
    car.angle += diff * Math.min(1, dt * 9);
    placeCar(car.el, p.x, p.y, car.angle);

    if (Math.hypot(p.x - GATE[0], p.y - GATE[1]) < 42) nearGate = true;

    if (car.dist >= car.path.total) {
      moving.splice(i, 1);
      if (car.type === "in") {
        car.spot.state = "occupied";
        car.spot.car = { el: car.el, angle: car.spot.parkAngle };
        placeCar(car.el, car.spot.x, car.spot.y, car.spot.parkAngle);
        renderSpot(car.spot);
        logActivity(
          car.spot.jefatura
            ? `⭐ Docente estacionó en Jefatura ${car.spot.jefatura}`
            : `🚗 Estacionó en ${ZONES[car.spot.zone].name}`
        );
      } else {
        car.el.remove();
      }
    }
  }

  barrier.classList.toggle("open", nearGate || scanOkFlashTimer > 0.35);

  spawnTimer += dt;
  if (spawnTimer >= SPAWN_INTERVAL) {
    spawnTimer = 0;
    const diff = target - committedCount();
    if (diff > 0 && gateQueue.length === 0) startDirectLiveArrival();
    else if (diff < 0) startDeparture();
  }

  statsTimer += realDt;
  if (statsTimer >= 0.15) {
    statsTimer = 0;
    updateStats();
    if (gateQueue[0]?.waiting && scanOkFlashTimer <= 0) {
      renderGateQr(gateQueue[0].driver);
    }
  }

  requestAnimationFrame(frame);
}

// ============================================================================
// FIREBASE (MODO EN VIVO + CUPOS DE JEFATURA)
// ============================================================================
onValue(ref(db, "estacionamiento/occupied"), (snap) => {
  const val = snap.val();
  const first = liveOccupied === null;
  liveOccupied = typeof val === "number" ? val : 0;

  if (mode === "live") {
    if (first) {
      resetAll();
      instantFill(Math.min(CAPACITY, liveOccupied));
    }
    target = Math.min(CAPACITY, liveOccupied);
  }
});

onValue(ref(db, "garita"), (snap) => {
  const g = snap.val();
  garitaRemoteOffline = Boolean(g && g.online === false);
  if (!garitaRemoteOffline) localLinkActive = false;

  // Escuchar enlace local simulado entre móvil (Guardia) y PC (DEMO)
  const relayTs = g?.localRelay?.ts || null;
  if (lastRelayTs === null) {
    lastRelayTs = relayTs || -1;
  } else if (relayTs && relayTs !== lastRelayTs) {
    lastRelayTs = relayTs;
    handleLocalLinkMessage(g.localRelay);
  }

  const tag = document.getElementById("modeTag");
  if (mode === "live" && tag) {
    tag.textContent = garitaRemoteOffline
      ? localLinkActive
        ? "Enlace Local (Offline)"
        : "Garita Offline"
      : "En vivo (BD)";
    tag.style.background = garitaRemoteOffline ? "#fef3c7" : "";
    tag.style.color = garitaRemoteOffline ? "#92400e" : "";
  }
  updateStats();
});

// Enlace local directo con la garita en la misma PC
if (typeof BroadcastChannel !== "undefined") {
  const localLink = new BroadcastChannel("smartpark_local_link");
  localLink.onmessage = (event) => handleLocalLinkMessage(event.data);
}

let prevJefaturaData = {};
onValue(ref(db, "jefatura"), (snap) => {
  const nextData = snap.val() || {};
  Object.entries(nextData).forEach(([area, info]) => {
    const prev = prevJefaturaData[area];
    // Si un docente acaba de ocupar el cupo en Firebase, entra saltándose la fila
    const occupiedNow = Boolean(info && (info.occupiedByDocente || info.claimedBy));
    const occupiedPrev = Boolean(prev && (prev.occupiedByDocente || prev.claimedBy));
    if (occupiedNow && !occupiedPrev) {
      dispatchDocenteExpress(area);
    }
    // Si el jefe dejó de prestar el cupo, liberar visualmente si estaba ocupado por demo
    if (info && !info.released && prev && prev.released) {
      const s = spots.find((sp) => sp.jefatura === area);
      if (s && s.car) {
        s.car.el.remove();
        s.car = null;
        s.state = "free";
      }
    }
  });
  prevJefaturaData = nextData;
  jefaturaData = nextData;
  spots.filter((s) => s.jefatura).forEach(renderSpot);
  updateStats();
});

// Cargar usuarios reales de Firebase para que el QR dinámico del auto sea 100% escaneable (sin nombres)
onValue(ref(db, "usuarios"), (snap) => {
  const data = snap.val();
  if (!data) return;
  const list = Object.entries(data)
    .filter(([, u]) => u && u.activo !== false)
    .map(([rut, u]) => ({
      rut,
      rol: u.rol === "jefe_carrera" ? "Jefe de Carrera" : u.rol === "docente" ? "Docente" : "Alumno"
    }));
  if (list.length > 0) demoDrivers = list;
});

// Escuchar escaneos reales desde Vista Guardia en Firebase (deja pasar al auto esperando en la barrera)
let seenLogKeys = null;
onValue(ref(db, "estacionamiento/logs"), (snap) => {
  const data = snap.val() || {};
  const keys = Object.keys(data);
  if (seenLogKeys === null) {
    seenLogKeys = new Set(keys);
    return;
  }
  const newKeys = keys.filter((k) => !seenLogKeys.has(k));
  newKeys.forEach((k) => {
    seenLogKeys.add(k);
    const log = data[k];
    if (!log) return;
    if (log.kind === "plus" && log.delta !== "Jefatura" && gateQueue.length > 0) {
      // El guardia escaneó el QR en guardia.html -> abrir barrera y dejar pasar!
      scanWaitingCar(true);
    } else if (log.kind === "invalid") {
      scanErrFlashTimer = 1.4;
      updateGateUI();
    }
  });
});

// ============================================================================
// INICIO EN VIVO + TRÁFICO AMBIENTAL INICIAL
// ============================================================================
drawSpots();
buildZoneList();
for (let i = 0; i < 4; i++) spawnAmbientCar(0.15 + i * 0.22);
updateStats();
requestAnimationFrame(frame);

Object.assign(window, {
  setSpeed,
  spawnLiveWaiter,
  simulateDocenteExpress,
  toggleAutoScan,
  liveFillAll,
  liveEmptyAll
});
