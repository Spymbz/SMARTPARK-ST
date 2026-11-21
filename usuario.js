import {
  db,
  ref,
  onValue,
  get,
  set,
  update,
  getDynamicQrState
} from "./firebase-config.js";

const SESSION_KEY = "smartpark_session_rut";

// Sin nombres ni patentes (cumplimiento ley de privacidad)
const DEMO_USERS = {
  "201112223": {
    email: "alumno.demo@alumnos.santotomas.cl",
    password: "12345",
    rol: "alumno",
    area: "Informática",
    activo: true
  },
  "148765432": {
    email: "carolina.munoz@santotomas.cl",
    password: "12345",
    rol: "docente",
    area: "Informática",
    activo: true
  },
  "112233445": {
    email: "roberto.soto@santotomas.cl",
    password: "12345",
    rol: "jefe_carrera",
    area: "Informática",
    activo: true
  }
};

let currentRut = null;
let currentUser = null;
let jefaturaUnsubscribe = null;
let lastQrStep = null;
let qrTimerInterval = null;

// Asegurar cuentas demo sin datos personales (sin nombre)
async function ensureDemoUsers() {
  const usersRef = ref(db, "usuarios");
  const snap = await get(usersRef);

  if (!snap.exists()) {
    await set(usersRef, DEMO_USERS);
    return;
  }

  const existing = snap.val();
  for (const [rut, demo] of Object.entries(DEMO_USERS)) {
    if (!existing[rut]) {
      await set(ref(db, `usuarios/${rut}`), demo);
    } else if (existing[rut].nombre || !existing[rut].email || !existing[rut].password) {
      await set(ref(db, `usuarios/${rut}`), {
        email: existing[rut].email || demo.email,
        password: existing[rut].password || demo.password,
        rol: existing[rut].rol || demo.rol,
        area: existing[rut].area || demo.area,
        activo: existing[rut].activo !== false
      });
    }
  }
}

// ============================================================================
// LOGIN Y SESIÓN
// ============================================================================
function showLoginError(msg) {
  const err = document.getElementById("loginError");
  if (!err) return;
  if (!msg) {
    err.classList.add("hidden");
    err.textContent = "";
  } else {
    err.textContent = msg;
    err.classList.remove("hidden");
  }
}

async function authenticate(emailInput, passInput) {
  const email = String(emailInput || "").trim().toLowerCase();
  const password = String(passInput || "");
  showLoginError("");

  if (!email.endsWith("@santotomas.cl") && !email.endsWith("@alumnos.santotomas.cl")) {
    showLoginError("Usa un correo @santotomas.cl o @alumnos.santotomas.cl");
    return;
  }

  const snap = await get(ref(db, "usuarios"));
  const users = snap.val() || {};

  const match = Object.entries(users).find(
    ([, u]) => u && String(u.email || "").toLowerCase() === email && String(u.password || "") === password
  );

  if (!match) {
    showLoginError("Correo o contraseña incorrectos.");
    return;
  }

  const [rut, userData] = match;
  if (userData.activo === false) {
    showLoginError("Esta cuenta está inactiva.");
    return;
  }

  enterSession(rut, userData);
}

function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value;
  const pass = document.getElementById("loginPass").value;
  authenticate(email, pass);
}

function quickLogin(email) {
  document.getElementById("loginEmail").value = email;
  document.getElementById("loginPass").value = "12345";
  authenticate(email, "12345");
}

function enterSession(rut, userData) {
  currentRut = rut;
  currentUser = userData;
  lastQrStep = null;
  localStorage.setItem(SESSION_KEY, rut);

  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("btnLogout").classList.remove("hidden");
  document.getElementById("topbarSpacer").classList.add("hidden");
  document.getElementById("topbarTitle").textContent = "Mi Credencial";

  renderUser();
  startDynamicQrTicker();
  subscribeAreaJefatura();
}

