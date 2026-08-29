import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, type ProxyOptions } from "vite";

/**
 * Rational is a static site, so the project it talks to is compiled into the
 * bundle. `rational.config.json` names that project -- endpoint, ids, and the
 * public project key, all of them public values. Without one, the example file
 * stands in; its ids are placeholders, which `src/config.ts` reads as "no
 * project", and the app then runs entirely against its in-browser fake
 * backend. That is what the published demo is.
 *
 * `base` is `/rational/` because GitHub Pages serves a project page from a
 * subpath, and every asset the built `index.html` names has to be under it.
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
  for (const name of ["rational.config.json", "rational.config.example.json"]) {
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
    base: "/rational/",
    define: { __RATIONAL_ENV__: JSON.stringify(runtimeEnvironment) },
    build: { outDir: "web-dist", emptyOutDir: true },
    server: Object.keys(proxy).length === 0 ? {} : { proxy },
  };
});
