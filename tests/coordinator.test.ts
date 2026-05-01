import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  InvoiceEmitter,
  PreparedSubmission,
  SellerSource,
  SubmissionContext,
  StepReporter,
} from "../src/browser";
import { loadConfig } from "../src/config";
import { AutomationCoordinator } from "../src/coordinator";
import { Artifact, InvoiceDraft, normalizeSale, Sale, saleToInvoiceDraft } from "../src/domain";
import { RunStore } from "../src/store";
import { createTempDataDir, waitUntil } from "./helpers";

class FakeSellerSource implements SellerSource {
  constructor(private readonly sales: Sale[]) {}

   async fetchSales(onStep: StepReporter, _options?: unknown): Promise<Sale[]> {
    await onStep("Sincronizando cookies del seller");
    return this.sales;
  }

  async refreshSale(externalId: string, onStep: StepReporter, _options?: unknown): Promise<Sale | undefined> {
    await onStep(`Refrescando venta ${externalId}`);
    return this.sales.find((sale) => sale.externalId === externalId);
  }

  async captureSaleEvidence(_sale: Sale, _attemptId: string, _onStep: StepReporter): Promise<Artifact[]> {
    return [{ kind: "screenshot", path: "/tmp/fake-seller.png" }];
  }
}

class BlockingSellerSource implements SellerSource {
  private releaseFetch?: () => void;

  constructor(private readonly sales: Sale[]) {}

  async fetchSales(onStep: StepReporter, _options?: unknown): Promise<Sale[]> {
    await onStep("Sincronizando cookies del seller");
    await new Promise<void>((resolve) => {
      this.releaseFetch = resolve;
    });
    return this.sales;
  }

  async refreshSale(externalId: string, onStep: StepReporter, _options?: unknown): Promise<Sale | undefined> {
    await onStep(`Refrescando venta ${externalId}`);
    return this.sales.find((sale) => sale.externalId === externalId);
  }

  release(): void {
    this.releaseFetch?.();
  }

  async captureSaleEvidence(_sale: Sale, _attemptId: string, _onStep: StepReporter): Promise<Artifact[]> {
    return [{ kind: "screenshot", path: "/tmp/fake-seller.png" }];
  }
}

class FakePreparedSubmission implements PreparedSubmission {
  constructor(public readonly preSubmitArtifacts: Artifact[]) {}

  waitForInterruption(): Promise<string> {
    return new Promise(() => undefined);
  }

  async submit(onStep: StepReporter): Promise<{
    artifacts: Artifact[];
    receiptNumber?: string;
    receiptPrefix?: string;
  }> {
    await onStep("Validando borrador antes del envio");
    return {
      artifacts: [{ kind: "screenshot", path: "/tmp/fake-submit.png" }],
      receiptNumber: "EB01-99999",
      receiptPrefix: "EB01",
    };
  }

  async cancel(_onStep: StepReporter): Promise<Artifact[]> {
    return [{ kind: "screenshot", path: "/tmp/fake-cancel.png" }];
  }
}

class InterruptiblePreparedSubmission implements PreparedSubmission {
  private resolveInterruption?: (message: string) => void;
  private resolveSubmitStarted?: () => void;
  private submitStarted = false;
  readonly preSubmitArtifacts: Artifact[];

  constructor() {
    this.preSubmitArtifacts = [{ kind: "screenshot", path: "/tmp/fake-review.png" }];
  }

  waitForInterruption(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.resolveInterruption = resolve;
    });
  }

  interrupt(message = "Flujo cancelado porque el operador cerró el navegador."): void {
    this.resolveInterruption?.(message);
  }

  waitUntilSubmitStarts(): Promise<void> {
    if (this.submitStarted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.resolveSubmitStarted = resolve;
    });
  }

  async submit(onStep: StepReporter): Promise<{
    artifacts: Artifact[];
    receiptNumber?: string;
    receiptPrefix?: string;
  }> {
    await onStep("Validando borrador antes del envio");
    this.submitStarted = true;
    this.resolveSubmitStarted?.();
    return new Promise(() => undefined);
  }

  async cancel(_onStep: StepReporter): Promise<Artifact[]> {
    return [{ kind: "screenshot", path: "/tmp/fake-cancel.png" }];
  }
}

