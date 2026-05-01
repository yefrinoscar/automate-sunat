import fs from "node:fs";
import path from "node:path";
import express from "express";
import { AutomationCoordinator } from "./coordinator";
import { normalizeFalabellaDocumentsSearchFromIso, normalizeFalabellaDocumentsSearchToIso } from "./config";
import { z } from "zod";

const LOCAL_DASHBOARD_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

export function createServer(coordinator: AutomationCoordinator): express.Express {
  const app = express();
  const staticRoot = path.resolve(process.cwd(), "frontend/dist");
  const hasBuiltDashboard = fs.existsSync(path.join(staticRoot, "index.html"));

  const parseAccountId = (raw: unknown): string | undefined =>
    typeof raw === "string" && raw.trim() ? raw.trim() : undefined;

  const validateAccountId = (accountId: string | undefined) => {
    if (!accountId) {
      return "Primero elige una cuenta antes de iniciar el workflow.";
    }
    const exists = coordinator.listAccounts().some((account) => account.id === accountId);
    if (!exists) {
      return "La cuenta seleccionada ya no existe. Elige otra antes de continuar.";
    }
    return null;
  };

  // This emitter fans out state updates to any number of dashboard clients.
  coordinator.events.setMaxListeners(0);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");

    if (origin && LOCAL_DASHBOARD_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.append("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }

    next();
  });
  if (hasBuiltDashboard) {
    app.use(express.static(staticRoot));
  }

  app.get("/api/state", (req, res) => {
    const accountId = parseAccountId(req.query?.accountId);
    res.json(coordinator.getSnapshot(accountId));
  });

  app.get("/api/accounts", (_req, res) => {
    res.json({ accounts: coordinator.listAccounts() });
  });

  app.post("/api/accounts", (req, res) => {
    const schema = z.object({
      label: z.string().trim().min(1).max(64),
      sellerUsername: z.string().trim().min(1).max(256),
      sellerPassword: z.string().min(1).max(256),
      sunatRuc: z.string().trim().min(8).max(16),
      sunatUsername: z.string().trim().min(1).max(64),
      sunatPassword: z.string().min(1).max(256),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, message: "Datos de cuenta inválidos." });
      return;
    }

    const account = coordinator.createAccount(parsed.data);
    res.status(201).json({ ok: true, account });
  });

  app.delete("/api/accounts/:accountId", (req, res) => {
    const accountId = String(req.params.accountId || "");
    if (!accountId) {
      res.status(400).json({ ok: false, message: "accountId inválido." });
      return;
    }
    const result = coordinator.deleteAccount(accountId);
    res.status(result.deleted ? 200 : 409).json(result);
  });

  app.post("/api/run/manual", async (req, res) => {
    let falabellaDocumentsSearchFromIso: string | undefined;
    let falabellaDocumentsSearchToIso: string | undefined;
    try {
      falabellaDocumentsSearchFromIso = normalizeFalabellaDocumentsSearchFromIso(
        typeof req.body?.falabellaDocumentsSearchFrom === "string"
          ? req.body.falabellaDocumentsSearchFrom
          : undefined,
      );
      falabellaDocumentsSearchToIso = normalizeFalabellaDocumentsSearchToIso(
        typeof req.body?.falabellaDocumentsSearchTo === "string"
          ? req.body.falabellaDocumentsSearchTo
          : undefined,
      );

      if (falabellaDocumentsSearchFromIso && falabellaDocumentsSearchToIso) {
        if (falabellaDocumentsSearchFromIso > falabellaDocumentsSearchToIso) {
          throw new Error(
            `La fecha "desde" (${falabellaDocumentsSearchFromIso}) no puede ser mayor que "hasta" (${falabellaDocumentsSearchToIso}).`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fecha de inicio inválida.";
      res.status(400).json({ started: false, message });
      return;
    }

    const accountId = parseAccountId(req.body?.accountId);
    const accountError = validateAccountId(accountId);
    if (accountError) {
      res.status(400).json({ started: false, message: accountError });
      return;
    }

    const result = await coordinator.triggerManualRun({
      accountId,
      fetchSalesOptions:
        falabellaDocumentsSearchFromIso || falabellaDocumentsSearchToIso
          ? {
              falabellaDocumentsSearchFromIso,
              falabellaDocumentsSearchToIso,
            }
          : undefined,
    });
    res.status(result.started ? 202 : 409).json(result);
  });

  app.post("/api/run/step-2", async (req, res) => {
    const accountId = parseAccountId(req.body?.accountId);
    const accountError = validateAccountId(accountId);
    if (accountError) {
      res.status(400).json({ started: false, message: accountError });
      return;
    }

    const result = await coordinator.triggerStepTwoRun({ accountId });
    res.status(result.started ? 202 : 409).json(result);
  });

  app.post("/api/run/stop", async (_req, res) => {
    await coordinator.stop();
    res.status(200).json({ message: "Ejecución detenida." });
  });

  app.post("/api/attempts/:attemptId/approve", (req, res) => {
    const result = coordinator.approveAttempt(req.params.attemptId);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/attempts/:attemptId/cancel", (req, res) => {
    const result = coordinator.cancelAttempt(req.params.attemptId);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/attempts/:attemptId/retry", async (req, res) => {
    const accountId = parseAccountId(req.body?.accountId);
    const accountError = validateAccountId(accountId);
    if (accountError) {
      res.status(400).json({ started: false, message: accountError });
      return;
    }

    const result = await coordinator.retryAttempt(req.params.attemptId, accountId);
    res.status(result.started ? 202 : 409).json(result);
  });

  app.delete("/api/runs/:runId", (req, res) => {
    const result = coordinator.deleteRun(req.params.runId);
    res.status(result.deleted ? 200 : 409).json(result);
  });

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const accountId = parseAccountId(req.query?.accountId);

    const sendSnapshot = () => {
      res.write(`data: ${JSON.stringify(coordinator.getSnapshot(accountId))}\n\n`);
    };

    sendSnapshot();
    coordinator.events.on("state", sendSnapshot);

    const cleanup = () => {
      coordinator.events.off("state", sendSnapshot);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    res.on("error", cleanup);
  });

  app.get(/.*/, (_req, res) => {
    if (!hasBuiltDashboard) {
      res
        .status(503)
        .type("text/plain")
        .send("El dashboard web no esta construido. Ejecuta `npm run build:web` o `npm start`.");
      return;
    }

    res.sendFile(path.join(staticRoot, "index.html"));
  });

  return app;
}
