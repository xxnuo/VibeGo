import { ArrowUpDown, Check, GripVertical, SquareStack, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { useReorderableList } from "@/hooks/use-reorderable-list";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores";

export interface TaskbarSortEntry {
  id: string;
  title: string;
  icon: React.ReactNode;
  badge?: string | number;
}

interface TaskbarItemMenuProps {
  title: string;
  children: React.ReactElement;
  onActivate: () => void;
  onClose?: () => void | Promise<void>;
  onCloseOthers?: () => void | Promise<void>;
  onCloseAll?: () => void | Promise<void>;
  onSort: () => void;
  canClose?: boolean;
  canCloseOthers?: boolean;
  canCloseAll?: boolean;
}

interface TaskbarSortDialogProps {
  open: boolean;
  title: string;
  entries: TaskbarSortEntry[];
  onOpenChange: (open: boolean) => void;
  onApply: (order: string[]) => void;
}

const LONG_PRESS_DELAY = 600;
const MOVE_THRESHOLD = 8;
const SHEET_TRANSITION = { type: "spring", stiffness: 420, damping: 38, mass: 0.7 } as const;
const DIALOG_TRANSITION = { type: "spring", stiffness: 380, damping: 34, mass: 0.72 } as const;

const reorderIds = (ids: string[], fromId: string, toId: string) => {
  if (fromId === toId) return ids;
  const fromIndex = ids.indexOf(fromId);
  const toIndex = ids.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1) return ids;
  const next = [...ids];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
};

interface ConfirmState {
  title: string;
  description: string;
  action: () => void | Promise<void>;
}

interface MotionMenuProps {
  open: boolean;
  title: string;
  items: Array<{ icon: React.ReactNode; label: string; variant?: "default" | "danger"; onClick: () => void }>;
  onClose: () => void;
}

interface MotionConfirmDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const MotionMenu: React.FC<MotionMenuProps> = ({ open, title, items, onClose }) => {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            type="button"
            aria-label={title}
            className="absolute inset-0 bg-black/35"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-ide-border bg-ide-panel p-2 pb-safe shadow-[0_-14px_40px_rgba(0,0,0,0.22)]"
            initial={{ y: 28, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 28, opacity: 0 }}
            transition={SHEET_TRANSITION}
          >
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ide-border/80" />
            <div className="max-h-[60vh] overflow-y-auto space-y-1">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    item.onClick();
                    onClose();
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                    item.variant === "danger" ? "text-red-500 hover:bg-red-500/10" : "text-ide-text hover:bg-ide-bg"
                  )}
                >
                  <span className={cn(item.variant === "danger" ? "text-red-500" : "text-ide-mute")}>{item.icon}</span>
                  <span className="text-sm">{item.label}</span>
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

