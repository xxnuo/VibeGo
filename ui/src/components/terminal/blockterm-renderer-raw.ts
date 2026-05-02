import type { BlockTermRendererName } from "@/components/terminal/blockterm-renderer-registry";
import { MAX_MUSTACHE_TEMPLATE_BYTES } from "./blockterm-mustache.ts";

const MAX_CODE_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 200_000;
const MAX_CSV_BYTES = 10 * 1024 * 1024;

function bytesStartWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function bytesStartWithText(bytes: Uint8Array, signature: string, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function readUint64BE(bytes: Uint8Array, offset: number): number | null {
  const high = readUint32BE(bytes, offset);
  const low = readUint32BE(bytes, offset + 4);
  if (high === null || low === null) return null;
  const value = high * 0x1_0000_0000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function readFourCC(bytes: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

const ISO_BMFF_MEDIA_BRANDS = new Set([
  "M4A ",
  "M4B ",
  "M4P ",
  "F4A ",
  "F4B ",
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "av01",
  "dash",
  "M4V ",
  "M4VH",
  "M4VP",
  "F4V ",
  "MSNV",
]);

interface IsoBmffBox {
  type: string;
  dataStart: number;
  end: number;
}

function readIsoBmffBox(bytes: Uint8Array, offset: number, limit: number): IsoBmffBox | null {
  const size32 = readUint32BE(bytes, offset);
  const type = readFourCC(bytes, offset + 4);
  if (size32 === null || !type || offset + 8 > limit) return null;

  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    const extendedSize = readUint64BE(bytes, offset + 8);
    if (extendedSize === null) return null;
    headerSize = 16;
    size = extendedSize;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (size < headerSize || size > limit - offset) return null;
  return { type, dataStart: offset + headerSize, end: offset + size };
}

function readIsoBmffTrackHandlers(bytes: Uint8Array, start: number, end: number): Set<string> | null {
  const handlers = new Set<string>();
  for (let trakCursor = start; trakCursor < end; ) {
    const trak = readIsoBmffBox(bytes, trakCursor, end);
    if (!trak) return null;
    if (trak.type === "trak") {
      for (let mdiaCursor = trak.dataStart; mdiaCursor < trak.end; ) {
        const mdia = readIsoBmffBox(bytes, mdiaCursor, trak.end);
        if (!mdia) return null;
        if (mdia.type === "mdia") {
          for (let handlerCursor = mdia.dataStart; handlerCursor < mdia.end; ) {
            const handler = readIsoBmffBox(bytes, handlerCursor, mdia.end);
            if (!handler) return null;
            if (handler.type === "hdlr") {
              const handlerType = readFourCC(bytes, handler.dataStart + 8);
              if (handlerType === "soun" || handlerType === "vide") handlers.add(handlerType);
            }
            handlerCursor = handler.end;
          }
        }
        mdiaCursor = mdia.end;
      }
    }
    trakCursor = trak.end;
  }
  return handlers;
}

function detectIsoBmffMimeType(bytes: Uint8Array, offset: number): string | null {
  const ftyp = readIsoBmffBox(bytes, offset, bytes.length);
  if (!ftyp || ftyp.type !== "ftyp" || ftyp.end - ftyp.dataStart < 8 || (ftyp.end - ftyp.dataStart - 8) % 4 !== 0)
    return null;

  const brands: string[] = [];
  const majorBrand = readFourCC(bytes, ftyp.dataStart);
  if (!majorBrand) return null;
  brands.push(majorBrand);
  for (let cursor = ftyp.dataStart + 8; cursor < ftyp.end; cursor += 4) {
    const brand = readFourCC(bytes, cursor);
    if (!brand) return null;
    brands.push(brand);
  }
  const quickTime = brands.includes("qt  ");
  if (!quickTime && !brands.some((brand) => ISO_BMFF_MEDIA_BRANDS.has(brand))) return null;

  const handlers = new Set<string>();
  for (let cursor = ftyp.end; cursor < bytes.length; ) {
    const box = readIsoBmffBox(bytes, cursor, bytes.length);
    if (!box) return null;
    if (box.type === "moov") {
      const moovHandlers = readIsoBmffTrackHandlers(bytes, box.dataStart, box.end);
      if (!moovHandlers) return null;
      for (const handler of moovHandlers) handlers.add(handler);
    }
    cursor = box.end;
  }
  if (handlers.has("vide")) return quickTime ? "video/quicktime" : "video/mp4";
  if (handlers.has("soun")) return quickTime ? "audio/quicktime" : "audio/mp4";
  return null;
}

interface EbmlSize {
  length: number;
  value: number;
  unknown: boolean;
}

function readEbmlSize(bytes: Uint8Array, offset: number, maxLength: number): EbmlSize | null {
  if (offset < 0 || offset >= bytes.length || bytes[offset] === 0) return null;
  let marker = 0x80;
  let length = 1;
  while (length <= maxLength && (bytes[offset] & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > maxLength || offset + length > bytes.length) return null;

  let value = bytes[offset] & (marker - 1);
  let unknown = value === marker - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
    unknown = unknown && bytes[offset + index] === 0xff;
  }
  if (unknown) return { length, value: 0, unknown: true };
  if (!Number.isSafeInteger(value)) return null;
  return { length, value, unknown: false };
}

function ebmlElementIdLength(firstByte: number): number {
  if ((firstByte & 0x80) !== 0) return 1;
  if ((firstByte & 0x40) !== 0) return 2;
  if ((firstByte & 0x20) !== 0) return 3;
  if ((firstByte & 0x10) !== 0) return 4;
  return 0;
}

interface EbmlElement {
  idStart: number;
  idLength: number;
  dataStart: number;
  end: number;
  unknownSize: boolean;
}

function readEbmlElement(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  allowUnknownSize = false
): EbmlElement | null {
  if (offset < 0 || offset >= limit) return null;
  const idLength = ebmlElementIdLength(bytes[offset]);
  if (idLength === 0 || offset + idLength > limit) return null;
  const size = readEbmlSize(bytes, offset + idLength, 8);
  if (!size || (size.unknown && !allowUnknownSize)) return null;
  const dataStart = offset + idLength + size.length;
  const end = size.unknown ? limit : dataStart + size.value;
  if (dataStart > limit || end > limit) return null;
  return { idStart: offset, idLength, dataStart, end, unknownSize: size.unknown };
}

function ebmlElementHasId(bytes: Uint8Array, element: EbmlElement, id: readonly number[]): boolean {
  return element.idLength === id.length && bytesStartWith(bytes, id, element.idStart);
}

function readEbmlUnsigned(bytes: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let cursor = start; cursor < end; cursor += 1) value = value * 256 + bytes[cursor];
  return Number.isSafeInteger(value) ? value : null;
}

function detectEbmlTrackTypes(bytes: Uint8Array, start: number, end: number): Set<number> | null {
  const trackTypes = new Set<number>();
  for (let cursor = start; cursor < end; ) {
    const entry = readEbmlElement(bytes, cursor, end);
    if (!entry) return null;
    if (ebmlElementHasId(bytes, entry, [0xae])) {
      for (let childCursor = entry.dataStart; childCursor < entry.end; ) {
        const child = readEbmlElement(bytes, childCursor, entry.end);
        if (!child) return null;
        if (ebmlElementHasId(bytes, child, [0x83])) {
          const trackType = readEbmlUnsigned(bytes, child.dataStart, child.end);
          if (trackType === 1 || trackType === 2) trackTypes.add(trackType);
        }
        childCursor = child.end;
      }
    }
    cursor = entry.end;
  }
  return trackTypes;
}

function findEbmlTrackTypes(bytes: Uint8Array, segment: EbmlElement): Set<number> | null {
  for (let cursor = segment.dataStart; cursor < segment.end; ) {
    const element = readEbmlElement(bytes, cursor, segment.end);
    if (!element) return null;
    if (ebmlElementHasId(bytes, element, [0x16, 0x54, 0xae, 0x6b]))
      return detectEbmlTrackTypes(bytes, element.dataStart, element.end);
    if (element.unknownSize) return null;
    cursor = element.end;
  }
  return new Set();
}

function detectEbmlMimeType(bytes: Uint8Array, offset: number): string | null {
  if (!bytesStartWith(bytes, [0x1a, 0x45, 0xdf, 0xa3], offset)) return null;
  const headerSize = readEbmlSize(bytes, offset + 4, 8);
  if (!headerSize || headerSize.unknown || headerSize.value > 4096) return null;
  const headerStart = offset + 4 + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > bytes.length) return null;

  let docType: "webm" | "matroska" | null = null;
  for (let cursor = headerStart; cursor < headerEnd; ) {
    const element = readEbmlElement(bytes, cursor, headerEnd);
    if (!element) return null;
    if (ebmlElementHasId(bytes, element, [0x42, 0x82])) {
      const value = String.fromCharCode(...bytes.subarray(element.dataStart, element.end));
      if (value !== "webm" && value !== "matroska") return null;
      docType = value;
    }
    cursor = element.end;
  }
  if (!docType) return null;

  for (let cursor = headerEnd; cursor < bytes.length; ) {
    const segment = readEbmlElement(bytes, cursor, bytes.length, true);
    if (!segment) return null;
    if (ebmlElementHasId(bytes, segment, [0x18, 0x53, 0x80, 0x67])) {
      const trackTypes = findEbmlTrackTypes(bytes, segment);
      if (!trackTypes) return null;
      if (trackTypes.has(1)) return docType === "webm" ? "video/webm" : "video/x-matroska";
      if (trackTypes.has(2)) return docType === "webm" ? "audio/webm" : "audio/x-matroska";
      return null;
    }
    if (segment.unknownSize) return null;
    cursor = segment.end;
  }
  return null;
}

function detectOggCodecMimeType(packet: Uint8Array): "audio/ogg" | "video/ogg" | null {
  if (
    bytesStartWithText(packet, "OpusHead") ||
    bytesStartWith(packet, [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]) ||
    bytesStartWithText(packet, "Speex   ") ||
    bytesStartWith(packet, [0x7f, 0x46, 0x4c, 0x41, 0x43])
  )
    return "audio/ogg";
  if (bytesStartWith(packet, [0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61])) return "video/ogg";
  return null;
}

function detectOggMimeType(bytes: Uint8Array, offset: number): string | null {
  let cursor = offset;
  let hasAudio = false;
  let hasVideo = false;
  let sawBosPage = false;

  while (cursor < bytes.length) {
    if (!bytesStartWithText(bytes, "OggS", cursor) || cursor + 27 > bytes.length || bytes[cursor + 4] !== 0)
      return null;
    const headerType = bytes[cursor + 5];
    const segmentCount = bytes[cursor + 26];
    const segmentTableStart = cursor + 27;
    const bodyStart = segmentTableStart + segmentCount;
    if (bodyStart > bytes.length) return null;
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) bodyLength += bytes[segmentTableStart + index];
    const pageEnd = bodyStart + bodyLength;
    if (pageEnd > bytes.length) return null;

    const isBos = (headerType & 0x02) !== 0;
    if (!isBos && sawBosPage) break;
    if (isBos) {
      sawBosPage = true;
      if ((headerType & 0x01) !== 0) return null;
      let packetLength = 0;
      let packetComplete = false;
      for (let index = 0; index < segmentCount; index += 1) {
        const lace = bytes[segmentTableStart + index];
        packetLength += lace;
        if (lace < 255) {
          packetComplete = true;
          break;
        }
      }
      if (!packetComplete || packetLength > bodyLength) return null;
      const mimeType = detectOggCodecMimeType(bytes.subarray(bodyStart, bodyStart + packetLength));
      if (mimeType === "video/ogg") hasVideo = true;
      else if (mimeType === "audio/ogg") hasAudio = true;
    }
    cursor = pageEnd;
  }
  if (hasVideo) return "video/ogg";
  if (hasAudio) return "audio/ogg";
  return null;
}

