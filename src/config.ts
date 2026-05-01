import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function resolveRuntimeDotenvPath(): string {
  return path.resolve(process.cwd(), ".env");
}

export function reloadRuntimeDotenv(envPath = resolveRuntimeDotenvPath()): void {
  dotenv.config({ path: envPath, override: true });
}

const booleanish = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    return value.toLowerCase() === "true";
  });

const envSchema = z.object({
  APP_PORT: z.coerce.number().int().positive().default(3030),
  APP_BASE_URL: z.string().url().optional(),
  DATA_DIR: z.string().default("./data"),
  SITE_PROFILE_PATH: z.string().default("./config/custom-profile.json"),
  SELLER_PURCHASED_ORDERS_URL: z
    .string()
    .url()
    .default("https://sellercenter.falabella.com/order/invoice#/purchased-order-list"),
  RUN_MODE: z.enum(["manual", "hourly", "both"]).default("manual"),
  AUTO_CONTINUE_STEP_2: booleanish.default(false),
  CHECK_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  HEADFUL: booleanish.default(true),
  SLOW_MO_MS: z.coerce.number().int().min(0).default(0),
  DEBUG_ARTIFACTS: booleanish.default(false),
  SUNAT_SESSION_MAX_INVOICES: z.coerce.number().int().positive().default(6),
  SELLER_USERNAME: z.string().default(""),
  SELLER_PASSWORD: z.string().default(""),
  SUNAT_USERNAME: z.string().default(""),
  SUNAT_PASSWORD: z.string().default(""),
  SUNAT_RUC: z.string().default(""),
  /** YYYY-MM-DD (fecha local). Vacío: en Falabella no se abre el filtro de fechas (se usa el rango ya mostrado). */
  FALABELLA_DOCUMENTS_SEARCH_FROM: z.string().optional().default(""),
});

/** Normaliza fecha de inicio para búsqueda en Documentos tributarios (Falabella). Vacío o solo espacios → undefined. */
export function normalizeFalabellaDocumentsSearchFromIso(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const t = raw.trim();
  if (!t) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw new Error(`La fecha de inicio debe ser YYYY-MM-DD; recibí "${raw}".`);
  }
  const [y, m, d] = t.split("-").map((p) => parseInt(p, 10));
  if (![y, m, d].every((n) => Number.isFinite(n))) {
    throw new Error(`La fecha de inicio no es válida: "${raw}".`);
  }
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d) {
    throw new Error(`Fecha de calendario inválida: "${raw}".`);
  }
  return t;
}

/** Normaliza fecha fin para búsqueda en Documentos tributarios (Falabella). Vacío o solo espacios → undefined. */
export function normalizeFalabellaDocumentsSearchToIso(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const t = raw.trim();
  if (!t) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw new Error(`La fecha de fin debe ser YYYY-MM-DD; recibí "${raw}".`);
  }
  const [y, m, d] = t.split("-").map((p) => parseInt(p, 10));
  if (![y, m, d].every((n) => Number.isFinite(n))) {
    throw new Error(`La fecha de fin no es válida: "${raw}".`);
  }
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d) {
    throw new Error(`Fecha de calendario inválida: "${raw}".`);
  }
  return t;
}

export interface AppConfig {
  port: number;
  appBaseUrl: string;
  profileKind: "custom";
  siteProfilePath: string;
  sellerPurchasedOrdersUrl: string;
  runMode: "manual" | "hourly" | "both";
  autoContinueStepTwo: boolean;
  checkIntervalMinutes: number;
  headful: boolean;
  slowMoMs: number;
  debugArtifacts: boolean;
  sunatSessionMaxInvoices: number;
  sellerCredentials: {
    username: string;
    password: string;
  };
  sunatCredentials: {
    ruc: string;
    username: string;
    password: string;
  };
  /** Inicio de barrido por fechas en Falabella (YYYY-MM-DD). Sin valor: no se interactúa con el date picker. */
  falabellaDocumentsSearchFrom?: string;
  /** Fin de barrido por fechas en Falabella (YYYY-MM-DD). Sin valor: se usa hoy (fecha local). */
  falabellaDocumentsSearchTo?: string;
  dataPaths: {
    rootDir: string;
    dbPath: string;
    authDir: string;
    screenshotsDir: string;
    tracesDir: string;
  };
}

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  const parsed = envSchema.parse({
    ...process.env,
    ...overrides,
  });

  const rootDir = path.resolve(parsed.DATA_DIR);
  const appBaseUrl = parsed.APP_BASE_URL ?? `http://localhost:${parsed.APP_PORT}`;
  const siteProfilePath = parsed.SITE_PROFILE_PATH
    ? path.resolve(parsed.SITE_PROFILE_PATH)
    : undefined;

  if (!siteProfilePath) {
    throw new Error("SITE_PROFILE_PATH es obligatorio.");
  }

  let falabellaDocumentsSearchFrom: string | undefined;
  try {
    falabellaDocumentsSearchFrom = normalizeFalabellaDocumentsSearchFromIso(parsed.FALABELLA_DOCUMENTS_SEARCH_FROM);
  } catch (error) {
    const message = error instanceof Error ? error.message : "FALABELLA_DOCUMENTS_SEARCH_FROM inválida.";
    throw new Error(`Config: ${message}`);
  }

  const config: AppConfig = {
    port: parsed.APP_PORT,
    appBaseUrl,
    profileKind: "custom",
    siteProfilePath,
    sellerPurchasedOrdersUrl: parsed.SELLER_PURCHASED_ORDERS_URL,
    runMode: parsed.RUN_MODE,
    autoContinueStepTwo: parsed.AUTO_CONTINUE_STEP_2,
    checkIntervalMinutes: parsed.CHECK_INTERVAL_MINUTES,
    headful: parsed.HEADFUL,
    slowMoMs: parsed.SLOW_MO_MS,
    debugArtifacts: parsed.DEBUG_ARTIFACTS,
    sunatSessionMaxInvoices: parsed.SUNAT_SESSION_MAX_INVOICES,
    sellerCredentials: {
      username: parsed.SELLER_USERNAME,
      password: parsed.SELLER_PASSWORD,
    },
    sunatCredentials: {
      ruc: parsed.SUNAT_RUC,
      username: parsed.SUNAT_USERNAME,
      password: parsed.SUNAT_PASSWORD,
    },
    falabellaDocumentsSearchFrom,
    dataPaths: {
      rootDir,
      dbPath: path.join(rootDir, "automation.db"),
      authDir: path.join(rootDir, "auth"),
      screenshotsDir: path.join(rootDir, "screenshots"),
      tracesDir: path.join(rootDir, "traces"),
    },
  };

  ensureDirectories(config);

  return config;
}

export function ensureDirectories(config: AppConfig): void {
  for (const directory of [
    config.dataPaths.rootDir,
    config.dataPaths.authDir,
    config.dataPaths.screenshotsDir,
    config.dataPaths.tracesDir,
  ]) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }
}

function persistEnvKey(key: string, value: string, envPath = resolveRuntimeDotenvPath()): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const assignment = `${key}=${value}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return assignment;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(assignment);
  }

  const normalized = nextLines.join("\n").replace(/\n+$/g, "");
  fs.writeFileSync(envPath, `${normalized}\n`, "utf8");
  reloadRuntimeDotenv(envPath);
}

export function persistFalabellaDocumentsSearchFrom(value: string): void {
  const normalized = normalizeFalabellaDocumentsSearchFromIso(value);
  persistEnvKey("FALABELLA_DOCUMENTS_SEARCH_FROM", normalized ?? "");
}
