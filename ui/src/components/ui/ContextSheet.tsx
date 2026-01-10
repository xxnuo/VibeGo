import React from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "./drawer";

export interface ContextMenuItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}

export interface ContextSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  items: ContextMenuItem[];
}

const ContextSheet: React.FC<ContextSheetProps> = ({
  open,
  onClose,
  title,
  items,
}) => {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="bg-ide-panel border-ide-border">
        {title && (
          <DrawerHeader className="pb-2">
            <DrawerTitle className="text-ide-text text-sm">{title}</DrawerTitle>
          </DrawerHeader>
        )}
        <div className="p-2 space-y-1">
          {items.map((item, index) => (
            <button
              key={index}
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-left ${
                item.variant === "danger"
                  ? "text-red-500 hover:bg-red-500/10"
                  : "text-ide-text hover:bg-ide-bg"
              }`}
            >
              <span
                className={
                  item.variant === "danger" ? "text-red-500" : "text-ide-mute"
                }
              >
                {item.icon}
              </span>
              <span className="text-sm">{item.label}</span>
            </button>
          ))}
        </div>
        <div className="h-6" />
      </DrawerContent>
    </Drawer>
  );
};

export default ContextSheet;
