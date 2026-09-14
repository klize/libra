import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

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

const valueWithCursorParts = (value, cursor) => {
  const parts = splitGraphemes(value);
  const safeCursor = clamp(cursor, 0, parts.length);
  const before = fromGraphemes(parts.slice(0, safeCursor));
  const selected = parts[safeCursor] || " ";
  const after = fromGraphemes(parts.slice(safeCursor + (parts[safeCursor] ? 1 : 0)));
  return { before, selected, after, length: parts.length };
};

const lineCount = (value) => Math.max(1, String(value || "").split("\n").length);

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
  const [cursor, setCursor] = useState(() => splitGraphemes(value).length);
  const [historyIndex, setHistoryIndex] = useState(null);

  const setDraft = useCallback(
    (nextValue, nextCursor = splitGraphemes(nextValue).length) => {
      onChange(nextValue);
      setCursor(clamp(nextCursor, 0, splitGraphemes(nextValue).length));
    },
    [onChange]
  );

  useEffect(() => {
    setCursor((current) => clamp(current, 0, splitGraphemes(value).length));
  }, [value]);

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
      const next = edit(value, cursor);
      setDraft(next.value, next.cursor);
    },
    [cursor, setDraft, value]
  );

  useInput(
    (character, key) => {
      if (readonly || disabled) return;

      if (key?.ctrl && character?.toLowerCase() === "c") {
        onExit?.();
        return;
      }

      if (key?.return) {
        setHistoryIndex(null);
        void onSubmit(value);
        return;
      }

      if (key?.ctrl && character?.toLowerCase() === "j") {
        applyEdit((current, index) => insertText(current, index, "\n"));
        return;
      }

      if (key?.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key?.rightArrow) {
        setCursor((current) => Math.min(splitGraphemes(value).length, current + 1));
        return;
      }
      if (key?.upArrow) {
        recallHistory(-1);
        return;
      }
      if (key?.downArrow) {
        recallHistory(1);
        return;
      }
      if (key?.backspace) {
        applyEdit(removeBeforeCursor);
        return;
      }
      if (key?.delete) {
        applyEdit(removeAtCursor);
        return;
      }
      if (key?.escape) {
        setHistoryIndex(null);
        setDraft("");
        return;
      }

      if (key?.ctrl) {
        const keyName = character?.toLowerCase();
        if (keyName === "a") {
          setCursor(0);
          return;
        }
        if (keyName === "e") {
          setCursor(splitGraphemes(value).length);
          return;
        }
        if (keyName === "u") {
          applyEdit((current, index) =>
            updateAtCursor(current, index, (parts, safeIndex) => ({
              parts: parts.slice(safeIndex),
              cursor: 0,
            }))
          );
          return;
        }
        if (keyName === "k") {
          applyEdit((current, index) =>
            updateAtCursor(current, index, (parts, safeIndex) => ({
              parts: parts.slice(0, safeIndex),
              cursor: safeIndex,
            }))
          );
          return;
        }
        if (keyName === "w") {
          applyEdit(deletePreviousWord);
          return;
        }
        return;
      }

      if (character && !key?.meta) {
        applyEdit((current, index) => insertText(current, index, character));
      }
    },
    { isActive: !readonly && !disabled }
  );

  const cursorParts = useMemo(() => valueWithCursorParts(value, cursor), [cursor, value]);
  const promptColor = value.trim().startsWith("/") ? "cyan" : "blue";
  const helper =
    "Enter send | Ctrl+J newline | ↑/↓ history | ←/→ move | Ctrl+A/E/U/K/W edit | Esc clear";

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Box,
      { flexDirection: "row" },
      React.createElement(Text, { color: promptColor, bold: true }, "you> "),
      value.length === 0
        ? React.createElement(Text, { dimColor: true }, "Type a message or /help")
        : React.createElement(
            Text,
            null,
            cursorParts.before,
            React.createElement(Text, { inverse: true }, cursorParts.selected),
            cursorParts.after
          ),
      busy ? React.createElement(Text, { color: "gray" }, " (sending...)") : null
    ),
    React.createElement(
      Text,
      { dimColor: true },
      `${helper} | chars=${cursorParts.length} lines=${lineCount(value)}`
    )
  );
};
