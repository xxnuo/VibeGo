import { Download, FolderGit2, FolderOpen, FolderPlus, Loader2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { gitApi } from "@/api/git";
import DirectoryPicker from "@/components/common/directory-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getTranslation, type Locale } from "@/lib/i18n";

export type GitRepositoryDialogMode = "create" | "clone";

interface GitRepositoryDialogProps {
  open: boolean;
  mode: GitRepositoryDialogMode;
  locale: Locale;
  initialPath?: string;
  onClose: () => void;
  onOpenRepository: (path: string) => Promise<unknown>;
}

export function validateGitRepositoryInput(
  mode: GitRepositoryDialogMode,
  url: string,
  path: string
): "url" | "path" | null {
  if (mode === "clone" && !url.trim()) return "url";
  if (!path.trim()) return "path";
  return null;
}

type GitRepositoryOperations = Pick<typeof gitApi, "init" | "clone">;

export async function performGitRepositoryOperation(
  mode: GitRepositoryDialogMode,
  url: string,
  path: string,
  operations: GitRepositoryOperations = gitApi
): Promise<string> {
  const targetPath = path.trim();
  const sourceUrl = url.trim();
  const validation = validateGitRepositoryInput(mode, sourceUrl, targetPath);
  if (validation === "url") throw new Error("repository URL is required");
  if (validation === "path") throw new Error("repository path is required");

  if (mode === "clone") {
    await operations.clone(sourceUrl, targetPath);
  } else {
    await operations.init(targetPath);
  }
  return targetPath;
}

const GitRepositoryDialog: React.FC<GitRepositoryDialogProps> = ({
  open,
  mode,
  locale,
  initialPath = "",
  onClose,
  onOpenRepository,
}) => {
  const t = (key: string) => getTranslation(locale, key);
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const browseButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreBrowseFocusRef = useRef(false);

  useEffect(() => {
    if (!open) {
      restoreBrowseFocusRef.current = false;
      return;
    }
    setUrl("");
    setDestination(mode === "create" ? initialPath : "");
    setError(null);
    setRunning(false);
    setDirectoryPickerOpen(false);
    restoreBrowseFocusRef.current = false;
  }, [initialPath, mode, open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (running) return;

    const validation = validateGitRepositoryInput(mode, url, destination);
    if (validation === "url") {
      setError(t("git.repositoryUrlRequired"));
      return;
    }
    if (validation === "path") {
      setError(t("git.repositoryPathRequired"));
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const targetPath = await performGitRepositoryOperation(mode, url, destination);
      await onOpenRepository(targetPath);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("git.repositoryOperationFailed"));
    } finally {
      setRunning(false);
    }
  };

  const title = mode === "clone" ? t("git.cloneRepositoryTitle") : t("git.createRepositoryTitle");
  const actionLabel = mode === "clone" ? t("git.cloneRepositoryAction") : t("git.createRepositoryAction");
  const browseInitialPath = mode === "clone" ? initialPath || "." : destination.trim() || initialPath || ".";

  return (
    <>
      <Dialog
        open={open && !directoryPickerOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !running && !directoryPickerOpen) onClose();
        }}
      >
        <DialogContent
          showCloseButton={!running}
          onOpenAutoFocus={(event) => {
            if (!restoreBrowseFocusRef.current) return;
            event.preventDefault();
            restoreBrowseFocusRef.current = false;
            browseButtonRef.current?.focus({ preventScroll: true });
          }}
          className="border-ide-border bg-ide-panel text-ide-text shadow-sm md:max-w-lg"
        >
          <DialogHeader className="gap-2 text-left">
            <DialogTitle className="flex items-center gap-2 text-base text-ide-text">
              {mode === "clone" ? <Download size={17} /> : <FolderPlus size={17} />}
              {title}
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-ide-mute">
              {mode === "clone" ? t("git.cloneRepositoryHint") : t("git.createRepositoryHint")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "clone" && (
              <label className="block space-y-1.5 text-sm">
                <span className="text-ide-text">{t("git.repositoryUrl")}</span>
                <Input
                  id="git-repository-url"
                  name="git-repository-url"
                  aria-label={t("git.repositoryUrl")}
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError(null);
                  }}
                  placeholder={t("git.repositoryUrlPlaceholder")}
                  autoFocus={!restoreBrowseFocusRef.current}
                  disabled={running}
                  className="border-ide-border bg-ide-bg text-ide-text placeholder:text-ide-mute focus-visible:ring-ide-accent/30"
                />
              </label>
            )}

            <label className="block space-y-1.5 text-sm">
              <span className="text-ide-text">{t("git.repositoryPath")}</span>
              <div className="flex gap-2">
                <Input
                  id="git-repository-path"
                  name="git-repository-path"
                  aria-label={t("git.repositoryPath")}
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    setError(null);
                  }}
                  placeholder={t("git.repositoryPathPlaceholder")}
                  autoFocus={mode === "create" && !restoreBrowseFocusRef.current}
                  disabled={running}
                  className="min-w-0 border-ide-border bg-ide-bg text-ide-text placeholder:text-ide-mute focus-visible:ring-ide-accent/30"
                />
                <Button
                  ref={browseButtonRef}
                  type="button"
                  variant="outline"
                  size="icon"
                  title={t("git.chooseRepositoryDirectory")}
                  aria-label={t("git.chooseRepositoryDirectory")}
                  onClick={() => {
                    restoreBrowseFocusRef.current = true;
                    setDirectoryPickerOpen(true);
                  }}
                  disabled={running}
                  className="shrink-0 border-ide-border bg-ide-panel text-ide-text hover:bg-ide-bg"
                >
                  <FolderOpen size={16} />
                </Button>
              </div>
              {mode === "clone" && (
                <span className="block text-xs leading-5 text-ide-mute">{t("git.clonePathHint")}</span>
              )}
            </label>

            {error && <div className="text-sm leading-5 text-red-400">{error}</div>}

            <DialogFooter className="gap-2 pt-2 sm:pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={running}
                className="border-ide-border bg-ide-panel text-ide-text hover:bg-ide-bg"
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={running}
                className="bg-ide-accent text-ide-on-accent hover:bg-ide-accent/90"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <FolderGit2 size={16} />}
                {running ? t("git.repositoryWorking") : actionLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DirectoryPicker
        isOpen={directoryPickerOpen}
        onClose={() => setDirectoryPickerOpen(false)}
        onSelect={(selectedPath) => {
          setDestination(selectedPath);
          setError(null);
          setDirectoryPickerOpen(false);
        }}
        initialPath={browseInitialPath}
        locale={locale}
      />
    </>
  );
};

export default GitRepositoryDialog;
