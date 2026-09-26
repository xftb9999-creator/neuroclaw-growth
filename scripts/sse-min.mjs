import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
const app = new Hono();
app.get("/s", (c) => streamSSE(c, async (st) => {
  await st.writeSSE({ event: "ping", data: "0" });
}));
serve({ fetch: app.fetch, port: 8799 });
console.log("minimal-sse up");