function logout() {
  currentRut = null;
  currentUser = null;
  lastQrStep = null;
  localStorage.removeItem(SESSION_KEY);

  if (qrTimerInterval) {
    clearInterval(qrTimerInterval);
    qrTimerInterval = null;
  }

  if (jefaturaUnsubscribe) {
    jefaturaUnsubscribe();
    jefaturaUnsubscribe = null;
  }

  document.getElementById("appView").classList.add("hidden");
  document.getElementById("loginView").classList.remove("hidden");
  document.getElementById("btnLogout").classList.add("hidden");
  document.getElementById("topbarSpacer").classList.remove("hidden");
  document.getElementById("topbarTitle").textContent = "Iniciar Sesión";
  document.getElementById("loginPass").value = "";
  showLoginError("");
}

// ============================================================================
// AFORO GENERAL EN TIEMPO REAL
// ============================================================================
onValue(ref(db, "estacionamiento"), (snapshot) => {
  const data = snapshot.val();
  if (!data) return;

  const capacity = typeof data.capacity === "number" ? data.capacity : 108;
  const occupied = typeof data.occupied === "number" ? data.occupied : 0;
  const free = Math.max(0, capacity - occupied);
  const pct = Math.min(100, Math.round((occupied / capacity) * 100));

  document.getElementById("freeSpotsBig").textContent = free;
  const labelEl = document.getElementById("freeSpotsLabel");
  labelEl.textContent = free === 0 ? "Estacionamiento lleno" : "cupos disponibles";
  labelEl.className = `aforo-free-sub${free === 0 ? " full" : free <= 15 ? " warn" : ""}`;

  const fill = document.getElementById("progressFill");
  fill.style.width = `${pct}%`;
  fill.style.background = free === 0 ? "#f04444" : free <= 15 ? "#f59e0b" : "#12a150";

  document.getElementById("aforoDetail").textContent = `Ocupados: ${occupied} / ${capacity}`;
});

// ============================================================================
// CREDENCIAL Y QR DINÁMICO 21x21 (60 SEGUNDOS)
// ============================================================================
function getRolLabel(rol) {
  return rol === "jefe_carrera" ? "Jefe de Carrera" : rol === "docente" ? "Docente" : "Alumno";
}

function renderUser() {
  if (!currentUser) return;
  const rolLabel = getRolLabel(currentUser.rol);

  document.getElementById("userName").textContent = `Credencial ${rolLabel}`;
  document.getElementById("userSub").textContent = `RUT: ${currentRut} · ${currentUser.area || "ST"}`;
  document.getElementById("userRolePill").textContent = rolLabel;

  refreshDynamicQr(true);
}

function refreshDynamicQr(force = false) {
  if (!currentRut) return;
  const q = getDynamicQrState(currentRut);

  const bar = document.getElementById("qrTimerBar");
  const txt = document.getElementById("qrTimerText");
  const zoomTxt = document.getElementById("qrZoomTimerText");

  if (bar) {
    bar.style.width = `${(q.remaining / 60) * 100}%`;
    bar.style.background = q.remaining <= 10 ? "#f59e0b" : "#12a150";
  }
  if (txt) txt.textContent = `Actualiza en ${q.remaining}s`;
  if (zoomTxt) zoomTxt.textContent = `Actualiza en ${q.remaining}s`;

  if (force || q.step !== lastQrStep) {
    lastQrStep = q.step;
    renderQr21x21("qrContainer", 8, q.payload);
    const zoomModal = document.getElementById("qrZoomModal");
    if (zoomModal && !zoomModal.classList.contains("hidden")) {
      renderQr21x21("qrZoomContainer", 12, q.payload);
    }
  }
}

function startDynamicQrTicker() {
  if (qrTimerInterval) clearInterval(qrTimerInterval);
  qrTimerInterval = setInterval(() => refreshDynamicQr(false), 1000);
}

