import { useEffect, useRef, useState } from "preact/hooks";
import { loadConfig, loadPack, sheets } from "./assets";
import { defaultSpec, drawPreview } from "./avatar";
import { sendAvatar, sendChat, startGame, useManifest } from "./game";
import type { LobbyInfo, Manifest, TileDef } from "./types";
import {
  avatar,
  chatLines,
  credit,
  displayName,
  hearingRadius,
  isHost,
  joinError,
  lobbyName,
  lobbies,
  manifest,
  meId,
  muted,
  population,
  ready,
  rememberAvatar,
  rememberName,
  saveHostToken,
  selectedTile,
  session,
  showCharacter,
  statusText,
  tool,
} from "./ui";
import { voice } from "./voice";

export function App() {
  const hash = useHash();
  const match = /^#\/l\/([A-Za-z0-9-]+)$/.exec(hash);
  if (!ready.value) return <main className="gate"><p>Loading the office…</p></main>;
  if (match) return <Office lobbyId={match[1]} />;
  return <LobbyHome />;
}

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function bootstrap() {
  void (async () => {
    const config = await loadConfig();
    hearingRadius.value = config.hearingRadius;
    voice.ice = config.iceServers;
    voice.radius = config.hearingRadius;
    const pack = await loadPack(config.assetPack);
    manifest.value = pack;
    credit.value = pack.credit;
    if (!localStorage.getItem("office.avatar")) rememberAvatar(defaultSpec(pack));
    ready.value = true;
  })().catch((error: unknown) => {
    joinError.value = error instanceof Error ? error.message : "failed to start";
    ready.value = true;
  });
}

