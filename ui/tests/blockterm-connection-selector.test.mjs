import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBlockTermSSHProfileEndpoint,
  getBlockTermSSHProfileAliases,
  resolveBlockTermSSHProfileReference,
} from "../src/components/terminal/blockterm-connection-selector.ts";

function profile(id, name, host, port = 22, user = "dev") {
  return { id, name, host, port, user };
}

test("resolves direct connect references by exact id before aliases", () => {
  const profiles = [
    profile("prod", "primary", "prod.example.com"),
    profile("secondary", "prod", "other.example.com"),
  ];
  assert.deepEqual(resolveBlockTermSSHProfileReference(profiles, " prod "), {
    kind: "resolved",
    profile: profiles[0],
  });
});

test("resolves a unique profile name and reports duplicate names", () => {
  const unique = profile("profile-a", "production", "prod.example.com");
  assert.deepEqual(resolveBlockTermSSHProfileReference([unique], "production"), {
    kind: "resolved",
    profile: unique,
  });

  const ambiguous = resolveBlockTermSSHProfileReference(
    [unique, profile("profile-b", "production", "backup.example.com")],
    "production"
  );
  assert.deepEqual(ambiguous, {
    kind: "error",
    code: "ambiguous-profile",
    reference: "production",
    matchingProfileIds: ["profile-a", "profile-b"],
    message: "SSH profile 'production' is ambiguous (matches: profile-a, profile-b)",
  });
});

test("resolves user-host and endpoint aliases only when unique", () => {
  const defaultPort = profile("profile-a", "alpha", "host.example.com", 22, "dev");
  const alternatePort = profile("profile-b", "beta", "host.example.com", 2202, "dev");
  const otherUser = profile("profile-c", "gamma", "host.example.com", 22, "root");

  assert.equal(resolveBlockTermSSHProfileReference([defaultPort], "dev@host.example.com").profile.id, "profile-a");
  assert.equal(resolveBlockTermSSHProfileReference([defaultPort], "host.example.com:22").profile.id, "profile-a");
  assert.equal(resolveBlockTermSSHProfileReference([alternatePort], "dev@host.example.com:2202").profile.id, "profile-b");

  const ambiguousUserHost = resolveBlockTermSSHProfileReference(
    [defaultPort, alternatePort],
    "dev@host.example.com"
  );
  assert.equal(ambiguousUserHost.kind, "error");
  assert.equal(ambiguousUserHost.code, "ambiguous-profile");
  assert.deepEqual(ambiguousUserHost.matchingProfileIds, ["profile-a", "profile-b"]);

  const ambiguousEndpoint = resolveBlockTermSSHProfileReference(
    [defaultPort, otherUser],
    "host.example.com:22"
  );
  assert.equal(ambiguousEndpoint.kind, "error");
  assert.equal(ambiguousEndpoint.code, "ambiguous-profile");
  assert.deepEqual(ambiguousEndpoint.matchingProfileIds, ["profile-a", "profile-c"]);
});

test("formats and resolves IPv6 endpoint aliases", () => {
  const ipv6 = profile("profile-v6", "ipv6", "2001:db8::1", 2222, "dev");
  assert.equal(formatBlockTermSSHProfileEndpoint(ipv6), "[2001:db8::1]:2222");
  assert.deepEqual(getBlockTermSSHProfileAliases(ipv6), [
    "2001:db8::1",
    "[2001:db8::1]:2222",
    "[2001:db8::1]",
    "dev@2001:db8::1",
    "dev@[2001:db8::1]:2222",
    "dev@[2001:db8::1]",
  ]);
  assert.equal(resolveBlockTermSSHProfileReference([ipv6], "dev@[2001:db8::1]:2222").profile.id, "profile-v6");
});

test("reports a stable not-found error for unknown or empty references", () => {
  const profiles = [profile("profile-a", "alpha", "host.example.com")];
  assert.deepEqual(resolveBlockTermSSHProfileReference(profiles, "missing"), {
    kind: "error",
    code: "unknown-profile",
    reference: "missing",
    matchingProfileIds: [],
    message: "cannot find SSH profile 'missing'",
  });
  assert.equal(resolveBlockTermSSHProfileReference(profiles, "   ").message, "cannot find SSH profile ''");
});