function renderQr21x21(containerId, cellSize, payloadText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (typeof qrcode !== "function") {
    container.textContent = payloadText;
    return;
  }

  try {
    // Modo Alphanumeric: hasta 20 caracteres en Versión 1 (21x21) sin overflow
    const qr = qrcode(0, "M");
    qr.addData(payloadText, "Alphanumeric");
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize, margin: 1 });
  } catch (err) {
    console.error("Error generando QR:", err);
    container.textContent = payloadText;
  }
}

function openQrZoom() {
  if (!currentRut) return;
  const q = getDynamicQrState(currentRut);
  renderQr21x21("qrZoomContainer", 12, q.payload);
  document.getElementById("qrZoomName").textContent = `RUT ${currentRut} · ${getRolLabel(currentUser?.rol)}`;
  document.getElementById("qrZoomModal").classList.remove("hidden");
  refreshDynamicQr(true);
}

function closeQrZoom() {
  document.getElementById("qrZoomModal").classList.add("hidden");
}

// ============================================================================
// LÓGICA DE JEFATURA (OCULTA PARA ALUMNOS, SIN NOMBRES)
// ============================================================================
function subscribeAreaJefatura() {
  if (jefaturaUnsubscribe) {
    jefaturaUnsubscribe();
    jefaturaUnsubscribe = null;
  }

  const jefeCard = document.getElementById("jefeCard");
  const docenteCard = document.getElementById("docenteAreaCard");

  if (!currentUser || currentUser.rol === "alumno") {
    jefeCard.classList.add("hidden");
    docenteCard.classList.add("hidden");
    return;
  }

  const area = currentUser.area || "Informática";
  const areaRef = ref(db, `jefatura/${area}`);

  jefaturaUnsubscribe = onValue(areaRef, (snap) => {
    const spot = snap.val() || { released: false };

    if (currentUser.rol === "jefe_carrera") {
      docenteCard.classList.add("hidden");
      jefeCard.classList.remove("hidden");
      document.getElementById("jefeAreaName").textContent = area;

      const btn = document.getElementById("btnToggleJefe");
      const desc = document.getElementById("jefeStatusDesc");

      if (spot.released) {
        desc.textContent = spot.occupiedByDocente
          ? `Prestaste tu espacio (${area}) y ya fue ocupado por un docente de tu área.`
          : `Tu espacio está PRESTADO hoy exclusivamente para docentes del área ${area}.`;
        btn.textContent = "Dejar de prestar mi espacio";
        btn.classList.add("released");
      } else {
        desc.textContent = `Si hoy no usarás tu estacionamiento, préstalo para docentes del área ${area}.`;
        btn.textContent = "Prestar mi espacio hoy";
        btn.classList.remove("released");
      }
    } else if (currentUser.rol === "docente") {
      jefeCard.classList.add("hidden");
      if (spot.released && !spot.occupiedByDocente) {
        docenteCard.classList.remove("hidden");
        document.getElementById("docenteAreaName").textContent = area;
        document.getElementById("docenteAreaMsg").textContent =
          `Jefatura de ${area} prestó su estacionamiento hoy. Puedes ingresar directo aunque esté lleno.`;
      } else {
        docenteCard.classList.add("hidden");
      }
    }
  });
}

async function toggleJefeSpot() {
  if (!currentUser || currentUser.rol !== "jefe_carrera") return;
  const area = currentUser.area || "Informática";
  const areaRef = ref(db, `jefatura/${area}`);
  const snap = await get(areaRef);
  const current = snap.val() || { released: false };

  await set(areaRef, {
    released: !current.released,
    occupiedByDocente: false
  });
}

Object.assign(window, {
  handleLogin,
  quickLogin,
  logout,
  openQrZoom,
  closeQrZoom,
  toggleJefeSpot
});

(async () => {
  await ensureDemoUsers();
  const savedRut = localStorage.getItem(SESSION_KEY);
  if (savedRut) {
    const snap = await get(ref(db, `usuarios/${savedRut}`));
    if (snap.exists() && snap.val().activo !== false) {
      enterSession(savedRut, snap.val());
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  }
})();
