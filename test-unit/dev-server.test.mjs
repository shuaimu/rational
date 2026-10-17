import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("one Vite server serves both entries, shared modules, public assets and Wasm", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "rational-vite-test-"));
  const server = await createServer({
    cacheDir,
    logLevel: "silent",
    // HTTP checks do not crawl imported modules like a browser does.
    server: { host: "127.0.0.1", port: 4186, strictPort: false, open: false, preTransformRequests: false },
  });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const get = (path, options) => fetch(origin + path, { signal: AbortSignal.timeout(15_000), ...options });
    for (const [path, title, entry] of [
      ["/", "Rational", "/src/main.tsx"],
      ["/investment/", "Rational Investment", "/investment/frontend/src/main.tsx"],
      ["/investment/index.html?reload=1", "Rational Investment", "/investment/frontend/src/main.tsx"],
    ]) {
      const response = await get(path);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(`<title>${title}</title>`));
      assert.ok(html.includes(`src="${entry}"`));
      assert.ok(html.includes('src="/@vite/client"'));
      assert.ok(html.includes('from "/@react-refresh"'));
      const module = await get(entry);
      assert.equal(module.status, 200);
      await module.text();
    }
    const redirect = await get("/investment?keep=1", { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/investment/?keep=1");

    const manifest = await get("/investment/site.webmanifest");
    assert.equal((await manifest.json()).name, "Rational Investment");
    for (const path of ["/investment/favicon.svg", "/favicon.svg"]) {
      const response = await get(path);
      assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
      assert.ok((await response.text()).includes("<svg"));
    }
    // Investment imports browser-safe helpers outside its frontend directory.
    const shared = await get("/investment/mako/serverless/shared/cache-generation.js");
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get("content-type"), /javascript/);
    assert.match(await shared.text(), /historicalDigest/);
    const css = await get("/investment/frontend/src/index.css");
    assert.equal(css.status, 200);
    assert.match(await css.text(), /tailwindcss/);
    const wasm = await get("/investment/frontend/src/wasm/robinlab_wasm_bg.wasm");
    assert.equal(wasm.status, 200);
    assert.match(wasm.headers.get("content-type"), /application\/wasm/);
    assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109]);
  } finally {
    await server.environments.client.depsOptimizer?.scanProcessing;
    server.httpServer.closeAllConnections();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
