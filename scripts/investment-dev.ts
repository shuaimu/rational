import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Mount the second static entry point in the root Vite server. */
export function investmentDev(): Plugin {
  const publicDir = fileURLToPath(new URL("../investment/frontend/public/", import.meta.url));
  const entry = "/investment/frontend/index.html";
  return {
    name: "rational-investment-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/investment") {
          res.writeHead(302, { Location: `/investment/${url.search}` });
          res.end();
          return;
        }
        if (url.pathname === "/investment/" || url.pathname === "/investment/index.html") {
          req.url = entry + url.search;
        } else if (url.pathname.startsWith("/investment/") && !url.pathname.startsWith("/investment/frontend/")) {
          // Let Vite serve public files with its normal MIME and caching rules.
          // Restrict this mount to files inside the investment public directory.
          let relative: string;
          try {
            relative = decodeURIComponent(url.pathname.slice("/investment/".length));
          } catch {
            res.writeHead(400);
            res.end("Invalid path");
            return;
          }
          const file = resolve(publicDir, relative);
          if (file.startsWith(resolve(publicDir) + sep) && statSync(file, { throwIfNoEntry: false })?.isFile()) {
            req.url = `/investment/frontend/public/${relative}${url.search}`;
          }
          // Other investment paths include shared function sources imported by
          // the frontend. Leave those to Vite's ordinary module middleware.
        }
        next();
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (context.path !== entry) return html;
        return html
          .replace('src="./src/main.tsx"', 'src="/investment/frontend/src/main.tsx"')
          .replaceAll("%BASE_URL%", "/investment/");
      },
    },
  };
}
