import { db, ref, onValue } from "./firebase-config.js";

let parkingData = { capacity: 108, occupied: 0 };
let logsArray = [];
let jefaturaData = {};

let weeklyChartInstance = null;
let typeChartInstance = null;
let gaugeChartInstance = null;
let yearlyChartInstance = null;
let hourlyAnalyticsInstance = null;

// Datos históricos agregados por año (100% anónimos)
const YEARLY_DATA = {
  "2026": {
    months: [420, 610, 3120, 3450, 3290, 2980, 1450, 3380, 2810, 3420, 3280, 0],
    fullDays: 38,
    peakDay: "Jueves",
    peakHour: "08:30",
    totalLabel: "28.4k"
  },
  "2025": {
    months: [380, 540, 2890, 3150, 3040, 2760, 1320, 3110, 2650, 3180, 3090, 1980],
    fullDays: 31,
    peakDay: "Martes",
    peakHour: "08:40",
    totalLabel: "28.1k"
  },
  "2024": {
    months: [310, 490, 2540, 2790, 2680, 2410, 1180, 2750, 2340, 2810, 2690, 1740],
    fullDays: 22,
    peakDay: "Jueves",
    peakHour: "08:45",
    totalLabel: "24.7k"
  }
};

// Elimina cualquier RUT o patrón personal residual de registros antiguos (protección de datos)
function anonymizeText(str) {
  return String(str || "Evento operativo")
    .replace(/RUT\s*:?\s*[0-9kK.\-]+/gi, "Validación QR")
    .replace(/\b[0-9]{7,9}-?[0-9kK]\b/g, "Credencial")
    .replace(/\(\s*Credencial\s*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Reloj en vivo
function updateClock() {
  const el = document.getElementById("liveClock");
  if (el) el.textContent = new Date().toLocaleTimeString("es-CL");
}
setInterval(updateClock, 1000);
updateClock();

// Atajo Cmd+F / Ctrl+F
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    const input = document.getElementById("globalSearch");
    if (input) {
      e.preventDefault();
      input.focus();
    }
  }
});