function detectAdtsFrame(bytes: Uint8Array, offset: number): boolean {
  if (offset + 7 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) return false;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x0f;
  if (sampleRateIndex === 0x0f) return false;
  const headerLength = (bytes[offset + 1] & 0x01) === 0 ? 9 : 7;
  const frameLength = ((bytes[offset + 3] & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
  return frameLength >= headerLength && frameLength <= bytes.length - offset;
}

const MPEG1_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
} as const;
const MPEG2_BITRATES = {
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
} as const;

function detectMpegAudioFrame(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3)
    return false;

  const bitrateTable = version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrate = bitrateTable[layer as 1 | 2 | 3][bitrateIndex] * 1000;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
  const sampleRate = version === 3 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  const frameLength =
    layer === 3
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / sampleRate + padding);
  return frameLength >= 4 && frameLength <= bytes.length - offset;
}

function audioFrameOffsetAfterId3(bytes: Uint8Array, offset: number): number | null {
  if (!bytesStartWithText(bytes, "ID3", offset)) return offset;
  if (offset + 10 > bytes.length || bytes[offset + 3] === 0xff || bytes[offset + 4] === 0xff) return null;
  const sizeBytes = bytes.subarray(offset + 6, offset + 10);
  if (sizeBytes.some((value) => (value & 0x80) !== 0)) return null;
  const tagSize = sizeBytes.reduce((size, value) => size * 128 + value, 0);
  const footerSize = bytes[offset + 3] === 4 && (bytes[offset + 5] & 0x10) !== 0 ? 10 : 0;
  const frameOffset = offset + 10 + tagSize + footerSize;
  return frameOffset <= bytes.length ? frameOffset : null;
}

