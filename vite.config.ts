import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron";
import path from "path";
import pkg from "./package.json" with { type: "json" };
import { contentSecurityPolicyPlugin } from "./vite.csp.ts";

export default defineConfig(({ command, mode }) => {
  if (command === "serve") {
    const devEnv = loadEnv(mode, process.cwd(), ["LINER_", "VITE_API_URL"]);
    for (const name of [
      "LINER_DEV_SIGNING_SECRET",
      "LINER_SIMULATE",
      "LINER_SIMULATE_COUNTRY",
      "VITE_API_URL",
    ]) {
      if (devEnv[name] && !process.env[name]) process.env[name] = devEnv[name];
    }
  }

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      react(),
      tailwindcss(),
      contentSecurityPolicyPlugin(),
      electron([
        {
          vite: {
            build: {
              lib: {
                entry: "electron/local-tracks/local-track-worker.ts",
                formats: ["cjs"],
                fileName: () => "local-track-worker.cjs",
              },
              rolldownOptions: {
                output: {
                  codeSplitting: false,
                },
              },
            },
          },
        },
        {
          entry: "electron/main.ts",
          vite: {
            define: {
              // LINER_PERSONAL_BUILD=1: a local build that must not swap in upstream ui
              // bundles or installers, which would drop the local changes
              __LINER_PERSONAL_BUILD__: JSON.stringify(
                process.env.LINER_PERSONAL_BUILD === "1",
              ),
            },
          },
        },
        {
          onstart: ({ reload }) => reload(),
          vite: {
            build: {
              rolldownOptions: {
                input: "electron/preload.ts",
                output: {
                  format: "cjs",
                  codeSplitting: false,
                  entryFileNames: "preload.cjs",
                },
              },
            },
          },
        },
      ]),
    ],
    clearScreen: false,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        "next/navigation": path.resolve(
          import.meta.dirname,
          "./src/lib/navigation.tsx",
        ),
        "next/link": path.resolve(
          import.meta.dirname,
          "./src/lib/navigation.tsx",
        ),
        "next/image": path.resolve(
          import.meta.dirname,
          "./src/components/ui/AppImage.tsx",
        ),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
    },
  };
});