// ============================================================================
// CONEXIÓN EN TIEMPO REAL CON FIREBASE (SOLO MÉTRICAS ANÓNIMAS)
// ============================================================================
onValue(ref(db, "estacionamiento"), (snapshot) => {
  const data = snapshot.val() || {};
  parkingData.capacity = typeof data.capacity === "number" ? data.capacity : 108;
  parkingData.occupied = typeof data.occupied === "number" ? data.occupied : 0;

  logsArray = data.logs
    ? Object.values(data.logs)
        .map((l) => ({
          ...l,
          title: anonymizeText(l.title || "Movimiento"),
          detail: anonymizeText(l.detail || "Validación anónima")
        }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    : [];

  renderAll();
});

onValue(ref(db, "jefatura"), (snapshot) => {
  jefaturaData = snapshot.val() || {};
  renderJefatura();
  renderKPIs();
});

function renderAll() {
  renderKPIs();
  renderWeeklyPreviewChart();
  renderTypeChart();
  renderGaugeChart();
  renderLogsPreview();
  renderFullLogsTable();
  renderAnalyticsView();
  renderJefatura();
}

// ============================================================================
// NAVEGACIÓN DE PESTAÑAS DEL SIDEBAR
// ============================================================================
function switchTab(tabId) {
  document.querySelectorAll(".tab-view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`tab-${tabId}`)?.classList.add("active");

  document.querySelectorAll(".sidebar .nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tabId);
  });

  if (tabId === "analitica") renderAnalyticsView();
  if (tabId === "registros") renderFullLogsTable();
}

function handleGlobalSearch() {
  renderLogsPreview();
  renderFullLogsTable();
}

// ============================================================================
// KPIs E INDICADORES OPERATIVOS
// ============================================================================
function renderKPIs() {
  const { capacity, occupied } = parkingData;
  const free = Math.max(0, capacity - occupied);

  document.getElementById("kpiAforo").innerHTML = `${occupied} <small>/ ${capacity}</small>`;
  document.getElementById("kpiAforoSub").textContent = `${free} cupos disponibles ahora`;

  const entries = logsArray.filter((l) => l.kind === "plus");
  const qrEntries = entries.filter((l) => (l.title || "").toUpperCase().includes("QR")).length;
  const exits = logsArray.filter((l) => l.kind === "minus").length;
  const invalids = logsArray.filter((l) => l.kind === "invalid").length;

  document.getElementById("kpiEntries").textContent = entries.length;
  document.getElementById("kpiEntriesSub").textContent = `${qrEntries} por QR · ${entries.length - qrEntries} manual/visitas`;

  document.getElementById("kpiExits").textContent = exits;
  document.getElementById("kpiExitsSub").textContent = `${invalids} QR rechazados`;

  const releasedList = Object.values(jefaturaData).filter((j) => j && j.released);
  const availableJefe = releasedList.filter((j) => !j.occupiedByDocente && !j.claimedBy).length;
  document.getElementById("kpiJefatura").textContent = `${releasedList.length} / 10`;
  document.getElementById("kpiJefaturaSub").textContent =
    availableJefe > 0
      ? `${availableJefe} disponible(s) para docentes`
      : releasedList.length > 0
      ? "Cupos prestados ocupados"
      : "Sin préstamos activos hoy";

  document.getElementById("navLogsBadge").textContent = logsArray.length;

  // Indicadores operativos en la tarjeta oscura
  const qrPct = entries.length > 0 ? Math.round((qrEntries / entries.length) * 100) : 0;
  const totalScans = qrEntries + invalids;
  const rejectPct = totalScans > 0 ? Math.round((invalids / totalScans) * 100) : 0;

  const qrRateEl = document.getElementById("statQrRate");
  const rejectRateEl = document.getElementById("statRejectRate");
  if (qrRateEl) qrRateEl.textContent = `${qrPct}%`;
  if (rejectRateEl) rejectRateEl.textContent = `${rejectPct}%`;
}

// ============================================================================
// GRÁFICOS DEL RESUMEN
// ============================================================================
function renderWeeklyPreviewChart() {
  const baseWeek = [148, 182, 169, 191, 134, 62, 18];
  const counts = [...baseWeek];

  logsArray.forEach((l) => {
    if (l.kind === "plus" && typeof l.timestamp === "number") {
      const jsDay = new Date(l.timestamp).getDay();
      const idx = jsDay === 0 ? 6 : jsDay - 1;
      counts[idx] += 1;
    }
  });

  const ctx = document.getElementById("weeklyPreviewChart").getContext("2d");
  const colors = counts.map((v) => (v >= 175 ? "#14532d" : "#4ade80"));

  if (weeklyChartInstance) {
    weeklyChartInstance.data.datasets[0].data = counts;
    weeklyChartInstance.data.datasets[0].backgroundColor = colors;
    weeklyChartInstance.update();
    return;
  }

  weeklyChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"],
      datasets: [
        {
          label: "Ingresos promedio",
          data: counts,
          backgroundColor: colors,
          borderRadius: 14,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "#f1f5f9" } }
      }
    }
  });
}

function renderTypeChart() {
  let qrAlumno = 0, qrDocente = 0, visitas = 0, manual = 0, invalidos = 0;

  logsArray.forEach((l) => {
    const t = (l.title || "").toLowerCase();
    if (l.kind === "invalid") invalidos += 1;
    else if (t.includes("alumno")) qrAlumno += 1;
    else if (t.includes("docente") || t.includes("jefe")) qrDocente += 1;
    else if (t.includes("visita")) visitas += 1;
    else manual += 1;
  });

  const values = [qrAlumno, qrDocente, visitas, manual, invalidos];
  const hasData = values.some((v) => v > 0);
  const ctx = document.getElementById("typeChart").getContext("2d");

  if (typeChartInstance) {
    typeChartInstance.data.datasets[0].data = hasData ? values : [1];
    typeChartInstance.data.labels = hasData
      ? ["Alumnos", "Docentes", "Visitas", "Manual", "Rechazos QR"]
      : ["Sin datos"];
    typeChartInstance.data.datasets[0].backgroundColor = hasData
      ? ["#14532d", "#22c55e", "#0ea5e9", "#94a3b8", "#f59e0b"]
      : ["#e5e7eb"];
    typeChartInstance.update();
    return;
  }

  typeChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: hasData ? ["Alumnos", "Docentes", "Visitas", "Manual", "Rechazos QR"] : ["Sin datos"],
      datasets: [
        {
          data: hasData ? values : [1],
          backgroundColor: hasData
            ? ["#14532d", "#22c55e", "#0ea5e9", "#94a3b8", "#f59e0b"]
            : ["#e5e7eb"],
          borderWidth: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } }
    }
  });
}

