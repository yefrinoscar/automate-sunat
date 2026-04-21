import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";

const DEV_SERVER_URL = process.env.DESKTOP_DEV_URL ?? "http://127.0.0.1:5173";
const DEFAULT_PROD_PORT = 3030;

let backendProcess: ChildProcess | null = null;
let backendStarted = false;

function isDev(): boolean {
  return process.env.NODE_ENV === "development" || process.env.ELECTRON_IS_DEV === "1";
}

function getProdServerUrl(): string {
  return process.env.DESKTOP_PROD_URL ?? process.env.APP_BASE_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? DEFAULT_PROD_PORT}`;
}

async function waitForHttp(url: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok || response.status === 404 || response.status === 503) {
        return;
      }
    } catch {
      // The backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function startPackagedBackend(): void {
  if (backendStarted) {
    return;
  }
  backendStarted = true;

  const appPath = path.join(process.resourcesPath, "app-bundle");
  const userData = app.getPath("userData");
  const browsersPath = path.join(process.resourcesPath, "pw-browsers");
  const appNodeModules = path.join(process.resourcesPath, "app.asar", "node_modules");
  const entry = path.join(appPath, "dist", "src", "index.js");

  backendProcess = spawn(process.execPath, [entry], {
    cwd: appPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DATA_DIR: path.join(userData, "data"),
      NODE_PATH: [appNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      SITE_PROFILE_PATH: path.join(appPath, "config", "custom-profile.json"),
      ...(fs.existsSync(browsersPath) ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
    },
    stdio: "inherit",
  });

  backendProcess.on("error", (error) => {
    console.error("Backend spawn error:", error);
  });
}

function stopPackagedBackend(): void {
  if (!backendProcess) {
    return;
  }
  const processToStop = backendProcess;
  backendProcess = null;
  backendStarted = false;
  if (!processToStop.killed) {
    processToStop.kill("SIGTERM");
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  window.on("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const allowed = [DEV_SERVER_URL, getProdServerUrl()].some((origin) => url.startsWith(origin));
    if (allowed) {
      return;
    }
    event.preventDefault();
    void shell.openExternal(url);
  });

  return window;
}

async function loadApp(window: BrowserWindow): Promise<void> {
  if (!isDev()) {
    startPackagedBackend();
    await waitForHttp(getProdServerUrl(), 90_000);
  }

  const url = isDev() ? DEV_SERVER_URL : getProdServerUrl();
  await window.loadURL(url);
}

async function main(): Promise<void> {
  await app.whenReady();

  const window = createMainWindow();
  await loadApp(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void main();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopPackagedBackend();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopPackagedBackend();
});

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
