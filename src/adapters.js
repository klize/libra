import { spawn } from "node:child_process";

const stripAnsi = (value) =>
  toText(value, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

const toText = (value, fallback = "") => {
  if (value == null) return fallback;
  if (typeof value === "string") return value.trim();
  return String(value);
};

const trimToLine = (text, maxChars = 1500) => {
  const normalized = stripAnsi(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
};

const isLimitLikeError = (text) =>
  [
    /rate limit/i,
    /usage limit/i,
    /token limit/i,
    /limit reached/i,
    /quota/i,
    /too many requests/i,
    /429/,
    /credit balance/i,
    /insufficient credits/i,
    /capacity/i,
  ].some((pattern) => pattern.test(text));

const parseResetAt = (text) => {
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (isoMatch) return isoMatch[0];
  const untilMatch = text.match(/\b(?:until|after|at)\s+([^\n.]+)/i);
  return untilMatch ? untilMatch[1].trim() : null;
};

const createCommandError = (code, exitText, rawOutput) => {
  const error = new Error(exitText);
  error.code = code;
  error.rawOutput = rawOutput;
  error.resetAt = parseResetAt(rawOutput);
  return error;
};

const formatMessage = (message, selfId) => {
  const sender = message?.senderId === selfId ? "you" : message?.senderId || "unknown";
  return `${sender}: ${toText(message?.content, "")}`;
};

const buildPrompt = (context, instruction = "") => {
  const recentMessages = Array.isArray(context.recentMessages)
    ? context.recentMessages
    : [];
  const transcript = recentMessages
    .map((message) => formatMessage(message, context.participantId))
    .filter(Boolean)
    .join("\n");
  const fallbackTarget = toText(context.humanAnchoredText || context.targetText, "");
  const style = toText(context.personality?.style, "");
  const name = toText(context.participantName || context.participantId, "assistant");
  return [
    `You are ${name}, one participant in a shared chat room named ${context.roomName}.`,
    instruction || "Reply naturally to the latest human message. Keep it concise.",
    style ? `Style preference: ${style}` : "",
    "Do not repeat a fixed template. Do not include implementation notes.",
    transcript ? "Recent chat:" : "",
    transcript || (fallbackTarget ? `human: ${fallbackTarget}` : ""),
    "Your next chat message:",
  ]
    .filter(Boolean)
    .join("\n");
};

const parseJsonAgentMessageOutput = (output) => {
  let text = "";
  let usage = { known: false };
  for (const line of toText(output, "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        text = toText(event.item.text, text);
      }
      if (event?.type === "turn.completed" && event.usage) {
        usage = {
          known: true,
          remaining: null,
          raw: event.usage,
        };
      }
    } catch {
      // Ignore non-JSON status lines from command-line tools.
    }
  }
  return { text, usage };
};

const findFlagValue = (args, flags) => {
  const index = args.findIndex((item) => flags.includes(item));
  return index >= 0 ? args[index + 1] || null : null;
};

const upsertFlagValue = (args, preferredFlag, flags, value) => {
  const nextArgs = [...args];
  const index = nextArgs.findIndex((item) => flags.includes(item));
  if (index >= 0) {
    nextArgs[index] = preferredFlag;
    nextArgs[index + 1] = value;
    return nextArgs;
  }
  return [...nextArgs, preferredFlag, value];
};

const findConfigValue = (args, key) => {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") continue;
    const assignment = String(args[index + 1] || "");
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex < 0) continue;
    if (assignment.slice(0, separatorIndex) === key) {
      return assignment.slice(separatorIndex + 1);
    }
  }
  return null;
};

const upsertConfigValue = (args, key, value) => {
  const nextArgs = [...args];
  for (let index = 0; index < nextArgs.length; index += 1) {
    if (nextArgs[index] !== "-c" && nextArgs[index] !== "--config") continue;
    const assignment = String(nextArgs[index + 1] || "");
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex < 0) continue;
    if (assignment.slice(0, separatorIndex) === key) {
      nextArgs[index + 1] = `${key}=${value}`;
      return nextArgs;
    }
  }
  return [...nextArgs, "-c", `${key}=${value}`];
};

const isCodexCommand = (command) => /(?:^|[/\\])codex$/.test(String(command || ""));

export function resolveAdapterType(input) {
  if (!input || typeof input !== "string") return "manual";
  return input.toLowerCase();
}

