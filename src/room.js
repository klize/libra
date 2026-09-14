import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createAdapter } from "./adapters.js";

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const normalizePositiveInt = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
};

const parseNonNegativeInt = (value) => {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
};

const parseBooleanLike = (value) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "n"].includes(normalized)) return false;
  return null;
};

const nowIso = () => new Date().toISOString();

const messagePreview = (message) => {
  const raw = typeof message === "string" ? message : message?.content || "";
  return raw.replace(/\s+/g, " ").slice(0, 120);
};

const normalizeMentionText = (value) => String(value || "").trim().toLowerCase();

const classifyParticipantFailure = (error) =>
  error?.code === "PROVIDER_LIMIT" ? "provider_limit" : "adapter_error";

const clonePlain = (value) => JSON.parse(JSON.stringify(value ?? null));

const createParticipantState = (cfg) => {
  const id = String(cfg.id || "").trim() || randomUUID();
  const adapter = createAdapter(cfg.adapter || { type: "manual", participantId: id, name: cfg.name || id });
  const sourceConfig = { ...cfg };
  delete sourceConfig.adapter;
  const aliases = [
    id,
    cfg.name,
    ...(Array.isArray(cfg.aliases) ? cfg.aliases : []),
  ]
    .map(normalizeMentionText)
    .filter(Boolean);
  return {
    id,
    name: cfg.name || id,
    type: cfg.type || "assistant",
    state: cfg.state || "active",
    adapter,
    personality: cfg.personality || {},
    aliases: [...new Set(aliases)],
    status: "ready",
    active: cfg.state ? cfg.state === "active" : true,
    busy: false,
    runSeq: 0,
    queue: [],
    interruptPolicy: cfg.interruptPolicy || "continue",
    skipNextOnInterrupt: false,
    limits: {
      enabled: Boolean(cfg.limits?.enabled),
      maxCalls: clamp(cfg.limits?.maxCalls, 1, 1e9),
      remaining: cfg.limits?.remaining ?? null,
      unknown: cfg.limits?.unknown !== false,
      resetAt: cfg.limits?.resetAt || null,
    },
    usage: { known: false, remaining: null, lastChecked: null },
    draftedDraftId: null,
    draftVersion: 0,
    respondedMessageIds: new Set(),
    ...sourceConfig,
  };
};

export class Room extends EventEmitter {
  constructor(config = {}, store) {
    super();
    const normalizedConfig = { ...config };
    const maxTurnsPerHuman = normalizePositiveInt(normalizedConfig.maxTurnsPerHuman, 6);
    this.config = {
      roomName: normalizedConfig.roomName || "libra",
      wakeAfterMs: normalizedConfig.wakeAfterMs || 120_000,
      replyContextSize: clamp(normalizedConfig.replyContextSize, 1, 200) || 20,
      maxTurnsPerHuman,
      allowAssistantToAssistantReplies:
        normalizedConfig.allowAssistantToAssistantReplies === true,
      idleTurnThreshold: clamp(normalizedConfig.idleTurnThreshold || 0, 0, 1_000_000),
      participants: Array.isArray(normalizedConfig.participants) ? normalizedConfig.participants : [],
      ...normalizedConfig,
      maxTurnsPerHuman,
      allowAssistantToAssistantReplies:
        normalizedConfig.allowAssistantToAssistantReplies === true,
    };
    this.store = store || null;
    this.messages = [];
    this.participants = new Map();
    this.turnCountSinceHuman = 0;
    this.runningTurn = 0;
    this.silenceSinceMs = null;
    this.currentHumanTurnMessageId = null;
    this.nextSpeakerCursor = 0;
    (config.participants || []).forEach((cfg) => {
      const participant = createParticipantState(cfg);
      if (participant.type !== "human") {
        this.participants.set(participant.id, participant);
      }
    });
  }

  async emitEvent(event) {
    this.emit("event", event);
    if (this.store) {
      await this.store.append(event);
    }
  }

  listParticipants() {
    return [...this.participants.values()].map((participant) => ({
      id: participant.id,
      name: participant.name,
      type: participant.type,
      state: participant.state,
      active: participant.active,
      queue: participant.queue.length,
      busy: participant.busy,
      status: participant.status,
      limits: participant.limits,
      usage: participant.usage,
      adapter: participant.adapter?.describeSettings?.() || null,
    }));
  }

