import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAppContext } from "../src/app";
import { loadConfig } from "../src/config";
import { normalizeSale, Sale } from "../src/domain";
import { createTempDataDir, waitUntil } from "./helpers";

const sellerRuns: Array<{ kind: "falabella" | "configurable"; username: string; profileMarker?: string }> = [];
const sunatRuns: Array<{ username: string; ruc: string; profileMarker?: string }> = [];
let sellerSales: Sale[] = [];

function resolveValue<T>(source: T | (() => T)): T {
  return typeof source === "function" ? (source as () => T)() : source;
}

function writeDotenv(targetDir: string, values: Record<string, string>): void {
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(path.join(targetDir, ".env"), `${content}\n`, "utf8");
}

vi.mock("../src/profiles", () => ({
  loadSiteProfile: (config: { siteProfilePath: string }) => ({
    marker: config.siteProfilePath,
    seller: {},
    sunat: {},
  }),
}));

vi.mock("../src/browser", () => ({
  ConfigurableSellerSource: class {
    constructor(
      private readonly configSource: unknown,
      private readonly profileSource: unknown,
    ) {}

    async fetchSales(onStep: (step: string) => Promise<void> | void): Promise<Sale[]> {
      await onStep("Abriendo sesión del navegador para Seller");
      const config = resolveValue(this.configSource as () => ReturnType<typeof loadConfig>);
      const profile = resolveValue(this.profileSource as () => { marker: string });
      sellerRuns.push({
        kind: "configurable",
        username: config.sellerCredentials.username,
        profileMarker: profile.marker,
      });
      return sellerSales;
    }

    async refreshSale(
      externalId: string,
      onStep: (step: string) => Promise<void> | void,
    ): Promise<Sale | undefined> {
      await onStep(`Refrescando venta ${externalId}`);
      return sellerSales.find((sale) => sale.externalId === externalId);
    }

    async captureSaleEvidence(): Promise<[]> {
      return [];
    }
  },
  FalabellaSellerSource: class {
    constructor(private readonly configSource: unknown) {}

    async fetchSales(onStep: (step: string) => Promise<void> | void): Promise<Sale[]> {
      await onStep("Abriendo Falabella Seller Center");
      const config = resolveValue(this.configSource as () => ReturnType<typeof loadConfig>);
      sellerRuns.push({
        kind: "falabella",
        username: config.sellerCredentials.username,
      });
      return sellerSales;
    }

    async refreshSale(
      externalId: string,
      onStep: (step: string) => Promise<void> | void,
    ): Promise<Sale | undefined> {
      await onStep(`Refrescando la orden ${externalId} en Falabella`);
      return sellerSales.find((sale) => sale.externalId === externalId);
    }

    async captureSaleEvidence(): Promise<[]> {
      return [];
    }
  },
  SunatPortalEmitter: class {
    constructor(
      private readonly configSource: unknown,
      private readonly profileSource: unknown,
    ) {}

    async prepareSubmission(
      _attemptId: string,
      draft: { saleExternalId: string },
      onStep: (step: string) => Promise<void> | void,
    ) {
      const config = resolveValue(this.configSource as () => ReturnType<typeof loadConfig>);
      const profile = resolveValue(this.profileSource as () => { marker: string });
      sunatRuns.push({
        username: config.sunatCredentials.username,
        ruc: config.sunatCredentials.ruc,
        profileMarker: profile.marker,
      });

      await onStep(`Abriendo el portal SUNAT para ${draft.saleExternalId}`);

      return {
        preSubmitArtifacts: [],
        waitForInterruption: () => new Promise<string>(() => undefined),
        submit: async () => ({
          artifacts: [],
          receiptNumber: "EB01-100",
          receiptPrefix: "EB01",
        }),
        cancel: async () => [],
      };
    }

    async close(): Promise<void> {
      return;
    }
  },
  isFalabellaDocumentsUrl: (url: string) =>
    /sellercenter\.falabella\.com\/order\/invoice/i.test(url),
}));

