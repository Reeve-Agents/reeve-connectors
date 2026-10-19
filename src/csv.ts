/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. First row is the header. */
export function parseCsv(text: string): Record<string, string | number | null>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, convert(r[i] ?? "")])));
}

const convert = (v: string): string | number | null => {
  const t = v.trim();
  if (t === "") return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
};

/** Text that looks like a person's data: never shown to the model, even as a category. */
const PERSONAL = /@|^\+?\d[\d\s-]{6,}$/;

/**
 * Field names and types (number, date, text) for the Builder's prompt. A short text column whose
 * values repeat (a status such as lunas/belum) also lists those labels, so the model uses the
 * words the sheet uses. Names, phone numbers, emails and other per-row values are never included.
 */
export function inferFields(records: Record<string, unknown>[]): { name: string; type: "number" | "text" | "date"; values?: string[] }[] {
  const names = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return names.map((name) => {
    const values = records.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== "");
    if (values.length && values.every((v) => typeof v === "number")) return { name, type: "number" as const };
    if (values.length && values.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return { name, type: "date" as const };
    const labels = [...new Set(values.map((v) => String(v).trim().toLowerCase()))];
    const categorical = labels.length > 0 && labels.length <= 6 && labels.length < values.length && labels.every((l) => l.length <= 24 && !PERSONAL.test(l));
    return categorical ? { name, type: "text" as const, values: labels.sort() } : { name, type: "text" as const };
  });
}
