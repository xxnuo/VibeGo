import type { editor } from "monaco-editor";
import { contextKeys } from "./context-key-service";

let activeEditor: editor.IStandaloneCodeEditor | undefined;
export const editorService = {
  attach(instance: editor.IStandaloneCodeEditor, position?: { line?: number; column?: number }) {
    activeEditor = instance;
    contextKeys.set("isCodeEditor", true);
    if (position?.line) {
      const target = { lineNumber: Math.max(1, position.line), column: Math.max(1, position.column || 1) };
      instance.setPosition(target);
      instance.revealPositionInCenter(target);
      instance.focus();
    }
    return () => {
      if (activeEditor === instance) {
        activeEditor = undefined;
        contextKeys.set("isCodeEditor", false);
      }
    };
  },
  navigate(position?: { line?: number; column?: number }) {
    if (activeEditor && position?.line) {
      const target = { lineNumber: Math.max(1, position.line), column: Math.max(1, position.column || 1) };
      activeEditor.setPosition(target);
      activeEditor.revealPositionInCenter(target);
    }
  },
  insertText(text: string) {
    const selection = activeEditor?.getSelection();
    if (!activeEditor || !selection) throw new Error("No active code editor");
    activeEditor.updateOptions({ readOnly: false });
    activeEditor.pushUndoStop();
    activeEditor.executeEdits("plugin-host", [{ range: selection, text, forceMoveMarkers: true }]);
    activeEditor.pushUndoStop();
    activeEditor.focus();
  },
};
