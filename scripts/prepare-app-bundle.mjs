import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

if (process.platform !== "darwin") {
  console.warn(
    "[prepare-app-bundle] Chromium se descargó para esta máquina (no macOS). " +
      "Para un .app usable en Mac, ejecuta `npm run prepare:mac-bundle` en macOS antes de `npm run pack:mac`.",
  );
}
const releaseRoot = path.join(root, "release");
const bundleDir = path.join(releaseRoot, "app-bundle");
const browsersDir = path.join(releaseRoot, "pw-browsers");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

const serverEntry = path.join(root, "dist", "src", "index.js");
if (!fs.existsSync(serverEntry)) {
  console.error("Falta dist/src/index.js; ejecuta primero: npm run build (tsc)");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "frontend", "dist", "index.html"))) {
  console.error("Falta frontend/dist; ejecuta primero: npm run build:web");
  process.exit(1);
}

rmrf(bundleDir);
rmrf(browsersDir);
fs.mkdirSync(bundleDir, { recursive: true });

copyDir(path.join(root, "dist"), path.join(bundleDir, "dist"));
copyDir(path.join(root, "frontend", "dist"), path.join(bundleDir, "frontend", "dist"));
copyDir(path.join(root, "config"), path.join(bundleDir, "config"));

fs.copyFileSync(path.join(root, "package.json"), path.join(bundleDir, "package.json"));
fs.copyFileSync(path.join(root, "package-lock.json"), path.join(bundleDir, "package-lock.json"));

execSync("npm ci --omit=dev", {
  cwd: bundleDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersDir,
  },
});

execSync("npx playwright install chromium", {
  cwd: bundleDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersDir,
  },
});

console.log("Bundle listo en", bundleDir);
console.log("Chromium en", browsersDir);
