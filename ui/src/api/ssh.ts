import { request } from "@/api/request";

export type SSHAuthMethod = "auto" | "agent" | "private_key" | "password";

export interface SSHAuthSecrets {
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export interface SSHProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_method: SSHAuthMethod;
  identity_file?: string;
  connect_timeout: number;
  connected: boolean;
  created_at: number;
  updated_at: number;
}

export interface SSHProfileInput {
  name?: string;
  host: string;
  port?: number;
  user?: string;
  auth_method?: SSHAuthMethod;
  identity_file?: string;
  connect_timeout?: number;
}

export interface SSHHostKeyChallenge {
  id: string;
  profile_id: string;
  endpoint: string;
  key_type: string;
  fingerprint: string;
  expires_at: number;
}

export const sshApi = {
  listProfiles: () => request<{ profiles: SSHProfile[] }>("/ssh/profiles"),

  createProfile: (input: SSHProfileInput) =>
    request<{ profile: SSHProfile }>("/ssh/profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateProfile: (id: string, input: Partial<SSHProfileInput>) =>
    request<{ profile: SSHProfile }>(`/ssh/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteProfile: (id: string) =>
    request<{ ok: boolean }>(`/ssh/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  connect: (id: string, auth: SSHAuthSecrets = {}) =>
    request<{ ok: boolean; profile_id: string; connected: boolean }>(
      `/ssh/profiles/${encodeURIComponent(id)}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ auth }),
      }
    ),

  disconnect: (id: string) =>
    request<{ ok: boolean; profile_id: string; connected: boolean }>(
      `/ssh/profiles/${encodeURIComponent(id)}/disconnect`,
      { method: "POST" }
    ),

  confirmHostKey: (challengeId: string) =>
    request<{ ok: boolean; endpoint: string; key_type: string; fingerprint: string }>(
      `/ssh/host-key-challenges/${encodeURIComponent(challengeId)}/confirm`,
      { method: "POST" }
    ),

  resetKnownHost: (profileId: string, expectedFingerprint: string) =>
    request<{ ok: boolean; endpoint: string; fingerprint: string; connected: boolean }>(
      `/ssh/profiles/${encodeURIComponent(profileId)}/known-host`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_fingerprint: expectedFingerprint }),
      }
    ),
};
