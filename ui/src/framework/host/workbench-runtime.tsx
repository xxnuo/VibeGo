import { getWorkspacePath } from "@/components/frame/workspace-hint-bubble";
import { GitBranch, Loader2, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { fileApi } from "@/api/file";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useWorkbenchRegistry } from "@/framework/workbench/registry";
import type { QuickOpenItem } from "@/framework/workbench/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppStore } from "@/stores/app-store";
import { useFrameStore } from "@/stores/frame-store";
import { getOrCreateGitStore } from "@/stores/git-store";
import { usePreviewStore } from "@/stores/preview-store";
import { commands } from "./command-service";
import { contextKeys, useContextKeyStore } from "./context-key-service";
import { pluginEvents } from "./event-bus";
import { createStatusBarItem } from "./status-bar-service";
import { usePluginUIStore } from "./ui-service";
import { usePluginHost } from "./use-plugin-host";

function snapshot() {
  const frame = useFrameStore.getState();
  const group = frame.getActiveGroup();
  const path = group ? getWorkspacePath(group) || undefined : undefined;
  return {
    tab: frame.getCurrentActiveTabId(),
    groupId: frame.activeGroupId,
    pageId: frame.getCurrentPage()?.id,
    path,
    type:
      frame.getCurrentTabs().find((tab) => tab.id === frame.getCurrentActiveTabId())?.data?.type ||
      frame.getCurrentPageType() ||
      (group?.type === "tool" ? group.pageId : group?.type),
    groupType: group?.type,
    nonHome: frame.groups.some((group) => group.type !== "home"),
  };
}
export function PluginWorkbenchRuntime() {
  const registry = useWorkbenchRegistry();
  const contextRevision = useContextKeyStore((state) => state.revision);
  const mobile = useIsMobile();
  const locale = useAppStore((state) => state.locale);
  const en = locale === "en";
  const picks = usePluginUIStore((state) => state.picks);
  const progress = usePluginUIStore((state) => state.progress);
  const pick = picks[0];
  const [query, setQuery] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [results, setResults] = useState<QuickOpenItem[]>([]);
  const [searching, setSearching] = useState(false);
  const host = usePluginHost();
  useEffect(() => {
    if (pick) setQuery("");
  }, [pick?.id]);

  useEffect(() => {
    contextKeys.set("isMobile", mobile);
  }, [mobile]);
  useEffect(() => {
    const path = host.workspace.currentPath;
    contextKeys.set("git.isRepo", false);
    if (!path) return;
    const store = getOrCreateGitStore(host.workspace.groupId);
    const item = createStatusBarItem("git", { id: "branch", priority: 10 }, host.workspace.groupId);
    item.icon = GitBranch;
    item.onClick = () => {
      const frame = useFrameStore.getState();
      if (
        frame.groups.some(
          (group) => group.id === host.workspace.groupId && group.type === "tool" && group.pageId === "git"
        )
      )
        frame.setActiveGroup(host.workspace.groupId);
      else frame.addGitGroup(path, undefined, host.workspace.groupId);
    };
    const update = () => {
      const state = store.getState();
      const available = state.isRepo === true && state.currentPath === path;
      contextKeys.set("git.isRepo", available);
      if (available) {
        item.text = state.currentBranch;
        item.tooltip = path;
        item.show();
      } else item.hide();
    };
    update();
    const off = store.subscribe(update);
    return () => {
      off();
      item.dispose();
    };
  }, [host.workspace.groupId, host.workspace.currentPath]);
  useEffect(() => {
    let previous = snapshot();
    const sync = () => {
      const next = snapshot();
      contextKeys.set("hasWorkspace", Boolean(next.path));
      contextKeys.set("activeTabType", next.type);
      if (next.tab !== previous.tab || next.type !== previous.type) contextKeys.set("isCodeEditor", false);
      contextKeys.set("activeGroupType", next.groupType);
      contextKeys.set("hasNonHomeGroups", next.nonHome);
      if (next.tab !== previous.tab || next.groupId !== previous.groupId || next.pageId !== previous.pageId)
        pluginEvents.emit("tab", next.tab);
      if (next.path !== previous.path || next.groupId !== previous.groupId) pluginEvents.emit("workspace", next.path);
      previous = next;
    };
    sync();
    const offFrame = useFrameStore.subscribe(sync);
    const offTheme = useAppStore.subscribe((state, prev) => {
      if (state.theme !== prev.theme) pluginEvents.emit("theme", state.theme);
    });
    const offPreview = usePreviewStore.subscribe((state) => contextKeys.set("editor.editMode", state.editMode));
    contextKeys.set("editor.editMode", usePreviewStore.getState().editMode);
    return () => {
      offFrame();
      offTheme();
      offPreview();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setQuery(event.shiftKey ? ">" : "");
        setQuickOpen(true);
        return;
      }
      const key = [
        ...(event.ctrlKey ? ["ctrl"] : []),
        ...(event.metaKey ? ["meta"] : []),
        ...(event.altKey ? ["alt"] : []),
        ...(event.shiftKey ? ["shift"] : []),
        event.key.toLowerCase(),
      ].join("+");
      const binding = registry
        .getPlugins()
        .flatMap((plugin) => plugin.contributions?.keybindings || [])
        .find((binding) => binding.key.toLowerCase() === key && contextKeys.evalWhen(binding.when));
      if (binding) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void commands.execute(binding.command).catch((error) => toast.error(String(error)));
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [registry, registry.getRevision()]);
  useEffect(() => {
    if (!quickOpen) return;
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const needle = query.replace(/^>/, "").trim().toLowerCase();
      const commandItems = commands
        .getCommands()
        .map((id) => {
          const contribution = registry
            .getPlugins()
            .flatMap((plugin) => plugin.contributions?.commands || [])
            .find((command) => command.id === id);
          return { id, label: contribution?.title || id, when: contribution?.when, run: () => commands.execute(id) };
        })
        .filter((item) => contextKeys.evalWhen(item.when) && item.label.toLowerCase().includes(needle));
      const providers = registry
        .getPlugins()
        .flatMap((plugin) => plugin.contributions?.quickOpenProviders || [])
        .filter((provider) => !provider.prefix || query.startsWith(provider.prefix));
      const sources = await Promise.allSettled([
        ...providers.map((provider) =>
          Promise.resolve(
            provider.search(provider.prefix ? query.slice(provider.prefix.length) : query, controller.signal)
          )
        ),
        ...(host.workspace.currentPath && !query.startsWith(">")
          ? [
              fileApi
                .search({ path: host.workspace.currentPath, search: query, containSub: true, pageSize: 50 })
                .then((result) =>
                  (result.items || [])
                    .filter((file) => !file.isDir)
                    .map((file) => ({
                      id: file.path,
                      label: file.name,
                      description: file.path,
                      run: () => host.workspace.openFile(file),
                    }))
                ),
            ]
          : []),
      ]);
      if (controller.signal.aborted) return;
      setResults([
        ...commandItems,
        ...sources.flatMap((source) => (source.status === "fulfilled" ? source.value : [])),
      ]);
      setSearching(false);
    }, 100);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [quickOpen, query, registry.getRevision(), host.workspace.currentPath, contextRevision]);
  const close = () => {
    if (pick) pick.resolve(null);
    else setQuickOpen(false);
    setQuery("");
  };
  const selectedItems = pick
    ? pick.items.filter((item) => `${item.label} ${item.description || ""}`.toLowerCase().includes(query.toLowerCase()))
    : results;
  return (
    <>
      <Dialog
        open={Boolean(pick) || quickOpen}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="border-ide-border bg-ide-panel text-ide-text">
          <DialogTitle className="text-sm">{pick?.placeholder || (en ? "Quick Open" : "快速打开")}</DialogTitle>
          <DialogDescription className="sr-only">{en ? "Search and select" : "搜索并选择"}</DialogDescription>
          <input
            autoFocus
            aria-label={en ? "Search" : "搜索"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded border border-ide-border bg-ide-bg px-3 py-2 text-sm outline-none focus:border-ide-accent"
          />
          <div className="max-h-[50dvh] overflow-y-auto">
            {searching && quickOpen && <Loader2 className="size-4 animate-spin" />}
            {selectedItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className="flex min-h-11 w-full flex-col border-b border-ide-border px-2 py-2 text-left text-xs hover:bg-ide-bg md:min-h-8"
                onClick={() => {
                  if (pick) pick.resolve(item);
                  else {
                    setQuickOpen(false);
                    void Promise.resolve((item as QuickOpenItem).run()).catch((error) => toast.error(String(error)));
                  }
                  setQuery("");
                }}
              >
                <span className="flex items-center gap-2">
                  {item.icon && <item.icon size={14} />}
                  {item.label}
                </span>
                {item.description && <span className="text-ide-mute">{item.description}</span>}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {progress.length > 0 && (
        <div
          className="absolute bottom-14 right-2 z-30 w-64 border border-ide-border bg-ide-panel p-2 text-xs"
          role="status"
        >
          {progress.map((item) => (
            <div key={item.id} className="py-1">
              <div className="flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" />
                <span className="flex-1 truncate">{item.step || item.title}</span>
                {item.cancellable && (
                  <button
                    type="button"
                    aria-label={en ? "Cancel" : "取消"}
                    disabled={item.controller.signal.aborted}
                    onClick={() => item.controller.abort()}
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <progress
                aria-label={item.title}
                value={item.percent}
                max={100}
                className="h-1 w-full accent-ide-accent"
              />
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={en ? "Quick Open" : "快速打开"}
        className="sr-only"
        onClick={() => setQuickOpen(true)}
      >
        <Search size={14} />
      </button>
    </>
  );
}