export function createAdapter(config, roomName, participantId) {
  const type = resolveAdapterType(config?.type || config?.adapter);
  const options = { ...config, roomName, participantId };
  if (type === "command") return new CommandAdapter(options);
  return new ManualAdapter(options);
}

export class ManualAdapter {
  constructor(config = {}) {
    this.config = config;
    this.personality = config.personality || {};
    this.name = config.name || config.participantId || "assistant";
    this.latencyMs = Number.isFinite(config.latencyMs) ? config.latencyMs : 250;
  }

  async generateReply(context) {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const recent = toText(context.recentMessageText, "");
    const target = toText(context.targetText, "");
    const anchored = toText(context.humanAnchoredText, "");
    const style = this.personality.style || "짧고 자연스럽게";
    const prefix = this.personality.prefix || `${this.name}:`;
    const quoteSource = anchored || recent || target || "이야기를 보고 있어요.";
    return {
      text: `[manual stub] ${prefix} ${quoteSource.slice(0, 120)} ... ${style}`,
      usage: { known: false },
      supportsInterruption: false,
    };
  }

  describeSettings() {
    return {
      type: "manual",
      model: null,
      effort: null,
    };
  }
}

export class CommandAdapter {
  constructor(config = {}) {
    this.config = config;
    this.command = config.command;
    this.args = Array.isArray(config.args) ? config.args : [];
    this.cwd = config.cwd;
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30000;
    this.env = config.env || {};
    this.name = config.name || config.participantId || "adapter";
    this.inputMode = config.inputMode || "json-stdin";
    this.instruction = config.instruction || "";
    this.outputMode = config.outputMode || "plain";
  }

  describeSettings() {
    return {
      type: "command",
      command: this.command,
      model: findFlagValue(this.args, ["--model", "-m"]),
      effort: isCodexCommand(this.command)
        ? findConfigValue(this.args, "model_reasoning_effort")
        : findFlagValue(this.args, ["--effort"]),
    };
  }

  setModel(model) {
    const value = toText(model, "");
    if (!value) return null;
    this.args = isCodexCommand(this.command)
      ? upsertFlagValue(this.args, "-m", ["--model", "-m"], value)
      : upsertFlagValue(this.args, "--model", ["--model", "-m"], value);
    this.config.args = this.args;
    return this.describeSettings();
  }

  setEffort(effort) {
    const value = toText(effort, "");
    if (!value) return null;
    this.args = isCodexCommand(this.command)
      ? upsertConfigValue(this.args, "model_reasoning_effort", value)
      : upsertFlagValue(this.args, "--effort", ["--effort"], value);
    this.config.args = this.args;
    return this.describeSettings();
  }

  async generateReply(context) {
    if (!this.command) {
      throw new Error("command adapter requires command");
    }
    const prompt = buildPrompt(context, this.instruction);
    const jsonInput = JSON.stringify({
      room: context.roomName,
      participantId: context.participantId,
      targetText: context.targetText,
      humanAnchoredText: context.humanAnchoredText,
      recent: context.recentMessages,
      personality: context.personality || {},
      messageId: context.messageId,
    });
    const args =
      this.inputMode === "prompt-arg" ? [...this.args, prompt] : this.args;

    const proc = spawn(this.command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: [this.inputMode === "prompt-arg" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (this.inputMode === "prompt-stdin") {
      proc.stdin?.write(prompt);
    } else if (this.inputMode !== "prompt-arg") {
      proc.stdin?.write(jsonInput);
    }
    proc.stdin?.end();

    const stdout = [];
    const stderr = [];
    proc.stdout.on("data", (chunk) => stdout.push(chunk));
    proc.stderr.on("data", (chunk) => stderr.push(chunk));

    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`command timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    const done = new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          const stderrText = Buffer.concat(stderr).toString("utf8").trim();
          const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
          const rawOutput = stripAnsi([stderrText, stdoutText].filter(Boolean).join("\n"));
          const shortText = trimToLine(rawOutput, 500);
          const message = shortText || `command exited with ${code}`;
          const errorCode = isLimitLikeError(rawOutput)
            ? "PROVIDER_LIMIT"
            : "COMMAND_FAILED";
          return reject(createCommandError(errorCode, message, rawOutput));
        }
        return resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });

    let output;
    try {
      output = await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    const parsed =
      this.outputMode === "json-agent-message"
        ? parseJsonAgentMessageOutput(output)
        : { text: output, usage: { known: false } };
    return {
      text: trimToLine(toText(parsed.text, "I had no output.")),
      usage: parsed.usage,
      supportsInterruption: false,
    };
  }
}
