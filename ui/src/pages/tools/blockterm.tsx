import React from "react";
import BlockTermPage from "@/components/blockterm/page";
import type { PageViewProps } from "@/pages/types";

const BlockTermView: React.FC<PageViewProps> = ({ context }) => {
  return <BlockTermPage groupId={context.groupId} cwd={context.path} />;
};

export default BlockTermView;
