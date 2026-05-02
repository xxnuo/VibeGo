// @ts-nocheck
"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function useFocusRestore(open: boolean | undefined) {
  const restoreRef = React.useRef<HTMLElement | null>(null)
  const previousOpenRef = React.useRef(open)

  React.useInsertionEffect(() => {
    if (typeof document === "undefined") return

    if (open && !previousOpenRef.current) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      restoreRef.current = active
      if (active && active !== document.body) active.blur()
    }

  }, [open])

  React.useEffect(() => {
    if (typeof document === "undefined") return

    let cleanup: (() => void) | undefined

    if (!open && previousOpenRef.current) {
      const target = restoreRef.current
      restoreRef.current = null
      if (target?.isConnected) {
        let frame = 0
        let timeout = 0
        let observer: MutationObserver | null = null
        cleanup = () => {
          cancelAnimationFrame(frame)
          window.clearTimeout(timeout)
          observer?.disconnect()
        }
        const restore = () => {
          if (!target.isConnected) {
            cleanup?.()
            return
          }
          const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
          if (
            active &&
            active !== document.body &&
            !active.closest('[aria-hidden="true"]') &&
            !active.closest('[data-slot="alert-dialog-content"]')
          ) {
            cleanup?.()
            return
          }
          if (!target.closest('[aria-hidden="true"]')) {
            target.focus({ preventScroll: true })
            cleanup?.()
          }
        }
        frame = requestAnimationFrame(restore)
        observer = new MutationObserver(restore)
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ["aria-hidden"],
        })
        timeout = window.setTimeout(() => {
          restore()
          cleanup?.()
        }, 500)
      }
    }

    previousOpenRef.current = open
    return cleanup
  }, [open])
}

function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  const controlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const effectiveOpen = controlled ? open : uncontrolledOpen
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!controlled) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [controlled, onOpenChange]
  )

  useFocusRestore(effectiveOpen)
  return (
    <AlertDialogPrimitive.Root
      data-slot="alert-dialog"
      {...props}
      {...(controlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    />
  )
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  onCloseAutoFocus,
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: "default" | "sm"
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus) onCloseAutoFocus(event)
          else event.preventDefault()
        }}
        className={cn(
          "group/alert-dialog-content fixed z-50 grid w-full gap-4 bg-background shadow-lg duration-200 outline-none",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "inset-x-0 top-auto bottom-0 translate-x-0 translate-y-0 max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_0.75rem)] overflow-y-auto rounded-t-2xl rounded-b-none border-t border-x-0 border-b-0 p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          "md:inset-auto md:top-[50%] md:left-[50%] md:-translate-x-[50%] md:-translate-y-[50%] md:w-full md:rounded-2xl md:border md:p-6 md:pb-6",
          "data-[size=sm]:md:max-w-sm data-[size=default]:md:max-w-lg",
          className
        )}
        {...props}
      >
        <div className="bg-muted mx-auto h-1.5 w-10 min-h-[6px] shrink-0 rounded-full md:hidden mb-2" />
        {props.children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-3 pt-3 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 md:flex-row md:justify-end md:gap-2 md:pt-0",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "text-lg font-semibold sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-16 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} className={cn("h-11 md:h-9", className)} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        {...props}
      />
    </Button>
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} className={cn("h-11 md:h-9", className)} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
