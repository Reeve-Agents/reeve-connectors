import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ComposioConnectConnector, ComposioConnector, ConnectorRegistry, LogConnector, McpConnector, parseCsv, type ComposioLike } from "../src/index";

/** Stand-in for the Composio SDK: one known tool, and it records executions. */
function fakeComposio() {
  const calls: { slug: string; body: unknown }[] = [];
  const client: ComposioLike = {
    tools: {
      async getRawComposioToolBySlug(slug) {
        if (slug !== "GMAIL_SEND_EMAIL") throw new Error("not found");
        return { slug, version: "20260901_00", inputParameters: { type: "object", properties: { recipient_email: {}, subject: {}, body: {} }, required: ["recipient_email", "body"] } };
      },
      async execute(slug, body) {
        calls.push({ slug, body });
        return { data: { id: "msg_1" }, error: null, successful: true };
      },
    },
  };
  return { client, calls };
}

/** A real MCP server (official SDK) over an in-memory transport: a tool Composio does not have. */
async function fakePosServer() {
  const server = new McpServer({ name: "moka-pos", version: "1.0.0" });
  server.registerTool("moka_list_items", { description: "List stock items", inputSchema: { outlet: z.string() } }, async ({ outlet }) => ({ content: [{ type: "text", text: `items for ${outlet}` }] }));
  const [client, srv] = InMemoryTransport.createLinkedPair();
  await server.connect(srv);
  return new McpConnector({ name: "moka", url: "memory://moka" }, () => client);
}

describe("connector registry", () => {
  it("runs Composio tools with a pinned version and checks required arguments", async () => {
    const { client, calls } = fakeComposio();
    const reg = new ConnectorRegistry([new ComposioConnector({ userId: "owner-1", client }), new LogConnector()]);
    const checks = await reg.check([
      { rule: "R2", connector: "gmail", tool: "GMAIL_SEND_EMAIL", args: ["recipient_email", "subject"] },
      { rule: "R9", connector: "jurnal", tool: "JURNAL_CREATE_INVOICE", args: [] },
      { rule: "R1", connector: "log", tool: "LOG", args: [] },
    ]);
    expect(checks.map((c) => [c.rule, c.status])).toEqual([["R2", "missing_args"], ["R9", "not_found"], ["R1", "log_only"]]);
    expect(checks[0]!.detail).toBe("GMAIL_SEND_EMAIL also needs body");
    expect(checks[1]!.detail).toMatch(/add an MCP server/);

    const r = await reg.execute("gmail", "GMAIL_SEND_EMAIL", { recipient_email: "a@example.com", body: "hi" });
    expect(r).toMatchObject({ ok: true, connector: "composio" });
    expect(calls[0]).toEqual({ slug: "GMAIL_SEND_EMAIL", body: { userId: "owner-1", version: "20260901_00", arguments: { recipient_email: "a@example.com", body: "hi" } } });
  });

  it("falls back to an MCP server for tools Composio lacks", async () => {
    const { client } = fakeComposio();
    const reg = new ConnectorRegistry([new ComposioConnector({ userId: "o", client }), await fakePosServer(), new LogConnector()]);
    const [check] = await reg.check([{ rule: "R1", connector: "moka", tool: "moka_list_items", args: [] }]);
    expect(check).toMatchObject({ status: "missing_args", connector: "mcp:moka", detail: "moka_list_items also needs outlet" });
    const r = await reg.execute("moka", "moka_list_items", { outlet: "Berkah" });
    expect(r).toEqual({ ok: true, data: "items for Berkah", connector: "mcp:moka" });
  });

  it("logs instead of sending when nothing fits", async () => {
    const log = new LogConnector();
    const reg = new ConnectorRegistry([log]);
    expect(await reg.execute("log", "LOG", { text: "x" })).toMatchObject({ ok: true, connector: "log" });
    expect(await reg.execute("whatsapp", "WHATSAPP_SEND_MESSAGE", {})).toMatchObject({ ok: false, connector: "none" });
    expect(log.sent).toHaveLength(1);
  });
});

