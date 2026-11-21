// Configuración compartida de Firebase Realtime Database para todas las ventanas
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  onDisconnect,
  get,
  set,
  update,
  push,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_FIREBASE_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Token QR dinámico de 60 segundos (compartido entre Usuario, DEMO y Guardia)
function computeDynamicCode(rut, step) {
  const input = `${rut}:${step}:SMARTPARK_ST_60S`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return String((hash >>> 0) % 1000000).padStart(6, "0");
}

function getDynamicQrState(rut) {
  const clean = String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const step = Math.floor(nowSec / 60);
  const remaining = 60 - (nowSec % 60);
  const code = computeDynamicCode(clean, step);
  return {
    rut: clean,
    payload: `${clean}-${code}`,
    remaining,
    step
  };
}

function parseAndVerifyDynamicQr(rawData) {
  const text = String(rawData || "").trim().toUpperCase();
  const match = text.match(/^([0-9]{7,9}[0-9K])-([0-9]{6})$/);
  if (!match) return { valid: false, reason: "Formato QR no válido o expirado" };

  const [, rut, code] = match;
  const nowSec = Math.floor(Date.now() / 1000);
  const step = Math.floor(nowSec / 60);
  const secInStep = nowSec % 60;

  // Acepta el código del bloque actual de 60s (y 10s de gracia al cambio de minuto)
  const validCurrent = computeDynamicCode(rut, step) === code;
  const validPrevGrace = secInStep < 10 && computeDynamicCode(rut, step - 1) === code;

  if (!validCurrent && !validPrevGrace) {
    return { valid: false, rut, reason: "Código QR expirado (superó los 60s)" };
  }
  return { valid: true, rut };
}

export {
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
  getDynamicQrState,
  parseAndVerifyDynamicQr
};

