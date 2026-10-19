/**
 * The development server: serves the page with hot reloading, and forwards
 * /api to a running editor server, which the example consumer binds on 8791
 * (see the README).
 *
 * A request is forwarded as the page made it, except for `Host`, which names
 * the API's address, so the server's check that a write came from its own page
 * sees what the browser said: `Sec-Fetch-Site` and `Origin` pass unchanged.
 */

import type { Server } from "bun";
import index from "../index.html";

const api = "http://127.0.0.1:8791";

const server = Bun.serve({
  port: 5173,
  development: true,
  routes: {
    "/": index,
    "/api/*": forward,
  },
});

console.log(`Serving the editor at ${server.url}, with /api forwarded to ${api}`);

async function forward(request: Request, server: Server<undefined>): Promise<Response> {
  // An action may take longer than Bun's default idle timeout of ten seconds.
  server.timeout(request, 0);
  const { pathname, search } = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  try {
    return await fetch(api + pathname + search, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  } catch (error) {
    // Most likely nothing is listening: `cargo run --example library -- web --api-only`.
    console.error(`${request.method} ${pathname} → ${api}: ${error}`);
    return new Response(`no API at ${api}`, { status: 502 });
  }
}