function detectMimeTypeAtOffset(renderer: BlockTermRendererName, bytes: Uint8Array, offset: number): string {
  if (renderer === "pdf")
    return bytesStartWithText(bytes, "%PDF-", offset) ? "application/pdf" : "application/octet-stream";
  if (renderer === "image") {
    if (bytesStartWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10], offset)) return "image/png";
    if (bytesStartWith(bytes, [0xff, 0xd8, 0xff], offset)) return "image/jpeg";
    if (bytesStartWithText(bytes, "GIF89a", offset) || bytesStartWithText(bytes, "GIF87a", offset)) return "image/gif";
    if (bytesStartWithText(bytes, "RIFF", offset) && bytesStartWithText(bytes, "WEBP", offset + 8)) return "image/webp";
    if (bytesStartWith(bytes, [0x42, 0x4d], offset)) return "image/bmp";
    return "application/octet-stream";
  }
  if (renderer === "media") {
    const audioFrameOffset = audioFrameOffsetAfterId3(bytes, offset);
    if (audioFrameOffset !== null && detectAdtsFrame(bytes, audioFrameOffset)) return "audio/aac";
    if (audioFrameOffset !== null && detectMpegAudioFrame(bytes, audioFrameOffset)) return "audio/mpeg";
    if (bytesStartWithText(bytes, "fLaC", offset)) return "audio/flac";
    const oggMimeType = detectOggMimeType(bytes, offset);
    if (oggMimeType) return oggMimeType;
    if (bytesStartWithText(bytes, "RIFF", offset) && bytesStartWithText(bytes, "WAVE", offset + 8)) return "audio/wav";
    if (bytesStartWithText(bytes, "RIFF", offset) && bytesStartWithText(bytes, "AVI ", offset + 8))
      return "video/x-msvideo";
    const ebmlMimeType = detectEbmlMimeType(bytes, offset);
    if (ebmlMimeType) return ebmlMimeType;
    const isoBmffMimeType = detectIsoBmffMimeType(bytes, offset);
    if (isoBmffMimeType) return isoBmffMimeType;
    return "application/octet-stream";
  }
  return "text/plain;charset=utf-8";
}

