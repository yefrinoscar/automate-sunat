import { useEffect, useMemo, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { DashboardSnapshot } from "@shared/dashboard-contract";
import { WorkflowHeader } from "./components/workflow/workflow-header";
import { WorkflowStepper } from "./components/workflow/workflow-stepper";
import { StepDetails } from "./components/workflow/step-details";
import { AutomationHistorySidebar } from "./components/automation-history-sidebar";
import { Card, CardContent } from "./components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./components/ui/empty";
import { useDashboardSelection } from "./hooks/use-dashboard-selection";
import {
  buildDashboardApiUrl,
  getDashboardApiBaseCandidates,
  useDashboardState,
} from "./hooks/use-dashboard-state";
import {
  buildWorkflowHeader,
  buildWorkflowSteps,
  resolveWorkflowActiveStepId,
} from "./lib/workflow-view-model";
import { findActiveRun, findRun } from "./lib/dashboard";
import { ExpandableLogMessage } from "./components/expandable-log-message";
import { AccountSelector } from "./components/accounts/account-selector";

const STEP_TWO_STAGE_ID = "registrar_facturas_sunat";

async function requestAction(
  url: string,
  options?: {
    method?: "POST" | "DELETE";
    preferredBaseUrl?: string;
    body?: Record<string, unknown>;
  },
) {
  const payload = await requestActionJson<{ message?: string }>(url, options);
  return payload.message || "Accion completada.";
}

async function requestActionJson<T extends Record<string, unknown>>(
  url: string,
  options?: {
    method?: "POST" | "DELETE";
    preferredBaseUrl?: string;
    body?: Record<string, unknown>;
  },
) : Promise<T> {
  const method = options?.method ?? "POST";
  let lastError: unknown;

  for (const baseUrl of getDashboardApiBaseCandidates(options?.preferredBaseUrl)) {
    try {
      const init: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
        },
      };
      if (options?.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }

      const response = await fetch(buildDashboardApiUrl(baseUrl, url), init);

      const payload = (await response.json()) as T & { message?: string };

      if (!response.ok) {
        throw new Error(payload.message || "La accion fallo.");
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("La accion fallo.");
}

type DashboardWorkspaceProps = {
  snapshot: DashboardSnapshot | null;
  streamState: "loading" | "connected" | "reconnecting" | "error";
  error: string | null;
  flashMessage: string | null;
  selectedRunId?: string | null;
  selectedStageId?: string | null;
  onStartRun: () => void;
  onStopRun: () => void;
  onStartStepTwo: () => void;
  onSelectRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onCloseRun: () => void;
  onSelectStage: (stageId: string) => void;
  onApprove: (attemptId: string) => void;
  onCancel: (attemptId: string) => void;
  onRetry: (attemptId: string) => void;
  pendingAction?: "run-all" | "step-2" | "stop" | null;
  deletingRunId?: string | null;
  falabellaDocumentsSearchFrom: string;
  onFalabellaDocumentsSearchFromChange: (value: string) => void;
  falabellaDocumentsSearchTo: string;
  onFalabellaDocumentsSearchToChange: (value: string) => void;
  onClearFalabellaDocumentsSearchRange: () => void;
  accounts: DashboardSnapshot["accounts"];
  selectedAccountId: string | null;
  onSelectAccountId: (accountId: string) => void;
  onCreateAccount: (input: {
    label: string;
    sellerUsername: string;
    sellerPassword: string;
    sunatRuc: string;
    sunatUsername: string;
    sunatPassword: string;
  }) => void;
  onDeleteAccount: (accountId: string) => void;
};

function StatusMessage({ text }: { text: string }) {
  return (
    <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <ExpandableLogMessage text={text} className="text-destructive" />
      </div>
    </div>
  );
}

function resolveFocusedRun(snapshot: DashboardSnapshot, selectedRunId?: string | null) {
  const selectedRun = findRun(snapshot, selectedRunId);
  const activeRun = findActiveRun(snapshot);
  const latestRun = snapshot.runs[0] ?? null;

  return selectedRun ?? activeRun ?? latestRun;
}

export function DashboardWorkspace({
  snapshot,
  streamState: _streamState,
  error,
  flashMessage,
  selectedRunId,
  selectedStageId,
  onStartRun,
  onStopRun,
  onStartStepTwo,
  onSelectRun,
  onDeleteRun,
  onSelectStage,
  pendingAction = null,
  deletingRunId = null,
  falabellaDocumentsSearchFrom,
  onFalabellaDocumentsSearchFromChange,
  falabellaDocumentsSearchTo,
  onFalabellaDocumentsSearchToChange,
  accounts,
  selectedAccountId,
  onSelectAccountId,
  onCreateAccount,
  onDeleteAccount,
}: DashboardWorkspaceProps) {
  const [activeStepId, setActiveStepId] = useState<string>("");
  const emptyHeader = {
    workflowName: "Seller a SUNAT",
    status: "idle" as const,
    branch: "Listo para iniciar",
    totalDuration: "-",
    completedSteps: 0,
    totalSteps: 2,
  };

  const focusedRun = snapshot ? resolveFocusedRun(snapshot, selectedRunId) : null;
  const workflowSteps = snapshot && focusedRun ? buildWorkflowSteps(focusedRun, snapshot) : [];
  const resolvedStepId =
    snapshot && focusedRun ? resolveWorkflowActiveStepId(focusedRun, snapshot, selectedStageId) : undefined;
  const activeStep = workflowSteps.find((step) => step.id === activeStepId) ?? workflowSteps.find((step) => step.id === resolvedStepId) ?? workflowSteps[0];
  const activeStepNumber = activeStep ? workflowSteps.findIndex((step) => step.id === activeStep.id) + 1 : 0;

  useEffect(() => {
    if (!resolvedStepId && workflowSteps[0]?.id) {
      setActiveStepId(workflowSteps[0].id);
      return;
    }

    if (resolvedStepId) {
      setActiveStepId(resolvedStepId);
    }
  }, [resolvedStepId, workflowSteps]);

  if (!snapshot || !focusedRun) {
    if (snapshot) {
      const autoContinueStepTwo = snapshot.config.autoContinueStepTwo;
      return (
        <div className="min-h-screen bg-background">
          <WorkflowHeader
            workflowName={emptyHeader.workflowName}
            status={emptyHeader.status}
            branch={emptyHeader.branch}
            totalDuration={emptyHeader.totalDuration}
            completedSteps={emptyHeader.completedSteps}
            totalSteps={emptyHeader.totalSteps}
            startLabel={autoContinueStepTwo ? "Ejecutar workflow" : "Ejecutar paso 1"}
            runningLabel={autoContinueStepTwo ? "Workflow en curso" : "Paso 1 en curso"}
            accountSlot={
              <AccountSelector
                accounts={accounts}
                selectedAccountId={selectedAccountId}
                isDisabled={snapshot.runtime.isRunning}
                onSelect={onSelectAccountId}
                onCreate={onCreateAccount}
                onDelete={onDeleteAccount}
              />
            }
            falabellaDocumentsSearchFrom={falabellaDocumentsSearchFrom}
            onFalabellaDocumentsSearchFromChange={onFalabellaDocumentsSearchFromChange}
            falabellaDocumentsSearchTo={falabellaDocumentsSearchTo}
            onFalabellaDocumentsSearchToChange={onFalabellaDocumentsSearchToChange}
            onStartRun={onStartRun}
            onStopRun={onStopRun}
            isRunning={snapshot.runtime.isRunning}
            isStopping={pendingAction === "stop"}
          />

          <main className="container mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
            {error ? <StatusMessage text={error} /> : null}
            {flashMessage ? <StatusMessage text={flashMessage} /> : null}

            <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] xl:grid-cols-[24rem_minmax(0,1fr)]">
              <AutomationHistorySidebar
                snapshot={snapshot}
                focusedRunId=""
                onSelectRun={onSelectRun}
                onDeleteRun={onDeleteRun}
                deletingRunId={deletingRunId}
              />

              <section className="min-w-0">
                <Card>
                  <CardContent className="py-10">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No hay workflows todavía</EmptyTitle>
                        <EmptyDescription>
                          {snapshot.config.autoContinueStepTwo
                            ? "Ejecuta el workflow completo y verás aquí el detalle del proceso."
                            : "Ejecuta el paso 1 para detectar ventas y ver aquí el detalle del proceso."}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </CardContent>
                </Card>
              </section>
            </div>
          </main>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-background">
        <main className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
          {error ? <StatusMessage text={error} /> : null}
          <Card>
            <CardContent className="py-8">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{error ? "No se pudo conectar con el panel" : "No hay workflows todavía"}</EmptyTitle>
                  <EmptyDescription>
                    {error
                      ? "El dashboard no recibio el estado inicial. Si acabas de borrar el historial, el sistema debe levantar igual con una base vacia."
                      : "Ejecuta el workflow para cargar la corrida."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  const header = buildWorkflowHeader(focusedRun, snapshot);
  const stepTwoReady = snapshot.runtime.stepTwoReady;
  const autoContinueStepTwo = snapshot.config.autoContinueStepTwo;
  const startRunLabel = autoContinueStepTwo ? "Ejecutar workflow" : "Ejecutar paso 1";
  const runningRunLabel = autoContinueStepTwo ? "Workflow en curso" : "Paso 1 en curso";
  const stepAction =
    activeStep?.id === STEP_TWO_STAGE_ID && !autoContinueStepTwo
      ? {
          label: "Continuar con paso 2",
          disabled: snapshot.runtime.isRunning || !stepTwoReady.available,
          loading: pendingAction === "step-2",
          hint: snapshot.runtime.isRunning
            ? "Espera a que termine la ejecución actual para volver a abrir SUNAT."
            : stepTwoReady.message,
        }
      : undefined;

  return (
    <div className="min-h-screen bg-background">
      <WorkflowHeader
        workflowName={header.workflowName}
        status={header.status}
        branch={header.branch}
        totalDuration={header.totalDuration}
        completedSteps={header.completedSteps}
        totalSteps={header.totalSteps}
        startLabel={startRunLabel}
        runningLabel={runningRunLabel}
        accountSlot={
          <AccountSelector
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            isDisabled={snapshot.runtime.isRunning}
            onSelect={onSelectAccountId}
            onCreate={onCreateAccount}
            onDelete={onDeleteAccount}
          />
        }
        falabellaDocumentsSearchFrom={falabellaDocumentsSearchFrom}
        onFalabellaDocumentsSearchFromChange={onFalabellaDocumentsSearchFromChange}
        falabellaDocumentsSearchTo={falabellaDocumentsSearchTo}
        onFalabellaDocumentsSearchToChange={onFalabellaDocumentsSearchToChange}
        onStartRun={onStartRun}
        onStopRun={onStopRun}
        isRunning={snapshot.runtime.isRunning}
        isStopping={pendingAction === "stop"}
      />

      <main className="container mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        {error ? <StatusMessage text={error} /> : null}
        {flashMessage ? <StatusMessage text={flashMessage} /> : null}

        <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] xl:grid-cols-[24rem_minmax(0,1fr)]">
          <AutomationHistorySidebar
            snapshot={snapshot}
            focusedRunId={focusedRun.id}
            onSelectRun={onSelectRun}
            onDeleteRun={onDeleteRun}
            deletingRunId={deletingRunId}
          />

          <section className="min-w-0">
            <div className="mb-6 rounded-2xl border bg-card p-6">
              <WorkflowStepper
                steps={workflowSteps}
                activeStepId={activeStepId}
                onStepSelect={(stepId) => {
                  if (selectedRunId !== focusedRun.id) {
                    onSelectRun(focusedRun.id);
                  }
                  setActiveStepId(stepId);
                  onSelectStage(stepId);
                }}
              />
            </div>

            {activeStep ? (
              <StepDetails
                step={activeStep}
                stepNumber={activeStepNumber}
                action={stepAction}
                onAction={stepAction ? onStartStepTwo : undefined}
              />
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

export function App() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem("automation.accountId");
    } catch {
      return null;
    }
  });
  const { snapshot, streamState, error, refresh } = useDashboardState(selectedAccountId);
  const selection = useDashboardSelection(snapshot);
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"run-all" | "step-2" | "stop" | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [falabellaDocumentsSearchFrom, setFalabellaDocumentsSearchFrom] = useState("");
  const [falabellaDocumentsSearchTo, setFalabellaDocumentsSearchTo] = useState("");
  const preferredBaseUrl = snapshot?.config.baseUrl;

  const accounts = snapshot?.accounts ?? [];
  const effectiveAccountId = useMemo(() => {
    if (selectedAccountId && accounts.some((a) => a.id === selectedAccountId)) {
      return selectedAccountId;
    }
    return accounts[0]?.id ?? null;
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    if (!effectiveAccountId) {
      return;
    }
    setSelectedAccountId(effectiveAccountId);
    try {
      window.localStorage.setItem("automation.accountId", effectiveAccountId);
    } catch {
      // ignore
    }
  }, [effectiveAccountId]);

  useEffect(() => {
    if (!flashMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setFlashMessage(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [flashMessage]);

  const actions = useMemo(
    () => ({
      async onStartRun() {
        if (!effectiveAccountId) {
          setFlashMessage("Primero crea una cuenta para ejecutar la automatización.");
          return;
        }
        setPendingAction("run-all");
        try {
          const trimmed = falabellaDocumentsSearchFrom.trim();
          const trimmedTo = falabellaDocumentsSearchTo.trim();
          setFlashMessage(
            await requestAction("/api/run/manual", {
              preferredBaseUrl,
              body: {
                accountId: effectiveAccountId,
                ...(trimmed ? { falabellaDocumentsSearchFrom: trimmed } : {}),
                ...(trimmedTo ? { falabellaDocumentsSearchTo: trimmedTo } : {}),
              },
            }),
          );
          refresh();
        } finally {
          setPendingAction(null);
        }
      },
      async onStopRun() {
        setPendingAction("stop");
        try {
          setFlashMessage(await requestAction("/api/run/stop", { preferredBaseUrl }));
          refresh();
        } finally {
          setPendingAction(null);
        }
      },
      async onStartStepTwo() {
        if (!effectiveAccountId) {
          setFlashMessage("Primero crea una cuenta para ejecutar la automatización.");
          return;
        }
        setPendingAction("step-2");
        try {
          setFlashMessage(
            await requestAction("/api/run/step-2", { preferredBaseUrl, body: { accountId: effectiveAccountId } }),
          );
          refresh();
        } finally {
          setPendingAction(null);
        }
      },
      async onApprove(attemptId: string) {
        setFlashMessage(await requestAction(`/api/attempts/${attemptId}/approve`, { preferredBaseUrl }));
        refresh();
      },
      async onCancel(attemptId: string) {
        setFlashMessage(await requestAction(`/api/attempts/${attemptId}/cancel`, { preferredBaseUrl }));
        refresh();
      },
      async onRetry(attemptId: string) {
        if (!effectiveAccountId) {
          setFlashMessage("Primero crea una cuenta para ejecutar la automatización.");
          return;
        }
        setFlashMessage(
          await requestAction(`/api/attempts/${attemptId}/retry`, {
            preferredBaseUrl,
            body: { accountId: effectiveAccountId },
          }),
        );
        refresh();
      },
      async onDeleteRun(runId: string) {
        setDeletingRunId(runId);
        try {
          setFlashMessage(
            await requestAction(`/api/runs/${runId}`, {
              method: "DELETE",
              preferredBaseUrl,
            }),
          );
          refresh();
        } finally {
          setDeletingRunId(null);
        }
      },
    }),
    [preferredBaseUrl, refresh, falabellaDocumentsSearchFrom, falabellaDocumentsSearchTo, effectiveAccountId],
  );

  return (
    <DashboardWorkspace
      snapshot={snapshot}
      streamState={streamState}
      error={error}
      flashMessage={flashMessage}
      selectedRunId={selection.selectedRunId}
      selectedStageId={selection.selectedStageId}
      onStartRun={() => void actions.onStartRun()}
      onStopRun={() => void actions.onStopRun()}
      onStartStepTwo={() => void actions.onStartStepTwo()}
      onSelectRun={(runId) => selection.openRun(runId)}
      onDeleteRun={(runId) => void actions.onDeleteRun(runId)}
      onCloseRun={() => selection.closeRun()}
      onSelectStage={(stageId) => selection.selectStage(stageId)}
      onApprove={(attemptId) => void actions.onApprove(attemptId)}
      onCancel={(attemptId) => void actions.onCancel(attemptId)}
      onRetry={(attemptId) => void actions.onRetry(attemptId)}
      pendingAction={pendingAction}
      deletingRunId={deletingRunId}
      falabellaDocumentsSearchFrom={falabellaDocumentsSearchFrom}
      onFalabellaDocumentsSearchFromChange={setFalabellaDocumentsSearchFrom}
      falabellaDocumentsSearchTo={falabellaDocumentsSearchTo}
      onFalabellaDocumentsSearchToChange={setFalabellaDocumentsSearchTo}
      onClearFalabellaDocumentsSearchRange={() => {
        setFalabellaDocumentsSearchFrom("");
        setFalabellaDocumentsSearchTo("");
      }}
      accounts={accounts}
      selectedAccountId={effectiveAccountId}
      onSelectAccountId={(id) => {
        setSelectedAccountId(id);
        try {
          window.localStorage.setItem("automation.accountId", id);
        } catch {
          // ignore
        }
      }}
      onCreateAccount={async (input) => {
        try {
          const payload = await requestActionJson<{
            ok: boolean;
            account?: {
              id: string;
            };
            message?: string;
          }>("/api/accounts", { preferredBaseUrl, body: input });
          if (payload.account?.id) {
            setSelectedAccountId(payload.account.id);
            try {
              window.localStorage.setItem("automation.accountId", payload.account.id);
            } catch {
              // ignore
            }
          }
          setFlashMessage(payload.message || "Cuenta creada.");
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : "No se pudo crear la cuenta.";
          setFlashMessage(message);
        }
      }}
      onDeleteAccount={async (accountId) => {
        try {
          await requestAction(`/api/accounts/${accountId}`, { preferredBaseUrl, method: "DELETE" });
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : "No se pudo eliminar la cuenta.";
          setFlashMessage(message);
        }
      }}
    />
  );
}
