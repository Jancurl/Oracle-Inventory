import { FieldMapping } from "./mapper";

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidatedRow {
  rowIndex: number;
  rawData: Record<string, unknown>;
  mappedData: Record<string, unknown>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  isValid: boolean;
  hasWarnings: boolean;
}

// Required field groups per category.
// Each inner array is an OR group — at least one field in the group must be present.
const REQUIRED_BY_CATEGORY: Record<string, string[][]> = {
  "Computers":       [["name"], ["assetTag", "serialNumber", "meta.computerName"]],
  "Laptops":         [["name"], ["assetTag", "serialNumber", "meta.computerName"]],
  "Desktops":        [["name"], ["assetTag", "serialNumber", "meta.computerName"]],
  "Company Phones":  [["name"], ["serialNumber", "meta.imeiNumber", "propertyTag"]],
  "Email Accounts":  [["name", "meta.email"]],
  "Monitors":        [["name"], ["assetTag", "serialNumber"]],
  "Printers":        [["name"], ["assetTag", "serialNumber"]],
  "Network Devices": [["name"], ["assetTag", "serialNumber", "meta.macAddress"]],
  "Peripherals":     [["name"]],
  "Accessories":     [["name"]],
};

const CONDITION_MAP: Record<string, string> = {
  good: "usable", working: "usable", ok: "usable", operational: "usable",
  usable: "usable", serviceable: "usable", functional: "usable",
  "for repair": "for_repair", repair: "for_repair", broken: "for_repair",
  defective: "for_repair", damaged: "for_repair",
  "for disposal": "for_disposal", disposal: "for_disposal", condemned: "for_disposal",
  disposed: "for_disposal", obsolete: "for_disposal",
};

const OWNERSHIP_MAP: Record<string, string> = {
  company: "company", "company-owned": "company", owned: "company",
  personal: "personal", byod: "personal",
};

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function utcDate(year: number, monthIndex: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, monthIndex, day));
  // Reject overflow such as 31/02, which Date would silently roll forward.
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIndex && d.getUTCDate() === day ? d : null;
}

/**
 * Read a spreadsheet date cell as a calendar date at UTC midnight, so the day
 * stored does not depend on the server's time zone. Accepts ISO dates, the
 * m/d/y text Excel exports, d/m/y when the first number cannot be a month,
 * month-name forms, and raw Excel serial numbers. Returns null when the value
 * is not a date.
 */
export function parseImportDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : utcDate(value.getFullYear(), value.getMonth(), value.getDate());
  const text = String(value ?? "").trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    // 1955–2119: outside this a bare number is far more likely a typo or an ID.
    return serial >= 20000 && serial <= 80000 ? new Date(EXCEL_EPOCH_UTC + serial * 86_400_000) : null;
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(text);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = slashed[3].length === 2 ? 2000 + Number(slashed[3]) : Number(slashed[3]);
    // m/d/y is what Excel writes; fall back to d/m/y only when m/d/y is impossible.
    return first <= 12 ? utcDate(year, first - 1, second) : utcDate(year, second - 1, first);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return utcDate(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getNestedValue(mapped: Record<string, unknown>, path: string): unknown {
  if (path.startsWith("meta.")) {
    const key = path.slice(5);
    return (mapped.metadata as Record<string, unknown> | null)?.[key];
  }
  return mapped[path];
}

export function validateRows(
  rows: Record<string, unknown>[],
  mappings: FieldMapping[],
  category: string,
  ingestUnmappedAsMetadata = false
): ValidatedRow[] {
  const mappedCols = new Set(mappings.map((m) => m.fileColumn));

  return rows.map((raw, i) => {
    const mapped: Record<string, unknown> = {};
    const metadata: Record<string, unknown> = {};

    // Apply column mappings
    for (const m of mappings) {
      const val = raw[m.fileColumn];
      const isEmpty = val === null || val === "" || val === undefined;
      if (isEmpty) continue; // empty cells → skip (PATCH semantics)

      if (m.isMetadata && m.metadataKey) {
        metadata[m.metadataKey] = val;
      } else {
        mapped[m.systemField] = val;
      }
    }

    // Ingest unmapped columns as metadata with normalized snake_case keys
    if (ingestUnmappedAsMetadata) {
      for (const [col, val] of Object.entries(raw)) {
        if (mappedCols.has(col)) continue;
        if (val === null || val === "" || val === undefined) continue;
        const snakeKey = col
          .toLowerCase()
          .replace(/[\s\-./]+/g, "_")
          .replace(/[^a-z0-9_]/g, "")
          .replace(/^_+|_+$/g, "");
        if (snakeKey && !(snakeKey in metadata)) {
          metadata[snakeKey] = val;
        }
      }
    }

    if (Object.keys(metadata).length > 0) mapped.metadata = metadata;

    // No name for this row: build one from Brand + Model, else the computer name.
    if (mapped.name === undefined) {
      const derived = [metadata.brand, metadata.model].filter(Boolean).join(" ").trim() || metadata.computerName;
      if (derived) mapped.name = String(derived);
    }

    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // ── Required fields ─────────────────────────────────────────────────────
    const reqs = REQUIRED_BY_CATEGORY[category] ?? [["name"]];
    for (const group of reqs) {
      const satisfied = group.some((f) => {
        const v = getNestedValue(mapped, f);
        return v !== null && v !== undefined && v !== "";
      });
      if (!satisfied) {
        errors.push({
          field: group.join(" or "),
          message: `Required: ${group.join(" or ")}`,
          severity: "error",
        });
      }
    }

    // ── Date fields ──────────────────────────────────────────────────────────
    // An unreadable date is dropped with a warning rather than failing the
    // whole row — the asset is still worth importing without it.
    for (const field of ["warrantyExpiry", "purchaseDate", "nextMaintenanceDate"]) {
      if (mapped[field]) {
        const d = parseImportDate(mapped[field]);
        if (!d) {
          warnings.push({ field, message: `Could not read "${mapped[field]}" as a date for ${field} — left blank.`, severity: "warning" });
          delete mapped[field];
        } else {
          mapped[field] = d.toISOString();
        }
      }
    }

    // ── Condition normalisation ───────────────────────────────────────────────
    if (mapped.condition) {
      const raw_c = String(mapped.condition).toLowerCase().trim();
      const normalised = CONDITION_MAP[raw_c];
      if (normalised) {
        mapped.condition = normalised;
      } else {
        warnings.push({
          field: "condition",
          message: `Unknown condition "${mapped.condition}", defaulting to "usable"`,
          severity: "warning",
        });
        mapped.condition = "usable";
      }
    }

    // ── Ownership normalisation ──────────────────────────────────────────────
    if (mapped.ownership) {
      const raw_o = String(mapped.ownership).toLowerCase().trim();
      mapped.ownership = OWNERSHIP_MAP[raw_o] ?? "company";
    }

    // ── No unique identifier warning ─────────────────────────────────────────
    const hasUniqueId =
      mapped.assetTag ||
      mapped.serialNumber ||
      mapped.propertyTag ||
      (mapped.metadata as Record<string, unknown> | undefined)?.imeiNumber ||
      (mapped.metadata as Record<string, unknown> | undefined)?.computerName;

    if (!hasUniqueId) {
      warnings.push({
        field: "identifier",
        message: "No unique identifier (assetTag, serialNumber, IMEI, propertyTag, computerName). Duplicate detection will be unavailable for this row.",
        severity: "warning",
      });
    }

    return {
      rowIndex: i,
      rawData: raw,
      mappedData: mapped,
      errors,
      warnings,
      isValid: errors.length === 0,
      hasWarnings: warnings.length > 0,
    };
  });
}
