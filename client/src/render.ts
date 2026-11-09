import { sheets, strideFor } from "./assets";
import type { Manifest, OfficeMap } from "./types";

export type SayBubble = {
  text: string;
  alpha: number;
};

export type DrawnPlayer = {
  name: string;
  x: number;
  y: number;
  dir: number;
  moving: boolean;
  bitmap: ImageBitmap | null;
  says: SayBubble[];
};

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  office: OfficeMap,
  players: DrawnPlayer[],
  camera: { x: number; y: number },
  zoom: number,
) {
  const size = manifest.tileSize * zoom;
  const viewW = ctx.canvas.width;
  const viewH = ctx.canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = "#12100e";
  ctx.fillRect(0, 0, viewW, viewH);

  const x0 = Math.max(0, Math.floor(camera.x / size) - 1);
  const y0 = Math.max(0, Math.floor(camera.y / size) - 1);
  const x1 = Math.min(office.width, Math.ceil((camera.x + viewW) / size) + 1);
  const y1 = Math.min(office.height, Math.ceil((camera.y + viewH) / size) + 1);
  const locked = new Set(office.doors.filter((door) => door.locked).map((door) => `${door.x},${door.y}`));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = y * office.width + x;
      drawTile(ctx, manifest, office.floor[index], x * size - camera.x, y * size - camera.y, zoom);
    }
  }

  type Item = { y: number; draw: () => void };
  const items: Item[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = y * office.width + x;
      const wall = office.wall[index];
      const object = office.object[index];
      if (wall) {
        items.push({
          y: y + 1,
          draw: () => {
            drawTile(ctx, manifest, wall, x * size - camera.x, y * size - camera.y, zoom);
            if (locked.has(`${x},${y}`)) {
              ctx.fillStyle = "rgba(176, 48, 32, 0.45)";
              ctx.fillRect(x * size - camera.x, y * size - camera.y, size, size);
            }
          },
        });
      }
      if (object) {
        items.push({
          y: y + 1,
          draw: () => drawTile(ctx, manifest, object, x * size - camera.x, y * size - camera.y, zoom),
        });
      }
    }
  }
  for (const player of players) {
    items.push({
      y: player.y + 0.35,
      draw: () => drawPlayer(ctx, manifest, player, camera, zoom),
    });
  }
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();
  for (const player of players) drawSays(ctx, manifest, player, camera, zoom);
}

