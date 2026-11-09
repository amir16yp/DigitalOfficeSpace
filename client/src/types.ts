export type TileDef = {
  id: number;
  name: string;
  sheet: string;
  col: number;
  row: number;
  kind: string;
};

export type FrameRef = {
  dir: number;
  frame: number;
  sheet: string;
  col: number;
  row: number;
  dx?: number;
  dy?: number;
};

export type AvatarLayer = {
  id?: string;
  name?: string;
  sheet?: string;
  col?: number;
  row?: number;
  frames?: FrameRef[];
};

export type Manifest = {
  id: string;
  tileSize: number;
  margin?: number;
  credit: { name: string; url: string };
  sheets: Record<string, string>;
  sheetStride?: Record<string, number>;
  tiles: TileDef[];
  avatars:
    | { mode: "presets"; presets: { id: string; name: string; layers: AvatarLayer[] }[] }
    | { mode: "layers"; groups: { id: string; name: string; options: AvatarLayer[] }[] };
};

export type AvatarSpec = {
  preset?: string;
  layers?: Record<string, string>;
};

export type OfficeMap = {
  version: number;
  width: number;
  height: number;
  floor: number[];
  wall: number[];
  object: number[];
  doors: { x: number; y: number; locked: boolean }[];
};

export type PlayerSnap = {
  id: string;
  name: string;
  avatar: AvatarSpec;
  x: number;
  y: number;
  dir: number;
  moving: boolean;
};

export type LobbyInfo = {
  id: string;
  name: string;
  players: number;
  hasPassword: boolean;
};

export type IceServer = { urls: string; username?: string; credential?: string };

export type AppConfig = {
  iceServers: IceServer[];
  hearingRadius: number;
  assetPack: string;
};
