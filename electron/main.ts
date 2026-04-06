import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { app, BrowserWindow, shell } from "electron";

const DEFAULT_PORT = 3030;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendStarted = false;

function projectRootDev(): string {
  return path.resolve(__dirname, "..");
}

/** Packaged server lives next to the app (extraResources → app-bundle). */
function bundledAppRoot(): string {
  return path.join(process.resourcesPath, "app-bundle");
}

function loadUserDataEnv(): void {
  const envPath = path.join(app.getPath("userData"), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getPanelUrl(): string {
  const port = process.env.APP_PORT ?? String(DEFAULT_PORT);
  const base = process.env.APP_BASE_URL;
  if (base) {
    return base;
  }
  return `http://127.0.0.1:${port}`;
}

async function waitForHttp(url: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok || response.status === 404 || response.status === 503) {
        return true;
      }
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function startBackendDev(root: string): void {
  backendProcess = spawn("npm", ["run", "dev:server"], {
    cwd: root,
    env: { ...process.env },
    stdio: "inherit",
    shell: false,
  });
  backendProcess.on("error", (err) => {
    console.error("Backend spawn error:", err);
  });
}

function startBackendProd(): void {
  loadUserDataEnv();
  const appPath = bundledAppRoot();
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  const browsersPath = path.join(process.resourcesPath, "pw-browsers");

  const entry = path.join(appPath, "dist", "src", "index.js");
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DATA_DIR: dataDir,
    SITE_PROFILE_PATH: path.join(appPath, "config", "custom-profile.json"),
    ...(fs.existsSync(browsersPath) ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
  };

  backendProcess = spawn(process.execPath, [entry], {
    cwd: appPath,
    env: childEnv,
    stdio: "inherit",
  });

  backendProcess.on("error", (err) => {
    console.error("Backend spawn error:", err);
  });
}

function ensureBackend(): void {
  if (process.env.ELECTRON_SKIP_BACKEND === "1") {
    return;
  }
  if (backendStarted) {
    return;
  }
  backendStarted = true;

  if (!app.isPackaged) {
    startBackendDev(projectRootDev());
  } else {
    startBackendProd();
  }
}

function stopBackend(): void {
  if (!backendProcess) {
    return;
  }
  const proc = backendProcess;
  backendProcess = null;
  backendStarted = false;
  proc.removeAllListeners();
  if (!proc.killed) {
    proc.kill("SIGTERM");
  }
}

function createWindow(panelUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Automate SUNAT",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void mainWindow.loadURL(panelUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function openDashboard(): Promise<void> {
  ensureBackend();
  const panelUrl = getPanelUrl();
  const ok = await waitForHttp(panelUrl, 90_000);
  if (!ok) {
    console.error("El panel no respondió a tiempo:", panelUrl);
  }
  createWindow(panelUrl);
}

void app.whenReady().then(() => {
  void openDashboard();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopBackend();
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const panelUrl = getPanelUrl();
    createWindow(panelUrl);
  }
});

app.on("before-quit", () => {
  stopBackend();
});
