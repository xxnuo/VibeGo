import React, { useState } from "react";
import { Terminal, Trash2, Check, X, Edit2, ArrowLeft } from "lucide-react";
import type { TerminalSession } from "@/stores/terminalStore";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface TerminalListManagerProps {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onBack: () => void;
  embedded?: boolean;
}

const TerminalListManager: React.FC<TerminalListManagerProps> = ({
  terminals,
  activeTerminalId,
  onSelect,
  onRename,
  onDelete,
  onClearAll,
  onBack,
  embedded = false,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeleteId(id);
  };

  const handleConfirmDelete = () => {
    if (deleteId) {
      onDelete(deleteId);
      setDeleteId(null);
    }
  };

  const handleClearAllClick = () => {
    setShowClearConfirm(true);
  };

  const handleConfirmClear = () => {
    onClearAll();
    setShowClearConfirm(false);
  };

  const handleRename = (id: string) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    onRename(id, editName.trim());
    setEditingId(null);
  };

  const startEditing = (e: React.MouseEvent, terminal: TerminalSession) => {
    e.stopPropagation();
    setEditingId(terminal.id);
    setEditName(terminal.name);
  };

  return (
    <div
      className={`flex flex-col h-full bg-ide-panel ${embedded ? "border-t border-ide-border" : ""}`}
    >
      {/* 
        If NOT embedded, show header. 
        If embedded, we rely on TopBar or generic container for header/controls.
        Assuming 'embedded' means "inside TerminalPage container" where we hide the duplicate header.
      */}
      {!embedded && (
        <div className="h-12 bg-ide-bg border-b border-ide-border flex items-center px-3 gap-2 shrink-0">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-md text-ide-accent hover:bg-ide-accent hover:text-ide-bg flex items-center justify-center border border-ide-border transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="font-medium text-ide-text flex-1">Terminals</span>
          {terminals.length > 0 && (
            <button
              onClick={handleClearAllClick}
              className="text-xs text-ide-mute hover:text-red-500 flex items-center gap-1 transition-colors"
            >
              <Trash2 size={12} />
              <span>Clear All</span>
            </button>
          )}
        </div>
      )}

      {/* 
        If embedded, we might still want a way to Clear All? 
        Let's add a small action bar or floating button if list is long?
        For now, let's assume TopBar doesn't have "Clear All" but "New".
        Let's add a list header inside the list area if embedded?
      */}
      {embedded && terminals.length > 0 && (
        <div className="flex justify-end px-3 py-2">
          <button
            onClick={handleClearAllClick}
            className="text-xs text-ide-mute hover:text-red-500 flex items-center gap-1 transition-colors"
          >
            <Trash2 size={12} />
            <span>Clear All</span>
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 pt-0">
        {terminals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-ide-mute">
            <Terminal size={40} className="mb-4 opacity-50" />
            <p className="text-sm">No terminals</p>
            <p className="mt-2 text-xs">Create a new terminal to get started</p>
          </div>
        ) : (
          <div className="space-y-1">
            {terminals.map((terminal) => {
              const isCurrent = terminal.id === activeTerminalId;
              const isEditing = editingId === terminal.id;

              return (
                <div
                  key={terminal.id}
                  onClick={() => onSelect(terminal.id)}
                  className={`group flex items-center gap-2 p-2.5 rounded-lg border transition-all cursor-pointer ${
                    isCurrent
                      ? "bg-ide-accent/10 border-ide-accent/30"
                      : "border-transparent hover:bg-ide-bg hover:border-ide-border"
                  }`}
                >
                  <div
                    className={`p-1.5 rounded-lg flex-shrink-0 ${
                      isCurrent
                        ? "bg-ide-accent/20"
                        : "bg-ide-bg group-hover:bg-ide-panel"
                    }`}
                  >
                    <Terminal
                      size={18}
                      className={
                        isCurrent ? "text-ide-accent" : "text-ide-mute"
                      }
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="flex-1 px-2 py-0.5 bg-ide-bg border border-ide-accent rounded text-sm text-ide-text outline-none"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(terminal.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                        <button
                          onClick={() => handleRename(terminal.id)}
                          className="p-1 text-green-500 hover:bg-ide-panel rounded"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-1 text-red-500 hover:bg-ide-panel rounded"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium truncate text-sm ${
                            isCurrent ? "text-ide-accent" : "text-ide-text"
                          }`}
                        >
                          {terminal.name}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] bg-ide-accent text-ide-bg px-1.5 py-0.5 rounded font-bold">
                            Active
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => startEditing(e, terminal)}
                        className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-ide-accent opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={(e) => handleDeleteClick(e, terminal.id)}
                        className="p-1.5 rounded hover:bg-ide-bg text-ide-mute hover:text-red-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Terminal</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this terminal session? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-500 hover:bg-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Terminals</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to close all terminal sessions?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmClear}
              className="bg-red-500 hover:bg-red-600"
            >
              Clear All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TerminalListManager;
