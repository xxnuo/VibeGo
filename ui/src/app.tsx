import React, { useCallback, useEffect, useState } from "react";
import { authApi } from "@/api/auth";
import { fileApi } from "@/api/file";
import { DirectoryPicker, NewPageMenu, ProjectMenu } from "@/components/common";
import { AppFrame, NewGroupMenu } from "@/components/frame";
import { getStoredAuthKey, LoginPage, setStoredAuthKey } from "@/components/login-page";
import BlockTermWorkspaceNavigator from "@/components/terminal/blockterm-workspace-navigator";
import { Toaster } from "@/components/ui/sonner";
import { isCustomFontValue, resolveFontFamily } from "@/lib/fonts";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import { pageRegistry } from "@/pages/registry";
import { shouldBlockTerminalBrowserUnload } from "@/services/terminal-browser-shortcut-guard";
import { initTerminalCleanup } from "@/services/terminal-cleanup-service";
import {
  getOrCreateFileManagerStore,
  type Locale,
  type Theme,
  useAppStore,
  useFrameStore,
  usePreviewStore,
  useSessionStore,
} from "@/stores";
import type { GenericGroup, ToolGroup } from "@/stores/frame-store";
import * as gitStoreModule from "@/stores/git-store";
import { enqueueWorkspaceMutation } from "@/stores/session-store";
import "@/pages";

