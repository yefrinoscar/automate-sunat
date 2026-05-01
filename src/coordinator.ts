import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  AutomationError,
  FetchSalesOptions,
  InvoiceEmitter,
  OperatorCancelledError,
  PreparedSubmission,
  SellerSource,
  StepReporter,
} from "./browser";
import { AppConfig } from "./config";
import {
  DashboardSnapshot,
  Sale,
  saleToInvoiceDraft,
  WorkflowLogEntry,
  WorkflowStage,
  WorkflowStepStatus,
} from "./domain";
import { RunStore } from "./store";
import {
  appendTimingMark,
  getStep2TimingsPath,
  wrapTimingReporter,
} from "./timing-tracker";

/** Prefijo en mensajes de `onStep` que se guardan como nivel `debug` (traza del vigilante de modales SUNAT). */
const SUNAT_MODAL_TRACE_LOG_PREFIX = "[sunat-modal-trace] ";

type ApprovalDecision = "approve" | "cancel";

type PendingApproval = {
  attemptId: string;
  saleExternalId: string;
  createdAt: string;
  resolve: (decision: ApprovalDecision) => void;
};

type RunProgress = {
  summary: {
    observedSales: number;
    queuedSales: number;
    submittedInvoices: number;
    failedInvoices: number;
    cancelledInvoices: number;
  };
  workflowStages: WorkflowStage[];
  logs: WorkflowLogEntry[];
  outputJsonPath?: string;
  outputJsonContent?: string;
  boletasDownloadDir?: string;
  currentWorkflowStageId?: string;
  currentWorkflowStepId?: string;
};

type RunReason = "manual" | "hourly" | "retry" | "step2";

type StepTwoReadiness = {
  available: boolean;
  pendingSales: number;
  message: string;
};

type SellerSourceFactory = (config: AppConfig, accountId?: string) => SellerSource;
type InvoiceEmitterFactory = (config: AppConfig, accountId?: string) => InvoiceEmitter;
type ClosableInvoiceEmitter = InvoiceEmitter & { close?: () => Promise<void> };

export class AutomationCoordinator {
  readonly events = new EventEmitter();
  private interval?: NodeJS.Timeout;
  private runInFlight = false;
  private activeRunPromise?: Promise<{ started: boolean; message: string }>;
  private pendingApprovals = new Map<string, PendingApproval>();
  private runProgressById = new Map<string, RunProgress>();
  private runtime = {
    isRunning: false,
    currentRunId: undefined as string | undefined,
    currentSaleId: undefined as string | undefined,
    currentStep: "En espera",
    currentAccountId: undefined as string | undefined,
    lastCheckAt: undefined as string | undefined,
    nextCheckAt: undefined as string | undefined,
    currentWorkflowStageId: undefined as string | undefined,
    currentWorkflowStepId: undefined as string | undefined,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly store: RunStore,
    private readonly sellerSourceOrFactory: SellerSource | SellerSourceFactory,
    private readonly invoiceEmitterOrFactory: InvoiceEmitter | InvoiceEmitterFactory,
    private readonly resolveAccountConfig: (accountId?: string) => AppConfig,
  ) {
    this.refreshNextCheckAt();
  }

  listAccounts() {
    return this.store.listAccounts();
  }

  createAccount(input: {
    label: string;
    sellerUsername: string;
    sellerPassword: string;
    sunatRuc: string;
    sunatUsername: string;
    sunatPassword: string;
  }) {
    return this.store.createAccount(input);
  }

  deleteAccount(accountId: string) {
    return this.store.deleteAccount(accountId);
  }

