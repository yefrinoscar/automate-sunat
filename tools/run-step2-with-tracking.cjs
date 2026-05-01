// Espera a que existan ventas pendientes del Paso 1 y entonces dispara el Paso 2.
// Mientras corre el Paso 2 lo monitorea y al final imprime un resumen.
// Uso: node tools/run-step2-with-tracking.cjs
const http = require("node:http");

const BASE = process.env.PANEL_URL || "http://localhost:3030";
const POLL_INTERVAL_MS = 4000;
const MAX_WAIT_FOR_STEP1_MS = 30 * 60 * 1000; // 30 min
const MAX_WAIT_FOR_STEP2_MS = 60 * 60 * 1000; // 60 min

function fetchJson(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: method === "POST" ? { "Content-Type": "application/json", "Content-Length": "0" } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      },
    );
    req.on("error", reject);
    if (method === "POST") req.write("");
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(1);
  return `${m}m ${r}s`;
}

async function main() {
  console.log(`[runner] Conectando a ${BASE}`);

  // Etapa 1: esperar a que haya ventas pendientes
  const startWait = Date.now();
  let lastReady = null;
  while (Date.now() - startWait < MAX_WAIT_FOR_STEP1_MS) {
    const { body } = await fetchJson("/api/state");
    const ready = body?.runtime?.stepTwoReady;
    const isRunning = body?.runtime?.isRunning;
    const currentStep = body?.runtime?.currentStep ?? "?";

    if (ready && (lastReady?.available !== ready.available || lastReady?.pendingSales !== ready.pendingSales)) {
      console.log(
        `[runner] Estado: isRunning=${isRunning} | step="${currentStep}" | stepTwoReady=${ready.available} pendientes=${ready.pendingSales}`,
      );
      lastReady = ready;
    }

    if (ready?.available && !isRunning) {
      console.log(`[runner] Hay ${ready.pendingSales} venta(s) lista(s) para Paso 2 y no hay run en curso.`);
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!lastReady?.available) {
    console.error("[runner] Tiempo agotado esperando ventas pendientes del Paso 1.");
    process.exit(1);
  }

  // Etapa 2: disparar Paso 2
  console.log("[runner] Disparando POST /api/run/step-2 …");
  const trigger = await fetchJson("/api/run/step-2", "POST");
  console.log(`[runner] Respuesta: ${trigger.status} ${JSON.stringify(trigger.body)}`);
  if (trigger.status !== 202) {
    console.error("[runner] No se pudo iniciar el Paso 2; aborto.");
    process.exit(1);
  }

  // Etapa 3: monitorear ejecución
  const t0 = Date.now();
  let prevStep = "";
  let runId = null;
  let runFinished = false;
  while (Date.now() - t0 < MAX_WAIT_FOR_STEP2_MS) {
    const { body } = await fetchJson("/api/state");
    const rt = body?.runtime;
    runId = rt?.currentRunId || runId;
    const step = rt?.currentStep ?? "";
    if (step !== prevStep) {
      console.log(`[runner ${fmtMs(Date.now() - t0)}] step=${step}`);
      prevStep = step;
    }
    if (!rt?.isRunning) {
      console.log(`[runner] Run terminado (isRunning=false). Paso 2 demoró ${fmtMs(Date.now() - t0)}.`);
      runFinished = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!runFinished) {
    console.error("[runner] Tiempo agotado esperando fin del Paso 2.");
    process.exit(1);
  }

  console.log(`[runner] runId=${runId}`);
  console.log("[runner] Listo. Ahora ejecuta: node tools/analyze-step2-timings.cjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
