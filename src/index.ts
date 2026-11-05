/**
 * kya-icp collector: every hour, download the ICP-Brasil CRLs listed in sources.json and keep each new version,
 * raw, in R2 (see collector.ts). The HTTP side is read-only: it lists the sources and the latest run log.
 */
import sourcesJson from "../sources.json";
import { runCollection, validateSources } from "./collector.js";

export interface Env {
  LCR: R2Bucket;
}

const sources = validateSources(sourcesJson);

const OPTIONS = {
  timeoutMs: 60_000,
  maxBytes: 64 * 1024 * 1024,
  concurrency: 6,
  userAgent: "kya-icp-collector/0.1 (+https://github.com/celfons/kya-icp)"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCollection({ ...OPTIONS, sources, bucket: env.LCR, fetch: (input, init) => fetch(input, init), now: () => new Date() }).then(({ logKey, attempts }) => {
        const count = (o: string) => attempts.filter((a) => a.outcome === o).length;
        console.log(JSON.stringify({ logKey, stored: count("stored"), unchanged: count("unchanged"), failed: attempts.length - count("stored") - count("unchanged") }));
      })
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (url.pathname === "/sources") return json(sources);
    if (url.pathname === "/") {
      // The most recent run log: list today's (UTC) logs, falling back to yesterday's.
      const day = (d: Date) => `log/${d.toISOString().slice(0, 4)}/${d.toISOString().slice(5, 7)}/${d.toISOString().slice(8, 10)}/`;
      const now = new Date();
      let latest: string | null = null;
      for (const prefix of [day(now), day(new Date(now.getTime() - 86_400_000))]) {
        const list = await env.LCR.list({ prefix });
        const keys = list.objects.map((o) => o.key).sort();
        if (keys.length) {
          latest = keys[keys.length - 1]!;
          break;
        }
      }
      const obj = latest ? await env.LCR.get(latest) : null;
      const attempts = obj ? (await obj.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { outcome: string }) : [];
      const byOutcome: Record<string, number> = {};
      for (const a of attempts) byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
      return json({ service: "kya-icp collector", sources: sources.length, latest_run: latest, outcomes: byOutcome, repository: "https://github.com/celfons/kya-icp" });
    }
    return json({ error: "not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
