// One-time import of Planning/UPDATED MAINTENANCE TOOLS INVENTORY 2026_1.xlsx
// into the stock system. Safe to re-run: skips any SKU that already exists.
//
// Run with: npx tsx scripts/import-maintenance-tools-2026.ts
import "dotenv/config";
import path from "path";
import XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";

const WORKBOOK_PATH = path.resolve(__dirname, "../../Planning/UPDATED MAINTENANCE TOOLS INVENTORY 2026_1.xlsx");
const PERFORMED_BY_ID = "usr-bootstrap-super-admin";
const DISPOSAL_DATE = new Date("2026-05-22T00:00:00.000Z");
const LOCATION_NAME = "Maintenance Tool Storage";

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function clean(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.toUpperCase() === "N/A") return null;
  return s;
}

function excelDateToISO(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = XLSX.SSF.parse_date_code(n);
  if (!d) return null;
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

interface Row {
  tool: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  acquisitionDate: string | null;
  serial: string | null;
  quantity: number;
  remarks: string | null;
}

function parseRows(raw: unknown[][], startIdx: number, endIdx: number): Row[] {
  const rows: Row[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const r = raw[i];
    if (!r || !clean(r[0])) continue;
    const qtyRaw = Number(r[6]);
    rows.push({
      tool: titleCase(String(r[0]).trim()),
      brand: clean(r[1]),
      model: clean(r[2]),
      color: clean(r[3]),
      acquisitionDate: excelDateToISO(r[4]),
      serial: clean(r[5]),
      quantity: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
      remarks: clean(r[7]),
    });
  }
  return rows;
}

function buildDescription(row: Row, extra?: string): string {
  const parts: string[] = [];
  if (row.brand) parts.push(`Brand: ${row.brand}`);
  if (row.model) parts.push(`Model: ${row.model}`);
  if (row.color) parts.push(`Color: ${row.color}`);
  if (row.serial) parts.push(`Serial: ${row.serial}`);
  if (row.acquisitionDate) parts.push(`Acquired: ${row.acquisitionDate}`);
  if (extra) parts.push(extra);
  return parts.join(" · ") || "Imported from maintenance tools inventory spreadsheet.";
}

async function main() {
  const wb = XLSX.readFile(WORKBOOK_PATH);
  const ws = wb.Sheets["FINAL"];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  // Sheet rows 3-56 (0-based idx 2-55): current tools (active).
  const activeRows = parseRows(raw, 2, 55);
  // Sheet rows 61-73 (0-based idx 60-72): DISPOSAL AS OF 05-22-2026 (POWER TOOLS).
  const disposedRows = parseRows(raw, 60, 72);

  console.log(`Parsed ${activeRows.length} active rows, ${disposedRows.length} disposed rows.`);

  let location = await prisma.stockLocation.findFirst({ where: { name: LOCATION_NAME } });
  if (!location) {
    const branch = await prisma.branch.findFirstOrThrow();
    location = await prisma.stockLocation.create({
      data: {
        branchId: branch.id,
        name: LOCATION_NAME,
        locationType: "room",
        description: "Created by maintenance-tools-2026 import script.",
      },
    });
    console.log(`Created StockLocation "${LOCATION_NAME}" (${location.id}) under branch ${branch.id}.`);
  } else {
    console.log(`Using existing StockLocation "${LOCATION_NAME}" (${location.id}).`);
  }

  let created = 0;
  let skipped = 0;
  let seq = 0;

  for (const row of activeRows) {
    seq++;
    const sku = `MT-${String(seq).padStart(3, "0")}`;
    const existing = await prisma.stockItem.findUnique({ where: { sku } });
    if (existing) { skipped++; continue; }

    const item = await prisma.stockItem.create({
      data: {
        sku,
        idempotencyKey: `import-mt2026-${sku}`,
        requestFingerprint: "bulk-import-maintenance-tools-2026",
        name: row.tool,
        category: "Maintenance Tools",
        unitOfMeasure: "pc",
        description: buildDescription(row, row.remarks ?? undefined),
        isSerialized: Boolean(row.serial),
        active: true,
      },
    });

    const movement = await prisma.stockMovement.create({
      data: {
        stockItemId: item.id,
        movementType: "opening",
        quantity: row.quantity,
        reason: "Opening balance — maintenance tools inventory import (June 01, 2026 snapshot).",
        idempotencyKey: `import-mt2026-movement-${sku}`,
        requestFingerprint: "bulk-import-maintenance-tools-2026",
        performedById: PERFORMED_BY_ID,
      },
    });
    await prisma.stockLedgerEntry.create({
      data: { movementId: movement.id, locationId: location.id, quantityDelta: row.quantity },
    });

    created++;
  }

  let disposedCreated = 0;
  let disposedSkipped = 0;
  let dseq = 0;

  for (const row of disposedRows) {
    dseq++;
    const sku = `MT-DISP-${String(dseq).padStart(3, "0")}`;
    const existing = await prisma.stockItem.findUnique({ where: { sku } });
    if (existing) { disposedSkipped++; continue; }

    await prisma.stockItem.create({
      data: {
        sku,
        idempotencyKey: `import-mt2026-${sku}`,
        requestFingerprint: "bulk-import-maintenance-tools-2026",
        name: row.tool,
        category: "Maintenance Tools",
        unitOfMeasure: "pc",
        description: buildDescription(row, "Disposed — no longer in use") + ` (qty at disposal: ${row.quantity})`,
        isSerialized: Boolean(row.serial),
        active: false,
        archivedAt: DISPOSAL_DATE,
      },
    });
    // No opening movement/ledger entry: disposed items carry no current stock.

    disposedCreated++;
  }

  console.log(`Active: created ${created}, skipped (already existed) ${skipped}.`);
  console.log(`Disposed: created ${disposedCreated}, skipped (already existed) ${disposedSkipped}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
