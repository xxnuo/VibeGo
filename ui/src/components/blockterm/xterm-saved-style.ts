import type { Terminal } from "@xterm/xterm";

type LinkData = { uri: string; id?: string };
type Attributes = {
  extended: { urlId: number; clone(): Attributes["extended"] };
  updateExtended(): void;
};
type BufferState = { savedCurAttrData: Attributes; ybase: number; y: number };
type CursorHandler = {
  _activeBuffer: BufferState;
  _curAttrData: Attributes;
  saveCursor(params?: unknown): boolean;
  restoreCursor(params?: unknown): boolean;
  softReset(params?: unknown): boolean;
};

// xterm 6 only copies fg/bg in DECSC/DECRC. Extended underline and OSC 8 state
// must follow the saved pen too, as they do in the backend continuation state.
export function installSavedCursorStyle(terminal: Terminal) {
  const core = (
    terminal as unknown as {
      _core?: {
        _inputHandler?: CursorHandler;
        _oscLinkService?: {
          getLinkData(id: number): LinkData | undefined;
          registerLink(data: LinkData): number;
          addLineToLink(id: number, row: number): void;
        };
      };
    }
  )._core;
  const handler = core?._inputHandler;
  const links = core?._oscLinkService;
  if (
    typeof handler?.saveCursor !== "function" ||
    typeof handler.restoreCursor !== "function" ||
    typeof handler.softReset !== "function" ||
    typeof handler._curAttrData?.extended?.clone !== "function" ||
    typeof handler._curAttrData.updateExtended !== "function" ||
    typeof handler._activeBuffer?.savedCurAttrData?.extended?.clone !== "function" ||
    typeof handler._activeBuffer.ybase !== "number" ||
    typeof handler._activeBuffer.y !== "number" ||
    typeof links?.getLinkData !== "function" ||
    typeof links.registerLink !== "function" ||
    typeof links.addLineToLink !== "function"
  )
    throw new Error("终端保存光标样式与当前解析器不兼容");
  const savedLinks = new WeakMap<BufferState, { data: LinkData; id: number }>();
  const save = handler.saveCursor;
  const restore = handler.restoreCursor;
  const softReset = handler.softReset;

  const saveStyle = (params?: unknown) => {
    const result = save.call(handler, params);
    const buffer = handler._activeBuffer;
    buffer.savedCurAttrData.extended = handler._curAttrData.extended.clone();
    const link = links.getLinkData(buffer.savedCurAttrData.extended.urlId);
    if (link) savedLinks.set(buffer, { data: { ...link }, id: buffer.savedCurAttrData.extended.urlId });
    else savedLinks.delete(buffer);
    return result;
  };
  const restoreStyle = (params?: unknown) => {
    const result = restore.call(handler, params);
    const buffer = handler._activeBuffer;
    const attrs = handler._curAttrData;
    attrs.extended = buffer.savedCurAttrData.extended.clone();
    if (attrs.extended.urlId) {
      const saved = savedLinks.get(buffer);
      const id = saved?.id ?? attrs.extended.urlId;
      const existing = links.getLinkData(id);
      const link = saved?.data ?? existing;
      // Link markers may have scrolled out since DECSC. Recreate the registration
      // at the restored row, without retaining obsolete markers or opening URLs.
      if (link) {
        if (existing?.uri === link.uri && existing?.id === link.id) {
          attrs.extended.urlId = id;
          links.addLineToLink(id, buffer.ybase + buffer.y);
        } else {
          attrs.extended.urlId = links.registerLink({ ...link });
          // Anonymous OSC links are never deduplicated by registerLink. Cache a
          // replacement id so repeated DECRC cannot allocate one entry per call.
          savedLinks.set(buffer, { data: { ...link }, id: attrs.extended.urlId });
        }
      }
    }
    attrs.updateExtended();
    return result;
  };
  const resetStyle = (params?: unknown) => {
    const result = softReset.call(handler, params);
    const buffer = handler._activeBuffer;
    buffer.savedCurAttrData.extended = handler._curAttrData.extended.clone();
    savedLinks.delete(buffer);
    return result;
  };
  handler.saveCursor = saveStyle;
  handler.restoreCursor = restoreStyle;
  handler.softReset = resetStyle;
  return {
    dispose() {
      if (handler.saveCursor === saveStyle) handler.saveCursor = save;
      if (handler.restoreCursor === restoreStyle) handler.restoreCursor = restore;
      if (handler.softReset === resetStyle) handler.softReset = softReset;
    },
  };
}
