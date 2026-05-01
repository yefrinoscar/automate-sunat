import fs from "node:fs";
import path from "node:path";

export interface FalabellaSettingsFile {
  documentsSearchFrom?: string | null;
}

const SETTINGS_FILENAME = "falabella-settings.json";

export function readFalabellaSettingsFile(rootDir: string): FalabellaSettingsFile {
  const filePath = path.join(rootDir, SETTINGS_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as FalabellaSettingsFile;
  } catch {
    return {};
  }
}

export function writeFalabellaSettingsFile(rootDir: string, data: FalabellaSettingsFile): void {
  const filePath = path.join(rootDir, SETTINGS_FILENAME);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Acepta YYYY-MM-DD o vacío para desactivar el filtro por ventanas de 30 días. */
export function normalizeDocumentsSearchFrom(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined;
  }

  const [y, m, d] = trimmed.split("-").map(Number);
  const probe = new Date(y, m - 1, d);
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== m - 1 ||
    probe.getDate() !== d
  ) {
    return undefined;
  }

  return trimmed;
}

/**
 * Fecha efectiva para búsquedas en Documentos tributarios: si `falabella-settings.json`
 * define la clave `documentsSearchFrom`, manda sobre la copia en memoria (evita desajustes
 * si el proceso no actualizó `AppConfig` tras guardar desde el panel).
 */
export function resolveFalabellaDocumentsSearchFrom(config: {
  falabellaDocumentsSearchFrom?: string;
  dataPaths: { rootDir: string };
}): string | undefined {
  const fileSettings = readFalabellaSettingsFile(config.dataPaths.rootDir);
  if (Object.prototype.hasOwnProperty.call(fileSettings, "documentsSearchFrom")) {
    return normalizeDocumentsSearchFrom(fileSettings.documentsSearchFrom);
  }
  return config.falabellaDocumentsSearchFrom;
}
