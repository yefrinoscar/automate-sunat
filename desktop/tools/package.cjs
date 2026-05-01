const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const tempRelease = path.join(os.tmpdir(), "automate-sunat-release");
const finalRelease = path.join(desktopRoot, "release");
const electronBuilder = path.join(
  desktopRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

fs.rmSync(tempRelease, { recursive: true, force: true });

execFileSync(
  electronBuilder,
  ["--config", "electron-builder.json", `-c.directories.output=${tempRelease}`],
  {
    cwd: desktopRoot,
    stdio: "inherit",
  },
);

fs.mkdirSync(finalRelease, { recursive: true });

for (const entry of fs.readdirSync(tempRelease)) {
  const source = path.join(tempRelease, entry);
  const destination = path.join(finalRelease, entry);

  if (!fs.statSync(source).isFile()) {
    continue;
  }

  fs.copyFileSync(source, destination);
}
