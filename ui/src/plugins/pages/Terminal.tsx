import React, { useEffect } from "react";
import { Terminal, Plus } from "lucide-react";
import { useFrameStore } from "@/stores/frameStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { registerPlugin, type PluginViewProps } from "../registry";
import TerminalView from "@/components/TerminalView";

const TerminalPluginView: React.FC<PluginViewProps> = ({ isActive }) => {
  const setPageMenuItems = useFrameStore((s) => s.setPageMenuItems);
  const addCurrentTab = useFrameStore((s) => s.addCurrentTab);
  const tabs = useFrameStore((s) => s.getCurrentTabs());
  const { terminals, activeTerminalId } = useTerminalStore();

  useEffect(() => {
    if (!isActive) return;
    setPageMenuItems([
      {
        id: "new-terminal-tab",
        icon: <Plus size={20} />,
        label: "New Tab",
        onClick: () => {
          addCurrentTab({
            id: `term-${Date.now()}`,
            title: `Terminal ${tabs.length + 1}`,
            data: { type: "terminal" },
          });
        },
      },
    ]);
    return () => setPageMenuItems([]);
  }, [isActive, setPageMenuItems, addCurrentTab, tabs.length]);

  return (
    <TerminalView
      activeTerminalId={activeTerminalId || ""}
      terminals={terminals}
    />
  );
};

registerPlugin({
  id: "terminal",
  name: "Terminal",
  icon: Terminal,
  order: 1,
  view: TerminalPluginView,
});

export default TerminalPluginView;
