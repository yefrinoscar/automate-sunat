import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const rootDir = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
const cleanupTargets = [
  path.join(rootDir, "traces"),
  path.join(rootDir, "screenshots"),
  path.join(rootDir, "falabella-extract"),
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
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    console.log(`Compactada DB: ${dbPath}`);
  } finally {
    db.close();
  }
}