  async postMessage(author, content, parentMessageIds = []) {
    const text = String(content ?? "").trim();
    if (!text) return null;
    const isHuman = author === "human";

    const message = {
      id: randomUUID(),
      room: this.config.roomName,
      senderId: author,
      parentMessageIds: Array.isArray(parentMessageIds)
        ? parentMessageIds.filter(Boolean)
        : [],
      content: text,
      kind: author === "human" ? "human" : "assistant_posted",
      createdAt: nowIso(),
      draftOf: null,
    };
    this.messages.push(message);
    this.runningTurn += 1;
    if (isHuman) {
      this.turnCountSinceHuman = 0;
      this.currentHumanTurnMessageId = message.id;
      this.participants.forEach((participant) => {
        participant.respondedMessageIds = new Set();
      });
    }
    this.silenceSinceMs = null;

    await this.emitEvent({
      type: "message.posted",
      eventId: randomUUID(),
      message,
      room: this.config.roomName,
      at: message.createdAt,
    });

    if (isHuman) {
      this.broadcast(message);
    } else {
      await this.onAnyMessage(message);
    }
    return message;
  }

  async onAnyMessage(message) {
    if (
      !this.config.allowAssistantToAssistantReplies &&
      message.senderId !== "human"
    ) {
      return;
    }
    this.broadcast(message);
  }

  broadcast(message) {
    const candidateIds = this.getBroadcastCandidateIds(message);
    if (this.config.allowAssistantToAssistantReplies) {
      this.enqueueNextSpeaker(message, candidateIds);
      return;
    }
    candidateIds.forEach((id) => this.enqueueParticipant(id, message.id, message.senderId));
  }

  enqueueParticipant(id, messageId, senderId = null) {
    if (id === senderId) {
      return false;
    }
    const participant = this.participants.get(id);
    if (!participant || !participant.active || participant.type === "human") {
      return false;
    }
    if (!participant.queue.includes(messageId)) {
      participant.queue.push(messageId);
    }
    if (participant.state === "sleeping" || participant.state === "muted") {
      return false;
    }
    this.schedule(participant);
    return true;
  }

  enqueueNextSpeaker(message, candidateIds = this.getBroadcastCandidateIds(message), excludeIds = []) {
    const id = this.selectNextSpeakerId(candidateIds, message.senderId, excludeIds);
    if (!id) return false;
    return this.enqueueParticipant(id, message.id, message.senderId);
  }

  selectNextSpeakerId(candidateIds, senderId = null, excludeIds = []) {
    const blocked = new Set([senderId, ...excludeIds].filter(Boolean));
    const ids = candidateIds.filter((id) => {
      const participant = this.participants.get(id);
      return (
        participant &&
        participant.type !== "human" &&
        !blocked.has(id) &&
        this.canRun(participant) &&
        participant.state !== "sleeping" &&
        participant.state !== "muted"
      );
    });
    if (ids.length === 0) return null;
    const allIds = [...this.participants.keys()];
    const start = this.nextSpeakerCursor % Math.max(1, allIds.length);
    for (let offset = 0; offset < allIds.length; offset += 1) {
      const index = (start + offset) % allIds.length;
      const id = allIds[index];
      if (!ids.includes(id)) continue;
      this.nextSpeakerCursor = index + 1;
      return id;
    }
    return ids[0];
  }

  getBroadcastCandidateIds(message) {
    const candidateIds = [...this.participants.keys()];
    if (message.senderId !== "human") {
      return candidateIds;
    }
    const mentionedIds = this.getMentionedParticipantIds(message.content);
    return mentionedIds.length > 0 ? mentionedIds : candidateIds;
  }

  getMentionedParticipantIds(content) {
    const text = normalizeMentionText(content);
    return [...this.participants.keys()].filter((id) => {
      const participant = this.participants.get(id);
      return participant?.aliases?.some((alias) => text.includes(alias));
    });
  }

  canRun(participant) {
    if (!participant.active || participant.state !== "active") {
      return false;
    }
    if (participant.limits.enabled && participant.limits.remaining !== null) {
      if (participant.limits.remaining <= 0) return false;
    }
    return true;
  }

