import { sheets, strideFor } from "./assets";
import type { AvatarLayer, AvatarSpec, FrameRef, Manifest } from "./types";

const DIRS = 4;
const FRAMES = 2;

export function defaultSpec(manifest: Manifest): AvatarSpec {
  if (manifest.avatars.mode === "presets") {
    return { preset: manifest.avatars.presets[0]?.id ?? "ada" };
  }
  const layers: Record<string, string> = {};
  for (const group of manifest.avatars.groups) {
    if (group.options[0]?.id) layers[group.id] = group.options[0].id;
  }
  return { layers };
}

export async function composeAvatar(manifest: Manifest, spec: AvatarSpec): Promise<ImageBitmap> {
  const size = manifest.tileSize;
  const canvas = document.createElement("canvas");
  canvas.width = size * FRAMES;
  canvas.height = size * DIRS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingEnabled = false;
  paintSpec(ctx, manifest, spec, size);
  return createImageBitmap(canvas);
}

export function drawPreview(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  spec: AvatarSpec,
  scale: number,
) {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const size = manifest.tileSize;
  ctx.save();
  ctx.scale(scale, scale);
  paintSpec(ctx, manifest, spec, size, true);
  ctx.restore();
}

function paintSpec(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  spec: AvatarSpec,
  size: number,
  preview = false,
) {
  const layers = resolveLayers(manifest, spec);
  for (let dir = 0; dir < DIRS; dir++) {
    for (let frame = 0; frame < FRAMES; frame++) {
      if (preview && (dir !== 0 || frame !== 0)) continue;
      const dx = frame * size;
      const dy = dir * size;
      ctx.clearRect(dx, dy, size, size);
      for (const layer of layers) {
        const ref = frameOf(layer, dir, frame);
        if (!ref) continue;
        const image = sheets.get(ref.sheet);
        if (!image) continue;
        const stride = strideFor(manifest, ref.sheet);
        ctx.drawImage(
          image,
          ref.col * stride,
          ref.row * stride,
          size,
          size,
          dx + (ref.dx ?? 0),
          dy + (ref.dy ?? 0),
          size,
          size,
        );
      }
    }
  }
}

function resolveLayers(manifest: Manifest, spec: AvatarSpec): AvatarLayer[] {
  if (manifest.avatars.mode === "presets") {
    const preset =
      manifest.avatars.presets.find((item) => item.id === spec.preset) ??
      manifest.avatars.presets[0];
    return preset?.layers ?? [];
  }
  const chosen: AvatarLayer[] = [];
  for (const group of manifest.avatars.groups) {
    const id = spec.layers?.[group.id] ?? group.options[0]?.id;
    const option = group.options.find((item) => item.id === id) ?? group.options[0];
    if (option) chosen.push(option);
  }
  return chosen;
}

function frameOf(layer: AvatarLayer, dir: number, frame: number): FrameRef | null {
  if (layer.frames && layer.frames.length > 0) {
    return (
      layer.frames.find((item) => item.dir === dir && item.frame === frame) ??
      layer.frames.find((item) => item.dir === dir && item.frame === 0) ??
      layer.frames.find((item) => item.dir === 0 && item.frame === 0) ??
      layer.frames[0]
    );
  }
  if (layer.sheet == null || layer.col == null || layer.row == null) return null;
  return {
    dir,
    frame,
    sheet: layer.sheet,
    col: layer.col,
    row: layer.row,
    dy: frame === 1 ? 1 : 0,
  };
}
