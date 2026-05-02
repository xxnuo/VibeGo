import React from "react";
import WorkbenchHeader from "@/components/frame/workbench-header";
import { useFrameStore } from "@/stores/frame-store";

const TopBar: React.FC = () => {
  const show = useFrameStore((s) => s.topBarConfig.show);
  return show ? <WorkbenchHeader /> : null;
};

export default TopBar;
