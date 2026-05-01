import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const rootDir = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
const cleanupTargets = [
  path.join(rootDir, "traces"),
  path.join(rootDir, "screenshots"),
  path.join(rootDir, "falabella-extract"),
  path.join(rootDir, "boletas-descargadas"),
  path.join(rootDir, "auth"),
];

function emptyDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

for (const directory of cleanupTargets) {
  emptyDirectory(directory);
  console.log(`Limpio: ${directory}`);
}

const dbPath = path.join(rootDir, "automation.db");
if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DELETE FROM invoice_attempts;
      DELETE FROM runs;
      DELETE FROM sales;
    `);
    db.pragma("foreign_keys = ON");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    console.log(`Reseteada DB runtime: ${dbPath}`);
  } finally {
    db.close();
  }
}