  start(): void {
    if (this.config.runMode === "hourly" || this.config.runMode === "both") {
      if (this.interval) {
        return;
      }

      const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;
      this.launchRun("hourly", undefined, false, this.falabellaFetchOptionsFromConfig());
      this.interval = setInterval(() => {
        this.launchRun("hourly", undefined, false, this.falabellaFetchOptionsFromConfig());
      }, intervalMs);
      this.refreshNextCheckAt();
      this.publish();
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    for (const pending of this.pendingApprovals.values()) {
      pending.resolve("cancel");
    }

    this.pendingApprovals.clear();
    await this.activeRunPromise?.catch(() => undefined);
    this.runtime.nextCheckAt = undefined;
    this.publish();
  }

  async triggerManualRun(options?: {
    accountId?: string;
    fetchSalesOptions?: FetchSalesOptions;
  }): Promise<{ started: boolean; message: string }> {
    if (this.runInFlight) {
      return { started: false, message: "Ya hay una ejecución en progreso." };
    }

    this.launchRun("manual", undefined, false, options?.fetchSalesOptions, options?.accountId);
    return { started: true, message: "Ejecución iniciada." };
  }

  async triggerStepTwoRun(options?: { accountId?: string }): Promise<{ started: boolean; message: string }> {
    if (this.runInFlight) {
      return { started: false, message: "Ya hay una ejecución en progreso." };
    }

    const reusableSales = this.store.getLatestSalesForStepTwo(options?.accountId);

    if (!reusableSales.length) {
      return {
        started: false,
        message: "No hay ventas del último paso 1 listas para continuar con el paso 2.",
      };
    }

    this.launchRun("step2", reusableSales, true, undefined, options?.accountId);
    return {
      started: true,
      message: `Paso 2 iniciado con ${reusableSales.length} venta(s) del último paso 1.`,
    };
  }

  async retryAttempt(attemptId: string, accountId?: string): Promise<{ started: boolean; message: string }> {
    const attempt = this.store.getAttempt(attemptId, accountId);

    if (!attempt) {
      return { started: false, message: "No se encontr? el intento." };
    }

    if (attempt.status === "submitted") {
      return { started: false, message: "Los intentos ya enviados no se pueden reintentar." };
    }

    const sale = this.store.getSaleForAttempt(attemptId, accountId);

    if (!sale) {
      return { started: false, message: "La venta vinculada a este intento ya no est? disponible." };
    }

    if (this.runInFlight) {
      return { started: false, message: "Ya hay una ejecución en progreso." };
    }

    this.launchRun("retry", [sale], false, this.falabellaFetchOptionsFromConfig(), accountId);
    return { started: true, message: "Reintento iniciado." };
  }

  approveAttempt(attemptId: string): { ok: boolean; message: string } {
    const pending = this.pendingApprovals.get(attemptId);

    if (!pending) {
      return {
        ok: false,
        message: "Ya no hay aprobaciones manuales pendientes; el flujo ahora continúa automáticamente.",
      };
    }

    pending.resolve("approve");
    return { ok: true, message: "Env?o aprobado." };
  }

  cancelAttempt(attemptId: string): { ok: boolean; message: string } {
    const pending = this.pendingApprovals.get(attemptId);

    if (!pending) {
      return {
        ok: false,
        message: "Ya no hay aprobaciones manuales pendientes en vivo.",
      };
    }

    pending.resolve("cancel");
    return { ok: true, message: "Env?o pendiente cancelado." };
  }

  deleteRun(runId: string): { deleted: boolean; message: string } {
    if (this.runInFlight && this.runtime.currentRunId === runId) {
      return {
        deleted: false,
        message: "No puedes eliminar un workflow mientras sigue en ejecución.",
      };
    }

    const result = this.store.deleteRun(runId);

    if (result.deleted) {
      this.publish();
    }

    return result;
  }

  getSnapshot(accountId?: string): DashboardSnapshot {
    const dashboardData = this.store.getDashboardData(25, accountId);
    const stepTwoReady = this.getStepTwoReadiness(accountId);

    return {
      config: {
        profile: this.config.profileKind,
        runMode: this.config.runMode,
        autoContinueStepTwo: this.config.autoContinueStepTwo,
        checkIntervalMinutes: this.config.checkIntervalMinutes,
        headful: this.config.headful,
        baseUrl: this.config.appBaseUrl,
      },
      accounts: dashboardData.accounts,
      runtime: {
        ...this.runtime,
        pendingApprovals: dashboardData.attempts
          .filter(
            (attempt) =>
              attempt.status === "ready_for_review" && this.pendingApprovals.has(attempt.id),
          )
          .map((attempt) => ({
            attemptId: attempt.id,
            saleExternalId: attempt.saleExternalId,
            createdAt: attempt.updatedAt,
            live: this.pendingApprovals.has(attempt.id),
          })),
        stepTwoReady,
      },
      sales: dashboardData.sales,
      attempts: dashboardData.attempts,
      runs: dashboardData.runs,
    };
  }

  private falabellaFetchOptionsFromConfig(): FetchSalesOptions {
    const fromIso = this.config.falabellaDocumentsSearchFrom;
    const toIso = this.config.falabellaDocumentsSearchTo;

    if (fromIso && toIso) {
      return { falabellaDocumentsSearchFromIso: fromIso, falabellaDocumentsSearchToIso: toIso };
    }
    if (fromIso) {
      return { falabellaDocumentsSearchFromIso: fromIso };
    }
    if (toIso) {
      return { falabellaDocumentsSearchToIso: toIso };
    }
    return {};
  }

  private async run(
    reason: RunReason,
    retrySales?: Sale[],
    stepTwoOnly = false,
    fetchSalesOptions?: FetchSalesOptions,
    accountId?: string,
  ): Promise<{ started: boolean; message: string }> {
    if (this.runInFlight) {
      return { started: false, message: "Ya hay una ejecución en progreso." };
    }

    this.runInFlight = true;
    this.runtime.isRunning = true;
    this.runtime.currentAccountId = accountId;
    this.runtime.currentStep =
      reason === "retry"
        ? "Reintentando venta fallida"
        : stepTwoOnly
          ? "Reutilizando ventas guardadas para el paso 2"
          : "Iniciando automatizaci?n";
    this.runtime.currentSaleId = undefined;
    this.runtime.currentRunId = this.store.createRun(reason, accountId);
    this.initializeRunProgress(this.runtime.currentRunId);
    this.publish();

    try {
      this.runtime.lastCheckAt = new Date().toISOString();
      const runConfig = this.resolveAccountConfig(accountId);
      this.appendRunLog({
        level: "info",
        stageId: "detectar_ventas",
        stepId: "abrir_falabella",
        message: `Cuenta seleccionada para este workflow: ${runConfig.sellerCredentials.username} / RUC ${runConfig.sunatCredentials.ruc}.`,
      });
      const sellerSource = this.resolveSellerSource(runConfig, accountId);
      let observedSales: Sale[] = [];
      let salesForSunat: Sale[] = [];

      if (stepTwoOnly) {
        observedSales = retrySales ?? [];
        salesForSunat = observedSales;
        this.currentRunProgress().summary.observedSales = observedSales.length;
        this.currentRunProgress().summary.queuedSales = salesForSunat.length;
        this.completeStage("detectar_ventas", observedSales.length);
        this.appendRunLog({
          level: "info",
          stageId: "detectar_ventas",
          stepId: "exportar_json",
          message: `Paso 1 reutilizado: ${observedSales.length} venta(s) guardada(s) quedaron listas para SUNAT.`,
        });
      } else {
        this.advanceWorkflow("detectar_ventas", "abrir_falabella", "Automatizaci?n iniciada.");
        if (reason === "retry" && retrySales?.length === 1) {
          const targetSale = retrySales[0];
          const refreshedSale = await sellerSource.refreshSale(
            targetSale.externalId,
            this.stepReporter(targetSale.externalId),
            fetchSalesOptions,
          );
          observedSales = refreshedSale ? [refreshedSale] : retrySales;
        } else {
          observedSales =
            retrySales ?? (await sellerSource.fetchSales(this.stepReporter(), fetchSalesOptions));
        }
        this.currentRunProgress().summary.observedSales = observedSales.length;
        this.advanceWorkflow(
          "detectar_ventas",
          "leer_detalle_ventas",
          `Se detectaron ${observedSales.length} venta(s) con documento pendiente en Falabella.`,
        );

        const output = this.writePendingSalesOutput(this.runtime.currentRunId!, observedSales);
        this.currentRunProgress().outputJsonPath = output.path;
        this.currentRunProgress().outputJsonContent = output.content;
        this.advanceWorkflow(
          "detectar_ventas",
          "exportar_json",
          `Se export? el JSON del paso 1 en ${output.path}.`,
        );
        this.completeStage("detectar_ventas", observedSales.length, output.path);

        this.store.registerObservedSales(observedSales, accountId);
        salesForSunat = this.store.getSalesForRegistration(
          observedSales.map((sale) => sale.externalId),
          accountId,
        );
        this.currentRunProgress().summary.queuedSales = salesForSunat.length;

        if (observedSales.length > salesForSunat.length) {
          this.appendRunLog({
            level: "info",
            stageId: "registrar_facturas_sunat",
            stepId: "abrir_sunat",
            message:
              salesForSunat.length > 0
                ? `Se omiten ${observedSales.length - salesForSunat.length} venta(s) porque ya estaban en revisión o enviadas a SUNAT.`
                : "Las ventas detectadas ya estaban en revisión o enviadas a SUNAT; no se abrir? una nueva sesi?n de registro.",
          });
        }
      }

      if ((stepTwoOnly || runConfig.autoContinueStepTwo) && salesForSunat.length > 0) {
        await this.processSunatRegistrations(salesForSunat, runConfig, accountId);
      } else if (salesForSunat.length > 0) {
        this.appendRunLog({
          level: "info",
          stageId: "registrar_facturas_sunat",
          stepId: "abrir_sunat",
          message: `Paso 2 listo para continuar con ${salesForSunat.length} venta(s) exportada(s) desde el paso 1.`,
        });
      }

      this.runtime.currentStep = stepTwoOnly
        ? `Paso 2 completado con ${salesForSunat.length} venta(s) guardada(s) del paso 1`
        : runConfig.autoContinueStepTwo && salesForSunat.length > 0
          ? `Workflow completado con ${salesForSunat.length} venta(s) procesada(s) automáticamente`
        : salesForSunat.length > 0
          ? `Paso 1 completado con ${salesForSunat.length} venta(s); el paso 2 queda listo para continuar`
          : observedSales.length > 0
            ? `Paso 1 completado: ${observedSales.length} venta(s) exportada(s); sin nuevas ventas para SUNAT`
            : "Paso 1 completado: no se encontraron ventas pendientes";
      this.refreshNextCheckAt();
      this.syncRunProgress();
      this.publish();

      const progress = this.currentRunProgress();
      const sunatStage = progress.workflowStages.find((s) => s.id === "registrar_facturas_sunat");
      const runEndedFailed =
        sunatStage?.status === "failed" ||
        (progress.summary.failedInvoices > 0 &&
          progress.summary.submittedInvoices === 0 &&
          progress.summary.cancelledInvoices === 0);

      this.store.finishRun(
        this.runtime.currentRunId!,
        runEndedFailed ? "failed" : "completed",
        this.buildRunSummaryPayload(),
      );
      return { started: true, message: "Ejecución iniciada." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fallo desconocido en la automatizaci?n.";
      this.failCurrentWorkflowStep(message);
      this.store.finishRun(this.runtime.currentRunId!, "failed", {
        ...this.buildRunSummaryPayload(),
        error: message,
      });
      return {
        started: false,
        message,
      };
    } finally {
      if (this.runtime.currentRunId) {
        this.runProgressById.delete(this.runtime.currentRunId);
      }
      this.runtime.isRunning = false;
      this.runtime.currentRunId = undefined;
      this.runtime.currentSaleId = undefined;
      this.runtime.currentStep = "En espera";
      this.runtime.currentAccountId = undefined;
      this.runtime.currentWorkflowStageId = undefined;
      this.runtime.currentWorkflowStepId = undefined;
      this.runInFlight = false;
      this.refreshNextCheckAt();
      this.publish();
    }
  }

  private async processSunatRegistrations(
    sales: Sale[],
    runConfig: AppConfig,
    accountId?: string,
  ): Promise<void> {
    const runId = this.runtime.currentRunId;
    if (!runId) {
      return;
    }
    const invoiceEmitter = this.resolveInvoiceEmitter(runConfig, accountId);

    let submitted = 0;
    let failed = 0;
    let cancelled = 0;

    this.advanceWorkflow(
      "registrar_facturas_sunat",
      "abrir_sunat",
      "Iniciando paso 2: registro en SUNAT.",
    );
    this.ensureRunOutputJson(runId, sales);
    const boletasDownloadDir = this.ensureBoletasDownloadDir();

    const timingsFile = getStep2TimingsPath(this.config.dataPaths.rootDir);

    for (const sale of sales) {
      const draft = saleToInvoiceDraft(sale);
      const attemptId = this.store.createAttempt(sale.externalId, draft, runId);
      this.store.setSaleStatus(sale.externalId, "drafted", attemptId);

      const timingContext = { runId, attemptId, saleExternalId: sale.externalId };
      appendTimingMark(timingsFile, timingContext, "sale_start");
      const timedStep = wrapTimingReporter(this.stepReporter(sale.externalId), {
        outFile: timingsFile,
        context: timingContext,
      });

      let submission: PreparedSubmission | undefined;

      try {
        appendTimingMark(timingsFile, timingContext, "prepare_submission_start");
        submission = await this.invoiceEmitter.prepareSubmission(
          attemptId,
          draft,
          timedStep,
          {
            runId,
            boletasDownloadDir,
          },
        );
        appendTimingMark(timingsFile, timingContext, "prepare_submission_end");
      } catch (error) {
        if (error instanceof OperatorCancelledError) {
          cancelled += 1;
        } else {
          failed += 1;
        }
        const message =
          error instanceof AutomationError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Error al preparar el envío en SUNAT.";
        const artifacts = error instanceof AutomationError ? error.artifacts : [];
        this.store.markAttemptFailed(attemptId, message, artifacts);
        this.store.setSaleStatus(sale.externalId, "failed", attemptId);
        this.appendRunLog({
          level: "error",
          stageId: "registrar_facturas_sunat",
          stepId: "cargar_factura_en_sunat",
          message,
          saleExternalId: sale.externalId,
        });
        this.syncRegistrationSummary(submitted, failed, cancelled);
        this.publish();
        if (error instanceof OperatorCancelledError) {
          throw error;
        }
        continue;
      }

      this.advanceWorkflow(
        "registrar_facturas_sunat",
        "abrir_sunat",
        "Iniciando paso 2: registro en SUNAT.",
      );
      this.ensureRunOutputJson(runId, sales);
      const boletasDownloadDir = this.ensureBoletasDownloadDir();

      for (const sale of sales) {
        const draft = saleToInvoiceDraft(sale);
        const attemptId = this.store.createAttempt(sale.externalId, draft, runId, accountId);
        this.store.setSaleStatus(sale.externalId, "drafted", attemptId, accountId);

        let submission: PreparedSubmission | undefined;

        try {
          submission = await invoiceEmitter.prepareSubmission(
            attemptId,
            draft,
            this.stepReporter(sale.externalId),
            {
              runId,
              boletasDownloadDir,
            },
          );
        } catch (error) {
          if (error instanceof OperatorCancelledError) {
            cancelled += 1;
          } else {
            failed += 1;
          }
          const message =
            error instanceof AutomationError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Error al preparar el envío en SUNAT.";
          const artifacts = error instanceof AutomationError ? error.artifacts : [];
          this.store.markAttemptFailed(attemptId, message, artifacts);
          this.store.setSaleStatus(sale.externalId, "failed", attemptId, accountId);
          this.appendRunLog({
            level: "error",
            stageId: "registrar_facturas_sunat",
            stepId: "cargar_factura_en_sunat",
            message,
            saleExternalId: sale.externalId,
          });
          this.syncRegistrationSummary(submitted, failed, cancelled);
          this.publish();
          if (error instanceof OperatorCancelledError) {
            throw error;
          }
          continue;
        }

      try {
        appendTimingMark(timingsFile, timingContext, "submit_start");
        const result = await this.submitPreparedSubmissionAutomatically(
          submission,
          timedStep,
        );
        appendTimingMark(timingsFile, timingContext, "submit_end");
        submitted += 1;
        this.store.markAttemptSubmitted(
          attemptId,
          result.artifacts,
          result.receiptNumber,
          result.receiptPrefix,
        );
        this.advanceWorkflow(
          "registrar_facturas_sunat",
          "esperar_revision",
          `Validación automática completada para ${sale.externalId}; continúo sin intervención manual.`,
          sale.externalId,
        );
        this.completeWorkflowStep(
          "registrar_facturas_sunat",
          "esperar_revision",
          `Validación automática lista para ${sale.externalId}.`,
          sale.externalId,
        );

        try {
          const result = await this.submitPreparedSubmissionAutomatically(
            submission,
            this.stepReporter(sale.externalId),
          );
          submitted += 1;
          this.store.markAttemptSubmitted(
            attemptId,
            result.artifacts,
            result.receiptNumber,
            result.receiptPrefix,
          );
          this.store.setSaleStatus(sale.externalId, "submitted", attemptId, accountId);
          this.enrichRunOutputWithReceiptMetadata(
            sale.externalId,
            result.receiptNumber,
            result.receiptPrefix,
          );
          this.completeWorkflowStep(
            "registrar_facturas_sunat",
            "enviar_factura",
            result.receiptNumber
              ? `Boleta registrada para ${sale.externalId} (${result.receiptNumber}).`
              : `Boleta registrada para ${sale.externalId}.`,
            sale.externalId,
          );
        } catch (error) {
          if (error instanceof OperatorCancelledError) {
            cancelled += 1;
          } else {
            failed += 1;
          }
          const message =
            error instanceof AutomationError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Error al enviar el comprobante a SUNAT.";
          const artifacts = error instanceof AutomationError ? error.artifacts : [];
          this.store.markAttemptFailed(attemptId, message, artifacts);
          this.store.setSaleStatus(sale.externalId, "failed", attemptId, accountId);
          this.appendRunLog({
            level: "error",
            stageId: "registrar_facturas_sunat",
            stepId: "enviar_factura",
            message,
            saleExternalId: sale.externalId,
          });
          this.syncRegistrationSummary(submitted, failed, cancelled);
          this.publish();
          if (error instanceof OperatorCancelledError) {
            throw error;
          }
          continue;
        }

        this.syncRegistrationSummary(submitted, failed, cancelled);
        this.publish();
      }

      this.syncRegistrationSummary(submitted, failed, cancelled);
      this.publish();
      appendTimingMark(timingsFile, timingContext, "sale_end");
    }

    this.syncRegistrationSummary(submitted, failed, cancelled);

      if (submitted === 0 && failed > 0 && cancelled === 0) {
        this.failWorkflowStep(
          "registrar_facturas_sunat",
          "cargar_factura_en_sunat",
          "No se pudo completar el registro en SUNAT para ninguna venta.",
        );
      } else {
        const boletasDownloadDir = submitted > 0 ? this.currentRunProgress().boletasDownloadDir : undefined;
        this.completeStage("registrar_facturas_sunat", submitted, boletasDownloadDir);
      }
    } finally {
      await invoiceEmitter.close?.().catch(() => undefined);
    }
  }

  private launchRun(
    reason: RunReason,
    retrySales?: Sale[],
    stepTwoOnly = false,
    fetchSalesOptions?: FetchSalesOptions,
    accountId?: string,
  ): void {
    const trackedPromise = this.run(reason, retrySales, stepTwoOnly, fetchSalesOptions, accountId).finally(() => {
      if (this.activeRunPromise === trackedPromise) {
        this.activeRunPromise = undefined;
      }
    });
    this.activeRunPromise = trackedPromise;
  }

  private async submitPreparedSubmissionAutomatically(
    submission: PreparedSubmission,
    onStep: StepReporter,
  ): Promise<Awaited<ReturnType<PreparedSubmission["submit"]>>> {
    const submissionOutcome = submission
      .submit(onStep)
      .then((result) => ({ kind: "submitted" as const, result }));
    const interruptionOutcome = submission
      .waitForInterruption()
      .then((message) => ({ kind: "interrupted" as const, message }));

    const outcome = await Promise.race([submissionOutcome, interruptionOutcome]);

    if (outcome.kind === "interrupted") {
      throw new OperatorCancelledError(
        outcome.message || "Flujo cancelado porque el navegador se cerró durante el envío.",
      );
    }

    return outcome.result;
  }

  private syncRegistrationSummary(submitted: number, failed: number, cancelled: number): void {
    const summary = this.currentRunProgress().summary;
    summary.submittedInvoices = submitted;
    summary.failedInvoices = failed;
    summary.cancelledInvoices = cancelled;
    this.syncRunProgress();
  }

  private stepReporter(saleExternalId?: string): StepReporter {
    return async (step: string) => {
      if (step.startsWith(SUNAT_MODAL_TRACE_LOG_PREFIX)) {
        const body = step.slice(SUNAT_MODAL_TRACE_LOG_PREFIX.length);
        const head = body.split("\n")[0] ?? body;
        this.runtime.currentStep =
          head.length > 120 ? `〈Traza modal SUNAT〉 ${head.slice(0, 117)}…` : `〈Traza modal SUNAT〉 ${head}`;
      } else {
        this.runtime.currentStep = step;
      }
      if (saleExternalId) {
        this.runtime.currentSaleId = saleExternalId;
      }
      this.recordWorkflowStep(step, saleExternalId);
      this.publish();
    };
  }

  private refreshNextCheckAt(): void {
    if (this.config.runMode === "manual") {
      this.runtime.nextCheckAt = undefined;
      return;
    }

    this.runtime.nextCheckAt = new Date(
      Date.now() + this.config.checkIntervalMinutes * 60 * 1000,
    ).toISOString();
  }

  private publish(): void {
    this.events.emit("state");
  }

  private getStepTwoReadiness(accountId?: string): StepTwoReadiness {
    const pendingSales = this.store.getLatestSalesForStepTwo(accountId).length;

    if (!pendingSales) {
      return {
        available: false,
        pendingSales: 0,
        message: "No hay ventas del último paso 1 listas para continuar con el paso 2.",
      };
    }

    return {
      available: true,
      pendingSales,
      message: `${pendingSales} venta(s) del último paso 1 listas para continuar con el paso 2.`,
    };
  }

  private initializeRunProgress(runId: string): void {
    const progress: RunProgress = {
      summary: {
        observedSales: 0,
        queuedSales: 0,
        submittedInvoices: 0,
        failedInvoices: 0,
        cancelledInvoices: 0,
      },
      workflowStages: buildWorkflowTemplate(),
      logs: [],
    };
    this.runProgressById.set(runId, progress);
    this.syncRunProgress();
  }

  private currentRunProgress(): RunProgress {
    const runId = this.runtime.currentRunId;
    const progress = runId ? this.runProgressById.get(runId) : undefined;

    if (!runId || !progress) {
      throw new Error("No hay una ejecución activa para actualizar el flujo.");
    }

    return progress;
  }

  private syncRunProgress(): void {
    const runId = this.runtime.currentRunId;
    if (!runId) {
      return;
    }

    this.store.updateRunSummary(runId, this.buildRunSummaryPayload());
  }

  private buildRunSummaryPayload(): Record<string, unknown> {
    const progress = this.currentRunProgress();

    return {
      ...progress.summary,
      accountId: this.runtime.currentAccountId,
      workflowStages: progress.workflowStages,
      logs: progress.logs,
      outputJsonPath: progress.outputJsonPath,
      outputJsonContent: progress.outputJsonContent,
      boletasDownloadDir: progress.boletasDownloadDir,
    };
  }

  private appendRunLog(entry: {
    level: "info" | "error" | "debug";
    stageId: string;
    stepId: string;
    message: string;
    saleExternalId?: string;
  }): void {
    const progress = this.currentRunProgress();
    progress.logs = [
      ...progress.logs.slice(-119),
      {
        at: new Date().toISOString(),
        ...entry,
      },
    ];
    this.syncRunProgress();
  }

  private advanceWorkflow(
    stageId: string,
    stepId: string,
    message: string,
    saleExternalId?: string,
  ): void {
    const progress = this.currentRunProgress();
    let reachedTarget = false;

    progress.workflowStages = progress.workflowStages.map((stage): WorkflowStage => {
      if (reachedTarget) {
        return {
          ...stage,
          status: keepFailedStatus(stage.status, "pending"),
          steps: stage.steps.map((step) => ({
            ...step,
            status: keepFailedStatus(step.status, "pending"),
          })),
        };
      }

      if (stage.id !== stageId) {
        const completedStage: WorkflowStage = {
          ...stage,
          status: keepFailedStatus(stage.status, "completed"),
          steps: stage.steps.map((step) => ({
            ...step,
            status: keepFailedStatus(step.status, "completed"),
          })),
        };
        return completedStage;
      }

      reachedTarget = true;
      let targetReachedInsideStage = false;
      const updatedStage: WorkflowStage = {
        ...stage,
        status: "active",
        steps: stage.steps.map((step) => {
          if (step.id === stepId) {
            targetReachedInsideStage = true;
            return { ...step, status: "active" };
          }

          if (!targetReachedInsideStage) {
            return { ...step, status: keepFailedStatus(step.status, "completed") };
          }

          return { ...step, status: keepFailedStatus(step.status, "pending") };
        }),
      };

      return updatedStage;
    });

    progress.currentWorkflowStageId = stageId;
    progress.currentWorkflowStepId = stepId;
    this.runtime.currentWorkflowStageId = stageId;
    this.runtime.currentWorkflowStepId = stepId;
    this.appendRunLog({
      level: "info",
      stageId,
      stepId,
      message,
      saleExternalId,
    });
    this.syncRunProgress();
  }

  private completeWorkflowStep(
    stageId: string,
    stepId: string,
    message: string,
    saleExternalId?: string,
  ): void {
    const progress = this.currentRunProgress();
    progress.workflowStages = progress.workflowStages.map((stage): WorkflowStage => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        steps: stage.steps.map((step) =>
          step.id === stepId ? { ...step, status: "completed" } : step,
        ),
      };
    });
    this.appendRunLog({
      level: "info",
      stageId,
      stepId,
      message,
      saleExternalId,
    });
    this.syncRunProgress();
  }

