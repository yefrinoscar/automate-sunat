import fs from "node:fs";
import path from "node:path";
import { StepReporter } from "./browser";

export interface TimingContext {
  runId?: string;
  attemptId: string;
  saleExternalId: string;
}

export interface TimingTrackerOptions {
  outFile: string;
  context: TimingContext;
}

export function getStep2TimingsPath(rootDir: string): string {
  return path.join(rootDir, "step2-timings.ndjson");
}

/**
 * Envuelve un StepReporter para que cada llamada a `onStep` escriba una línea NDJSON
 * con timestamp ms y el contexto (run/attempt/sale). Útil para medir el Paso 2 con
 * granularidad fina sin tocar todos los call sites del flujo SUNAT.
 */
export function wrapTimingReporter(
  onStep: StepReporter,
  options: TimingTrackerOptions,
): StepReporter {
  fs.mkdirSync(path.dirname(options.outFile), { recursive: true });

  return async (step: string) => {
    const entry = {
      ts: Date.now(),
      runId: options.context.runId,
      attemptId: options.context.attemptId,
      sale: options.context.saleExternalId,
      step,
    };
    try {
      fs.appendFileSync(options.outFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      /* nunca debe romper el flujo principal */
    }
    await onStep(step);
  };
}

/** Escribe una línea de marca arbitraria en el ndjson sin emitir log al UI. */
export function appendTimingMark(
  outFile: string,
  context: TimingContext,
  marker: string,
): void {
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(
      outFile,
      `${JSON.stringify({
        ts: Date.now(),
        runId: context.runId,
        attemptId: context.attemptId,
        sale: context.saleExternalId,
        step: `__mark__:${marker}`,
        marker: true,
      })}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}
