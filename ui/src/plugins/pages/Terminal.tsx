import React from "react";
import { Terminal } from "lucide-react";
import { registerPlugin, type PluginViewProps } from "../registry";
import TerminalPage from "@/components/TerminalPage";

const TerminalPluginView: React.FC<PluginViewProps> = () => {
  return <TerminalPage />;
};

registerPlugin({
  id: "terminal",
  name: "Terminal",
  nameKey: "plugin.terminal.name",
  icon: Terminal,
  order: 1,
  view: TerminalPluginView,
});

export default TerminalPluginView;
