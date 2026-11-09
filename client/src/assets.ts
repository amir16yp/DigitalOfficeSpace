import type { AppConfig, Manifest } from "./types";

export const sheets = new Map<string, HTMLImageElement>();

export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch("/config");
  if (!response.ok) throw new Error("config unavailable");
  return (await response.json()) as AppConfig;
}

export async function loadPack(pack: string): Promise<Manifest> {
  const response = await fetch(`/assets/${pack}/manifest.json`);
  if (!response.ok) throw new Error("art pack missing");
  const manifest = (await response.json()) as Manifest;
  await Promise.all(
    Object.entries(manifest.sheets).map(async ([name, file]) => {
      const image = new Image();
      image.src = `/assets/${pack}/${file}`;
      await image.decode();
      sheets.set(name, image);
    }),
  );
  return manifest;
}

export function strideFor(manifest: Manifest, sheet: string): number {
  return manifest.sheetStride?.[sheet] ?? manifest.tileSize + (manifest.margin ?? 0);
}
