export const BLOCKTERM_MODEL_MAX_BYTES = 256;

const textEncoder = new TextEncoder();

export function blockTermModelNameFitsLimit(value: string): boolean {
  return textEncoder.encode(value).byteLength <= BLOCKTERM_MODEL_MAX_BYTES;
}
