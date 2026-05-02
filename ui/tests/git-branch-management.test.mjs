import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("git branch management API sends explicit refs and remote names", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });
  globalThis.localStorage = { getItem: () => null };

  const { gitApi } = await vite.ssrLoadModule("/src/api/git.ts");
  const { parseRemoteBranchDisplay } = await vite.ssrLoadModule("/src/components/git/branch-selector.tsx");
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      ok: true,
      branch: "feature/new",
      oldBranch: "feature/old",
      remote: "origin",
      dryRun: false,
      removed: ["origin/stale"],
      branches: ["main"],
      remoteBranches: ["origin/main"],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await gitApi.renameBranch("/repo", "feature/old", "feature/new");
  await gitApi.deleteRemoteBranch("/repo", "origin", "feature/new");
  await gitApi.pruneRemote("/repo", "origin");
  await gitApi.switchRemoteBranch("/repo", "origin", "feature/nested/topic", "feature/nested/topic");
  await gitApi.stashFiles("/repo", 1, "0123456789012345678901234567890123456789");
  await gitApi.stashDiff("/repo", 1, "tab\tname", "0123456789012345678901234567890123456789");
  await gitApi.stashPop("/repo", 1, "0123456789012345678901234567890123456789");
  await gitApi.stashDrop("/repo", 1, "0123456789012345678901234567890123456789");

  assert.deepEqual(parseRemoteBranchDisplay("team/origin/feature/topic", ["team", "team/origin"]), {
    remote: "team/origin",
    branch: "feature/topic",
  });
  assert.equal(parseRemoteBranchDisplay("team/origin/feature/topic", []), null);

  assert.deepEqual(calls, [
    { url: "/api/git/rename-branch", body: { path: "/repo", oldBranch: "feature/old", newBranch: "feature/new" } },
    { url: "/api/git/delete-remote-branch", body: { path: "/repo", remote: "origin", branch: "feature/new" } },
    { url: "/api/git/prune-remote", body: { path: "/repo", remote: "origin", dryRun: false } },
    {
      url: "/api/git/switch-remote-branch",
      body: {
        path: "/repo",
        remote: "origin",
        branch: "feature/nested/topic",
        localBranch: "feature/nested/topic",
      },
    },
    {
      url: "/api/git/stash-files",
      body: { path: "/repo", index: 1, oid: "0123456789012345678901234567890123456789" },
    },
    {
      url: "/api/git/stash-diff",
      body: {
        path: "/repo",
        index: 1,
        oid: "0123456789012345678901234567890123456789",
        filePath: "tab\tname",
      },
    },
    {
      url: "/api/git/stash-pop",
      body: { path: "/repo", index: 1, oid: "0123456789012345678901234567890123456789" },
    },
    {
      url: "/api/git/stash-drop",
      body: { path: "/repo", index: 1, oid: "0123456789012345678901234567890123456789" },
    },
  ]);
});

