import React from "react";
import { CodexPage } from "@/components/codex";
import type { PageViewProps } from "@/pages/types";

const CodexView: React.FC<PageViewProps> = ({ context }) => <CodexPage context={context} />;

export default CodexView;
