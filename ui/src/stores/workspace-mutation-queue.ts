let workspaceMutationChain: Promise<void> = Promise.resolve();

export function enqueueWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = workspaceMutationChain.catch(() => {}).then(operation);
  workspaceMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
