import { signal } from "@preact/signals";
import type { AvatarSpec, LobbyInfo, Manifest } from "./types";

export const statusText = signal("offline");
export const isHost = signal(false);
export const muted = signal(false);
export const population = signal(0);
export const chatLines = signal<{ id: string; name: string; text: string }[]>([]);
export const selectedTile = signal(1);
export const tool = signal<"paint" | "lock">("paint");
export const meId = signal("");
export const displayName = signal(localStorage.getItem("office.name") ?? "");
export const avatar = signal<AvatarSpec>(readAvatar());
export const showCharacter = signal(false);
export const credit = signal({ name: "Kenney", url: "https://kenney.nl" });
export const manifest = signal<Manifest | null>(null);
export const hearingRadius = signal(4);
export const lobbies = signal<LobbyInfo[]>([]);
export const lobbyName = signal("");
export const joinError = signal("");
export const ready = signal(false);

export const session = {
  lobbyId: "",
  password: "",
};

function readAvatar(): AvatarSpec {
  try {
    const raw = localStorage.getItem("office.avatar");
    if (raw) return JSON.parse(raw) as AvatarSpec;
  } catch {
    /* keep the default */
  }
  return { preset: "ada" };
}

export function rememberName(name: string) {
  displayName.value = name;
  localStorage.setItem("office.name", name);
}

export function rememberAvatar(spec: AvatarSpec) {
  avatar.value = spec;
  localStorage.setItem("office.avatar", JSON.stringify(spec));
}

export function playerId(): string {
  let id = sessionStorage.getItem("office.playerId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("office.playerId", id);
  }
  return id;
}

export function hostToken(lobbyId: string): string | undefined {
  const all = readTokens();
  return all[lobbyId];
}

export function saveHostToken(lobbyId: string, token: string) {
  const all = readTokens();
  all[lobbyId] = token;
  localStorage.setItem("office.hostTokens", JSON.stringify(all));
}

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem("office.hostTokens") || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
