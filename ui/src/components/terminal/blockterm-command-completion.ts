import {
  type BlockTermCompletionCandidate,
  type BlockTermCompletionContext,
  parseBlockTermCompletionContext,
} from "./blockterm-model.ts";

export type BlockTermCommandCompletionKind = "subcommand" | "option";

export interface BlockTermCommandCompletionCandidate extends BlockTermCompletionCandidate {
  kind: BlockTermCommandCompletionKind;
  description: string;
}

export interface BlockTermCommandCompletionResult {
  context: BlockTermCompletionContext;
  candidates: BlockTermCommandCompletionCandidate[];
  commonPrefix: string;
  ghostText: string;
}

interface CommandOptionSpec {
  names: readonly string[];
  description: string;
  takesValue?: boolean;
  repeatable?: boolean;
}

interface CommandSubcommandSpec {
  name: string;
  description: string;
  spec?: CommandSpec;
}

interface CommandSpec {
  options?: readonly CommandOptionSpec[];
  subcommands?: readonly CommandSubcommandSpec[];
}

interface LexedCommand {
  tokens: string[];
  activeWord: boolean;
}

const option = (
  names: string | readonly string[],
  description: string,
  takesValue = false,
  repeatable = false
): CommandOptionSpec => ({
  names: typeof names === "string" ? [names] : names,
  description,
  takesValue,
  repeatable,
});

const subcommand = (name: string, description: string, spec?: CommandSpec): CommandSubcommandSpec => ({
  name,
  description,
  spec,
});

const helpOptions = [option(["-h", "--help"], "Show command help"), option("--version", "Show version")];

const commandWrapperOptions = [
  option("-p", "Use a default executable search path"),
  option(["-v", "-V"], "Describe how the command name is resolved"),
];

const envWrapperOptions = [
  option(["-i", "--ignore-environment"], "Start with an empty environment"),
  option(["-u", "--unset"], "Remove an environment variable", true, true),
  option(["-C", "--chdir"], "Change directory before running", true),
  option(["-S", "--split-string"], "Split a string into arguments", true),
  option("--argv0", "Override the executed command name", true),
  option(["-0", "--null"], "End output lines with NUL"),
  option(["-v", "--debug"], "Show diagnostic information"),
];

const sudoWrapperOptions = [
  option(["-A", "--askpass"], "Use an askpass helper"),
  option(["-b", "--background"], "Run in the background"),
  option(["-E", "--preserve-env"], "Preserve the environment"),
  option(["-e", "--edit"], "Edit files instead of running a command"),
  option(["-H", "--set-home"], "Set HOME for the target user"),
  option(["-i", "--login"], "Run a login shell"),
  option(["-K", "--remove-timestamp"], "Remove cached credentials"),
  option(["-k", "--reset-timestamp"], "Ignore cached credentials"),
  option(["-l", "--list"], "List allowed commands"),
  option(["-n", "--non-interactive"], "Do not prompt"),
  option(["-P", "--preserve-groups"], "Preserve group membership"),
  option(["-S", "--stdin"], "Read the password from stdin"),
  option(["-s", "--shell"], "Run a shell"),
  option(["-V", "--version"], "Show version"),
  option(["-v", "--validate"], "Refresh cached credentials"),
  option(["-C", "--close-from"], "Close file descriptors", true),
  option(["-D", "--chdir"], "Change directory before running", true),
  option(["-g", "--group"], "Run as the specified group", true),
  option(["-h", "--host"], "Run on the specified host", true),
  option(["-p", "--prompt"], "Use a custom password prompt", true),
  option(["-R", "--chroot"], "Change the root directory", true),
  option(["-r", "--role"], "Use the specified SELinux role", true),
  option(["-T", "--command-timeout"], "Limit command runtime", true),
  option(["-t", "--type"], "Use the specified SELinux type", true),
  option(["-u", "--user"], "Run as the specified user", true),
];