const App: React.FC = () => {
  const { theme, locale, isMenuOpen, setMenuOpen, setTheme, setLocale } = useAppStore();
  const t = useTranslation(locale);

  const [authChecked, setAuthChecked] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);

  const resetPreview = usePreviewStore((s) => s.reset);
  const initSettings = useSettingsStore((s) => s.init);
  const themeSetting = useSettingsStore((s) => s.settings.theme);
  const localeSetting = useSettingsStore((s) => s.settings.locale);
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily);
  const fontFallbackFamily = useSettingsStore((s) => s.settings.fontFallbackFamily);

  const activeGroup = useFrameStore((s) => s.getActiveGroup());
  const currentPage = useFrameStore((s) => s.getCurrentPage());
  const activeTabId = useFrameStore((s) => s.getCurrentActiveTabId());
  const addToolGroup = useFrameStore((s) => s.addToolGroup);
  const addTerminalGroup = useFrameStore((s) => s.addTerminalGroup);
  const addSettingsGroup = useFrameStore((s) => s.addSettingsGroup);
  const initDefaultGroups = useFrameStore((s) => s.initDefaultGroups);
  const showHomePage = useFrameStore((s) => s.showHomePage);

  const openFolder = useSessionStore((s) => s.openFolder);
  const saveCurrentSession = useSessionStore((s) => s.saveCurrentSession);
  const refreshCurrentSession = useSessionStore((s) => s.refreshCurrentSession);

  const [isNewGroupMenuOpen, setNewGroupMenuOpen] = useState(false);
  const [isNewPageMenuOpen, setNewPageMenuOpen] = useState(false);
  const [isDirectoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  useEffect(() => {
    initSettings();
    initTerminalCleanup(enqueueWorkspaceMutation);
  }, [initSettings]);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const status = await authApi.status();
        if (status.need_login) {
          const storedKey = getStoredAuthKey();
          if (storedKey) {
            try {
              const loginRes = await authApi.login(storedKey);
              if (loginRes.ok) {
                setNeedLogin(false);
                setAuthChecked(true);
                return;
              }
            } catch {}
            setStoredAuthKey(null);
          }
          setNeedLogin(true);
        } else {
          setNeedLogin(false);
        }
      } catch {
        setNeedLogin(false);
      }
      setAuthChecked(true);
    };
    checkAuth();
  }, []);

  const initSession = useSessionStore((s) => s.initSession);

  useEffect(() => {
    if (!authChecked || needLogin) return;
    const init = async () => {
      const initializationRevision = useSessionStore.getState().workspaceRevision;
      const hasSession = await initSession();
      const sessionState = useSessionStore.getState();
      if (
        !hasSession &&
        sessionState.workspaceRevision === initializationRevision &&
        sessionState.currentSessionId === null &&
        !sessionState.loading &&
        sessionState.sessionInitialized
      ) {
        initDefaultGroups();
      }
    };
    init();
  }, [initSession, initDefaultGroups, authChecked, needLogin]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      saveCurrentSession();
      if (shouldBlockTerminalBrowserUnload()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentSession]);

  useEffect(() => {
    if (!authChecked || needLogin) return;

    const handleFocus = () => {
      void refreshCurrentSession();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshCurrentSession();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [authChecked, needLogin, refreshCurrentSession]);

  useEffect(() => {
    if (themeSetting) setTheme(themeSetting as Theme);
  }, [themeSetting, setTheme]);

  useEffect(() => {
    if (localeSetting) setLocale(localeSetting as Locale);
  }, [localeSetting, setLocale]);

  useEffect(() => {
    if (isCustomFontValue(fontFamily)) {
      const resolvedFontFamily = resolveFontFamily(fontFamily, undefined, fontFallbackFamily);
      document.body.removeAttribute("data-font");
      document.body.style.setProperty("--font-sans", resolvedFontFamily);
      document.body.style.setProperty("--font-mono", resolvedFontFamily);
      document.body.style.fontFamily = resolvedFontFamily;
    } else if (fontFamily && fontFamily !== "default") {
      const resolvedFontFamily = resolveFontFamily(fontFamily, undefined, fontFallbackFamily);
      document.body.setAttribute("data-font", fontFamily);
      document.body.style.setProperty("--font-sans", resolvedFontFamily);
      document.body.style.setProperty("--font-mono", resolvedFontFamily);
      document.body.style.removeProperty("font-family");
    } else if (fontFallbackFamily && fontFallbackFamily !== "default") {
      const resolvedFontFamily = resolveFontFamily(fontFamily, undefined, fontFallbackFamily);
      document.body.removeAttribute("data-font");
      document.body.style.setProperty("--font-sans", resolvedFontFamily);
      document.body.style.setProperty("--font-mono", resolvedFontFamily);
      document.body.style.fontFamily = resolvedFontFamily;
    } else {
      document.body.removeAttribute("data-font");
      document.body.style.removeProperty("--font-sans");
      document.body.style.removeProperty("--font-mono");
      document.body.style.removeProperty("font-family");
    }
  }, [fontFamily, fontFallbackFamily]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.className = "";
    body.classList.remove("scanlines");
    switch (theme) {
      case "dark":
        root.classList.add("dark");
        break;
      case "hacker":
        root.classList.add("dark", "hacker");
        break;
      case "terminal":
        root.classList.add("dark", "terminal");
        body.classList.add("scanlines");
        break;
      case "ocean":
        root.classList.add("dark", "ocean");
        break;
      case "sunset":
        root.classList.add("dark", "sunset");
        break;
      case "nord":
        root.classList.add("dark", "nord");
        break;
      case "solarized":
        root.classList.add("dark", "solarized");
        break;
    }
  }, [theme]);

  const handleBackToList = useCallback(() => {
    resetPreview();
  }, [resetPreview]);

  const handleRefresh = useCallback(async () => {
    if (!activeGroup) return;

    if (activeGroup.type === "group") {
      const pageType = currentPage?.type;
      switch (pageType) {
        case "files": {
          const storeApi = getOrCreateFileManagerStore(activeGroup.id);
          storeApi.getState().setLoading(true);
          const path = storeApi.getState().currentPath;
          try {
            const res = await fileApi.list(path);
            const files = (res.files ?? []).map((f) => ({
              path: f.path,
              name: f.name,
              size: f.size,
              isDir: f.isDir,
              isSymlink: f.isSymlink,
              isHidden: f.isHidden,
              mode: f.mode,
              mimeType: f.mimeType,
              modTime: f.modTime,
              extension: f.extension,
            }));
            storeApi.getState().setFiles(files);
          } finally {
            storeApi.getState().setLoading(false);
          }
          break;
        }
        case "git": {
          const gitStore = gitStoreModule.getOrCreateGitStore(activeGroup.id);
          const state = gitStore.getState();
          await Promise.allSettled([
            state.fetchStatus(),
            state.fetchBranches(),
            state.fetchBranchStatus(),
            state.fetchRemotes(),
            state.fetchStashes(),
            state.fetchConflicts(),
            state.fetchLog(),
          ]);
          break;
        }
        case "terminal":
          break;
      }
    }
  }, [activeGroup, currentPage]);

  const handleOpenDirectory = useCallback(() => {
    setDirectoryPickerOpen(true);
  }, []);

  const handleDirectorySelect = useCallback(
    async (path: string) => {
      await openFolder(path);
      setDirectoryPickerOpen(false);
    },
    [openFolder]
  );

  const handleNewTool = useCallback(
    (pageId: string) => {
      addToolGroup(pageId, pageId);
    },
    [addToolGroup]
  );

  const renderToolPage = (group: ToolGroup) => {
    const page = pageRegistry.get(group.pageId);
    if (!page) {
      return (
        <div className="h-full flex items-center justify-center text-ide-mute">
          {t("common.pageNotFound")}: {group.pageId}
        </div>
      );
    }
    const View = page.View;
    return <View context={{ groupId: group.id, tabId: activeTabId, isActive: true }} />;
  };

  const renderGroupPage = (group: GenericGroup) => {
    if (!currentPage) return null;

    const page = pageRegistry.get(currentPage.type);
    if (!page) {
      return (
        <div className="h-full flex items-center justify-center text-ide-mute">
          {t("common.pageNotFound")}: {currentPage.type}
        </div>
      );
    }
    const View = page.View;
    return <View context={{ groupId: group.id, tabId: activeTabId, isActive: true, path: currentPage.path }} />;
  };

  const renderContent = () => {
    if (!activeGroup) return null;

    switch (activeGroup.type) {
      case "home": {
        const page = pageRegistry.get("home");
        if (!page) return null;
        const View = page.View;
        return <View context={{ groupId: activeGroup.id, tabId: null, isActive: true }} />;
      }
      case "settings": {
        const page = pageRegistry.get("settings");
        if (!page) return null;
        const View = page.View;
        return <View context={{ groupId: activeGroup.id, tabId: null, isActive: true }} />;
      }
      case "tool":
        return renderToolPage(activeGroup);
      case "group":
        return renderGroupPage(activeGroup);
      default:
        return null;
    }
  };

  if (!authChecked) {
    return null;
  }

  if (needLogin) {
    return <LoginPage locale={locale} onLoginSuccess={() => setNeedLogin(false)} />;
  }

  return (
    <>
      <AppFrame
        onMenuOpen={() => setMenuOpen(true)}
        onRefresh={handleRefresh}
        onBackToList={handleBackToList}
        onNewPage={() => setNewPageMenuOpen(true)}
      >
        {renderContent()}
      </AppFrame>
      <BlockTermWorkspaceNavigator />
      <ProjectMenu
        isOpen={isMenuOpen}
        onClose={() => setMenuOpen(false)}
        locale={locale}
        onOpenDirectory={handleOpenDirectory}
        onOpenSettings={addSettingsGroup}
        onShowHomePage={showHomePage}
        onNewPage={() => setNewPageMenuOpen(true)}
      />
      <NewPageMenu
        isOpen={isNewPageMenuOpen}
        onClose={() => setNewPageMenuOpen(false)}
        locale={locale}
        onOpenDirectory={handleOpenDirectory}
        onNewTerminal={addTerminalGroup}
        onNewTool={handleNewTool}
      />
      <NewGroupMenu
        isOpen={isNewGroupMenuOpen}
        onClose={() => setNewGroupMenuOpen(false)}
        locale={locale}
        onOpenDirectory={handleOpenDirectory}
        onNewTool={handleNewTool}
        availableTools={[
          { id: "claude-code", name: "Claude Code" },
          { id: "gemini-cli", name: "Gemini CLI" },
        ]}
      />
      <DirectoryPicker
        isOpen={isDirectoryPickerOpen}
        onClose={() => setDirectoryPickerOpen(false)}
        onSelect={handleDirectorySelect}
        initialPath="."
        locale={locale}
      />
      <Toaster />
    </>
  );
};

export default App;
