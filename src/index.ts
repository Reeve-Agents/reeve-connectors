/**
 * Connector layer ("Reeve - Connectors and Composio"): where records come from and where actions go.
 *
 * - Composio (1,500+ toolkits: WhatsApp, Gmail, Sheets, Slack, Shopify, HubSpot, ...) via its official SDK.
 * - Any MCP server, for systems Composio does not cover (Indonesian POS, accounting, marketplaces):
 *   add it to REEVE_MCP_SERVERS and Reeve can call its tools.
 * - CSV, for owners who start from a spreadsheet export.
 * - log, when nothing fits yet: the action is recorded, not sent, and the owner sees it.
 *
 * Keys live only here, in the broker. The sandbox never sees them: it returns the tool calls the
 * approved rules decided, and the broker makes them.
 */

import { coerceArgs, toRecords, type FlatRecord } from "./records";

export interface ToolInfo {
  slug: string;
  connector: string;
  /** The app the tool belongs to (gmail, whatsapp, ...), when the connector says. */
  toolkit?: string;
  description?: string;
  /** JSON Schema of the arguments, when the connector publishes one. */
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface Connector {
  readonly id: string;
  readonly kind: "composio" | "mcp" | "log";
  readonly label: string;
  /** The tool's description and argument schema, or null if this connector does not have it. */
  describeTool(tool: string): Promise<ToolInfo | null>;
  execute(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** How many accounts of a toolkit the owner has connected, if the connector can tell. */
  activeAccounts?(toolkit: string): Promise<number>;
  /** Build time: tool slugs that fit a use case, if the connector can search. */
  searchTools?(useCase: string): Promise<string[]>;
  /** Start connecting an app; returns the link where the owner signs in. */
  linkApp?(toolkit: string): Promise<{ redirectUrl: string; status: string }>;
  /** Active account counts for several apps. */
  connectionStatus?(toolkits: string[]): Promise<Record<string, number>>;
}

export class LogConnector implements Connector {
  readonly id = "log";
  readonly kind = "log" as const;
  readonly label = "Log only (no connector yet)";
  readonly sent: { tool: string; args: Record<string, unknown> }[] = [];
  async describeTool(tool: string): Promise<ToolInfo> {
    return { slug: tool, connector: "log", description: "Recorded, not sent" };
  }
  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.sent.push({ tool, args });
    return { ok: true, data: { logged: true } };
  }
}

export interface ToolCheck {
  rule: string;
  tool: string;
  connector: string | null;
  status: "ok" | "missing_args" | "not_found" | "not_connected" | "log_only";
  detail: string;
}

/** Finds which connector runs a tool: an explicit `mcp:<name>`, else Composio, else any MCP server that lists it. */
export class ConnectorRegistry {
  constructor(private readonly connectors: Connector[]) {}

  list() {
    return this.connectors.map((c) => ({ id: c.id, kind: c.kind, label: c.label }));
  }

  async resolve(connectorHint: string, tool: string): Promise<{ connector: Connector; info: ToolInfo } | null> {
    if (tool === "LOG" || connectorHint === "log") {
      const log = this.connectors.find((c) => c.kind === "log")!;
      return { connector: log, info: { slug: tool, connector: "log", description: "Recorded, not sent" } };
    }
    const explicit = connectorHint.startsWith("mcp:") ? this.connectors.find((c) => c.id === connectorHint) : undefined;
    const order = explicit ? [explicit] : [...this.connectors.filter((c) => c.kind === "composio"), ...this.connectors.filter((c) => c.kind === "mcp")];
    for (const c of order) {
      const info = await c.describeTool(tool).catch(() => null);
      if (info) return { connector: c, info };
    }
    return null;
  }

