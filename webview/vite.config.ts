import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../dist-webview"),
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      output: {
        entryFileNames: "webview.js",
        assetFileNames: "webview.[ext]",
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
