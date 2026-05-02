import { GitBranch, Loader2, Square, SquareCheck, SquareMinus } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import type { GitImageDiff, GitInteractiveDiff, GitSubmoduleDiff, GitSubmoduleStatus } from "@/api/git";
import GitImageDiffPreview from "@/components/git/git-image-diff";
import { useIsMobile } from "@/hooks/use-mobile";
import { type GitParsedDiff, type GitSelectionType, parseGitDiff } from "@/lib/git-diff";
import { getTranslation } from "@/lib/i18n";
import { useGitStore } from "@/stores";
import { useAppStore } from "@/stores/app-store";

interface DiffViewProps {
  groupId: string;
  original: string;
  modified: string;
  filename?: string;
  filePath?: string;
  repoPath?: string;
  language?: string;
  allowSelection?: boolean;
  submodule?: GitSubmoduleStatus;
  metadata?: GitDiffMetadata;
}

export interface GitDiffMetadata {
  kind?: string;
  patch?: string;
  capability?: { lineSelectable: boolean };
  submodule?: GitSubmoduleDiff;
  oldSize?: number;
  newSize?: number;
  oldBinary?: boolean;
  newBinary?: boolean;
  oldTruncated?: boolean;
  newTruncated?: boolean;
  binary?: boolean;
  large?: boolean;
  patchTruncated?: boolean;
  image?: GitImageDiff;
}

interface DisplayRow {
  id: string;
  type: "context" | "added" | "removed";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  selectable: boolean;
  selected: boolean;
}

interface DisplayHunk {
  id: string;
  header: string;
  rows: DisplayRow[];
  selectableRowIds: string[];
}

const getLanguageFromFilename = (filename?: string): string => {
  if (!filename) return "plaintext";
  const ext = filename.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    graphql: "graphql",
    vue: "vue",
    svelte: "svelte",
    php: "php",
    rb: "ruby",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    lua: "lua",
    r: "r",
    toml: "toml",
    ini: "ini",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  return langMap[ext || ""] || "plaintext";
};

const getSelectionIcon = (selectionType: GitSelectionType, size: number, className: string) => {
  if (selectionType === "all") {
    return <SquareCheck size={size} className={className} />;
  }
  if (selectionType === "partial") {
    return <SquareMinus size={size} className={className} />;
  }
  return <Square size={size} className={className} />;
};

const mapParsedDiffToDisplay = (parsedDiff: GitParsedDiff): DisplayHunk[] =>
  parsedDiff.hunks.map((hunk) => ({
    id: hunk.id,
    header: hunk.header,
    selectableRowIds: hunk.selectableRowIds,
    rows: hunk.rows
      .filter((row) => row.type !== "hunk")
      .map((row) => ({
        id: row.id,
        type: row.type === "added" ? "added" : row.type === "removed" ? "removed" : "context",
        content: row.content,
        oldLineNumber: row.oldLineNumber,
        newLineNumber: row.newLineNumber,
        selectable: row.selectable,
        selected: false,
      })),
  }));

const mapInteractiveDiffToDisplay = (diff: GitInteractiveDiff): DisplayHunk[] =>
  diff.hunks.map((hunk) => ({
    id: hunk.id,
    header: hunk.header,
    selectableRowIds: hunk.lines.filter((line) => line.selectable).map((line) => line.id),
    rows: hunk.lines.map((line) => ({
      id: line.id,
      type: line.kind === "add" ? "added" : line.kind === "del" ? "removed" : "context",
      content: line.content,
      oldLineNumber: line.oldLine > 0 ? line.oldLine : null,
      newLineNumber: line.newLine > 0 ? line.newLine : null,
      selectable: line.selectable,
      selected: line.selected,
    })),
  }));

const getHunkSelectionType = (hunk: DisplayHunk): GitSelectionType => {
  if (hunk.selectableRowIds.length === 0) {
    return "none";
  }
  const selectedCount = hunk.rows.filter((row) => row.selectable && row.selected).length;
  if (selectedCount === 0) {
    return "none";
  }
  if (selectedCount === hunk.selectableRowIds.length) {
    return "all";
  }
  return "partial";
};

const getRowSelectionType = (row: DisplayRow): GitSelectionType => {
  if (!row.selectable) {
    return "none";
  }
  return row.selected ? "all" : "none";
};

