interface SpeculativeTerminalCleanupApi {
  delete: (terminalId: string) => Promise<unknown>;
  close: (terminalId: string) => Promise<unknown>;
}

export async function cleanupSpeculativeTerminal(
  terminalId: string,
  api: SpeculativeTerminalCleanupApi
): Promise<void> {
  try {
    await api.delete(terminalId);
  } catch {
    await api.close(terminalId).catch(() => {});
  }
}