const gitSpec: CommandSpec = {
  options: [
    ...helpOptions,
    option("-C", "Run as if started in this directory", true),
    option("-c", "Set a configuration value", true, true),
    option("--no-pager", "Do not pipe output into a pager"),
    option("--paginate", "Pipe output into a pager"),
  ],
  subcommands: [
    subcommand("status", "Show the working tree status", {
      options: [
        option(["-s", "--short"], "Use the short status format"),
        option(["-b", "--branch"], "Show branch information"),
        option("--porcelain", "Use a stable machine-readable format"),
        option(["-u", "--untracked-files"], "Control untracked file display", true),
        option("--ignored", "Show ignored files"),
      ],
    }),
    subcommand("switch", "Switch branches", {
      options: [
        option(["-c", "--create"], "Create and switch to a new branch", true),
        option(["-C", "--force-create"], "Reset or create and switch to a branch", true),
        option(["-d", "--detach"], "Switch to a detached HEAD"),
        option(["-f", "--force"], "Discard local changes"),
        option("--guess", "Try to match a remote tracking branch"),
      ],
    }),
    subcommand("checkout", "Switch branches or restore files", {
      options: [
        option(["-b", "--branch"], "Create a new branch", true),
        option(["-B", "--force-branch"], "Create or reset a branch", true),
        option(["-d", "--detach"], "Detach HEAD"),
        option(["-f", "--force"], "Discard local changes"),
        option(["-p", "--patch"], "Select hunks interactively"),
      ],
    }),
    subcommand("branch", "List, create, or delete branches", {
      options: [
        option(["-a", "--all"], "List local and remote branches"),
        option(["-d", "--delete"], "Delete a fully merged branch"),
        option(["-D"], "Force-delete a branch"),
        option(["-m", "--move"], "Rename a branch"),
        option(["-r", "--remotes"], "List remote-tracking branches"),
        option(["-v", "--verbose"], "Show commit and upstream information"),
      ],
    }),
    subcommand("add", "Add file contents to the index", {
      options: [
        option(["-A", "--all"], "Stage all changes"),
        option(["-p", "--patch"], "Select hunks interactively"),
        option(["-u", "--update"], "Stage modified and deleted files"),
        option(["-f", "--force"], "Allow ignored files"),
        option(["-n", "--dry-run"], "Show what would be staged"),
      ],
    }),
    subcommand("restore", "Restore working tree files", {
      options: [
        option(["-s", "--source"], "Restore from a tree", true),
        option(["-S", "--staged"], "Restore the index"),
        option(["-W", "--worktree"], "Restore the working tree"),
        option(["-p", "--patch"], "Select hunks interactively"),
      ],
    }),
    subcommand("commit", "Record changes to the repository", {
      options: [
        option(["-a", "--all"], "Stage tracked file changes"),
        option("--amend", "Replace the previous commit"),
        option(["-m", "--message"], "Use the given commit message", true),
        option("--no-verify", "Bypass commit hooks"),
        option(["-s", "--signoff"], "Add a Signed-off-by trailer"),
        option("--allow-empty", "Allow an empty commit"),
      ],
    }),
    subcommand("diff", "Show changes between commits and the working tree", {
      options: [
        option("--cached", "Show staged changes"),
        option("--staged", "Show staged changes"),
        option("--stat", "Show a diffstat"),
        option("--name-only", "Show changed file names"),
        option("--word-diff", "Show word-level changes"),
      ],
    }),
    subcommand("log", "Show commit logs", {
      options: [
        option("--oneline", "Show one commit per line"),
        option("--graph", "Draw the commit graph"),
        option("--decorate", "Show ref names"),
        option(["-n", "--max-count"], "Limit the number of commits", true),
        option("--all", "Show commits from all refs"),
      ],
    }),
    subcommand("show", "Show objects"),
    subcommand("reset", "Reset the current HEAD", {
      options: [
        option("--soft", "Keep index and working tree changes"),
        option("--mixed", "Reset the index"),
        option("--hard", "Reset index and working tree"),
        option("--keep", "Keep local changes where possible"),
      ],
    }),
    subcommand("rebase", "Reapply commits on top of another base", {
      options: [
        option(["-i", "--interactive"], "Edit the rebase plan"),
        option("--continue", "Continue the current rebase"),
        option("--abort", "Abort the current rebase"),
        option("--skip", "Skip the current commit"),
        option("--onto", "Use a different new base", true),
      ],
    }),
    subcommand("merge", "Join development histories", {
      options: [
        option("--no-ff", "Create a merge commit"),
        option("--ff-only", "Refuse non-fast-forward merges"),
        option("--squash", "Produce a squashed working tree"),
        option("--abort", "Abort the current merge"),
      ],
    }),
    subcommand("cherry-pick", "Apply existing commits", {
      options: [
        option("--continue", "Continue the current cherry-pick"),
        option("--abort", "Abort the current cherry-pick"),
        option("--skip", "Skip the current commit"),
        option(["-n", "--no-commit"], "Apply changes without committing"),
      ],
    }),
    subcommand("fetch", "Download objects and refs", {
      options: [option("--all", "Fetch all remotes"), option(["-p", "--prune"], "Prune deleted remote refs")],
    }),
    subcommand("pull", "Fetch and integrate changes", {
      options: [option("--rebase", "Rebase after fetching"), option("--ff-only", "Allow only fast-forward updates")],
    }),
    subcommand("push", "Update remote refs", {
      options: [
        option(["-u", "--set-upstream"], "Set the upstream branch"),
        option("--force-with-lease", "Force only when the remote is unchanged"),
        option("--tags", "Push all tags"),
        option("--delete", "Delete a remote ref"),
      ],
    }),
    subcommand("remote", "Manage tracked repositories", {
      subcommands: [
        subcommand("add", "Add a remote"),
        subcommand("remove", "Remove a remote"),
        subcommand("rename", "Rename a remote"),
        subcommand("set-url", "Change remote URLs"),
        subcommand("show", "Show remote information"),
        subcommand("prune", "Delete stale remote-tracking refs"),
      ],
    }),
    subcommand("stash", "Stash working tree changes", {
      subcommands: [
        subcommand("push", "Save changes to a new stash"),
        subcommand("list", "List stashes"),
        subcommand("show", "Show stash changes"),
        subcommand("pop", "Apply and remove a stash"),
        subcommand("apply", "Apply a stash"),
        subcommand("drop", "Delete a stash"),
        subcommand("clear", "Delete all stashes"),
      ],
      options: [option(["-u", "--include-untracked"], "Include untracked files")],
    }),
    subcommand("tag", "Create, list, or delete tags"),
    subcommand("worktree", "Manage multiple working trees", {
      subcommands: [
        subcommand("add", "Create a working tree"),
        subcommand("list", "List working trees"),
        subcommand("move", "Move a working tree"),
        subcommand("remove", "Remove a working tree"),
        subcommand("prune", "Prune stale worktree metadata"),
      ],
    }),
    subcommand("init", "Create an empty repository"),
    subcommand("clone", "Clone a repository"),
  ],
};

