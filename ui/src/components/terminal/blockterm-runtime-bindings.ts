export interface BlockTermRuntimeBinding {
  terminalId: string;
  blockId: string;
  blockToken: string;
}

export interface BlockTermRuntimeBindingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "vibego_blockterm_runtime_bindings_v1";
const BLOCK_TOKEN_RE = /^[0-9a-fA-F]{32,128}$/u;

function getDefaultStorage(): BlockTermRuntimeBindingStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isValidBinding(value: unknown): value is BlockTermRuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<BlockTermRuntimeBinding>;
  return (
    typeof candidate.terminalId === "string" &&
    candidate.terminalId.trim() === candidate.terminalId &&
    candidate.terminalId.length > 0 &&
    typeof candidate.blockId === "string" &&
    candidate.blockId.trim() === candidate.blockId &&
    candidate.blockId.length > 0 &&
    typeof candidate.blockToken === "string" &&
    BLOCK_TOKEN_RE.test(candidate.blockToken)
  );
}

function writeBindings(storage: BlockTermRuntimeBindingStorage, bindings: readonly BlockTermRuntimeBinding[]): void {
  try {
    if (bindings.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Storage can be unavailable in private browsing or after quota changes.
  }
}

export function loadBlockTermRuntimeBindings(
  storage: BlockTermRuntimeBindingStorage | null = getDefaultStorage()
): BlockTermRuntimeBinding[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore an unavailable storage backend.
    }
    return [];
  }
  if (!Array.isArray(parsed)) {
    writeBindings(storage, []);
    return [];
  }

  const deduplicated = new Map<string, BlockTermRuntimeBinding>();
  for (const candidate of parsed) {
    if (!isValidBinding(candidate)) continue;
    deduplicated.set(`${candidate.terminalId}\u0000${candidate.blockId}`, candidate);
  }
  const bindings = [...deduplicated.values()];
  if (bindings.length !== parsed.length) writeBindings(storage, bindings);
  return bindings;
}

export function getBlockTermRuntimeBinding(
  terminalId: string,
  blockId: string,
  storage: BlockTermRuntimeBindingStorage | null = getDefaultStorage()
): BlockTermRuntimeBinding | null {
  return (
    loadBlockTermRuntimeBindings(storage).find(
      (binding) => binding.terminalId === terminalId && binding.blockId === blockId
    ) || null
  );
}

export function rememberBlockTermRuntimeBinding(
  binding: BlockTermRuntimeBinding,
  storage: BlockTermRuntimeBindingStorage | null = getDefaultStorage()
): boolean {
  if (!storage || !isValidBinding(binding)) return false;
  const bindings = loadBlockTermRuntimeBindings(storage).filter(
    (candidate) => candidate.terminalId !== binding.terminalId || candidate.blockId !== binding.blockId
  );
  bindings.push(binding);
  writeBindings(storage, bindings);
  return true;
}

export function forgetBlockTermRuntimeBinding(
  terminalId: string,
  blockId: string,
  blockToken?: string,
  storage: BlockTermRuntimeBindingStorage | null = getDefaultStorage()
): void {
  if (!storage) return;
  const bindings = loadBlockTermRuntimeBindings(storage);
  writeBindings(
    storage,
    bindings.filter(
      (binding) =>
        binding.terminalId !== terminalId ||
        binding.blockId !== blockId ||
        (blockToken !== undefined && binding.blockToken !== blockToken)
    )
  );
}

export function pruneBlockTermRuntimeBindings(
  terminalId: string,
  retainedBlockIds: ReadonlySet<string>,
  storage: BlockTermRuntimeBindingStorage | null = getDefaultStorage()
): void {
  if (!storage) return;
  const bindings = loadBlockTermRuntimeBindings(storage);
  writeBindings(
    storage,
    bindings.filter((binding) => binding.terminalId !== terminalId || retainedBlockIds.has(binding.blockId))
  );
}
