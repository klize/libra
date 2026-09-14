import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JsonlStore } from "./store.js";
import { Room } from "./room.js";

export class LocalRoomClient extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config || {};
    this.options = {
      logPath: options.logPath || null,
      maxHistoryLines: Number.isFinite(options.maxHistoryLines)
        ? options.maxHistoryLines
        : 200,
      ...options,
    };
    this.store = null;
    this.room = null;
    this.connected = false;
    this._onRoomEvent = this._onRoomEvent.bind(this);
    this._onRoomState = this._onRoomState.bind(this);
  }

  async connect() {
    if (this.connected) return this;
    this.store = this.options.logPath ? new JsonlStore(this.options.logPath) : null;
    this.room = new Room(this.config, this.store);
    this.room.on("event", this._onRoomEvent);
    this.room.on("state", this._onRoomState);
    this.connected = true;
    setTimeout(() => this.emit("connected", this.getStatus()), 0);
    return this;
  }

  disconnect() {
    if (!this.connected) return;
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
  }

  _onRoomState(state) {
    this.emit("state", state);
  }
}