const goSpec: CommandSpec = {
  options: [...helpOptions, option("-C", "Change to a directory before running", true), option("-x", "Print commands")],
  subcommands: [
    subcommand("build", "Compile packages", {
      options: [
        option("-o", "Write output to a file", true),
        option("-race", "Enable the race detector"),
        option("-trimpath", "Remove filesystem paths"),
      ],
    }),
    subcommand("test", "Test packages", {
      options: [
        option("-run", "Run matching tests", true),
        option("-count", "Run tests multiple times", true),
        option("-race", "Enable the race detector"),
        option("-v", "Verbose output"),
      ],
    }),
    subcommand("run", "Compile and run a Go program"),
    subcommand("install", "Compile and install packages"),
    subcommand("get", "Add or update module dependencies"),
    subcommand("list", "List packages or modules"),
    subcommand("env", "Print Go environment information"),
    subcommand("fmt", "Format package sources"),
    subcommand("vet", "Report suspicious constructs"),
    subcommand("generate", "Run source generators"),
    subcommand("clean", "Remove build artifacts"),
    subcommand("mod", "Module maintenance", {
      subcommands: [
        subcommand("download", "Download modules"),
        subcommand("edit", "Edit go.mod"),
        subcommand("graph", "Print the module graph"),
        subcommand("init", "Initialize a module"),
        subcommand("tidy", "Add missing and remove unused modules"),
        subcommand("vendor", "Make a vendored copy of dependencies"),
        subcommand("verify", "Verify downloaded modules"),
        subcommand("why", "Explain why packages are needed"),
      ],
    }),
    subcommand("work", "Workspace maintenance", {
      subcommands: [
        subcommand("init", "Initialize a workspace"),
        subcommand("use", "Add modules"),
        subcommand("sync", "Sync workspace modules"),
        subcommand("edit", "Edit go.work"),
      ],
    }),
  ],
};