test("git branch checkout ignores stale repositories and surfaces stash restore conflicts", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { gitApi } = await vite.ssrLoadModule("/src/api/git.ts");
  const { createGitStore } = await vite.ssrLoadModule("/src/stores/git-store.ts");
  const originalCheckout = gitApi.checkoutRemoteBranch;
  const originalSmartSwitch = gitApi.smartSwitchBranch;
  t.after(() => {
    gitApi.checkoutRemoteBranch = originalCheckout;
    gitApi.smartSwitchBranch = originalSmartSwitch;
  });

  let resolveCheckout;
  gitApi.checkoutRemoteBranch = () =>
    new Promise((resolve) => {
      resolveCheckout = resolve;
    });

  const store = createGitStore("branch-management-test");
  store.getState().setCurrentPath("/repo-a");
  const staleRequest = store.getState().checkoutRemoteBranch("origin", "feature");
  store.getState().setCurrentPath("/repo-b");
  resolveCheckout({
    ok: true,
    branch: "feature",
    remote: "origin",
    remoteBranch: "feature",
    created: true,
    stashed: false,
    stashConflict: false,
  });
  assert.equal(await staleRequest, true);
  assert.equal(store.getState().currentPath, "/repo-b");
  assert.equal(store.getState().currentBranch, "main");
  assert.equal(store.getState().isLoading, false);

  store.getState().setCurrentPath("/repo-a");
  gitApi.checkoutRemoteBranch = async () => ({
    ok: true,
    branch: "feature",
    remote: "origin",
    remoteBranch: "feature",
    created: true,
    stashed: true,
    stashConflict: true,
    stashError: "same.txt already exists",
    status: {
      files: [],
      summary: { changed: 0, staged: 0, unstaged: 0, included: 0, conflicted: 0 },
    },
  });
  assert.equal(await store.getState().checkoutRemoteBranch("origin", "feature"), false);
  assert.equal(store.getState().currentBranch, "feature");
  assert.match(store.getState().error, /same\.txt already exists/);

  const preservedFile = {
    path: "preserved.txt",
    name: "preserved.txt",
    status: "modified",
    includedState: "none",
  };
  store.setState({ allFiles: [preservedFile], error: null });
  gitApi.smartSwitchBranch = async () => ({
    ok: true,
    branch: "legacy-response",
    stashed: false,
    stashConflict: false,
  });
  assert.equal(await store.getState().smartSwitchBranch("legacy-response"), true);
  assert.equal(store.getState().currentBranch, "legacy-response");
  assert.deepEqual(store.getState().allFiles, [preservedFile]);
});

