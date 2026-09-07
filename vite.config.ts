import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * Rational is a static site, so the project it talks to is compiled into the
 * bundle. `rational.config.json` names that project -- endpoint, ids, and the
 * public project key, all of them public values, and this repository commits
 * the one the published site uses. A checkout without it falls back to the
 * example file, whose ids are placeholders; `src/config.ts` reads those as "no
 * project" and runs the app entirely against its in-browser fake backend, so a
 * fork builds and runs before it has a project of its own.
 *
 * `base` is `/rational/` for the production build because GitHub Pages serves
 * a project page from a subpath, and every asset the built `index.html` names
 * has to be under it. The dev server and the browser suite stay at `/`, where
 * the copied Playwright configuration expects them.
 *
 * The data plane sends no CORS headers, so in development the dev server
 * proxies `/v1` (and the function route) to the configured endpoint and the
 * app calls same-origin -- the topology a deployment has behind its reverse
 * proxy. A deployed site calls the endpoint cross-origin instead, which is
 * what `mako allowed-origins set --origin` allows.
 */
interface RationalConfigFile {
  readonly endpoint: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly publicProjectKey: string;
  /** Where the edge gateway serves the environment's functions, when deployed. */
  readonly functionsEndpoint?: string | null;
  readonly signIn?: {
    readonly providers: ReadonlyArray<{
      readonly name: string;
      readonly enabled: boolean;
      readonly label?: string;
    }>;
    readonly magicLinks: boolean;
  };
}

function readConfigFile(): RationalConfigFile | null {
  // `RATIONAL_CONFIG=example` asks for the placeholder, which is how the
  // wire-mocked suite gets the in-browser fake in a checkout that names a real
  // project -- the published one does.
  const names =
    process.env.RATIONAL_CONFIG === "example"
      ? ["rational.config.example.json"]
      : ["rational.config.json", "rational.config.example.json"];
  for (const name of names) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as RationalConfigFile;
  }
  return null;
}

export default defineConfig(({ command }) => {
  const configFile = readConfigFile();
  const liveEndpoint = process.env.MAKO_LIVE_ENDPOINT ?? configFile?.endpoint;
  const functionsEndpoint =
    process.env.MAKO_FUNCTIONS_ENDPOINT ?? configFile?.functionsEndpoint ?? undefined;
  const runtimeEnvironment =
    configFile === null
      ? null
      : {
          ...configFile,
          endpoint: command === "serve" ? "same-origin" : configFile.endpoint,
          functionsEndpoint:
            command === "serve" && functionsEndpoint !== undefined
              ? "same-origin"
              : (configFile.functionsEndpoint ?? null),
        };
  const proxy: Record<string, ProxyOptions> = {};
  if (liveEndpoint !== undefined) {
    proxy["/v1"] = {
      target: liveEndpoint,
      changeOrigin: false,
      configure: (server) => {
        server.on("proxyRes", (proxyRes) => {
          // The live pull stream is server-sent events; never buffer it.
          if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
            proxyRes.headers["cache-control"] = "no-cache";
          }
        });
      },
    };
  }
  if (functionsEndpoint !== undefined && functionsEndpoint !== null) {
    proxy["^/[^/]+--[^/]+/functions/v1/"] = {
      target: functionsEndpoint,
      changeOrigin: false,
    };
  }
  return {
    base: command === "build" ? "/rational/" : "/",
    plugins: [tailwindcss()],
    // The design system travels with this repository as sources under
    // `src/kit`; its package name resolves there.
    resolve: {
      alias: {
        "@mako-cloud/ui": fileURLToPath(new URL("./src/kit/index.ts", import.meta.url)),
      },
    },
    // Pre-bundled up front rather than on the first request, which would
    // otherwise take a minute cold and reload the page mid-way through a test.
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "recharts",
        "radix-ui",
        "lucide-react",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
      ],
    },
    define: { __RATIONAL_ENV__: JSON.stringify(runtimeEnvironment) },
    build: {
      outDir: "web-dist",
      emptyOutDir: true,
      // The libraries change on their own schedule; kept apart from the app's
      // own code so a release does not invalidate every byte.
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
            if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor|internmap)/.test(id)) return "charts";
            if (/[\\/]node_modules[\\/](radix-ui|@radix-ui|@floating-ui|aria-hidden|react-remove-scroll)/.test(id)) return "primitives";
            if (/[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?(rxdb|rxjs|dexie)/.test(id)) return "database";
            return "vendor";
          },
        },
      },
    },
    server: Object.keys(proxy).length === 0 ? {} : { proxy },
  };
});
