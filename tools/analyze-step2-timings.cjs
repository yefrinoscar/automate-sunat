// Lee data/step2-timings.ndjson + data/automation.db y produce una tabla por boleta
// con las fases del Paso 2 y los gaps más caros (Top 10).
// Uso: node tools/analyze-step2-timings.cjs [runId]
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const NDJSON = path.join(ROOT, "data", "step2-timings.ndjson");
const DB = path.join(ROOT, "data", "automation.db");

const filterRunId = process.argv[2];

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2);
  return `${m}m ${r}s`;
}

if (!fs.existsSync(NDJSON)) {
  console.error(`No existe ${NDJSON}. ¿Corriste algún Paso 2 con la nueva instrumentación?`);
  process.exit(1);
}

const lines = fs
  .readFileSync(NDJSON, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const filteredEntries = filterRunId ? lines.filter((entry) => entry.runId === filterRunId) : lines;

if (filteredEntries.length === 0) {
  console.error("No hay entradas para el filtro indicado.");
  process.exit(1);
}

// Agrupar por sale (sólo entradas con sale)
const salesEntries = new Map();
for (const entry of filteredEntries) {
  if (!entry.sale) continue;
  const list = salesEntries.get(entry.sale) ?? [];
  list.push(entry);
  salesEntries.set(entry.sale, list);
}

// Para cada venta calcular fases marcadas con __mark__
function summarizeSale(saleId, entries) {
  entries.sort((a, b) => a.ts - b.ts);
  const first = entries[0]?.ts;
  const last = entries[entries.length - 1]?.ts;
  const total = last - first;

  const marks = entries.filter((e) => typeof e.step === "string" && e.step.startsWith("__mark__:"));
  const phases = {};
  for (const mark of marks) {
    phases[mark.step.replace("__mark__:", "")] = mark.ts;
  }

  // gaps por par de pasos consecutivos
  const gaps = [];
  for (let i = 1; i < entries.length; i += 1) {
    const dt = entries[i].ts - entries[i - 1].ts;
    gaps.push({
      dt,
      from: entries[i - 1].step,
      to: entries[i].step,
      atIndex: i,
    });
  }

  // top 10 gaps más caros
  const topGaps = [...gaps].sort((a, b) => b.dt - a.dt).slice(0, 10);

  return {
    saleId,
    runId: entries[0]?.runId,
    attemptId: entries[0]?.attemptId,
    first,
    last,
    total,
    phases,
    gaps,
    topGaps,
    stepCount: entries.length,
  };
}

const summaries = [...salesEntries.entries()].map(([sale, entries]) => summarizeSale(sale, entries));
summaries.sort((a, b) => a.first - b.first);

console.log("=================== TIEMPOS REALES DEL PASO 2 (instrumentación fina) ===================\n");

if (filterRunId) console.log(`runId filtrado: ${filterRunId}\n`);

const PHASE_PAIRS = [
  ["sale_start", "prepare_submission_start", "Cola interna previa"],
  ["prepare_submission_start", "prepare_submission_end", "prepareSubmission (login + form + items)"],
  ["prepare_submission_end", "submit_start", "Pre-submit (workflow updates)"],
  ["submit_start", "submit_end", "submit (Emitir + Aceptar + descarga)"],
  ["submit_end", "sale_end", "Post-submit (registro DB)"],
];

let grand = 0;
const colWidths = { sale: 14, total: 12 };

for (const summary of summaries) {
  console.log(`\n── Boleta ${summary.saleId} (attempt ${summary.attemptId.slice(0, 8)} | run ${summary.runId?.slice(0, 8) ?? "?"})`);
  console.log(`   total: ${fmtMs(summary.total)} | logs: ${summary.stepCount}`);
  for (const [from, to, label] of PHASE_PAIRS) {
    if (summary.phases[from] && summary.phases[to]) {
      const dt = summary.phases[to] - summary.phases[from];
      console.log(`     · ${label.padEnd(45)} ${fmtMs(dt)}`);
    }
  }
  console.log("   Top 5 gaps más largos:");
  for (const gap of summary.topGaps.slice(0, 5)) {
    const fromTrunc = (gap.from || "").slice(0, 70);
    const toTrunc = (gap.to || "").slice(0, 70);
    console.log(`       [${fmtMs(gap.dt).padStart(8)}] ${fromTrunc} → ${toTrunc}`);
  }
  grand += summary.total || 0;
}

console.log(`\n========================================================================================`);
console.log(`Total acumulado por boletas medidas: ${fmtMs(grand)} (${summaries.length} boletas)`);
if (summaries.length > 0) {
  console.log(`Promedio por boleta: ${fmtMs(grand / summaries.length)}`);
}

// si tenemos sqlite, también imprimimos status final
try {
  const db = new Database(DB, { readonly: true });
  const ids = summaries.map((s) => s.attemptId).filter(Boolean);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, sale_external_id, status, error_message FROM invoice_attempts WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    console.log("\n--- Estado final de cada attempt según DB ---");
    for (const row of rows) {
      console.log(
        `   ${row.sale_external_id} (${row.id.slice(0, 8)}) → ${row.status}${row.error_message ? `  | ${row.error_message.slice(0, 120)}` : ""}`,
      );
    }
  }
} catch {
  /* opcional */
}
