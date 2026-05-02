import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS,
  createBlockTermKeymapOverrides,
  getBlockTermKeyDescriptorFromEvent,
  getBlockTermKeymapDefaults,
  getBlockTermKeymapDisplayBindings,
  keyDescriptorMatchesEvent,
  normalizeBlockTermKeyDescriptor,
  parseBlockTermKeymapConfig,
  resolveBlockTermKeymapAction,
  serializeBlockTermKeymapBindings,
  serializeBlockTermKeymapOverrides,
} from "../src/components/terminal/blockterm-keymap.ts";
import {
  resolveBlockTermDesktopShortcut,
  resolveBlockTermDesktopShortcutForTarget,
} from "../src/components/terminal/blockterm-desktop-keybindings.ts";
import { resolveBlockTermInputShortcut } from "../src/components/terminal/blockterm-input-keybindings.ts";

const event = (key, patch = {}) => ({
  key,
  code: undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

test("normalizes WaveTerm modifiers, uppercase keys, Space, and physical code syntax", () => {
  assert.equal(normalizeBlockTermKeyDescriptor("Cmd:Option:Shift:R"), "Cmd:Option:Shift:r");
  assert.equal(normalizeBlockTermKeyDescriptor("Ctrl:Space"), "Ctrl:Space");
  assert.equal(normalizeBlockTermKeyDescriptor(" "), "Space");
  assert.equal(normalizeBlockTermKeyDescriptor("c{KeyT}:Cmd"), "Cmd:c{KeyT}");
  assert.equal(normalizeBlockTermKeyDescriptor("Alt:Meta:x"), "Alt:Meta:x");
  assert.equal(normalizeBlockTermKeyDescriptor("Esc"), "Escape");
  assert.equal(normalizeBlockTermKeyDescriptor("Cmd:"), null);
  assert.equal(normalizeBlockTermKeyDescriptor("Cmd:x:y"), null);
  assert.equal(normalizeBlockTermKeyDescriptor("c{}"), null);
});

test("matches WaveTerm portable Cmd and Option with exact remaining modifiers", () => {
  assert.equal(keyDescriptorMatchesEvent(event("t", { metaKey: true }), "Cmd:t"), true);
  assert.equal(keyDescriptorMatchesEvent(event("t", { altKey: true }), "Cmd:t"), true);
  assert.equal(keyDescriptorMatchesEvent(event("t", { metaKey: true, altKey: true }), "Cmd:t"), false);
  assert.equal(keyDescriptorMatchesEvent(event("t", { ctrlKey: true, metaKey: true }), "Cmd:t"), false);
  assert.equal(keyDescriptorMatchesEvent(event("t"), "Cmd:t"), false);
  assert.equal(keyDescriptorMatchesEvent(event("i", { metaKey: true, altKey: true }), "Cmd:Option:i"), true);
  assert.equal(keyDescriptorMatchesEvent(event("i", { metaKey: true }), "Cmd:Option:i"), false);
  assert.equal(keyDescriptorMatchesEvent(event("i", { altKey: true }), "Cmd:Option:i"), false);
  assert.equal(keyDescriptorMatchesEvent(event("i", { altKey: true }), "Option:i"), true);
  assert.equal(keyDescriptorMatchesEvent(event("i", { metaKey: true }), "Option:i"), true);
  assert.equal(keyDescriptorMatchesEvent(event("T", { ctrlKey: true, shiftKey: true }), "Ctrl:Shift:t"), true);
  assert.equal(keyDescriptorMatchesEvent(event("t", { ctrlKey: true }), "Ctrl:Shift:t"), false);
  assert.equal(keyDescriptorMatchesEvent(event(" ", { ctrlKey: true }), "Ctrl:Space"), true);
});

test("matches c{code}, altered Option characters, and only the session macOS fallback shape", () => {
  assert.equal(keyDescriptorMatchesEvent(event("z", { code: "KeyT" }), "c{KeyT}"), true);
  assert.equal(keyDescriptorMatchesEvent(event("t", { code: "KeyY" }), "c{KeyT}"), false);
  assert.equal(
    keyDescriptorMatchesEvent(event("†", { altKey: true, code: "KeyT" }), "Cmd:t", { allowCodeFallback: true }),
    true
  );
  assert.equal(
    keyDescriptorMatchesEvent(event("!", { ctrlKey: true, shiftKey: true, code: "Digit1" }), "Cmd:1", {
      allowMacSessionFallback: true,
    }),
    true
  );
  assert.equal(
    keyDescriptorMatchesEvent(event("N", { ctrlKey: true, shiftKey: true, code: "KeyN" }), "Cmd:Ctrl:n", {
      allowMacSessionFallback: true,
    }),
    false
  );
});

test("resolves macOS bracket session fallbacks through the configurable keymap", () => {
  const keymap = parseBlockTermKeymapConfig(null).keymap;
  assert.deepEqual(
    resolveBlockTermDesktopShortcut(event("{", { code: "BracketLeft", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap,
    }),
    { type: "previous-session" }
  );
  assert.deepEqual(
    resolveBlockTermDesktopShortcut(event("}", { code: "BracketRight", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap,
    }),
    { type: "next-session" }
  );
});

test("captures portable modifiers using the active platform and can capture physical codes", () => {
  assert.equal(
    getBlockTermKeyDescriptorFromEvent(event("t", { code: "KeyT", metaKey: true }), { macPlatform: true }),
    "Cmd:t"
  );
  assert.equal(
    getBlockTermKeyDescriptorFromEvent(event("†", { code: "KeyT", altKey: true }), { macPlatform: true }),
    "Option:c{KeyT}"
  );
  assert.equal(
    getBlockTermKeyDescriptorFromEvent(event("†", { code: "KeyT", metaKey: true, altKey: true }), {
      macPlatform: true,
    }),
    "Cmd:Option:c{KeyT}"
  );
  assert.equal(
    getBlockTermKeyDescriptorFromEvent(event("z", { code: "KeyY", metaKey: true }), { macPlatform: true }),
    "Cmd:z"
  );
  assert.equal(getBlockTermKeyDescriptorFromEvent(event("t", { code: "KeyT", altKey: true })), "Cmd:t");
  assert.equal(getBlockTermKeyDescriptorFromEvent(event("t", { code: "KeyT", metaKey: true })), "Option:t");
  assert.equal(
    getBlockTermKeyDescriptorFromEvent(event("t", { code: "KeyT", ctrlKey: true }), { keyType: "code" }),
    "Ctrl:c{KeyT}"
  );
  assert.equal(getBlockTermKeyDescriptorFromEvent(event("Meta", { metaKey: true }), { macPlatform: true }), null);
});

test("round-trips recorded macOS Option characters and non-US logical keys", () => {
  const events = [
    event("†", { code: "KeyT", altKey: true }),
    event("†", { code: "KeyT", metaKey: true, altKey: true }),
    event("z", { code: "KeyY", metaKey: true }),
  ];
  for (const keyboardEvent of events) {
    const descriptor = getBlockTermKeyDescriptorFromEvent(keyboardEvent, { macPlatform: true });
    assert.ok(descriptor);
    assert.equal(keyDescriptorMatchesEvent(keyboardEvent, descriptor), true, descriptor);
  }
});

test("falls back to physical codes when recorded characters use descriptor syntax", () => {
  const events = [
    event(":", { code: "Semicolon", shiftKey: true }),
    event("(", { code: "Digit9", shiftKey: true }),
    event(")", { code: "Digit0", shiftKey: true }),
  ];
  const expected = ["Shift:c{Semicolon}", "Shift:c{Digit9}", "Shift:c{Digit0}"];
  events.forEach((keyboardEvent, index) => {
    const descriptor = getBlockTermKeyDescriptorFromEvent(keyboardEvent);
    assert.equal(descriptor, expected[index]);
    assert.equal(keyDescriptorMatchesEvent(keyboardEvent, descriptor), true);
  });
});

test("merges a known alias by canonical command name", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([{ command: "blockterm:new-session", keys: ["Cmd:n"] }])
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.keymap.byCommand.get("app:newTab")?.keys, ["Cmd:n"]);
  assert.equal(resolveBlockTermDesktopShortcut(event("n", { metaKey: true }), { keymap: result.keymap })?.type, "new-session");
  assert.equal(resolveBlockTermDesktopShortcut(event("t", { metaKey: true }), { keymap: result.keymap }), null);
});

test("falls back the entire keymap when JSON, shape, entries, or any key are invalid", () => {
  const invalidConfigs = [
    "{",
    JSON.stringify({ command: "app:newTab", keys: ["Cmd:n"] }),
    JSON.stringify([{ command: "app:newTab", keys: "Cmd:n" }]),
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "app:closeCurrentTab", keys: ["not valid:descriptor"] },
    ]),
    JSON.stringify([
      { command: "blockterm:new-session", keys: ["Cmd:n"] },
      { command: "app:newTab", keys: ["Cmd:m"] },
    ]),
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "not-a-command", keys: ["Cmd:x"] },
    ]),
  ];
  for (const config of invalidConfigs) {
    const result = parseBlockTermKeymapConfig(config);
    assert.equal(result.valid, false);
    assert.deepEqual(result.keymap.byCommand.get("app:newTab")?.keys, ["Cmd:t"]);
    assert.deepEqual(result.keymap.byCommand.get("app:closeCurrentTab")?.keys, ["Cmd:w"]);
    assert.equal(result.keymap.bindings.length, BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS.length);
  }
});

