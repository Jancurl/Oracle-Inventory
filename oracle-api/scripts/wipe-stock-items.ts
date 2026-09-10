// One-time cleanup: removes every StockItem and everything that references
// it (ledger entries, movements, count lines, assignments; policies cascade
// on their own) from the "All Items" stock list. Requested 2026-09-01,
// re-run 2026-09-01 after the Stock Assignments feature was added.
//
// Run with: npx tsx scripts/wipe-stock-items.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const before = {
    items: await prisma.stockItem.count(),
    movements: await prisma.stockMovement.count(),
    ledgerEntries: await prisma.stockLedgerEntry.count(),
    countLines: await prisma.stockCountLine.count(),
    policies: await prisma.stockLevelPolicy.count(),
    assignments: await prisma.stockAssignment.count(),
  };
  console.log("Before:", before);

  if (before.items === 0) {
    console.log("No stock items found — nothing to do.");
    return;
  }

  await prisma.$transaction([
    // Restrict FKs must be cleared child-first: assignments reference
    // movements (+ stock item/employee/location), ledger entries reference
    // movements, movements + count lines reference stock items.
    prisma.stockAssignment.deleteMany({}),
    prisma.stockLedgerEntry.deleteMany({}),
    prisma.stockCountLine.deleteMany({}),
    prisma.stockMovement.deleteMany({}),
    prisma.stockItem.deleteMany({}), // policies cascade automatically
  ]);

  const after = {
    items: await prisma.stockItem.count(),
    movements: await prisma.stockMovement.count(),
    ledgerEntries: await prisma.stockLedgerEntry.count(),
    countLines: await prisma.stockCountLine.count(),
    policies: await prisma.stockLevelPolicy.count(),
    assignments: await prisma.stockAssignment.count(),
  };
  console.log("After:", after);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
