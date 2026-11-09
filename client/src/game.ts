import { composeAvatar } from "./avatar";
import { sheets } from "./assets";
import { net } from "./net";
import { cameraFor, drawWorld, type SayBubble } from "./render";
import type { AvatarSpec, Manifest, OfficeMap, PlayerSnap } from "./types";
import {
  avatar,
  chatLines,
  displayName,
  hearingRadius,
  hostToken,
  isHost,
  joinError,
  lobbyName,
  meId,
  muted,
  playerId,
  population,
  saveHostToken,
  selectedTile,
  session,
  statusText,
  tool,
} from "./ui";
import { voice } from "./voice";

export type LivePlayer = PlayerSnap & {
  tx: number;
  ty: number;
  bitmap: ImageBitmap | null;
  avatarKey: string;
};

type Say = { text: string; born: number; until: number };

const live = {
  office: null as OfficeMap | null,
  manifest: null as Manifest | null,
  players: new Map<string, LivePlayer>(),
  audible: new Set<string>(),
  says: new Map<string, Say[]>(),
};

let paintCell = "";

export function startGame(canvas: HTMLCanvasElement) {
  const keys = new Set<string>();
  let lastAxis = "";
  let running = true;
  let last = performance.now();

  const hello = () => {
    net.send({
      type: "hello",
      lobby: session.lobbyId,
      password: session.password || undefined,
      id: playerId(),
      name: displayName.value || "Guest",
      avatar: avatar.value,
      hostToken: hostToken(session.lobbyId),
    });
  };

  net.onStatus = (status) => {
    statusText.value = status;
  };
  net.onOpen = hello;
  net.onMessage = (message) => {
    void onMessage(message);
  };
  voice.onSignal = (to, data) => net.send({ type: "signal", to, data });
  voice.myId = playerId();
  voice.radius = hearingRadius.value;
  chatLines.value = [];
  live.says.clear();
  void voice.start();
  net.connect();

  const onKeyDown = (event: KeyboardEvent) => {
    if (isTyping(event)) return;
    if (event.key.toLowerCase() === "m") {
      muted.value = !muted.value;
      voice.setMuted(muted.value);
      return;
    }
    keys.add(event.key.toLowerCase());
    sendAxis();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.key.toLowerCase());
    sendAxis();
  };
  const onBlur = () => {
    keys.clear();
    sendAxis();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!isHost.value) return;
    canvas.setPointerCapture(event.pointerId);
    paintAt(event);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!isHost.value || event.buttons !== 1) return;
    paintAt(event);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);

  const resize = () => fitCanvas(canvas);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const frame = (now: number) => {
    if (!running) return;
    const dt = Math.min(50, now - last);
    last = now;
    stepPlayers(dt);
    const manifest = live.manifest;
    const office = live.office;
    const ctx = canvas.getContext("2d");
    if (ctx && manifest && office) {
      const zoom = 3 * Math.max(1, Math.round(window.devicePixelRatio || 1));
      const me = live.players.get(meId.value);
      const camera = cameraFor(me, canvas.width, canvas.height, manifest.tileSize * zoom, office.width, office.height);
      const now = performance.now();
      const drawn = [...live.players.values()].map((player) => ({
        name: player.name,
        x: player.x,
        y: player.y,
        dir: player.dir,
        moving: player.moving,
        bitmap: player.bitmap,
        says: saysFor(player.id, now),
      }));
      drawWorld(ctx, manifest, office, drawn, camera, zoom);
      voice.update(me, live.players, live.audible);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  function sendAxis() {
    let x = 0;
    let y = 0;
    if (keys.has("a") || keys.has("arrowleft")) x -= 1;
    if (keys.has("d") || keys.has("arrowright")) x += 1;
    if (keys.has("w") || keys.has("arrowup")) y -= 1;
    if (keys.has("s") || keys.has("arrowdown")) y += 1;
    const next = `${x},${y}`;
    if (next == lastAxis) return;
    lastAxis = next;
    net.send({ type: "input", x, y });
  }

  function paintAt(event: PointerEvent) {
    const office = live.office;
    const manifest = live.manifest;
    if (!office || !manifest || !isHost.value) return;
    const zoom = 3 * Math.max(1, Math.round(window.devicePixelRatio || 1));
    const tilePx = manifest.tileSize * zoom;
    const rect = canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * (canvas.width / rect.width);
    const sy = (event.clientY - rect.top) * (canvas.height / rect.height);
    const me = live.players.get(meId.value);
    const camera = cameraFor(me, canvas.width, canvas.height, tilePx, office.width, office.height);
    const x = Math.floor((sx + camera.x) / tilePx);
    const y = Math.floor((sy + camera.y) / tilePx);
    if (x < 0 || y < 0 || x >= office.width || y >= office.height) return;
    const key = `${tool.value}:${x},${y}:${selectedTile.value}`;
    if (key === paintCell) return;
    paintCell = key;
    if (tool.value === "lock") {
      const door = office.doors.some((item) => item.x === x && item.y === y);
      if (door) net.send({ type: "lock", x, y });
      return;
    }
    const tile = manifest.tiles.find((item) => item.id === selectedTile.value);
    if (!tile || selectedTile.value === 0) {
      net.send({
        type: "paint",
        edits: [
          { layer: "wall", x, y, tile: 0 },
          { layer: "object", x, y, tile: 0 },
        ],
      });
      return;
    }
    const layer = tile.kind === "floor" ? "floor" : tile.kind === "object" ? "object" : "wall";
    net.send({ type: "paint", edits: [{ layer, x, y, tile: tile.id }] });
  }

  return () => {
    running = false;
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    net.stop();
    voice.close();
    live.players.clear();
    live.office = null;
    live.audible.clear();
    live.says.clear();
  };
}

export function sendAvatar(spec: AvatarSpec) {
  net.send({ type: "avatar", avatar: spec });
}

export function sendChat(text: string) {
  net.send({ type: "chat", text });
}

async function onMessage(message: Record<string, unknown>) {
  if (message.type === "error") {
    joinError.value = String(message.message ?? "could not join");
    location.hash = "";
    net.stop();
    return;
  }
  if (message.type === "welcome") {
    meId.value = String(message.id);
    isHost.value = Boolean(message.isHost);
    lobbyName.value = String(message.lobbyName ?? "");
    if (typeof message.hostToken === "string" && session.lobbyId) {
      saveHostToken(session.lobbyId, message.hostToken);
    }
    live.office = message.office as OfficeMap;
    applySnaps((message.players as PlayerSnap[]) ?? []);
    voice.myId = meId.value;
  } else if (message.type === "snapshot") {
    applySnaps((message.players as PlayerSnap[]) ?? []);
  } else if (message.type === "office") {
    live.office = message.office as OfficeMap;
    paintCell = "";
  } else if (message.type === "audible") {
    const ids = (message.ids as string[]) ?? [];
    live.audible = new Set(ids);
    voice.sync(ids);
  } else if (message.type === "chat") {
    const line = {
      id: String(message.id),
      name: String(message.name),
      text: String(message.text),
    };
    chatLines.value = [...chatLines.value, line].slice(-80);
    pushSay(line.id, line.text);
  } else if (message.type === "signal") {
    await voice.handle(String(message.from), message.data as { kind: string; sdp?: string; candidate?: RTCIceCandidateInit });
  }
}

function applySnaps(snaps: PlayerSnap[]) {
  const seen = new Set<string>();
  for (const snap of snaps) {
    seen.add(snap.id);
    const key = JSON.stringify(snap.avatar);
    let player = live.players.get(snap.id);
    if (!player) {
      player = { ...snap, tx: snap.x, ty: snap.y, bitmap: null, avatarKey: "" };
      live.players.set(snap.id, player);
    }
    player.tx = snap.x;
    player.ty = snap.y;
    player.name = snap.name;
    player.dir = snap.dir;
    player.moving = snap.moving;
    player.avatar = snap.avatar;
    if (player.avatarKey !== key && live.manifest) {
      player.avatarKey = key;
      const target = player;
      void composeAvatar(live.manifest, snap.avatar).then((bitmap) => {
        if (target.avatarKey === key) target.bitmap = bitmap;
      });
    }
  }
  for (const id of [...live.players.keys()]) {
    if (!seen.has(id)) {
      live.players.delete(id);
      live.says.delete(id);
    }
  }
  population.value = snaps.length;
}

function pushSay(id: string, text: string) {
  const now = performance.now();
  const life = Math.min(9000, 3800 + Math.min(text.length, 180) * 35);
  const list = live.says.get(id) ?? [];
  list.push({ text, born: now, until: now + life });
  while (list.length > 3) list.shift();
  live.says.set(id, list);
}

function saysFor(id: string, now: number): SayBubble[] {
  const list = live.says.get(id);
  if (!list) return [];
  const kept = list.filter((say) => now < say.until);
  if (kept.length === 0) live.says.delete(id);
  else if (kept.length !== list.length) live.says.set(id, kept);
  return kept.map((say) => {
    const age = now - say.born;
    const left = say.until - now;
    let alpha = 1;
    if (age < 140) alpha = age / 140;
    if (left < 480) alpha = Math.min(alpha, left / 480);
    return { text: say.text, alpha };
  });
}

function stepPlayers(dt: number) {
  const k = Math.min(1, dt / 90);
  for (const player of live.players.values()) {
    player.x += (player.tx - player.x) * k;
    player.y += (player.ty - player.y) * k;
  }
}

export function useManifest(manifest: Manifest) {
  live.manifest = manifest;
}

function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}

function isTyping(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  return target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
}
