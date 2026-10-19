import { Composio } from "@composio/core";
import type { Connector, ToolInfo, ToolResult } from "./index";

/** The slice of the Composio SDK Reeve uses (so tests can stand in for it). */
export interface ComposioLike {
  tools: {
    getRawComposioToolBySlug(slug: string): Promise<{ slug: string; description?: string; version?: string; inputParameters?: unknown; toolkit?: { slug?: string } }>;
    execute(slug: string, body: { userId: string; version?: string; arguments: Record<string, unknown>; dangerouslySkipVersionCheck?: boolean }): Promise<{ data: Record<string, unknown>; error: string | null; successful: boolean }>;
  };
}

/**
 * Composio via its official SDK. Tool versions are looked up once and pinned on every call, as
 * Composio recommends. `userId` is whose connected accounts (the owner's WhatsApp, Gmail, ...) run it.
 */
export class ComposioConnector implements Connector {
  readonly id = "composio";
  readonly kind = "composio" as const;
  readonly label = "Composio";
  private readonly client: ComposioLike;
  private readonly cache = new Map<string, { info: ToolInfo; version?: string } | null>();

  constructor(opts: { apiKey?: string; userId: string; client?: ComposioLike }) {
    this.client = opts.client ?? (new Composio({ apiKey: opts.apiKey }) as unknown as ComposioLike);
    this.userId = opts.userId;
  }
  private readonly userId: string;

  private async lookup(tool: string) {
    if (this.cache.has(tool)) return this.cache.get(tool)!;
    let entry: { info: ToolInfo; version?: string } | null;
    try {
      const t = await this.client.tools.getRawComposioToolBySlug(tool);
      entry = {
        info: { slug: t.slug, connector: "composio", description: t.description, inputSchema: t.inputParameters as ToolInfo["inputSchema"] },
        version: t.version,
      };
    } catch {
      entry = null;
    }
    this.cache.set(tool, entry);
    return entry;
  }

  async describeTool(tool: string): Promise<ToolInfo | null> {
    return (await this.lookup(tool))?.info ?? null;
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = await this.lookup(tool);
    if (!entry) return { ok: false, error: `Composio has no tool ${tool}` };
    try {
      const r = await this.client.tools.execute(tool, { userId: this.userId, version: entry.version, arguments: args });
      return r.successful ? { ok: true, data: r.data } : { ok: false, error: r.error ?? "failed" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
