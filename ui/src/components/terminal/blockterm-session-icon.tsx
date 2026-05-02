import {
  Cloud,
  Compass,
  Crown,
  Droplet,
  File,
  Flame,
  Ghost,
  GraduationCap,
  Heart,
  type LucideIcon,
  Sparkle,
  Square,
} from "lucide-react";
import React from "react";
import {
  type BlockTermTabColor,
  type BlockTermTabIcon,
  normalizeBlockTermTabColor,
  normalizeBlockTermTabIcon,
} from "@/components/terminal/blockterm-session-settings";
import { cn } from "@/lib/utils";

const BLOCKTERM_TAB_ICON_COMPONENTS: Record<BlockTermTabIcon, LucideIcon> = {
  default: Square,
  square: Square,
  sparkle: Sparkle,
  fire: Flame,
  ghost: Ghost,
  cloud: Cloud,
  compass: Compass,
  crown: Crown,
  droplet: Droplet,
  "graduation-cap": GraduationCap,
  heart: Heart,
  file: File,
};

const BLOCKTERM_TAB_COLOR_VALUES: Partial<Record<BlockTermTabColor, string>> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  mint: "#34d399",
  cyan: "#06b6d4",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
  white: "#f8fafc",
};

export interface BlockTermSessionIconProps {
  icon?: BlockTermTabIcon | string | null;
  color?: BlockTermTabColor | string | null;
  size?: number;
  className?: string;
}

export const BlockTermSessionIcon: React.FC<BlockTermSessionIconProps> = ({ icon, color, size = 16, className }) => {
  const normalizedIcon = normalizeBlockTermTabIcon(icon);
  const normalizedColor = normalizeBlockTermTabColor(color);
  const Icon = BLOCKTERM_TAB_ICON_COMPONENTS[normalizedIcon];

  return (
    <Icon
      aria-hidden="true"
      data-blockterm-session-icon={normalizedIcon}
      data-blockterm-session-color={normalizedColor}
      size={size}
      strokeWidth={2}
      className={cn(
        "shrink-0 text-ide-accent",
        normalizedColor === "white" && "drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]",
        className
      )}
      style={
        BLOCKTERM_TAB_COLOR_VALUES[normalizedColor] ? { color: BLOCKTERM_TAB_COLOR_VALUES[normalizedColor] } : undefined
      }
    />
  );
};

export default BlockTermSessionIcon;
