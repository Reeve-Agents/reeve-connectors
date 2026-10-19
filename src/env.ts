import { ComposioConnector } from "./composio";
import { ComposioConnectConnector } from "./composio-connect";
import { ConnectorRegistry, LogConnector, type Connector } from "./index";
import { McpConnector, type McpServerConfig } from "./mcp";

/**
 * COMPOSIO_API_KEY: a project key (ak_…, via the SDK; COMPOSIO_USER_ID picks whose accounts act, default
 * "reeve-owner") or a Connect consumer key (ck_…, via Composio's hosted MCP server). Plus
 * REEVE_MCP_SERVERS, a JSON list of {name, url, headers?}. The log connector is always there.
 */
export function connectorsFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectorRegistry {
  const list: Connector[] = [];
  const key = (env.COMPOSIO_API_KEY ?? env.COMPOSIO_CONSUMER_API_KEY)?.trim();
  // ck_… is a Composio Connect consumer key (hosted MCP); anything else is a project key for the SDK.
  if (key?.startsWith("ck_")) list.push(new ComposioConnectConnector({ consumerKey: key, url: env.COMPOSIO_CONNECT_URL?.trim() || undefined }));
  else if (key) list.push(new ComposioConnector({ apiKey: key, userId: env.COMPOSIO_USER_ID?.trim() || "reeve-owner" }));
  if (env.REEVE_MCP_SERVERS?.trim()) {
    let servers: McpServerConfig[] = [];
    try {
      servers = JSON.parse(env.REEVE_MCP_SERVERS) as McpServerConfig[];
    } catch {
      throw new Error("REEVE_MCP_SERVERS must be a JSON list of {name, url, headers?}");
    }
    for (const s of servers) list.push(new McpConnector(s));
  }
  list.push(new LogConnector());
  return new ConnectorRegistry(list);
}