  schedule(participant) {
    if (participant.busy) return;
    if (!this.canRun(participant)) return;
    if (participant.queue.length === 0) return;
    if (
      this.config.maxTurnsPerHuman > 0 &&
      this.turnCountSinceHuman >= this.config.maxTurnsPerHuman
    ) {
      participant.queue = [];
      return;
    }
    setTimeout(() => {
      this.runParticipant(participant).catch((error) => {
        void this.disableParticipant(participant, error, {
          reason: classifyParticipantFailure(error),
        });
      });
    }, 0);
  }

  async disableParticipant(participant, error, details = {}) {
    const reason = details.reason || classifyParticipantFailure(error);
    const resetAt = error?.resetAt || null;
    participant.status = "limited";
    participant.state = "limited";
    participant.active = false;
    participant.queue = [];
    participant.limits.enabled = true;
    participant.limits.remaining = 0;
    participant.limits.unknown = false;
    participant.limits.resetAt = resetAt;
    participant.limits.lastSet = {
      reason,
      at: nowIso(),
    };
    await this.emitEvent({
      type: "participant.limited",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId: participant.id,
      reason,
      resetAt,
      runSeq: details.runSeq,
      draftId: details.draftId,
      at: nowIso(),
    });
  }

  async runParticipant(participant) {
    if (participant.busy) return;
    if (!this.canRun(participant)) return;

    if (
      this.config.maxTurnsPerHuman > 0 &&
      this.turnCountSinceHuman >= this.config.maxTurnsPerHuman
    ) {
      await this.emitEvent({
        type: "room.turn_limit_reached",
        eventId: randomUUID(),
        room: this.config.roomName,
        reason: "maxTurnsPerHuman",
        turnCount: this.turnCountSinceHuman,
        maxTurnsPerHuman: this.config.maxTurnsPerHuman,
        at: nowIso(),
      });
      participant.queue = [];
      return;
    }
    const queuedIds = participant.queue.splice(0, participant.queue.length);
    if (queuedIds.length === 0) return;

    const queuedMessages = this.messages.filter((item) => queuedIds.includes(item.id));
    const targetMessage = this.messages.find((item) => item.id === queuedIds[queuedIds.length - 1]);
    const targetIndex = targetMessage ? this.messages.indexOf(targetMessage) : -1;
    const latestHumanMessage =
      targetIndex >= 0
        ? [...this.messages.slice(0, targetIndex + 1)]
            .reverse()
            .find((item) => item.senderId === "human")
        : [...queuedMessages]
            .reverse()
            .find((item) => item.senderId === "human");
    const activeHumanTurnMessageId =
      latestHumanMessage?.id || this.currentHumanTurnMessageId;
    if (this.config.allowAssistantToAssistantReplies) {
      if (!activeHumanTurnMessageId || !targetMessage) {
        return;
      }
      if (participant.respondedMessageIds.has(targetMessage.id)) {
        await this.emitEvent({
          type: "participant.skip",
          eventId: randomUUID(),
          room: this.config.roomName,
          participantId: participant.id,
          reason: "already_responded_to_message",
          at: nowIso(),
        });
        return;
      }
      if (this.currentHumanTurnMessageId !== activeHumanTurnMessageId) {
        this.currentHumanTurnMessageId = activeHumanTurnMessageId;
      }
      participant.respondedMessageIds.add(targetMessage.id);
    }

    this.turnCountSinceHuman += 1;
    participant.busy = true;
    participant.runSeq += 1;
    const runSeq = participant.runSeq;
    const draftId = randomUUID();
    participant.draftedDraftId = draftId;
    participant.draftVersion += 1;

    const contextEndIndex = targetIndex >= 0 ? targetIndex + 1 : this.messages.length;
    const recentMessages = this.messages.slice(
      Math.max(0, contextEndIndex - this.config.replyContextSize),
      contextEndIndex
    );
    const humanAnchoredText = messagePreview(latestHumanMessage || targetMessage);

    await this.emitEvent({
      type: "message.draft_started",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId: participant.id,
      runSeq,
      draftId,
      messageIds: queuedIds,
      at: nowIso(),
    });

    let replyText = "";
    try {
      const context = {
        roomName: this.config.roomName,
        participantId: participant.id,
        participantName: participant.name,
        messageId: draftId,
        targetText: messagePreview(targetMessage),
        humanAnchoredText,
        recentMessageText: recentMessages.map((item) => item.content).join("\n"),
        recentMessages,
        personality: participant.personality || {},
      };
      const result = await participant.adapter.generateReply(context);
      replyText = String(result?.text || "").trim();
      participant.usage = {
        known: Boolean(result?.usage?.known),
        remaining: result?.usage?.remaining ?? participant.usage.remaining,
        lastChecked: nowIso(),
      };
      if (!replyText) {
        await this.emitEvent({
          type: "participant.skip",
          eventId: randomUUID(),
          room: this.config.roomName,
          participantId: participant.id,
          reason: "empty_reply",
          runSeq,
          at: nowIso(),
        });
      } else {
        if (participant.limits.enabled && participant.limits.remaining !== null) {
          participant.limits.remaining = Math.max(
            0,
            participant.limits.remaining - 1
          );
        }
        await this.postMessage(participant.id, replyText, queuedIds);
        await this.emitEvent({
          type: "message.draft_completed",
          eventId: randomUUID(),
          room: this.config.roomName,
          participantId: participant.id,
          runSeq,
          draftId,
          postedMessageText: messagePreview(replyText),
          at: nowIso(),
        });
      }
      participant.status = "ready";
    } catch (error) {
      await this.disableParticipant(participant, error, {
        reason: classifyParticipantFailure(error),
        runSeq,
        draftId,
      });
      if (this.config.allowAssistantToAssistantReplies && targetMessage) {
        this.enqueueNextSpeaker(targetMessage, this.getBroadcastCandidateIds(targetMessage), [
          participant.id,
        ]);
      }
    } finally {
      participant.busy = false;
      participant.draftedDraftId = null;
    }

    if (participant.state === "active" && participant.queue.length > 0) {
      const shouldSkip = participant.interruptPolicy === "skip";
      if (shouldSkip) {
        participant.queue = [];
        await this.emitEvent({
          type: "participant.skip",
          eventId: randomUUID(),
          room: this.config.roomName,
          participantId: participant.id,
          reason: "interrupted_cancel",
          at: nowIso(),
        });
      } else {
        this.schedule(participant);
      }
    }
  }

