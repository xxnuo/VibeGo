import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  GitCommit as GitCommitIcon,
  Loader2,
  Plus,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommitFileInfo, GitCommit } from "@/api/git";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getIntlLocale, getTranslation, type Locale } from "@/lib/i18n";

type AvatarPlatform = "github" | "gitlab" | "gravatar";

const detectPlatforms = (remoteUrls: string[]): AvatarPlatform[] => {
  const platforms: AvatarPlatform[] = [];
  const joined = remoteUrls.join(" ").toLowerCase();
  if (joined.includes("github.com")) platforms.push("github");
  if (joined.includes("gitlab.com") || joined.includes("gitlab")) platforms.push("gitlab");
  platforms.push("gravatar");
  return platforms;
};

const md5 = async (str: string): Promise<string> => {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
};

const platformAvatarUrl = async (platform: AvatarPlatform, email: string): Promise<string> => {
  switch (platform) {
    case "github":
      return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=64`;
    case "gitlab":
      return `https://gitlab.com/api/v4/avatar?email=${encodeURIComponent(email)}&size=64`;
    case "gravatar": {
      const hash = await md5(email.trim().toLowerCase());
      return `https://www.gravatar.com/avatar/${hash}?s=64&d=404`;
    }
  }
};

const tryFetchAvatar = async (url: string, platform: AvatarPlatform): Promise<string | null> => {
  try {
    if (platform === "gitlab") {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.avatar_url) return null;
      const imgRes = await fetch(json.avatar_url);
      if (!imgRes.ok) return null;
      const blob = await imgRes.blob();
      if (blob.size < 100) return null;
      return URL.createObjectURL(blob);
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 100) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
};

const avatarCache = new Map<string, string>();
const avatarLoading = new Map<string, Promise<string | null>>();

const fetchAndCacheAvatar = (email: string, platforms: AvatarPlatform[]): Promise<string | null> => {
  const cacheKey = email;
  const cached = avatarCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const inflight = avatarLoading.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    for (const platform of platforms) {
      const url = await platformAvatarUrl(platform, email);
      const result = await tryFetchAvatar(url, platform);
      if (result) {
        avatarCache.set(cacheKey, result);
        return result;
      }
    }
    return null;
  })().finally(() => avatarLoading.delete(cacheKey));

  avatarLoading.set(cacheKey, promise);
  return promise;
};

