import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8080", ws: true },
      "/config": "http://127.0.0.1:8080",
      "/assets": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
      "/lobbies": "http://127.0.0.1:8080",
    },
  },
});
