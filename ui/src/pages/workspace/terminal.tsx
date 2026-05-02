import React from "react";
import { TerminalPage } from "@/components/terminal";
import type { PageViewProps } from "@/pages/types";

const TerminalWorkspaceView: React.FC<PageViewProps> = ({ context }) => {
  return <TerminalPage groupId={context.groupId} cwd={context.path} />;
};

export default TerminalWorkspaceView;
