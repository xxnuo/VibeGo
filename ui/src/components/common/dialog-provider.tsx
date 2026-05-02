import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Locale, useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import { cn } from "@/lib/utils";

type DialogType = "alert" | "confirm" | "prompt";

interface DialogState {
  type: DialogType;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "default" | "danger";
  resolve: (value: boolean | string | null) => void;
}

interface DialogContextType {
  alert: (title: string, message?: string) => Promise<void>;
  confirm: (
    title: string,
    message?: string,
    options?: { confirmText?: string; cancelText?: string; confirmVariant?: "default" | "danger" }
  ) => Promise<boolean>;
  prompt: (
    title: string,
    options?: { defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string }
  ) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextType | null>(null);

export const useDialog = () => {
  const context = useContext(DialogContext);
  if (!context) throw new Error("useDialog must be used within DialogProvider");
  return context;
};

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [viewportInset, setViewportInset] = useState(0);
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);

  const alert = useCallback((title: string, message?: string): Promise<void> => {
    return new Promise((resolve) => {
      setDialog({
        type: "alert",
        title,
        message,
        resolve: () => resolve(),
      });
    });
  }, []);

  const confirm = useCallback(
    (
      title: string,
      message?: string,
      options?: { confirmText?: string; cancelText?: string; confirmVariant?: "default" | "danger" }
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        setDialog({
          type: "confirm",
          title,
          message,
          confirmText: options?.confirmText,
          cancelText: options?.cancelText,
          confirmVariant: options?.confirmVariant,
          resolve: (value) => resolve(value as boolean),
        });
      });
    },
    []
  );

  const prompt = useCallback(
    (
      title: string,
      options?: { defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string }
    ): Promise<string | null> => {
      setInputValue(options?.defaultValue || "");
      return new Promise((resolve) => {
        setDialog({
          type: "prompt",
          title,
          defaultValue: options?.defaultValue,
          placeholder: options?.placeholder,
          confirmText: options?.confirmText,
          cancelText: options?.cancelText,
          resolve: (value) => resolve(value as string | null),
        });
      });
    },
    []
  );

  const handleClose = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === "alert") {
      dialog.resolve(true);
    } else {
      dialog.resolve(dialog.type === "confirm" ? false : null);
    }
    setDialog(null);
    setInputValue("");
  }, [dialog]);

  const handleConfirm = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === "prompt") {
      dialog.resolve(inputValue);
    } else {
      dialog.resolve(true);
    }
    setDialog(null);
    setInputValue("");
  }, [dialog, inputValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && dialog?.type === "prompt") {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "Escape") {
        handleClose();
      }
    },
    [dialog, handleConfirm, handleClose]
  );

  useEffect(() => {
    if (!dialog) {
      setViewportInset(0);
      return;
    }

    const updateInset = () => {
      const vv = window.visualViewport;
      if (!vv) {
        setViewportInset(0);
        return;
      }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setViewportInset(inset);
    };

    updateInset();
    window.visualViewport?.addEventListener("resize", updateInset);
    window.visualViewport?.addEventListener("scroll", updateInset);
    window.addEventListener("orientationchange", updateInset);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("scroll", updateInset);
      window.removeEventListener("orientationchange", updateInset);
    };
  }, [dialog]);

  return (
    <DialogContext.Provider value={{ alert, confirm, prompt }}>
      {children}
      <Dialog open={!!dialog} onOpenChange={(open) => !open && handleClose()}>
        {dialog && (
          <DialogContent
            showCloseButton={false}
            onKeyDown={handleKeyDown}
            style={{ "--dialog-bottom": viewportInset ? `${viewportInset}px` : undefined } as React.CSSProperties}
            className="border-ide-border bg-ide-panel text-ide-text shadow-sm md:max-w-md"
          >
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="text-base leading-6 text-ide-text">{dialog.title}</DialogTitle>
              {dialog.message && (
                <DialogDescription className="text-sm leading-6 text-ide-mute">{dialog.message}</DialogDescription>
              )}
            </DialogHeader>
            {dialog.type === "prompt" && (
              <div>
                <Input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={dialog.placeholder || ""}
                  autoFocus
                  className="border-ide-border bg-ide-bg text-ide-text placeholder:text-ide-mute focus-visible:ring-ide-accent/30"
                />
              </div>
            )}
            <DialogFooter className="gap-3 pt-3 md:flex-row">
              {dialog.type !== "alert" && (
                <Button
                  variant="outline"
                  onClick={handleClose}
                  className="h-11 w-full border-ide-border bg-ide-panel text-ide-text hover:bg-ide-bg md:w-auto"
                >
                  {dialog.cancelText || t("common.cancel")}
                </Button>
              )}
              <Button
                variant={dialog.confirmVariant === "danger" ? "destructive" : "default"}
                onClick={handleConfirm}
                className={cn(
                  "h-11 w-full md:w-auto",
                  dialog.confirmVariant === "danger"
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : "bg-ide-accent text-ide-on-accent hover:bg-ide-accent/90"
                )}
                autoFocus={dialog.type !== "prompt"}
              >
                {dialog.confirmText || (dialog.type === "alert" ? t("dialog.ok") : t("dialog.confirm"))}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </DialogContext.Provider>
  );
};