/** Composio Connect's meta-tools, shaped like the live server's replies (19 Oct 2026). */
async function fakeComposioConnect(gmailConnected: boolean) {
  const executed: unknown[] = [];
  const server = new McpServer({ name: "composio-connect", version: "1.0.0" });
  const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
  server.registerTool("COMPOSIO_GET_TOOL_SCHEMAS", { inputSchema: { tool_slugs: z.array(z.string()) } }, async ({ tool_slugs }) =>
    tool_slugs[0] === "GMAIL_SEND_EMAIL"
      ? text({ successful: true, data: { tool_schemas: { GMAIL_SEND_EMAIL: { toolkit: "GMAIL", input_schema: { type: "object", properties: { recipient_email: {}, body: {} }, required: [] } } } } })
      : text({ successful: false, data: { tool_schemas: {}, not_found: tool_slugs }, error: "Some tools were not found" }),
  );
  server.registerTool("COMPOSIO_MANAGE_CONNECTIONS", { inputSchema: { toolkits: z.array(z.object({ name: z.string(), action: z.string() })) } }, async ({ toolkits }) =>
    text({ successful: true, data: { results: { [toolkits[0]!.name]: { accounts: gmailConnected ? [{ id: "ca_1", status: "ACTIVE" }] : [] } } } }),
  );
  server.registerTool("COMPOSIO_MULTI_EXECUTE_TOOL", { inputSchema: { tools: z.array(z.any()), sync_response_to_workbench: z.boolean(), thought: z.string().optional() } }, async (args) => {
    executed.push(args.tools);
    return text({ successful: true, data: { results: [{ successful: gmailConnected, error: gmailConnected ? null : "no active connection" }] } });
  });
  const [client, srv] = InMemoryTransport.createLinkedPair();
  await server.connect(srv);
  return { connector: new ComposioConnectConnector({ consumerKey: "ck_test", transportFactory: () => client }), executed };
}

describe("Composio Connect (consumer key)", () => {
  it("checks tools and connections with the meta-tools, and runs exactly the decided tool", async () => {
    const { connector, executed } = await fakeComposioConnect(true);
    const reg = new ConnectorRegistry([connector, new LogConnector()]);
    const checks = await reg.check([
      { rule: "R2", connector: "gmail", tool: "GMAIL_SEND_EMAIL", args: ["recipient_email", "body"] },
      { rule: "R9", connector: "x", tool: "NOPE_TOOL", args: [] },
    ]);
    expect(checks.map((c) => c.status)).toEqual(["ok", "not_found"]);
    const r = await reg.execute("gmail", "GMAIL_SEND_EMAIL", { recipient_email: "a@example.com", body: "hi" });
    expect(r).toMatchObject({ ok: true, connector: "composio" });
    expect(executed).toEqual([[{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@example.com", body: "hi" } }]]);
  });

  it("says when the app account is not connected, and reports the tool's own failure", async () => {
    const { connector } = await fakeComposioConnect(false);
    const reg = new ConnectorRegistry([connector]);
    const [check] = await reg.check([{ rule: "R2", connector: "gmail", tool: "GMAIL_SEND_EMAIL", args: [] }]);
    expect(check).toMatchObject({ status: "not_connected", detail: expect.stringContaining("no gmail account is connected") });
    expect(await reg.execute("gmail", "GMAIL_SEND_EMAIL", {})).toMatchObject({ ok: false, error: "no active connection" });
  });
});

describe("csv", () => {
  it("parses quotes, commas and numbers", () => {
    expect(parseCsv('id,name,fee\nS1,"Alya, A.",850000\nS2,"Bima ""B""",\n')).toEqual([
      { id: "S1", name: "Alya, A.", fee: 850000 },
      { id: "S2", name: 'Bima "B"', fee: null },
    ]);
  });
});
