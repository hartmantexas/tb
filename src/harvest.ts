/**
 * tb harvest — resumable bulk page → structured data.
 *
 * The job tb kept *almost* being able to do: take a list of URLs, visit them
 * one at a time in a warm session, run an extractor on each, and write results
 * as you go. Everything here exists because a 62-page scrape needed it:
 *
 * - checkpoint after every page, so a halt at #40 loses nothing
 * - resume by skipping URLs already present in the output
 * - jittered delays (a fixed interval is itself a bot signature)
 * - a circuit breaker that treats a challenge as *soft* — wait for it to
 *   clear (it often does, or you solve it in the visible window) and only
 *   give up if it persists. Never retry into a challenge; that's what turns
 *   a temporary rate-limit into a hard block.
 */
import { existsSync, readFileSync, appendFileSync } from "fs";

export interface HarvestOptions {
  urlsFile: string;
  out: string;
  recipe?: string;
  schema?: string;
  jitter: [number, number];
  settle: boolean;
  timeout: number;
  /** Stop after this many consecutive pages yield nothing usable. */
  emptyStreakLimit?: number;
  /** How long to let a challenge clear before giving up, ms. */
  blockGraceMs?: number;
}

export interface HarvestDeps {
  /** Navigate; resolves to the real status + whether we landed on a challenge. */
  goto(url: string): Promise<{ status: number; url: string; blocked: boolean }>;
  isBlocked(): Promise<{ blocked: boolean; reason: string | null }>;
  waitForSettled(timeout: number): Promise<{ settled: boolean; textLen: number }>;
  evaluate(expression: string): Promise<unknown>;
  log(msg: string): void;
}

/** Default extractor when no recipe/schema is given. */
const DEFAULT_RECIPE = `(() => ({
  url: location.href,
  title: (document.querySelector('meta[property="og:title"]') || {}).content
         || (document.querySelector('h1') || {}).innerText
         || document.title,
  text: document.body ? document.body.innerText.slice(0, 5000) : ''
}))()`;

/** Build an in-page expression from a {field: "sel@attr"} map. */
export function schemaToExpression(schemaObj: Record<string, string>): string {
  return `(() => {
    const schema = ${JSON.stringify(schemaObj)};
    const result = { url: location.href };
    const read = (el, attr) => {
      if (!attr) return el.textContent.trim();
      if (attr === 'src' && el.src != null) return el.src;
      if (attr === 'href' && el.href != null) return el.href;
      return el.getAttribute(attr);
    };
    for (const [key, raw] of Object.entries(schema)) {
      if (typeof raw !== 'string') continue;
      const at = raw.lastIndexOf('@');
      const selector = at > 0 ? raw.slice(0, at) : raw;
      const attr = at > 0 ? raw.slice(at + 1) : null;
      let els;
      try { els = document.querySelectorAll(selector); }
      catch { result[key] = null; continue; }
      if (els.length > 1) result[key] = Array.from(els).map(e => read(e, attr));
      else if (els.length === 1) result[key] = read(els[0], attr);
      else result[key] = null;
    }
    return result;
  })()`;
}

export function readUrls(file: string): string[] {
  if (!existsSync(file)) throw new Error(`URL list not found: ${file}`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l && !l.startsWith("#"));
}

/** URLs already recorded in the output file — used to resume. */
export function alreadyDone(out: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(out)) return done;
  for (const line of readFileSync(out, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { requested_url?: string; url?: string };
      if (rec.requested_url) done.add(rec.requested_url);
      else if (rec.url) done.add(rec.url);
    } catch {}
  }
  return done;
}

/**
 * A recipe file is plain JS whose *last expression* is the extractor result —
 * i.e. the same thing you'd hand to `tb eval`. Wrapped so a trailing
 * semicolon or a leading comment block doesn't change behaviour.
 */
export function loadRecipe(path: string): string {
  if (!existsSync(path)) throw new Error(`Recipe not found: ${path}`);
  return readFileSync(path, "utf-8");
}

function jitterMs([min, max]: [number, number]): number {
  return (min + Math.random() * Math.max(0, max - min)) * 1000;
}

export interface HarvestResult {
  total: number;
  scraped: number;
  skipped: number;
  halted: boolean;
  haltReason?: string;
}

export async function harvest(
  opts: HarvestOptions,
  deps: HarvestDeps,
): Promise<HarvestResult> {
  const urls = readUrls(opts.urlsFile);
  const done = alreadyDone(opts.out);
  const todo = urls.filter((u) => !done.has(u));
  const emptyLimit = opts.emptyStreakLimit ?? 4;
  const blockGrace = opts.blockGraceMs ?? 40000;

  let expression = DEFAULT_RECIPE;
  if (opts.recipe) expression = loadRecipe(opts.recipe);
  else if (opts.schema) expression = schemaToExpression(JSON.parse(opts.schema));

  deps.log(
    `${urls.length} urls, ${done.size} already done, ${todo.length} to harvest`,
  );

  let scraped = 0;
  let emptyStreak = 0;

  for (const [i, url] of todo.entries()) {
    const started = Date.now();
    let nav: { status: number; url: string; blocked: boolean };
    try {
      nav = await deps.goto(url);
    } catch (e) {
      deps.log(`  [${i + 1}/${todo.length}] NAV-FAIL ${url}: ${(e as Error).message}`);
      emptyStreak++;
      if (emptyStreak >= emptyLimit) {
        return { total: urls.length, scraped, skipped: done.size, halted: true, haltReason: `${emptyLimit} consecutive failures` };
      }
      continue;
    }

    // Soft-handle a challenge: give it a chance to clear rather than bailing.
    if (nav.blocked) {
      deps.log(`      challenge shown — waiting up to ${Math.round(blockGrace / 1000)}s to clear...`);
      const graceEnd = Date.now() + blockGrace;
      let cleared = false;
      while (Date.now() < graceEnd) {
        await new Promise((r) => setTimeout(r, 4000));
        const b = await deps.isBlocked();
        if (!b.blocked) { cleared = true; break; }
      }
      if (!cleared) {
        return {
          total: urls.length, scraped, skipped: done.size, halted: true,
          haltReason: `persistent block at ${url} — solve it in the browser window, then re-run to resume`,
        };
      }
      deps.log("      cleared, continuing.");
    }

    if (opts.settle) await deps.waitForSettled(opts.timeout);

    let data: Record<string, unknown> = {};
    try {
      data = (await deps.evaluate(expression)) as Record<string, unknown>;
    } catch (e) {
      data = { error: (e as Error).message };
    }

    const usable = data && !data.error && Object.entries(data).some(
      ([k, v]) => k !== "url" && v !== null && v !== undefined && v !== "",
    );
    emptyStreak = usable ? 0 : emptyStreak + 1;

    appendFileSync(
      opts.out,
      JSON.stringify({ requested_url: url, status: nav.status, ...data }) + "\n",
    );
    scraped++;
    deps.log(
      `  [${i + 1}/${todo.length}] ${usable ? "ok  " : "MISS"} ${Math.round((Date.now() - started) / 1000)}s  ${String(data.title ?? url).slice(0, 60)}`,
    );

    if (emptyStreak >= emptyLimit) {
      return { total: urls.length, scraped, skipped: done.size, halted: true, haltReason: `${emptyLimit} consecutive empty pages` };
    }

    if (i < todo.length - 1) {
      await new Promise((r) => setTimeout(r, jitterMs(opts.jitter)));
    }
  }

  return { total: urls.length, scraped, skipped: done.size, halted: false };
}
