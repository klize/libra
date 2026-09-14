import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JsonlStore } from "./store.js";
import { Room } from "./room.js";

const clonePlain = (value) => JSON.parse(JSON.stringify(value ?? null));

const buildSnapshotFromEvents = (config = {}, events = []) => {
  const participants = clonePlain(config.participants || []);
  const byId = new Map(participants.map((participant) => [participant.id, participant]));
  const roomConfig = {
    roomName: config.roomName || "libra",
    wakeAfterMs: config.wakeAfterMs,
    replyContextSize: config.replyContextSize,
    maxTurnsPerHuman: config.maxTurnsPerHuman || 0,
    allowAssistantToAssistantReplies: config.allowAssistantToAssistantReplies === true,
    idleTurnThreshold: config.idleTurnThreshold || 0,
  };
  const messages = [];

  for (const event of events) {
    if (event?.type === "message.posted" && event.message) {
      messages.push(event.message);
    } else if (event?.type === "room.config_updated") {
      if (event.key === "allowAssistantToAssistantReplies") {
        roomConfig.allowAssistantToAssistantReplies = event.value === true;
      }
      if (event.key === "maxTurnsPerHuman") {
        roomConfig.maxTurnsPerHuman = Number(event.value) || 0;
      }
    } else if (event?.type === "participant.limited") {
      const participant = byId.get(event.participantId);
      if (participant) {
        participant.state = "limited";
        participant.limits = {
          ...(participant.limits || {}),
          enabled: true,
          remaining: 0,
          unknown: false,
          resetAt: event.resetAt || null,
        };
      }
    } else if (event?.type === "participant.limit") {
      const participant = byId.get(event.participantId);
      if (participant) {
        const remaining = Number(event.remaining);
        participant.state = Number.isFinite(remaining) && remaining <= 0 ? "limited" : participant.state;
        participant.limits = {
          ...(participant.limits || {}),
          enabled: true,
          remaining: Number.isFinite(remaining) ? remaining : 0,
          unknown: false,
        };
      }
    }
  }

  const lastHumanIndex = messages.map((message) => message.senderId).lastIndexOf("human");
  const currentHumanTurnMessageId =
    lastHumanIndex >= 0 ? messages[lastHumanIndex]?.id || null : null;
  const turnCountSinceHuman =
    lastHumanIndex >= 0
      ? messages.slice(lastHumanIndex + 1).filter((message) => message.senderId !== "human").length
      : 0;

  return {
    version: 1,
    roomName: roomConfig.roomName,
    roomConfig,
    turnState: {
      runningTurn: messages.length,
      turnCountSinceHuman,
      currentHumanTurnMessageId,
      nextSpeakerCursor: 0,
    },
    participants,
    messages,
  };
};

