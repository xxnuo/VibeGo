// Copyright 2026, VibeGo contributors
// SPDX-License-Identifier: Apache-2.0

import type { SSHProfile } from "@/api/ssh";

export type BlockTermSSHProfileReference = Pick<SSHProfile, "id" | "name" | "host" | "port" | "user">;

export type BlockTermSSHProfileResolution =
  | { kind: "resolved"; profile: BlockTermSSHProfileReference }
  | {
      kind: "error";
      code: "ambiguous-profile" | "unknown-profile";
      reference: string;
      matchingProfileIds: string[];
      message: string;
    };

function formatHostForEndpoint(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function formatBlockTermSSHProfileEndpoint(
  profile: Pick<BlockTermSSHProfileReference, "host" | "port">
): string {
  return `${formatHostForEndpoint(profile.host)}:${profile.port}`;
}

export function getBlockTermSSHProfileAliases(profile: BlockTermSSHProfileReference): readonly string[] {
  const host = profile.host.trim();
  const user = profile.user.trim();
  const endpoint = formatBlockTermSSHProfileEndpoint({ host, port: profile.port });
  const aliases = new Set<string>([host, endpoint]);
  if (host.includes(":")) aliases.add(`[${host}]`);
  if (user) {
    aliases.add(`${user}@${host}`);
    aliases.add(`${user}@${endpoint}`);
    if (host.includes(":")) aliases.add(`${user}@[${host}]`);
  }
  return [...aliases];
}

function ambiguousProfileResolution(
  reference: string,
  profiles: readonly BlockTermSSHProfileReference[]
): BlockTermSSHProfileResolution {
  const matchingProfileIds = [...new Set(profiles.map((profile) => profile.id))].sort();
  return {
    kind: "error",
    code: "ambiguous-profile",
    reference,
    matchingProfileIds,
    message: `SSH profile '${reference}' is ambiguous (matches: ${matchingProfileIds.join(", ")})`,
  };
}

function resolveUniqueMatches(
  reference: string,
  profiles: readonly BlockTermSSHProfileReference[]
): BlockTermSSHProfileResolution | null {
  const matches = [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
  if (matches.length === 1) return { kind: "resolved", profile: matches[0] };
  return matches.length > 1 ? ambiguousProfileResolution(reference, matches) : null;
}

/** Resolve the profile operand accepted by direct `/connect` commands. */
export function resolveBlockTermSSHProfileReference(
  profiles: readonly BlockTermSSHProfileReference[],
  rawReference: string
): BlockTermSSHProfileResolution {
  const reference = rawReference.trim();

  const byId = profiles.find((profile) => profile.id === reference);
  if (byId) return { kind: "resolved", profile: byId };

  const byName = resolveUniqueMatches(
    reference,
    profiles.filter((profile) => profile.name === reference)
  );
  if (byName) return byName;

  const byAlias = resolveUniqueMatches(
    reference,
    profiles.filter((profile) => getBlockTermSSHProfileAliases(profile).includes(reference))
  );
  if (byAlias) return byAlias;

  return {
    kind: "error",
    code: "unknown-profile",
    reference,
    matchingProfileIds: [],
    message: `cannot find SSH profile '${reference}'`,
  };
}
