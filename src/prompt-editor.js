import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useStdin } from "ink";

const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const splitGraphemes = (value) => {
  const text = String(value ?? "");
  if (!segmenter) return Array.from(text);
  return [...segmenter.segment(text)].map((item) => item.segment);
};

const fromGraphemes = (items) => items.join("");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const updateAtCursor = (value, cursor, updater) => {
  const parts = splitGraphemes(value);
  const next = updater(parts, clamp(cursor, 0, parts.length));
  return {
    value: fromGraphemes(next.parts),
    cursor: clamp(next.cursor, 0, next.parts.length),
  };
};

const deletePreviousWord = (value, cursor) =>
  updateAtCursor(value, cursor, (parts, index) => {
    let start = index;
    while (start > 0 && /\s/.test(parts[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(parts[start - 1])) start -= 1;
    return {
      parts: [...parts.slice(0, start), ...parts.slice(index)],
      cursor: start,
    };
  });

const insertText = (value, cursor, text) =>
  updateAtCursor(value, cursor, (parts, index) => {
    const inserted = splitGraphemes(text);
    return {
      parts: [...parts.slice(0, index), ...inserted, ...parts.slice(index)],
      cursor: index + inserted.length,
    };
  });

const removeBeforeCursor = (value, cursor) =>
  updateAtCursor(value, cursor, (parts, index) => ({
    parts: index <= 0 ? parts : [...parts.slice(0, index - 1), ...parts.slice(index)],
    cursor: Math.max(0, index - 1),
  }));

const removeAtCursor = (value, cursor) =>
  updateAtCursor(value, cursor, (parts, index) => ({
    parts: index >= parts.length ? parts : [...parts.slice(0, index), ...parts.slice(index + 1)],
    cursor: index,
  }));

const valueWithCursor = (value, cursor) => {
  const parts = splitGraphemes(value);
  const safeCursor = clamp(cursor, 0, parts.length);
  return {
    value: fromGraphemes([...parts.slice(0, safeCursor), "▌", ...parts.slice(safeCursor)]),
    length: parts.length,
  };
};

const lineCount = (value) => Math.max(1, String(value || "").split("\n").length);

const keys = {
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlK: "\x0b",
  ctrlO: "\x0f",
  ctrlU: "\x15",
  ctrlW: "\x17",
  escape: "\x1b",
  enter: "\r",
  backspace: "\x7f",
  ctrlH: "\b",
  deleteForward: "\x1b[3~",
  left: "\x1b[D",
  leftAlt: "\x1bOD",
  right: "\x1b[C",
  rightAlt: "\x1bOC",
  up: "\x1b[A",
  upAlt: "\x1bOA",
  down: "\x1b[B",
  downAlt: "\x1bOB",
};

export const PromptEditor = ({
  value,
  onChange,
  onSubmit,
  onExit,
  history = [],
  disabled = false,
  readonly = false,
  busy = false,
}) => {
  const { setRawMode, internal_eventEmitter: inputEvents } = useStdin();
  const valueRef = useRef(String(value ?? ""));
  const cursorRef = useRef(splitGraphemes(valueRef.current).length);
  const [cursor, setCursor] = useState(cursorRef.current);
  const [historyIndex, setHistoryIndex] = useState(null);

  const setDraft = useCallback(
    (nextValue, nextCursor = splitGraphemes(nextValue).length) => {
      const normalizedValue = String(nextValue ?? "");
      const nextLength = splitGraphemes(normalizedValue).length;
      const normalizedCursor = clamp(nextCursor, 0, nextLength);
      valueRef.current = normalizedValue;
      cursorRef.current = normalizedCursor;
      onChange(normalizedValue);
      setCursor(normalizedCursor);
    },
    [onChange]
  );

  useEffect(() => {
    const normalizedValue = String(value ?? "");
    const nextLength = splitGraphemes(normalizedValue).length;
    valueRef.current = normalizedValue;
    cursorRef.current = clamp(cursorRef.current, 0, nextLength);
    setCursor(cursorRef.current);
  }, [value]);

  const setCursorPosition = useCallback((updater) => {
    const length = splitGraphemes(valueRef.current).length;
    const nextCursor =
      typeof updater === "function" ? updater(cursorRef.current, length) : updater;
    cursorRef.current = clamp(nextCursor, 0, length);
    setCursor(cursorRef.current);
  }, []);

  const recallHistory = useCallback(
    (direction) => {
      if (history.length === 0) return;
      const lastIndex = history.length - 1;
      const nextIndex =
        historyIndex === null
          ? direction < 0
            ? lastIndex
            : null
          : clamp(historyIndex + direction, 0, lastIndex);
      if (nextIndex === null) return;
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex]);
    },
    [history, historyIndex, setDraft]
  );

  const applyEdit = useCallback(
    (edit) => {
      setHistoryIndex(null);
      const next = edit(valueRef.current, cursorRef.current);
      setDraft(next.value, next.cursor);
    },
    [setDraft]
  );

  const handleInput = useCallback(
    (data) => {
      if (readonly || disabled) return;
      const raw = String(data ?? "");
      if (!raw) return;

      if (raw === keys.ctrlC) {
        onExit?.();
        return;
      }

      const submitIndex = raw.search(/[\r\n]/);
      if (submitIndex >= 0) {
        const beforeSubmit = raw.slice(0, submitIndex);
        if (beforeSubmit) {
          const next = insertText(valueRef.current, cursorRef.current, beforeSubmit);
          setDraft(next.value, next.cursor);
        }
        setHistoryIndex(null);
        void onSubmit(valueRef.current);
        return;
      }

      if (raw === keys.ctrlO) {
        applyEdit((current, index) => insertText(current, index, "\n"));
        return;
      }

      if (raw === keys.left || raw === keys.leftAlt) {
        setCursorPosition((current) => current - 1);
        return;
      }
      if (raw === keys.right || raw === keys.rightAlt) {
        setCursorPosition((current) => current + 1);
        return;
      }
      if (raw === keys.up || raw === keys.upAlt) {
        recallHistory(-1);
        return;
      }
      if (raw === keys.down || raw === keys.downAlt) {
        recallHistory(1);
        return;
      }
      if (raw === keys.backspace || raw === keys.ctrlH) {
        applyEdit(removeBeforeCursor);
        return;
      }
      if (raw === keys.deleteForward || raw === keys.ctrlD) {
        applyEdit(removeAtCursor);
        return;
      }
      if (raw === keys.escape) {
        setHistoryIndex(null);
        setDraft("");
        return;
      }

      if (raw === keys.ctrlA) {
        setCursorPosition(0);
        return;
      }
      if (raw === keys.ctrlE) {
        setCursorPosition((_, length) => length);
        return;
      }
      if (raw === keys.ctrlU) {
        applyEdit((current, index) =>
          updateAtCursor(current, index, (parts, safeIndex) => ({
            parts: parts.slice(safeIndex),
            cursor: 0,
          }))
        );
        return;
      }
      if (raw === keys.ctrlK) {
        applyEdit((current, index) =>
          updateAtCursor(current, index, (parts, safeIndex) => ({
            parts: parts.slice(0, safeIndex),
            cursor: safeIndex,
          }))
        );
        return;
      }
      if (raw === keys.ctrlW) {
        applyEdit(deletePreviousWord);
        return;
      }

      if (raw.startsWith(keys.escape)) {
        return;
      }

      applyEdit((current, index) => insertText(current, index, raw));
    },
    [
      applyEdit,
      disabled,
      onExit,
      onSubmit,
      readonly,
      recallHistory,
      setCursorPosition,
      setDraft,
    ]
  );

  useEffect(() => {
    if (readonly || disabled) return;

    setRawMode(true);
    inputEvents?.on("input", handleInput);

    return () => {
      inputEvents?.removeListener("input", handleInput);
      setRawMode(false);
    };
  }, [disabled, handleInput, inputEvents, readonly, setRawMode]);

  const display = useMemo(() => valueWithCursor(value, cursor), [cursor, value]);
  const promptColor = value.trim().startsWith("/") ? "cyan" : "blue";
  const helper =
    "Enter send | Ctrl+O newline | ↑/↓ history | ←/→ move | Ctrl+A/E/U/K/W edit | Esc clear";
  const displayValue = `${value.length === 0 ? "▌ Type a message or /help" : display.value}${
    busy ? " (sending...)" : ""
  }`;

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { color: value.length === 0 ? "gray" : promptColor, bold: value.length > 0 },
      `you> ${displayValue}`
    ),
    React.createElement(
      Text,
      { dimColor: true },
      `${helper} | chars=${display.length} lines=${lineCount(value)}`
    )
  );
};
