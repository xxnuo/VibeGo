import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { type DialogRequest, DialogRequestQueue, getDialogCancelValue } from "@/components/common/dialog-queue";
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

type DialogOptions = { signal?: AbortSignal };

interface DialogContextType {
  alert: (title: string, message?: string, options?: DialogOptions) => Promise<void>;
  confirm: (
    title: string,
    message?: string,
    options?: { confirmText?: string; cancelText?: string; confirmVariant?: "default" | "danger" } & DialogOptions
  ) => Promise<boolean>;
  prompt: (
    title: string,
    options?: { defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string } & DialogOptions
  ) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextType | null>(null);

export const useDialog = () => {
  const context = useContext(DialogContext);
  if (!context) throw new Error("useDialog must be used within DialogProvider");
  return context;
};

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [viewportInset, setViewportInset] = useState(0);
  const dialogQueueRef = React.useRef<DialogRequestQueue | null>(null);
  const nextDialogIdRef = React.useRef(1);
  const mountGenerationRef = React.useRef(0);
  if (!dialogQueueRef.current) {
    dialogQueueRef.current = new DialogRequestQueue((request) => {
      if (request?.type === "prompt") setInputValue(request.defaultValue || "");
      else if (!request) setInputValue("");
      setDialog(request);
    });
  }
  const dialogQueue = dialogQueueRef.current;
  const locale = (useSettingsStore((s) => s.settings.locale) || "zh") as Locale;
  const t = useTranslation(locale);

  const alert = useCallback(
    (title: string, message?: string, options?: DialogOptions): Promise<void> => {
      const request: DialogRequest = {
        id: nextDialogIdRef.current++,
        type: "alert",
        title,
        message,
        resolve: () => {},
        signal: options?.signal,
        settled: false,
      };
      return dialogQueue.enqueue(request, true, () => undefined);
    },
    [dialogQueue]
  );

  const confirm = useCallback(
    (
      title: string,
      message?: string,
      options?: { confirmText?: string; cancelText?: string; confirmVariant?: "default" | "danger" } & DialogOptions
    ): Promise<boolean> => {
      const request: DialogRequest = {
        id: nextDialogIdRef.current++,
        type: "confirm",
        title,
        message,
        confirmText: options?.confirmText,
        cancelText: options?.cancelText,
        confirmVariant: options?.confirmVariant,
        resolve: () => {},
        signal: options?.signal,
        settled: false,
      };
      return dialogQueue.enqueue(request, false, (value) => value as boolean);
    },
    [dialogQueue]
  );

  const prompt = useCallback(
    (
      title: string,
      options?: {
        defaultValue?: string;
        placeholder?: string;
        confirmText?: string;
        cancelText?: string;
      } & DialogOptions
    ): Promise<string | null> => {
      const request: DialogRequest = {
        id: nextDialogIdRef.current++,
        type: "prompt",
        title,
        defaultValue: options?.defaultValue,
        placeholder: options?.placeholder,
        confirmText: options?.confirmText,
        cancelText: options?.cancelText,
        resolve: () => {},
        signal: options?.signal,
        settled: false,
      };
      return dialogQueue.enqueue(request, null, (value) => value as string | null);
    },
    [dialogQueue]
  );

  const handleClose = useCallback(
    (request: DialogRequest | null) => {
      if (!dialogQueue.isActive(request)) return;
      dialogQueue.finish(request, getDialogCancelValue(request));
    },
    [dialogQueue]
  );

  const handleConfirm = useCallback(
    (request: DialogRequest | null) => {
      if (!dialogQueue.isActive(request)) return;
      dialogQueue.finish(request, request.type === "prompt" ? inputValue : true);
    },
    [dialogQueue, inputValue]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, request: DialogRequest | null) => {
      if (e.key === "Enter" && request?.type === "prompt") {
        e.preventDefault();
        handleConfirm(request);
      } else if (e.key === "Escape") {
        handleClose(request);
      }
    },
    [handleClose, handleConfirm]
  );

  useEffect(() => {
    const mountGeneration = ++mountGenerationRef.current;
    dialogQueue.mount();
    return () => {
      queueMicrotask(() => {
        if (mountGenerationRef.current !== mountGeneration) return;
        dialogQueue.dispose({ notifyActiveChange: false });
      });
    };
  }, [dialogQueue]);

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
      <Dialog open={!!dialog} onOpenChange={(open) => !open && handleClose(dialog)}>
        {dialog && (
          <DialogContent
            key={dialog.id}
            showCloseButton={false}
            onKeyDown={(event) => handleKeyDown(event, dialog)}
            style={{ "--dialog-bottom": viewportInset ? `${viewportInset}px` : undefined } as React.CSSProperties}
            className="overflow-x-hidden border-ide-border bg-ide-panel text-ide-text shadow-sm md:max-w-md"
          >
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="break-words text-base leading-6 text-ide-text">{dialog.title}</DialogTitle>
              {dialog.message && (
                <DialogDescription className="break-words text-sm leading-6 text-ide-mute">
                  {dialog.message}
                </DialogDescription>
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
                  name="dialog-prompt"
                  aria-label={dialog.title}
                  className="h-11 border-ide-border bg-ide-bg text-ide-text placeholder:text-ide-mute focus-visible:ring-ide-accent/30 md:h-9"
                />
              </div>
            )}
            <DialogFooter className="gap-3 pt-3 md:flex-row">
              {dialog.type !== "alert" && (
                <Button
                  variant="outline"
                  onClick={() => handleClose(dialog)}
                  className="h-11 w-full border-ide-border bg-ide-panel text-ide-text hover:bg-ide-bg md:w-auto"
                >
                  {dialog.cancelText || t("common.cancel")}
                </Button>
              )}
              <Button
                variant={dialog.confirmVariant === "danger" ? "destructive" : "default"}
                onClick={() => handleConfirm(dialog)}
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
