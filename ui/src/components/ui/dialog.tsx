// @ts-nocheck
import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

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
            !active.closest('[data-slot="dialog-content"]')
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

function useVisualViewportBottomInset() {
  const [bottomInset, setBottomInset] = React.useState(0)

  React.useEffect(() => {
    const updateInset = () => {
      const viewport = window.visualViewport
      if (!viewport) {
        setBottomInset(0)
        return
      }
      setBottomInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
    }

    updateInset()
    window.visualViewport?.addEventListener("resize", updateInset)
    window.visualViewport?.addEventListener("scroll", updateInset)
    window.addEventListener("orientationchange", updateInset)
    return () => {
      window.visualViewport?.removeEventListener("resize", updateInset)
      window.visualViewport?.removeEventListener("scroll", updateInset)
      window.removeEventListener("orientationchange", updateInset)
    }
  }, [])

  return bottomInset
}

function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
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
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
      {...(controlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    />
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  onCloseAutoFocus,
  style,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const viewportBottomInset = useVisualViewportBottomInset()
  const explicitDialogBottom = style?.["--dialog-bottom"] != null
  const contentStyle = {
    ...style,
    ...(explicitDialogBottom
      ? null
      : { "--dialog-bottom": viewportBottomInset ? `${viewportBottomInset}px` : undefined }),
  } as React.CSSProperties

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus) onCloseAutoFocus(event)
          else event.preventDefault()
        }}
        className={cn(
          "fixed z-50 grid min-w-0 w-full gap-4 bg-background shadow-lg duration-200 outline-none [&>*]:min-w-0",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "inset-x-0 top-auto bottom-(--dialog-bottom,0px) translate-x-0 translate-y-0 max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_var(--dialog-bottom,0px)_-_0.75rem)] overflow-y-auto rounded-t-2xl rounded-b-none border-t border-x-0 border-b-0 p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          "md:inset-auto md:top-[50%] md:bottom-auto md:left-[50%] md:h-auto md:-translate-x-[50%] md:-translate-y-[50%] md:w-full md:rounded-2xl md:border md:p-6 md:max-w-lg",
          className
        )}
        style={contentStyle}
        {...props}
      >
        <div className="bg-muted mx-auto h-1.5 w-10 min-h-[6px] shrink-0 rounded-full md:hidden mb-2" />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 inline-flex h-11 w-11 items-center justify-center rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none md:top-4 md:right-4 md:h-8 md:w-8 data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-3 pt-3 md:flex-row md:justify-end md:gap-2 md:pt-0",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
