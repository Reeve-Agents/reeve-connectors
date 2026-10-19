import { describe, expect, it } from "vitest";
import { AppCatalog, parseCatalog } from "../src/index";

const md = `# Toolkits

| Toolkit | Slug | Tools | Triggers | Auth | Managed App |
|---------|------|-------|----------|------|-------------|
| [Gmail](/toolkits/gmail.md) | \`GMAIL\` | 61 | 2 | OAUTH2 | Yes |
| [Notion](/toolkits/notion.md) | \`NOTION\` | 45 | 3 | OAUTH2, API_KEY | Yes |
| [Odoo](/toolkits/odoo.md) | \`ODOO\` | 12 | 0 | API_KEY | — |
`;

describe("Composio app catalog", () => {
  it("parses the toolkits table", () => {
    expect(parseCatalog(md)).toEqual([
      { name: "Gmail", slug: "gmail", tools: 61, triggers: 2, auth: ["OAUTH2"] },
      { name: "Notion", slug: "notion", tools: 45, triggers: 3, auth: ["OAUTH2", "API_KEY"] },
      { name: "Odoo", slug: "odoo", tools: 12, triggers: 0, auth: ["API_KEY"] },
    ]);
  });

  it("searches by name or slug and caches the download", async () => {
    let fetches = 0;
    const fake = (async () => {
      fetches++;
      return new Response(md);
    }) as unknown as typeof fetch;
    const cat = new AppCatalog({ fetch: fake });
    expect((await cat.search("", 3)).apps.map((a) => a.slug)).toEqual(["gmail", "notion", "odoo"]); // featured order
    expect((await cat.search("od")).apps.map((a) => a.slug)).toEqual(["odoo"]);
    expect((await cat.search("no")).total).toBe(1);
    expect(fetches).toBe(1);
  });
});