const getSelectionSurfaceClassName = (row: DisplayRow, selected: boolean, interactive: boolean) => {
  if (row.type === "added") {
    if (!interactive) {
      return "bg-green-500/20";
    }
    return selected ? "bg-green-500/12 hover:bg-green-500/18" : "bg-green-500/5 hover:bg-green-500/10";
  }
  if (row.type === "removed") {
    if (!interactive) {
      return "bg-red-500/20";
    }
    return selected ? "bg-red-500/12 hover:bg-red-500/18" : "bg-red-500/5 hover:bg-red-500/10";
  }
  return interactive ? "bg-ide-bg hover:bg-ide-panel/40" : "bg-ide-bg";
};

const getSelectionClassName = (row: DisplayRow, selected: boolean, interactive: boolean) => {
  const surfaceClassName = getSelectionSurfaceClassName(row, selected, interactive);
  if (row.type === "added" || row.type === "removed") {
    if (!interactive) {
      return `${surfaceClassName} text-ide-text`;
    }
    return selected ? surfaceClassName : `${surfaceClassName} text-ide-mute/80`;
  }
  return surfaceClassName;
};

const DiffView: React.FC<DiffViewProps> = ({
  groupId,
  original,
  modified,
  filename,
  filePath,
  language,
  allowSelection = false,
  submodule,
  metadata,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = (key: string) => getTranslation(locale, key);
  const getInteractiveDiff = useGitStore(groupId, (state) => state.getInteractiveDiff);
  const applySelection = useGitStore(groupId, (state) => state.applySelection);
  const interactiveDiff = useGitStore(groupId, (state) => (filePath ? state.interactiveDiffs[filePath] : undefined));
  const isMobile = useIsMobile();
  const [isLoading, setIsLoading] = useState(false);

  const detectedLanguage = useMemo(() => language || getLanguageFromFilename(filename), [language, filename]);
  const parsedDiff = useMemo(() => parseGitDiff(original, modified), [original, modified]);
  const interactiveRequested =
    Boolean(filePath) && (allowSelection || Boolean(submodule) || metadata?.kind === "submodule");

  useEffect(() => {
    if (!interactiveRequested || !filePath) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    void getInteractiveDiff(filePath, "working").finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [interactiveRequested, filePath, getInteractiveDiff]);

  const diffMetadata = interactiveRequested ? (interactiveDiff ?? metadata) : metadata;
  const submoduleDiff = diffMetadata?.submodule;
  const isSubmodule = Boolean(submoduleDiff || submodule || diffMetadata?.kind === "submodule");
  const isBinary = Boolean(diffMetadata?.binary || diffMetadata?.oldBinary || diffMetadata?.newBinary);
  const isLarge = Boolean(
    diffMetadata?.large || diffMetadata?.patchTruncated || diffMetadata?.oldTruncated || diffMetadata?.newTruncated
  );
  const imageDiff = diffMetadata?.image;
  const previewUnavailable = isBinary || isLarge;
  const interactive =
    interactiveRequested && !previewUnavailable && !isSubmodule && diffMetadata?.capability?.lineSelectable !== false;

  const displayHunks = useMemo(
    () =>
      interactive && interactiveDiff && !previewUnavailable
        ? mapInteractiveDiffToDisplay(interactiveDiff)
        : mapParsedDiffToDisplay(parsedDiff),
    [interactive, interactiveDiff, parsedDiff, previewUnavailable]
  );

  const diffStats = useMemo(() => {
    if (interactive && interactiveDiff && !previewUnavailable) {
      return {
        added: interactiveDiff.stats.added,
        removed: interactiveDiff.stats.deleted,
      };
    }

    const rows = displayHunks.flatMap((hunk) => hunk.rows);
    return {
      added: rows.filter((row) => row.type === "added").length,
      removed: rows.filter((row) => row.type === "removed").length,
    };
  }, [displayHunks, interactive, interactiveDiff, previewUnavailable]);

  const fileSelectionType = useMemo<GitSelectionType>(() => {
    if (!interactive || !interactiveDiff || previewUnavailable) {
      return "none";
    }
    return interactiveDiff.includedState;
  }, [interactive, interactiveDiff, previewUnavailable]);

  const selectedRowCount = useMemo(
    () => displayHunks.flatMap((hunk) => hunk.rows).filter((row) => row.selectable && row.selected).length,
    [displayHunks]
  );
  const selectableRowCount = useMemo(
    () => displayHunks.flatMap((hunk) => hunk.rows).filter((row) => row.selectable).length,
    [displayHunks]
  );

  const maxMobileContentColumns = useMemo(() => {
    if (!isMobile) {
      return 0;
    }
    const lineLengths = displayHunks.flatMap((hunk) => [
      hunk.header.length,
      ...hunk.rows.map((row) => row.content.length + 2),
    ]);
    return Math.max(24, ...lineLengths);
  }, [isMobile, displayHunks]);

  const diffContentWrapperClassName = isMobile ? "min-w-full" : "";
  const diffContentWrapperStyle = isMobile ? { minWidth: `calc(${maxMobileContentColumns}ch + 60px)` } : undefined;
  const diffRowClassName = `w-full flex items-stretch transition-colors ${interactive ? "text-left" : "select-text"}`;
  const interactiveDiffRowClassName = isMobile ? "min-h-11" : "";
  const diffLeftPaneOuterClassName = isMobile
    ? "sticky left-0 z-10 flex shrink-0 self-stretch border-r border-ide-border bg-ide-bg bg-opacity-100"
    : "sticky left-0 z-10 flex shrink-0 self-stretch border-r border-ide-border/50 bg-ide-bg bg-opacity-100";
  const diffLeftPaneInnerClassName = isMobile
    ? "flex items-center gap-0 w-full px-0.5"
    : "flex items-start gap-2 w-full pl-2 pr-2 py-0.5";
  const diffCheckboxClassName = isMobile
    ? "h-5 w-3 flex items-center justify-center shrink-0"
    : "h-5 w-[26px] flex items-center justify-center shrink-0";
  const diffLineNumberClassName = isMobile
    ? "h-5 w-[26px] flex items-center justify-end text-[8px] text-ide-mute/60 tabular-nums shrink-0"
    : "h-5 w-[56px] flex items-center justify-end text-ide-mute/70 tabular-nums shrink-0";
  const diffPrefixClassName = isMobile
    ? "inline-block w-2 shrink-0 text-ide-mute/70"
    : "inline-block w-3 shrink-0 text-ide-mute/70";
  const diffContentClassName = isMobile
    ? "flex min-w-0 flex-1 items-center px-2 leading-5 whitespace-pre"
    : "flex-1 min-w-0 pr-2 pl-2 py-0.5 leading-5 whitespace-pre-wrap break-words";
  const diffBodyClassName = isMobile
    ? "flex-1 overflow-auto font-mono text-[11px]"
    : "flex-1 overflow-auto font-mono text-xs";
  const hunkHeaderClassName = isMobile
    ? `sticky top-0 z-20 flex min-h-11 w-full items-stretch border-b border-ide-border bg-ide-panel text-left ${interactive ? "cursor-pointer" : ""}`
    : `sticky top-0 z-20 flex w-full items-stretch border-b border-ide-border/50 bg-ide-panel text-left ${interactive ? "cursor-pointer hover:bg-ide-panel/80" : ""}`;
  const hunkHeaderLeftClassName = isMobile
    ? "sticky left-0 z-20 flex shrink-0 self-stretch items-center gap-0 border-r border-ide-border bg-ide-panel px-0.5"
    : "sticky left-0 z-20 flex shrink-0 self-stretch items-center gap-2 border-r border-ide-border/50 bg-ide-panel pl-2 pr-2 py-1";
  const hunkHeaderTextClassName = isMobile
    ? "px-2 py-0.75 text-[11px] text-ide-accent flex items-center"
    : "px-2 py-1 text-[11px] text-ide-accent flex items-center";

  const runSelectionAction = async (
    target: "line" | "hunk" | "file",
    action: "include" | "exclude" | "discard",
    lineIds: string[],
    hunkIds: string[]
  ) => {
    if (!interactive || !filePath || !interactiveDiff || previewUnavailable) {
      return;
    }

    setIsLoading(true);
    await applySelection(filePath, "working", target, action, interactiveDiff.patchHash, lineIds, hunkIds);
    setIsLoading(false);
  };

  return (
    <div className="h-full flex flex-col bg-ide-bg">
      <div
        className={`flex items-center justify-between gap-3 border-b border-ide-border bg-ide-panel/50 px-3 ${isMobile ? "min-h-11" : "py-1.5"}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {interactive && (
            <button
              type="button"
              className={isMobile ? "-ml-3 flex size-11 shrink-0 items-center justify-center" : "shrink-0"}
              onClick={() => {
                const action = fileSelectionType === "none" ? "include" : "exclude";
                void runSelectionAction("file", action, [], []);
              }}
              aria-label={`${fileSelectionType === "none" ? t("git.add") : t("git.reset")}: ${filePath || filename || "Diff View"}`}
              aria-pressed={fileSelectionType !== "none"}
            >
              {getSelectionIcon(
                fileSelectionType,
                16,
                fileSelectionType === "none" ? "text-ide-mute" : "text-ide-accent"
              )}
            </button>
          )}
          <span className="text-xs text-ide-text font-medium truncate">{filePath || filename || "Diff View"}</span>
          <span className="text-[10px] text-ide-mute/60 bg-ide-bg px-1.5 py-0.5 rounded shrink-0">
            {detectedLanguage}
          </span>
          {(diffStats.added > 0 || diffStats.removed > 0) && !previewUnavailable && (
            <span className="text-[10px] shrink-0">
              {diffStats.added > 0 && <span className="text-green-400">+{diffStats.added}</span>}
              {diffStats.added > 0 && diffStats.removed > 0 && <span className="text-ide-mute mx-0.5">/</span>}
              {diffStats.removed > 0 && <span className="text-red-400">-{diffStats.removed}</span>}
            </span>
          )}
        </div>
        {interactive && (
          <div className="text-[10px] text-ide-mute shrink-0">
            {selectedRowCount}/{selectableRowCount}
          </div>
        )}
      </div>

      <div className={diffBodyClassName} style={isMobile ? { overscrollBehaviorX: "contain" } : undefined}>
        {isLoading && interactiveRequested && !interactiveDiff ? (
          <div className="h-full flex items-center justify-center text-ide-mute gap-2">
            <Loader2 size={14} className="animate-spin" />
            {t("git.loading")}
          </div>
        ) : imageDiff ? (
          <GitImageDiffPreview
            image={imageDiff}
            oldSize={diffMetadata?.oldSize}
            newSize={diffMetadata?.newSize}
            oldTruncated={diffMetadata?.oldTruncated}
            newTruncated={diffMetadata?.newTruncated}
            locale={locale}
          />
        ) : previewUnavailable ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-ide-mute">
            <span className="text-sm text-ide-text">{isBinary ? t("git.binaryFile") : t("git.largeFile")}</span>
            <span className="text-xs max-w-md">
              {isBinary ? t("git.binaryDiffUnavailable") : t("git.largeDiffUnavailable")}
            </span>
            {(diffMetadata?.oldSize !== undefined || diffMetadata?.newSize !== undefined) && (
              <span className="text-[10px] font-mono">
                {diffMetadata?.oldSize ?? 0} -&gt; {diffMetadata?.newSize ?? 0} {t("git.bytes")}
              </span>
            )}
          </div>
        ) : isSubmodule ? (
          <div className="h-full overflow-auto px-4 py-5 text-sm">
            <div className="flex items-center gap-2 text-ide-text">
              <GitBranch size={16} className="text-ide-accent" />
              <span>{t("git.submoduleDiff")}</span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-ide-mute">
              <div className="font-mono text-ide-text">{filePath || filename || "submodule"}</div>
              {submoduleDiff?.url && <div className="truncate font-mono">{submoduleDiff.url}</div>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
                <span>
                  {t("git.submoduleOldCommit")}: {submoduleDiff?.oldSHA || "-"}
                </span>
                <span>
                  {t("git.submoduleNewCommit")}: {submoduleDiff?.newSHA || "-"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(submoduleDiff?.status.initialized ?? submodule?.initialized) ? (
                  <span className="rounded border border-green-500/30 px-1.5 py-0.5 text-[10px] text-green-400">
                    {t("git.submoduleInitialized")}
                  </span>
                ) : (
                  <span className="rounded border border-orange-500/30 px-1.5 py-0.5 text-[10px] text-orange-400">
                    {t("git.submoduleUninitialized")}
                  </span>
                )}
                {(submoduleDiff?.status.commitChanged || submodule?.commitChanged) && (
                  <span className="rounded border border-orange-500/30 px-1.5 py-0.5 text-[10px] text-orange-400">
                    {t("git.submoduleCommitChanged")}
                  </span>
                )}
                {(submoduleDiff?.status.modifiedChanges || submodule?.modifiedChanges) && (
                  <span className="rounded border border-yellow-500/30 px-1.5 py-0.5 text-[10px] text-yellow-400">
                    {t("git.submoduleModified")}
                  </span>
                )}
                {(submoduleDiff?.status.untrackedChanges || submodule?.untrackedChanges) && (
                  <span className="rounded border border-blue-500/30 px-1.5 py-0.5 text-[10px] text-blue-400">
                    {t("git.submoduleUntracked")}
                  </span>
                )}
                {(submoduleDiff?.status.conflict || submodule?.conflict) && (
                  <span className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-400">
                    {t("git.submoduleConflict")}
                  </span>
                )}
              </div>
            </div>
            {diffMetadata?.patch && (
              <pre className="mt-4 overflow-auto border-t border-ide-border pt-3 font-mono text-[11px] leading-5 text-ide-mute">
                {diffMetadata.patch}
              </pre>
            )}
          </div>
        ) : displayHunks.length === 0 ? (
          <div className="h-full flex items-center justify-center text-ide-mute">{t("git.noChanges")}</div>
        ) : (
          <div className={diffContentWrapperClassName} style={diffContentWrapperStyle}>
            {displayHunks.map((hunk) => (
              <div key={hunk.id} className="border-b border-ide-border/60 last:border-b-0">
                {interactive ? (
                  <button
                    type="button"
                    className={hunkHeaderClassName}
                    onClick={() => {
                      const hunkSelectionType = getHunkSelectionType(hunk);
                      const action = hunkSelectionType === "none" ? "include" : "exclude";
                      void runSelectionAction("hunk", action, [], [hunk.id]);
                    }}
                    aria-label={`${getHunkSelectionType(hunk) === "none" ? t("git.add") : t("git.reset")}: ${hunk.header}`}
                    aria-pressed={getHunkSelectionType(hunk) !== "none"}
                  >
                    <div className={hunkHeaderLeftClassName}>
                      <span className={diffCheckboxClassName}>
                        {getSelectionIcon(
                          getHunkSelectionType(hunk),
                          13,
                          getHunkSelectionType(hunk) === "none" ? "text-ide-mute" : "text-ide-accent"
                        )}
                      </span>
                      <span className={diffLineNumberClassName} />
                      <span className={diffLineNumberClassName} />
                    </div>
                    <span className={hunkHeaderTextClassName}>{hunk.header}</span>
                  </button>
                ) : (
                  <div className={hunkHeaderClassName}>
                    <div className={hunkHeaderLeftClassName}>
                      <span className={diffCheckboxClassName} />
                      <span className={diffLineNumberClassName} />
                      <span className={diffLineNumberClassName} />
                    </div>
                    <span className={hunkHeaderTextClassName}>{hunk.header}</span>
                  </div>
                )}

                {hunk.rows.map((row) => {
                  const rowSelectionType = getRowSelectionType(row);
                  const selected = rowSelectionType === "all";
                  const rowContent = (
                    <>
                      <div className={diffLeftPaneOuterClassName}>
                        <div
                          className={`${diffLeftPaneInnerClassName} ${getSelectionSurfaceClassName(row, selected, interactive)}`}
                        >
                          <span className={diffCheckboxClassName}>
                            {interactive && row.selectable
                              ? getSelectionIcon(rowSelectionType, 13, selected ? "text-ide-accent" : "text-ide-mute")
                              : null}
                          </span>
                          <span className={diffLineNumberClassName}>{row.oldLineNumber ?? ""}</span>
                          <span className={diffLineNumberClassName}>{row.newLineNumber ?? ""}</span>
                        </div>
                      </div>
                      <span className={diffContentClassName}>
                        <span className={diffPrefixClassName}>
                          {row.type === "added" ? "+" : row.type === "removed" ? "-" : " "}
                        </span>
                        <span>{row.content || " "}</span>
                      </span>
                    </>
                  );

                  if (interactive && row.selectable) {
                    return (
                      <button
                        type="button"
                        key={row.id}
                        className={`${diffRowClassName} ${interactiveDiffRowClassName} ${getSelectionClassName(row, selected, interactive)}`}
                        onClick={() => {
                          const action = selected ? "exclude" : "include";
                          void runSelectionAction("line", action, [row.id], []);
                        }}
                        aria-label={`${selected ? t("git.reset") : t("git.add")}: ${filePath || filename || "Diff View"}, ${t("git.lines")} ${row.newLineNumber ?? row.oldLineNumber ?? ""}`}
                        aria-pressed={selected}
                      >
                        {rowContent}
                      </button>
                    );
                  }

                  return (
                    <div
                      key={row.id}
                      className={`${diffRowClassName} ${getSelectionClassName(row, selected, interactive)}`}
                    >
                      {rowContent}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DiffView;