const useCachedAvatarUrl = (email: string, platforms: AvatarPlatform[]): string | undefined => {
  const trimmed = email.trim();
  const [url, setUrl] = useState<string | undefined>(() => avatarCache.get(trimmed));

  useEffect(() => {
    if (!trimmed) return;
    const cached = avatarCache.get(trimmed);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    fetchAndCacheAvatar(trimmed, platforms).then((result) => {
      if (!cancelled && result) setUrl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [trimmed, platforms]);

  return url;
};

export interface GitHistoryViewProps {
  commits: GitCommit[];
  isLoading: boolean;
  locale: Locale;
  remoteUrls: string[];
  aheadCount: number;
  tagsToPush: string[];
  tagsToPushError: string | null;
  onCommitSelect: (commit: GitCommit) => void;
  onUndoCommit: (commit: GitCommit) => void;
  onCreateTag: (commit: GitCommit) => void;
  onDeleteTag: (tag: string) => void;
  onFileClick: (commit: GitCommit, filePath: string) => void;
  selectedCommitFiles: CommitFileInfo[];
  selectedCommitHash: string | null;
  onLoadMore?: () => void;
  /** Optional controlled selection. Hashes which are not currently loaded are ignored. */
  selectedCommitHashes?: readonly string[];
  /** Called whenever the history multi-selection changes. */
  onSelectedCommitsChange?: (commits: GitCommit[]) => void;
  /** Optional hash callback for consumers which persist selection by id. */
  onSelectedCommitHashesChange?: (hashes: string[]) => void;
  /** Actions exposed by the history context menu. */
  onCherryPick?: (commits: GitCommit[]) => unknown;
  onCherryPickCommits?: (commits: GitCommit[]) => unknown;
  onRevert?: (commit: GitCommit) => unknown;
  onRevertCommit?: (commit: GitCommit) => unknown;
  onResetToCommit?: (commit: GitCommit) => unknown;
  onResetCommit?: (commit: GitCommit) => unknown;
  onSquash?: (commits: GitCommit[], squashOnto: GitCommit) => unknown;
  onSquashCommits?: (commits: GitCommit[], squashOnto: GitCommit) => unknown;
  onReorder?: (commits: GitCommit[], beforeCommit: GitCommit) => unknown;
  onReorderCommits?: (commits: GitCommit[], beforeCommit: GitCommit) => unknown;
}

const formatRelativeTime = (dateStr: string, locale: Locale, t: (key: string) => string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 30) return date.toLocaleDateString(getIntlLocale(locale));
  if (days > 0) return t("time.daysAgoShort").replace("{count}", String(days));
  if (hours > 0) return t("time.hoursAgoShort").replace("{count}", String(hours));
  if (minutes > 0) return t("time.minutesAgoShort").replace("{count}", String(minutes));
  return t("time.now");
};

const getStatusColor = (status: string) => {
  switch (status) {
    case "M":
    case "modified":
      return "text-yellow-500";
    case "A":
    case "added":
      return "text-green-500";
    case "D":
    case "deleted":
      return "text-red-500";
    default:
      return "text-ide-mute";
  }
};

const getInitials = (name: string) => {
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const hashColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const colors = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500", "bg-pink-500", "bg-teal-500"];
  return colors[Math.abs(h) % colors.length];
};

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

const CopyHashButton: React.FC<{ hash: string; locale: Locale }> = ({ hash, locale }) => {
  const [copied, setCopied] = useState(false);
  const t = (key: string) => getTranslation(locale, key);
  const shortHash = hash.substring(0, 7);
  return (
    <button
      className="flex items-center gap-0.5 font-mono px-1 py-0.5 rounded hover:bg-ide-accent/10 text-ide-mute hover:text-ide-accent transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? t("common.copied") : hash}
    >
      <GitCommitIcon size={9} />
      <span>{shortHash}</span>
      {copied ? <Check size={9} className="text-green-400" /> : <Copy size={9} />}
    </button>
  );
};

const CopyTagButton: React.FC<{ tag: string; locale: Locale }> = ({ tag, locale }) => {
  const [copied, setCopied] = useState(false);
  const t = (key: string) => getTranslation(locale, key);
  return (
    <button
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ide-mute/10 hover:bg-ide-accent/10 text-ide-text"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(tag);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? t("common.copied") : t("git.copyTag")}
    >
      <Tag size={9} />
      <span className="max-w-[140px] truncate">{tag}</span>
      {copied ? <Check size={9} className="text-green-400" /> : <Copy size={9} />}
    </button>
  );
};

interface CommitItemProps {
  commit: GitCommit;
  isExpanded: boolean;
  isDetailSelected: boolean;
  isMultiSelected: boolean;
  isUnpushed: boolean;
  unpushedTags: Set<string>;
  tagPushCheckDisabled: boolean;
  locale: Locale;
  platforms: AvatarPlatform[];
  canUndoCommit: boolean;
  isLoading: boolean;
  onUndoCommit: () => void;
  onCreateTag: () => void;
  onDeleteTag: (tag: string) => void;
  onFileClick: (filePath: string) => void;
  files: CommitFileInfo[];
  onSummaryClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSummaryKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  renderContextMenu: () => React.ReactNode;
}

const CommitItem: React.FC<CommitItemProps> = ({
  commit,
  isExpanded,
  isDetailSelected,
  isMultiSelected,
  isUnpushed,
  unpushedTags,
  tagPushCheckDisabled,
  locale,
  platforms,
  canUndoCommit,
  isLoading,
  onUndoCommit,
  onCreateTag,
  onDeleteTag,
  onFileClick,
  files,
  onSummaryClick,
  onSummaryKeyDown,
  onContextMenu,
  renderContextMenu,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const shortHash = commit.hash.substring(0, 7);
  const firstLine = commit.message.split("\n")[0];
  const tags = commit.tags ?? [];
  const authorAvatarUrl = useCachedAvatarUrl(commit.authorEmail, platforms);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        <div
          className={`border-b border-ide-border/50 ${
            isMultiSelected
              ? "bg-ide-accent/10 border-l-2 border-l-ide-accent"
              : isDetailSelected
                ? "bg-ide-accent/5"
                : ""
          }`}
          data-commit-hash={commit.hash}
          data-selected={isMultiSelected ? "true" : "false"}
        >
          <div
            className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-ide-accent/10 active:bg-ide-accent/15"
            onClick={onSummaryClick}
            onKeyDown={onSummaryKeyDown}
            role="option"
            aria-selected={isMultiSelected}
            data-expanded={isExpanded ? "true" : "false"}
            tabIndex={0}
          >
            <Avatar className="mt-0.5 size-7 shrink-0">
              {authorAvatarUrl ? (
                <img src={authorAvatarUrl} alt={commit.author} className="aspect-square size-full rounded-full" />
              ) : (
                <AvatarFallback className={`${hashColor(commit.author)} text-[10px] font-bold text-white`}>
                  {getInitials(commit.author)}
                </AvatarFallback>
              )}
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-ide-text font-medium truncate">{firstLine}</div>
              {tags.length > 0 && (
                <div className="flex items-center gap-1 mt-1 min-w-0">
                  <span className="inline-flex items-center gap-1 max-w-[160px] px-1.5 py-0.5 rounded bg-ide-mute/10 text-[10px] text-ide-text">
                    <Tag size={9} className="shrink-0" />
                    <span className="truncate">{tags[0]}</span>
                  </span>
                  {tags.length > 1 && <span className="text-[10px] text-ide-mute">+{tags.length - 1}</span>}
                </div>
              )}
              <div className="flex items-center gap-2 mt-0.5 text-[10px] text-ide-mute">
                <span>{commit.author}</span>
                <span className="flex items-center gap-0.5">
                  <Clock size={9} />
                  {formatRelativeTime(commit.date, locale, t)}
                </span>
                <span className="flex items-center gap-0.5 font-mono">
                  <GitCommitIcon size={9} />
                  {shortHash}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 pt-1">
              {isUnpushed && (
                <span className="shrink-0 px-2 py-0.5 rounded-full bg-ide-mute/15" title={t("git.unpushedCommit")}>
                  <ArrowUp size={12} className="text-ide-text/60" />
                </span>
              )}
              {isExpanded ? (
                <ChevronDown size={14} className="text-ide-mute" />
              ) : (
                <ChevronRight size={14} className="text-ide-mute" />
              )}
            </div>
          </div>

          {isExpanded && (
            <div className="bg-ide-panel/30 border-t border-ide-border/30">
              {commit.message.includes("\n") && (
                <div className="px-3 py-1.5 text-[11px] text-ide-mute/80 whitespace-pre-wrap break-words border-b border-ide-border/20">
                  {commit.message.split("\n").slice(1).join("\n").trim()}
                </div>
              )}
              <div className="px-3 py-1 flex items-center justify-between gap-2 text-[10px] text-ide-mute">
                <div className="flex items-center gap-2">
                  <span>
                    {files.length} {t("git.filesChanged")}
                  </span>
                  <CopyHashButton hash={commit.hash} locale={locale} />
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    className="px-2 py-0.5 rounded flex items-center gap-1 text-ide-accent hover:bg-ide-accent/10 disabled:opacity-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateTag();
                    }}
                    disabled={isLoading}
                  >
                    <Plus size={10} />
                    {t("git.createTag")}
                  </button>
                  {canUndoCommit && (
                    <button
                      className="px-2 py-0.5 rounded flex items-center gap-1 text-ide-accent hover:bg-ide-accent/10 disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUndoCommit();
                      }}
                      disabled={isLoading}
                    >
                      <Undo2 size={10} />
                      {t("git.undoCommit")}
                    </button>
                  )}
                </div>
              </div>
              {tags.length > 0 && (
                <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5 text-[10px] border-t border-ide-border/20">
                  {tags.map((tag) => {
                    const isUnpushedTag = unpushedTags.has(tag);
                    return (
                      <span key={tag} className="inline-flex items-center gap-1">
                        <CopyTagButton tag={tag} locale={locale} />
                        {isUnpushedTag && (
                          <span title={t("git.unpushedTag")}>
                            <ArrowUp size={10} className="text-blue-400" />
                          </span>
                        )}
                        {isUnpushedTag && !tagPushCheckDisabled && (
                          <button
                            className="p-0.5 rounded text-ide-mute hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteTag(tag);
                            }}
                            disabled={isLoading}
                            title={t("git.deleteTag")}
                          >
                            <Trash2 size={10} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
              {files.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-2 px-4 py-1 hover:bg-ide-accent/10 cursor-pointer active:bg-ide-accent/15"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFileClick(file.path);
                  }}
                >
                  <span className={`w-3 text-center font-bold text-[10px] ${getStatusColor(file.status)}`}>
                    {file.status[0]?.toUpperCase() || "?"}
                  </span>
                  <span className="text-xs text-ide-text truncate">{file.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {renderContextMenu()}
    </ContextMenu>
  );
};

const GitHistoryView: React.FC<GitHistoryViewProps> = ({
  commits,
  isLoading,
  locale,
  remoteUrls,
  aheadCount,
  tagsToPush,
  tagsToPushError,
  onCommitSelect,
  onUndoCommit,
  onCreateTag,
  onDeleteTag,
  onFileClick,
  selectedCommitFiles,
  selectedCommitHash,
  onLoadMore,
  selectedCommitHashes,
  onSelectedCommitsChange,
  onSelectedCommitHashesChange,
  onCherryPick,
  onCherryPickCommits,
  onRevert,
  onRevertCommit,
  onResetToCommit,
  onResetCommit,
  onSquash,
  onSquashCommits,
  onReorder,
  onReorderCommits,
}) => {
  const t = useCallback((key: string) => getTranslation(locale, key), [locale]);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [internalSelectedHashes, setInternalSelectedHashes] = useState<string[]>(
    () => selectedCommitHashes?.slice() ?? []
  );
  const [contextSelectionHashes, setContextSelectionHashes] = useState<string[]>([]);
  const contextSelectionHashesRef = useRef<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const platforms = useMemo(() => detectPlatforms(remoteUrls), [remoteUrls]);
  const unpushedTags = useMemo(() => new Set(tagsToPush), [tagsToPush]);

  const loadedHashes = useMemo(() => new Set(commits.map((commit) => commit.hash)), [commits]);
  const effectiveSelectedHashes = useMemo(() => {
    const source = selectedCommitHashes ?? internalSelectedHashes;
    return source.filter((hash, index) => loadedHashes.has(hash) && source.indexOf(hash) === index);
  }, [internalSelectedHashes, loadedHashes, selectedCommitHashes]);
  const selectedHashSet = useMemo(() => new Set(effectiveSelectedHashes), [effectiveSelectedHashes]);

  useEffect(() => {
    if (selectedCommitHashes !== undefined) return;
    setInternalSelectedHashes((current) => {
      const next = current.filter((hash) => loadedHashes.has(hash));
      return next.length === current.length ? current : next;
    });
  }, [loadedHashes, selectedCommitHashes]);

  useEffect(() => {
    const next = selectedCommitHashes ?? internalSelectedHashes;
    const currentAnchor = selectionAnchorRef.current;
    if (currentAnchor && next.includes(currentAnchor) && loadedHashes.has(currentAnchor)) return;
    const first = next[0];
    selectionAnchorRef.current = first && loadedHashes.has(first) ? first : null;
  }, [internalSelectedHashes, loadedHashes, selectedCommitHashes]);

  const commitsForHashes = useCallback(
    (hashes: string[]): GitCommit[] => {
      const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
      return hashes.map((hash) => byHash.get(hash)).filter((commit): commit is GitCommit => Boolean(commit));
    },
    [commits]
  );

  const emitSelection = useCallback(
    (hashes: string[]) => {
      const next = Array.from(new Set(hashes)).filter((hash) => loadedHashes.has(hash));
      if (selectedCommitHashes === undefined) setInternalSelectedHashes(next);
      onSelectedCommitHashesChange?.(next);
      onSelectedCommitsChange?.(commitsForHashes(next));
      return next;
    },
    [commitsForHashes, loadedHashes, onSelectedCommitHashesChange, onSelectedCommitsChange, selectedCommitHashes]
  );

  const handleToggle = useCallback(
    (commit: GitCommit) => {
      if (expandedHash === commit.hash) {
        setExpandedHash(null);
      } else {
        setExpandedHash(commit.hash);
        onCommitSelect(commit);
      }
    },
    [expandedHash, onCommitSelect]
  );

  const selectCommit = useCallback(
    (commit: GitCommit, event: React.MouseEvent) => {
      const index = commits.findIndex((candidate) => candidate.hash === commit.hash);
      if (index < 0) return;
      const multiKey = event.metaKey || event.ctrlKey;
      const current = effectiveSelectedHashes;
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
        if (!selectionAnchorRef.current || !loadedHashes.has(selectionAnchorRef.current)) {
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
      emitSelection(next);
    },
    [commits, effectiveSelectedHashes, emitSelection, loadedHashes]
  );

  const handleSummaryClick = useCallback(
    (commit: GitCommit, event: React.MouseEvent<HTMLDivElement>) => {
      const hasModifier = event.shiftKey || event.metaKey || event.ctrlKey;
      selectCommit(commit, event);
      // Modified clicks are selection gestures and must not change which row is expanded.
      if (!hasModifier) handleToggle(commit);
    },
    [handleToggle, selectCommit]
  );

  const handleContextMenu = useCallback(
    (commit: GitCommit, _event: React.MouseEvent<HTMLDivElement>) => {
      const next = selectedHashSet.has(commit.hash) ? effectiveSelectedHashes : emitSelection([commit.hash]);
      if (!selectedHashSet.has(commit.hash)) selectionAnchorRef.current = commit.hash;
      contextSelectionHashesRef.current = next;
      setContextSelectionHashes(next);
    },
    [effectiveSelectedHashes, emitSelection, selectedHashSet]
  );

  const handleSummaryKeyDown = useCallback(
    (commit: GitCommit, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const mouseLikeEvent = event as unknown as React.MouseEvent<HTMLDivElement>;
      handleSummaryClick(commit, mouseLikeEvent);
    },
    [handleSummaryClick]
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

  const copyHash = useCallback((hash: string) => {
    void copyText(hash).catch(() => undefined);
  }, []);

  const cherryPickAction = onCherryPick ?? onCherryPickCommits;
  const revertAction = onRevert ?? onRevertCommit;
  const resetAction = onResetToCommit ?? onResetCommit;
  const squashAction = onSquash ?? onSquashCommits;
  const reorderAction = onReorder ?? onReorderCommits;

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!onLoadMore || loadingMoreRef.current || isLoading) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        loadingMoreRef.current = true;
        onLoadMore();
        setTimeout(() => {
          loadingMoreRef.current = false;
        }, 500);
      }
    },
    [onLoadMore, isLoading]
  );

  if (isLoading && commits.length === 0) {
    return <div className="flex items-center justify-center h-32 text-ide-mute text-sm">{t("git.loading")}</div>;
  }

  if (commits.length === 0) {
    return <div className="flex items-center justify-center h-32 text-ide-mute text-sm">{t("git.noCommits")}</div>;
  }

  const unpushedCount = aheadCount > 0 ? aheadCount : 0;

  return (
    <div className="h-full overflow-y-auto bg-ide-bg" onScroll={handleScroll}>
      {tagsToPushError && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/8 border-b border-yellow-500/20">
          <Tag size={12} className="text-yellow-400" />
          <span className="text-[11px] text-yellow-400 font-medium">{t("git.tagsStatusUnavailable")}</span>
        </div>
      )}
      {!tagsToPushError && tagsToPush.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/8 border-b border-blue-500/20">
          <Tag size={12} className="text-blue-400" />
          <span className="text-[11px] text-blue-400 font-medium">
            {tagsToPush.length} {t("git.unpushedTags")}
          </span>
        </div>
      )}
      {unpushedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/8 border-b border-blue-500/20">
          <ArrowUp size={12} className="text-blue-400" />
          <span className="text-[11px] text-blue-400 font-medium">
            {unpushedCount} {t("git.unpushedCommits")}
          </span>
        </div>
      )}
      {commits.map((commit, index) => (
        <CommitItem
          key={commit.hash}
          commit={commit}
          isExpanded={expandedHash === commit.hash}
          isDetailSelected={selectedCommitHash === commit.hash}
          isMultiSelected={selectedHashSet.has(commit.hash)}
          isUnpushed={index < unpushedCount}
          unpushedTags={unpushedTags}
          tagPushCheckDisabled={Boolean(tagsToPushError)}
          locale={locale}
          platforms={platforms}
          canUndoCommit={index === 0 && commit.parentCount > 0}
          isLoading={isLoading}
          onSummaryClick={(event) => handleSummaryClick(commit, event)}
          onSummaryKeyDown={(event) => handleSummaryKeyDown(commit, event)}
          onContextMenu={(event) => handleContextMenu(commit, event)}
          renderContextMenu={() => {
            const selected = menuCommits(commit);
            const isMulti = selected.length >= 2;
            return (
              <ContextMenuContent className="min-w-48">
                {isMulti ? (
                  <>
                    <ContextMenuItem
                      disabled={!cherryPickAction || isLoading}
                      onSelect={() => void cherryPickAction?.(selected)}
                    >
                      {t("git.cherryPick")} ({selected.length})
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={!squashAction || isLoading}
                      onSelect={() => void squashAction?.(selected, commit)}
                    >
                      {t("git.squash")} ({selected.length})
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={!reorderAction || isLoading}
                      onSelect={() => void reorderAction?.(selected, commit)}
                    >
                      {t("git.reorder")} ({selected.length})
                    </ContextMenuItem>
                  </>
                ) : (
                  <>
                    <ContextMenuItem
                      disabled={!cherryPickAction || isLoading}
                      onSelect={() => void cherryPickAction?.([commit])}
                    >
                      {t("git.cherryPick")}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!revertAction || isLoading} onSelect={() => void revertAction?.(commit)}>
                      {t("git.revert")}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!resetAction || isLoading} onSelect={() => void resetAction?.(commit)}>
                      {t("git.resetToCommit")}
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyHash(commit.hash)}>{t("common.copy")} SHA</ContextMenuItem>
              </ContextMenuContent>
            );
          }}
          onUndoCommit={() => onUndoCommit(commit)}
          onCreateTag={() => onCreateTag(commit)}
          onDeleteTag={onDeleteTag}
          onFileClick={(path) => onFileClick(commit, path)}
          files={expandedHash === commit.hash ? selectedCommitFiles : []}
        />
      ))}
      {isLoading && commits.length > 0 && (
        <div className="flex items-center justify-center py-3">
          <Loader2 size={14} className="animate-spin text-ide-mute" />
        </div>
      )}
    </div>
  );
};

export default GitHistoryView;