test("git mutations ignore stale repository responses", async (t) => {
  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { gitApi } = await vite.ssrLoadModule("/src/api/git.ts");
  const { createGitStore } = await vite.ssrLoadModule("/src/stores/git-store.ts");
  const originals = {
    createBranch: gitApi.createBranch,
    deleteBranch: gitApi.deleteBranch,
    stash: gitApi.stash,
    stashPop: gitApi.stashPop,
    stashDrop: gitApi.stashDrop,
    stashFiles: gitApi.stashFiles,
  };
  t.after(() => {
    Object.assign(gitApi, originals);
  });

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const store = createGitStore("git-stale-mutations-test");
  const preservedFile = {
    path: "repo-b.txt",
    name: "repo-b.txt",
    status: "modified",
    includedState: "none",
  };
  const stash = { index: 0, oid: "0123456789012345678901234567890123456789", message: "work" };

  const popRequest = deferred();
  gitApi.stashPop = () => popRequest.promise;
  store.getState().setCurrentPath("/repo-a");
  store.setState({ stashes: [stash] });
  const stalePop = store.getState().stashPop(0);
  store.getState().setCurrentPath("/repo-b");
  store.setState({ allFiles: [preservedFile], error: null });
  popRequest.resolve({
    ok: true,
    status: {
      files: [{ path: "repo-a.txt", status: "modified", staged: false }],
      summary: { changed: 1, staged: 0, unstaged: 1, included: 0, conflicted: 0 },
    },
  });
  assert.equal(await stalePop, true);
  assert.deepEqual(store.getState().allFiles, [preservedFile]);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, false);

  const stashRequest = deferred();
  gitApi.stash = () => stashRequest.promise;
  store.getState().setCurrentPath("/repo-a");
  const staleStash = store.getState().stash("work");
  store.getState().setCurrentPath("/repo-b");
  store.setState({ allFiles: [preservedFile], error: null });
  stashRequest.resolve({
    ok: true,
    status: {
      files: [{ path: "repo-a-stash.txt", status: "modified", staged: false }],
      summary: { changed: 1, staged: 0, unstaged: 1, included: 0, conflicted: 0 },
    },
  });
  assert.equal(await staleStash, true);
  assert.deepEqual(store.getState().allFiles, [preservedFile]);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, false);

  const dropRequest = deferred();
  gitApi.stashDrop = () => dropRequest.promise;
  store.getState().setCurrentPath("/repo-a");
  store.setState({ stashes: [stash] });
  const staleDrop = store.getState().stashDrop(0);
  store.getState().setCurrentPath("/repo-b");
  store.setState({ error: null });
  dropRequest.reject(new Error("stale drop failure"));
  assert.equal(await staleDrop, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, false);

  const createRequest = deferred();
  gitApi.createBranch = () => createRequest.promise;
  store.getState().setCurrentPath("/repo-a");
  const staleCreate = store.getState().createBranch("feature");
  store.getState().setCurrentPath("/repo-b");
  store.setState({ error: null });
  createRequest.reject(new Error("stale create failure"));
  assert.equal(await staleCreate, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, false);

  const deleteRequest = deferred();
  gitApi.deleteBranch = () => deleteRequest.promise;
  store.getState().setCurrentPath("/repo-a");
  const staleDelete = store.getState().deleteBranch("feature");
  store.getState().setCurrentPath("/repo-b");
  store.setState({ error: null });
  deleteRequest.reject(new Error("stale delete failure"));
  assert.equal(await staleDelete, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, false);

  const supersededCreateRequest = deferred();
  const currentDeleteRequest = deferred();
  gitApi.createBranch = () => supersededCreateRequest.promise;
  gitApi.deleteBranch = () => currentDeleteRequest.promise;
  store.getState().setCurrentPath("/repo");
  const supersededCreate = store.getState().createBranch("superseded");
  const currentDelete = store.getState().deleteBranch("current");
  supersededCreateRequest.reject(new Error("superseded create failure"));
  assert.equal(await supersededCreate, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().isLoading, true);
  currentDeleteRequest.resolve({ ok: true });
  assert.equal(await currentDelete, true);
  assert.equal(store.getState().isLoading, false);

  const supersededPopRequest = deferred();
  const currentDropRequest = deferred();
  gitApi.stashPop = () => supersededPopRequest.promise;
  gitApi.stashDrop = () => currentDropRequest.promise;
  store.setState({
    stashes: [stash],
    allFiles: [preservedFile],
    selectedStashIndex: 0,
    stashFiles: [{ path: "selected.txt", status: "modified" }],
    error: null,
  });
  const supersededPop = store.getState().stashPop(0);
  const currentDrop = store.getState().stashDrop(0);
  supersededPopRequest.resolve({
    ok: true,
    status: {
      files: [{ path: "superseded-pop.txt", status: "modified", staged: false }],
      summary: { changed: 1, staged: 0, unstaged: 1, included: 0, conflicted: 0 },
    },
  });
  assert.equal(await supersededPop, true);
  assert.deepEqual(store.getState().allFiles, [preservedFile]);
  assert.equal(store.getState().selectedStashIndex, 0);
  assert.equal(store.getState().isLoading, true);
  currentDropRequest.resolve({ ok: true });
  assert.equal(await currentDrop, true);
  assert.equal(store.getState().selectedStashIndex, null);
  assert.equal(store.getState().isLoading, false);

  const staleDetailRequest = deferred();
  gitApi.stashFiles = () => staleDetailRequest.promise;
  store.setState({ stashes: [{ index: 0, oid: "old-oid", message: "old" }] });
  const staleDetail = store.getState().selectStash(0);
  store.setState({
    stashes: [{ index: 0, oid: "new-oid", message: "new" }],
    selectedStashIndex: 0,
    stashFiles: [{ path: "new.txt", status: "added" }],
    stashLoading: false,
    error: null,
  });
  staleDetailRequest.reject(new Error("stale stash detail failure"));
  await staleDetail;
  assert.deepEqual(store.getState().stashFiles, [{ path: "new.txt", status: "added" }]);
  assert.equal(store.getState().stashLoading, false);
  assert.equal(store.getState().error, null);
});
