import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadConfig,
  persistFalabellaDocumentsSearchFrom,
} from "../src/config";
import { createTempDataDir } from "./helpers";

describe("config persistence", () => {
  let tempDir = "";
  let originalCwd = "";

  beforeEach(() => {
    tempDir = createTempDataDir("sunat-config");
    originalCwd = process.cwd();
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, ".env"),
      [
        "APP_PORT=3030",
        "APP_BASE_URL=http://localhost:3030",
        "DATA_DIR=./data",
        "SITE_PROFILE_PATH=./config/custom-profile.json",
        "SELLER_PURCHASED_ORDERS_URL=https://sellercenter.falabella.com/order/invoice#/purchased-order-list",
        "RUN_MODE=manual",
        "AUTO_CONTINUE_STEP_2=false",
        "CHECK_INTERVAL_MINUTES=60",
        "HEADFUL=false",
        "SLOW_MO_MS=0",
        "SELLER_USERNAME=test@example.com",
        "SELLER_PASSWORD=secret",
        "SUNAT_USERNAME=12345678",
        "SUNAT_PASSWORD=secret",
        "SUNAT_RUC=20123456789",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "config", "custom-profile.json"), JSON.stringify({}), "utf8");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists falabella search date in .env for future runs", () => {
    persistFalabellaDocumentsSearchFrom("2026-04-17");

    const envContent = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
    expect(envContent).toContain("FALABELLA_DOCUMENTS_SEARCH_FROM=2026-04-17");

    const config = loadConfig();
    expect(config.falabellaDocumentsSearchFrom).toBe("2026-04-17");
  });

  test("clears falabella search date in .env when saved empty", () => {
    persistFalabellaDocumentsSearchFrom("2026-04-17");
    persistFalabellaDocumentsSearchFrom("");

    const envContent = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
    expect(envContent).toContain("FALABELLA_DOCUMENTS_SEARCH_FROM=");

    const config = loadConfig();
    expect(config.falabellaDocumentsSearchFrom).toBeUndefined();
  });
});