const pnpmSpec: CommandSpec = {
  options: [
    ...helpOptions,
    option(["-C", "--dir"], "Run as if started in this directory", true),
    option(["-F", "--filter"], "Select workspace packages", true, true),
    option(["-r", "--recursive"], "Run in every workspace package"),
    option(["-w", "--workspace-root"], "Run in the workspace root"),
  ],
  subcommands: [
    subcommand("add", "Install a package", {
      options: [
        option(["-D", "--save-dev"], "Save as a dev dependency"),
        option(["-g", "--global"], "Install globally"),
        option("--workspace", "Only add workspace packages"),
      ],
    }),
    subcommand("install", "Install project dependencies", {
      options: [
        option("--frozen-lockfile", "Fail when the lockfile needs changes"),
        option("--offline", "Use only cached packages"),
        option("--prod", "Skip dev dependencies"),
      ],
    }),
    subcommand("remove", "Remove packages"),
    subcommand("update", "Update packages"),
    subcommand("run", "Run a package script"),
    subcommand("exec", "Run a command in the project context"),
    subcommand("dlx", "Fetch and run a package"),
    subcommand("test", "Run the test script"),
    subcommand("build", "Run the build script"),
    subcommand("dev", "Run the dev script"),
    subcommand("list", "List installed packages"),
    subcommand("why", "Show why a package is installed"),
    subcommand("outdated", "Check for outdated packages"),
    subcommand("publish", "Publish a package"),
    subcommand("pack", "Create a package tarball"),
  ],
};

const dockerSpec: CommandSpec = {
  options: [
    ...helpOptions,
    option(["-H", "--host"], "Docker daemon socket", true),
    option("--context", "Docker context", true),
  ],
  subcommands: [
    subcommand("build", "Build an image", {
      options: [
        option(["-t", "--tag"], "Name and tag the image", true),
        option(["-f", "--file"], "Dockerfile path", true),
        option("--no-cache", "Do not use the build cache"),
      ],
    }),
    subcommand("run", "Run a container", {
      options: [
        option(["-d", "--detach"], "Run in the background"),
        option(["-it"], "Allocate an interactive TTY"),
        option(["-p", "--publish"], "Publish a port", true, true),
        option(["-v", "--volume"], "Bind-mount a volume", true, true),
        option("--rm", "Remove the container on exit"),
      ],
    }),
    subcommand("compose", "Manage Compose applications", {
      subcommands: [
        subcommand("up", "Create and start services", {
          options: [
            option(["-d", "--detach"], "Run in the background"),
            option("--build", "Build images before starting"),
          ],
        }),
        subcommand("down", "Stop and remove services", {
          options: [option(["-v", "--volumes"], "Remove named volumes")],
        }),
        subcommand("build", "Build services", {
          options: [
            option("--no-cache", "Do not use the build cache"),
            option("--pull", "Always try to pull newer images"),
          ],
        }),
        subcommand("logs", "View service output", {
          options: [option(["-f", "--follow"], "Follow log output"), option("--tail", "Number of lines to show", true)],
        }),
        subcommand("exec", "Run a command in a service"),
        subcommand("ps", "List service containers"),
        subcommand("pull", "Pull service images"),
        subcommand("restart", "Restart services"),
      ],
      options: [
        option(["-f", "--file"], "Compose file", true, true),
        option(["-p", "--project-name"], "Project name", true),
      ],
    }),
    subcommand("ps", "List containers"),
    subcommand("images", "List images"),
    subcommand("exec", "Run a command in a container"),
    subcommand("logs", "Fetch container logs", {
      options: [option(["-f", "--follow"], "Follow log output"), option("--tail", "Number of lines to show", true)],
    }),
    subcommand("pull", "Pull an image"),
    subcommand("push", "Push an image"),
    subcommand("inspect", "Display detailed object information"),
    subcommand("stop", "Stop containers"),
    subcommand("rm", "Remove containers", {
      options: [option(["-f", "--force"], "Force removal"), option(["-v", "--volumes"], "Remove anonymous volumes")],
    }),
  ],
};