test("enforces the 64 KiB configuration limit at the byte boundary", () => {
  const base = JSON.stringify([{ command: "app:newTab", keys: ["Cmd:n"], info: "" }]);
  const exact = JSON.stringify([
    { command: "app:newTab", keys: ["Cmd:n"], info: "x".repeat(64 * 1024 - base.length) },
  ]);
  assert.equal(new TextEncoder().encode(exact).byteLength, 64 * 1024);
  assert.equal(parseBlockTermKeymapConfig(exact).valid, true);
  const oversized = `${exact.slice(0, -3)}x${exact.slice(-3)}`;
  assert.equal(new TextEncoder().encode(oversized).byteLength, 64 * 1024 + 1);
  const result = parseBlockTermKeymapConfig(oversized);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.kind === "invalid-config" && /too large/u.test(item.message)));
});

test("enforces the 64-entry configuration boundary before command validation", () => {
  const entries = Array.from({ length: 64 }, (_, index) => ({ command: `unknown:${index}`, keys: [] }));
  const atLimit = parseBlockTermKeymapConfig(JSON.stringify(entries));
  assert.equal(atLimit.diagnostics.some((item) => /more than 64 entries/u.test(item.message)), false);
  const overLimit = parseBlockTermKeymapConfig(
    JSON.stringify([...entries, { command: "unknown:overflow", keys: [] }])
  );
  assert.ok(overLimit.diagnostics.some((item) => /more than 64 entries/u.test(item.message)));
});

