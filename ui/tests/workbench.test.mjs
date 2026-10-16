import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("workbench registry, taskbars, and contributed actions preserve frame behavior", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const globals = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "localStorage",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const original = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) {
    const value =
      name === "IS_REACT_ACT_ENVIRONMENT"
        ? true
        : typeof dom.window[name] === "function" && name[0] === name[0].toLowerCase()
          ? dom.window[name].bind(dom.window)
          : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const vite = await createServer({ appType: "custom", server: { hmr: false, ws:false, middlewareMode: true } });
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    await vite.close();
    dom.window.close();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const registry = await vite.ssrLoadModule("/src/framework/workbench/registry.ts");
  const legacyRegistry = await vite.ssrLoadModule("/src/pages/registry.ts");
  const { useFrameStore } = await vite.ssrLoadModule("/src/stores/frame-store.ts");
  const { useSessionStore } = await vite.ssrLoadModule("/src/stores/session-store.ts");
  const { useTaskbar } = await vite.ssrLoadModule("/src/framework/workbench/use-taskbar.ts");
  const { useWorkbenchActionStore, useContributedEditorActions, useContributedViewActions } = await vite.ssrLoadModule(
    "/src/framework/workbench/use-workbench-actions.ts"
  );
  const { default: WorkbenchHeader } = await vite.ssrLoadModule("/src/components/frame/workbench-header.tsx");
  let taskbar;
  function TaskbarProbe({ orientation }) {
    taskbar = useTaskbar({ orientation });
    return null;
  }
  const renderProbe = (orientation) =>
    act(() => root.render(React.createElement(TaskbarProbe, { orientation, key: orientation })));
  const reset = async () => {
    await act(() => root.render(null));
    useFrameStore.setState({
      groups: [],
      activeGroupId: null,
      taskbarOrder: [],
      topBarConfig: { show: false },
      bottomBarConfig: { show: true },
    });
    useFrameStore.getState().initDefaultGroups();
    useWorkbenchActionStore.setState({ editorActions: [], viewActions: [] });
  };

  await t.test("legacy registration uses the same sorted workbench registry", () => {
    assert.equal(legacyRegistry.pageRegistry, registry.workbenchRegistry);
    const page = { id: "workbench-test", name: "test", order: -1, category: "tool", View: () => null };
    legacyRegistry.registerPage(page);
    assert.equal(registry.workbenchRegistry.get(page.id), page);
    assert.equal(registry.workbenchRegistry.getAll()[0], page);
    registry.unregisterPage(page.id);
    assert.equal(legacyRegistry.pageRegistry.get(page.id), undefined);
  });

  await t.test("home visibility, custom ordering, and badges retain orientation rules", async () => {
    await reset();
    await renderProbe("vertical");
    assert.deepEqual(taskbar.visibleIds, ["group:home"]);
    await renderProbe("horizontal");
    assert.deepEqual(taskbar.visibleIds, []);
    await act(() => {
      useFrameStore.getState().setBottomBarConfig({
        show: true,
        customItems: [
          { id: "a", label: "A", badge: 2 },
          { id: "b", label: "B" },
        ],
      });
      useFrameStore.getState().setTaskbarOrder(["stale", "custom:b"]);
    });
    assert.deepEqual(
      taskbar.orderedItems.map((item) => item.id),
      ["custom:b", "custom:a"]
    );
    assert.equal(taskbar.sortEntries[1].badge, 2);
    assert.equal(taskbar.sortEntries[1].title, "A");
  });

  await t.test("desktop repeated clicks and mobile double clicks retain tab behavior", async () => {
    await reset();
    useFrameStore.getState().addToolGroup("test-tool", "Tool", "test-tool");
    useFrameStore.getState().addCurrentTab({ id: "tab", title: "test.ts" });
    await renderProbe("vertical");
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().getActiveGroup(), document.body));
    assert.equal(useFrameStore.getState().getCurrentActiveTabId(), null);
    await act(() => useFrameStore.getState().setCurrentActiveTab("tab"));
    await renderProbe("horizontal");
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().getActiveGroup(), document.body));
    assert.equal(useFrameStore.getState().getCurrentActiveTabId(), "tab");
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().getActiveGroup(), document.body));
    assert.equal(useFrameStore.getState().getCurrentActiveTabId(), null);
  });

  await t.test("workspace hints and folder closing route through their existing owners", async () => {
    await reset();
    useFrameStore.getState().addFolderGroup("/repo", "Repo", "repo");
    await renderProbe("horizontal");
    await act(() => useFrameStore.getState().addToolGroup("test-tool", "Tool", "other"));
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().groups.find(group => group.id === "repo"), document.body));
    assert.equal(taskbar.workspaceHint, null);
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().getActiveGroup(), document.body));
    assert.equal(taskbar.workspaceHint.path, "/repo");
    assert.equal(taskbar.workspaceHint.placement, "top");
    await renderProbe("vertical");
    await act(() => taskbar.handleGroupClick(useFrameStore.getState().getActiveGroup(), document.body));
    assert.equal(taskbar.workspaceHint.placement, "right");
    await act(() => useFrameStore.getState().removeGroup("other"));
    const closeFolderGroup = useSessionStore.getState().closeFolderGroup;
    const closed = [];
    await act(() =>
      useSessionStore.setState({
        closeFolderGroup: async (id) => {
          closed.push(id);
          useFrameStore.getState().removeGroup(id);
        },
      })
    );
    try {
      await act(() => taskbar.closeGroup(useFrameStore.getState().getActiveGroup()));
      assert.deepEqual(closed, ["repo"]);
      assert.deepEqual(
        useFrameStore.getState().groups.map((group) => group.type),
        ["home"]
      );
      await act(() => taskbar.closeAllGroups());
      assert.equal(useFrameStore.getState().groups.length, 1);
    } finally {
      await act(() => useSessionStore.setState({ closeFolderGroup }));
    }
  });

  await t.test("saved workspaces restore group ownership, tabs, and taskbar order", async () => {
    await reset();
    const { sessionApi } = await vite.ssrLoadModule("/src/api/session.ts");
    const { settingsApi } = await vite.ssrLoadModule("/src/api/settings.ts");
    const { terminalApi } = await vite.ssrLoadModule("/src/api/terminal.ts");
    const { getTerminalWorkspaceGroupIds } = await vite.ssrLoadModule("/src/stores/session-workspace-guard.ts");
    const patches = [];
    let saved;
    const { workspaceApi } = await vite.ssrLoadModule("/src/api/workspace-sync.ts");
    const { inventoryFromFrame } = await vite.ssrLoadModule("/src/stores/workspace-inventory.ts");
    const { useWorkspaceSyncStore } = await vite.ssrLoadModule("/src/stores/workspace-sync-store.ts");
    const mock = (target, key, value) => {
      patches.push([target, key, target[key]]);
      target[key] = value;
    };
    mock(sessionApi, "update", async () => ({ ok: true }));
    mock(sessionApi, "patchWorkspace", async (_id, state) => {
      saved = structuredClone(state);
      return { ok: true };
    });
    mock(sessionApi, "get", async () => ({ id: "fixture", workspace_state: saved }));
    mock(settingsApi, "set", async () => ({ ok: true }));
    mock(terminalApi, "syncWorkspace", async () => ({ ok: true }));
    mock(terminalApi, "list", async () => ({ terminals: [] }));
    mock(workspaceApi,"getSnapshot",async()=>saved);
    mock(useWorkspaceSyncStore.getState(),"connect",async()=>{});
    const initAutoSave = useSessionStore.getState().initAutoSave;
    useSessionStore.setState({
      currentSessionId: "fixture",
      workspaceRevision: 0,
      loading: false,
      sessionInitialized: true,
      initAutoSave() {},
    });
    try {
      const frame = useFrameStore.getState();
      frame.addFolderGroup("/repo", "Repo", "repo");
      frame.addCurrentTab({ id: "file", title: "file.ts", pinned: true });
      frame.addToolGroup("test-tool", "Tool", "tool");
      frame.addCurrentTab({ id: "tool-tab", title: "Tool tab" });
      frame.setTaskbarOrder(["group:tool", "group:repo"]);
      frame.setActiveGroup("repo");
      saved={workspace:{id:"fixture",name:"Fixture",revision:1,data:"{}"},...inventoryFromFrame(useFrameStore.getState().groups,"fixture"),storage:[],terminals:[]};
      await useSessionStore.getState().saveCurrentSession();
      assert.equal(JSON.parse(window.sessionStorage.getItem("vibego:viewport:fixture")).activeTabs["repo-files"], "file");
      useSessionStore.setState({ currentSessionId: null });
      frame.initDefaultGroups();
      await useSessionStore.getState().switchSession("fixture");
      const restored = useFrameStore.getState();
      assert.equal(useSessionStore.getState().error, null);
      assert.equal(restored.activeGroupId, "repo");
      assert.deepEqual(restored.taskbarOrder, ["group:tool", "group:repo"]);
      assert.deepEqual(
        restored.groups[0].pages.map((page) => page.type),
        ["files"]
      );
      assert.equal(restored.getCurrentTabs()[0].pinned, true);
      assert.equal(restored.getCurrentActiveTabId(), "file");
      assert.deepEqual([...getTerminalWorkspaceGroupIds(restored.groups)], []);
      assert.equal(restored.groups.find((group) => group.id === "tool").activeTabId, "tool-tab");
    } finally {
      for (const [target, key, value] of patches) target[key] = value;
      useSessionStore.setState({ initAutoSave, currentSessionId: null });
    }
  });

  await t.test("fullscreen follows orientation options and fullscreenchange", async () => {
    await reset();
    const calls = [];
    document.documentElement.requestFullscreen = async (options) => calls.push(options);
    document.exitFullscreen = async () => calls.push("exit");
    await renderProbe("horizontal");
    taskbar.handleToggleFullscreen();
    assert.deepEqual(calls, [{ navigationUI: "hide" }]);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
    await act(() => document.dispatchEvent(new window.Event("fullscreenchange")));
    assert.equal(taskbar.isFullscreen, true);
    taskbar.handleToggleFullscreen();
    assert.equal(calls[1], "exit");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    await renderProbe("vertical");
    taskbar.handleToggleFullscreen();
    assert.equal(calls[2], undefined);
  });

  await t.test("custom header keeps configured actions and falls back to editor tabs", async () => {
    await reset();
    useFrameStore.getState().addToolGroup("test-tool", "Tool", "test-tool");
    useFrameStore.getState().addCurrentTab({ id: "tab", title: "test.ts" });
    useFrameStore
      .getState()
      .setTopBarConfig({
        show: true,
        leftButtons: [{ title: "Custom left" }],
        rightButtons: [{ title: "Custom right", disabled: true }],
      });
    await act(() => root.render(React.createElement(WorkbenchHeader)));
    assert.ok(document.querySelector('[title="Custom left"]'));
    assert.equal(document.querySelector('[title="Custom right"]').disabled, true);
    assert.match(document.body.textContent, /test.ts/);
    await act(() => useFrameStore.getState().setTopBarConfig({ show: true, centerContent: "Settings" }));
    assert.match(document.body.textContent, /Settings/);
    assert.doesNotMatch(document.body.textContent, /test.ts/);
  });

  function Contribution({ editor, view }) {
    useContributedEditorActions(editor);
    useContributedViewActions(view);
    return null;
  }
  await t.test("actions update callbacks, sort, and clean up in StrictMode", async () => {
    await reset();
    useFrameStore.getState().addToolGroup("test-tool", "Tool", "test-tool");
    const clicks = [];
    const view = [{ id: "refresh", title: "Refresh", order: 2, onClick: () => clicks.push("refresh") }];
    const render = (title) =>
      act(() =>
        root.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(WorkbenchHeader),
            React.createElement(Contribution, {
              editor: [{ id: "edit", title, order: 1, onClick: () => clicks.push(title) }],
              view,
            })
          )
        )
      );
    await render("Edit");
    assert.deepEqual(
      [...document.querySelectorAll("button[aria-label]")].map((button) => button.getAttribute("aria-label")),
      ["关闭页面", "Edit", "Refresh"]
    );
    await act(() => document.querySelector('[aria-label="Edit"]').click());
    await render("Preview");
    await act(() => document.querySelector('[aria-label="Preview"]').click());
    assert.deepEqual(clicks, ["Edit", "Preview"]);
    await act(() => root.render(React.createElement(WorkbenchHeader)));
    assert.deepEqual(useWorkbenchActionStore.getState().editorActions, []);
    assert.deepEqual(useWorkbenchActionStore.getState().viewActions, []);
  });

  await t.test("editor actions are published before editor layout effects", async () => {
    await reset();
    const actions = [{ id: "ready", title: "Ready", onClick() {} }];
    let observed;
    function EditorProbe() {
      useContributedEditorActions(actions);
      React.useLayoutEffect(() => {
        observed = useWorkbenchActionStore.getState().editorActions;
      }, []);
      return null;
    }
    await act(() => root.render(React.createElement(EditorProbe)));
    assert.equal(observed, actions);
  });

  await t.test("a departing contribution cannot clear a newer contribution", async () => {
    await reset();
    const first = [{ id: "first", title: "First", onClick() {} }];
    const second = [{ id: "second", title: "Second", onClick() {} }];
    const view = [];
    await act(() =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Contribution, { key: "first", editor: first, view }),
          React.createElement(Contribution, { key: "second", editor: second, view })
        )
      )
    );
    await act(() =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Contribution, { key: "second", editor: second, view })
        )
      )
    );
    assert.equal(useWorkbenchActionStore.getState().editorActions, second);
    await act(() => root.render(null));
    assert.deepEqual(useWorkbenchActionStore.getState().editorActions, []);
  });
});
