#!/usr/bin/env node
import React from "react";
import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { render } from "ink";
import { LocalRoomClient } from "./room-client.js";
import { LibraTui } from "./tui.js";

const DEFAULT_CONFIG_PATH = "libra.config.json";

const defaultConfig = {
  roomName: "libra",
  wakeAfterMs: 120000,
  replyContextSize: 20,
  maxTurnsPerHuman: 6,
  allowAssistantToAssistantReplies: false,
  participants: [
    {
      id: "claude",
      name: "Claude",
      type: "assistant",
      adapter: {
        type: "command",
        name: "Claude",
        command: "claude",
        args: ["-p"],
        inputMode: "prompt-arg",
        timeoutMs: 120000,
        instruction:
          "Reply as Claude in Korean when the user writes Korean. Keep the answer brief, natural, and useful.",
        personality: { style: "근거 중심으로 짧고 단정하게", prefix: "[Claude]" },
      },
      limits: {
        enabled: false,
        remaining: null,
        unknown: true,
      },
      interruptPolicy: "continue",
    },
    {
      id: "codex",
      name: "Codex",
      type: "assistant",
      adapter: {
        type: "command",
        name: "Codex",
        command: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--json",
        ],
        inputMode: "prompt-arg",
        outputMode: "json-agent-message",
        timeoutMs: 120000,
        instruction:
          "Reply as Codex in Korean when the user writes Korean. Keep the answer brief, practical, and conversational.",
        personality: { style: "도움 되는 포인트부터 간단히", prefix: "[Codex]" },
      },
      limits: {
        enabled: false,
        remaining: null,
        unknown: true,
      },
      interruptPolicy: "continue",
    },
  ],
};

const parseArgs = (argv) => {
  const result = { flags: {}, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      result.configPath = argv[++i];
    } else if (arg === "--log" && argv[i + 1]) {
      result.logPath = argv[++i];
    } else if (arg.startsWith("--")) {
      result.flags[arg.slice(2)] = true;
    } else {
      result.args.push(arg);
    }
  }
  return result;
};

const ensureConfigExists = async (targetPath) => {
  try {
    statSync(targetPath);
    return;
  } catch {
    await writeFile(targetPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  }
};

const mergeConfigForInit = (existing = {}) => ({
  ...defaultConfig,
  ...existing,
  participants: Array.isArray(existing.participants)
    ? existing.participants
    : defaultConfig.participants,
  maxTurnsPerHuman:
    existing.maxTurnsPerHuman == null ? defaultConfig.maxTurnsPerHuman : existing.maxTurnsPerHuman,
});

const resolveProjectPath = (value) => resolve(process.cwd(), value || DEFAULT_CONFIG_PATH);

const loadConfig = async (path) => {
  const resolved = resolve(path);
  const raw = await readFile(resolved, "utf8");
  return { path: resolved, ...JSON.parse(raw) };
};

const main = async () => {
  const argv = parseArgs(process.argv.slice(2));
  const configPath = resolveProjectPath(argv.configPath);
  const modeInit = argv.flags.init === true || argv.args.includes("init");
  const modeNoInput = argv.flags["no-input"] === true;

  if (modeInit) {
    let existingConfig = {};
    try {
      existingConfig = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      existingConfig = {};
    }
    const nextConfig = mergeConfigForInit(existingConfig || {});
    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    console.log(`initialized: ${configPath}`);
    return;
  }

  await ensureConfigExists(configPath);
  const rawConfig = await loadConfig(configPath);
  const logPath = argv.logPath
    ? resolve(argv.logPath)
    : resolve(dirname(configPath), `${rawConfig.roomName || "libra"}.jsonl`);

  const client = new LocalRoomClient(rawConfig, { logPath });
  await client.connect();

  try {
    const { waitUntilExit } = render(React.createElement(LibraTui, { client, readonly: modeNoInput }));
    await waitUntilExit();
  } finally {
    client.disconnect();
  }
};

main().catch((error) => {
  console.error("libra failed:", error);
  process.exit(1);
});
