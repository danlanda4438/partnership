// Immutable snapshot of a workbook: every tab, every populated row, with the displayed values,
// archived formulas (as text — never executed), hyperlink destinations, cell notes and checksums.
import ExcelJS from "exceljs";
import { sha256 } from "js-sha256";

export interface SnapshotLink { column: string; text: string | null; url: string }
export interface SnapshotRow {
  rowNumber: number;
  values: Record<string, string>;       // column header -> displayed value (verbatim text)
  formulas: Record<string, string>;     // column header -> formula expression (archived only)
  notes: Record<string, string>;        // column header -> cell note
  links: SnapshotLink[];
  checksum: string;                     // sha256 of the row's values+formulas+links
}
export interface SnapshotTab { name: string; state: string; header: string[]; rows: SnapshotRow[] }
export interface Snapshot {
  fileName: string;
  fileSha256: string;
  capturedAt: string;
  tabs: SnapshotTab[];
}

// Pure-JS hashing so this runs in the browser as well as on a server.
const sha = (s: string | ArrayBuffer | Uint8Array) => sha256(s);

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("text" in v && typeof (v as { text: unknown }).text === "string") return String((v as { text: string }).text);
    if ("result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ("error" in v) return String((v as { error: string }).error);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Unique, stable header names (blank → "Column X", duplicates suffixed). */
function headerNames(row: ExcelJS.Row, width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let c = 1; c <= width; c++) {
    let name = cellText(row.getCell(c).value).trim().replace(/\s+/g, " ");
    if (!name) name = `Column ${columnLetter(c)}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.push(n > 1 ? `${name} (${n})` : name);
  }
  return out;
}

export function columnLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export async function readWorkbook(buffer: ArrayBuffer | Uint8Array, fileName: string, capturedAt = new Date().toISOString()): Promise<Snapshot> {
  const wb = new ExcelJS.Workbook();
  // exceljs typings expect a Node Buffer; both inputs are accepted at runtime.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const tabs: SnapshotTab[] = [];
  wb.eachSheet((ws) => {
    const width = ws.actualColumnCount || ws.columnCount;
    const first = ws.getRow(1);
    const header = headerNames(first, width);
    const rows: SnapshotRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, string> = {};
      const formulas: Record<string, string> = {};
      const notes: Record<string, string> = {};
      const links: SnapshotLink[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        const col = header[c - 1];
        const raw = cell.value;
        const text = cellText(raw).trim();
        if (text) values[col] = text;
        // cell.formula also resolves shared formulas to this cell's own expression.
        const formula = cell.type === ExcelJS.ValueType.Formula ? cell.formula : undefined;
        if (formula) formulas[col] = `=${formula}`;
        const link = (raw && typeof raw === "object" && "hyperlink" in raw ? (raw as { hyperlink?: string }).hyperlink : undefined) ?? cell.hyperlink;
        if (link) links.push({ column: col, text: text || null, url: String(link) });
        const note = cell.note;
        if (note) notes[col] = typeof note === "string" ? note : (note.texts ?? []).map((t) => t.text).join("");
      }
      if (Object.keys(values).length === 0 && links.length === 0) return;
      rows.push({ rowNumber, values, formulas, notes, links, checksum: sha(JSON.stringify([values, formulas, links])) });
    });
    tabs.push({ name: ws.name, state: ws.state ?? "visible", header, rows });
  });
  return { fileName, fileSha256: sha(buffer), capturedAt, tabs };
}

export function tab(snapshot: Snapshot, name: string): SnapshotTab | undefined {
  return snapshot.tabs.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
}
