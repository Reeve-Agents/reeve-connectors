/**
 * Composio's public app catalog (docs.composio.dev/toolkits.md, about 1,600 apps): name, slug, tool
 * count, auth type. Read once and cached, so the studio can list every app an owner could connect.
 */

export interface AppInfo {
  name: string;
  /** Lowercase toolkit slug, as connections use it (gmail, notion, googlesheets). */
  slug: string;
  tools: number;
  triggers: number;
  auth: string[];
}

const CATALOG_URL = "https://docs.composio.dev/toolkits.md";

/** Shown first when the owner has not searched: the apps small businesses use most. */
const FEATURED = ["gmail", "googlesheets", "googledrive", "googledocs", "googlecalendar", "telegram", "whatsapp", "notion", "clickup", "slack", "shopify", "airtable", "hubspot", "odoo", "quickbooks", "xero", "googlephotos", "trello", "asana", "outlook", "dropbox", "canva", "instagram", "facebook"];
const TTL = 24 * 60 * 60 * 1000;

/** Rows of the "All Toolkits" table: | [Name](...) | `SLUG` | tools | triggers | auth | managed |. */
export function parseCatalog(markdown: string): AppInfo[] {
  const out: AppInfo[] = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([^|]*)\|/);
    if (!m) continue;
    out.push({
      name: m[1]!.trim(),
      slug: m[2]!.trim().toLowerCase(),
      tools: Number(m[3]),
      triggers: Number(m[4]),
      auth: m[5]!.split(",").map((a) => a.trim()).filter(Boolean),
    });
  }
  return out;
}

const rank = (slug: string) => {
  const i = FEATURED.indexOf(slug);
  return i < 0 ? FEATURED.length : i;
};

export class AppCatalog {
  private cache: { at: number; apps: AppInfo[] } | null = null;

  constructor(private readonly opts: { fetch?: typeof fetch; url?: string; now?: () => number } = {}) {}

  async all(): Promise<AppInfo[]> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cache && now - this.cache.at < TTL) return this.cache.apps;
    const res = await (this.opts.fetch ?? fetch)(this.opts.url ?? CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Composio catalog: HTTP ${res.status}`);
    const apps = parseCatalog(await res.text());
    if (apps.length === 0) throw new Error("Composio catalog: no apps found (format changed?)");
    this.cache = { at: now, apps };
    return apps;
  }

  /** Search by name or slug; the most capable apps first when there is no query. */
  async search(q = "", limit = 24, offset = 0): Promise<{ total: number; apps: AppInfo[] }> {
    const all = await this.all();
    const needle = q.trim().toLowerCase();
    const hits = needle
      ? all
          .filter((a) => a.name.toLowerCase().includes(needle) || a.slug.includes(needle))
          .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)) || b.tools - a.tools)
      : [...all].sort((a, b) => rank(a.slug) - rank(b.slug) || b.tools - a.tools);
    return { total: hits.length, apps: hits.slice(offset, offset + limit) };
  }
}