export class LocalRoomClient extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config || {};
    this.options = {
      logPath: options.logPath || null,
      legacyLogPath: options.legacyLogPath || null,
      sessionId: options.sessionId || config?.roomName || "libra",
      sessionDir: options.sessionDir || null,
      sessionPath: options.sessionPath || null,
      snapshotPath: options.snapshotPath || null,
      maxHistoryLines: Number.isFinite(options.maxHistoryLines)
        ? options.maxHistoryLines
        : 200,
      ...options,
    };
    this.store = null;
    this.room = null;
    this.session = null;
    this.saveQueue = Promise.resolve(false);
    this.connected = false;
    this._onRoomEvent = this._onRoomEvent.bind(this);
    this._onRoomState = this._onRoomState.bind(this);
  }

  async connect() {
    if (this.connected) return this;
    const now = new Date().toISOString();
    this.session = {
      sessionId: this.options.sessionId,
      roomName: this.config.roomName || "libra",
      sessionDir: this.options.sessionDir,
      eventLogPath: this.options.logPath,
      snapshotPath: this.options.snapshotPath,
      configPath: this.config.path || null,
      createdAt: now,
    };
    this.store = this.options.logPath
      ? new JsonlStore(this.options.logPath, {
          snapshotPath: this.options.snapshotPath,
          sessionPath: this.options.sessionPath,
          session: this.session,
        })
      : null;
    const existingSession = await this.store?.loadSession();
    if (existingSession?.createdAt) {
      this.session.createdAt = existingSession.createdAt;
    }
    await this.store?.saveSession(this.session);
    this.room = new Room(this.config, this.store);
    const snapshot = await this.loadInitialSnapshot();
    if (snapshot) {
      this.room.restoreSnapshot(snapshot);
    }
    this.room.on("event", this._onRoomEvent);
    this.room.on("state", this._onRoomState);
    this.connected = true;
    await this.saveSession();
    setTimeout(() => this.emit("connected", this.getStatus()), 0);
    return this;
  }

  async loadInitialSnapshot() {
    const snapshot = await this.store?.loadSnapshot();
    if (snapshot) {
      return snapshot;
    }
    if (!this.options.legacyLogPath) {
      return null;
    }
    const legacyStore = new JsonlStore(this.options.legacyLogPath);
    const events = await legacyStore.loadAll();
    if (events.length === 0) {
      return null;
    }
    return buildSnapshotFromEvents(this.config, events);
  }

  async saveSession() {
    if (!this.store || !this.room) {
      return false;
    }
    const save = async () => {
      await this.store.saveSession(this.session);
      return this.store.saveSnapshot(this.room.createSnapshot());
    };
    this.saveQueue = this.saveQueue.then(save, save);
    return this.saveQueue;
  }

  async disconnect() {
    if (!this.connected) return;
    await this.saveSession();
    if (this.room) {
      this.room.off("event", this._onRoomEvent);
      this.room.off("state", this._onRoomState);
    }
    this.connected = false;
    this.room = null;
    this.store = null;
    this.emit("disconnected");
  }

  async loadHistory(maxLines = this.options.maxHistoryLines) {
    if (this.room) {
      return this.room.getHistoryRows(maxLines);
    }
    if (!this.store) return [];
    const events = await this.store.loadTail(maxLines);
    const seen = new Set();
    return events
      .filter((entry) => entry?.type === "message.posted" && entry?.message)
      .map((entry) => ({
        kind: "message",
        source: entry.message.senderId,
        id: entry.message.id || randomUUID(),
        at: entry.message.createdAt || new Date().toISOString(),
        text: entry.message.content || "",
      }))
      .filter((item) => {
        if (seen.has(item.id)) {
          return false;
        }
        seen.add(item.id);
        return true;
      });
  }

  async sendMessage(author, content) {
    if (!this.room) {
      throw new Error("Room is not connected");
    }
    return this.room.postMessage(author, content);
  }

  setParticipantState(participantId, nextState, note = "manual") {
    if (!this.room) {
      return false;
    }
    return this.room.setParticipantState(participantId, nextState, note);
  }

  setLimit(participantId, remaining, reason = "owner-set") {
    if (!this.room) {
      return false;
    }
    return this.room.setLimit(participantId, remaining, reason);
  }

  resetLimit(participantId) {
    if (!this.room) {
      return false;
    }
    const participant = this.room.participants.get(participantId);
    if (!participant) {
      return false;
    }
    participant.limits.enabled = false;
    participant.limits.unknown = true;
    participant.limits.remaining = null;
    participant.limits.resetAt = null;
    participant.limits.lastSet = null;
    participant.state = "active";
    participant.active = true;
    participant.status = "ready";
    this.room.emit("state", {
      type: "participant.state",
      eventId: randomUUID(),
      room: this.config.roomName || "libra",
      participantId,
      state: "active",
      note: "reset-limits",
      at: new Date().toISOString(),
    });
    return true;
  }

  setRoomConfig(key, value) {
    if (!this.room) {
      return false;
    }
    return this.room.setConfig(key, value);
  }

  setParticipantModel(participantId, model) {
    if (!this.room) {
      return null;
    }
    return this.room.setParticipantModel(participantId, model);
  }

  setParticipantEffort(participantId, effort) {
    if (!this.room) {
      return null;
    }
    return this.room.setParticipantEffort(participantId, effort);
  }

  cloneParticipant(sourceId, newId) {
    if (!this.room) {
      return null;
    }
    return this.room.cloneParticipant(sourceId, newId);
  }

  getSessionStatus() {
    return {
      sessionId: this.options.sessionId,
      sessionDir: this.options.sessionDir,
      eventLogPath: this.options.logPath,
      snapshotPath: this.options.snapshotPath,
      connected: this.connected,
      messages: this.room?.messages?.length || 0,
    };
  }

  getStatus() {
    if (!this.room) {
      return {
        roomName: this.config.roomName || "libra",
        allowAssistantToAssistantReplies:
          this.config.allowAssistantToAssistantReplies === true,
        participants: Array.isArray(this.config.participants)
          ? this.config.participants.map((item) => ({
              id: item.id || "unknown",
              name: item.name || item.id || "unknown",
              type: item.type || "assistant",
              state: item.state || "active",
              active: item.state ? item.state === "active" : true,
              queue: 0,
              busy: false,
              status: "ready",
              limits: item.limits || { enabled: false, remaining: null, unknown: true },
              usage: item.usage || { known: false, remaining: null, lastChecked: null },
              adapter: null,
            }))
          : [],
        totalMessages: 0,
        runningTurn: 0,
        turnCountSinceHuman: 0,
        maxTurnsPerHuman: this.config.maxTurnsPerHuman || 0,
        remainingTurnsSinceHuman: this.config.maxTurnsPerHuman
          ? Math.max(0, Number(this.config.maxTurnsPerHuman) - 0)
          : null,
      };
    }
    return this.room.getStatus();
  }

  _onRoomEvent(event) {
    this.emit("event", event);
    void this.saveSession();
  }

  _onRoomState(state) {
    this.emit("state", state);
    void this.saveSession();
  }
}
