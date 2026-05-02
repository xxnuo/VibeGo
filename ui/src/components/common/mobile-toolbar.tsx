import React from "react";

interface MobileToolbarProps {
  onInsert: (char: string) => void;
}

const MobileToolbar: React.FC<MobileToolbarProps> = ({ onInsert }) => {
  const chars = ["{", "}", "(", ")", "[", "]", "<", ">", "=", "=>", ";", '"', "'", "`", "$", "!"];

  return (
    <div className="z-10 flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-t border-ide-accent bg-black px-1 custom-scrollbar md:h-10">
      {chars.map((char) => (
        <button
          key={char}
          type="button"
          aria-label={`Insert ${char}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onInsert(char)}
          className="flex h-11 min-w-11 shrink-0 items-center justify-center border border-ide-border bg-ide-panel font-bold text-ide-accent transition-all hover:border-ide-accent hover:bg-ide-accent hover:text-black active:translate-y-0.5 md:h-8 md:min-w-9"
        >
          {char}
        </button>
      ))}
      <div className="w-2 shrink-0" />
    </div>
  );
};

export default MobileToolbar;
