import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR,
  hasOpenBlockTermDesktopShortcutModal,
  isBlockTermDesktopShortcutEditingTarget,
  isBlockTermDesktopShortcutRepeatable,
  isBlockTermMacPlatform,
  resolveBlockTermSessionAfterClose,
  resolveBlockTermDesktopShortcut,
  resolveBlockTermDesktopShortcutForTarget,
  resolveBlockTermSessionFocusTarget,
  shouldConfirmBlockTermSessionClose,
  shouldIgnoreBlockTermDesktopShortcutTarget,
} from "../src/components/terminal/blockterm-desktop-keybindings.ts";

const keyEvent = (key, patch = {}) => ({
  key,
  code: undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

const portableCommandEvents = (key, patch = {}) => [
  keyEvent(key, { metaKey: true, ...patch }),
  keyEvent(key, { altKey: true, ...patch }),
];

const shortcutTarget = ({ tagName = "DIV", isContentEditable = false, ancestorClass = null } = {}) => ({
  tagName,
  isContentEditable,
  closest(selector) {
    return ancestorClass && selector.includes(ancestorClass) ? this : null;
  },
});

test("maps WaveTerm desktop commands through Meta or portable Alt", () => {
  const mappings = [
    ["t", { type: "new-session" }],
    ["w", { type: "close-session" }],
    ["[", { type: "previous-session" }],
    ["]", { type: "next-session" }],
    ["i", { type: "focus-input" }],
    ["l", { type: "focus-selected-block" }],
    ["r", { type: "rerun-selected-command" }],
    ["ArrowUp", { type: "previous-block" }],
    ["PageUp", { type: "previous-block" }],
    ["ArrowDown", { type: "next-block" }],
    ["PageDown", { type: "next-block" }],
    ["d", { type: "delete-selected-block" }],
    ["b", { type: "open-bookmarks" }],
    ["h", { type: "open-history" }],
  ];

  for (const [key, expected] of mappings) {
    for (const event of portableCommandEvents(key)) {
      assert.deepEqual(resolveBlockTermDesktopShortcut(event), expected, `${key} with ${event.metaKey ? "Meta" : "Alt"}`);
    }
  }
});

test("distinguishes the Shift and Ctrl desktop command variants", () => {
  for (const event of portableCommandEvents("R", { shiftKey: true })) {
    assert.deepEqual(resolveBlockTermDesktopShortcut(event), { type: "rerun-last-command" });
  }
  for (const event of portableCommandEvents("s", { ctrlKey: true })) {
    assert.deepEqual(resolveBlockTermDesktopShortcut(event), { type: "toggle-sidebar" });
  }

  assert.deepEqual(resolveBlockTermDesktopShortcut(keyEvent("r", { metaKey: true })), {
    type: "rerun-selected-command",
  });
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("s", { metaKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("s", { metaKey: true, ctrlKey: true, shiftKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("r", { altKey: true, ctrlKey: true })), null);
});

test("maps portable command digits 1 through 9 to zero-based session indexes", () => {
  for (let number = 1; number <= 9; number += 1) {
    for (const event of portableCommandEvents(String(number))) {
      assert.deepEqual(resolveBlockTermDesktopShortcut(event), {
        type: "select-session",
        index: number - 1,
      });
    }
  }

  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("0", { metaKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("1", { altKey: true, shiftKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("9", { metaKey: true, ctrlKey: true })), null);
});

test("uses physical key codes for macOS Option characters", () => {
  const mappings = [
    ["†", "KeyT", { type: "new-session" }],
    ["∑", "KeyW", { type: "close-session" }],
    ["¡", "Digit1", { type: "select-session", index: 0 }],
    ["“", "BracketLeft", { type: "previous-session" }],
    ["‘", "BracketRight", { type: "next-session" }],
    ["®", "KeyR", { type: "rerun-last-command" }, { shiftKey: true }],
    ["ß", "KeyS", { type: "toggle-sidebar" }, { ctrlKey: true }],
  ];

  for (const [key, code, expected, patch = {}] of mappings) {
    const event = keyEvent(key, { altKey: true, code, ...patch });
    assert.equal(resolveBlockTermDesktopShortcut(event), null);
    assert.deepEqual(resolveBlockTermDesktopShortcut(event, { allowAltCodeFallback: true }), expected);
  }
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("†", { metaKey: true, code: "KeyT" })), null);
});

test("provides macOS browser session fallbacks without consuming Option editing keys", () => {
  assert.equal(isBlockTermMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isBlockTermMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), true);
  assert.equal(isBlockTermMacPlatform({ platform: "Linux x86_64" }), false);

  const commandInput = shortcutTarget({ tagName: "textarea" });
  const xtermInput = shortcutTarget({ tagName: "textarea", ancestorClass: ".xterm" });
  const fallbackMappings = [
    ["T", "KeyT", { type: "new-session" }],
    ["W", "KeyW", { type: "close-session" }],
    ["!", "Digit1", { type: "select-session", index: 0 }],
    ["{", "BracketLeft", { type: "previous-session" }],
    ["}", "BracketRight", { type: "next-session" }],
  ];
  for (const [key, code, expected] of fallbackMappings) {
    const event = keyEvent(key, { code, ctrlKey: true, shiftKey: true });
    assert.deepEqual(
      resolveBlockTermDesktopShortcutForTarget(event, commandInput, { commandInput: true, macPlatform: true }),
      expected
    );
    assert.equal(
      resolveBlockTermDesktopShortcutForTarget(event, commandInput, { commandInput: true, macPlatform: false }),
      null
    );
  }

  for (const target of [commandInput, xtermInput]) {
    assert.equal(
      resolveBlockTermDesktopShortcutForTarget(
        keyEvent("†", { code: "KeyT", altKey: true }),
        target,
        { commandInput: target === commandInput, macPlatform: true }
      ),
      null
    );
    assert.equal(
      resolveBlockTermDesktopShortcutForTarget(keyEvent("ArrowUp", { altKey: true }), target, {
        commandInput: target === commandInput,
        macPlatform: true,
      }),
      null
    );
  }
  assert.equal(
    resolveBlockTermDesktopShortcutForTarget(
      keyEvent("R", { code: "KeyR", ctrlKey: true, shiftKey: true }),
      commandInput,
      { commandInput: true, macPlatform: true }
    ),
    null
  );
});

test("rejects missing, doubled, and unrelated modifier combinations", () => {
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("t")), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("t", { ctrlKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("t", { shiftKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("t", { metaKey: true, altKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("x", { metaKey: true })), null);
  assert.equal(resolveBlockTermDesktopShortcut(keyEvent("Enter", { altKey: true })), null);
});

test("guards both dialog families while desktop shortcuts are active", () => {
  let queriedSelector = null;
  assert.equal(
    hasOpenBlockTermDesktopShortcutModal({
      querySelector(selector) {
        queriedSelector = selector;
        return { open: true };
      },
    }),
    true
  );
  assert.equal(queriedSelector, BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR);
  assert.match(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR, /dialog-content/);
  assert.match(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR, /alert-dialog-content/);
  assert.match(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR, /dropdown-menu-content/);
  assert.match(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR, /combobox-content.*data-open/);
  assert.match(BLOCKTERM_DESKTOP_SHORTCUT_MODAL_SELECTOR, /role="dialog"/);
  assert.equal(hasOpenBlockTermDesktopShortcutModal({ querySelector: () => null }), false);
});

test("only repeats navigation shortcuts", () => {
  const repeatable = [
    { type: "previous-session" },
    { type: "next-session" },
    { type: "previous-block" },
    { type: "next-block" },
  ];
  const oneShot = [
    { type: "new-session" },
    { type: "close-session" },
    { type: "select-session", index: 0 },
    { type: "focus-input" },
    { type: "focus-selected-block" },
    { type: "rerun-selected-command" },
    { type: "rerun-last-command" },
    { type: "delete-selected-block" },
    { type: "toggle-sidebar" },
    { type: "open-bookmarks" },
    { type: "open-history" },
  ];

  for (const shortcut of repeatable) assert.equal(isBlockTermDesktopShortcutRepeatable(shortcut), true);
  for (const shortcut of oneShot) assert.equal(isBlockTermDesktopShortcutRepeatable(shortcut), false);
});

test("matches the WaveTerm close threshold and prefers the right session neighbor", () => {
  assert.equal(shouldConfirmBlockTermSessionClose(9), false);
  assert.equal(shouldConfirmBlockTermSessionClose(10), true);
  assert.equal(shouldConfirmBlockTermSessionClose(11), true);

  const sessionIds = ["a", "b", "c"];
  assert.equal(resolveBlockTermSessionAfterClose(sessionIds, "a"), "b");
  assert.equal(resolveBlockTermSessionAfterClose(sessionIds, "b"), "c");
  assert.equal(resolveBlockTermSessionAfterClose(sessionIds, "c"), "b");
  assert.equal(resolveBlockTermSessionAfterClose(["only"], "only"), null);
  assert.equal(resolveBlockTermSessionAfterClose(sessionIds, "missing"), null);
});

test("falls back from unavailable session focus targets to the visible selection or input", () => {
  const terminalTarget = {
    type: "block",
    blockId: "main-a",
    area: "main",
    focus: "terminal",
  };
  assert.deepEqual(resolveBlockTermSessionFocusTarget(terminalTarget, ["main-a"], "side-a", "main-a"), terminalTarget);

  const sidebarTarget = {
    type: "block",
    blockId: "side-a",
    area: "sidebar",
    focus: "editor",
  };
  assert.deepEqual(resolveBlockTermSessionFocusTarget(sidebarTarget, ["main-a"], "side-a", "side-a"), sidebarTarget);
  assert.deepEqual(resolveBlockTermSessionFocusTarget(terminalTarget, ["main-b"], "side-a", "main-b"), {
    type: "block",
    blockId: "main-b",
    area: "main",
    focus: "container",
  });
  assert.deepEqual(resolveBlockTermSessionFocusTarget(terminalTarget, ["main-b"], "side-a", "side-a"), {
    type: "block",
    blockId: "side-a",
    area: "sidebar",
    focus: "container",
  });
  assert.deepEqual(resolveBlockTermSessionFocusTarget(sidebarTarget, [], null, null), { type: "input" });
});

test("protects renderer editing from line actions without disabling global session actions", () => {
  const protectedShortcuts = [
    { type: "focus-selected-block" },
    { type: "rerun-selected-command" },
    { type: "rerun-last-command" },
    { type: "previous-block" },
    { type: "next-block" },
    { type: "delete-selected-block" },
    { type: "toggle-sidebar" },
  ];
  const globalShortcuts = [
    { type: "new-session" },
    { type: "close-session" },
    { type: "select-session", index: 0 },
    { type: "previous-session" },
    { type: "next-session" },
    { type: "focus-input" },
    { type: "open-bookmarks" },
    { type: "open-history" },
  ];
  const deleteShortcut = protectedShortcuts[5];
  assert.equal(shouldIgnoreBlockTermDesktopShortcutTarget(null, deleteShortcut), false);
  assert.equal(shouldIgnoreBlockTermDesktopShortcutTarget(shortcutTarget(), deleteShortcut), false);

  for (const tagName of ["INPUT", "textarea", "Select"]) {
    const target = shortcutTarget({ tagName });
    for (const shortcut of protectedShortcuts) {
      assert.equal(shouldIgnoreBlockTermDesktopShortcutTarget(target, shortcut), true, `${tagName}:${shortcut.type}`);
    }
    for (const shortcut of globalShortcuts) {
      assert.equal(shouldIgnoreBlockTermDesktopShortcutTarget(target, shortcut), false, `${tagName}:${shortcut.type}`);
    }
  }
  for (const shortcut of protectedShortcuts) {
    assert.equal(
      shouldIgnoreBlockTermDesktopShortcutTarget(shortcutTarget({ isContentEditable: true }), shortcut),
      true,
      `contenteditable:${shortcut.type}`
    );
    assert.equal(
      shouldIgnoreBlockTermDesktopShortcutTarget(shortcutTarget({ ancestorClass: ".monaco-editor" }), shortcut),
      true,
      `monaco:${shortcut.type}`
    );
    assert.equal(
      shouldIgnoreBlockTermDesktopShortcutTarget(
        shortcutTarget({ ancestorClass: "[data-blockterm-renderer]" }),
        shortcut
      ),
      true,
      `renderer:${shortcut.type}`
    );
  }
  assert.equal(
    shouldIgnoreBlockTermDesktopShortcutTarget(shortcutTarget({ ancestorClass: ".xterm" }), deleteShortcut),
    false
  );
  assert.equal(
    shouldIgnoreBlockTermDesktopShortcutTarget(
      shortcutTarget({ tagName: "textarea", ancestorClass: ".xterm" }),
      deleteShortcut
    ),
    false
  );

  const commandInput = shortcutTarget({ tagName: "textarea" });
  assert.equal(isBlockTermDesktopShortcutEditingTarget(commandInput), true);
  assert.equal(isBlockTermDesktopShortcutEditingTarget(shortcutTarget({ ancestorClass: ".xterm" })), true);
  assert.equal(isBlockTermDesktopShortcutEditingTarget(shortcutTarget()), false);
  assert.equal(
    shouldIgnoreBlockTermDesktopShortcutTarget(commandInput, deleteShortcut, { commandInput: true }),
    true
  );
  for (const shortcut of [...protectedShortcuts.filter((item) => item !== deleteShortcut), ...globalShortcuts]) {
    assert.equal(
      shouldIgnoreBlockTermDesktopShortcutTarget(commandInput, shortcut, { commandInput: true }),
      false,
      `command-input:${shortcut.type}`
    );
  }
});
