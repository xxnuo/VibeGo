import React from "react";

interface DiffViewProps {
  original: string;
  modified: string;
}

const DiffView: React.FC<DiffViewProps> = ({ original, modified }) => {
  // Very naive diff implementation for prototype purposes
  // In a real app, use a library like 'diff' or 'diff-match-patch'

  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // This is a dummy "diff" logic just for visual representation
  // It blindly assumes lines map 1:1 unless length differs significantly
  const maxLines = Math.max(originalLines.length, modifiedLines.length);

  const renderLines = () => {
    const output = [];
    for (let i = 0; i < maxLines; i++) {
      const org = originalLines[i];
      const mod = modifiedLines[i];

      if (org === mod) {
        // Unchanged
        output.push(
          <div key={i} className="flex text-ide-mute/50">
            <div className="w-8 text-right pr-2 select-none border-r border-ide-border/50 text-xs leading-6">
              {i + 1}
            </div>
            <div className="pl-2 text-ide-text font-mono text-sm leading-6 whitespace-pre">
              {mod || ""}
            </div>
          </div>,
        );
      } else {
        // Changed (Visualize as Delete then Add for simplicity)
        if (org !== undefined) {
          output.push(
            <div key={`del-${i}`} className="flex bg-ide-diff-del-bg">
              <div className="w-8 text-right pr-2 select-none border-r border-ide-border/50 text-xs leading-6 text-ide-diff-del">
                -
              </div>
              <div className="pl-2 text-ide-text font-mono text-sm leading-6 whitespace-pre opacity-70">
                {org}
              </div>
            </div>,
          );
        }
        if (mod !== undefined) {
          output.push(
            <div key={`add-${i}`} className="flex bg-ide-diff-add-bg">
              <div className="w-8 text-right pr-2 select-none border-r border-ide-border/50 text-xs leading-6 text-ide-diff-add">
                +
              </div>
              <div className="pl-2 text-ide-text font-mono text-sm leading-6 whitespace-pre">
                {mod}
              </div>
            </div>,
          );
        }
      }
    }
    return output;
  };

  return (
    <div className="h-full overflow-auto bg-ide-bg pb-20">
      <div className="flex sticky top-0 bg-ide-panel border-b border-ide-border p-2 text-xs font-bold text-ide-mute z-10 mb-2">
        <div className="flex-1 text-center">Base</div>
        <div className="w-px bg-ide-border mx-2"></div>
        <div className="flex-1 text-center">Head</div>
      </div>
      <div className="flex flex-col w-full">{renderLines()}</div>
    </div>
  );
};

export default DiffView;
