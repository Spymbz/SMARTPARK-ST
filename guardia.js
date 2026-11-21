import {
  db,
  ref,
  onValue,
  onDisconnect,
  get,
  set,
  update,
  push,
  runTransaction,
  serverTimestamp,
  parseAndVerifyDynamicQr
} from "./firebase-config.js";

const CACHE_KEY = "smartpark_guardia_cache_v1";
const QUEUE_KEY = "smartpark_guardia_queue_v1";

const parkingRef = ref(db, "estacionamiento");
const occupiedRef = ref(db, "estacionamiento/occupied");
const logsRef = ref(db, "estacionamiento/logs");
const garitaRef = ref(db, "garita");

// Canal local: BroadcastChannel (misma PC) + garita/localRelay (cuando se simula corte entre móvil y PC)
const localLink = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("smartpark_local_link") : null;

function notifyLocalDisplay(action, extra = {}) {
  const payload = {
    action,
    occupied: state.occupied,
    capacity: state.capacity,
    offline: isOffline(),
    ts: Date.now(),
    ...extra
  };
  if (localLink) {
    localLink.postMessage(payload);
  }
  // Si es corte simulado (hay red real), reenviar por enlace local hacia la pantalla grande del PC
  if (forceOfflineSim && firebaseConnected && navigator.onLine) {
    set(ref(db, "garita/localRelay"), payload).catch(() => {});
  }
}

// Cargar caché local para arranque instantáneo incluso sin internet
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        capacity: state.capacity,
        occupied: state.occupied,
        logs: state.logs.slice(0, 20),
        usuarios: cachedUsers,
        jefatura: cachedJefatura
      })
    );
  } catch {
    // ignore quota errors
  }
}

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveQueue() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(offlineQueue));
  } catch {
    // ignore
  }
}

const initialCache = loadCache();
let state = {
  capacity: 108,
  occupied: initialCache?.occupied ?? 0,
  loaded: Boolean(initialCache),
  logs: initialCache?.logs ?? []
};
let cachedUsers = initialCache?.usuarios ?? {
  "201112223": { rol: "alumno", area: "Informática", activo: true },
  "148765432": { rol: "docente", area: "Informática", activo: true },
  "112233445": { rol: "jefe_carrera", area: "Informática", activo: true }
};
let cachedJefatura = initialCache?.jefatura ?? {};
let offlineQueue = loadQueue();

let firebaseConnected = navigator.onLine;
let forceOfflineSim = false;
let isSyncing = false;

let pendingAction = null;
let cameraStream = null;
let scanAnimationId = null;
let feedbackTimer = null;

function isOffline() {
  return !navigator.onLine || !firebaseConnected || forceOfflineSim;
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5);
}

// Registrar Service Worker para que la app cargue sin internet
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// ============================================================================
// DETECCIÓN DE CONEXIÓN + PRESENCIA DE GARITA EN FIREBASE (onDisconnect)
// ============================================================================
onValue(ref(db, ".info/connected"), (snap) => {
  firebaseConnected = Boolean(snap.val());

  if (firebaseConnected && !forceOfflineSim) {
    // Avisar a Dashboard/DEMO que la garita está en línea, y marcar offline si se corta
    onDisconnect(garitaRef).set({
      online: false,
      lastSeen: serverTimestamp()
    });
    set(garitaRef, {
      online: true,
      lastSeen: serverTimestamp()
    });

    syncOfflineQueue();
  }
  updateConnectionUI();
});

window.addEventListener("online", () => {
  updateConnectionUI();
  if (!isOffline()) syncOfflineQueue();
});

window.addEventListener("offline", () => {
  updateConnectionUI();
});

