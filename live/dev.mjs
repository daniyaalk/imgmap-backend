// The /live/ Worker on http://localhost:8787 for a local preview, without
// wrangler (no edge cache here):
//
//   node live/dev.mjs [port]
//   .venv/bin/python -m imgmap_backend.site serve --live http://localhost:8787

import { createServer } from "node:http";

import worker from "./src/index.js";

const port = Number(process.argv[2] ?? 8787);
const env = { PROVIDER: process.env.PROVIDER ?? "adsblol" };

createServer(async (req, res) => {
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`/live/ on http://localhost:${port}/live/ (${env.PROVIDER})`));
