const Db = require("better-sqlite3");
const db = new Db("data/automation.db", { readonly: true });
const runId = process.argv[2] || "0a0a6b67-17c1-4358-ae0c-9ed1e59dabfb";
const row = db
  .prepare("SELECT id,reason,status,started_at,ended_at,summary_json FROM runs WHERE id=?")
  .get(runId);
if (!row) {
  console.error("run no encontrado");
  process.exit(1);
}
const s = JSON.parse(row.summary_json);
console.log(`run ${row.id} | reason=${row.reason} status=${row.status}`);
console.log(`iniciado=${row.started_at} terminado=${row.ended_at}`);
console.log("summary=", {
  observed: s.observedSales,
  queued: s.queuedSales,
  ok: s.submittedInvoices,
  fail: s.failedInvoices,
  cancel: s.cancelledInvoices,
  err: s.error,
});
const cols = db.prepare("PRAGMA table_info(invoice_attempts)").all();
const colNames = cols.map((c) => c.name);
console.log("\ncolumnas attempts:", colNames.join(","));
const att = db
  .prepare("SELECT * FROM invoice_attempts WHERE run_id=? ORDER BY created_at")
  .all(row.id);
console.log("\nattempts:");
for (const a of att) {
  const errMsg =
    typeof a.error === "string"
      ? a.error
      : typeof a.error_json === "string"
        ? a.error_json
        : (typeof a.last_error === "string" ? a.last_error : "");
  console.log(`  ${a.sale_external_id} (${a.id.slice(0, 8)}) -> ${a.status}${errMsg ? "  | " + errMsg.slice(0, 220) : ""}`);
}

console.log("\nlogs ERROR del run:");
for (const l of (s.logs || []).filter((x) => x.level === "error")) {
  console.log(
    `  ${l.at} | ${l.stageId}/${l.stepId} | sale=${l.saleExternalId ?? "-"} | ${(l.message || "").slice(0, 240)}`,
  );
}
