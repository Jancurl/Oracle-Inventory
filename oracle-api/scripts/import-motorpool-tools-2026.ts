// One-time import of the "MOTORPOOL TOOLS INVENTORY JUNE 11, 2026" sheet
// (provided as screenshots, not a file — transcribed by hand below) into the
// stock system. Safe to re-run: skips any SKU that already exists.
//
// Notes on the source data:
// - "DEEP SOCKET 22" appears twice in the sheet (rows 9 and 28), each with
//   count 1 — merged here into a single item with quantity 2.
// - "FLAT SCREW" shows count 0 and is flagged missing on both the June 01
//   and June 11 sheets — included at 0 quantity per user decision, so it
//   stays visible in All Items as a known-missing tool.
//
// Run with: npx tsx scripts/import-motorpool-tools-2026.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const PERFORMED_BY_ID = "usr-bootstrap-super-admin";
const LOCATION_NAME = "Motorpool Tool Storage";
const CATEGORY = "Motorpool Tools";

interface Row {
  name: string;
  uom: "set" | "pc";
  quantity: number;
  model: string | null;
  color: string | null;
  serial: string | null;
  remarks: string | null;
}

const ROWS: Row[] = [
  { name: "Set Socket Wrench", uom: "set", quantity: 1, model: null, color: "Blue", serial: null, remarks: "Flymann Professional" },
  { name: "Set Spring Compressor", uom: "set", quantity: 2, model: null, color: null, serial: null, remarks: null },
  { name: "Torque Wrench", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Labe Tubo", uom: "pc", quantity: 1, model: null, color: "Red", serial: null, remarks: null },
  { name: "Deep Socket 5/8", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Deep Socket 14", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Deep Socket 17", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Deep Socket 19", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Deep Socket 22", uom: "pc", quantity: 2, model: null, color: null, serial: null, remarks: "Two units on sheet (rows 9 & 28), merged" },
  { name: "Deep Socket 34", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Deep Socket 21", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Vice C Clump", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Grease Gun", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Oil Filter Remover", uom: "pc", quantity: 1, model: null, color: "Orange", serial: null, remarks: null },
  { name: "Flat Screw", uom: "pc", quantity: 0, model: null, color: null, serial: null, remarks: "Missing — still not located as of 06-11-2026" },
  { name: "Set Open Wrench Alb 22", uom: "set", quantity: 6, model: null, color: null, serial: null, remarks: "All complete (24, 27, 21, 32, 17, 14)" },
  { name: "Steel Brush", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Embudo Large", uom: "pc", quantity: 1, model: null, color: "Black", serial: null, remarks: null },
  { name: "Embudo Small", uom: "pc", quantity: 1, model: null, color: "Red", serial: null, remarks: null },
  { name: "Piston Ring Compresor", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Impact Drive", uom: "pc", quantity: 1, model: null, color: "Green", serial: null, remarks: "Not working" },
  { name: "Crocodile Jack (Small)", uom: "pc", quantity: 1, model: null, color: "Red", serial: null, remarks: null },
  { name: "Crocodile Jack (Big)", uom: "pc", quantity: 1, model: null, color: "Yellow", serial: null, remarks: null },
  { name: "Bottle Hack (Small)", uom: "pc", quantity: 1, model: null, color: "Blue", serial: null, remarks: null },
  { name: "Bottle Hack (Big)", uom: "pc", quantity: 1, model: null, color: "Blue", serial: null, remarks: null },
  { name: "Pitcher", uom: "pc", quantity: 1, model: null, color: "Black", serial: null, remarks: null },
  { name: "Plastic Car Creeper", uom: "pc", quantity: 1, model: null, color: "Orange", serial: null, remarks: null },
  { name: "Steel Hammer (Big)", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Steel Hammer (Small)", uom: "pc", quantity: 1, model: null, color: null, serial: null, remarks: null },
  { name: "Air Compressor Set", uom: "pc", quantity: 1, model: "MT-23", color: null, serial: null, remarks: "Vespa" },
  { name: "Battery Charger", uom: "pc", quantity: 1, model: "ING-CB1501", color: "Yellow", serial: "23393600254", remarks: null },
];

function buildDescription(row: Row): string {
  const parts: string[] = [];
  if (row.model) parts.push(`Model: ${row.model}`);
  if (row.color) parts.push(`Color: ${row.color}`);
  if (row.serial) parts.push(`Serial: ${row.serial}`);
  if (row.remarks) parts.push(row.remarks);
  return parts.join(" · ") || "Imported from motorpool tools inventory (June 11, 2026 snapshot).";
}

async function main() {
  let location = await prisma.stockLocation.findFirst({ where: { name: LOCATION_NAME } });
  if (!location) {
    const branch = await prisma.branch.findFirstOrThrow();
    location = await prisma.stockLocation.create({
      data: {
        branchId: branch.id,
        name: LOCATION_NAME,
        locationType: "room",
        description: "Created by import-motorpool-tools-2026 import script.",
      },
    });
    console.log(`Created StockLocation "${LOCATION_NAME}" (${location.id}) under branch ${branch.id}.`);
  } else {
    console.log(`Using existing StockLocation "${LOCATION_NAME}" (${location.id}).`);
  }

  let created = 0;
  let skipped = 0;
  let seq = 0;

  for (const row of ROWS) {
    seq++;
    const sku = `MP-${String(seq).padStart(3, "0")}`;
    const existing = await prisma.stockItem.findUnique({ where: { sku } });
    if (existing) { skipped++; continue; }

    const item = await prisma.stockItem.create({
      data: {
        sku,
        idempotencyKey: `import-mp2026-${sku}`,
        requestFingerprint: "bulk-import-motorpool-tools-2026",
        name: row.name,
        category: CATEGORY,
        unitOfMeasure: row.uom,
        description: buildDescription(row),
        isSerialized: Boolean(row.serial),
        active: true,
      },
    });

    const movement = await prisma.stockMovement.create({
      data: {
        stockItemId: item.id,
        movementType: "opening",
        quantity: row.quantity,
        reason: "Opening balance — motorpool tools inventory import (June 11, 2026 snapshot).",
        idempotencyKey: `import-mp2026-movement-${sku}`,
        requestFingerprint: "bulk-import-motorpool-tools-2026",
        performedById: PERFORMED_BY_ID,
      },
    });
    await prisma.stockLedgerEntry.create({
      data: { movementId: movement.id, locationId: location.id, quantityDelta: row.quantity },
    });

    created++;
  }

  console.log(`Created ${created}, skipped (already existed) ${skipped}. Total rows: ${ROWS.length}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
