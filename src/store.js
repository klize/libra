import { mkdir, appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.snapshotPath = options.snapshotPath || null;
    this.sessionPath = options.sessionPath || null;
    this.session = options.session || null;
    this._dirReady = false;
  }

  async append(record) {
    const payload = `${JSON.stringify(record)}\n`;
    await this.ensureDir();
    await appendFile(this.filePath, payload, "utf8");
  }

  async ensureDir() {
    if (this._dirReady) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    if (this.snapshotPath) {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
    }
    if (this.sessionPath) {
      await mkdir(dirname(this.sessionPath), { recursive: true });
    }
    this._dirReady = true;
  }

  async writeJson(filePath, value) {
    await this.ensureDir();
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async saveSession(session = this.session) {
    if (!this.sessionPath || !session) return false;
    await this.writeJson(this.sessionPath, {
      ...session,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async loadSession() {
    if (!this.sessionPath) return null;
    return this.readJson(this.sessionPath);
  }

  async saveSnapshot(snapshot) {
    if (!this.snapshotPath || !snapshot) return false;
    await this.writeJson(this.snapshotPath, {
      ...snapshot,
      savedAt: new Date().toISOString(),
    });
    return true;
  }

  async loadSnapshot() {
    if (!this.snapshotPath) return null;
    return this.readJson(this.snapshotPath);
  }

  async loadTail(maxLines = 200) {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (!raw.trim()) {
        return [];
      }
      return raw
        .trim()
        .split("\n")
        .slice(-maxLines)
        .map((line) => JSON.parse(line));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async loadAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (!raw.trim()) {
        return [];
      }
      return raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}
