import type React from "react";
import type { PageDefinition } from "@/pages/types";

export type WorkbenchLocation = "header-left" | "header-right" | "editor-title";

export interface WorkbenchAction {
  id: string;
  icon: React.ReactNode;
  title: string;
  ariaLabel?: string;
  onClick: () => void | Promise<void>;
  active?: boolean;
  disabled?: boolean;
  order?: number;
}

export type WorkbenchPageDefinition = PageDefinition;

export type { PageCategory, PageContext, PageId, PageViewProps } from "@/pages/types";
export type { TabItem } from "@/stores/frame-store";