const commandSpecs: Readonly<Record<string, CommandSpec>> = {
  docker: dockerSpec,
  git: gitSpec,
  go: goSpec,
  pnpm: pnpmSpec,
};

function isUnsafeCompletionCharacter(char: string): boolean {
  return char === "$" || char === "`" || char === "*" || char === "?" || "[]{}".includes(char);
}

function lexCurrentCommand(draft: string, cursor: number): LexedCommand | null {
  const tokens: string[] = [];
  let current = "";
  let wordActive = false;
  let quote: "none" | "single" | "double" = "none";

  const finishWord = () => {
    if (!wordActive) return;
    tokens.push(current);
    current = "";
    wordActive = false;
  };

  for (let index = 0; index < cursor; ) {
    const codePoint = draft.codePointAt(index);
    if (codePoint === undefined) return null;
    const char = String.fromCodePoint(codePoint);
    const next = index + char.length;

    if (quote === "single") {
      if (char === "'") quote = "none";
      else current += char;
      wordActive = true;
      index = next;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = "none";
        wordActive = true;
        index = next;
        continue;
      }
      if (char === "\\") {
        const escapedCodePoint = draft.codePointAt(next);
        if (escapedCodePoint === undefined || next >= cursor) return null;
        const escaped = String.fromCodePoint(escapedCodePoint);
        current += escaped;
        wordActive = true;
        index = next + escaped.length;
        continue;
      }
      if (isUnsafeCompletionCharacter(char)) return null;
      current += char;
      wordActive = true;
      index = next;
      continue;
    }

    if (/\s/u.test(char)) {
      finishWord();
      if (char === "\n" || char === "\r") tokens.length = 0;
      index = next;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      finishWord();
      tokens.length = 0;
      index = next;
      continue;
    }
    if (char === "(" || char === ")" || char === "<" || char === ">") return null;
    if (char === "#" && !wordActive) return null;
    if (isUnsafeCompletionCharacter(char)) return null;
    if (char === "'") {
      quote = "single";
      wordActive = true;
      index = next;
      continue;
    }
    if (char === '"') {
      quote = "double";
      wordActive = true;
      index = next;
      continue;
    }
    if (char === "\\") {
      const escapedCodePoint = draft.codePointAt(next);
      if (escapedCodePoint === undefined || next >= cursor) return null;
      const escaped = String.fromCodePoint(escapedCodePoint);
      current += escaped;
      wordActive = true;
      index = next + escaped.length;
      continue;
    }
    current += char;
    wordActive = true;
    index = next;
  }

  const activeWord = wordActive;
  finishWord();
  return { tokens, activeWord };
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function optionHasInlineValue(candidate: CommandOptionSpec, token: string): boolean {
  return candidate.names.some(
    (name) =>
      token.startsWith(`${name}=`) || (name.length === 2 && token.length > name.length && token.startsWith(name))
  );
}

function consumeWrapperOptions(
  tokens: readonly string[],
  start: number,
  options: readonly CommandOptionSpec[]
): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (!token.startsWith("-") || token === "-") return index;
    const matched = findOption(options, token);
    if (!matched) return tokens.length;
    index += 1;
    if (matched.takesValue && !optionHasInlineValue(matched, token)) {
      if (index >= tokens.length) return tokens.length;
      index += 1;
    }
  }
  return index;
}

function resolveCommandIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length) {
    while (index < tokens.length && isEnvironmentAssignment(tokens[index])) index += 1;
    if (tokens[index] === "command") {
      index = consumeWrapperOptions(tokens, index + 1, commandWrapperOptions);
      continue;
    }
    if (tokens[index] === "env") {
      index = consumeWrapperOptions(tokens, index + 1, envWrapperOptions);
      continue;
    }
    if (tokens[index] === "sudo") {
      index = consumeWrapperOptions(tokens, index + 1, sudoWrapperOptions);
      continue;
    }
    break;
  }
  return index;
}

