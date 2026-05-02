import { type RefObject, useState } from "react";
import ContextSheet, { type ContextSheetProps } from "@/components/ui/context-sheet";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";

export function BlockActionMenu({ anchor, ...props }: ContextSheetProps & { anchor: RefObject<HTMLElement | null> }) {
  const isMobile = useIsMobile();
  const [mobile, setMobile] = useState(isMobile);
  // Keep the active focus scope mounted when the viewport crosses a breakpoint.
  if (!props.open && mobile !== isMobile) setMobile(isMobile);
  if (mobile) return <ContextSheet {...props} />;
  return (
    <Popover open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        aria-label={props.title}
        align="end"
        side="bottom"
        collisionPadding={8}
        className="w-72 max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-1"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          event.preventDefault();
          buttons[next].focus();
        }}
      >
        {props.items.map((item) => (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            className="flex min-h-9 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              item.onClick();
              props.onClose();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
