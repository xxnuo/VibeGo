import {
  Activity,
  Bot,
  Files,
  GitGraph,
  Home,
  Keyboard as KeyboardIcon,
  MonitorUp,
  Network,
  Radius,
  Settings,
  Terminal,
} from "lucide-react";
import { lazy } from "react";
import { registerPage } from "@/pages/registry";

export { pageRegistry, registerPage, unregisterPage } from "@/pages/registry";
export type { PageCategory, PageContext, PageDefinition, PageId, PageViewProps } from "@/pages/types";

registerPage({
  id: "ai-session-manager",
  name: "AI Sessions",
  nameKey: "plugin.aiSessionManager.name",
  descriptionKey: "plugin.aiSessionManager.description",
  icon: Bot,
  category: "tool",
  order: 20,
  singleton: true,
  View: lazy(() => import("@/pages/tools/ai-session-manager")),
});

registerPage({
  id: "codex",
  name: "Codex",
  nameKey: "plugin.codex.name",
  descriptionKey: "plugin.codex.description",
  icon: Bot,
  category: "tool",
  order: 12,
  singleton: true,
  newPageDefaultVisible: true,
  View: lazy(() => import("@/pages/tools/codex")),
});

registerPage({
  id: "home",
  name: "Home",
  nameKey: "common.home",
  icon: Home,
  category: "system",
  order: 0,
  View: lazy(() => import("@/pages/system/home")),
});

registerPage({
  id: "settings",
  name: "Settings",
  nameKey: "common.settings",
  icon: Settings,
  category: "system",
  order: 1,
  View: lazy(() => import("@/pages/system/settings")),
});

registerPage({
  id: "process-monitor",
  name: "Process Monitor",
  nameKey: "plugin.processMonitor.name",
  descriptionKey: "plugin.processMonitor.description",
  icon: Activity,
  order: 10,
  category: "tool",
  singleton: true,
  View: lazy(() => import("@/pages/tools/process-monitor")),
});

registerPage({
  id: "port-manager",
  name: "Port Manager",
  nameKey: "plugin.portManager.name",
  descriptionKey: "plugin.portManager.description",
  icon: Network,
  order: 12,
  category: "tool",
  singleton: true,
  View: lazy(() => import("@/pages/tools/port-manager")),
});

registerPage({
  id: "files",
  name: "Files",
  nameKey: "sidebar.files",
  icon: Files,
  category: "workspace",
  order: 10,
  View: lazy(() => import("@/pages/workspace/files")),
});

registerPage({
  id: "git",
  name: "Git",
  nameKey: "sidebar.git",
  icon: GitGraph,
  category: "workspace",
  order: 20,
  View: lazy(() => import("@/pages/workspace/git")),
});

registerPage({
  id: "terminal",
  name: "Terminal",
  nameKey: "sidebar.terminal",
  icon: Terminal,
  category: "workspace",
  order: 1,
  View: lazy(() => import("@/pages/workspace/terminal")),
});

registerPage({
  id: "remote-control",
  name: "Remote Control",
  nameKey: "plugin.remoteControl.name",
  descriptionKey: "plugin.remoteControl.description",
  icon: Radius,
  order: 15,
  category: "tool",
  singleton: true,
  View: lazy(() => import("@/pages/tools/remote-control")),
});

registerPage({
  id: "remote-desktop",
  name: "Remote Desktop",
  nameKey: "plugin.remoteDesktop.name",
  descriptionKey: "plugin.remoteDesktop.description",
  icon: MonitorUp,
  order: 16,
  category: "tool",
  singleton: true,
  View: lazy(() => import("@/pages/tools/remote-desktop")),
});

registerPage({
  id: "keyboard-test",
  name: "Keyboard Test",
  nameKey: "plugin.keyboardTest.name",
  descriptionKey: "plugin.keyboardTest.description",
  icon: KeyboardIcon,
  order: 20,
  category: "tool",
  singleton: true,
  newPageDefaultVisible: false,
  tags: [{ labelKey: "pageTag.test" }],
  View: lazy(() => import("@/pages/tools/keyboard-test")),
});
