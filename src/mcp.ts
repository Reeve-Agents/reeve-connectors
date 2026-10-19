import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Connector, ToolInfo, ToolResult } from "./index";

export interface McpServerConfig {
  /** Short name; rules can pin it as connector "mcp:<name>". */
  name: string;
  url: string;
  /** e.g. an Authorization header. Stays in the broker. */
  headers?: Record<string, string>;
}

/**
 * Any MCP server over Streamable HTTP, through the official SDK. This is the fallback for systems
 * Composio lacks: point Reeve at an MCP server for Moka, Jurnal, Accurate or a marketplace, and
 * its tools become actions the rules can use.
 */
export class McpConnector implements Connector {
  readonly id: string;
  readonly kind = "mcp" as const;
  readonly label: string;
  private client: Client | null = null;
  private tools: Map<string, ToolInfo> | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly transportFactory?: () => Transport,
  ) {
    this.id = `mcp:${config.name}`;
    this.label = `MCP server ${config.name}`;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "reeve-broker", version: "0.1.0" });
    const transport = this.transportFactory?.() ?? new StreamableHTTPClientTransport(new URL(this.config.url), { requestInit: { headers: this.config.headers } });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async catalog(): Promise<Map<string, ToolInfo>> {
    if (this.tools) return this.tools;
    const client = await this.connect();
    const map = new Map<string, ToolInfo>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) map.set(t.name, { slug: t.name, connector: this.id, description: t.description, inputSchema: t.inputSchema as ToolInfo["inputSchema"] });
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = map;
    return map;
  }

  async describeTool(tool: string): Promise<ToolInfo | null> {
    return (await this.catalog()).get(tool) ?? null;
  }

  async listTools(): Promise<ToolInfo[]> {
    return [...(await this.catalog()).values()];
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const client = await this.connect();
      const r = await client.callTool({ name: tool, arguments: args });
      const texts = Array.isArray(r.content) ? r.content.flatMap((c) => (c && typeof c === "object" && "text" in c ? [String(c.text)] : [])) : [];
      const text = texts.join("\n");
      return r.isError ? { ok: false, error: text || "tool error" } : { ok: true, data: r.structuredContent ?? (texts.length === 1 ? texts[0] : texts) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }
}