  private completeStage(stageId: string, outputCount?: number, outputPath?: string): void {
    const progress = this.currentRunProgress();
    progress.workflowStages = progress.workflowStages.map((stage): WorkflowStage => {
      if (stage.id !== stageId) {
        return stage;
      }

      const hasFailure =
        stage.status === "failed" || stage.steps.some((step) => step.status === "failed");
      if (hasFailure) {
        return {
          ...stage,
          outputCount: outputCount ?? stage.outputCount,
          outputPath: outputPath ?? stage.outputPath,
        };
      }

      return {
        ...stage,
        status: "completed",
        outputCount: outputCount ?? stage.outputCount,
        outputPath: outputPath ?? stage.outputPath,
        steps: stage.steps.map((step) => ({
          ...step,
          status: keepFailedStatus(step.status, "completed"),
        })),
      };
    });
    this.syncRunProgress();
  }

  private failWorkflowStep(
    stageId: string,
    stepId: string,
    message: string,
    saleExternalId?: string,
  ): void {
    const progress = this.currentRunProgress();
    progress.workflowStages = progress.workflowStages.map((stage): WorkflowStage => {
      if (stage.id !== stageId) {
        return stage;
      }

      return {
        ...stage,
        status: "failed",
        steps: stage.steps.map((step) =>
          step.id === stepId
            ? { ...step, status: "failed" }
            : step.status === "active"
              ? { ...step, status: "completed" }
              : step,
        ),
      };
    });
    this.appendRunLog({
      level: "error",
      stageId,
      stepId,
      message,
      saleExternalId,
    });
    this.syncRunProgress();
  }

