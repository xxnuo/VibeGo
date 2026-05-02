import {
  Archive,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FileDiff,
  GitCommit as GitCommitIcon,
  GitMerge,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  SquareCheck,
  SquareMinus,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroupImperativeHandle, Layout } from "react-resizable-panels";
import type {
  CommitFileInfo,
  GitCommit,
  GitDiff,
  GitInteractiveDiff,
  GitOperationResponse,
  GitStashFile,
  StashEntry,
} from "@/api/git";
import { gitApi } from "@/api/git";
import DiffView from "@/components/git/diff-view";
import GitCommitComposer from "@/components/git/git-commit-composer";
import { areHistoryCommitsContiguous } from "@/components/git/git-history-selection";
import GitOperationControls from "@/components/git/git-operation-controls";
import GitRepositorySettings from "@/components/git/git-repository-settings";
import GitStashDetail from "@/components/git/git-stash-detail";
import GithubPanel from "@/components/git/github-panel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { getTranslation, type Locale } from "@/lib/i18n";
import type { GitFileNode } from "@/stores";
import "@/components/git/desktop-git-workspace.css";

interface DesktopGitWorkspaceProps {
  groupId: string;
  path: string;
  locale: Locale;
  allFiles: GitFileNode[];
  commits: GitCommit[];
  isLoading: boolean;
  selectedCommit: GitCommit | null;
  selectedCommitFiles: CommitFileInfo[];
  currentBranch: string;
  branches: string[];
  activeTab: "changes" | "history";
  hasRemote: boolean;
  remoteUrls: string[];
  aheadCount: number;
  behindCount: number;
  tagsToPush: string[];
  tagsToPushError: string | null;
  stashes: StashEntry[];
  selectedStashIndex: number | null;
  selectedStashFile: string | null;
  stashFiles: GitStashFile[];
  stashDiff: GitInteractiveDiff | null;
  stashLoading: boolean;
  conflicts: string[];
  operation: GitOperationResponse | null;
  error: string | null;
  onActiveTabChange: (tab: "changes" | "history") => void;
  onBranchOpen: () => void;
  onRefresh: () => void;
  repositorySettingsOpen: boolean;
  githubPanelOpen: boolean;
  onRepositorySettingsOpenChange: (open: boolean) => void;
  onGithubPanelOpenChange: (open: boolean) => void;
  onOpenWorktree: (path: string) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: (force?: boolean) => void;
  onToggleFile: (path: string) => Promise<void>;
  onToggleAll: () => Promise<void>;
  onDiscardFile: (path: string) => void;
  onConflictClick: (path: string) => void;
  onStash: (message?: string, files?: string[]) => void;
  onStashPop: (index: number, oid?: string) => void;
  onStashDrop: (index: number, oid?: string) => void;
  onStashSelect: (index: number | null) => void;
  onStashFileSelect: (filePath: string | null) => void;
  onUndoLastCommit: () => Promise<boolean>;
  onCommitSelect: (commit: GitCommit) => Promise<void>;
  onHistoryFileClick: (commit: GitCommit, filePath: string) => Promise<GitDiff | null>;
  selectedCommitHashes?: readonly string[];
  onSelectedCommitHashesChange?: (hashes: string[]) => void;
  onCherryPickCommit?: (commit: GitCommit) => unknown;
  onCherryPickCommits?: (commits: GitCommit[]) => unknown;
  onRevertCommit?: (commit: GitCommit) => unknown;
  onRevertCommits?: (commits: GitCommit[]) => unknown;
  onResetCommit?: (commit: GitCommit) => unknown;
  onResetCommits?: (commits: GitCommit[]) => unknown;
  onSquashCommits?: (commits: GitCommit[], squashOnto: GitCommit) => unknown;
  onReorderCommits?: (commits: GitCommit[], beforeCommit: GitCommit) => unknown;
  onUndoCommit: (commit: GitCommit) => void;
  onCreateTag: (commit: GitCommit) => void;
  onDeleteTag: (tag: string) => void;
  getDiff: (filePath: string) => Promise<GitDiff | null>;
  onLoadMore: () => void;
  onMerge: (ref: string) => Promise<boolean>;
  onRebase: (upstream: string) => Promise<boolean>;
  onCherryPick: (commit: string) => Promise<boolean>;
  onRevert: (commit: string) => Promise<boolean>;
  onResetToCommit: (ref: string, mode: "soft" | "mixed" | "hard") => Promise<boolean>;
  onOperationAction: (action: "continue" | "abort" | "skip") => Promise<boolean>;
  onSquash: (squashOnto: GitCommit) => Promise<boolean>;
  onReorder: (beforeCommit: GitCommit) => Promise<boolean>;
}

type SelectionType = "all" | "partial" | "none";

export { defaultGitOperationRef } from "@/components/git/git-operation-controls";

const statusMeta: Record<GitFileNode["status"], { key: string; label: string }> = {
  modified: { key: "modified", label: "M" },
  added: { key: "added", label: "A" },
  deleted: { key: "deleted", label: "D" },
  renamed: { key: "renamed", label: "R" },
  copied: { key: "copied", label: "C" },
  untracked: { key: "untracked", label: "U" },
};

const selectionIcon = (selection: SelectionType, size = 14) => {
  if (selection === "all") return <SquareCheck size={size} />;
  if (selection === "partial") return <SquareMinus size={size} />;
  return <Square size={size} />;
};

const statusClass = (status: GitFileNode["status"]) => `desktop-git-file-status desktop-git-file-status--${status}`;

const normalizeStatus = (status: string): GitFileNode["status"] => {
  switch (status.toLowerCase()) {
    case "m":
    case "modified":
      return "modified";
    case "a":
    case "added":
      return "added";
    case "d":
    case "deleted":
      return "deleted";
    case "r":
    case "renamed":
      return "renamed";
    case "c":
    case "copied":
      return "copied";
    case "u":
    case "untracked":
      return "untracked";
    default:
      return "modified";
  }
};

const fileSelection = (file: GitFileNode): SelectionType => file.includedState;

const aggregateSelection = (files: GitFileNode[]): SelectionType => {
  if (files.length === 0) return "none";
  const states = files.map(fileSelection);
  if (states.every((state) => state === "all")) return "all";
  if (states.every((state) => state === "none")) return "none";
  return "partial";
};

const firstLine = (message: string) => message.split("\n")[0] || message;

const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
};

