export function decodeBase64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}