  private failCurrentWorkflowStep(message: string): void {
    const progress = this.currentRunProgress();
    const stageId = progress.currentWorkflowStageId ?? "detectar_ventas";
    const stepId = progress.currentWorkflowStepId ?? "abrir_falabella";
    this.failWorkflowStep(stageId, stepId, message, this.runtime.currentSaleId);
  }

  private recordWorkflowStep(step: string, saleExternalId?: string): void {
    const isSunatModalTrace = step.startsWith(SUNAT_MODAL_TRACE_LOG_PREFIX);
    const messageForLog = isSunatModalTrace ? step.slice(SUNAT_MODAL_TRACE_LOG_PREFIX.length) : step;

    const target = this.resolveWorkflowStepTarget(step);

    if (target) {
      this.advanceWorkflow(target.stageId, target.stepId, step, saleExternalId);
      return;
    }

    const progress = this.currentRunProgress();
    const currentStage =
      progress.workflowStages.find((stage) => stage.id === progress.currentWorkflowStageId)
      ?? progress.workflowStages[0];
    const currentStep =
      currentStage?.steps.find((entry) => entry.id === progress.currentWorkflowStepId)
      ?? currentStage?.steps[0];

    this.appendRunLog({
      level: isSunatModalTrace ? "debug" : "info",
      stageId: currentStage?.id ?? "detectar_ventas",
      stepId: currentStep?.id ?? "abrir_falabella",
      message: messageForLog,
      saleExternalId,
    });
    this.syncRunProgress();
  }

