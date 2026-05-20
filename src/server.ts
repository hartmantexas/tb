import { ensureDaemon, daemonFetch } from "./daemon.js";

let activeSessionId: string | null = null;

async function getSession(
  engine?: string,
  needsScreenshot = false,
): Promise<string> {
  if (activeSessionId) return activeSessionId;

  const result = (await daemonFetch("/session/create", {
    method: "POST",
    body: { engine: engine ?? "auto", needsScreenshot },
  })) as { sessionId: string };

  activeSessionId = result.sessionId;
  return activeSessionId;
}

async function sessionCmd(
  method: string,
  params: Record<string, unknown> = {},
  engine?: string,
): Promise<unknown> {
  const needsScreenshot = method === "screenshot";
  const sessionId = await getSession(engine, needsScreenshot);

  const result = (await daemonFetch("/session/command", {
    method: "POST",
    body: { sessionId, method, params },
  })) as { result: unknown };

  return result.result;
}

export async function startServer(port = 7171): Promise<void> {
  await ensureDaemon();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS
      if (method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };

      try {
        let result: unknown;

        if (method === "POST" && path === "/navigate") {
          const body = (await req.json()) as { url: string; engine?: string };
          await getSession(body.engine);
          result = await sessionCmd("goto", { url: body.url }, body.engine);
        } else if (method === "POST" && path === "/screenshot") {
          const body = (await req.json()) as {
            path?: string;
            fullPage?: boolean;
            format?: string;
            quality?: number;
          };
          result = await sessionCmd("screenshot", body, "chromium");
        } else if (method === "POST" && path === "/click") {
          const body = (await req.json()) as { selector: string };
          result = await sessionCmd("click", body);
        } else if (method === "POST" && path === "/type") {
          const body = (await req.json()) as {
            selector: string;
            text: string;
          };
          result = await sessionCmd("type", body);
        } else if (method === "POST" && path === "/eval") {
          const body = (await req.json()) as { expression: string };
          result = await sessionCmd("evaluate", body);
        } else if (method === "GET" && path === "/content") {
          result = { html: await sessionCmd("content") };
        } else if (method === "GET" && path === "/text") {
          result = { text: await sessionCmd("text") };
        } else if (method === "GET" && path === "/title") {
          result = { title: await sessionCmd("title") };
        } else if (method === "GET" && path === "/url") {
          result = { url: await sessionCmd("url") };
        } else if (method === "GET" && path === "/cookies") {
          result = { cookies: await sessionCmd("cookies") };
        } else if (method === "GET" && path === "/status") {
          result = await daemonFetch("/status");
        } else if (method === "POST" && path === "/session") {
          const body = (await req.json()) as {
            engine?: string;
            url?: string;
          };
          const s = (await daemonFetch("/session/create", {
            method: "POST",
            body,
          })) as { sessionId: string };
          activeSessionId = s.sessionId;
          result = s;
        } else {
          return Response.json(
            { error: "Not found" },
            { status: 404, headers: corsHeaders },
          );
        }

        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: message },
          { status: 500, headers: corsHeaders },
        );
      }
    },
  });

  console.log(`tb HTTP API running on http://localhost:${port}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /navigate     { url }              → Navigate`);
  console.log(`  POST /screenshot   { path?, fullPage? } → Screenshot`);
  console.log(`  POST /click        { selector }         → Click`);
  console.log(`  POST /type         { selector, text }   → Type`);
  console.log(`  POST /eval         { expression }       → Eval JS`);
  console.log(`  GET  /content                           → Page HTML`);
  console.log(`  GET  /text                              → Page text`);
  console.log(`  GET  /title                             → Page title`);
  console.log(`  GET  /url                               → Current URL`);
  console.log(`  GET  /cookies                           → Cookies`);
  console.log(`  GET  /status                            → Daemon status`);
}