class FakeEmitter implements InvoiceEmitter {
  async prepareSubmission(
    _attemptId: string,
    _draft: InvoiceDraft,
    _onStep: StepReporter,
    _context?: SubmissionContext,
  ): Promise<PreparedSubmission> {
    return new FakePreparedSubmission([{ kind: "screenshot", path: "/tmp/fake-review.png" }]);
  }
}

class RecordingEmitter implements InvoiceEmitter {
  readonly preparedSaleIds: string[] = [];

  async prepareSubmission(
    _attemptId: string,
    draft: InvoiceDraft,
    _onStep: StepReporter,
    _context?: SubmissionContext,
  ): Promise<PreparedSubmission> {
    this.preparedSaleIds.push(draft.saleExternalId);
    return new FakePreparedSubmission([{ kind: "screenshot", path: "/tmp/fake-review.png" }]);
  }
}

class InterruptibleEmitter implements InvoiceEmitter {
  readonly submissions: InterruptiblePreparedSubmission[] = [];

  async prepareSubmission(
    _attemptId: string,
    _draft: InvoiceDraft,
    _onStep: StepReporter,
    _context?: SubmissionContext,
  ): Promise<PreparedSubmission> {
    const submission = new InterruptiblePreparedSubmission();
    this.submissions.push(submission);
    return submission;
  }
}

