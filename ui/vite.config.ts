import { createReadStream, type Stats, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const proxyTarget = process.env.VG_DEV_PROXY_TARGET || "http://127.0.0.1:11984";
const proxy = {
  "/api": {
    target: proxyTarget,
    changeOrigin: true,
    secure: false,
    ws: true,
  },
  "/version": {
    target: proxyTarget,
    changeOrigin: true,
    secure: false,
  },
};

const sherpaAssetDir = path.resolve(import.meta.dirname, "../assets/sherpa");

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".data":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

function requestPath(req: IncomingMessage): string | null {
  try {
    const pathname = decodeURIComponent((req.url || "").split("?")[0] || "");
    let relPath = pathname.replace(/^\/+/, "");
    if (relPath.startsWith("sherpa/")) {
      relPath = relPath.slice("sherpa/".length);
    }
    return relPath || null;
  } catch {
    return null;
  }
}

function serveSherpa(req: IncomingMessage, res: ServerResponse): void {
  const relPath = requestPath(req);
  if (!relPath) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const filePath = path.resolve(sherpaAssetDir, relPath);
  if (!filePath.startsWith(sherpaAssetDir + path.sep)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType(filePath));
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "public, max-age=3600");
  createReadStream(filePath).pipe(res);
}

function sherpaAssetPlugin(): Plugin {
  return {
    name: "vibego-sherpa-assets",
    configureServer(server) {
      server.middlewares.use("/sherpa", serveSherpa);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/sherpa", serveSherpa);
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), sherpaAssetPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        httpUpgrade: path.resolve(import.meta.dirname, "http-upgrade.html"),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 15173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 15173,
    proxy,
  },
});