  private resolveWorkflowStepTarget(step: string): { stageId: string; stepId: string } | null {
    if (!this.runtime.currentRunId) {
      return null;
    }

    const currentStageId = this.currentRunProgress().currentWorkflowStageId;

    if (
      /Falabella Seller Center|sesi[?]n del navegador para Seller|p[?]gina de ventas del seller|sitio del seller/i.test(step)
      && (!currentStageId || currentStageId === "detectar_ventas")
    ) {
      return { stageId: "detectar_ventas", stepId: "abrir_falabella" };
    }

    if (/Abriendo Documentos tributarios en Falabella/i.test(step)) {
      return { stageId: "detectar_ventas", stepId: "filtrar_ventas_pendientes" };
    }

    if (/Leyendo la orden|Leyendo la venta/i.test(step)) {
      return { stageId: "detectar_ventas", stepId: "leer_detalle_ventas" };
    }

    if (/portal SUNAT|Autenticando en SUNAT|Men\u00fa SUNAT:/i.test(step)) {
      return { stageId: "registrar_facturas_sunat", stepId: "abrir_sunat" };
    }

    if (/Llenando la factura SUNAT/i.test(step)) {
      return { stageId: "registrar_facturas_sunat", stepId: "cargar_factura_en_sunat" };
    }

    if (/Esperando aprobaci?n|Validaci[oó]n autom[aá]tica/i.test(step)) {
      return { stageId: "registrar_facturas_sunat", stepId: "esperar_revision" };
    }

    if (/Enviando factura en SUNAT/i.test(step)) {
      return { stageId: "registrar_facturas_sunat", stepId: "enviar_factura" };
    }

    return null;
  }

