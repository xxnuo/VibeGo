import React, { useEffect } from "react";
import { Activity, RefreshCw, Square } from "lucide-react";
import { useFrameStore } from "@/stores/frameStore";
import { registerPlugin, type PluginViewProps } from "../registry";

const ProcessMonitorView: React.FC<PluginViewProps> = ({ isActive }) => {
  const setPageMenuItems = useFrameStore((s) => s.setPageMenuItems);

  useEffect(() => {
    if (!isActive) return;
    setPageMenuItems([
      {
        id: "refresh-processes",
        icon: <RefreshCw size={20} />,
        label: "Refresh",
        onClick: () => {
          console.log("Refresh process list");
        },
      },
      {
        id: "kill-process",
        icon: <Square size={20} />,
        label: "Kill Process",
        onClick: () => {
          console.log("Kill selected process");
        },
      },
    ]);
    return () => setPageMenuItems([]);
  }, [isActive, setPageMenuItems]);

  return (
    <div className="h-full flex flex-col bg-ide-bg">
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-ide-mute">
          <Activity size={48} className="mx-auto mb-4 opacity-50" />
          <h2 className="text-lg font-medium text-ide-text mb-2">
            Process Monitor
          </h2>
          <p className="text-sm">
            This plugin demonstrates how to create a custom page with its own
            menu items.
          </p>
          <p className="text-xs mt-4">
            In a real implementation, this would display a terminal running{" "}
            <code className="bg-ide-panel px-1 rounded">top</code> or{" "}
            <code className="bg-ide-panel px-1 rounded">htop</code>.
          </p>
        </div>
      </div>
    </div>
  );
};

registerPlugin({
  id: "process-monitor",
  name: "Process Monitor",
  icon: Activity,
  order: 10,
  view: ProcessMonitorView,
  getMenuItems: () => [
    {
      id: "launch-monitor",
      icon: <Activity size={20} />,
      label: "Open Monitor",
    },
  ],
});

export default ProcessMonitorView;
