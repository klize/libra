import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlStore {
  constructor(filePath) {
    this.filePath = filePath;
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
    this._dirReady = true;
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
}