function renderGaugeChart() {
  const { capacity, occupied } = parkingData;
  const pct = capacity > 0 ? Math.min(100, Math.round((occupied / capacity) * 100)) : 0;
  document.getElementById("gaugePercent").textContent = `${pct}%`;

  const ctx = document.getElementById("gaugeChart").getContext("2d");
  const dataVals = [pct, Math.max(0, 100 - pct)];

  if (gaugeChartInstance) {
    gaugeChartInstance.data.datasets[0].data = dataVals;
    gaugeChartInstance.update();
    return;
  }

  gaugeChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Ocupado", "Disponible"],
      datasets: [{ data: dataVals, backgroundColor: ["#14532d", "#e5e7eb"], borderWidth: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: -90,
      circumference: 180,
      cutout: "76%",
      plugins: { legend: { display: false } }
    }
  });
}

// ============================================================================
// FLUJO ANÓNIMO (PREVIEW Y TABLA COMPLETA)
// ============================================================================
function getFilteredLogs() {
  const search = (document.getElementById("globalSearch").value || "").toLowerCase().trim();
  const kindFilter = document.getElementById("filterKind")?.value || "all";

  return logsArray.filter((l) => {
    if (kindFilter !== "all" && l.kind !== kindFilter) return false;
    if (search) {
      const txt = `${l.title || ""} ${l.detail || ""} ${l.time || ""}`.toLowerCase();
      if (!txt.includes(search)) return false;
    }
    return true;
  });
}

function renderLogsPreview() {
  const listEl = document.getElementById("logsPreviewList");
  const filtered = getFilteredLogs();

  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="muted-empty">No hay eventos recientes.</p>`;
    return;
  }

  listEl.innerHTML = filtered
    .slice(0, 8)
    .map((l) => {
      const symbol = l.kind === "plus" ? "↑" : l.kind === "minus" ? "↓" : "!";
      const badgeText = l.kind === "plus" ? "+1 Ingreso" : l.kind === "minus" ? "-1 Salida" : "Rechazado";
      return `
        <div class="log-row">
          <div class="log-avatar ${l.kind || ""}">${symbol}</div>
          <div class="log-info">
            <strong>${l.title}</strong>
            <span>${l.detail}</span>
          </div>
          <div class="log-right">
            <span class="log-status ${l.kind || ""}">${badgeText}</span>
            <div>${l.time || "—"}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderFullLogsTable() {
  const tbody = document.getElementById("fullLogsTableBody");
  const filtered = getFilteredLogs();
  document.getElementById("logsCountPill").textContent = `${filtered.length} eventos`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-empty">No hay eventos que coincidan.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((l) => {
      const badgeText = l.kind === "plus" ? "+1 Ingreso" : l.kind === "minus" ? "-1 Salida" : "Rechazado (0)";
      return `
        <tr>
          <td><strong>${l.time || "—"}</strong></td>
          <td>${l.title}</td>
          <td>${l.detail}</td>
          <td><span class="log-status ${l.kind || ""}">${badgeText}</span></td>
        </tr>
      `;
    })
    .join("");
}