function updateConnectionUI() {
  const bar = document.getElementById("connStatusBar");
  const text = document.getElementById("connStatusText");
  const badge = document.getElementById("pendingBadge");
  const simBtn = document.getElementById("btnToggleOffline");
  if (!bar || !text || !badge) return;

  const offline = isOffline();
  bar.className = `conn-bar ${offline ? "offline" : "online"}`;

  if (offline) {
    text.textContent = forceOfflineSim
      ? "🟠 Modo Offline (Simulado) · Validación local activa"
      : "🟠 Sin internet · Modo Offline local activo";
  } else {
    text.textContent = isSyncing ? "🔄 Sincronizando movimientos..." : "● En línea · Sincronizado";
  }

  if (offlineQueue.length > 0) {
    badge.textContent = `${offlineQueue.length} pendiente${offlineQueue.length === 1 ? "" : "s"}`;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  if (simBtn) {
    simBtn.textContent = forceOfflineSim ? "Restaurar conexión" : "Simular corte de internet";
  }
}

async function toggleSimulatedOffline() {
  forceOfflineSim = !forceOfflineSim;
  if (forceOfflineSim) {
    await set(garitaRef, { online: false, lastSeen: serverTimestamp() }).catch(() => {});
    notifyLocalDisplay("status");
    showFeedback("🟠 Corte simulado: la garita ahora opera 100% offline.", "info");
  } else {
    await set(garitaRef, { online: true, lastSeen: serverTimestamp() }).catch(() => {});
    await syncOfflineQueue();
    notifyLocalDisplay("status");
  }
  closeHistoryModal();
  updateConnectionUI();
}

// ============================================================================
// SINCRONIZACIÓN AUTOMÁTICA AL RECUPERAR INTERNET
// ============================================================================
async function syncOfflineQueue() {
  if (isSyncing || isOffline() || offlineQueue.length === 0) return;
  isSyncing = true;
  updateConnectionUI();

  const totalToSync = offlineQueue.length;
  let syncedCount = 0;

  while (offlineQueue.length > 0 && !isOffline()) {
    const item = offlineQueue[0];
    try {
      if (item.op === "occupancy") {
        await runTransaction(occupiedRef, (currentVal) => {
          const current = typeof currentVal === "number" ? currentVal : 0;
          return Math.max(0, Math.min(state.capacity, current + item.delta));
        });
        await push(logsRef, {
          time: item.time,
          timestamp: serverTimestamp(),
          title: item.title,
          detail: `${item.detail} [Sync offline]`,
          delta: item.delta > 0 ? `+${item.delta}` : `${item.delta}`,
          kind: item.delta > 0 ? "plus" : "minus"
        });
      } else if (item.op === "jefe_claim") {
        await update(ref(db, `jefatura/${item.area}`), {
          occupiedByDocente: true
        });
        await push(logsRef, {
          time: item.time,
          timestamp: serverTimestamp(),
          title: "Ingreso QR Docente (Jefatura)",
          detail: `Cupo prestado · Área ${item.area} [Sync offline]`,
          delta: "Jefatura",
          kind: "plus"
        });
      } else if (item.op === "log_only") {
        await push(logsRef, {
          time: item.time,
          timestamp: serverTimestamp(),
          title: item.title,
          detail: `${item.detail} [Sync offline]`,
          delta: item.delta,
          kind: item.kind
        });
      }

      offlineQueue.shift();
      saveQueue();
      syncedCount++;
    } catch (err) {
      console.error("Error sincronizando cola offline:", err);
      break;
    }
  }

  isSyncing = false;
  updateConnectionUI();

  if (syncedCount > 0) {
    showFeedback(
      `✅ Conexión restaurada: ${syncedCount} de ${totalToSync} movimiento(s) sincronizados.`,
      "success"
    );
  }
}

// ============================================================================
// CONEXIÓN EN TIEMPO REAL CON FIREBASE + ACTUALIZACIÓN DE CACHÉ LOCAL
// ============================================================================
onValue(parkingRef, (snapshot) => {
  const data = snapshot.val();
  if (!data) {
    if (!isOffline()) {
      set(parkingRef, { capacity: 108, occupied: 0 });
    }
    return;
  }

  // Sincronizar capacidad real del recinto (108 calzas generales)
  if (data.capacity !== 108 && !isOffline()) {
    update(parkingRef, { capacity: 108 });
  }

  // Si hay movimientos offline pendientes, conservar el cálculo local hasta sincronizar
  if (offlineQueue.length === 0) {
    state.capacity = 108;
    state.occupied = Math.min(108, typeof data.occupied === "number" ? data.occupied : 0);
  }
  state.loaded = true;

  if (data.logs) {
    const remoteLogs = Object.values(data.logs)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 20);
    if (offlineQueue.length === 0) {
      state.logs = remoteLogs;
    }
  }

  saveCache();
  render();
});

onValue(ref(db, "usuarios"), (snapshot) => {
  if (snapshot.exists()) {
    cachedUsers = snapshot.val();
    saveCache();
  }
});

onValue(ref(db, "jefatura"), (snapshot) => {
  if (snapshot.exists()) {
    cachedJefatura = snapshot.val();
    saveCache();
  }
});

