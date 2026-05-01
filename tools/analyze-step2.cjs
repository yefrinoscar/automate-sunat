// Tool de análisis: lee data/automation.db y mide tiempos del Paso 2 por venta y por step.
// Uso: node tools/analyze-step2.cjs
const path = require("node:path");
const Database = require("better-sqlite3");

const dbPath = path.resolve(__dirname, "..", "data", "automation.db");
const db = new Database(dbPath, { readonly: true });

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(1);
  return `${m}m ${r}s`;
}

function asJson(value) {
  if (value == null) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

const runs = db
  .prepare(
    `SELECT id, reason, status, summary_json, started_at, ended_at FROM runs ORDER BY started_at ASC`,
  )
  .all();

const attempts = db
  .prepare(
    `SELECT id, run_id, sale_external_id, status, created_at, updated_at FROM invoice_attempts ORDER BY created_at ASC`,
  )
  .all();

const SUNAT_STAGE_ID = "registrar_facturas_sunat";
const SUNAT_STEP_IDS = ["abrir_sunat", "cargar_factura_en_sunat", "esperar_revision", "enviar_factura"];

const SUNAT_PHASE_LABELS = {
  abrir_sunat: "Abrir SUNAT",
  cargar_factura_en_sunat: "Cargar comprobante",
  esperar_revision: "Validación automática",
  enviar_factura: "Registrar/Emitir + descargar",
};

function classifyLog(entry) {
  if (!entry || entry.stageId !== SUNAT_STAGE_ID) return null;
  const stepId = entry.stepId;
  if (!SUNAT_STEP_IDS.includes(stepId)) return null;
  return stepId;
}

const runsAnalysis = [];

for (const run of runs) {
  const summary = asJson(run.summary_json) || {};
  const logs = Array.isArray(summary.logs) ? summary.logs : [];
  const sunatLogs = logs
    .map((entry) => ({ ...entry, _t: Date.parse(entry.at) }))
    .filter((entry) => Number.isFinite(entry._t) && entry.stageId === SUNAT_STAGE_ID);

  if (sunatLogs.length === 0) continue;

  const runDurationMs = run.ended_at ? Date.parse(run.ended_at) - Date.parse(run.started_at) : null;

  const sunatFirst = sunatLogs[0]?._t;
  const sunatLast = sunatLogs[sunatLogs.length - 1]?._t;
  const stepDurationMs = sunatFirst && sunatLast ? sunatLast - sunatFirst : null;

  // duraciones agregadas por step (sumando todos los segmentos por venta)
  const phaseTotals = Object.fromEntries(SUNAT_STEP_IDS.map((id) => [id, 0]));

  // por venta (saleExternalId)
  const perSale = new Map();

  // recorrer logs en orden y emitir segmentos cuando cambia stepId
  let cursor = null; // { saleId, stepId, t }
  for (const entry of sunatLogs) {
    const stepId = classifyLog(entry);
    if (!stepId) continue;
    const saleId = entry.saleExternalId || cursor?.saleId || "(global)";
    if (cursor) {
      const dt = entry._t - cursor.t;
      if (dt > 0 && dt < 30 * 60 * 1000) {
        phaseTotals[cursor.stepId] += dt;
        if (!perSale.has(cursor.saleId)) {
          perSale.set(cursor.saleId, { total: 0, byStep: Object.fromEntries(SUNAT_STEP_IDS.map((id) => [id, 0])) });
        }
        const bucket = perSale.get(cursor.saleId);
        bucket.byStep[cursor.stepId] += dt;
        bucket.total += dt;
      }
    }
    cursor = { saleId, stepId, t: entry._t };
  }

  runsAnalysis.push({
    runId: run.id,
    reason: run.reason,
    status: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    runDurationMs,
    stepDurationMs,
    summary: {
      observedSales: summary.observedSales,
      queuedSales: summary.queuedSales,
      submittedInvoices: summary.submittedInvoices,
      failedInvoices: summary.failedInvoices,
      cancelledInvoices: summary.cancelledInvoices,
    },
    phaseTotals,
    perSale: [...perSale.entries()].map(([saleId, v]) => ({ saleId, ...v })),
    logsCount: sunatLogs.length,
  });
}

// agregados globales
const aggregate = {
  runsConSunat: runsAnalysis.length,
  totalSunatPhaseMs: runsAnalysis.reduce((acc, r) => acc + (r.stepDurationMs || 0), 0),
  byStep: Object.fromEntries(SUNAT_STEP_IDS.map((id) => [id, 0])),
  ventasEnviadas: runsAnalysis.reduce((a, r) => a + (r.summary.submittedInvoices || 0), 0),
  ventasFallidas: runsAnalysis.reduce((a, r) => a + (r.summary.failedInvoices || 0), 0),
  ventasCanceladas: runsAnalysis.reduce((a, r) => a + (r.summary.cancelledInvoices || 0), 0),
};
for (const r of runsAnalysis) {
  for (const id of SUNAT_STEP_IDS) {
    aggregate.byStep[id] += r.phaseTotals[id] || 0;
  }
}

console.log("=== Resumen general (Paso 2 / SUNAT) ===");
console.log(`Runs con actividad SUNAT: ${aggregate.runsConSunat}`);
console.log(`Tiempo total acumulado en Paso 2: ${fmtMs(aggregate.totalSunatPhaseMs)}`);
console.log(`Boletas emitidas: ${aggregate.ventasEnviadas} | falladas: ${aggregate.ventasFallidas} | canceladas: ${aggregate.ventasCanceladas}`);
console.log("\nTiempo acumulado por sub-paso:");
for (const id of SUNAT_STEP_IDS) {
  console.log(`  - ${SUNAT_PHASE_LABELS[id]} (${id}): ${fmtMs(aggregate.byStep[id])}`);
}

console.log("\n=== Detalle por run ===");
for (const r of runsAnalysis) {
  console.log(`\nRun ${r.runId} | reason=${r.reason} status=${r.status}`);
  console.log(`  iniciado=${r.startedAt} | terminado=${r.endedAt ?? "n/a"}`);
  console.log(`  duración total run: ${fmtMs(r.runDurationMs)} | duración fase Paso 2: ${fmtMs(r.stepDurationMs)}`);
  console.log(
    `  ventas: observadas=${r.summary.observedSales ?? 0} queue=${r.summary.queuedSales ?? 0} ok=${r.summary.submittedInvoices ?? 0} fail=${r.summary.failedInvoices ?? 0} cancel=${r.summary.cancelledInvoices ?? 0}`,
  );
  console.log("  por sub-paso:");
  for (const id of SUNAT_STEP_IDS) {
    console.log(`    - ${SUNAT_PHASE_LABELS[id]}: ${fmtMs(r.phaseTotals[id])}`);
  }
  if (r.perSale.length > 0) {
    console.log("  por venta:");
    for (const sale of r.perSale) {
      console.log(`    · ${sale.saleId}: total=${fmtMs(sale.total)}`);
      for (const id of SUNAT_STEP_IDS) {
        const v = sale.byStep[id];
        if (v > 0) console.log(`        ${SUNAT_PHASE_LABELS[id]}: ${fmtMs(v)}`);
      }
    }
  }
}

// promedio por boleta enviada
if (aggregate.ventasEnviadas > 0) {
  const avg = aggregate.totalSunatPhaseMs / aggregate.ventasEnviadas;
  console.log(`\nPromedio Paso 2 por boleta emitida (con éxito): ${fmtMs(avg)}`);
}
