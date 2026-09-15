import readline from "node:readline";

const toLabel = (id) => (id === "human" ? "you" : id);

const toTimeText = (value) => {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const summarizeBoolean = (value) => (value ? "on" : "off");

const summarizeLimit = (limits) => {
  if (!limits || !limits.enabled) return "∞";
  if (limits.resetAt) return `${limits.remaining ?? 0} reset=${limits.resetAt}`;
  if (limits.remaining === null) return "unknown";
  return String(limits.remaining);
};

const summarizeUsage = (usage) => {
  if (!usage || !usage.known) return "unknown";
  if (usage.remaining == null) return "unknown";
  return String(usage.remaining);
};

const summarizeAdapter = (adapter) => {
  if (!adapter) return "";
  const parts = [];
  if (adapter.model) parts.push(`model=${adapter.model}`);
  if (adapter.effort) parts.push(`effort=${adapter.effort}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
};

const formatParticipantLine = (participant) =>
  `${participant.id} ${participant.state} queue=${participant.queue} busy=${participant.busy} limit=${summarizeLimit(participant.limits)} usage=${summarizeUsage(participant.usage)}${summarizeAdapter(participant.adapter)}`;

const summarizeRoomTurns = (status) => {
  if (!status.maxTurnsPerHuman) return "remainingTurns=∞";
  return `remainingTurns=${status.remainingTurnsSinceHuman ?? 0}/${status.maxTurnsPerHuman}`;
};

const parseBooleanInput = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "n"].includes(normalized)) return false;
  return null;
};

const parseNonNegativeIntInput = (value) => {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
};

const normalizeRoomConfigKey = (raw) => {
  const normalized = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalized === "a2a" ||
    normalized === "assistant2assistant" ||
    normalized === "allowassistanttoassistantreplies"
  ) {
    return "allowAssistantToAssistantReplies";
  }
  if (
    normalized === "maxturns" ||
    normalized === "maxturnsperhuman" ||
    normalized === "turnlimit" ||
    normalized === "turns"
  ) {
    return "maxTurnsPerHuman";
  }
  return normalized;
};

const commandHelp = [
  "/help",
  "/status",
  "/config",
  "/get <a2a|maxTurnsPerHuman>",
  "/participants",
  "/session",
  "/save",
  "/input",
  "/model [id] [model]",
  "/effort [id] [low|medium|high|xhigh]",
  "/clone <sourceId> <newId>",
  "/clear",
  "/a2a <on|off>",
  "/turns <number> (0 = unlimited)",
  "/set a2a <on|off>",
  "/set maxTurnsPerHuman <number> (aliases: maxTurns, turnLimit)",
  "/pause <id>",
  "/resume <id>",
  "/sleep <id>",
  "/limit <id> <number>",
  "/reset-limits <id>",
  "/send <text>",
  "/exit",
];

const countTrailingBackslashes = (value) => {
  let count = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== "\\") break;
    count += 1;
  }
  return count;
};

const isContinuationLine = (value) => countTrailingBackslashes(value) % 2 === 1;

const stripContinuationSlash = (value) => value.slice(0, -1);

const formatRow = (row) =>
  row.kind === "message"
    ? `[${toTimeText(row.at)}] ${toLabel(row.source)}: ${row.text}`
    : `[${toTimeText(row.at)}] ${row.text}`;

const formatEvent = (event) => {
  if (event?.type === "message.posted" && event.message) {
    return `[${toTimeText(event.message.createdAt)}] ${toLabel(event.message.senderId)}: ${event.message.content || ""}`;
  }
  if (event?.type === "room.turn_limit_reached") {
    return `[${toTimeText(event.at)}] turn limit reached (${event.turnCount}/${event.maxTurnsPerHuman})`;
  }
  if (event?.type === "participant.skip") {
    return `[${toTimeText(event.at)}] ${event.participantId}: ${event.reason || "skip"}`;
  }
  if (event?.type === "participant.limited") {
    const resetText = event.resetAt ? ` reset=${event.resetAt}` : " reset=unknown";
    const reasonText =
      event.reason === "provider_limit" ? "provider limit reached" : "adapter failed";
    return `[${toTimeText(event.at)}] ${event.participantId} limited: ${reasonText}; disabled${resetText}`;
  }
  if (event?.type === "participant.error") {
    return `[${toTimeText(event.at)}] ${event.participantId}: ${event.error || "error"}`;
  }
  return null;
};

const formatState = (state) => {
  if (state?.type === "participant.added") {
    return `${state.participantId} added from ${state.sourceId}`;
  }
  if (state?.type === "participant.adapter") {
    return `${state.participantId} ${state.key} -> ${state.value}`;
  }
  if (state?.state) {
    return `state ${state.participantId} -> ${state.state}`;
  }
  return "state changed";
};

export const executeLineCommand = async (client, rawCommand, output = console.log) => {
  const parts = String(rawCommand || "").trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  const args = parts;

  if (!command) return { exit: false };

  if (command === "help") {
    commandHelp.forEach((item) => output(`command: ${item}`));
    return { exit: false };
  }

  if (command === "participants" || command === "status") {
    const currentStatus = client.getStatus();
    output(
      `room=${currentStatus.roomName} totalMessages=${currentStatus.totalMessages} turns=${currentStatus.runningTurn} ${summarizeRoomTurns(currentStatus)} a2a=${summarizeBoolean(currentStatus.allowAssistantToAssistantReplies || false)}`
    );
    currentStatus.participants.map(formatParticipantLine).forEach(output);
    return { exit: false };
  }

  if (command === "config") {
    const status = client.getStatus();
    output(`a2a=${summarizeBoolean(status.allowAssistantToAssistantReplies || false)}`);
    output(`maxTurnsPerHuman=${status.maxTurnsPerHuman || 0} (${summarizeRoomTurns(status)})`);
    return { exit: false };
  }

  if (command === "session") {
    const session = client.getSessionStatus?.();
    if (!session) {
      output("session status unavailable");
      return { exit: false };
    }
    output(`session=${session.sessionId}`);
    output(`dir=${session.sessionDir || "unknown"}`);
    output(`events=${session.eventLogPath || "unknown"}`);
    output(`snapshot=${session.snapshotPath || "unknown"}`);
    output(`messages=${session.messages}`);
    return { exit: false };
  }

  if (command === "save") {
    const saved = await client.saveSession?.();
    output(saved ? "session saved" : "session save unavailable");
    return { exit: false };
  }

  if (command === "input") {
    output("input=line; multiline: end a line with \\ then Enter; raw TUI: restart with --input raw");
    return { exit: false };
  }

  if (command === "model" || command === "effort") {
    const [id, ...valueParts] = args;
    const value = valueParts.join(" ").trim();
    const currentStatus = client.getStatus();
    const key = command;
    if (!id) {
      currentStatus.participants
        .map((participant) => `${participant.id} ${key}=${participant.adapter?.[key] || "unknown"}`)
        .forEach(output);
      return { exit: false };
    }
    const participant = currentStatus.participants.find((item) => item.id === id);
    if (!participant) {
      output(`unknown participant: ${id}`);
      return { exit: false };
    }
    if (!value) {
      output(`${id} ${key}=${participant.adapter?.[key] || "unknown"}`);
      return { exit: false };
    }
    const updated =
      key === "model"
        ? client.setParticipantModel(id, value)
        : client.setParticipantEffort(id, value);
    output(
      updated
        ? `${id} ${key}=${updated[key] || value} (effective immediately, runtime only)`
        : `failed to set ${key} for ${id}`
    );
    return { exit: false };
  }

  if (command === "clone" || command === "spawn") {
    const [sourceId, newId] = args;
    if (!sourceId || !newId) {
      output("usage: /clone <sourceId> <newId>");
      return { exit: false };
    }
    const participant = client.cloneParticipant(sourceId, newId);
    output(
      participant
        ? `${newId} cloned from ${sourceId}${summarizeAdapter(participant.adapter)} (runtime only)`
        : `failed to clone ${sourceId} as ${newId} (check source exists and new id is unused)`
    );
    return { exit: false };
  }

  if (command === "get") {
    const normalizedKey = normalizeRoomConfigKey(args[0]);
    const currentStatus = client.getStatus();
    if (normalizedKey === "allowAssistantToAssistantReplies") {
      output(`a2a=${summarizeBoolean(currentStatus.allowAssistantToAssistantReplies || false)}`);
    } else if (normalizedKey === "maxTurnsPerHuman") {
      output(`maxTurnsPerHuman=${currentStatus.maxTurnsPerHuman || 0} (${summarizeRoomTurns(currentStatus)})`);
    } else {
      output("usage: /get <a2a|maxTurnsPerHuman>");
    }
    return { exit: false };
  }

  if (command === "clear") {
    console.clear();
    return { exit: false };
  }

  if (command === "a2a") {
    const parsed = parseBooleanInput(args[0]);
    if (parsed === null) {
      output("usage: /a2a <on|off>");
      return { exit: false };
    }
    output(client.setRoomConfig("a2a", parsed) ? `a2a=${summarizeBoolean(parsed)} (effective immediately)` : "failed to set a2a");
    return { exit: false };
  }

  if (command === "turns") {
    const parsed = parseNonNegativeIntInput(args[0]);
    if (parsed === null) {
      output("usage: /turns <number> (0 = unlimited)");
      return { exit: false };
    }
    output(client.setRoomConfig("maxTurnsPerHuman", parsed) ? `maxTurnsPerHuman=${parsed} (effective immediately)` : "failed to set maxTurnsPerHuman");
    return { exit: false };
  }

  if (command === "set") {
    const [rawKey, rawValue] = args;
    if (!rawKey || rawValue == null) {
      output("usage: /set <a2a|maxTurnsPerHuman> <value>");
      return { exit: false };
    }
    const normalizedKey = normalizeRoomConfigKey(rawKey);
    if (normalizedKey === "allowAssistantToAssistantReplies") {
      const parsed = parseBooleanInput(rawValue);
      output(parsed !== null && client.setRoomConfig(normalizedKey, parsed) ? `set a2a=${summarizeBoolean(parsed)} (effective immediately)` : "usage: /set a2a <on|off>");
      return { exit: false };
    }
    if (normalizedKey === "maxTurnsPerHuman") {
      const parsed = parseNonNegativeIntInput(rawValue);
      output(parsed !== null && client.setRoomConfig(normalizedKey, parsed) ? `set maxTurnsPerHuman=${parsed} (effective immediately)` : "usage: /set maxTurnsPerHuman <number> (0 = unlimited)");
      return { exit: false };
    }
    output("supported: a2a, maxTurnsPerHuman");
    return { exit: false };
  }

  if (command === "pause" || command === "resume" || command === "sleep") {
    const id = args[0];
    const nextState = command === "pause" ? "muted" : command === "sleep" ? "sleeping" : "active";
    output(id && client.setParticipantState(id, nextState) ? `${id} -> ${nextState}` : `unknown participant: ${id || "(empty)"}`);
    return { exit: false };
  }

  if (command === "limit") {
    const [id, rawLimit] = args;
    const remaining = Number(rawLimit);
    if (!id || !Number.isFinite(remaining)) {
      output("usage: /limit <id> <number>");
      return { exit: false };
    }
    output(client.setLimit(id, remaining) ? `limit for ${id} set to ${remaining}` : `unknown participant: ${id}`);
    return { exit: false };
  }

  if (command === "reset-limits") {
    const id = args[0];
    output(id && client.resetLimit(id) ? `limit reset for ${id}` : `unknown participant: ${id || "(empty)"}`);
    return { exit: false };
  }

  if (command === "send") {
    const text = args.join(" ");
    if (!text) {
      output("usage: /send <text>");
      return { exit: false };
    }
    await client.sendMessage("human", text);
    return { exit: false };
  }

  if (command === "exit" || command === "quit") {
    await client.saveSession?.();
    return { exit: true };
  }

  output(`unknown command: /${command}`);
  return { exit: false };
};

export const runLineCli = async (client, options = {}) => {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const rl = readline.createInterface({
    input,
    output,
    prompt: "you> ",
    terminal: true,
  });

  let closed = false;
  let continuation = [];

  const writeLine = (line = "") => {
    if (output.isTTY) {
      readline.clearLine(output, 0);
      readline.cursorTo(output, 0);
    }
    output.write(`${line}\n`);
    if (!closed) rl.prompt(true);
  };

  const onEvent = (event) => {
    const line = formatEvent(event);
    if (line) writeLine(line);
  };

  const onState = (state) => writeLine(formatState(state));

  const close = async () => {
    if (closed) return;
    closed = true;
    client.off("event", onEvent);
    client.off("state", onState);
    await client.saveSession?.();
    rl.close();
  };

  client.on("event", onEvent);
  client.on("state", onState);

  writeLine("connected (line input mode)");
  writeLine("Enter sends. End a line with \\ then Enter to continue a multiline message.");
  const history = await client.loadHistory(250);
  history.forEach((row) => writeLine(formatRow(row)));

  rl.on("line", async (line) => {
    try {
      if (isContinuationLine(line)) {
        continuation.push(stripContinuationSlash(line));
        rl.setPrompt("...> ");
        rl.prompt();
        return;
      }

      const text = [...continuation, line].join("\n");
      continuation = [];
      rl.setPrompt("you> ");
      const trimmed = text.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }
      if (trimmed.startsWith("/")) {
        const result = await executeLineCommand(client, trimmed.slice(1), writeLine);
        if (result.exit) {
          await close();
          return;
        }
      } else {
        await client.sendMessage("human", text);
      }
    } catch (error) {
      writeLine(String(error?.message || error));
    }
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    void close();
  });

  rl.on("close", () => {
    if (!closed) void close();
  });

  rl.prompt();
  await new Promise((resolve) => rl.once("close", resolve));
};
