const path = require("node:path");
const Database = require("better-sqlite3");

const dbPath = path.resolve(__dirname, "..", "data", "automation.db");
const db = new Database(dbPath, { readonly: true });

const runs = db
  .prepare(`SELECT id, reason, status, summary_json, started_at, ended_at FROM runs ORDER BY started_at ASC`)
  .all();

const SUNAT_STAGE_ID = "registrar_facturas_sunat";

const errors = [];
for (const run of runs) {
  let summary;
  try {
    summary = JSON.parse(run.summary_json);
  } catch {
    continue;
  }
  if (!summary || !Array.isArray(summary.logs)) continue;
  for (const entry of summary.logs) {
    if (entry?.level === "error" && entry.stageId === SUNAT_STAGE_ID) {
      errors.push({
        runId: run.id,
        at: entry.at,
        stepId: entry.stepId,
        sale: entry.saleExternalId,
        message: entry.message,
      });
    }
  }
}

console.log("=== Errores en Paso 2 (registrar_facturas_sunat) ===\n");
const counter = new Map();
for (const e of errors) {
  // Mensaje normalizado para agrupar
  const key = (e.message || "").replace(/\s+/g, " ").slice(0, 160);
  counter.set(key, (counter.get(key) || 0) + 1);
}

const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Total de eventos error: ${errors.length}\n`);
console.log("Top mensajes:");
for (const [msg, n] of sorted.slice(0, 15)) {
  console.log(`  [${n}] ${msg}`);
}

console.log("\n--- Últimos 10 errores en orden cronológico ---");
for (const e of errors.slice(-10)) {
  console.log(
    `${e.at} | run=${e.runId.slice(0, 8)} | step=${e.stepId} | sale=${e.sale ?? "-"}\n   ${(e.message || "").slice(0, 280)}`,
  );
}
