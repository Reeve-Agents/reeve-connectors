import { describe, expect, it } from "vitest";
import { coerceArgs, toRecords } from "../src/index";

describe("toRecords: rows from any app's read tool", () => {
  it("Google Sheets values (header row + rows)", () => {
    const sheets = { range: "Siswa!A1:C3", values: [["id", "fee", "status"], ["S01", "850000", "belum"], ["S02", "850000", "lunas"], []] };
    expect(toRecords(sheets)).toEqual([
      { id: "S01", fee: 850000, status: "belum" },
      { id: "S02", fee: 850000, status: "lunas" },
    ]);
  });

  it("skips a title row above the header (unnamed columns dropped)", () => {
    const cal = { values: [["", "OCTOBER"], [], ["", "SUNDAY", "MONDAY"], ["", "", "1"], [], ["", "4", "5"]] };
    expect(toRecords(cal)).toEqual([
      { SUNDAY: null, MONDAY: 1 },
      { SUNDAY: 4, MONDAY: 5 },
    ]);
  });

  it("Notion database pages (properties lifted, typed values reduced)", () => {
    const notion = {
      results: [
        {
          id: "p1",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Alya" }] },
            Fee: { type: "number", number: 850000 },
            Status: { type: "select", select: { name: "Belum" } },
            Due: { type: "date", date: { start: "2026-11-03" } },
            Paid: { type: "checkbox", checkbox: false },
          },
        },
      ],
      has_more: false,
    };
    expect(toRecords(notion)).toEqual([{ id: "p1", Name: "Alya", Fee: 850000, Status: "Belum", Due: "2026-11-03", Paid: "false" }]);
  });

  it("ClickUp tasks inside a wrapper, nested objects flattened", () => {
    const clickup = { data: { tasks: [{ id: "t1", name: "Invoice Alya", status: { status: "to do" }, due_date: "1793664000000", priority: null }], last_page: true } };
    expect(toRecords(clickup)).toEqual([{ id: "t1", name: "Invoice Alya", "status.status": "to do", due_date: 1793664000000, priority: null }]);
  });

  it("Airtable records (fields object)", () => {
    const airtable = { records: [{ id: "rec1", createdTime: "2026-10-01T00:00:00.000Z", fields: { Name: "Bima", Fee: 1200000 } }] };
    expect(toRecords(airtable)).toEqual([{ id: "rec1", createdTime: "2026-10-01T00:00:00.000Z", "fields.Name": "Bima", "fields.Fee": 1200000 }]);
  });

  it("JSON delivered as text", () => {
    expect(toRecords(JSON.stringify({ items: [{ a: 1 }, { a: 2 }] }))).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("coerceArgs: rule text to the tool's argument types", () => {
  it("numbers, flags and lists per the schema; strings untouched", () => {
    const schema = { properties: { chat_id: { type: "integer" }, cc: { type: "array" }, is_html: { type: "boolean" }, body: { type: "string" }, meta: { type: "object" } } };
    expect(coerceArgs({ chat_id: "900000001", cc: "a@example.com, b@example.com", is_html: "false", body: "123", meta: '{"x":1}', other: "kept" }, schema)).toEqual({
      chat_id: 900000001,
      cc: ["a@example.com", "b@example.com"],
      is_html: false,
      body: "123",
      meta: { x: 1 },
      other: "kept",
    });
  });
});