function LobbyHome() {
  const [name, setName] = useState(displayName.value);
  const [lobbyTitle, setLobbyTitle] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [passwords, setPasswords] = useState<Record<string, string>>({});

  useEffect(() => {
    let stop = false;
    const pull = () => {
      void fetch("/lobbies")
        .then((response) => response.json())
        .then((body: { lobbies: LobbyInfo[] }) => {
          if (!stop) lobbies.value = body.lobbies ?? [];
        })
        .catch(() => undefined);
    };
    pull();
    const timer = window.setInterval(pull, 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  const create = async (event: Event) => {
    event.preventDefault();
    joinError.value = "";
    rememberName(name.trim() || "Guest");
    const response = await fetch("/lobbies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: lobbyTitle.trim() || "Office",
        password: createPassword.trim() || undefined,
      }),
    });
    if (!response.ok) {
      joinError.value = "could not create that lobby";
      return;
    }
    const created = (await response.json()) as { id: string; name: string; hostToken: string };
    saveHostToken(created.id, created.hostToken);
    await voice.start();
    session.lobbyId = created.id;
    session.password = createPassword.trim();
    location.hash = `#/l/${created.id}`;
  };

  const join = async (lobby: LobbyInfo) => {
    const password = passwords[lobby.id]?.trim() ?? "";
    if (lobby.hasPassword && !password) {
      joinError.value = "that lobby needs a password";
      return;
    }
    joinError.value = "";
    rememberName(name.trim() || "Guest");
    await voice.start();
    session.lobbyId = lobby.id;
    session.password = password;
    location.hash = `#/l/${lobby.id}`;
  };

  return (
    <main className="home">
      <header className="home-intro">
        <p className="eyebrow">Self-hosted</p>
        <h1>Office</h1>
        <p>Walk in, talk to the people near you, and close a door when the meeting is private.</p>
      </header>
      <section className="panel">
        <h2>Your name</h2>
        <input
          value={name}
          maxlength={24}
          placeholder="Ada"
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        />
        {manifest.value && (
          <CharacterFields manifest={manifest.value} spec={avatar.value} onChange={rememberAvatar} />
        )}
      </section>
      <section className="panel">
        <h2>New lobby</h2>
        <form onSubmit={create}>
          <label>
            Name
            <input
              value={lobbyTitle}
              maxlength={32}
              placeholder="Design review"
              onInput={(event) => setLobbyTitle((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Password, optional
            <input
              type="password"
              value={createPassword}
              maxlength={64}
              placeholder="Leave empty for an open lobby"
              onInput={(event) => setCreatePassword((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button type="submit">Create and enter</button>
        </form>
      </section>
      <section className="panel">
        <h2>Open lobbies</h2>
        {joinError.value && <p className="error">{joinError.value}</p>}
        {lobbies.value.length === 0 && <p className="muted">No lobbies yet. Create the first one.</p>}
        <ul className="lobby-list">
          {lobbies.value.map((lobby) => (
            <li key={lobby.id}>
              <div>
                <strong>{lobby.name}</strong>
                <span className="muted">
                  {lobby.players} here{lobby.hasPassword ? " · password" : ""}
                </span>
              </div>
              {lobby.hasPassword && (
                <input
                  type="password"
                  placeholder="Password"
                  value={passwords[lobby.id] ?? ""}
                  onInput={(event) =>
                    setPasswords({
                      ...passwords,
                      [lobby.id]: (event.currentTarget as HTMLInputElement).value,
                    })
                  }
                />
              )}
              <button type="button" onClick={() => join(lobby)}>
                Join
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="credit">
        Art: <a href={credit.value.url}>{credit.value.name}</a>
      </p>
    </main>
  );
}

function Office({ lobbyId }: { lobbyId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"check" | "password" | "play">("check");
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancel = false;
    void fetch(`/lobbies/${lobbyId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("gone");
        return (await response.json()) as LobbyInfo;
      })
      .then((info) => {
        if (cancel) return;
        lobbyName.value = info.name;
        if (session.lobbyId !== lobbyId) session.password = "";
        if (info.hasPassword && !session.password) setPhase("password");
        else {
          session.lobbyId = lobbyId;
          setPhase("play");
        }
      })
      .catch(() => {
        joinError.value = "That lobby is gone";
        location.hash = "";
      });
    return () => {
      cancel = true;
    };
  }, [lobbyId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const pack = manifest.value;
    if (phase !== "play" || !canvas || !pack) return;
    useManifest(pack);
    const stop = startGame(canvas);
    return stop;
  }, [phase, lobbyId]);

  const unlock = async (event: Event) => {
    event.preventDefault();
    if (!password.trim()) return;
    await voice.start();
    session.lobbyId = lobbyId;
    session.password = password.trim();
    setPhase("play");
  };

  if (phase === "password") {
    return (
      <main className="gate">
        <form className="panel" onSubmit={unlock}>
          <h1>{lobbyName.value || "Lobby"}</h1>
          <p>This lobby is locked.</p>
          <input
            type="password"
            value={password}
            placeholder="Password"
            onInput={(event) => setPassword((event.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit">Enter</button>
          <button type="button" className="ghost" onClick={() => (location.hash = "")}>
            Back
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="office">
      <header className="topbar">
        <div>
          <strong>{lobbyName.value || "Office"}</strong>
          <span className="muted">
            {population.value} here · {statusText.value}
            {isHost.value ? " · you host" : ""}
          </span>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => (showCharacter.value = !showCharacter.value)}>
            Look
          </button>
          <button
            type="button"
            onClick={() => {
              muted.value = !muted.value;
              voice.setMuted(muted.value);
            }}
          >
            {muted.value ? "Unmute" : "Mute"}
          </button>
          <button type="button" className="ghost" onClick={() => (location.hash = "")}>
            Lobbies
          </button>
        </div>
      </header>
      <div className="stage">
        <canvas ref={canvasRef} />
        {isHost.value && manifest.value && (
          <aside className="palette">
            <div className="tools">
              <button type="button" className={tool.value === "paint" ? "on" : ""} onClick={() => (tool.value = "paint")}>
                Paint
              </button>
              <button type="button" className={tool.value === "lock" ? "on" : ""} onClick={() => (tool.value = "lock")}>
                Lock
              </button>
              <button type="button" className={selectedTile.value === 0 ? "on" : ""} onClick={() => (selectedTile.value = 0)}>
                Erase
              </button>
            </div>
            {manifest.value.tiles.map((tile) => (
              <Swatch key={tile.id} tile={tile} pack={manifest.value as Manifest} />
            ))}
          </aside>
        )}
        <form
          className="chat"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            sendChat(text);
            setDraft("");
          }}
        >
          <ul>
            {chatLines.value.map((line, index) => (
              <li key={`${line.id}-${index}`}>
                <b>{line.name}</b> {line.text}
              </li>
            ))}
            {chatLines.value.length === 0 && (
              <li className="muted">What you say floats over your head for anyone close enough to hear. WASD to walk. M mutes.</li>
            )}
          </ul>
          <input
            value={draft}
            maxlength={400}
            placeholder="Say something nearby"
            onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
          />
        </form>
        {showCharacter.value && manifest.value && (
          <div className="character-card panel">
            <CharacterFields
              manifest={manifest.value}
              spec={avatar.value}
              onChange={(spec) => {
                rememberAvatar(spec);
                sendAvatar(spec);
              }}
            />
          </div>
        )}
      </div>
      <footer className="credit">
        Art: <a href={credit.value.url}>{credit.value.name}</a>
        {meId.value ? "" : ""}
      </footer>
    </div>
  );
}

function CharacterFields({
  manifest: pack,
  spec,
  onChange,
}: {
  manifest: Manifest;
  spec: { preset?: string; layers?: Record<string, string> };
  onChange: (spec: { preset?: string; layers?: Record<string, string> }) => void;
}) {
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = preview.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawPreview(ctx, pack, spec, 4);
  }, [pack, spec]);

  if (pack.avatars.mode === "presets") {
    return (
      <div className="faces">
        <canvas ref={preview} width={64} height={64} />
        <div className="face-grid">
          {pack.avatars.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={spec.preset === preset.id ? "on" : ""}
              onClick={() => onChange({ preset: preset.id })}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="faces">
      <canvas ref={preview} width={64} height={64} />
      <div className="face-grid">
        {pack.avatars.groups.map((group) => (
          <label key={group.id}>
            {group.name}
            <select
              value={spec.layers?.[group.id] ?? group.options[0]?.id ?? ""}
              onChange={(event) =>
                onChange({
                  layers: { ...spec.layers, [group.id]: (event.currentTarget as HTMLSelectElement).value },
                })
              }
            >
              {group.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name ?? option.id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function Swatch({ tile, pack }: { tile: TileDef; pack: Manifest }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    const image = sheets.get(tile.sheet);
    if (!canvas || !ctx || !image) return;
    ctx.imageSmoothingEnabled = false;
    const stride = pack.sheetStride?.[tile.sheet] ?? pack.tileSize + (pack.margin ?? 0);
    ctx.drawImage(image, tile.col * stride, tile.row * stride, pack.tileSize, pack.tileSize, 0, 0, 32, 32);
  }, [tile, pack]);
  return (
    <button
      type="button"
      className={selectedTile.value === tile.id && tool.value === "paint" ? "swatch on" : "swatch"}
      title={tile.name}
      onClick={() => {
        tool.value = "paint";
        selectedTile.value = tile.id;
      }}
    >
      <canvas ref={ref} width={32} height={32} />
      <span>{tile.name}</span>
    </button>
  );
}