function reverseOnlcr(bytes: Uint8Array): Uint8Array {
  let crlfCount = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      crlfCount += 1;
      index += 1;
    }
  }
  const restored = new Uint8Array(bytes.length - crlfCount);
  let writeOffset = 0;
  for (let readOffset = 0; readOffset < bytes.length; readOffset += 1) {
    if (bytes[readOffset] === 0x0d && bytes[readOffset + 1] === 0x0a) {
      restored[writeOffset] = 0x0a;
      writeOffset += 1;
      readOffset += 1;
    } else {
      restored[writeOffset] = bytes[readOffset];
      writeOffset += 1;
    }
  }
  return restored;
}

function removeLegacyWrapperSuffix(bytes: Uint8Array, offset: number): Uint8Array {
  let end = bytes.length;
  if (end > offset && bytes[end - 1] === 0x0a) end -= 1;
  return bytes.subarray(offset, end);
}

export interface BlockTermRawRendererPayload {
  bytes: Uint8Array;
  mimeType: string;
}

export function resolveBlockTermRawRendererPayload(
  renderer: BlockTermRendererName,
  bytes: Uint8Array
): BlockTermRawRendererPayload {
  const mimeType = detectMimeTypeAtOffset(renderer, bytes, 0);
  if (mimeType !== "application/octet-stream") return { bytes, mimeType };

  if (bytes[0] === 0x0d && bytes[1] === 0x0a) {
    const restored = reverseOnlcr(bytes);
    const candidate = removeLegacyWrapperSuffix(restored, 1);
    const legacyMimeType = detectMimeTypeAtOffset(renderer, candidate, 0);
    if (legacyMimeType !== "application/octet-stream") {
      return { bytes: candidate, mimeType: legacyMimeType };
    }
  } else if (bytes[0] === 0x0a) {
    const candidate = removeLegacyWrapperSuffix(bytes, 1);
    const legacyMimeType = detectMimeTypeAtOffset(renderer, candidate, 0);
    if (legacyMimeType !== "application/octet-stream") {
      return { bytes: candidate, mimeType: legacyMimeType };
    }
  }
  return { bytes, mimeType };
}

export function detectBlockTermRawRendererMimeType(renderer: BlockTermRendererName, bytes: Uint8Array): string {
  return resolveBlockTermRawRendererPayload(renderer, bytes).mimeType;
}

export function canCreateBlockTermRawView(renderer: BlockTermRendererName, mimeType: string): boolean {
  if (renderer === "image") return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
  if (renderer === "pdf") return mimeType === "application/pdf";
  if (renderer === "media") return mimeType.startsWith("audio/") || mimeType.startsWith("video/");
  return false;
}

export function getBlockTermRendererTextByteLimit(renderer: BlockTermRendererName): number | null {
  if (renderer === "code") return MAX_CODE_BYTES;
  if (renderer === "markdown") return MAX_MARKDOWN_BYTES;
  if (renderer === "csv") return MAX_CSV_BYTES;
  if (renderer === "mustache") return MAX_MUSTACHE_TEMPLATE_BYTES;
  return null;
}

export function isBlockTermRendererTextSizeAllowed(renderer: BlockTermRendererName, byteLength: number): boolean {
  const limit = getBlockTermRendererTextByteLimit(renderer);
  return limit === null || (Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= limit);
}