  markMessageFromQueue(participantId, messageId) {
    const participant = this.participants.get(participantId);
    if (!participant) return false;
    const exists = this.messages.some((item) => item.id === messageId);
    if (!exists) return false;
    participant.queue.push(messageId);
    if (participant.interruptPolicy === "revise" && participant.busy) {
      participant.skipNextOnInterrupt = true;
      this.emitEvent({
        type: "participant.interrupt_noted",
        eventId: randomUUID(),
        room: this.config.roomName,
        participantId,
        messageId,
        at: nowIso(),
      });
    }
    this.schedule(participant);
    return true;
  }

  setParticipantState(participantId, nextState, note = "") {
    const participant = this.participants.get(participantId);
    if (!participant) {
      return false;
    }
    participant.state = nextState;
    participant.active = nextState === "active";
    participant.status = nextState;
    this.emit("state", {
      type: "participant.state",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId,
      state: nextState,
      note,
      at: nowIso(),
    });
    return true;
  }

  setLimit(participantId, remaining, reason = "owner-set") {
    const participant = this.participants.get(participantId);
    if (!participant) return false;
    participant.limits.enabled = true;
    participant.limits.remaining = Number.isFinite(remaining) ? remaining : 0;
    participant.limits.unknown = false;
    participant.limits.lastSet = { reason, at: nowIso() };
    participant.state = participant.limits.remaining <= 0 ? "limited" : participant.state;
    participant.active = participant.state === "active";
    this.emitEvent({
      type: "participant.limit",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId,
      remaining: participant.limits.remaining,
      reason,
      at: nowIso(),
    });
    return true;
  }

