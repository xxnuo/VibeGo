// Copyright 2023, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface BlockTermRendererCommandDefinition {
  name: string;
  aliases?: readonly string[];
  mode?: "edit" | "view";
  shouldFocus: boolean;
}

export interface BlockTermRendererRegistration<Name extends string = string> {
  name: Name;
  commands: readonly BlockTermRendererCommandDefinition[];
}

export const BLOCKTERM_RENDERER_DEFINITIONS = [
  {
    name: "code",
    commands: [
      { name: "codeedit", mode: "edit", shouldFocus: true },
      { name: "codeview", mode: "view", shouldFocus: true },
    ],
  },
  {
    name: "markdown",
    commands: [{ name: "markdownview", aliases: ["mdview"], shouldFocus: true }],
  },
  {
    name: "csv",
    commands: [{ name: "csvview", shouldFocus: true }],
  },
  {
    name: "image",
    commands: [{ name: "imageview", shouldFocus: false }],
  },
  {
    name: "pdf",
    commands: [{ name: "pdfview", shouldFocus: false }],
  },
  {
    name: "media",
    commands: [{ name: "mediaview", shouldFocus: false }],
  },
  {
    name: "mustache",
    commands: [{ name: "mustacheview", aliases: ["mustache"], shouldFocus: true }],
  },
  {
    name: "openai",
    commands: [{ name: "chat", aliases: ["openai", "model"], shouldFocus: true }],
  },
] as const satisfies readonly BlockTermRendererRegistration[];

export type BlockTermRendererName = (typeof BLOCKTERM_RENDERER_DEFINITIONS)[number]["name"];
export type BlockTermRendererDefinition = BlockTermRendererRegistration<BlockTermRendererName>;
export type BlockTermRendererSelection = "terminal" | "none" | BlockTermRendererName;
export type BlockTermRendererSwitchResolution =
  | { ok: true; patch: { renderer: BlockTermRendererSelection; stateJson: string } }
  | { ok: false; reason: "unsupported-kind" | "unknown-renderer" };

export interface BlockTermRendererCommandResolution<Name extends string = BlockTermRendererName> {
  renderer: BlockTermRendererRegistration<Name>;
  command: BlockTermRendererCommandDefinition;
  matchedName: string;
  isAlias: boolean;
}

export interface BlockTermRendererDispatchResolution<Name extends string, Handler> {
  renderer: BlockTermRendererRegistration<Name>;
  handler: Handler;
}

export interface BlockTermRendererDispatch<Name extends string, Handler> {
  resolve(name: string | null | undefined): BlockTermRendererDispatchResolution<Name, Handler> | null;
}

export class BlockTermRendererRegistry<Name extends string> {
  private readonly definitions: readonly BlockTermRendererRegistration<Name>[];
  private readonly renderers = new Map<string, BlockTermRendererRegistration<Name>>();
  private readonly commands = new Map<
    string,
    { renderer: BlockTermRendererRegistration<Name>; command: BlockTermRendererCommandDefinition; isAlias: boolean }
  >();

  constructor(definitions: readonly BlockTermRendererRegistration<Name>[]) {
    this.definitions = Object.freeze([...definitions]);
    for (const renderer of definitions) {
      if (!renderer.name || renderer.name === "terminal" || renderer.name === "none") {
        throw new Error(`invalid renderer name '${renderer.name}'`);
      }
      if (this.renderers.has(renderer.name)) throw new Error(`renderer '${renderer.name}' is already registered`);
      this.renderers.set(renderer.name, renderer);
      for (const command of renderer.commands) {
        this.registerCommand(command.name, renderer, command, false);
        for (const alias of command.aliases || []) this.registerCommand(alias, renderer, command, true);
      }
    }
  }

  private registerCommand(
    name: string,
    renderer: BlockTermRendererRegistration<Name>,
    command: BlockTermRendererCommandDefinition,
    isAlias: boolean
  ): void {
    if (!name) throw new Error(`renderer '${renderer.name}' has an empty command name`);
    if (this.commands.has(name)) throw new Error(`renderer command '${name}' is already registered`);
    this.commands.set(name, { renderer, command, isAlias });
  }

  all(): readonly BlockTermRendererRegistration<Name>[] {
    return this.definitions;
  }

  get(name: string | null | undefined): BlockTermRendererRegistration<Name> | null {
    if (!name) return null;
    return this.renderers.get(name) || null;
  }

  resolveCommand(name: string): BlockTermRendererCommandResolution<Name> | null {
    const resolved = this.commands.get(name);
    if (!resolved) return null;
    return { ...resolved, matchedName: name };
  }

  createDispatch<Handler>(handlers: Readonly<Record<Name, Handler>>): BlockTermRendererDispatch<Name, Handler> {
    for (const renderer of this.definitions) {
      if (!Object.hasOwn(handlers, renderer.name)) {
        throw new Error(`renderer '${renderer.name}' has no dispatch handler`);
      }
    }
    return Object.freeze({
      resolve: (name: string | null | undefined) => {
        const renderer = this.get(name);
        if (!renderer) return null;
        return { renderer, handler: handlers[renderer.name] };
      },
    });
  }
}

export function createBlockTermRendererRegistry<Name extends string>(
  definitions: readonly BlockTermRendererRegistration<Name>[]
): BlockTermRendererRegistry<Name> {
  return new BlockTermRendererRegistry(definitions);
}

export const blockTermRendererRegistry = createBlockTermRendererRegistry(BLOCKTERM_RENDERER_DEFINITIONS);

export const BLOCKTERM_RENDERER_NAMES = Object.freeze(
  BLOCKTERM_RENDERER_DEFINITIONS.map((renderer) => renderer.name)
) as readonly BlockTermRendererName[];

export const BLOCKTERM_RENDERER_SELECTIONS = Object.freeze([
  "terminal",
  ...BLOCKTERM_RENDERER_NAMES.filter((renderer) => renderer !== "openai"),
  "none",
]) as readonly BlockTermRendererSelection[];

export function isBlockTermRendererSelection(value: string): value is BlockTermRendererSelection {
  return BLOCKTERM_RENDERER_SELECTIONS.includes(value as BlockTermRendererSelection);
}

export function resolveBlockTermRendererSwitch(
  block: { kind: string },
  renderer: string
): BlockTermRendererSwitchResolution {
  if (block.kind !== "command") return { ok: false, reason: "unsupported-kind" };
  if (!isBlockTermRendererSelection(renderer)) return { ok: false, reason: "unknown-renderer" };
  return {
    ok: true,
    patch: {
      renderer,
      stateJson: renderer === "terminal" || renderer === "none" ? "" : '{"prompt:source":"pty"}',
    },
  };
}
