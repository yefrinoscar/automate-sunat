const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const root = path.resolve(desktopRoot, "..");
const releaseRoot = path.join(desktopRoot, "release");
const bundleDir = path.join(releaseRoot, "app-bundle");
const browsersDir = path.join(releaseRoot, "pw-browsers");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

const serverEntry = path.join(root, "dist", "src", "index.js");
const dashboardEntry = path.join(root, "frontend", "dist", "index.html");

if (!fs.existsSync(serverEntry)) {
  throw new Error("Falta dist/src/index.js; ejecuta primero npm run build.");
}

if (!fs.existsSync(dashboardEntry)) {
  throw new Error("Falta frontend/dist/index.html; ejecuta primero npm run build:web.");
}

rmrf(bundleDir);
rmrf(browsersDir);

copyDir(path.join(root, "dist"), path.join(bundleDir, "dist"));
copyDir(path.join(root, "frontend", "dist"), path.join(bundleDir, "frontend", "dist"));
copyDir(path.join(root, "config"), path.join(bundleDir, "config"));

fs.copyFileSync(path.join(root, "package.json"), path.join(bundleDir, "package.json"));
fs.copyFileSync(path.join(root, "package-lock.json"), path.join(bundleDir, "package-lock.json"));

execSync("npx playwright install chromium", {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersDir,
  },
});

console.log("Bundle listo en", bundleDir);
console.log("Chromium en", browsersDir);
