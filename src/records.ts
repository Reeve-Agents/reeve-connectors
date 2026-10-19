/**
 * Turn whatever a read tool returns into flat records the rules can use:
 * - a 2D matrix with a header row (Google Sheets values, CSV-like exports);
 * - a list of objects (ClickUp tasks, Airtable records, Odoo rows, Drive files, ...), flattened to
 *   dotted keys (custom.field), with Notion-style property objects reduced to their plain value.
 * The largest list in the response wins, so wrappers ({data: {tasks: [...]}}) need no configuration.
 */

export type Cell = string | number | null;
export type FlatRecord = Record<string, Cell>;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Notion and similar APIs wrap each value in {type, <type>: ...}. */
function plain(v: unknown): Cell | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const parts = v.map((x) => (isObj(x) ? (plain(x.plain_text ?? x.name ?? x.text ?? x.value) ?? null) : plain(x))).filter((x) => x !== null && x !== undefined);
    return parts.length ? parts.join(", ") : null;
  }
  if (isObj(v)) {
    if (typeof v.type === "string" && v.type in v) return plain(v[v.type]);
    for (const k of ["plain_text", "name", "start", "value", "content", "number", "email", "phone_number", "url"]) if (k in v) return plain(v[k]);
  }
  return undefined;
}

function flatten(obj: Record<string, unknown>, prefix = "", depth = 0, out: FlatRecord = {}): FlatRecord {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const p = plain(v);
    if (p !== undefined && !(isObj(v) && depth < 2 && !("type" in v))) {
      out[key] = p;
    } else if (isObj(v) && depth < 2) {
      // Notion pages keep their fields under `properties`: lift them to the top level.
      flatten(v, k === "properties" && depth === 0 ? "" : key, depth + 1, out);
    }
  }
  return out;
}

/** Every array in the response, breadth-first, with its path. */
function arrays(root: unknown): unknown[][] {
  const found: unknown[][] = [];
  const queue: unknown[] = [root];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      found.push(v);
      for (const x of v.slice(0, 3)) if (isObj(x)) queue.push(...Object.values(x).filter((y) => Array.isArray(y) || isObj(y)));
    } else if (isObj(v)) queue.push(...Object.values(v));
    else if (typeof v === "string" && /^\s*[[{]/.test(v)) {
      try {
        queue.push(JSON.parse(v));
      } catch {
        /* not JSON */
      }
    }
  }
  return found;
}

const cell = (v: unknown): Cell => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
};

export function toRecords(data: unknown): FlatRecord[] {
  const candidates = arrays(data);
  // A matrix: rows of cells with a header row.
  // A matrix: the header is the first row with at least two named columns (sheets often start with a title row).
  const headerAt = (m: unknown[][]) => m.findIndex((r) => Array.isArray(r) && r.filter((h) => typeof h === "string" && h.trim() !== "").length >= 2);
  const matrix = candidates
    .filter((a) => a.length >= 2 && a.every((r) => Array.isArray(r)) && headerAt(a as unknown[][]) >= 0 && headerAt(a as unknown[][]) < a.length - 1)
    .sort((a, b) => b.length - a.length)[0] as unknown[][] | undefined;
  const objects = candidates.filter((a) => a.length > 0 && a.every(isObj)).sort((a, b) => b.length - a.length)[0] as Record<string, unknown>[] | undefined;
  if (matrix && (!objects || matrix.length - 1 >= objects.length)) {
    const h = headerAt(matrix);
    const names = (matrix[h] as unknown[]).map((x) => String(x ?? "").trim());
    const rows = matrix.slice(h + 1) as unknown[][];
    return rows
      .filter((r) => r.some((c) => c !== "" && c !== null))
      .map((r) => Object.fromEntries(names.flatMap((n, i) => (n ? [[n, cell(r[i])]] : []))));
  }
  if (objects) return objects.map((o) => Object.fromEntries(Object.entries(flatten(o)).map(([k, v]) => [k, cell(v)])));
  return [];
}

/** Coerce rendered text arguments to the types the tool's schema asks for (numbers, booleans, lists). */
export function coerceArgs(args: Record<string, unknown>, schema?: { properties?: Record<string, unknown> }): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k] as { type?: string | string[]; anyOf?: { type?: string }[] } | undefined;
    const types = [p?.type, ...(p?.anyOf?.map((a) => a.type) ?? [])].flat().filter(Boolean) as string[];
    if (typeof v !== "string" || types.length === 0 || types.includes("string")) {
      out[k] = v;
      continue;
    }
    const t = v.trim();
    if (types.includes("integer") || types.includes("number")) out[k] = t === "" ? undefined : Number(t.replace(/[^0-9.-]/g, ""));
    else if (types.includes("boolean")) out[k] = /^(true|ya|yes|1)$/i.test(t);
    else if (types.includes("array")) {
      try {
        const j = JSON.parse(t);
        out[k] = Array.isArray(j) ? j : [j];
      } catch {
        out[k] = t === "" ? [] : t.split(",").map((x) => x.trim());
      }
    } else if (types.includes("object")) {
      try {
        out[k] = JSON.parse(t);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(typeof v === "number" && Number.isNaN(v))));
}