function render() {
  const free = Math.max(0, state.capacity - state.occupied);
  const pct = Math.min(100, Math.round((state.occupied / state.capacity) * 100));

  document.getElementById("aforoCurrent").textContent = state.occupied;
  document.getElementById("aforoMax").textContent = state.capacity;

  const freeEl = document.getElementById("freeText");
  freeEl.textContent =
    free === 0 ? "Estacionamiento lleno" : `${free} cupos disponibles`;
  freeEl.className = `aforo-free${free === 0 ? " full" : free <= 20 ? " warn" : ""}`;

  const fill = document.getElementById("progressFill");
  fill.style.width = `${pct}%`;
  fill.style.background = free === 0 ? "#f04444" : free <= 20 ? "#f59e0b" : "#12a150";

  const logList = document.getElementById("logList");
  if (state.logs.length === 0) {
    logList.innerHTML = `<li class="log-item"><div>Sin movimientos aún</div></li>`;
    return;
  }

  logList.innerHTML = state.logs
    .slice(0, 15)
    .map(
      (item) => `
      <li class="log-item ${item.kind || ""}">
        <div>
          <strong>${item.title}</strong>
          <div style="font-size:12px;color:#64748b;">${item.detail || ""}</div>
        </div>
        <div style="text-align:right;white-space:nowrap;">
          <strong>${item.delta}</strong>
          <div style="font-size:11px;color:#64748b;">${item.time || ""}</div>
        </div>
      </li>
    `
    )
    .join("");
}

function showFeedback(message, type = "success") {
  const banner = document.getElementById("feedbackBanner");
  banner.className = `feedback-banner ${type}`;
  banner.innerHTML = `
    <span>${message}</span>
    <button onclick="hideFeedback()" style="border:none;background:transparent;font-weight:800;cursor:pointer;color:inherit;">✕</button>
  `;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(hideFeedback, 4500);
}

function hideFeedback() {
  document.getElementById("feedbackBanner").classList.add("hidden");
}

// ============================================================================
// +1 / -1 CON CONFIRMACIÓN ("¿Estás seguro?") — ONLINE Y OFFLINE
// ============================================================================
function requestConfirm(delta, label) {
  if (delta > 0 && state.occupied >= state.capacity) {
    showFeedback(`Estacionamiento lleno (${state.capacity}/${state.capacity}).`, "error");
    return;
  }
  if (delta < 0 && state.occupied <= 0) {
    showFeedback("El aforo ya está en 0.", "error");
    return;
  }

  pendingAction = { delta, label };
  const next = state.occupied + delta;

  document.getElementById("confirmIcon").textContent = delta > 0 ? "🚗" : "↩️";
  document.getElementById("confirmTitle").textContent =
    delta > 0 ? "¿Sumar +1 ingreso?" : "¿Restar -1 salida?";
  document.getElementById("confirmDesc").textContent = `El aforo pasará a ${next} / ${state.capacity}.`;

  const btn = document.getElementById("btnConfirmExecute");
  btn.style.background = delta > 0 ? "#12a150" : "#f04444";
  btn.textContent = delta > 0 ? "Sí, sumar +1" : "Sí, restar -1";

  document.getElementById("confirmModal").classList.remove("hidden");
}

function closeConfirmModal() {
  pendingAction = null;
  document.getElementById("confirmModal").classList.add("hidden");
}

async function executeConfirmedAction() {
  if (!pendingAction) return;
  const { delta, label } = pendingAction;
  closeConfirmModal();

  const ok = await updateOccupancy(delta, label, "Confirmado por Guardia");
  if (ok) {
    showFeedback(
      delta > 0 ? "✅ Ingreso registrado (+1)" : "ℹ️ Salida registrada (-1)",
      delta > 0 ? "success" : "info"
    );
  }
}

function applyLocalUpdate(delta, title, detail, kindOverride = null, deltaOverride = null) {
  state.occupied = Math.max(0, Math.min(state.capacity, state.occupied + delta));
  state.logs.unshift({
    time: nowTime(),
    title,
    detail,
    delta: deltaOverride || (delta > 0 ? `+${delta}` : `${delta}`),
    kind: kindOverride || (delta > 0 ? "plus" : "minus")
  });
  saveCache();
  render();
}

