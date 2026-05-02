import { workbenchRegistry } from "@/framework/workbench/registry";
import { contextKeys } from "./context-key-service";
import type { PluginHostCommands } from "./types";

const handlers = workbenchRegistry.commandHandlers;
export const commands: PluginHostCommands = {
  register(id, handler) {
    if (
      handlers.has(id) ||
      workbenchRegistry
        .getPlugins()
        .some((plugin) => plugin.contributions?.commands?.some((command) => command.id === id))
    )
      throw new Error(`Command already registered: ${id}`);
    handlers.set(id, handler);
    return () => {
      if (handlers.get(id) === handler) handlers.delete(id);
    };
  },
  async execute<T>(id: string, ...args: any[]): Promise<T> {
    const command = workbenchRegistry
      .getPlugins()
      .flatMap((plugin) => plugin.contributions?.commands || [])
      .find((command) => command.id === id);
    const handler = handlers.get(id) || (contextKeys.evalWhen(command?.when) ? command?.handler : undefined);
    if (!handler) throw new Error(`Command unavailable: ${id}`);
    return (await handler(...args)) as T;
  },
  getCommands() {
    return [
      ...new Set([
        ...handlers.keys(),
        ...workbenchRegistry
          .getPlugins()
          .flatMap((plugin) => plugin.contributions?.commands?.map((command) => command.id) || []),
      ]),
    ];
  },
};