// ============================================================================
// ANALÍTICA (AÑOS Y FLUJO HORARIO EN VIVO)
// ============================================================================
function renderAnalyticsView() {
  const year = document.getElementById("analyticsYearSelect").value || "2026";
  const info = YEARLY_DATA[year] || YEARLY_DATA["2026"];

  document.getElementById("lblChartYear").textContent = year;
  document.getElementById("insightPeakDay").textContent = info.peakDay;
  document.getElementById("insightPeakHour").textContent = info.peakHour;
  document.getElementById("insightFullDays").textContent = info.fullDays;
  document.getElementById("insightYearLabel").textContent = `Temporada ${year}`;
  document.getElementById("insightYearTotal").textContent = info.totalLabel;

  const monthsData = [...info.months];
  if (year === "2026") {
    const liveEntries = logsArray.filter((l) => l.kind === "plus").length;
    monthsData[10] += liveEntries;
  }

  const ctxYear = document.getElementById("yearlyChart").getContext("2d");
  if (yearlyChartInstance) {
    yearlyChartInstance.data.datasets[0].data = monthsData;
    yearlyChartInstance.update();
  } else {
    yearlyChartInstance = new Chart(ctxYear, {
      type: "line",
      data: {
        labels: ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"],
        datasets: [
          {
            label: "Vehículos ingresados",
            data: monthsData,
            borderColor: "#14532d",
            backgroundColor: "rgba(20, 83, 45, 0.12)",
            fill: true,
            tension: 0.35,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: "#f1f5f9" } }
        }
      }
    });
  }

  const buckets = {};
  logsArray.forEach((log) => {
    let h = "Hoy";
    if (typeof log.timestamp === "number") {
      h = `${String(new Date(log.timestamp).getHours()).padStart(2, "0")}:00`;
    } else if (log.time && log.time.includes(":")) {
      h = `${log.time.slice(0, 2)}:00`;
    }
    if (!buckets[h]) buckets[h] = { in: 0, out: 0 };
    if (log.kind === "plus") buckets[h].in += 1;
    if (log.kind === "minus") buckets[h].out += 1;
  });

  const hLabels = Object.keys(buckets).sort();
  const hIn = hLabels.map((k) => buckets[k].in);
  const hOut = hLabels.map((k) => buckets[k].out);

  const ctxHourly = document.getElementById("hourlyAnalyticsChart").getContext("2d");
  if (hourlyAnalyticsInstance) {
    hourlyAnalyticsInstance.data.labels = hLabels.length ? hLabels : ["Sin datos"];
    hourlyAnalyticsInstance.data.datasets[0].data = hLabels.length ? hIn : [0];
    hourlyAnalyticsInstance.data.datasets[1].data = hLabels.length ? hOut : [0];
    hourlyAnalyticsInstance.update();
  } else {
    hourlyAnalyticsInstance = new Chart(ctxHourly, {
      type: "bar",
      data: {
        labels: hLabels.length ? hLabels : ["Sin datos"],
        datasets: [
          { label: "Ingresos", data: hLabels.length ? hIn : [0], backgroundColor: "#14532d", borderRadius: 10 },
          { label: "Salidas", data: hLabels.length ? hOut : [0], backgroundColor: "#86efac", borderRadius: 10 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
      }
    });
  }
}

// ============================================================================
// JEFATURAS POR ÁREA (SIN RUTS NI NOMBRES)
// ============================================================================
function renderJefatura() {
  const entries = Object.entries(jefaturaData);
  const html =
    entries.length === 0
      ? `<p class="muted-empty">Sin préstamos de jefatura activos hoy.</p>`
      : entries
          .map(([area, info]) => {
            const occupied = Boolean(info.occupiedByDocente || info.claimedBy);
            const statusText = !info.released
              ? "Reservado"
              : occupied
              ? "Ocupado (Docente)"
              : "Prestado a Docentes";
            const cls = info.released && !occupied ? "open" : "closed";
            return `
              <div class="jefe-pill-row ${info.released ? "released" : ""}">
                <div>
                  <strong>Área ${area}</strong>
                  <div style="font-size:11.5px;color:#6b7280;">Cupo exclusivo docentes</div>
                </div>
                <span class="jefe-badge ${cls}">${statusText}</span>
              </div>
            `;
          })
          .join("");

  document.getElementById("jefaturaList").innerHTML = html;
}

Object.assign(window, {
  switchTab,
  handleGlobalSearch,
  renderFullLogsTable,
  renderAnalyticsView
});
