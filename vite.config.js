import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const page = (p) => fileURLToPath(new URL(p, import.meta.url));
// LeatherFab on GitHub Pages: "/" is the landing page, "/app/" the editor.
export default defineConfig({
  base: "/LeatherFab/",
  build: {
    target: "esnext",
    rollupOptions: { input: { landing: page("index.html"), editor: page("app/index.html") } },
  },
  optimizeDeps: { exclude: ["harfbuzzjs"] },
});