function findOption(options: readonly CommandOptionSpec[], token: string): CommandOptionSpec | undefined {
  for (const candidate of options) {
    for (const name of candidate.names) {
      if (token === name) return candidate;
      if (candidate.takesValue && (token.startsWith(`${name}=`) || (name.length === 2 && token.startsWith(name)))) {
        return candidate;
      }
    }
  }
  return undefined;
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    const limit = Math.min(prefix.length, value.length);
    while (index < limit && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

function resolveGhostText(
  context: BlockTermCompletionContext,
  candidates: readonly BlockTermCommandCompletionCandidate[]
): string {
  if (candidates.length === 0 || !context.prefix || context.cursor !== context.draft.length || context.hasContentSuffix)
    return "";
  const primary = candidates[0].value;
  return primary.startsWith(context.prefix) ? primary.slice(context.prefix.length) : "";
}

export function resolveBlockTermCommandCompletion(
  draft: string,
  cursor: number
): BlockTermCommandCompletionResult | null {
  const context = parseBlockTermCompletionContext(draft, cursor);
  const lexed = lexCurrentCommand(draft, cursor);
  if (!context || !lexed || lexed.tokens.length === 0) return null;

  const commandIndex = resolveCommandIndex(lexed.tokens);
  if (commandIndex >= lexed.tokens.length) return null;
  const commandName = lexed.tokens[commandIndex].split(/[\\/]/).pop()?.toLowerCase() || "";
  const rootSpec = commandSpecs[commandName];
  if (!rootSpec) return null;

  const activeIndex = lexed.activeWord ? lexed.tokens.length - 1 : lexed.tokens.length;
  if (activeIndex <= commandIndex) return null;
  const prefix = lexed.activeWord ? lexed.tokens[activeIndex] : "";
  if (prefix !== context.prefix) return null;

  const completed = lexed.tokens.slice(commandIndex + 1, activeIndex);
  const rootOptions = rootSpec.options || [];
  let spec = rootSpec;
  let pendingOptionValue = false;
  let positionalSeen = false;
  const usedOptions = new Set<CommandOptionSpec>();

  for (const token of completed) {
    if (pendingOptionValue) {
      pendingOptionValue = false;
      continue;
    }
    if (token === "--") return null;
    const availableOptions = spec === rootSpec ? rootOptions : spec.options || [];
    const matchedOption = findOption(availableOptions, token);
    if (matchedOption) {
      usedOptions.add(matchedOption);
      const inlineValue = optionHasInlineValue(matchedOption, token);
      pendingOptionValue = Boolean(matchedOption.takesValue && !inlineValue);
      continue;
    }
    const matchedSubcommand = !positionalSeen
      ? spec.subcommands?.find((candidate) => candidate.name === token)
      : undefined;
    if (matchedSubcommand) {
      spec = matchedSubcommand.spec || {};
      positionalSeen = false;
      continue;
    }
    if (!token.startsWith("-")) positionalSeen = true;
  }

  if (pendingOptionValue || prefix.includes("=")) return null;

  let candidates: BlockTermCommandCompletionCandidate[] = [];
  if (prefix.startsWith("-")) {
    const availableOptions = spec === rootSpec ? rootOptions : spec.options || [];
    const seenNames = new Set<string>();
    for (const candidate of availableOptions) {
      if (usedOptions.has(candidate) && !candidate.repeatable) continue;
      for (const name of candidate.names) {
        if (!name.startsWith(prefix) || seenNames.has(name)) continue;
        seenNames.add(name);
        candidates.push({
          value: name,
          display: name,
          isDirectory: false,
          kind: "option",
          description: candidate.description,
        });
      }
    }
  } else if (!positionalSeen && spec.subcommands) {
    candidates = spec.subcommands
      .filter((candidate) => candidate.name.startsWith(prefix))
      .map((candidate) => ({
        value: candidate.name,
        display: candidate.name,
        isDirectory: false,
        kind: "subcommand" as const,
        description: candidate.description,
      }));
  }

  if (candidates.length === 0) return null;
  return {
    context,
    candidates,
    commonPrefix: commonPrefix(candidates.map((candidate) => candidate.value)),
    ghostText: resolveGhostText(context, candidates),
  };
}