const formatDate = (date: string, locale: Locale) => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const readStoredLayout = (key: string, fallback: Layout): Layout => {
  if (typeof window === "undefined") return fallback;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null") as Layout | null;
    const panelIds = Object.keys(fallback);
    if (
      !value ||
      Object.keys(value).length !== panelIds.length ||
      panelIds.some((panelId) => typeof value[panelId] !== "number" || !Number.isFinite(value[panelId]))
    ) {
      return fallback;
    }
    return value;
  } catch {
    return fallback;
  }
};

const storeLayout = (key: string, layout: Layout): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
};

const DesktopGitWorkspace: React.FC<DesktopGitWorkspaceProps> = ({
  groupId,
  path,
  locale,
  allFiles,
  commits,
  isLoading,
  selectedCommit,
  selectedCommitFiles,
  currentBranch,
  activeTab,
  remoteUrls,
  aheadCount,
  tagsToPush,
  stashes,
  selectedStashIndex,
  selectedStashFile,
  stashFiles,
  stashDiff,
  stashLoading,
  conflicts,
  operation,
  error,
  onActiveTabChange,
  onRefresh,
  repositorySettingsOpen,
  githubPanelOpen,
  onRepositorySettingsOpenChange,
  onGithubPanelOpenChange,
  onOpenWorktree,
  onPush,
  onToggleFile,
  onToggleAll,
  onDiscardFile,
  onConflictClick,
  onStash,
  onStashPop,
  onStashDrop,
  onStashSelect,
  onStashFileSelect,
  onUndoLastCommit,
  onCommitSelect,
  onHistoryFileClick,
  selectedCommitHashes,
  onSelectedCommitHashesChange,
  onCherryPickCommit,
  onCherryPickCommits,
  onRevertCommit,
  onRevertCommits,
  onResetCommit,
  onResetCommits,
  onSquashCommits,
  onReorderCommits,
  onUndoCommit,
  onCreateTag,
  onDeleteTag,
  getDiff,
  onLoadMore,
  onMerge,
  onRebase,
  onCherryPick,
  onRevert,
  onResetToCommit,
  onOperationAction,
  onSquash,
  onReorder,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const [filterText, setFilterText] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileDiff, setSelectedFileDiff] = useState<GitDiff | null>(null);
  const [selectedHistoryFile, setSelectedHistoryFile] = useState<string | null>(null);
  const [selectedHistoryDiff, setSelectedHistoryDiff] = useState<GitDiff | null>(null);
  const [selectedHistoryDiffLoading, setSelectedHistoryDiffLoading] = useState(false);
  const [selectedHistoryDiffError, setSelectedHistoryDiffError] = useState<string | null>(null);
  const fileDiffRequestRef = useRef(0);
  const historyDiffRequestRef = useRef(0);
  const [operationPanelOpen, setOperationPanelOpen] = useState(false);
  const [stashPanelOpen, setStashPanelOpen] = useState(false);
  const [internalSelectedCommitHashes, setInternalSelectedCommitHashes] = useState<string[]>(
    () => selectedCommitHashes?.slice() ?? []
  );
  const [contextSelectionHashes, setContextSelectionHashes] = useState<string[]>([]);
  const [selectedRangeFiles, setSelectedRangeFiles] = useState<CommitFileInfo[]>([]);
  const [selectedRangeLoading, setSelectedRangeLoading] = useState(false);
  const [selectedRangeError, setSelectedRangeError] = useState<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const contextSelectionHashesRef = useRef<string[]>([]);
  const rangeFilesRequestRef = useRef(0);
  const mainGroupRef = useRef<GroupImperativeHandle | null>(null);
  const historyGroupRef = useRef<GroupImperativeHandle | null>(null);

  const mainLayoutStorageKey = `vibego.git.layout.${groupId}.main`;
  const mainSidebarId = `desktop-git-sidebar-${groupId}`;
  const mainContentId = `desktop-git-content-${groupId}`;
  const mainDefaultLayout = useMemo<Layout>(
    () => ({ [mainSidebarId]: 28, [mainContentId]: 72 }),
    [mainContentId, mainSidebarId]
  );
  const mainInitialLayout = useMemo(
    () => readStoredLayout(mainLayoutStorageKey, mainDefaultLayout),
    [mainDefaultLayout, mainLayoutStorageKey]
  );
  const historyLayoutStorageKey = `vibego.git.layout.${groupId}.history`;
  const historyFilesId = `desktop-git-history-files-${groupId}`;
  const historyDiffId = `desktop-git-history-diff-${groupId}`;
  const historyDefaultLayout = useMemo<Layout>(
    () => ({ [historyFilesId]: 30, [historyDiffId]: 70 }),
    [historyDiffId, historyFilesId]
  );
  const historyInitialLayout = useMemo(
    () => readStoredLayout(historyLayoutStorageKey, historyDefaultLayout),
    [historyDefaultLayout, historyLayoutStorageKey]
  );

  const loadedCommitHashes = useMemo(() => new Set(commits.map((commit) => commit.hash)), [commits]);
  const effectiveSelectedCommitHashes = useMemo(() => {
    const source = selectedCommitHashes ?? internalSelectedCommitHashes;
    return source.filter((hash, index) => loadedCommitHashes.has(hash) && source.indexOf(hash) === index);
  }, [internalSelectedCommitHashes, loadedCommitHashes, selectedCommitHashes]);
  const selectedCommitHashSet = useMemo(() => new Set(effectiveSelectedCommitHashes), [effectiveSelectedCommitHashes]);
  const selectedHistoryCommits = useMemo(
    () => commits.filter((commit) => selectedCommitHashSet.has(commit.hash)),
    [commits, selectedCommitHashSet]
  );
  const selectedHistoryIsContiguous = useMemo(
    () => areHistoryCommitsContiguous(commits, selectedHistoryCommits),
    [commits, selectedHistoryCommits]
  );
  const selectedHistoryNewest = selectedHistoryCommits[0] ?? null;
  const selectedHistoryOldest = selectedHistoryCommits[selectedHistoryCommits.length - 1] ?? null;

  useEffect(() => {
    if (selectedCommitHashes !== undefined) return;
    setInternalSelectedCommitHashes((current) => {
      const next = current.filter((hash) => loadedCommitHashes.has(hash));
      return next.length === current.length ? current : next;
    });
  }, [loadedCommitHashes, selectedCommitHashes]);

  useEffect(() => {
    const source = selectedCommitHashes ?? internalSelectedCommitHashes;
    const currentAnchor = selectionAnchorRef.current;
    if (currentAnchor && source.includes(currentAnchor) && loadedCommitHashes.has(currentAnchor)) return;
    const first = source.find((hash) => loadedCommitHashes.has(hash));
    selectionAnchorRef.current = first ?? null;
  }, [internalSelectedCommitHashes, loadedCommitHashes, selectedCommitHashes]);

  useEffect(() => {
    const requestId = rangeFilesRequestRef.current + 1;
    rangeFilesRequestRef.current = requestId;
    setSelectedHistoryFile(null);
    setSelectedHistoryDiff(null);
    setSelectedHistoryDiffLoading(false);
    setSelectedHistoryDiffError(null);
    setSelectedRangeError(null);
    if (
      activeTab !== "history" ||
      selectedHistoryCommits.length <= 1 ||
      !selectedHistoryIsContiguous ||
      !selectedHistoryNewest ||
      !selectedHistoryOldest
    ) {
      setSelectedRangeFiles([]);
      setSelectedRangeLoading(false);
      return;
    }
    setSelectedRangeFiles([]);
    setSelectedRangeLoading(true);
    void gitApi
      .commitFiles(path, selectedHistoryNewest.hash, selectedHistoryOldest.hash)
      .then((response) => {
        if (rangeFilesRequestRef.current === requestId) setSelectedRangeFiles(response.files);
      })
      .catch((requestError: unknown) => {
        if (rangeFilesRequestRef.current !== requestId) return;
        setSelectedRangeFiles([]);
        setSelectedRangeError(requestError instanceof Error ? requestError.message : t("git.operationFailed"));
      })
      .finally(() => {
        if (rangeFilesRequestRef.current === requestId) setSelectedRangeLoading(false);
      });
  }, [
    activeTab,
    path,
    selectedHistoryCommits.length,
    selectedHistoryIsContiguous,
    selectedHistoryNewest,
    selectedHistoryOldest,
    t,
  ]);

  const commitsForHashes = useCallback(
    (hashes: readonly string[]): GitCommit[] => {
      const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
      return hashes.map((hash) => byHash.get(hash)).filter((commit): commit is GitCommit => Boolean(commit));
    },
    [commits]
  );

  const emitCommitSelection = useCallback(
    (hashes: readonly string[]) => {
      const next = Array.from(new Set(hashes)).filter((hash) => loadedCommitHashes.has(hash));
      if (selectedCommitHashes === undefined) setInternalSelectedCommitHashes(next);
      onSelectedCommitHashesChange?.(next);
      return next;
    },
    [loadedCommitHashes, onSelectedCommitHashesChange, selectedCommitHashes]
  );

  type CommitSelectionEvent = Pick<React.MouseEvent<HTMLButtonElement>, "shiftKey" | "metaKey" | "ctrlKey">;

  const selectHistoryRow = useCallback(
    (commit: GitCommit, event: CommitSelectionEvent) => {
      const index = commits.findIndex((candidate) => candidate.hash === commit.hash);
      if (index < 0) return { hashes: effectiveSelectedCommitHashes, modified: false };

      const multiKey = event.metaKey || event.ctrlKey;
      const current = effectiveSelectedCommitHashes;
      let next: string[];
      if (event.shiftKey && current.length > 0) {
        const anchorHash = selectionAnchorRef.current ?? current[0];
        const anchorIndex = commits.findIndex((candidate) => candidate.hash === anchorHash);
        if (anchorIndex >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          next = commits.slice(start, end + 1).map((candidate) => candidate.hash);
        } else {
          next = [commit.hash];
        }
      } else if (multiKey) {
        next = current.includes(commit.hash)
          ? current.filter((hash) => hash !== commit.hash)
          : [...current, commit.hash];
      } else {
        next = [commit.hash];
      }

      if (event.shiftKey) {
        if (!selectionAnchorRef.current || !loadedCommitHashes.has(selectionAnchorRef.current)) {
          selectionAnchorRef.current = commit.hash;
        }
      } else if (multiKey) {
        if (current.length === 0) {
          selectionAnchorRef.current = commit.hash;
        } else if (current.includes(commit.hash) && selectionAnchorRef.current === commit.hash) {
          selectionAnchorRef.current = next[0] ?? null;
        }
      } else {
        selectionAnchorRef.current = commit.hash;
      }

      return { hashes: emitCommitSelection(next), modified: Boolean(event.shiftKey || multiKey) };
    },
    [commits, effectiveSelectedCommitHashes, emitCommitSelection, loadedCommitHashes]
  );

  const handleHistoryRowContextMenu = useCallback(
    (commit: GitCommit) => {
      const isSelected = selectedCommitHashSet.has(commit.hash);
      const next = isSelected ? effectiveSelectedCommitHashes : emitCommitSelection([commit.hash]);
      if (!isSelected) {
        selectionAnchorRef.current = commit.hash;
        onStashSelect(null);
        historyDiffRequestRef.current += 1;
        setSelectedHistoryFile(null);
        setSelectedHistoryDiff(null);
        setSelectedHistoryDiffLoading(false);
        setSelectedHistoryDiffError(null);
        void onCommitSelect(commit);
      }
      contextSelectionHashesRef.current = next;
      setContextSelectionHashes(next);
    },
    [effectiveSelectedCommitHashes, emitCommitSelection, onCommitSelect, onStashSelect, selectedCommitHashSet]
  );

  const menuCommits = useCallback(
    (fallback: GitCommit): GitCommit[] => {
      const hashes =
        contextSelectionHashesRef.current.length > 0
          ? contextSelectionHashesRef.current
          : contextSelectionHashes.length > 0
            ? contextSelectionHashes
            : [fallback.hash];
      const selected = commitsForHashes(hashes);
      return selected.length > 0 ? selected : [fallback];
    },
    [commitsForHashes, contextSelectionHashes]
  );

  const copyCommitHash = useCallback((hash: string) => {
    void copyText(hash).catch(() => undefined);
  }, []);

  const filteredFiles = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return allFiles;
    return allFiles.filter(
      (file) => file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query)
    );
  }, [allFiles, filterText]);

  const groupedFiles = useMemo(() => {
    const groups = new Map<GitFileNode["status"], GitFileNode[]>();
    for (const file of filteredFiles) {
      const group = groups.get(file.status) || [];
      group.push(file);
      groups.set(file.status, group);
    }
    return [...groups.entries()];
  }, [filteredFiles]);

  const selectedCount = useMemo(() => allFiles.filter((file) => file.includedState !== "none").length, [allFiles]);
  const allSelection = useMemo(() => aggregateSelection(allFiles), [allFiles]);
  const activeFile = useMemo(
    () => allFiles.find((file) => file.path === selectedFilePath) || null,
    [allFiles, selectedFilePath]
  );
  const selectedStash = useMemo(
    () => stashes.find((stash) => stash.index === selectedStashIndex) || null,
    [selectedStashIndex, stashes]
  );
  const selectedCommitTags = selectedCommit?.tags ?? [];
  const operationInProgress = operation?.state === "in_progress" || operation?.state === "conflicts";

  useEffect(() => {
    if (!operationInProgress || !operation) return;
    if (
      operation.operation === "merge" ||
      operation.operation === "rebase" ||
      operation.operation === "cherry-pick" ||
      operation.operation === "revert"
    ) {
      setOperationPanelOpen(true);
    }
  }, [operation, operationInProgress]);

  useEffect(() => {
    if (selectedFilePath && !allFiles.some((file) => file.path === selectedFilePath)) {
      setSelectedFilePath(null);
      setSelectedFileDiff(null);
    }
  }, [allFiles, selectedFilePath]);

  useEffect(() => {
    if (activeTab !== "history") {
      historyDiffRequestRef.current += 1;
      setSelectedHistoryFile(null);
      setSelectedHistoryDiff(null);
      setSelectedHistoryDiffLoading(false);
      setSelectedHistoryDiffError(null);
      return;
    }
    if (!selectedCommit && commits[0]) {
      void onCommitSelect(commits[0]);
    }
  }, [activeTab, commits, onCommitSelect, selectedCommit]);

  const selectFile = useCallback(
    async (file: GitFileNode) => {
      onStashSelect(null);
      setSelectedFilePath(file.path);
      setSelectedHistoryFile(null);
      setSelectedHistoryDiff(null);
      setSelectedHistoryDiffLoading(false);
      setSelectedHistoryDiffError(null);
      setSelectedFileDiff(null);
      const requestId = fileDiffRequestRef.current + 1;
      fileDiffRequestRef.current = requestId;
      const diff = await getDiff(file.path);
      if (fileDiffRequestRef.current === requestId) {
        setSelectedFileDiff(diff);
      }
    },
    [getDiff, onStashSelect]
  );

  const selectCommit = useCallback(
    async (commit: GitCommit) => {
      onStashSelect(null);
      historyDiffRequestRef.current += 1;
      setSelectedHistoryFile(null);
      setSelectedHistoryDiff(null);
      setSelectedHistoryDiffLoading(false);
      setSelectedHistoryDiffError(null);
      await onCommitSelect(commit);
    },
    [onCommitSelect, onStashSelect]
  );

  const handleHistoryRowClick = useCallback(
    (commit: GitCommit, event: CommitSelectionEvent) => {
      const { hashes, modified } = selectHistoryRow(commit, event);
      if (!modified) {
        void selectCommit(commit);
        return;
      }
      if (hashes.length === 1) {
        const remaining = commits.find((candidate) => candidate.hash === hashes[0]);
        if (remaining) void selectCommit(remaining);
      }
    },
    [commits, selectCommit, selectHistoryRow]
  );

  const selectHistoryFile = useCallback(
    async (commit: GitCommit, filePath: string) => {
      const requestId = historyDiffRequestRef.current + 1;
      historyDiffRequestRef.current = requestId;
      setSelectedHistoryFile(filePath);
      setSelectedHistoryDiff(null);
      setSelectedHistoryDiffLoading(true);
      setSelectedHistoryDiffError(null);
      try {
        const diff =
          selectedHistoryCommits.length > 1 &&
          selectedHistoryIsContiguous &&
          selectedHistoryNewest &&
          selectedHistoryOldest
            ? await gitApi.commitDiff(path, selectedHistoryNewest.hash, filePath, selectedHistoryOldest.hash)
            : await onHistoryFileClick(commit, filePath);
        if (historyDiffRequestRef.current === requestId) {
          setSelectedHistoryDiff(diff);
        }
      } catch (requestError: unknown) {
        if (historyDiffRequestRef.current === requestId) {
          setSelectedHistoryDiffError(requestError instanceof Error ? requestError.message : t("git.operationFailed"));
        }
      } finally {
        if (historyDiffRequestRef.current === requestId) {
          setSelectedHistoryDiffLoading(false);
        }
      }
    },
    [
      onHistoryFileClick,
      path,
      selectedHistoryCommits.length,
      selectedHistoryIsContiguous,
      selectedHistoryNewest,
      selectedHistoryOldest,
      t,
    ]
  );

  const invokeCherryPick = useCallback(
    async (selected: GitCommit[]) => {
      if (selected.length === 0) return;
      if (onCherryPickCommits) return onCherryPickCommits(selected);
      if (selected.length === 1 && onCherryPickCommit) return onCherryPickCommit(selected[0]);
      for (const commit of selected) {
        if (onCherryPick) {
          const result = await onCherryPick(commit.hash);
          if (result === false) return result;
        }
      }
    },
    [onCherryPick, onCherryPickCommit, onCherryPickCommits]
  );

  const invokeRevert = useCallback(
    async (commit: GitCommit) => {
      if (onRevertCommit) return onRevertCommit(commit);
      if (onRevertCommits) return onRevertCommits([commit]);
      return onRevert(commit.hash);
    },
    [onRevert, onRevertCommit, onRevertCommits]
  );

  const invokeReset = useCallback(
    async (commit: GitCommit) => {
      if (onResetCommit) return onResetCommit(commit);
      if (onResetCommits) return onResetCommits([commit]);
      return onResetToCommit(commit.hash, "mixed");
    },
    [onResetCommit, onResetCommits, onResetToCommit]
  );

  const invokeSquash = useCallback(
    async (selected: GitCommit[], squashOnto: GitCommit) => {
      if (onSquashCommits) return onSquashCommits(selected, squashOnto);
      return onSquash(squashOnto);
    },
    [onSquash, onSquashCommits]
  );

  const invokeReorder = useCallback(
    async (selected: GitCommit[], beforeCommit: GitCommit) => {
      if (onReorderCommits) return onReorderCommits(selected, beforeCommit);
      return onReorder(beforeCommit);
    },
    [onReorder, onReorderCommits]
  );

  const deletableTag = selectedCommitTags.find((tag) => tagsToPush.includes(tag));

  const renderChangesList = () => (
    <>
      {conflicts.length > 0 && (
        <div className="desktop-git-conflicts">
          <div className="desktop-git-file-group-heading">
            <Circle size={8} fill="currentColor" />
            <span>
              {conflicts.length} {t("git.conflicts")}
            </span>
          </div>
          {conflicts.map((conflictPath) => (
            <button
              type="button"
              className="desktop-git-conflict-row"
              key={conflictPath}
              onClick={() => onConflictClick(conflictPath)}
            >
              <Circle size={10} fill="currentColor" />
              <span className="desktop-git-file-copy">
                <span className="desktop-git-file-name">{conflictPath.split("/").pop() || conflictPath}</span>
                <span className="desktop-git-file-path">{conflictPath}</span>
              </span>
              <span>{t("git.resolve")}</span>
            </button>
          ))}
        </div>
      )}

      <div className="desktop-git-search">
        <Search size={13} />
        <input
          id="desktop-git-file-search"
          name="desktop-git-file-search"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder={t("git.searchFiles")}
          aria-label={t("git.searchFiles")}
        />
        {filterText && (
          <button
            type="button"
            className="desktop-git-file-action"
            onClick={() => setFilterText("")}
            aria-label={t("git.clearSelection")}
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="desktop-git-file-group-heading">
        <button
          type="button"
          onClick={() => void onToggleAll()}
          aria-label={t("git.selectAll")}
          className="text-ide-accent"
        >
          {selectionIcon(allSelection, 14)}
        </button>
        <span>{t("git.selectAll")}</span>
        <span className="desktop-git-panel-meta">
          {selectedCount}/{allFiles.length}
        </span>
      </div>

      {groupedFiles.length === 0 ? (
        <div className="desktop-git-empty">
          <Check size={18} className="text-green-500/70" />
          <span>{t("git.noChanges")}</span>
        </div>
      ) : (
        groupedFiles.map(([status, files]) => (
          <section key={status}>
            <div className="desktop-git-file-group-heading">
              <span className={statusClass(status)}>{statusMeta[status].label}</span>
              <span>{t(`git.status${statusMeta[status].key[0].toUpperCase()}${statusMeta[status].key.slice(1)}`)}</span>
              <span className="desktop-git-panel-meta">{files.length}</span>
            </div>
            {files.map((file) => {
              const selection = fileSelection(file);
              const isSelected = selectedFilePath === file.path && activeTab === "changes";
              return (
                <div
                  className={`desktop-git-file-row ${isSelected ? "desktop-git-file-row--selected" : ""} ${selection !== "none" ? "desktop-git-file-row--included" : ""}`}
                  key={file.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => void selectFile(file)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void selectFile(file);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={`desktop-git-file-check ${selection !== "none" ? "text-ide-accent" : "text-ide-mute"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onToggleFile(file.path);
                    }}
                    aria-label={selection === "none" ? t("git.add") : t("git.reset")}
                  >
                    {selectionIcon(selection, 14)}
                  </button>
                  <span className={statusClass(file.status)}>{statusMeta[file.status].label}</span>
                  <span className="desktop-git-file-copy">
                    <span className="desktop-git-file-name">
                      {file.name}
                      {file.submodule && <span className="desktop-git-file-submodule">{t("git.submodule")}</span>}
                    </span>
                    <span className="desktop-git-file-path">{file.path}</span>
                  </span>
                  <button
                    type="button"
                    className="desktop-git-file-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDiscardFile(file.path);
                    }}
                    aria-label={t("git.discard")}
                    title={t("git.discard")}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </section>
        ))
      )}
    </>
  );

  const clearHistorySelection = useCallback(() => {
    selectionAnchorRef.current = null;
    contextSelectionHashesRef.current = [];
    setContextSelectionHashes([]);
    emitCommitSelection([]);
  }, [emitCommitSelection]);

  const renderHistoryList = () => {
    const selectedCount = selectedHistoryCommits.length;
    const squashTarget = selectedHistoryCommits[selectedHistoryCommits.length - 1];

    return (
      <>
        {selectedCount > 0 && (
          <div className="desktop-git-history-selection-bar" role="toolbar" aria-label={t("common.selected")}>
            <span className="desktop-git-history-selection-count">
              {selectedCount} {t("common.selected")}
            </span>
            <div className="desktop-git-history-selection-actions">
              <button
                type="button"
                className="desktop-git-action-button"
                onClick={() => void invokeCherryPick(selectedHistoryCommits)}
                disabled={isLoading || selectedCount === 0}
                title={t("git.cherryPick")}
              >
                <GitCommitIcon size={12} />
                <span>{t("git.cherryPick")}</span>
              </button>
              {selectedCount > 1 && (
                <>
                  <button
                    type="button"
                    className="desktop-git-action-button"
                    onClick={() => void invokeSquash(selectedHistoryCommits, squashTarget)}
                    disabled={isLoading || !selectedHistoryIsContiguous}
                    title={t("git.squash")}
                  >
                    <GitMerge size={12} />
                    <span>{t("git.squash")}</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="desktop-git-file-action desktop-git-history-clear-button"
                onClick={clearHistorySelection}
                aria-label={t("git.clearSelection")}
                title={t("git.clearSelection")}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        )}
        {commits.length === 0 ? (
          <div className="desktop-git-empty">
            <History size={18} />
            <span>{t("git.noCommits")}</span>
          </div>
        ) : (
          commits.map((commit, index) => {
            const isDetailSelected = selectedHistoryCommits.length <= 1 && selectedCommit?.hash === commit.hash;
            const isMultiSelected = selectedCommitHashSet.has(commit.hash);
            return (
              <ContextMenu key={commit.hash}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className={`desktop-git-commit-row ${isDetailSelected ? "desktop-git-commit-row--selected" : ""} ${isMultiSelected ? "desktop-git-commit-row--multi-selected" : ""}`}
                    data-commit-hash={commit.hash}
                    data-selected={isMultiSelected ? "true" : "false"}
                    aria-pressed={isMultiSelected}
                    onClick={(event) => handleHistoryRowClick(commit, event)}
                    onContextMenu={() => handleHistoryRowContextMenu(commit)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      handleHistoryRowClick(commit, event);
                    }}
                  >
                    <span className="desktop-git-commit-selection" aria-hidden="true">
                      {selectionIcon(isMultiSelected ? "all" : "none", 13)}
                    </span>
                    <span className="desktop-git-commit-icon">
                      {index === 0 ? <GitCommitIcon size={14} /> : <Circle size={11} />}
                    </span>
                    <span className="desktop-git-commit-copy">
                      <span className="desktop-git-commit-message">{firstLine(commit.message)}</span>
                      <span className="desktop-git-commit-meta">
                        {commit.author} · {formatDate(commit.date, locale)}
                      </span>
                      <span className="desktop-git-commit-hash">
                        {commit.hash.slice(0, 8)}
                        {(commit.tags ?? []).length > 0 ? ` · ${(commit.tags ?? []).join(", ")}` : ""}
                      </span>
                    </span>
                    {index < aheadCount && <ArrowUp size={12} className="text-blue-400" />}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-48">
                  {(() => {
                    const menuSelection = menuCommits(commit);
                    const multi = menuSelection.length > 1;
                    return (
                      <>
                        <ContextMenuItem disabled={isLoading} onSelect={() => void invokeCherryPick(menuSelection)}>
                          <GitCommitIcon size={13} />
                          {t("git.cherryPick")}
                          {multi ? ` (${menuSelection.length})` : ""}
                        </ContextMenuItem>
                        {multi ? (
                          <>
                            <ContextMenuItem
                              disabled={
                                isLoading || !onSquashCommits || !areHistoryCommitsContiguous(commits, menuSelection)
                              }
                              onSelect={() => void invokeSquash(menuSelection, commit)}
                            >
                              <GitMerge size={13} />
                              {t("git.squash")} ({menuSelection.length})
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={isLoading || !onReorderCommits}
                              onSelect={() => void invokeReorder(menuSelection, commit)}
                            >
                              <ArrowUpDown size={13} />
                              {t("git.reorder")} ({menuSelection.length})
                            </ContextMenuItem>
                          </>
                        ) : (
                          <>
                            <ContextMenuItem disabled={isLoading} onSelect={() => void invokeRevert(menuSelection[0])}>
                              <RotateCcw size={13} />
                              {t("git.revert")}
                            </ContextMenuItem>
                            <ContextMenuItem disabled={isLoading} onSelect={() => void invokeReset(menuSelection[0])}>
                              <Undo2 size={13} />
                              {t("git.resetToCommit")}
                            </ContextMenuItem>
                          </>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => copyCommitHash(commit.hash)}>
                          <Copy size={13} />
                          {t("common.copy")} SHA
                        </ContextMenuItem>
                        {selectedCount > 0 && (
                          <ContextMenuItem onSelect={clearHistorySelection}>
                            <X size={13} />
                            {t("git.clearSelection")}
                          </ContextMenuItem>
                        )}
                      </>
                    );
                  })()}
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
        {commits.length > 0 && (
          <button
            type="button"
            className="desktop-git-action-button m-2 w-[calc(100%-1rem)]"
            onClick={onLoadMore}
            disabled={isLoading}
          >
            {isLoading ? <RefreshCw size={12} className="animate-spin" /> : <ChevronDown size={12} />}
            {t("git.commitsCount").replace("{count}", "...")}
          </button>
        )}
      </>
    );
  };

  const renderChangeDetail = () => {
    if (!selectedFilePath) {
      return (
        <div className="desktop-git-empty h-full">
          <FileDiff size={24} />
          <span>{t("git.selectFile")}</span>
        </div>
      );
    }
    return (
      <DiffView
        key={selectedFilePath}
        groupId={groupId}
        original={selectedFileDiff?.old || ""}
        modified={selectedFileDiff?.new || ""}
        filename={activeFile?.name}
        filePath={selectedFilePath}
        repoPath={path}
        metadata={selectedFileDiff || undefined}
        allowSelection={Boolean(
          activeFile && !activeFile.submodule && ["modified", "added", "untracked"].includes(activeFile.status)
        )}
        submodule={activeFile?.submodule}
      />
    );
  };

  const historySelection =
    selectedHistoryCommits.length > 0 ? selectedHistoryCommits : selectedCommit ? [selectedCommit] : [];
  const historyPrimaryCommit = historySelection[0] ?? null;
  const singleHistoryDetailsMatch = Boolean(
    historyPrimaryCommit && selectedCommit && historyPrimaryCommit.hash === selectedCommit.hash
  );
  const historyFiles =
    selectedHistoryCommits.length > 1 ? selectedRangeFiles : singleHistoryDetailsMatch ? selectedCommitFiles : [];

  const renderHistorySummary = () => {
    if (!historyPrimaryCommit) {
      return (
        <div className="desktop-git-empty desktop-git-history-summary-empty">
          <History size={24} />
          <span>{t("git.noCommits")}</span>
        </div>
      );
    }

    if (selectedHistoryCommits.length > 1) {
      return (
        <div className="desktop-git-history-header desktop-git-history-header--multiple">
          <div className="desktop-git-history-title-row">
            <History size={15} />
            <h2 className="desktop-git-history-title">
              {selectedHistoryCommits.length} {t("common.selected")}
            </h2>
          </div>
          <div className="desktop-git-history-meta">
            <span>{formatDate(selectedHistoryOldest?.date || "", locale)}</span>
            <span>→</span>
            <span>{formatDate(selectedHistoryNewest?.date || "", locale)}</span>
            <span className="desktop-git-history-hash">
              {selectedHistoryOldest?.hash.slice(0, 8)}..{selectedHistoryNewest?.hash.slice(0, 8)}
            </span>
          </div>
          {!selectedHistoryIsContiguous && (
            <div className="desktop-git-history-selection-note">{t("git.nonContiguousSelection")}</div>
          )}
          <div className="desktop-git-history-selected-commits">
            {selectedHistoryCommits.map((commit) => (
              <div className="desktop-git-history-selected-commit" key={commit.hash}>
                <span className="desktop-git-history-hash">{commit.hash.slice(0, 8)}</span>
                <span>{firstLine(commit.message)}</span>
              </div>
            ))}
          </div>
          <div className="desktop-git-history-actions">
            <button
              type="button"
              className="desktop-git-action-button"
              onClick={() => void invokeCherryPick(selectedHistoryCommits)}
              disabled={isLoading}
            >
              <GitCommitIcon size={12} />
              {t("git.cherryPick")}
            </button>
            <button
              type="button"
              className="desktop-git-action-button"
              onClick={() => void invokeSquash(selectedHistoryCommits, selectedHistoryOldest!)}
              disabled={isLoading || !selectedHistoryOldest || !selectedHistoryIsContiguous}
            >
              <GitMerge size={12} />
              {t("git.squash")}
            </button>
          </div>
        </div>
      );
    }

    const description = historyPrimaryCommit.message.split("\n").slice(1).join("\n").trim();
    return (
      <div className="desktop-git-history-header">
        <h2 className="desktop-git-history-title">{firstLine(historyPrimaryCommit.message)}</h2>
        {description && <div className="desktop-git-history-description">{description}</div>}
        <div className="desktop-git-history-meta">
          <span>{historyPrimaryCommit.author}</span>
          <span>{formatDate(historyPrimaryCommit.date, locale)}</span>
          <span className="desktop-git-history-hash">{historyPrimaryCommit.hash}</span>
        </div>
        {(historyPrimaryCommit.tags ?? []).length > 0 && (
          <div className="desktop-git-history-meta">
            <Tag size={12} />
            {(historyPrimaryCommit.tags ?? []).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        <div className="desktop-git-history-actions">
          <button
            type="button"
            className="desktop-git-action-button"
            onClick={() => onCreateTag(historyPrimaryCommit)}
            disabled={isLoading}
          >
            <Tag size={12} />
            {t("git.createTag")}
          </button>
          {commits[0]?.hash === historyPrimaryCommit.hash && historyPrimaryCommit.parentCount > 0 && (
            <button
              type="button"
              className="desktop-git-action-button desktop-git-action-button--danger"
              onClick={() => onUndoCommit(historyPrimaryCommit)}
              disabled={isLoading}
            >
              <Undo2 size={12} />
              {t("git.undoCommit")}
            </button>
          )}
          {deletableTag && (
            <button
              type="button"
              className="desktop-git-action-button"
              onClick={() => onDeleteTag(deletableTag)}
              disabled={isLoading}
            >
              <Trash2 size={12} />
              {t("git.deleteTag")}
            </button>
          )}
          <button
            type="button"
            className="desktop-git-action-button"
            onClick={() => void invokeRevert(historyPrimaryCommit)}
            disabled={isLoading || operationInProgress}
          >
            <RotateCcw size={12} />
            {t("git.revert")}
          </button>
          <button
            type="button"
            className="desktop-git-action-button desktop-git-action-button--danger"
            onClick={() => void invokeReset(historyPrimaryCommit)}
            disabled={isLoading || operationInProgress}
          >
            <Undo2 size={12} />
            {t("git.resetToCommit")}
          </button>
        </div>
      </div>
    );
  };

  const renderHistoryFiles = () => (
    <div className="desktop-git-history-file-panel">
      <div className="desktop-git-history-files-heading">
        <span>{t("git.filesChanged")}</span>
        <span>{selectedHistoryIsContiguous ? historyFiles.length : 0}</span>
      </div>
      {!selectedHistoryIsContiguous ? (
        <div className="desktop-git-empty desktop-git-history-file-empty">{t("git.nonContiguousSelection")}</div>
      ) : selectedRangeError ? (
        <div className="desktop-git-empty desktop-git-history-file-empty text-red-400">{selectedRangeError}</div>
      ) : selectedRangeLoading ||
        (selectedHistoryCommits.length <= 1 &&
          (!singleHistoryDetailsMatch || isLoading) &&
          historyFiles.length === 0) ? (
        <div className="desktop-git-empty desktop-git-history-file-empty">
          <RefreshCw size={14} className="animate-spin" />
          {t("git.loading")}
        </div>
      ) : historyFiles.length === 0 ? (
        <div className="desktop-git-empty desktop-git-history-file-empty">{t("git.noChanges")}</div>
      ) : (
        historyFiles.map((file) => (
          <button
            type="button"
            className={`desktop-git-history-file ${selectedHistoryFile === file.path ? "desktop-git-history-file--selected" : ""}`}
            key={file.path}
            aria-pressed={selectedHistoryFile === file.path}
            onClick={() => historyPrimaryCommit && void selectHistoryFile(historyPrimaryCommit, file.path)}
          >
            <span className={`desktop-git-history-file-status ${statusClass(normalizeStatus(file.status))}`}>
              {file.status.slice(0, 1).toUpperCase()}
            </span>
            <span className="desktop-git-history-file-path">{file.path}</span>
            {selectedHistoryFile === file.path && <ChevronRight size={12} />}
          </button>
        ))
      )}
    </div>
  );

  const renderHistoryDiff = () => {
    if (!selectedHistoryFile) {
      return (
        <div className="desktop-git-empty h-full">
          <FileDiff size={22} />
          <span>{t("git.selectFile")}</span>
        </div>
      );
    }
    if (selectedHistoryDiffError) {
      return <div className="desktop-git-empty h-full text-red-400">{selectedHistoryDiffError}</div>;
    }
    if (selectedHistoryDiffLoading) {
      return (
        <div className="desktop-git-empty h-full">
          <RefreshCw size={14} className="animate-spin" />
          <span>{t("git.loading")}</span>
        </div>
      );
    }
    if (!selectedHistoryDiff) {
      return <div className="desktop-git-empty h-full">{t("git.noDiff")}</div>;
    }
    return (
      <DiffView
        key={`history-${selectedHistoryFile}-${selectedHistoryOldest?.hash || historyPrimaryCommit?.hash || ""}`}
        groupId={groupId}
        original={selectedHistoryDiff.old}
        modified={selectedHistoryDiff.new}
        filename={selectedHistoryFile.split("/").pop() || selectedHistoryFile}
        filePath={selectedHistoryFile}
        repoPath={path}
        metadata={selectedHistoryDiff}
      />
    );
  };

  const renderHistoryWorkspace = () => (
    <div className="desktop-git-history-workspace">
      {renderHistorySummary()}
      {historyPrimaryCommit && (
        <ResizablePanelGroup
          orientation="horizontal"
          className="desktop-git-history-split"
          id={`desktop-git-history-detail-${groupId}`}
          groupRef={historyGroupRef}
          defaultLayout={historyInitialLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) storeLayout(historyLayoutStorageKey, layout);
          }}
          resizeTargetMinimumSize={{ coarse: 28, fine: 18 }}
        >
          <ResizablePanel id={historyFilesId} defaultSize="30%" minSize="180px" maxSize="48%">
            {renderHistoryFiles()}
          </ResizablePanel>
          <ResizableHandle
            className="desktop-git-resize-handle"
            withHandle
            onDoubleClick={() => {
              historyGroupRef.current?.setLayout(historyDefaultLayout);
              storeLayout(historyLayoutStorageKey, historyDefaultLayout);
            }}
          />
          <ResizablePanel id={historyDiffId} defaultSize="70%" minSize="260px">
            <div className="desktop-git-history-diff-panel">{renderHistoryDiff()}</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );

  const renderChangesWorkspace = () => {
    if (selectedStash) {
      return (
        <GitStashDetail
          groupId={groupId}
          path={path}
          locale={locale}
          stash={selectedStash}
          files={stashFiles}
          selectedFile={selectedStashFile}
          diff={stashDiff}
          loading={stashLoading}
          disabled={isLoading}
          onClose={() => onStashSelect(null)}
          onFileSelect={onStashFileSelect}
          onPop={onStashPop}
          onDrop={onStashDrop}
        />
      );
    }
    return renderChangeDetail();
  };

  const renderChangesUtilities = () => (
    <>
      <section className="desktop-git-stash-panel">
        <button
          type="button"
          className="desktop-git-sidebar-section-heading"
          onClick={() => setStashPanelOpen((open) => !open)}
          aria-expanded={stashPanelOpen}
        >
          <Archive size={13} />
          <span>{t("git.stashes")}</span>
          <span className="desktop-git-panel-meta">{stashes.length}</span>
          {stashPanelOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {stashPanelOpen && (
          <div className="desktop-git-stash-list">
            <button
              type="button"
              className="desktop-git-action-button mb-1 w-full"
              onClick={() => onStash()}
              disabled={isLoading}
            >
              <Archive size={12} />
              {t("git.stashAll")}
            </button>
            {stashes.slice(0, 5).map((stash) => (
              <div
                className={`desktop-git-stash-row ${selectedStashIndex === stash.index ? "desktop-git-stash-row--selected" : ""}`}
                key={stash.index}
                role="button"
                tabIndex={0}
                onClick={() => onStashSelect(stash.index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onStashSelect(stash.index);
                  }
                }}
              >
                <span className="desktop-git-stash-message" title={stash.message}>
                  {stash.message}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStashPop(stash.index, stash.oid);
                  }}
                  disabled={isLoading}
                >
                  {t("git.pop")}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStashDrop(stash.index, stash.oid);
                  }}
                  disabled={isLoading}
                >
                  {t("git.drop")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="desktop-git-operation-panel">
        <button
          type="button"
          className="desktop-git-sidebar-section-heading"
          onClick={() => setOperationPanelOpen((open) => !open)}
          aria-expanded={operationPanelOpen}
        >
          <GitMerge size={13} />
          <span>{t("git.advancedOperations")}</span>
          {operationPanelOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {operationPanelOpen && (
          <GitOperationControls
            locale={locale}
            selectedCommitHash={selectedCommit?.hash}
            currentBranch={currentBranch}
            aheadCount={aheadCount}
            isLoading={isLoading}
            operation={operation}
            onMerge={onMerge}
            onRebase={onRebase}
            onCherryPick={onCherryPick}
            onRevert={onRevert}
            onResetToCommit={onResetToCommit}
            onPush={onPush}
            onOperationAction={onOperationAction}
          />
        )}
      </section>
    </>
  );

  return (
    <div className="desktop-git-workspace">
      {error && <div className="desktop-git-error">{error}</div>}

      <ResizablePanelGroup
        orientation="horizontal"
        className="desktop-git-main"
        id={`desktop-git-main-${groupId}`}
        groupRef={mainGroupRef}
        defaultLayout={mainInitialLayout}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) storeLayout(mainLayoutStorageKey, layout);
        }}
        resizeTargetMinimumSize={{ coarse: 28, fine: 18 }}
      >
        <ResizablePanel
          id={mainSidebarId}
          defaultSize="28%"
          minSize="190px"
          maxSize="45%"
          className="desktop-git-sidebar"
        >
          <div className="desktop-git-sidebar-tabs" role="tablist" aria-label={t("sidebar.git")}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "changes"}
              onClick={() => onActiveTabChange("changes")}
            >
              <FileDiff size={13} />
              <span>{t("git.changes")}</span>
              {allFiles.length > 0 && <span className="desktop-git-sidebar-tab-count">{allFiles.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "history"}
              onClick={() => onActiveTabChange("history")}
            >
              <History size={13} />
              <span>{t("git.history")}</span>
            </button>
          </div>

          <div className="desktop-git-sidebar-list">
            {activeTab === "changes" ? (
              <>
                {renderChangesList()}
                {renderChangesUtilities()}
              </>
            ) : (
              renderHistoryList()
            )}
          </div>

          {activeTab === "changes" && (
            <div className="desktop-git-sidebar-footer">
              <GitCommitComposer
                groupId={groupId}
                locale={locale}
                autoSummary={
                  allFiles.filter((file) => file.includedState !== "none").length === 1
                    ? `Update ${allFiles.find((file) => file.includedState !== "none")?.name || "file"}`
                    : ""
                }
                checkedCount={selectedCount}
                currentBranch={currentBranch}
                hasConflicts={conflicts.length > 0}
                isLoading={isLoading}
                onUndoLastCommit={onUndoLastCommit}
              />
            </div>
          )}
        </ResizablePanel>

        <ResizableHandle
          className="desktop-git-resize-handle"
          withHandle
          onDoubleClick={() => {
            mainGroupRef.current?.setLayout(mainDefaultLayout);
            storeLayout(mainLayoutStorageKey, mainDefaultLayout);
          }}
        />

        <ResizablePanel id={mainContentId} defaultSize="72%" minSize="280px" className="desktop-git-content">
          {activeTab === "changes" ? renderChangesWorkspace() : renderHistoryWorkspace()}
        </ResizablePanel>
      </ResizablePanelGroup>
      {githubPanelOpen && (
        <GithubPanel
          path={path}
          locale={locale}
          remoteUrls={remoteUrls}
          currentBranch={currentBranch}
          headHash={commits[0]?.hash}
          onClose={() => onGithubPanelOpenChange(false)}
          onChanged={onRefresh}
        />
      )}
      {repositorySettingsOpen && (
        <GitRepositorySettings
          path={path}
          locale={locale}
          onClose={() => onRepositorySettingsOpenChange(false)}
          onChanged={onRefresh}
          onOpenWorktree={onOpenWorktree}
        />
      )}
    </div>
  );
};

export default DesktopGitWorkspace;