test("accepts 16 keys per command and rejects 17 with a full default fallback", () => {
  const keys = [...Array.from({ length: 10 }, (_, index) => `Ctrl:${index}`), ..."abcdef".split("").map((key) => `Ctrl:${key}`)];
  assert.equal(keys.length, 16);
  const atLimit = parseBlockTermKeymapConfig(JSON.stringify([{ command: "app:newTab", keys }]));
  assert.equal(atLimit.valid, true);
  assert.deepEqual(atLimit.keymap.byCommand.get("app:newTab")?.keys, keys);
  const overLimit = parseBlockTermKeymapConfig(
    JSON.stringify([{ command: "app:newTab", keys: [...keys, "Ctrl:g"] }])
  );
  assert.equal(overLimit.valid, false);
  assert.deepEqual(overLimit.keymap.byCommand.get("app:newTab")?.keys, ["Cmd:t"]);
});

test("allows empty keys to disable commands without falling through to legacy defaults", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "cmdinput:clearInput", keys: [] },
      { command: "app:newTab", keys: [] },
    ])
  );
  assert.equal(result.valid, true);
  assert.equal(resolveBlockTermInputShortcut(event("c", { ctrlKey: true }), result.keymap), null);
  assert.equal(resolveBlockTermDesktopShortcut(event("t", { metaKey: true }), { keymap: result.keymap }), null);
  assert.equal(resolveBlockTermInputShortcut(event("c", { ctrlKey: true })), "clear");
});

test("reports effective conflicts and resolves them in fixed definition order", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:closeCurrentTab", keys: ["Alt:x"] },
      { command: "app:newTab", keys: ["Cmd:x"] },
    ])
  );
  assert.equal(result.valid, true);
  const conflict = result.diagnostics.find((item) => item.kind === "conflict");
  assert.equal(conflict?.command, "app:closeCurrentTab");
  assert.equal(conflict?.conflictsWith, "app:newTab");
  assert.equal(conflict?.key, "Alt:x");
  assert.deepEqual(
    resolveBlockTermKeymapAction(event("x", { altKey: true }), result.keymap, { scope: "desktop" }),
    { scope: "desktop", action: { type: "close-session" } }
  );
});

test("reports configurable macOS session fallback conflicts in fixed definition order", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "app:closeCurrentTab", keys: ["Ctrl:Shift:n"] },
    ])
  );
  const conflict = result.diagnostics.find((item) => item.kind === "conflict");
  assert.equal(conflict?.command, "app:closeCurrentTab");
  assert.equal(conflict?.conflictsWith, "app:newTab");
  assert.deepEqual(
    resolveBlockTermDesktopShortcut(event("N", { code: "KeyN", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap: result.keymap,
    }),
    { type: "close-session" }
  );
  const physicalConflict = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "app:closeCurrentTab", keys: ["Ctrl:Shift:c{KeyN}"] },
    ])
  ).diagnostics.find((item) => item.kind === "conflict");
  assert.equal(physicalConflict?.command, "app:closeCurrentTab");
  assert.equal(physicalConflict?.conflictsWith, "app:newTab");
});