  cloneParticipant(sourceId, newId) {
    const source = this.participants.get(sourceId);
    const id = String(newId || "").trim();
    if (!source || !id || this.participants.has(id)) {
      return null;
    }
    const cfg = {
      id,
      name: id,
      type: source.type,
      state: "active",
      adapter: {
        ...clonePlain(source.adapter?.config || {}),
        name: id,
      },
      personality: clonePlain(source.personality || {}),
      aliases: [id],
      limits: {
        enabled: false,
        remaining: null,
        unknown: true,
      },
      interruptPolicy: source.interruptPolicy || "continue",
    };
    const participant = createParticipantState(cfg);
    if (participant.type === "human") {
      return null;
    }
    this.participants.set(participant.id, participant);
    this.config.participants = [...(this.config.participants || []), cfg];
    this.emit("state", {
      type: "participant.added",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId: participant.id,
      sourceId,
      at: nowIso(),
    });
    return this.listParticipants().find((item) => item.id === participant.id) || null;
  }

  setParticipantModel(participantId, model) {
    const participant = this.participants.get(participantId);
    if (!participant || typeof participant.adapter?.setModel !== "function") {
      return null;
    }
    const previous = participant.adapter.describeSettings?.() || null;
    const adapter = participant.adapter.setModel(model);
    if (!adapter) return null;
    this.emit("state", {
      type: "participant.adapter",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId,
      key: "model",
      previous: previous?.model ?? null,
      value: adapter.model,
      at: nowIso(),
    });
    return adapter;
  }

  setParticipantEffort(participantId, effort) {
    const participant = this.participants.get(participantId);
    if (!participant || typeof participant.adapter?.setEffort !== "function") {
      return null;
    }
    const previous = participant.adapter.describeSettings?.() || null;
    const adapter = participant.adapter.setEffort(effort);
    if (!adapter) return null;
    this.emit("state", {
      type: "participant.adapter",
      eventId: randomUUID(),
      room: this.config.roomName,
      participantId,
      key: "effort",
      previous: previous?.effort ?? null,
      value: adapter.effort,
      at: nowIso(),
    });
    return adapter;
  }

  getStatus() {
    const maxTurnsPerHuman = this.config.maxTurnsPerHuman || 0;
    return {
      roomName: this.config.roomName,
      totalMessages: this.messages.length,
      participants: this.listParticipants(),
      runningTurn: this.runningTurn,
      turnCountSinceHuman: this.turnCountSinceHuman,
      allowAssistantToAssistantReplies: this.config.allowAssistantToAssistantReplies,
      maxTurnsPerHuman,
      remainingTurnsSinceHuman: maxTurnsPerHuman > 0
        ? Math.max(0, maxTurnsPerHuman - this.turnCountSinceHuman)
        : null,
    };
  }

  setConfig(key, value) {
    const normalized = String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const resolvedKey =
      normalized === "a2a" || normalized === "allowassistanttoassistantreplies"
        ? "allowAssistantToAssistantReplies"
        : normalized === "maxturns" ||
            normalized === "maxturnsperhuman" ||
            normalized === "turnlimit" ||
            normalized === "turns"
          ? "maxTurnsPerHuman"
        : null;
    if (!resolvedKey) {
      return false;
    }
    if (resolvedKey === "maxTurnsPerHuman") {
      const parsed = parseNonNegativeInt(value);
      if (parsed === null) {
        return false;
      }
      const previous = this.config.maxTurnsPerHuman;
      this.config.maxTurnsPerHuman = parsed;
      void this.emitEvent({
        type: "room.config_updated",
        eventId: randomUUID(),
        room: this.config.roomName,
        key: resolvedKey,
        previous,
        value: parsed,
        at: nowIso(),
      });
      this.participants.forEach((participant) => this.schedule(participant));
      return true;
    }
    const parsed = parseBooleanLike(value);
    if (parsed === null) {
      return false;
    }
    const previous = this.config.allowAssistantToAssistantReplies;
    this.config.allowAssistantToAssistantReplies = parsed;
    if (!parsed) {
      this.participants.forEach((participant) => {
        participant.queue = [];
      });
    }
    void this.emitEvent({
      type: "room.config_updated",
      eventId: randomUUID(),
      room: this.config.roomName,
      key: resolvedKey,
      previous,
      value: parsed,
      at: nowIso(),
    });
    return true;
  }
}