  /**
   * Build time: does every tool a rulebook uses exist somewhere, and do its arguments cover what the
   * tool requires? "not_found" is the cue to hunt for an MCP server that has it.
   */
  async check(actions: { rule: string; connector: string; tool: string; args: string[] }[]): Promise<ToolCheck[]> {
    const out: ToolCheck[] = [];
    for (const a of actions) {
      const hit = await this.resolve(a.connector, a.tool);
      if (!hit) {
        out.push({ rule: a.rule, tool: a.tool, connector: null, status: "not_found", detail: `no connected service has ${a.tool}: connect Composio's ${a.connector} toolkit or add an MCP server that offers it` });
        continue;
      }
      if (hit.connector.kind === "log") {
        out.push({ rule: a.rule, tool: a.tool, connector: "log", status: "log_only", detail: "recorded, not sent" });
        continue;
      }
      const required = hit.info.inputSchema?.required ?? [];
      const missing = required.filter((r) => !a.args.includes(r));
      const toolkit = hit.info.toolkit;
      if (toolkit && hit.connector.activeAccounts && (await hit.connector.activeAccounts(toolkit).catch(() => 1)) === 0) {
        out.push({ rule: a.rule, tool: a.tool, connector: hit.connector.id, status: "not_connected", detail: `${a.tool} exists, but no ${toolkit} account is connected in ${hit.connector.label}${missing.length ? `; it also needs ${missing.join(", ")}` : ""}` });
        continue;
      }
      out.push({
        rule: a.rule,
        tool: a.tool,
        connector: hit.connector.id,
        status: missing.length ? "missing_args" : "ok",
        detail: missing.length ? `${a.tool} also needs ${missing.join(", ")}` : `runs on ${hit.connector.label}`,
      });
    }
    return out;
  }

  async execute(connectorHint: string, tool: string, args: Record<string, unknown>): Promise<ToolResult & { connector: string }> {
    const hit = await this.resolve(connectorHint, tool);
    if (!hit) return { ok: false, error: `no connected service has ${tool}`, connector: "none" };
    // Rules render text; the tool's schema says which arguments are numbers, flags or lists.
    const r = await hit.connector.execute(tool, coerceArgs(args, hit.info.inputSchema));
    return { ...r, connector: hit.connector.id };
  }

  /** Read records from any connected app's read tool (a sheet range, a Notion database, a ClickUp list, ...). */
  async readRecords(connectorHint: string, tool: string, args: Record<string, unknown>): Promise<FlatRecord[]> {
    const r = await this.execute(connectorHint, tool, args);
    if (!r.ok) throw new Error(`${tool} failed: ${r.error}`);
    return toRecords(r.data);
  }

  /** The connector that can link the owner's apps (Composio), if any. */
  private linker() {
    return this.connectors.find((c) => c.linkApp && c.connectionStatus);
  }

  canConnectApps(): boolean {
    return Boolean(this.linker());
  }

  async connectApp(toolkit: string) {
    const c = this.linker();
    if (!c) throw new Error("no connector can link apps: set COMPOSIO_API_KEY");
    return c.linkApp!(toolkit);
  }

  async appStatus(toolkits: string[]): Promise<Record<string, number>> {
    const c = this.linker();
    return c ? c.connectionStatus!(toolkits) : Object.fromEntries(toolkits.map((t) => [t, 0]));
  }

  /** Build time: candidate tools for a use case, with what each needs. */
  async suggestTools(useCase: string, limit = 6): Promise<{ slug: string; description?: string; required: string[] }[]> {
    for (const c of this.connectors) {
      if (!c.searchTools) continue;
      const slugs = (await c.searchTools(useCase).catch(() => [])).slice(0, limit);
      const out: { slug: string; description?: string; required: string[] }[] = [];
      for (const slug of slugs) {
        const info = await c.describeTool(slug).catch(() => null);
        if (info) out.push({ slug, description: info.description?.split(/(?<=\.)\s/)[0]?.slice(0, 200), required: info.inputSchema?.required ?? [] });
      }
      if (out.length) return out;
    }
    return [];
  }
}

export { coerceArgs, toRecords, type FlatRecord } from "./records";
export { ComposioConnector, type ComposioLike } from "./composio";
export { ComposioConnectConnector } from "./composio-connect";
export { AppCatalog, parseCatalog, type AppInfo } from "./catalog";
export { McpConnector, type McpServerConfig } from "./mcp";
export { parseCsv, inferFields } from "./csv";
export { connectorsFromEnv } from "./env";
