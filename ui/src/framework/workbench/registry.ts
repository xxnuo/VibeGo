import type { WorkbenchPageDefinition } from "./types";

class WorkbenchRegistry {
  private pages = new Map<string, WorkbenchPageDefinition>();

  register(page: WorkbenchPageDefinition): void {
    this.pages.set(page.id, page);
  }

  unregister(id: string): void {
    this.pages.delete(id);
  }

  get(id: string): WorkbenchPageDefinition | undefined {
    return this.pages.get(id);
  }

  getAll(): WorkbenchPageDefinition[] {
    return Array.from(this.pages.values()).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
}

export const workbenchRegistry = new WorkbenchRegistry();
export const pageRegistry = workbenchRegistry;

export function registerPage(page: WorkbenchPageDefinition): void {
  workbenchRegistry.register(page);
}

export function unregisterPage(id: string): void {
  workbenchRegistry.unregister(id);
}
