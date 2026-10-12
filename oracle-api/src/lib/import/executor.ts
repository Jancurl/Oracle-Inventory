import { prisma } from "../prisma";
import { ValidatedRow, parseImportDate } from "./validator";
import { DuplicateInfo } from "./duplicateChecker";
import { logActivity } from "../activity";

const CHUNK_SIZE = 50;

export interface ExecuteOptions {
  importHistoryId: string;
  categoryId: string | null;
  branchId: string | null;
  strictMode: boolean;
  userId: string;
  duplicates: Map<number, DuplicateInfo>;
  overwriteIndices: Set<number>;          // row indices the user chose to overwrite
  resolvedEmployees: Map<number, string>; // rowIndex → employeeId
  rowBranchOverrides?: Map<number, string>;    // per-row branch remaps from preview UI
  rowCategoryOverrides?: Map<number, string>;  // per-row category overrides (OPC multi-schema)
  categoryNames?: Map<string, string>;         // categoryId → name, to tell a laptop from a desktop
}

export interface ExecuteResult {
  importedRows: number;
  skippedRows: number;
  failedRows: number;
  duplicatesSkipped: number;
  overwrittenRows: number;
  assignmentsCreated: number;
  categoriesCreated: number;
  employeesCreated: number;
  employeesUpdated: number;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

/** "8GB + 8GB" or "SSD 512GB, HDD 1TB" → one component row per part. */
function componentParts(value: unknown): string[] {
  return (text(value) ?? "").split(/\s*[+,;]\s*/).map((part) => part.trim()).filter(Boolean).slice(0, 8);
}

/**
 * Brand, model, OS, processor, RAM and storage have no column on Asset — they
 * live on the device profile and its component rows, which is what the asset
 * page reads. Without this they were only kept in the raw metadata JSON and
 * never shown anywhere.
 */
async function saveDeviceDetails(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  assetId: string,
  mappedData: Record<string, unknown>,
  meta: Record<string, unknown>,
  serialNumber: string | null,
  replaceComponents: boolean,
  categoryName: string
): Promise<void> {
  const brand = text(mappedData.brand ?? meta.brand);
  const model = text(mappedData.model ?? meta.model);
  const operatingSystem = text(meta.os);
  const processor = text(meta.processor);
  const ram = componentParts(meta.ram);
  const storage = componentParts(meta.storage);
  if (!brand && !model && !operatingSystem && !processor && ram.length === 0 && storage.length === 0) return;

  const typeHint = `${text(mappedData.deviceType ?? meta.deviceType) ?? ""} ${text(mappedData.categoryHint) ?? ""} ${categoryName}`;
  const details = {
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
    ...(operatingSystem ? { operatingSystem } : {}),
    ...(processor ? { processor } : {}),
    ...(serialNumber ? { deviceSerial: serialNumber } : {}),
  };
  const profile = await tx.deviceProfile.upsert({
    where: { assetId },
    create: { assetId, deviceType: /laptop|notebook/i.test(typeHint) ? "laptop" : "computer", source: "import", ...details },
    update: details,
  });

  if (ram.length === 0 && storage.length === 0) return;
  if (replaceComponents) {
    // Overwrite re-imports the same row: replace what the last import wrote, keep manual rows.
    await tx.assetComponent.deleteMany({ where: { assetId, source: "import", type: { in: ["ram", "storage"] } } });
  }
  await tx.assetComponent.createMany({
    data: [
      ...ram.map((capacity) => ({ assetId, deviceProfileId: profile.id, type: "ram", capacity, source: "import" })),
      ...storage.map((capacity) => ({ assetId, deviceProfileId: profile.id, type: "storage", capacity, source: "import" })),
    ],
  });
}

async function processRow(
  row: ValidatedRow,
  opts: ExecuteOptions,
  result: ExecuteResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any
): Promise<void> {
  const { mappedData, rowIndex } = row;
  const dupInfo = opts.duplicates.get(rowIndex) ?? { isDuplicate: false };
  const shouldOverwrite = opts.overwriteIndices.has(rowIndex);

  if (dupInfo.isDuplicate && !shouldOverwrite) {
    result.duplicatesSkipped++;
    await tx.importRow.updateMany({
      where: { importId: opts.importHistoryId, rowIndex },
      data: { outcome: "duplicate", conflictKey: dupInfo.conflictKey, isDuplicate: true },
    });
    return;
  }

  const meta = (mappedData.metadata as Record<string, unknown> | null | undefined) ?? {};
  const serialNumber = text(mappedData.serialNumber);

  const assetData = {
    name:               text(mappedData.name) ?? "Unnamed Asset",
    serialNumber,
    assetTag:           text(mappedData.assetTag),
    // Single-sheet imports map these three columns into metadata; the
    // multi-sheet extractors set them at the top level. Read both.
    computerName:       text(mappedData.computerName ?? meta.computerName),
    imeiNumber:         text(mappedData.imeiNumber   ?? meta.imeiNumber),
    propertyTag:        text(mappedData.propertyTag),
    macAddress:         text(mappedData.macAddress   ?? meta.macAddress),
    metadata:           mappedData.metadata ?? null,
    condition:          (mappedData.condition  as string)  ?? "usable",
    ownership:          (mappedData.ownership  as string)  ?? "company",
    description:        text(mappedData.description),
    // parseImportDate returns null for an unreadable value, so one bad date
    // cell can no longer fail the whole 50-row chunk.
    warrantyExpiry:     parseImportDate(mappedData.warrantyExpiry),
    purchaseDate:       parseImportDate(mappedData.purchaseDate),
    nextMaintenanceDate:parseImportDate(mappedData.nextMaintenanceDate),
    categoryId:         opts.rowCategoryOverrides?.get(rowIndex) ?? opts.categoryId,
    branchId:           opts.rowBranchOverrides?.get(rowIndex) ?? opts.branchId,
    importId:           opts.importHistoryId,
  };

  let assetId: string;

  if (shouldOverwrite && dupInfo.existingAssetId) {
    // PATCH-style overwrite: only non-null values
    const updateData = Object.fromEntries(
      Object.entries(assetData).filter(([, v]) => v !== null && v !== undefined)
    );
    delete updateData.importId; // don't overwrite importId on existing records
    const updated = await tx.asset.update({ where: { id: dupInfo.existingAssetId }, data: updateData });
    assetId = updated.id;
    result.overwrittenRows++;
    await tx.importRow.updateMany({
      where: { importId: opts.importHistoryId, rowIndex },
      data: { outcome: "overwritten", assetId, conflictKey: dupInfo.conflictKey },
    });
  } else {
    const asset = await tx.asset.create({ data: assetData });
    assetId = asset.id;
    result.importedRows++;
    await tx.importRow.updateMany({
      where: { importId: opts.importHistoryId, rowIndex },
      data: { outcome: "imported", assetId },
    });
  }

  const categoryName = (assetData.categoryId && opts.categoryNames?.get(assetData.categoryId)) || "";
  await saveDeviceDetails(tx, assetId, mappedData, meta, serialNumber, shouldOverwrite, categoryName);

  // Employee linking
  const employeeId = opts.resolvedEmployees.get(rowIndex);
  if (employeeId) {
    if (!shouldOverwrite) {
      // New asset — create assignment unconditionally
      await tx.assetAssignment.create({
        data: { assetId, employeeId, status: "active", notes: "Created via import" },
      });
      await tx.movementLog.create({
        data: { assetId, employeeId, type: "assignment", notes: "Imported via Excel/CSV upload" },
      });
      result.assignmentsCreated++;
    } else {
      // Overwritten asset — sync assignment: close any active assignment to a different
      // employee, then create (or keep) one for the current resolved employee.
      const existing = await tx.assetAssignment.findFirst({
        where: { assetId, status: "active" },
        select: { id: true, employeeId: true },
      });
      if (!existing) {
        // No active assignment — create one
        await tx.assetAssignment.create({
          data: { assetId, employeeId, status: "active", notes: "Reassigned via import overwrite" },
        });
        await tx.movementLog.create({
          data: { assetId, employeeId, type: "assignment", notes: "Assignment synced via import overwrite" },
        });
        result.assignmentsCreated++;
      } else if (existing.employeeId !== employeeId) {
        // Different employee — close old, open new
        await tx.assetAssignment.update({
          where: { id: existing.id },
          data: { status: "returned", returnedAt: new Date() },
        });
        await tx.assetAssignment.create({
          data: { assetId, employeeId, status: "active", notes: "Reassigned via import overwrite" },
        });
        await tx.movementLog.create({
          data: { assetId, employeeId, type: "transfer", notes: "Employee changed via import overwrite" },
        });
        result.assignmentsCreated++;
      }
      // else: same employee already assigned — no change needed
    }
  }
}

export async function executeImport(
  validatedRows: ValidatedRow[],
  opts: ExecuteOptions
): Promise<ExecuteResult> {
  const result: ExecuteResult = {
    importedRows: 0, skippedRows: 0, failedRows: 0,
    duplicatesSkipped: 0, overwrittenRows: 0, assignmentsCreated: 0,
    categoriesCreated: 0, employeesCreated: 0, employeesUpdated: 0,
  };

  const validRows   = validatedRows.filter((r) => r.isValid);
  const invalidRows = validatedRows.filter((r) => !r.isValid);

  // Mark invalid rows as failed
  for (const row of invalidRows) {
    result.failedRows++;
    await prisma.importRow.updateMany({
      where: { importId: opts.importHistoryId, rowIndex: row.rowIndex },
      data: {
        outcome: "failed",
        errorMessage: row.errors.map((e) => e.message).join("; "),
      },
    });
  }

  if (opts.strictMode) {
    // All-or-nothing — single transaction with extended timeout
    await prisma.$transaction(async (tx) => {
      for (const row of validRows) {
        await processRow(row, opts, result, tx);
      }
    }, { timeout: 120_000 });
  } else {
    // Chunked partial import — each chunk gets its own transaction with extended timeout
    for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + CHUNK_SIZE);
      try {
        await prisma.$transaction(async (tx) => {
          for (const row of chunk) {
            await processRow(row, opts, result, tx);
          }
        }, { timeout: 60_000 });
      } catch (err) {
        for (const row of chunk) {
          result.failedRows++;
          await prisma.importRow.updateMany({
            where: { importId: opts.importHistoryId, rowIndex: row.rowIndex },
            data: { outcome: "failed", errorMessage: (err as Error).message },
          }).catch(() => {});
        }
      }
    }
  }

  // Update ImportHistory status (entity counters are written by the route after this returns)
  await prisma.importHistory.update({
    where: { id: opts.importHistoryId },
    data: {
      status:
        result.failedRows > 0 && result.importedRows === 0 && result.overwrittenRows === 0
          ? "failed"
          : result.failedRows > 0
          ? "partial"
          : "completed",
    },
  });

  await logActivity({
    userId: opts.userId,
    action: "import_completed",
    entity: "ImportHistory",
    entityId: opts.importHistoryId,
    metadata: { ...result },
  });

  return result;
}
