import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Connector, ToolInfo, ToolResult } from "./index";
import { McpConnector } from "./mcp";

/**
 * Composio Connect: Composio's hosted MCP server, authenticated with the account's consumer key
 * (ck_…, header x-consumer-api-key, from Connect → Sessions & API Key). It exposes meta-tools
 * rather than one MCP tool per app tool, so Reeve calls them deterministically:
 *   COMPOSIO_GET_TOOL_SCHEMAS   → does GMAIL_SEND_EMAIL exist, and what does it need
 *   COMPOSIO_MULTI_EXECUTE_TOOL → run exactly that tool with exactly these arguments
 *   COMPOSIO_MANAGE_CONNECTIONS → list (never add) the owner's connected accounts
 * No model chooses anything at runtime.
 */
export class ComposioConnectConnector implements Connector {
  readonly id = "composio";
  readonly kind = "composio" as const;
  readonly label = "Composio (Connect)";
  private readonly mcp: McpConnector;
  private readonly schemas = new Map<string, ToolInfo | null>();

  constructor(opts: { consumerKey: string; url?: string; transportFactory?: () => Transport }) {
    this.mcp = new McpConnector(
      { name: "composio-connect", url: opts.url ?? "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": opts.consumerKey } },
      opts.transportFactory,
    );
  }

  /** The meta-tools answer with JSON text; unwrap it. */
  private async call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> | null; error?: string }> {
    const r = await this.mcp.execute(tool, args);
    const raw = r.ok ? r.data : r.error;
    // The server may answer in several text blocks; the first one that is JSON is the result.
    let body: Record<string, unknown> | null = null;
    for (const part of Array.isArray(raw) ? raw : [raw]) {
      if (typeof part === "string") {
        try {
          body = JSON.parse(part) as Record<string, unknown>;
          break;
        } catch {
          continue;
        }
      } else if (part && typeof part === "object") {
        body = part as Record<string, unknown>;
        break;
      }
    }
    const ok = r.ok && body?.successful !== false;
    return { ok, body, error: ok ? undefined : String(body?.error ?? r.error ?? "failed") };
  }

  async describeTool(tool: string): Promise<ToolInfo | null> {
    if (this.schemas.has(tool)) return this.schemas.get(tool)!;
    const r = await this.call("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: [tool] });
    const data = r.body?.data as { tool_schemas?: Record<string, { toolkit?: string; description?: string; input_schema?: ToolInfo["inputSchema"] }> } | undefined;
    const s = data?.tool_schemas?.[tool];
    const info: ToolInfo | null = s ? { slug: tool, connector: this.id, description: s.description, inputSchema: s.input_schema, toolkit: s.toolkit?.toLowerCase() } : null;
    this.schemas.set(tool, info);
    return info;
  }

  /** Active accounts for a toolkit. Uses action "list" only: it never starts a new connection. */
  async activeAccounts(toolkit: string): Promise<number> {
    const r = await this.call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: toolkit, action: "list" }] });
    const data = r.body?.data as { results?: Record<string, { accounts?: { status?: string }[] }> } | undefined;
    return (data?.results?.[toolkit]?.accounts ?? []).filter((a) => String(a.status ?? "").toUpperCase() === "ACTIVE").length;
  }

  /**
   * Start connecting an app for the owner: Composio returns a link (valid about 10 minutes) where the
   * owner signs in with OAuth or enters the app's API key. Reeve never sees those credentials.
   */
  async linkApp(toolkit: string): Promise<{ redirectUrl: string; status: string }> {
    const r = await this.call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: toolkit, action: "add" }] });
    const res = (r.body?.data as { results?: Record<string, { status?: string; redirect_url?: string; error?: string }> } | undefined)?.results?.[toolkit];
    if (!r.ok || !res?.redirect_url) throw new Error(res?.error ?? r.error ?? `Composio returned no link for ${toolkit}`);
    return { redirectUrl: res.redirect_url, status: res.status ?? "initiated" };
  }

  /** Active account counts for several apps at once (action "list": no side effects). */
  async connectionStatus(toolkits: string[]): Promise<Record<string, number>> {
    if (!toolkits.length) return {};
    const r = await this.call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: toolkits.map((name) => ({ name, action: "list" })) });
    const results = (r.body?.data as { results?: Record<string, { accounts?: { status?: string }[] }> } | undefined)?.results ?? {};
    return Object.fromEntries(toolkits.map((t) => [t, (results[t]?.accounts ?? []).filter((a) => String(a.status ?? "").toUpperCase() === "ACTIVE").length]));
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.call("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: tool, arguments: args }],
      sync_response_to_workbench: false,
      thought: `Reeve: run ${tool} as the approved rulebook decided`,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // One tool per call: surface its own success or error, not just the batch's.
    const results = (r.body?.data as { results?: { successful?: boolean; error?: string | null; response?: { successful?: boolean; error?: string | null } }[] } | undefined)?.results;
    const first = results?.[0];
    const failed = first && (first.successful === false || first.response?.successful === false);
    if (failed) return { ok: false, error: String(first.error ?? first.response?.error ?? "tool failed") };
    // The tool's own response, without the batch wrapper.
    return { ok: true, data: (first?.response as { data?: unknown } | undefined)?.data ?? r.body?.data };
  }

  /** Build time: Composio's own tool search for a use case ("send a reminder email", "read rows from a sheet"). */
  async searchTools(useCase: string): Promise<string[]> {
    const r = await this.call("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: useCase.slice(0, 1000) }] });
    const results = (r.body?.data as { results?: { primary_tool_slugs?: string[]; related_tool_slugs?: string[] }[] } | undefined)?.results ?? [];
    return [...new Set(results.flatMap((x) => [...(x.primary_tool_slugs ?? []), ...(x.related_tool_slugs ?? [])]))];
  }

  async close() {
    await this.mcp.close();
  }
}
