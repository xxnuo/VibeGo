// Work around xterm's interim UTF-8 decoder losing 0x80 continuation bytes.
// Keep only a valid incomplete suffix; malformed bytes pass through unchanged.
export class CompleteUTF8Chunks {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array {
    let data = chunk;
    if (this.pending.length) {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
      this.pending = new Uint8Array(0);
    }
    let start = data.length - 1;
    while (start >= 0 && data[start] >= 0x80 && data[start] <= 0xbf && data.length - start <= 3) start--;
    if (start < 0) return data;
    const lead = data[start];
    const width =
      lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    const length = data.length - start;
    if (!width || length >= width) return data;
    if (length > 1) {
      const next = data[start + 1];
      if (
        (lead === 0xe0 && next < 0xa0) ||
        (lead === 0xed && next > 0x9f) ||
        (lead === 0xf0 && next < 0x90) ||
        (lead === 0xf4 && next > 0x8f)
      )
        return data;
    }
    this.pending = data.slice(start);
    return data.subarray(0, start);
  }

  flush(): Uint8Array {
    const pending = this.pending;
    this.pending = new Uint8Array(0);
    return pending;
  }
}