export function cameraFor(
  me: { x: number; y: number } | undefined,
  viewW: number,
  viewH: number,
  tilePx: number,
  mapW: number,
  mapH: number,
) {
  const mapPxW = mapW * tilePx;
  const mapPxH = mapH * tilePx;
  if (!me) return { x: 0, y: 0 };
  let x = me.x * tilePx - viewW / 2;
  let y = me.y * tilePx - viewH / 2;
  x = mapPxW < viewW ? (mapPxW - viewW) / 2 : Math.max(0, Math.min(mapPxW - viewW, x));
  y = mapPxH < viewH ? (mapPxH - viewH) / 2 : Math.max(0, Math.min(mapPxH - viewH, y));
  return { x: Math.round(x), y: Math.round(y) };
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  id: number,
  dx: number,
  dy: number,
  zoom: number,
) {
  if (!id) return;
  const tile = manifest.tiles.find((item) => item.id === id);
  if (!tile) return;
  const image = sheets.get(tile.sheet);
  if (!image) return;
  const stride = strideFor(manifest, tile.sheet);
  const size = manifest.tileSize;
  ctx.drawImage(
    image,
    tile.col * stride,
    tile.row * stride,
    size,
    size,
    Math.round(dx),
    Math.round(dy),
    size * zoom,
    size * zoom,
  );
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  player: DrawnPlayer,
  camera: { x: number; y: number },
  zoom: number,
) {
  const size = manifest.tileSize * zoom;
  const dx = Math.round(player.x * size - camera.x - size / 2);
  const dy = Math.round(player.y * size - camera.y - size * 0.85);
  if (player.bitmap) {
    const frame = player.moving ? Math.floor(performance.now() / 180) % 2 : 0;
    ctx.drawImage(
      player.bitmap,
      frame * manifest.tileSize,
      player.dir * manifest.tileSize,
      manifest.tileSize,
      manifest.tileSize,
      dx,
      dy,
      size,
      size,
    );
  }
  ctx.font = `${Math.max(11, 4 * zoom)}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.fillStyle = "#fffaf3";
  const labelY = dy - 2;
  ctx.strokeText(player.name, dx + size / 2, labelY);
  ctx.fillText(player.name, dx + size / 2, labelY);
}

function drawSays(
  ctx: CanvasRenderingContext2D,
  manifest: Manifest,
  player: DrawnPlayer,
  camera: { x: number; y: number },
  zoom: number,
) {
  if (player.says.length === 0) return;
  const size = manifest.tileSize * zoom;
  const dx = Math.round(player.x * size - camera.x - size / 2);
  const dy = Math.round(player.y * size - camera.y - size * 0.85);
  const anchorX = dx + size / 2;
  const fontSize = Math.max(12, Math.round(3.5 * zoom));
  const nameFont = Math.max(11, 4 * zoom);
  const maxText = Math.round(Math.max(size * 4.2, fontSize * 8));
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.42);
  const lineH = Math.round(fontSize * 1.28);
  const radius = Math.round(fontSize * 0.55);
  const gap = Math.round(fontSize * 0.35);
  const viewW = ctx.canvas.width;
  let bottom = dy - nameFont - 6;

  ctx.save();
  ctx.font = `600 ${fontSize}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  for (let i = player.says.length - 1; i >= 0; i--) {
    const say = player.says[i];
    const newest = i === player.says.length - 1;
    const lines = capLines(wrapLines(ctx, say.text, maxText), ctx, maxText);
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), fontSize);
    const boxW = Math.ceil(textWidth + padX * 2);
    const boxH = lines.length * lineH + padY * 2;
    const tailH = newest ? Math.round(fontSize * 0.48) : 0;
    let boxX = Math.round(anchorX - boxW / 2);
    boxX = Math.max(6, Math.min(viewW - boxW - 6, boxX));
    const boxY = Math.round(bottom - tailH - boxH);
    const tailX = Math.max(boxX + radius + 8, Math.min(boxX + boxW - radius - 8, anchorX));

    ctx.save();
    ctx.globalAlpha = say.alpha;
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = Math.max(4, fontSize * 0.45);
    ctx.shadowOffsetY = Math.max(1, fontSize * 0.12);
    traceBubble(ctx, boxX, boxY, boxW, boxH, radius, newest ? tailX : 0, tailH);
    ctx.fillStyle = "#fffaf3";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = Math.max(1, zoom * 0.35);
    ctx.strokeStyle = "rgba(42, 32, 24, 0.55)";
    ctx.stroke();
    ctx.fillStyle = "#1c1612";
    lines.forEach((line, index) => {
      const y = boxY + padY + lineH * index + lineH / 2;
      ctx.fillText(line, boxX + boxW / 2, y);
    });
    ctx.restore();
    bottom = boxY - gap;
  }
  ctx.restore();
}

function traceBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  tailX: number,
  tailH: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  if (tailH > 0) {
    const tailW = Math.max(7, Math.round(radius * 0.7));
    const left = Math.max(x + radius, Math.min(tailX - tailW, x + w - radius - tailW * 2));
    const right = left + tailW * 2;
    ctx.lineTo(right, y + h);
    ctx.lineTo(tailX, y + h + tailH);
    ctx.lineTo(left, y + h);
  }
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      for (const piece of breakWord(ctx, word, maxWidth)) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = piece;
        } else {
          line = candidate;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function breakWord(ctx: CanvasRenderingContext2D, word: string, maxWidth: number) {
  if (ctx.measureText(word).width <= maxWidth) return [word];
  const pieces: string[] = [];
  let chunk = "";
  for (const char of word) {
    const next = chunk + char;
    if (chunk && ctx.measureText(next).width > maxWidth) {
      pieces.push(chunk);
      chunk = char;
    } else {
      chunk = next;
    }
  }
  if (chunk) pieces.push(chunk);
  return pieces;
}

function capLines(lines: string[], ctx: CanvasRenderingContext2D, maxWidth: number) {
  if (lines.length <= 4) return lines;
  const kept = lines.slice(0, 4);
  let last = kept[3];
  while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  kept[3] = `${last}…`;
  return kept;
}