test("moves the macOS session fallback with the current configurable binding", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "app:closeCurrentTab", keys: [] },
    ])
  );
  assert.deepEqual(
    resolveBlockTermDesktopShortcut(event("N", { code: "KeyN", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap: result.keymap,
    }),
    { type: "new-session" }
  );
  assert.equal(
    resolveBlockTermDesktopShortcut(event("T", { code: "KeyT", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap: result.keymap,
    }),
    null
  );
});

test("does not add macOS session fallback behavior to other desktop commands", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: [] },
      { command: "app:focusCmdInput", keys: ["Cmd:n"] },
    ])
  );
  assert.equal(
    resolveBlockTermDesktopShortcut(event("N", { code: "KeyN", ctrlKey: true, shiftKey: true }), {
      allowMacSessionFallback: true,
      keymap: result.keymap,
    }),
    null
  );
});

test("does not report a macOS fallback conflict for an unmapped character", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:é"] },
      { command: "app:focusCmdInput", keys: ["Ctrl:Shift:é"] },
    ])
  );
  assert.equal(result.diagnostics.some((item) => item.kind === "conflict"), false);
});

test("keeps cross-scope matches separate so input can resolve before document capture", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Ctrl:x"] },
      { command: "cmdinput:clearInput", keys: ["Ctrl:x"] },
    ])
  );
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.some((item) => item.kind === "conflict"), false);
  assert.equal(resolveBlockTermInputShortcut(event("x", { ctrlKey: true }), result.keymap), "clear");
  assert.deepEqual(
    resolveBlockTermKeymapAction(event("x", { ctrlKey: true }), result.keymap, { scope: "desktop" }),
    { scope: "desktop", action: { type: "new-session" } }
  );
  const commandInput = { tagName: "TEXTAREA", closest: () => null };
  assert.equal(
    resolveBlockTermDesktopShortcutForTarget(event("x", { ctrlKey: true }), commandInput, {
      commandInput: true,
      keymap: result.keymap,
    }),
    null
  );
  assert.deepEqual(resolveBlockTermDesktopShortcutForTarget(event("x", { ctrlKey: true }), null, {
    keymap: result.keymap,
  }), { type: "new-session" });
});

test("resolves desktop and input actions from the effective keymap", () => {
  const result = parseBlockTermKeymapConfig(
    JSON.stringify([
      { command: "app:newTab", keys: ["Cmd:n"] },
      { command: "cmdinput:clearInput", keys: ["Ctrl:x"] },
      { command: "generic:confirm", keys: ["Ctrl:Enter"] },
    ])
  );
  assert.deepEqual(resolveBlockTermKeymapAction(event("n", { metaKey: true }), result.keymap, { scope: "desktop" }), {
    scope: "desktop",
    action: { type: "new-session" },
  });
  assert.equal(resolveBlockTermInputShortcut(event("x", { ctrlKey: true }), result.keymap), "clear");
  assert.equal(resolveBlockTermInputShortcut(event("Enter", { ctrlKey: true }), result.keymap), "submit");
});

test("serializes only effective overrides and preserves disabled commands", () => {
  const defaults = getBlockTermKeymapDefaults();
  assert.deepEqual(createBlockTermKeymapOverrides(defaults), []);
  assert.equal(serializeBlockTermKeymapOverrides(defaults), "[]");
  const edited = defaults.map((binding) => ({ ...binding, keys: [...binding.keys] }));
  edited.find((binding) => binding.command === "app:newTab").keys = ["Cmd:n"];
  edited.find((binding) => binding.command === "app:closeCurrentTab").keys = [];
  edited.find((binding) => binding.command === "app:selectLineAbove").keys.reverse();
  const serialized = serializeBlockTermKeymapOverrides(edited);
  assert.deepEqual(JSON.parse(serialized), [
    { command: "app:newTab", keys: ["Cmd:n"] },
    { command: "app:closeCurrentTab", keys: [] },
  ]);
  const roundTrip = parseBlockTermKeymapConfig(serialized);
  assert.deepEqual(roundTrip.keymap.byCommand.get("app:newTab")?.keys, ["Cmd:n"]);
  assert.deepEqual(roundTrip.keymap.byCommand.get("app:closeCurrentTab")?.keys, []);
});

test("serializes editable rows and returns detached scoped display bindings", () => {
  const serialized = serializeBlockTermKeymapBindings([{ command: "blockterm:new-session", keys: ["Cmd:N"] }]);
  assert.deepEqual(JSON.parse(serialized), [{ command: "blockterm:new-session", keys: ["Cmd:Shift:n"] }]);
  const keymap = parseBlockTermKeymapConfig(serialized).keymap;
  const desktop = getBlockTermKeymapDisplayBindings(keymap, "desktop");
  const input = getBlockTermKeymapDisplayBindings(keymap, "input");
  assert.ok(desktop.length > 1);
  assert.ok(input.length > 1);
  desktop[0].keys.length = 0;
  assert.ok(keymap.bindings[0].keys.length > 0);
});