describe("runtime .env usage", () => {
  let dataDir = "";
  let originalCwd = "";
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dataDir = createTempDataDir("sunat-runtime-env");
    originalCwd = process.cwd();
    process.chdir(dataDir);
    sellerRuns.length = 0;
    sunatRuns.length = 0;
    sellerSales = [];
    originalEnv = {
      SELLER_USERNAME: process.env.SELLER_USERNAME,
      SELLER_PASSWORD: process.env.SELLER_PASSWORD,
      SELLER_PURCHASED_ORDERS_URL: process.env.SELLER_PURCHASED_ORDERS_URL,
      SUNAT_USERNAME: process.env.SUNAT_USERNAME,
      SUNAT_PASSWORD: process.env.SUNAT_PASSWORD,
      SUNAT_RUC: process.env.SUNAT_RUC,
      SITE_PROFILE_PATH: process.env.SITE_PROFILE_PATH,
      AUTO_CONTINUE_STEP_2: process.env.AUTO_CONTINUE_STEP_2,
    };
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.chdir(originalCwd);
    fs.rmSync(dataDir, { recursive: true, force: true });
    await Promise.resolve();
  });

  test("paso 1 toma el SELLER_USERNAME y el SITE_PROFILE_PATH actualizados desde .env", async () => {
    const startupProfile = path.join(dataDir, "profile-start.json");
    const stepOneProfile = path.join(dataDir, "profile-step1.json");

    writeDotenv(dataDir, {
      SELLER_USERNAME: "startup@example.com",
      SELLER_PASSWORD: "seller-start",
      SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
      SUNAT_USERNAME: "sunat-start",
      SUNAT_PASSWORD: "sunat-pass",
      SUNAT_RUC: "11111111111",
      SITE_PROFILE_PATH: startupProfile,
      AUTO_CONTINUE_STEP_2: "false",
    });

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const context = createAppContext(config);

    try {
      writeDotenv(dataDir, {
        SELLER_USERNAME: "seller-step1@example.com",
        SELLER_PASSWORD: "seller-start",
        SELLER_PURCHASED_ORDERS_URL: "https://example.com/orders",
        SUNAT_USERNAME: "sunat-start",
        SUNAT_PASSWORD: "sunat-pass",
        SUNAT_RUC: "11111111111",
        SITE_PROFILE_PATH: stepOneProfile,
        AUTO_CONTINUE_STEP_2: "false",
      });

      await context.coordinator.triggerManualRun();
      await waitUntil(() => context.coordinator.getSnapshot().runtime.isRunning === false);

      expect(sellerRuns.at(-1)).toEqual({
        kind: "configurable",
        username: "seller-step1@example.com",
        profileMarker: stepOneProfile,
      });
    } finally {
      await context.close();
    }
  });

  test("paso 2 toma SUNAT_USERNAME, SUNAT_RUC y SITE_PROFILE_PATH actualizados desde .env", async () => {
    const startupProfile = path.join(dataDir, "profile-start.json");
    const stepTwoProfile = path.join(dataDir, "profile-step2.json");

    writeDotenv(dataDir, {
      SELLER_USERNAME: "seller@example.com",
      SELLER_PASSWORD: "seller-pass",
      SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
      SUNAT_USERNAME: "sunat-start",
      SUNAT_PASSWORD: "sunat-pass",
      SUNAT_RUC: "11111111111",
      SITE_PROFILE_PATH: startupProfile,
      AUTO_CONTINUE_STEP_2: "false",
    });

    sellerSales = [
      normalizeSale({
        externalId: "SALE-RUNTIME-1",
        issuedAt: "2026-04-17T10:00:00-05:00",
        currency: "PEN",
        customer: { name: "Cliente Runtime", documentNumber: "44556677" },
        items: [{ description: "Producto QA", quantity: 1, unitPrice: 99, total: 99 }],
        totals: { subtotal: 99, tax: 0, total: 99 },
        raw: {},
      }),
    ];

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const context = createAppContext(config);

    try {
      await context.coordinator.triggerManualRun();
      await waitUntil(() => context.coordinator.getSnapshot().runtime.isRunning === false);

      writeDotenv(dataDir, {
        SELLER_USERNAME: "seller@example.com",
        SELLER_PASSWORD: "seller-pass",
        SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
        SUNAT_USERNAME: "sunat-step2",
        SUNAT_PASSWORD: "sunat-pass-step2",
        SUNAT_RUC: "22222222222",
        SITE_PROFILE_PATH: stepTwoProfile,
        AUTO_CONTINUE_STEP_2: "false",
      });

      await context.coordinator.triggerStepTwoRun();
      await waitUntil(() => context.coordinator.getSnapshot().runtime.isRunning === false);

      expect(sunatRuns.at(-1)).toEqual({
        username: "sunat-step2",
        ruc: "22222222222",
        profileMarker: stepTwoProfile,
      });
    } finally {
      await context.close();
    }
  });

  test("AUTO_CONTINUE_STEP_2 actualizado desde .env se aplica en una corrida nueva", async () => {
    const runtimeProfile = path.join(dataDir, "profile-auto.json");

    writeDotenv(dataDir, {
      SELLER_USERNAME: "seller@example.com",
      SELLER_PASSWORD: "seller-pass",
      SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
      SUNAT_USERNAME: "sunat-auto",
      SUNAT_PASSWORD: "sunat-auto-pass",
      SUNAT_RUC: "33333333333",
      SITE_PROFILE_PATH: runtimeProfile,
      AUTO_CONTINUE_STEP_2: "false",
    });

    sellerSales = [
      normalizeSale({
        externalId: "SALE-RUNTIME-2",
        issuedAt: "2026-04-17T11:00:00-05:00",
        currency: "PEN",
        customer: { name: "Cliente Auto", documentNumber: "77889900" },
        items: [{ description: "Producto Auto", quantity: 1, unitPrice: 150, total: 150 }],
        totals: { subtotal: 150, tax: 0, total: 150 },
        raw: {},
      }),
    ];

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const context = createAppContext(config);

    try {
      writeDotenv(dataDir, {
        SELLER_USERNAME: "seller@example.com",
        SELLER_PASSWORD: "seller-pass",
        SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
        SUNAT_USERNAME: "sunat-auto",
        SUNAT_PASSWORD: "sunat-auto-pass",
        SUNAT_RUC: "33333333333",
        SITE_PROFILE_PATH: runtimeProfile,
        AUTO_CONTINUE_STEP_2: "true",
      });

      await context.coordinator.triggerManualRun();
      await waitUntil(() => context.coordinator.getSnapshot().runtime.isRunning === false);

      expect(sunatRuns).toHaveLength(1);
      expect(context.coordinator.getSnapshot().runs[0]?.workflowStages[1]?.status).toBe("completed");
    } finally {
      await context.close();
    }
  });

  test("una corrida manual usa la cuenta elegida y no las credenciales base del arranque", async () => {
    const startupProfile = path.join(dataDir, "profile-start.json");

    writeDotenv(dataDir, {
      SELLER_USERNAME: "limbo@example.com",
      SELLER_PASSWORD: "seller-pass",
      SELLER_PURCHASED_ORDERS_URL: "https://sellercenter.falabella.com/order/invoice",
      SUNAT_USERNAME: "sunat-limbo",
      SUNAT_PASSWORD: "sunat-pass",
      SUNAT_RUC: "11111111111",
      SITE_PROFILE_PATH: startupProfile,
      AUTO_CONTINUE_STEP_2: "false",
    });

    const config = loadConfig({
      APP_PORT: "3030",
      APP_BASE_URL: "http://localhost:3030",
      RUN_MODE: "manual",
      HEADFUL: "false",
      SLOW_MO_MS: "0",
      DATA_DIR: dataDir,
    });
    const context = createAppContext(config);

    try {
      const account = context.coordinator.createAccount({
        label: "Nueva",
        sellerUsername: "beautyhomeperu1@gmail.com",
        sellerPassword: "seller-pass-2",
        sunatRuc: "20612784192",
        sunatUsername: "71329360",
        sunatPassword: "sunat-pass-2",
      });

      await context.coordinator.triggerManualRun({ accountId: account.id });
      await waitUntil(() => context.coordinator.getSnapshot().runtime.isRunning === false);

      expect(sellerRuns.at(-1)).toEqual({
        kind: "falabella",
        username: "beautyhomeperu1@gmail.com",
      });
    } finally {
      await context.close();
    }
  });
});
