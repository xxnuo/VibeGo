import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBlockTermInput,
  cutBlockTermInputLineLeft,
  cutBlockTermInputWordLeft,
  getBlockTermInputRows,
  insertBlockTermInputText,
  resolveBlockTermInputShortcut,
} from "../src/components/terminal/blockterm-input-keybindings.ts";

const keyEvent = (key, patch = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

test("maps WaveTerm command input editing shortcuts without stealing modified variants", () => {
  assert.equal(resolveBlockTermInputShortcut(keyEvent("c", { ctrlKey: true })), "clear");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("u", { ctrlKey: true })), "cut-line-left");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("w", { ctrlKey: true })), "cut-word-left");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("y", { ctrlKey: true })), "paste");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("p", { ctrlKey: true })), "history-previous");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("n", { ctrlKey: true })), "history-next");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("w", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(resolveBlockTermInputShortcut(keyEvent("c", { metaKey: true })), null);
});

test("maps explicit newline and portable command-expand shortcuts", () => {
  assert.equal(resolveBlockTermInputShortcut(keyEvent("Enter", { shiftKey: true })), "insert-newline");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("Enter", { ctrlKey: true })), "insert-newline");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("Enter", { metaKey: true })), null);
  assert.equal(resolveBlockTermInputShortcut(keyEvent("e", { metaKey: true })), "toggle-expanded");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("e", { altKey: true })), "toggle-expanded");
  assert.equal(resolveBlockTermInputShortcut(keyEvent("e", { metaKey: true, altKey: true })), null);
});

test("clears and cuts the input using textarea cursor offsets", () => {
  assert.deepEqual(clearBlockTermInput(), { draft: "", cursor: 0 });
  assert.deepEqual(cutBlockTermInputLineLeft("printf hello", 7), {
    draft: "hello",
    cursor: 0,
    clipboardText: "printf ",
  });
  assert.deepEqual(cutBlockTermInputWordLeft("git commit   --amend", 13), {
    draft: "git --amend",
    cursor: 4,
    clipboardText: "commit   ",
  });
  assert.deepEqual(cutBlockTermInputWordLeft("single", 6), {
    draft: "",
    cursor: 0,
    clipboardText: "single",
  });
});

test("inserts clipboard text or a newline over the current selection", () => {
  assert.deepEqual(insertBlockTermInputText("echo old tail", 5, 8, "new"), {
    draft: "echo new tail",
    cursor: 8,
  });
  assert.deepEqual(insertBlockTermInputText("echo tail", 5, 5, "\n"), {
    draft: "echo \ntail",
    cursor: 6,
  });
  assert.deepEqual(insertBlockTermInputText("abc", 99, -5, "x"), {
    draft: "x",
    cursor: 1,
  });
});

test("keeps automatic rows bounded and offers an explicit expanded height", () => {
  assert.equal(getBlockTermInputRows("", false), 2);
  assert.equal(getBlockTermInputRows("a\nb\nc", false), 3);
  assert.equal(getBlockTermInputRows(Array.from({ length: 12 }, () => "x").join("\n"), false), 8);
  assert.equal(getBlockTermInputRows("one line", true), 8);
});