async function updateOccupancy(delta, title, detail) {
  if (isOffline()) {
    if (state.occupied + delta < 0 || state.occupied + delta > state.capacity) {
      showFeedback("⚠️ Límite de aforo alcanzado.", "error");
      return false;
    }
    const time = nowTime();
    applyLocalUpdate(delta, title, `${detail} (Offline)`);
    offlineQueue.push({ op: "occupancy", delta, title, detail, time });
    saveQueue();
    updateConnectionUI();
    notifyLocalDisplay(delta > 0 ? "entry" : "exit");
    return true;
  }

  try {
    const result = await runTransaction(occupiedRef, (currentVal) => {
      const current = typeof currentVal === "number" ? currentVal : state.occupied;
      const next = current + delta;
      if (next < 0 || next > state.capacity) return;
      return next;
    });

    if (!result.committed) {
      showFeedback("⚠️ No se pudo actualizar el cupo (límite alcanzado).", "error");
      return false;
    }

    await push(logsRef, {
      time: nowTime(),
      timestamp: serverTimestamp(),
      title,
      detail,
      delta: delta > 0 ? `+${delta}` : `${delta}`,
      kind: delta > 0 ? "plus" : "minus"
    });

    return true;
  } catch (err) {
    // Si falla la red en medio de la operación, guardar en cola offline automáticamente
    const time = nowTime();
    applyLocalUpdate(delta, title, `${detail} (Offline)`);
    offlineQueue.push({ op: "occupancy", delta, title, detail, time });
    saveQueue();
    updateConnectionUI();
    notifyLocalDisplay(delta > 0 ? "entry" : "exit");
    return true;
  }
}

// ============================================================================
// CÁMARA QR REAL
// ============================================================================
async function openCameraScanner() {
  const modal = document.getElementById("cameraModal");
  const statusText = document.getElementById("cameraStatusText");
  const fallback = document.getElementById("cameraFallbackOverlay");
  const video = document.getElementById("cameraVideo");

  modal.classList.remove("hidden");
  fallback.classList.add("hidden");
  statusText.textContent = "Abriendo cámara...";

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusText.textContent = "Usa la cámara del teléfono o código manual";
    fallback.classList.remove("hidden");
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    video.srcObject = cameraStream;
    await video.play();
    statusText.textContent = "Apunta al código QR";
    startQrScanLoop();
  } catch {
    statusText.textContent = "Usa la cámara del teléfono o código manual";
    fallback.classList.remove("hidden");
  }
}

function startQrScanLoop() {
  const video = document.getElementById("cameraVideo");
  const canvas = document.getElementById("cameraCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function tick() {
    if (!cameraStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && typeof jsQR === "function") {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert"
      });
      if (code && code.data) {
        handleDecodedQr(code.data);
        return;
      }
    }
    scanAnimationId = requestAnimationFrame(tick);
  }
  scanAnimationId = requestAnimationFrame(tick);
}

function closeCameraScanner() {
  if (scanAnimationId) cancelAnimationFrame(scanAnimationId);
  scanAnimationId = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  document.getElementById("cameraVideo").srcObject = null;
  document.getElementById("cameraModal").classList.add("hidden");
}

function handleQrImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.getElementById("cameraCanvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      if (typeof jsQR === "function") {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          handleDecodedQr(code.data);
        } else {
          closeCameraScanner();
          showFeedback("❌ No se detectó un QR válido en la foto.", "error");
        }
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = "";
}

function validateManualQr() {
  const input = document.getElementById("manualQrInput");
  const val = (input.value || "").trim();
  if (!val) return;
  input.value = "";
  handleDecodedQr(val);
}

