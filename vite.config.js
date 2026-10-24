import { defineConfig } from "vite";
// LeatherFab: a single-page editor served from GitHub Pages at /LeatherFab/.
export default defineConfig({
  base: "/LeatherFab/",
  build: { target: "esnext" },
  optimizeDeps: { exclude: ["harfbuzzjs"] },
});
