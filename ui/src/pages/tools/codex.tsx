import { Bot } from "lucide-react";
import React from "react";
import { CodexPage } from "@/components/codex";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";

const CodexView: React.FC<PageViewProps> = ({ context }) => <CodexPage context={context} />;

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
  View: CodexView,
});

export default CodexView;