  private resolveSellerSource(config: AppConfig, accountId?: string): SellerSource {
    if (typeof this.sellerSourceOrFactory === "function") {
      return this.sellerSourceOrFactory(config, accountId);
    }

    return this.sellerSourceOrFactory;
  }

  private resolveInvoiceEmitter(config: AppConfig, accountId?: string): ClosableInvoiceEmitter {
    if (typeof this.invoiceEmitterOrFactory === "function") {
      return this.invoiceEmitterOrFactory(config, accountId) as ClosableInvoiceEmitter;
    }

    return this.invoiceEmitterOrFactory as ClosableInvoiceEmitter;
  }

  private writePendingSalesOutput(runId: string, sales: Sale[]): { path: string; content: string } {
    const exportDir = path.join(this.config.dataPaths.rootDir, "falabella-extract");
    fs.mkdirSync(exportDir, { recursive: true });
    const runPath = path.join(exportDir, `${runId}.json`);
    const latestPath = this.latestPendingSalesOutputPath();
    const payload = sales.map((sale) => ({
      orderNumber: sale.externalId,
      customerName: sale.customer.name,
      dni: sale.customer.documentNumber,
      total: sale.totals.total,
      productCount:
        typeof sale.raw.productCount === "number"
          ? sale.raw.productCount
          : sale.items.reduce((sum, item) => sum + item.quantity, 0),
      products: sale.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
        ...(item.documentType ? { documentType: item.documentType } : {}),
      })),
    }));

    const content = JSON.stringify(payload, null, 2);
    fs.writeFileSync(runPath, content, "utf8");
    fs.writeFileSync(latestPath, content, "utf8");
    return { path: runPath, content };
  }

  private latestPendingSalesOutputPath(): string {
    return path.join(this.config.dataPaths.rootDir, "falabella-extract", "latest.json");
  }

  private ensureRunOutputJson(runId: string, sales: Sale[]): void {
    const progress = this.currentRunProgress();
    if (progress.outputJsonPath && progress.outputJsonContent) {
      return;
    }

    const output = this.writePendingSalesOutput(runId, sales);
    progress.outputJsonPath = output.path;
    progress.outputJsonContent = output.content;
    this.appendRunLog({
      level: "info",
      stageId: "detectar_ventas",
      stepId: "exportar_json",
      message: `JSON del paso 1 recreado para esta corrida en ${output.path}.`,
    });
  }

  private ensureBoletasDownloadDir(): string {
    const progress = this.currentRunProgress();
    if (progress.boletasDownloadDir) {
      return progress.boletasDownloadDir;
    }

    const folderName = this.buildLimaTimestampFolderName();
    const boletasDownloadDir = path.join(
      this.config.dataPaths.rootDir,
      "boletas-descargadas",
      folderName,
    );
    fs.mkdirSync(boletasDownloadDir, { recursive: true });
    progress.boletasDownloadDir = boletasDownloadDir;
    this.appendRunLog({
      level: "info",
      stageId: "registrar_facturas_sunat",
      stepId: "abrir_sunat",
      message: `Carpeta de boletas de esta corrida: ${folderName} (${boletasDownloadDir}).`,
    });
    return boletasDownloadDir;
  }

  private buildLimaTimestampFolderName(date = new Date()): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;

    return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
  }

  private enrichRunOutputWithReceiptMetadata(
    saleExternalId: string,
    receiptNumber?: string,
    receiptPrefix?: string,
  ): void {
    const progress = this.currentRunProgress();
    const rawContent = progress.outputJsonContent;
    const outputJsonPath = progress.outputJsonPath;

    if (!rawContent || !outputJsonPath) {
      return;
    }

    try {
      const parsed = JSON.parse(rawContent) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }

      let updated = false;
      const nextContent = parsed.map((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("orderNumber" in entry) ||
          entry.orderNumber !== saleExternalId
        ) {
          return entry;
        }

        updated = true;
        return {
          ...entry,
          receiptNumber: receiptNumber ?? null,
          receiptPrefix: receiptPrefix ?? null,
        };
      });

      if (!updated) {
        return;
      }

      const serialized = JSON.stringify(nextContent, null, 2);
      progress.outputJsonContent = serialized;
      fs.writeFileSync(outputJsonPath, serialized, "utf8");
      fs.writeFileSync(this.latestPendingSalesOutputPath(), serialized, "utf8");
      this.syncRunProgress();
      this.appendRunLog({
        level: "info",
        stageId: "registrar_facturas_sunat",
        stepId: "enviar_factura",
        message: `JSON del run enriquecido con ${receiptNumber ?? receiptPrefix ?? "metadatos"} para la orden ${saleExternalId}.`,
        saleExternalId,
      });
    } catch {
      /* ignore malformed JSON and keep the run moving */
    }
  }
}