describe("AutomationCoordinator", () => {
  let dataDir = "";
  let store: RunStore;
  let coordinator: AutomationCoordinator | undefined;

  beforeEach(() => {
    dataDir = createTempDataDir("sunat-coordinator");
    store = new RunStore(path.join(dataDir, "test.db"));
  });

  afterEach(async () => {
    await coordinator?.stop();
    coordinator = undefined;
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("completes paso 1 and leaves paso 2 pending when no hay ventas", async () => {
    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      new FakeSellerSource([]),
      new FakeEmitter(),
      (accountId) => config,
    ));

    const runPromise = currentCoordinator.triggerManualRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const attempts = currentCoordinator.getSnapshot().attempts;
    const runs = currentCoordinator.getSnapshot().runs;

    expect(attempts).toHaveLength(0);
    expect(runs[0]?.workflowStages[0]?.title).toBe("Paso 1: Obtener informacion de ventas");
    expect(runs[0]?.workflowStages[0]?.status).toBe("completed");
    expect(runs[0]?.workflowStages).toHaveLength(2);
    expect(runs[0]?.workflowStages[1]?.title).toBe("Paso 2: Registro de boleta electrónica");
    expect(runs[0]?.workflowStages[1]?.status).toBe("pending");
    expect(currentCoordinator.getSnapshot().runtime.pendingApprovals).toHaveLength(0);
  });

  test("completa solo el paso 1 y deja el paso 2 listo cuando hay ventas", async () => {
    const sale = normalizeSale({
      externalId: "SALE-COORD-1",
      issuedAt: "2026-03-24T12:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente QA",
        documentNumber: "20101010101",
      },
      items: [{ description: "Monitor", quantity: 1, unitPrice: 350, total: 350 }],
      totals: { subtotal: 350, tax: 0, total: 350 },
      raw: {},
    });

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      new FakeSellerSource([sale]),
      new FakeEmitter(),
      (accountId) => {
        if (!accountId) {
          return config;
        }
        const credentials = store.getAccountCredentials(accountId);
        if (!credentials) {
          return config;
        }
        return {
          ...config,
          sellerCredentials: credentials.sellerCredentials,
          sunatCredentials: credentials.sunatCredentials,
          dataPaths: {
            ...config.dataPaths,
            authDir: path.join(config.dataPaths.authDir, `account-${accountId}`),
          },
        };
      },
    ));

    const runPromise = currentCoordinator.triggerManualRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const runs = snapshot.runs;
    expect(snapshot.attempts).toHaveLength(0);
    expect(runs[0]?.entries).toHaveLength(0);
    expect(runs[0]?.workflowStages[1]?.status).toBe("pending");
    expect(runs[0]?.outputJsonPath).toContain("/falabella-extract/");
    expect(runs[0]?.outputJsonContent).toContain("SALE-COORD-1");
    expect(runs[0]?.outputJsonContent).toContain("\"dni\": \"20101010101\"");
    expect(runs[0]?.outputJsonContent).toContain("\"productCount\": 1");
    expect(runs[0]?.outputJsonContent).toContain("\"total\": 350");
    expect(runs[0]?.outputJsonContent).toContain("\"products\"");
    expect(runs[0]?.outputJsonContent).toContain("Monitor");
    expect(runs[0]?.outputJsonContent).not.toContain("\"receiptNumber\"");
    expect(runs[0]?.outputJsonContent).not.toContain("\"receiptPrefix\"");
    expect(runs[0]?.summary.boletasDownloadDir).toBeUndefined();
    expect(runs[0]?.logs.some((log) => /JSON del paso 1/i.test(log.message))).toBe(true);
    expect(runs[0]?.logs.some((log) => /Sincronizando cookies del seller/i.test(log.message))).toBe(true);
    expect(runs[0]?.logs.some((log) => /Paso 2 listo para continuar/i.test(log.message))).toBe(true);
    expect(snapshot.runtime.stepTwoReady.available).toBe(true);
    expect(snapshot.runtime.stepTwoReady.pendingSales).toBe(1);
    expect(snapshot.runtime.pendingApprovals).toHaveLength(0);
  });

  test("continua automáticamente al paso 2 cuando el flag está activo", async () => {
    const sale = normalizeSale({
      externalId: "SALE-AUTO-FLAG-1",
      issuedAt: "2026-03-24T12:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente auto",
        documentNumber: "20101010109",
      },
      items: [{ description: "Monitor", quantity: 1, unitPrice: 350, total: 350 }],
      totals: { subtotal: 350, tax: 0, total: 350 },
      raw: {},
    });

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      AUTO_CONTINUE_STEP_2: "true",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      new FakeSellerSource([sale]),
      new FakeEmitter(),
      (accountId) => {
        if (!accountId) {
          return config;
        }
        const credentials = store.getAccountCredentials(accountId);
        if (!credentials) {
          return config;
        }
        return {
          ...config,
          sellerCredentials: credentials.sellerCredentials,
          sunatCredentials: credentials.sunatCredentials,
        };
      },
    ));

    const runPromise = currentCoordinator.triggerManualRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const attempt = snapshot.attempts.find((entry) => entry.saleExternalId === "SALE-AUTO-FLAG-1");

    expect(snapshot.config.autoContinueStepTwo).toBe(true);
    expect(attempt?.status).toBe("submitted");
    expect(attempt?.receiptNumber).toBe("EB01-99999");
    expect(snapshot.runs[0]?.workflowStages[1]?.status).toBe("completed");
    expect(snapshot.runtime.stepTwoReady.available).toBe(false);
  });

  test("ejecuta el paso 2 cuando se lanza de forma explícita", async () => {
    const saleOne = normalizeSale({
      externalId: "SALE-STEP2-AUTO-1",
      issuedAt: "2026-03-24T12:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente step 2",
        documentNumber: "20101010111",
      },
      items: [{ description: "Monitor", quantity: 1, unitPrice: 350, total: 350 }],
      totals: { subtotal: 350, tax: 0, total: 350 },
      raw: {},
    });

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const seller = new FakeSellerSource([saleOne]);
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      seller,
      new FakeEmitter(),
      (accountId) => {
        if (!accountId) {
          return config;
        }
        const credentials = store.getAccountCredentials(accountId);
        if (!credentials) {
          return config;
        }
        return {
          ...config,
          sellerCredentials: credentials.sellerCredentials,
          sunatCredentials: credentials.sunatCredentials,
        };
      },
    ));

    const paso1Promise = currentCoordinator.triggerManualRun();
    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await paso1Promise;

    const runPromise = currentCoordinator.triggerStepTwoRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const firstAttempt = snapshot.attempts.find((attempt) => attempt.saleExternalId === "SALE-STEP2-AUTO-1");

    expect(firstAttempt?.status).toBe("submitted");
    expect(firstAttempt?.receiptNumber).toBe("EB01-99999");
    expect(snapshot.runs[0]?.workflowStages[1]?.status).toBe("completed");
    expect(snapshot.runs[0]?.summary.boletasDownloadDir).toBeTruthy();
    expect(snapshot.runtime.stepTwoReady.available).toBe(false);
    expect(snapshot.runtime.pendingApprovals).toHaveLength(0);
  });

  test("cancela toda la corrida si el navegador se cierra durante el envío automático", async () => {
    const saleOne = normalizeSale({
      externalId: "SALE-CANCEL-1",
      issuedAt: "2026-03-24T12:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente cierre 1",
        documentNumber: "20101010111",
      },
      items: [{ description: "Monitor", quantity: 1, unitPrice: 350, total: 350 }],
      totals: { subtotal: 350, tax: 0, total: 350 },
      raw: {},
    });
    const saleTwo = normalizeSale({
      externalId: "SALE-CANCEL-2",
      issuedAt: "2026-03-24T13:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente cierre 2",
        documentNumber: "20101010112",
      },
      items: [{ description: "Teclado", quantity: 1, unitPrice: 120, total: 120 }],
      totals: { subtotal: 120, tax: 0, total: 120 },
      raw: {},
    });
    const emitter = new InterruptibleEmitter();

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const seller = new FakeSellerSource([saleOne, saleTwo]);
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      seller,
      emitter,
      (accountId) => config,
    ));

    const paso1Promise = currentCoordinator.triggerManualRun();
    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await paso1Promise;

    const runPromise = currentCoordinator.triggerStepTwoRun();

    await waitUntil(() => emitter.submissions.length > 0);
    await emitter.submissions[0]!.waitUntilSubmitStarts();
    emitter.submissions[0]?.interrupt();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const firstAttempt = snapshot.attempts.find((attempt) => attempt.saleExternalId === "SALE-CANCEL-1");
    const secondAttempt = snapshot.attempts.find((attempt) => attempt.saleExternalId === "SALE-CANCEL-2");

    expect(firstAttempt?.status).toBe("failed");
    expect(firstAttempt?.error).toMatch(/cerr[oó] el navegador/i);
    expect(secondAttempt).toBeUndefined();
    expect(snapshot.runtime.pendingApprovals).toHaveLength(0);
    expect(snapshot.runs[0]?.status).toBe("failed");
    expect(snapshot.runs[0]?.summary.cancelledInvoices).toBe(1);
  });

  test("deja el paso 2 listo aunque otras ventas ya esten en revision previa", async () => {
    const saleReady = normalizeSale({
      externalId: "SALE-READY-1",
      issuedAt: "2026-03-24T11:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente en revision",
        documentNumber: "20101010102",
      },
      items: [{ description: "Teclado", quantity: 1, unitPrice: 120, total: 120 }],
      totals: { subtotal: 120, tax: 0, total: 120 },
      raw: {},
    });
    const saleNew = normalizeSale({
      externalId: "SALE-NEW-1",
      issuedAt: "2026-03-24T12:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente nuevo",
        documentNumber: "20101010103",
      },
      items: [{ description: "Mouse", quantity: 1, unitPrice: 80, total: 80 }],
      totals: { subtotal: 80, tax: 0, total: 80 },
      raw: {},
    });

    store.registerObservedSales([saleReady]);
    store.setSaleStatus(saleReady.externalId, "ready_for_review", "attempt-old");

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      new FakeSellerSource([saleReady, saleNew]),
      new FakeEmitter(),
      (_accountId) => config,
    ));

    const runPromise = currentCoordinator.triggerManualRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const runs = snapshot.runs;
    expect(runs[0]?.summary.queuedSales).toBe(1);
    expect(
      runs[0]?.logs.some((log) => /ya estaban en revisión o enviadas a SUNAT/i.test(log.message)),
    ).toBe(true);
    expect(runs[0]?.workflowStages[1]?.status).toBe("pending");
    expect(snapshot.runtime.stepTwoReady.available).toBe(true);
    expect(snapshot.runtime.pendingApprovals).toHaveLength(0);
  });

  test("permite ejecutar solo el paso 2 con ventas guardadas del paso 1", async () => {
    const sale = normalizeSale({
      externalId: "SALE-STEP2-1",
      issuedAt: "2026-03-24T13:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente reutilizado",
        documentNumber: "20101010104",
      },
      items: [{ description: "Laptop", quantity: 1, unitPrice: 1500, total: 1500 }],
      totals: { subtotal: 1500, tax: 0, total: 1500 },
      raw: {},
    });
    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const seller = new FakeSellerSource([sale]);
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      seller,
      new FakeEmitter(),
      () => config,
    ));

    const paso1Promise = currentCoordinator.triggerManualRun();
    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await paso1Promise;

    expect(currentCoordinator.getSnapshot().runtime.stepTwoReady.available).toBe(true);
    expect(currentCoordinator.getSnapshot().runtime.stepTwoReady.pendingSales).toBe(1);

    const runPromise = currentCoordinator.triggerStepTwoRun();

    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await runPromise;

    const snapshot = currentCoordinator.getSnapshot();
    const latestRun = snapshot.runs[0];
    const attemptId = snapshot.attempts[0]?.id;

    expect(snapshot.attempts.some((attempt) => attempt.id === attemptId && attempt.status === "submitted")).toBe(
      true,
    );
    expect(latestRun?.reason).toBe("step2");
    expect(latestRun?.workflowStages[0]?.status).toBe("completed");
    expect(latestRun?.workflowStages[1]?.status).toBe("completed");
    expect(latestRun?.logs.some((log) => /Paso 1 reutilizado/i.test(log.message))).toBe(true);
    expect(latestRun?.logs.some((log) => /Carpeta de boletas de esta corrida/i.test(log.message))).toBe(
      true,
    );
    expect(latestRun?.logs.some((log) => /Sincronizando cookies del seller/i.test(log.message))).toBe(
      false,
    );
    expect(latestRun?.outputJsonContent).toContain("\"receiptPrefix\": \"EB01\"");
    expect(String(latestRun?.summary.boletasDownloadDir)).toContain("/boletas-descargadas/");
    expect(snapshot.runtime.stepTwoReady.available).toBe(false);
    expect(snapshot.runtime.pendingApprovals).toHaveLength(0);
  });

  test("paso 2 reutiliza solo el último lote detectado y no arrastra ventas fallidas viejas", async () => {
    const staleSale = normalizeSale({
      externalId: "SALE-OLD-FAILED",
      issuedAt: "2026-03-20T10:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente viejo",
        documentNumber: "20000000001",
      },
      items: [{ description: "Producto viejo", quantity: 1, unitPrice: 50, total: 50 }],
      totals: { subtotal: 50, tax: 0, total: 50 },
      raw: {},
    });
    const latestSaleA = normalizeSale({
      externalId: "SALE-LATEST-1",
      issuedAt: "2026-03-24T13:00:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente nuevo uno",
        documentNumber: "20101010105",
      },
      items: [{ description: "Mouse", quantity: 1, unitPrice: 90, total: 90 }],
      totals: { subtotal: 90, tax: 0, total: 90 },
      raw: {},
    });
    const latestSaleB = normalizeSale({
      externalId: "SALE-LATEST-2",
      issuedAt: "2026-03-24T13:10:00-05:00",
      currency: "PEN",
      customer: {
        name: "Cliente nuevo dos",
        documentNumber: "20101010106",
      },
      items: [{ description: "Teclado", quantity: 1, unitPrice: 120, total: 120 }],
      totals: { subtotal: 120, tax: 0, total: 120 },
      raw: {},
    });

    store.registerObservedSales([staleSale]);
    const staleAttemptId = store.createAttempt(staleSale.externalId, saleToInvoiceDraft(staleSale));
    store.setSaleStatus(staleSale.externalId, "failed", staleAttemptId);

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const seller = new FakeSellerSource([latestSaleA, latestSaleB]);
    const emitter = new RecordingEmitter();
    const currentCoordinator = (coordinator = new AutomationCoordinator(
      config,
      store,
      seller,
      emitter,
      () => config,
    ));

    const paso1Promise = currentCoordinator.triggerManualRun();
    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await paso1Promise;

    expect(currentCoordinator.getSnapshot().runtime.stepTwoReady.pendingSales).toBe(2);

    const paso2Promise = currentCoordinator.triggerStepTwoRun();
    await waitUntil(() => currentCoordinator.getSnapshot().runtime.isRunning === false);
    await paso2Promise;

    expect(emitter.preparedSaleIds).toEqual(["SALE-LATEST-1", "SALE-LATEST-2"]);
    expect(emitter.preparedSaleIds).not.toContain("SALE-OLD-FAILED");
  });

  test("returns immediately when a manual run starts", async () => {
    const blockingSource = new BlockingSellerSource([]);
    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    coordinator = new AutomationCoordinator(
      config,
      store,
      blockingSource,
      new FakeEmitter(),
      (accountId) => {
        if (!accountId) {
          return config;
        }
        const credentials = store.getAccountCredentials(accountId);
        if (!credentials) {
          return config;
        }
        return {
          ...config,
          sellerCredentials: credentials.sellerCredentials,
          sunatCredentials: credentials.sunatCredentials,
        };
      },
    );

    const result = await coordinator.triggerManualRun();

    expect(result).toEqual({ started: true, message: "Ejecución iniciada." });
    expect(coordinator.getSnapshot().runtime.isRunning).toBe(true);
    expect(coordinator.getSnapshot().runs[0]?.status).toBe("running");

    blockingSource.release();
    await waitUntil(() => coordinator?.getSnapshot().runtime.isRunning === false);
  });

  test("starts the first hourly run immediately", async () => {
    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      SITE_PROFILE_PATH: "./config/custom-profile.json",
      RUN_MODE: "hourly",
      CHECK_INTERVAL_MINUTES: "60",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    coordinator = new AutomationCoordinator(
      config,
      store,
      new FakeSellerSource([]),
      new FakeEmitter(),
      (accountId) => {
        if (!accountId) {
          return config;
        }
        const credentials = store.getAccountCredentials(accountId);
        if (!credentials) {
          return config;
        }
        return {
          ...config,
          sellerCredentials: credentials.sellerCredentials,
          sunatCredentials: credentials.sunatCredentials,
        };
      },
    );

    coordinator.start();

    await waitUntil(() => (coordinator?.getSnapshot().runs.length ?? 0) > 0);
    await waitUntil(() => coordinator?.getSnapshot().runtime.isRunning === false);

    const snapshot = coordinator.getSnapshot();

    expect(snapshot.runs[0]?.reason).toBe("hourly");
    expect(snapshot.runs[0]?.status).toBe("completed");
    expect(snapshot.runtime.lastCheckAt).toBeTruthy();
    expect(snapshot.runtime.nextCheckAt).toBeTruthy();
  });
});