async function handleDecodedQr(rawData) {
  closeCameraScanner();
  const parsed = parseAndVerifyDynamicQr(rawData);

  if (!parsed.valid) {
    const detail = parsed.reason;
    if (isOffline()) {
      applyLocalUpdate(0, "QR Expirado / Inválido", `${detail} (Offline)`, "invalid", "0");
      offlineQueue.push({ op: "log_only", title: "QR Expirado / Inválido", detail, delta: "0", kind: "invalid", time: nowTime() });
      saveQueue();
      updateConnectionUI();
      notifyLocalDisplay("invalid");
    } else {
      await push(logsRef, { time: nowTime(), timestamp: serverTimestamp(), title: "QR Expirado / Inválido", detail, delta: "0", kind: "invalid" });
    }
    showFeedback(`❌ ${parsed.reason}. No se sumó ingreso.`, "error");
    return;
  }

  const cleanRut = parsed.rut;

  try {
    // Online consulta Firebase; Offline valida contra la caché local de usuarios (sin guardar RUT en logs)
    let userData = null;
    if (!isOffline()) {
      const userSnap = await get(ref(db, `usuarios/${cleanRut}`));
      if (userSnap.exists()) userData = userSnap.val();
    } else {
      userData = cachedUsers[cleanRut] || null;
    }

    if (!userData) {
      const detail = "Credencial no habilitada";
      if (isOffline()) {
        applyLocalUpdate(0, "QR No Autorizado", `${detail} (Offline)`, "invalid", "0");
        offlineQueue.push({ op: "log_only", title: "QR No Autorizado", detail, delta: "0", kind: "invalid", time: nowTime() });
        saveQueue();
        updateConnectionUI();
      } else {
        await push(logsRef, { time: nowTime(), timestamp: serverTimestamp(), title: "QR No Autorizado", detail, delta: "0", kind: "invalid" });
      }
      showFeedback("❌ Credencial no autorizada. No se sumó ingreso.", "error");
      return;
    }

    if (userData.activo === false) {
      showFeedback("❌ Credencial inactiva.", "error");
      return;
    }

    const rolLabel =
      userData.rol === "jefe_carrera"
        ? "Jefe de Carrera"
        : userData.rol === "docente"
        ? "Docente"
        : "Alumno";

    // Si es docente, verificar si hay un cupo de jefatura prestado en su área (registro anónimo)
    if (userData.rol === "docente" && userData.area) {
      let jefeInfo = cachedJefatura[userData.area];
      if (!isOffline()) {
        const jefeSnap = await get(ref(db, `jefatura/${userData.area}`));
        jefeInfo = jefeSnap.val();
      }
      if (jefeInfo && jefeInfo.released && !jefeInfo.occupiedByDocente && !jefeInfo.claimedBy) {
        if (isOffline()) {
          cachedJefatura[userData.area] = { ...jefeInfo, occupiedByDocente: true };
          applyLocalUpdate(0, "Ingreso QR Docente (Jefatura)", `Área ${userData.area} (Offline)`, "plus", "Jefatura");
          offlineQueue.push({
            op: "jefe_claim",
            area: userData.area,
            time: nowTime()
          });
          saveCache();
          saveQueue();
          updateConnectionUI();
          notifyLocalDisplay("docente_express", { area: userData.area });
        } else {
          await update(ref(db, `jefatura/${userData.area}`), {
            occupiedByDocente: true,
            claimedBy: null
          });
          await push(logsRef, {
            time: nowTime(),
            timestamp: serverTimestamp(),
            title: "Ingreso QR Docente (Jefatura)",
            detail: `Cupo prestado · Área ${userData.area}`,
            delta: "Jefatura",
            kind: "plus"
          });
        }
        showFeedback(
          `⭐ Docente validado: ingresa a cupo prestado de Jefatura (${userData.area}).`,
          "success"
        );
        return;
      }
    }

    if (state.occupied >= state.capacity) {
      showFeedback(`Estacionamiento lleno (${state.capacity}/${state.capacity}).`, "error");
      return;
    }

    const ok = await updateOccupancy(
      1,
      `Ingreso QR (${rolLabel})`,
      `Área ${userData.area || "General"} · Validación anónima`
    );

    if (ok) {
      showFeedback(
        `✅ ${rolLabel} validado — +1 ingreso${isOffline() ? " (Offline)" : ""}.`,
        "success"
      );
    }
  } catch (err) {
    console.error("Error validando RUT:", err);
    showFeedback("❌ Error al validar RUT.", "error");
  }
}

// ============================================================================
// VISITAS Y HISTORIAL (Sin nombres ni patentes por privacidad)
// ============================================================================
function openVisitModal() {
  document.getElementById("visitModal").classList.remove("hidden");
}

function closeVisitModal() {
  document.getElementById("visitModal").classList.add("hidden");
}

async function submitVisit(event) {
  event.preventDefault();
  if (state.occupied >= state.capacity) {
    closeVisitModal();
    showFeedback(`Estacionamiento lleno (${state.capacity}/${state.capacity}).`, "error");
    return;
  }
  const reason = document.getElementById("visitReason").value.trim() || "Visita autorizada";
  closeVisitModal();
  event.target.reset();

  const ok = await updateOccupancy(1, "Visita", reason);
  if (ok) {
    showFeedback(`✅ Visita ingresada (+1): ${reason}`, "success");
  }
}

function openHistoryModal() {
  document.getElementById("historyModal").classList.remove("hidden");
}

function closeHistoryModal() {
  document.getElementById("historyModal").classList.add("hidden");
}

async function resetGuardiaData() {
  offlineQueue = [];
  saveQueue();
  state.occupied = 0;
  state.logs = [];
  saveCache();
  if (!isOffline()) {
    await set(parkingRef, { capacity: 108, occupied: 0 });
  }
  closeHistoryModal();
  hideFeedback();
  updateConnectionUI();
  render();
}

Object.assign(window, {
  requestConfirm,
  closeConfirmModal,
  executeConfirmedAction,
  openCameraScanner,
  closeCameraScanner,
  handleQrImageUpload,
  validateManualQr,
  openVisitModal,
  closeVisitModal,
  submitVisit,
  openHistoryModal,
  closeHistoryModal,
  resetGuardiaData,
  toggleSimulatedOffline,
  hideFeedback
});

render();
updateConnectionUI();