function buildWorkflowTemplate(): WorkflowStage[] {
  return [
    {
      id: "detectar_ventas",
      title: "Paso 1: Obtener informacion de ventas",
      description:
        "Entrar a Falabella, detectar ventas pendientes y construir el JSON con DNI, productos, precios y montos.",
      status: "pending",
      steps: [
        {
          id: "abrir_falabella",
          title: "Abrir Falabella",
          description: "Ingresar al seller y dejar lista la sesi?n.",
          status: "pending",
        },
        {
          id: "filtrar_ventas_pendientes",
          title: "Encontrar ventas pendientes",
          description: "Ir a Documentos tributarios y detectar cuales ordenes aun no tienen comprobante cargado.",
          status: "pending",
        },
        {
          id: "leer_detalle_ventas",
          title: "Leer detalle de cada venta",
          description: "Extraer DNI, cliente, productos, precios, cantidades y montos por orden.",
          status: "pending",
        },
        {
          id: "exportar_json",
          title: "Exportar salida JSON",
          description: "Guardar el resultado del paso 1 en un archivo JSON listo para usar.",
          status: "pending",
        },
      ],
    },
    {
      id: "registrar_facturas_sunat",
      title: "Paso 2: Registro de boleta electrónica",
      description:
        "Tomar las ventas detectadas, preparar cada boleta, validarla automáticamente y registrarla en SUNAT; guardar los PDFs emitidos en una carpeta de salida.",
      status: "pending",
      steps: [
        {
          id: "abrir_sunat",
          title: "Abrir SUNAT",
          description: "Ingresar al portal de emision o al flujo configurado.",
          status: "pending",
        },
        {
          id: "cargar_factura_en_sunat",
          title: "Cargar comprobante",
          description: "Completar los datos del cliente y los items de la venta.",
          status: "pending",
        },
        {
          id: "esperar_revision",
          title: "Validación automática",
          description: "Revisar el borrador y continuar al envío sin intervención humana.",
          status: "pending",
        },
        {
          id: "enviar_factura",
          title: "Registrar en SUNAT",
          description: "Enviar el comprobante y guardar el resultado.",
          status: "pending",
        },
      ],
    },
  ];
}

function keepFailedStatus(
  currentStatus: WorkflowStepStatus,
  nextStatus: Exclude<WorkflowStepStatus, "failed">,
): WorkflowStepStatus {
  return currentStatus === "failed" ? "failed" : nextStatus;
}
