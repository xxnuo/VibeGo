import { create } from "zustand";
import { gitApi, type GitFileStatus, type GitCommit, type GitDiff } from "@/api/git";

export interface GitFileNode {
  id: string;
  name: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";
  path: string;
  staged: boolean;
  originalContent?: string;
  modifiedContent?: string;
}

interface GitState {
  currentPath: string | null;
  files: GitFileNode[];
  stagedFiles: GitFileNode[];
  unstagedFiles: GitFileNode[];
  currentBranch: string;
  branches: string[];
  commits: GitCommit[];
  selectedCommit: GitCommit | null;
  selectedCommitFiles: GitFileNode[];
  commitMessage: string;
  isLoading: boolean;
  error: string | null;
  activeTab: "changes" | "history";

  setCurrentPath: (path: string | null) => void;
  setFiles: (files: GitFileNode[]) => void;
  setCurrentBranch: (branch: string) => void;
  setBranches: (branches: string[]) => void;
  setCommitMessage: (msg: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSelectedCommit: (commit: GitCommit | null) => void;
  setSelectedCommitFiles: (files: GitFileNode[]) => void;
  setActiveTab: (tab: "changes" | "history") => void;

  reset: () => void;
  fetchStatus: () => Promise<void>;
  fetchLog: (limit?: number) => Promise<void>;
  fetchBranches: () => Promise<void>;
  switchBranch: (branch: string) => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  discardFile: (path: string) => Promise<void>;
  commit: () => Promise<boolean>;
  getDiff: (filePath: string) => Promise<GitDiff | null>;
}

const mapStatus = (status: string): GitFileNode["status"] => {
  switch (status) {
    case "M":
    case "modified":
      return "modified";
    case "A":
    case "added":
      return "added";
    case "D":
    case "deleted":
      return "deleted";
    case "R":
    case "renamed":
      return "renamed";
    case "C":
    case "copied":
      return "copied";
    case "?":
    case "untracked":
      return "untracked";
    default:
      return "modified";
  }
};

const fileStatusToNodes = (files: GitFileStatus[]): { staged: GitFileNode[]; unstaged: GitFileNode[] } => {
  const staged: GitFileNode[] = [];
  const unstaged: GitFileNode[] = [];

  files.forEach((f) => {
    const name = f.path.split("/").pop() || f.path;
    const node: GitFileNode = {
      id: `git-${f.path}-${f.staged ? "staged" : "unstaged"}`,
      name,
      status: mapStatus(f.status),
      path: f.path,
      staged: f.staged,
    };
    if (f.staged) {
      staged.push(node);
    } else {
      unstaged.push(node);
    }
  });

  return { staged, unstaged };
};

export const useGitStore = create<GitState>((set, get) => ({
  currentPath: null,
  files: [],
  stagedFiles: [],
  unstagedFiles: [],
  currentBranch: "main",
  branches: [],
  commits: [],
  selectedCommit: null,
  selectedCommitFiles: [],
  commitMessage: "",
  isLoading: false,
  error: null,
  activeTab: "changes",

  setCurrentPath: (path) => set({ currentPath: path }),
  setFiles: (files) => set({ files }),
  setCurrentBranch: (branch) => set({ currentBranch: branch }),
  setBranches: (branches) => set({ branches }),
  setCommitMessage: (msg) => set({ commitMessage: msg }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  setSelectedCommit: (commit) => set({ selectedCommit: commit }),
  setSelectedCommitFiles: (files) => set({ selectedCommitFiles: files }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  reset: () => set({
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    commits: [],
    selectedCommit: null,
    selectedCommitFiles: [],
    commitMessage: "",
    isLoading: false,
    error: null,
  }),

  fetchStatus: async () => {
    const { currentPath } = get();
    if (!currentPath) return;

    set({ isLoading: true, error: null });
    try {
      const res = await gitApi.status(currentPath);
      const { staged, unstaged } = fileStatusToNodes(res.files);
      set({
        stagedFiles: staged,
        unstagedFiles: unstaged,
        files: [...staged, ...unstaged],
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to fetch status" });
    } finally {
      set({ isLoading: false });
    }
  },

  fetchLog: async (limit = 50) => {
    const { currentPath } = get();
    if (!currentPath) return;

    set({ isLoading: true, error: null });
    try {
      const res = await gitApi.log(currentPath, limit);
      set({ commits: res.commits });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to fetch log" });
    } finally {
      set({ isLoading: false });
    }
  },

  fetchBranches: async () => {
    const { currentPath } = get();
    if (!currentPath) return;

    try {
      const res = await gitApi.branches(currentPath);
      set({
        branches: res.branches.map(b => b.name),
        currentBranch: res.currentBranch,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to fetch branches" });
    }
  },

  switchBranch: async (branch: string) => {
    const { currentPath, fetchStatus, fetchBranches } = get();
    if (!currentPath) return;

    set({ isLoading: true, error: null });
    try {
      await gitApi.switchBranch(currentPath, branch);
      await fetchBranches();
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to switch branch" });
    } finally {
      set({ isLoading: false });
    }
  },

  stageFile: async (path: string) => {
    const { currentPath, fetchStatus } = get();
    if (!currentPath) return;

    try {
      await gitApi.add(currentPath, [path]);
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to stage file" });
    }
  },

  unstageFile: async (path: string) => {
    const { currentPath, fetchStatus } = get();
    if (!currentPath) return;

    try {
      await gitApi.reset(currentPath, [path]);
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to unstage file" });
    }
  },

  stageAll: async () => {
    const { currentPath, unstagedFiles, fetchStatus } = get();
    if (!currentPath || unstagedFiles.length === 0) return;

    try {
      await gitApi.add(currentPath, unstagedFiles.map((f) => f.path));
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to stage all files" });
    }
  },

  unstageAll: async () => {
    const { currentPath, stagedFiles, fetchStatus } = get();
    if (!currentPath || stagedFiles.length === 0) return;

    try {
      await gitApi.reset(currentPath, stagedFiles.map((f) => f.path));
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to unstage all files" });
    }
  },

  discardFile: async (path: string) => {
    const { currentPath, fetchStatus } = get();
    if (!currentPath) return;

    try {
      await gitApi.checkout(currentPath, [path]);
      await fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to discard changes" });
    }
  },

  commit: async () => {
    const { currentPath, commitMessage, fetchStatus, fetchLog } = get();
    if (!currentPath || !commitMessage.trim()) return false;

    set({ isLoading: true, error: null });
    try {
      await gitApi.commit(currentPath, commitMessage);
      set({ commitMessage: "" });
      await fetchStatus();
      await fetchLog();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to commit" });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  getDiff: async (filePath: string) => {
    const { currentPath } = get();
    if (!currentPath) return null;

    try {
      return await gitApi.diff(currentPath, filePath);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to get diff" });
      return null;
    }
  },
}));