const MotionConfirmDialog: React.FC<MotionConfirmDialogProps> = ({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}) => {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
          <motion.button
            type="button"
            aria-label={title}
            className="absolute inset-0 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onCancel}
          />
          <motion.div
            className="relative z-10 w-full border-t border-ide-border bg-background p-4 pb-5 shadow-lg md:max-w-lg md:rounded-2xl md:border md:p-6 md:pb-6"
            initial={{ y: 18, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0, scale: 0.98 }}
            transition={DIALOG_TRANSITION}
          >
            <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-muted md:hidden" />
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-foreground">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="mt-5 flex flex-col-reverse gap-3 md:flex-row md:justify-end">
              <Button variant="outline" onClick={onCancel}>
                {cancelLabel}
              </Button>
              <Button variant="destructive" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export const TaskbarItemMenu: React.FC<TaskbarItemMenuProps> = ({
  title,
  children,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSort,
  canClose = false,
  canCloseOthers = false,
  canCloseAll = false,
}) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => () => clearLongPress(), []);

  const menuItems = useMemo(() => {
    const items: Array<{ icon: React.ReactNode; label: string; variant?: "default" | "danger"; onClick: () => void }> = [
      { icon: <Check size={16} />, label: t("common.activate"), onClick: onActivate },
    ];
    if (canClose) {
      items.push({
        icon: <X size={16} />,
        label: t("common.close"),
        variant: "danger",
        onClick: () => {
          setPendingConfirm({
            title: t("common.closeConfirmTitle"),
            description: t("common.closeConfirmMessage").replace("{name}", title),
            action: () => onClose?.(),
          });
        },
      });
    }
    if (canCloseOthers) {
      items.push({
        icon: <SquareStack size={16} />,
        label: t("common.closeOthers"),
        variant: "danger",
        onClick: () => {
          setPendingConfirm({
            title: t("common.closeConfirmTitle"),
            description: t("common.closeOthersConfirmMessage").replace("{name}", title),
            action: () => onCloseOthers?.(),
          });
        },
      });
    }
    if (canCloseAll) {
      items.push({
        icon: <ArrowUpDown size={16} />,
        label: t("common.closeAll"),
        variant: "danger",
        onClick: () => {
          setPendingConfirm({
            title: t("common.closeConfirmTitle"),
            description: t("common.closeAllConfirmMessage"),
            action: () => onCloseAll?.(),
          });
        },
      });
    }
    items.push({
      icon: <GripVertical size={16} />,
      label: t("common.sort"),
      onClick: onSort,
    });
    return items;
  }, [canClose, canCloseAll, canCloseOthers, onActivate, onClose, onCloseAll, onCloseOthers, onSort, t]);

  if (isMobile) {
    const element = children as React.ReactElement<any>;
    const mobileChild = React.cloneElement(element, {
      onPointerDown: (event: React.PointerEvent) => {
        element.props.onPointerDown?.(event);
        if (event.pointerType !== "touch") return;
        touchStartRef.current = { x: event.clientX, y: event.clientY };
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          suppressClickRef.current = true;
          setOpen(true);
        }, LONG_PRESS_DELAY);
      },
      onPointerMove: (event: React.PointerEvent) => {
        element.props.onPointerMove?.(event);
        if (event.pointerType !== "touch" || !longPressTimer.current) return;
        if (Math.hypot(event.clientX - touchStartRef.current.x, event.clientY - touchStartRef.current.y) > MOVE_THRESHOLD) {
          clearLongPress();
        }
      },
      onPointerUp: (event: React.PointerEvent) => {
        element.props.onPointerUp?.(event);
        clearLongPress();
      },
      onPointerCancel: (event: React.PointerEvent) => {
        element.props.onPointerCancel?.(event);
        clearLongPress();
      },
      onContextMenu: (event: React.MouseEvent) => {
        element.props.onContextMenu?.(event);
        event.preventDefault();
      },
      onClickCapture: (event: React.MouseEvent) => {
        element.props.onClickCapture?.(event);
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      },
    });

    return (
      <>
        {mobileChild}
        <MotionMenu
          open={open}
          title={title}
          items={menuItems.map((item) => ({
            icon: item.icon,
            label: item.label,
            variant: item.variant === "danger" ? "danger" : "default",
            onClick: () => {
              item.onClick();
              setOpen(false);
            },
          }))}
          onClose={() => setOpen(false)}
        />
        <MotionConfirmDialog
          open={!!pendingConfirm}
          title={pendingConfirm?.title}
          description={pendingConfirm?.description}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("dialog.confirm")}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            void pendingConfirm?.action();
            setPendingConfirm(null);
          }}
        />
      </>
    );
  }

  const element = children as React.ReactElement<any>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{element}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {menuItems.map((item, index) => (
          <React.Fragment key={item.label}>
            {index === 1 && canClose && <ContextMenuSeparator />}
            <ContextMenuItem
              className={cn(item.variant === "danger" && "text-red-500 focus:text-red-500")}
              onSelect={(event) => {
                event.preventDefault();
                item.onClick();
              }}
            >
              {item.label}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
      <MotionConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.title}
        description={pendingConfirm?.description}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("dialog.confirm")}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          void pendingConfirm?.action();
          setPendingConfirm(null);
        }}
      />
    </ContextMenu>
  );
};

export const TaskbarSortDialog: React.FC<TaskbarSortDialogProps> = ({ open, title, entries, onOpenChange, onApply }) => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const [order, setOrder] = useState<string[]>(entries.map((entry) => entry.id));

  useEffect(() => {
    if (open) {
      setOrder(entries.map((entry) => entry.id));
    }
  }, [entries, open]);

  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const orderedEntries = useMemo(
    () => order.map((id) => entryMap.get(id)).filter((entry): entry is TaskbarSortEntry => Boolean(entry)),
    [entryMap, order]
  );

  const reorder = useReorderableList({
    ids: order,
    axis: "y",
    onReorder: (fromId, toId) => setOrder((current) => reorderIds(current, fromId, toId)),
    dragScale: 1,
    disabled: order.length < 2,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[56vh] space-y-2 overflow-y-auto overflow-x-hidden pr-1">
          {orderedEntries.map((entry) => (
            <motion.div
              key={entry.id}
              layout={reorder.activeId !== entry.id}
              transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
              {...reorder.bindItem(entry.id)}
              className={cn(
                "flex items-center gap-3 border border-ide-border bg-ide-bg px-3 py-2.5 transition-shadow",
                reorder.activeId === entry.id && "z-50 opacity-95 shadow-lg cursor-grabbing",
                reorder.overId === entry.id && "ring-1 ring-ide-accent"
              )}
            >
              <span className="text-ide-mute">
                <GripVertical size={16} />
              </span>
              <span className="flex size-9 items-center justify-center text-ide-text">{entry.icon}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ide-text">{entry.title}</span>
              {entry.badge !== undefined && (
                <span className="shrink-0 rounded-full border border-ide-border px-2 py-0.5 text-[10px] text-ide-mute">
                  {entry.badge}
                </span>
              )}
            </motion.div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              onApply(order);
              onOpenChange(false);
            }}
          >
            {t("common.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
