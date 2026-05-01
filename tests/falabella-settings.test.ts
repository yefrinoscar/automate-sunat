import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  normalizeDocumentsSearchFrom,
  readFalabellaSettingsFile,
  resolveFalabellaDocumentsSearchFrom,
  writeFalabellaSettingsFile,
} from "../src/falabella-settings";
import { createTempDataDir } from "./helpers";

describe("falabella-settings", () => {
  test("resolveFalabellaDocumentsSearchFrom prefers explicit null in file over config", () => {
    const rootDir = createTempDataDir("falabella-resolve");
    writeFalabellaSettingsFile(rootDir, { documentsSearchFrom: null });

    const resolved = resolveFalabellaDocumentsSearchFrom({
      falabellaDocumentsSearchFrom: "2026-01-01",
      dataPaths: { rootDir },
    });

    expect(resolved).toBeUndefined();
  });

  test("resolveFalabellaDocumentsSearchFrom uses file date when present", () => {
    const rootDir = createTempDataDir("falabella-resolve2");
    writeFalabellaSettingsFile(rootDir, { documentsSearchFrom: "2026-03-15" });

    const resolved = resolveFalabellaDocumentsSearchFrom({
      falabellaDocumentsSearchFrom: "2026-01-01",
      dataPaths: { rootDir },
    });

    expect(resolved).toBe("2026-03-15");
  });

  test("resolveFalabellaDocumentsSearchFrom falls back to config when file omits key", () => {
    const rootDir = createTempDataDir("falabella-resolve3");
    fs.writeFileSync(path.join(rootDir, "falabella-settings.json"), "{}\n", "utf8");
    const fileSettings = readFalabellaSettingsFile(rootDir);
    expect(Object.prototype.hasOwnProperty.call(fileSettings, "documentsSearchFrom")).toBe(false);

    const resolved = resolveFalabellaDocumentsSearchFrom({
      falabellaDocumentsSearchFrom: "2026-02-01",
      dataPaths: { rootDir },
    });

    expect(resolved).toBe("2026-02-01");
  });

  test("normalizeDocumentsSearchFrom rejects invalid calendar dates", () => {
    expect(normalizeDocumentsSearchFrom("2026-02-30")).toBeUndefined();
  });
});
