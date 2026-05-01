import { EventEmitter } from "node:events";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { createServer } from "../src/server";

function createCoordinatorStub() {
  const triggerManualRun = vi.fn(async () => ({ started: true, message: "ok" }));
  const triggerStepTwoRun = vi.fn(async () => ({ started: true, message: "ok" }));
  const retryAttempt = vi.fn(async () => ({ started: true, message: "ok" }));

  return {
    events: new EventEmitter(),
    listAccounts: () => [
      {
        id: "account-1",
        label: "Principal",
        sellerUsername: "seller@example.com",
        sunatRuc: "20600000000",
        sunatUsername: "SOLUSER",
        createdAt: "2026-03-28T15:00:00.000Z",
        updatedAt: "2026-03-28T15:00:00.000Z",
      },
    ],
    getSnapshot: () => ({
      config: {
        profile: "custom",
        runMode: "manual",
        autoContinueStepTwo: false,
        checkIntervalMinutes: 60,
        headful: true,
        baseUrl: "http://localhost:3030",
      },
      runtime: {
        isRunning: false,
        currentStep: "En espera",
        pendingApprovals: [],
        stepTwoReady: {
          available: false,
          pendingSales: 0,
          message: "Sin ventas pendientes.",
        },
      },
      sales: [],
      attempts: [],
      runs: [],
    }),
    triggerManualRun,
    triggerStepTwoRun,
    stop: async () => undefined,
    approveAttempt: () => ({ ok: true, message: "ok" }),
    cancelAttempt: () => ({ ok: true, message: "ok" }),
    retryAttempt,
    deleteRun: () => ({ deleted: true, message: "deleted" }),
  };
}

describe("createServer", () => {
  test("allows local dashboard origins to call the API directly", async () => {
    const app = createServer(createCoordinatorStub() as never);

    const response = await request(app)
      .get("/api/state")
      .set("Origin", "http://127.0.0.1:5174");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5174");
  });

  test("responds to local API preflight requests", async () => {
    const app = createServer(createCoordinatorStub() as never);

    const response = await request(app)
      .options("/api/state")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
  });

  test("deletes a run through the API", async () => {
    const app = createServer(createCoordinatorStub() as never);

    const response = await request(app)
      .delete("/api/runs/run-123")
      .set("Origin", "http://127.0.0.1:5174");

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("deleted");
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5174");
  });

  test("requires an explicit selected account for manual runs", async () => {
    const coordinator = createCoordinatorStub();
    const app = createServer(coordinator as never);

    const response = await request(app)
      .post("/api/run/manual")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toContain("elige una cuenta");
    expect(coordinator.triggerManualRun).not.toHaveBeenCalled();
  });

  test("forwards the selected account on retry", async () => {
    const coordinator = createCoordinatorStub();
    const app = createServer(coordinator as never);

    const response = await request(app)
      .post("/api/attempts/attempt-1/retry")
      .send({ accountId: "account-1" });

    expect(response.status).toBe(202);
    expect(coordinator.retryAttempt).toHaveBeenCalledWith("attempt-1", "account-1");
  });
});
