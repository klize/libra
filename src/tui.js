import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { PromptEditor } from "./prompt-editor.js";

const toLabel = (id) => (id === "human" ? "you" : id);

const toTimeText = (value) => {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const clampList = (items, maxLength) => {
  if (items.length <= maxLength) return items;
  return items.slice(items.length - maxLength);
};

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

const summarizeBoolean = (value) => (value ? "on" : "off");

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

const pushSystemRows = (appendRows, prefix, rows) => {
  const now = new Date().toISOString();
  const items = rows.map((text) => ({
    kind: "system",
    at: now,
    id: `${now}-${text}`,
    text,
    source: prefix,
  }));
  appendRows(items);
};

const formatConfigLines = (status) => [
  `a2a=${summarizeBoolean(status.allowAssistantToAssistantReplies || false)}`,
  `maxTurnsPerHuman=${status.maxTurnsPerHuman || 0} (${summarizeRoomTurns(status)})`,
];

export const renderRows = (rows) =>
  rows.map((row) =>
    React.createElement(
      Box,
      { key: row.id || `${row.at}-${Math.random()}`, flexDirection: "row" },
      React.createElement(
        Text,
        { color: "gray", dimColor: true },
        `[${toTimeText(row.at)}] `
      ),
      React.createElement(
        Text,
        { color: row.kind === "error" ? "red" : row.kind === "system" ? "yellow" : "green" },
        row.kind === "message" ? `${toLabel(row.source)}: ` : ""
      ),
      React.createElement(
        Text,
        { color: row.kind === "error" ? "red" : "white", dimColor: row.kind === "system" },
        row.kind === "system" ? ` ${row.text}` : row.text
      )
    )
  );

export const LibraTui = ({ client, readonly = false }) => {
  const { exit } = useApp();
  const [rows, setRows] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(() => client.getStatus());
  const [isBusy, setIsBusy] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [inputHistory, setInputHistory] = useState([]);
  const connectedAnnouncedRef = useRef(false);

  const appendRows = useCallback(
    (items) => {
      setRows((prev) => clampList([...prev, ...items], 250));
    },
    [setRows]
  );

  const refreshStatus = useCallback(() => {
    setStatus(client.getStatus());
  }, [client]);

  const emitSystemLines = useCallback(
    (texts, prefix = "system") => pushSystemRows(appendRows, prefix, texts),
    [appendRows]
  );

  const requestExit = useCallback(() => {
    void client.saveSession?.();
    exit();
  }, [client, exit]);

  const executeCommand = useCallback(
    async (rawCommand) => {
      const parts = String(rawCommand || "").trim().split(/\s+/);
      const command = (parts.shift() || "").toLowerCase();
      const args = parts;

      if (!command) return;

      if (command === "help") {
        emitSystemLines(commandHelp.map((item) => `command: ${item}`), "help");
        return;
      }

      if (command === "participants" || command === "status") {
        const currentStatus = client.getStatus();
        const header = `room=${currentStatus.roomName} totalMessages=${currentStatus.totalMessages} turns=${currentStatus.runningTurn} ${summarizeRoomTurns(currentStatus)} a2a=${summarizeBoolean(currentStatus.allowAssistantToAssistantReplies || false)}`;
        const participantLines = currentStatus.participants.map(formatParticipantLine);
        emitSystemLines([header, ...participantLines], "status");
        return;
      }

      if (command === "config") {
        emitSystemLines(formatConfigLines(client.getStatus()), "config");
        return;
      }

      if (command === "session") {
        const session = client.getSessionStatus?.();
        if (!session) {
          emitSystemLines(["session status unavailable"], "error");
          return;
        }
        emitSystemLines([
          `session=${session.sessionId}`,
          `dir=${session.sessionDir || "unknown"}`,
          `events=${session.eventLogPath || "unknown"}`,
          `snapshot=${session.snapshotPath || "unknown"}`,
          `messages=${session.messages}`,
        ], "session");
        return;
      }

      if (command === "save") {
        const saved = await client.saveSession?.();
        emitSystemLines([saved ? "session saved" : "session save unavailable"], saved ? "session" : "error");
        return;
      }

      if (command === "input") {
        emitSystemLines([
          "input=raw; iPad/SSH Korean IME safe mode: restart with --input line",
        ], "config");
        return;
      }

      if (command === "model" || command === "effort") {
        const [id, ...valueParts] = args;
        const value = valueParts.join(" ").trim();
        const currentStatus = client.getStatus();
        const key = command;
        if (!id) {
          const lines = currentStatus.participants.map((participant) => {
            const current = participant.adapter?.[key] || "unknown";
            return `${participant.id} ${key}=${current}`;
          });
          emitSystemLines(lines.length > 0 ? lines : ["no participants"], "config");
          return;
        }
        const participant = currentStatus.participants.find((item) => item.id === id);
        if (!participant) {
          emitSystemLines([`unknown participant: ${id}`], "error");
          return;
        }
        if (!value) {
          emitSystemLines([
            `${id} ${key}=${participant.adapter?.[key] || "unknown"}`,
          ], "config");
          return;
        }
        const updated =
          key === "model"
            ? client.setParticipantModel(id, value)
            : client.setParticipantEffort(id, value);
        if (!updated) {
          emitSystemLines([`failed to set ${key} for ${id}`], "error");
          return;
        }
        emitSystemLines([
          `${id} ${key}=${updated[key] || value} (effective immediately, runtime only)`,
        ], "state");
        refreshStatus();
        return;
      }

      if (command === "clone" || command === "spawn") {
        const [sourceId, newId] = args;
        if (!sourceId || !newId) {
          emitSystemLines(["usage: /clone <sourceId> <newId>"], "help");
          return;
        }
        const participant = client.cloneParticipant(sourceId, newId);
        if (!participant) {
          emitSystemLines([
            `failed to clone ${sourceId} as ${newId} (check source exists and new id is unused)`,
          ], "error");
          return;
        }
        emitSystemLines([
          `${newId} cloned from ${sourceId}${summarizeAdapter(participant.adapter)} (runtime only)`,
        ], "state");
        refreshStatus();
        return;
      }

      if (command === "get") {
        const normalizedKey = normalizeRoomConfigKey(args[0]);
        const currentStatus = client.getStatus();
        if (normalizedKey === "allowAssistantToAssistantReplies") {
          emitSystemLines([
            `a2a=${summarizeBoolean(currentStatus.allowAssistantToAssistantReplies || false)}`,
          ], "config");
          return;
        }
        if (normalizedKey === "maxTurnsPerHuman") {
          emitSystemLines([
            `maxTurnsPerHuman=${currentStatus.maxTurnsPerHuman || 0} (${summarizeRoomTurns(currentStatus)})`,
          ], "config");
          return;
        }
        emitSystemLines(["usage: /get <a2a|maxTurnsPerHuman>"], "help");
        return;
      }

      if (command === "clear") {
        setRows([]);
        emitSystemLines(["history cleared"], "system");
        return;
      }

      if (command === "a2a") {
        const rawValue = args[0];
        if (rawValue == null) {
          emitSystemLines(["usage: /a2a <on|off>"], "help");
          return;
        }
        const parsed = parseBooleanInput(rawValue);
        if (parsed === null) {
          emitSystemLines(["usage: /a2a <on|off>"], "help");
          return;
        }
        const updated = client.setRoomConfig("a2a", parsed);
        if (!updated) {
          emitSystemLines(["failed to set a2a"], "error");
          return;
        }
        emitSystemLines([`a2a=${summarizeBoolean(parsed)} (effective immediately)`], "state");
        refreshStatus();
        return;
      }

      if (command === "turns") {
        const parsed = parseNonNegativeIntInput(args[0]);
        if (parsed === null) {
          emitSystemLines(["usage: /turns <number> (0 = unlimited)"], "help");
          return;
        }
        const updated = client.setRoomConfig("maxTurnsPerHuman", parsed);
        if (!updated) {
          emitSystemLines(["failed to set maxTurnsPerHuman"], "error");
          return;
        }
        emitSystemLines([`maxTurnsPerHuman=${parsed} (effective immediately)`], "state");
        refreshStatus();
        return;
      }

      if (command === "set") {
        const [rawKey, rawValue] = args;
        if (!rawKey || rawValue == null) {
          emitSystemLines(["usage: /set <a2a|maxTurnsPerHuman> <value>"], "help");
          return;
        }
        const normalizedKey = normalizeRoomConfigKey(rawKey);
        if (normalizedKey === "allowAssistantToAssistantReplies") {
          const parsed = parseBooleanInput(rawValue);
          if (parsed === null) {
            emitSystemLines(["usage: /set a2a <on|off>"], "help");
            return;
          }
          const updated = client.setRoomConfig(normalizedKey, parsed);
          if (!updated) {
            emitSystemLines([`unknown config: ${rawKey}`], "error");
            return;
          }
          emitSystemLines([`set a2a=${summarizeBoolean(parsed)} (effective immediately)`], "state");
          refreshStatus();
          return;
        }
        if (normalizedKey === "maxTurnsPerHuman") {
          const parsed = parseNonNegativeIntInput(rawValue);
          if (parsed === null) {
            emitSystemLines(["usage: /set maxTurnsPerHuman <number> (0 = unlimited)"], "help");
            return;
          }
          const updated = client.setRoomConfig(normalizedKey, parsed);
          if (!updated) {
            emitSystemLines([`unknown config: ${rawKey}`], "error");
            return;
          }
          emitSystemLines([`set maxTurnsPerHuman=${parsed} (effective immediately)`], "state");
          refreshStatus();
          return;
        }
        emitSystemLines(["supported: a2a, maxTurnsPerHuman"], "help");
        return;
      }

      if (command === "pause" || command === "resume" || command === "sleep") {
        const id = args[0];
        const nextState = command === "pause" ? "muted" : command === "sleep" ? "sleeping" : "active";
        if (!id || !client.setParticipantState(id, nextState)) {
          emitSystemLines([`unknown participant: ${id || "(empty)"}`], "error");
          return;
        }
        emitSystemLines([`${id} -> ${nextState}`], "state");
        return;
      }

      if (command === "limit") {
        const [id, rawLimit] = args;
        const remaining = Number(rawLimit);
        if (!id || !Number.isFinite(remaining)) {
          emitSystemLines(["usage: /limit <id> <number>"], "help");
          return;
        }
        if (!client.setLimit(id, remaining)) {
          emitSystemLines([`unknown participant: ${id}`], "error");
          return;
        }
        emitSystemLines([`limit for ${id} set to ${remaining}`], "state");
        return;
      }

      if (command === "reset-limits") {
        const id = args[0];
        if (!id || !client.resetLimit(id)) {
          emitSystemLines([`unknown participant: ${id || "(empty)"}`], "error");
          return;
        }
        emitSystemLines([`limit reset for ${id}`], "state");
        return;
      }

      if (command === "send") {
        const text = args.join(" ");
        if (!text) {
          emitSystemLines(["usage: /send <text>"], "help");
          return;
        }
        await client.sendMessage("human", text);
        return;
      }

      if (command === "exit" || command === "quit") {
        requestExit();
        return;
      }

      emitSystemLines([`unknown command: /${command}`], "error");
    },
    [client, emitSystemLines, requestExit, setRows]
  );

  const rememberInput = useCallback((text) => {
    setInputHistory((prev) => {
      const trimmed = String(text || "").trim();
      if (!trimmed) return prev;
      const withoutDuplicateTail = prev[prev.length - 1] === trimmed ? prev.slice(0, -1) : prev;
      return clampList([...withoutDuplicateTail, trimmed], 100);
    });
  }, []);

  const submitLine = useCallback(
    async (value) => {
      const text = String(value || "").trim();
      if (!text) {
        setInput("");
        return;
      }

      if (text.startsWith("/")) {
        rememberInput(text);
        setInput("");
        try {
          await executeCommand(text.slice(1));
        } catch (error) {
          emitSystemLines([String(error?.message || error)], "error");
        } finally {
          refreshStatus();
        }
        return;
      }

      if (isBusy) {
        emitSystemLines(["busy, wait for current send to finish"], "system");
        return;
      }

      setInput("");
      setIsBusy(true);
      try {
        rememberInput(text);
        await client.sendMessage("human", text);
      } catch (error) {
        emitSystemLines([String(error?.message || error)], "error");
      } finally {
        refreshStatus();
        setIsBusy(false);
      }
    },
    [client, emitSystemLines, executeCommand, isBusy, refreshStatus, rememberInput]
  );

  useInput((character, key) => {
    if (key?.ctrl && character?.toLowerCase() === "c") {
      requestExit();
    }
  }, { isActive: readonly });

  useEffect(() => {
    let mounted = true;
    const onEvent = async (event) => {
      if (!mounted) return;
      if (event?.type === "message.posted" && event.message) {
        appendRows([
          {
            id: event.message.id,
            kind: "message",
            at: event.message.createdAt,
            source: event.message.senderId,
            text: event.message.content || "",
          },
        ]);
      } else if (event?.type === "room.turn_limit_reached") {
        appendRows([
          {
            id: event.eventId || `${Date.now()}`,
            kind: "system",
            at: event.at || new Date().toISOString(),
            text: `turn limit reached (${event.turnCount}/${event.maxTurnsPerHuman})`,
            source: "system",
          },
        ]);
      } else if (event?.type === "participant.skip") {
        appendRows([
          {
            id: event.eventId || `${Date.now()}`,
            kind: "system",
            at: event.at || new Date().toISOString(),
            text: `${event.participantId}: ${event.reason || "skip"}`,
            source: "system",
          },
        ]);
      } else if (event?.type === "participant.limited") {
        const resetText = event.resetAt ? ` reset=${event.resetAt}` : " reset=unknown";
        const reasonText =
          event.reason === "provider_limit"
            ? "provider limit reached"
            : "adapter failed";
        appendRows([
          {
            id: event.eventId || `${Date.now()}`,
            kind: "system",
            at: event.at || new Date().toISOString(),
            text: `${event.participantId} limited: ${reasonText}; disabled${resetText}`,
            source: "system",
          },
        ]);
      } else if (event?.type === "participant.error") {
        appendRows([
          {
            id: event.eventId || `${Date.now()}`,
            kind: "error",
            at: event.at || new Date().toISOString(),
            text: `${event.participantId}: ${event.error || "error"}`,
            source: "system",
          },
        ]);
      }
      refreshStatus();
    };
    const onState = (state) => {
      if (!mounted) return;
      const next =
        state?.type === "participant.added"
          ? `${state.participantId} added from ${state.sourceId}`
          : state?.type === "participant.adapter"
          ? `${state.participantId} ${state.key} -> ${state.value}`
          : state?.state
            ? `state ${state.participantId} -> ${state.state}`
            : `state changed`;
      emitSystemLines([next], "state");
      refreshStatus();
    };

    const init = async () => {
      try {
        if (!mounted) return;
        setHasConnected(true);
        if (!connectedAnnouncedRef.current) {
          connectedAnnouncedRef.current = true;
          emitSystemLines(["connected"], "system");
        }
        const history = await client.loadHistory(250);
        if (history.length > 0) {
          appendRows(history);
        }
      } catch {
        emitSystemLines(["failed to load history"], "error");
      }
      if (!mounted) return;
      refreshStatus();
    };

    const onConnected = () => {
      if (!mounted) return;
      setHasConnected(true);
      if (!connectedAnnouncedRef.current) {
        connectedAnnouncedRef.current = true;
        emitSystemLines(["connected"], "system");
      }
    };

    client.on("event", onEvent);
    client.on("state", onState);
    client.on("connected", onConnected);
    void init();

    return () => {
      mounted = false;
      client.off("event", onEvent);
      client.off("state", onState);
      client.off("connected", onConnected);
    };
  }, [appendRows, client, emitSystemLines, refreshStatus]);

  useEffect(() => {
    if (!hasConnected) {
      emitSystemLines(["connecting..."], "system");
    }
  }, [emitSystemLines, hasConnected]);

  const visibleRows = useMemo(() => clampList(rows, 220), [rows]);
  const helpLine = readonly
    ? "readonly mode - command input disabled"
    : "Type and Enter to send, /help for command list, Ctrl+C to quit";
  const participantLines = status.participants || [];

  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(
      Box,
      { flexDirection: "column", width: "100%", marginBottom: 1, borderStyle: "single", padding: 1 },
      React.createElement(
        Text,
        { bold: true },
        `${status.roomName} | messages=${status.totalMessages} | turns=${status.runningTurn} | ${summarizeRoomTurns(status)} | a2a=${summarizeBoolean(status.allowAssistantToAssistantReplies || false)}`
      ),
      React.createElement(Text, { color: "gray" }, `participants: ${participantLines.length}`)
    ),
    React.createElement(
      Box,
      { flexDirection: "column", width: "100%", borderStyle: "single", padding: 1 },
      participantLines.map((participant) =>
        React.createElement(Text, { key: participant.id }, formatParticipantLine(participant))
      )
    ),
    React.createElement(
      Box,
      { flexGrow: 1, width: "100%", flexDirection: "column", marginTop: 1 },
      ...renderRows(visibleRows)
    ),
    React.createElement(
      Box,
      { marginTop: 1, width: "100%", borderStyle: "single", padding: 1, flexDirection: "column" },
      React.createElement(PromptEditor, {
        value: input,
        onChange: setInput,
        onSubmit: submitLine,
        onExit: requestExit,
        history: inputHistory,
        readonly,
        disabled: false,
        busy: isBusy,
      }),
      React.createElement(Text, { dimColor: true }, helpLine)
    )
  );
};
