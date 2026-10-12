import { describe, it, expect } from "vitest";
import { validateRows, parseImportDate } from "../validator";
import type { FieldMapping } from "../mapper";

const BASE_MAPPINGS: FieldMapping[] = [
  { fileColumn: "Asset Name", systemField: "name", isMetadata: false },
  { fileColumn: "Serial Number", systemField: "serialNumber", isMetadata: false },
];

// ── ingestUnmappedAsMetadata ──────────────────────────────────────────────────

describe("validateRows – ingestUnmappedAsMetadata", () => {
  const rows = [
    {
      "Asset Name": "Laptop A",
      "Serial Number": "SN123",
      "Purchase Order": "PO-999",
      "Custom Field": "some value",
    },
  ];

  it("excludes unmapped columns by default (flag off)", () => {
    const validated = validateRows(rows, BASE_MAPPINGS, "Peripherals", false);
    const meta = validated[0].mappedData.metadata as Record<string, unknown> | undefined;
    expect(meta?.purchase_order).toBeUndefined();
    expect(meta?.custom_field).toBeUndefined();
  });

  it("ingests unmapped columns as snake_case metadata keys when flag is on", () => {
    const validated = validateRows(rows, BASE_MAPPINGS, "Peripherals", true);
    const meta = validated[0].mappedData.metadata as Record<string, unknown>;
    expect(meta.purchase_order).toBe("PO-999");
    expect(meta.custom_field).toBe("some value");
  });

  it("does not overwrite already-mapped metadata keys", () => {
    const mappingsWithMeta: FieldMapping[] = [
      ...BASE_MAPPINGS,
      { fileColumn: "MAC Address", systemField: "metadata", isMetadata: true, metadataKey: "macAddress" },
    ];
    const rowsWithMac = [{ "Asset Name": "PC", "Serial Number": "SN1", "MAC Address": "AA:BB:CC:DD:EE:FF", "Extra": "val" }];
    const validated = validateRows(rowsWithMac, mappingsWithMeta, "Computers", true);
    const meta = validated[0].mappedData.metadata as Record<string, unknown>;
    // MAC was explicitly mapped; unmapped "Extra" should appear as "extra"
    expect(meta.macAddress).toBe("AA:BB:CC:DD:EE:FF");
    expect(meta.extra).toBe("val");
  });

  it("skips empty unmapped cells", () => {
    const rowsWithEmpty = [{ "Asset Name": "Laptop", "Serial Number": "SN2", "Empty Col": "" }];
    const validated = validateRows(rowsWithEmpty, BASE_MAPPINGS, "Peripherals", true);
    const meta = validated[0].mappedData.metadata as Record<string, unknown> | undefined;
    expect(meta?.empty_col).toBeUndefined();
  });

  it("normalises column names to snake_case keys", () => {
    const rowsSpecial = [{ "Asset Name": "X", "Serial Number": "SN3", "Foo-Bar/Baz Col": "test" }];
    const validated = validateRows(rowsSpecial, BASE_MAPPINGS, "Peripherals", true);
    const meta = validated[0].mappedData.metadata as Record<string, unknown>;
    expect(meta.foo_bar_baz_col).toBe("test");
  });
});

// ── MAC duplicate detection (unit-only: no DB) ────────────────────────────────
// Full duplicate detection needs a DB; these just verify the shape of ValidatedRow
// so downstream logic can read metadata.macAddress correctly.

describe("validateRows – macAddress in metadata", () => {
  it("stores MAC address under metadata.macAddress when mapped", () => {
    const mappings: FieldMapping[] = [
      { fileColumn: "Name", systemField: "name", isMetadata: false },
      { fileColumn: "MAC", systemField: "metadata", isMetadata: true, metadataKey: "macAddress" },
    ];
    const rows = [{ Name: "Switch", MAC: "00:11:22:33:44:55" }];
    const validated = validateRows(rows, mappings, "Network Devices");
    const meta = validated[0].mappedData.metadata as Record<string, unknown>;
    expect(meta.macAddress).toBe("00:11:22:33:44:55");
  });
});

// ── categoryHint and employeeId pass-through ──────────────────────────────────

describe("validateRows – categoryHint and employeeId pass-through", () => {
  it("stores categoryHint as a top-level mapped field", () => {
    const mappings: FieldMapping[] = [
      { fileColumn: "Name",     systemField: "name",        isMetadata: false },
      { fileColumn: "Category", systemField: "categoryHint",isMetadata: false },
    ];
    const rows = [{ Name: "Laptop", Category: "Computers" }];
    const validated = validateRows(rows, mappings, "Peripherals");
    expect(validated[0].mappedData.categoryHint).toBe("Computers");
  });

  it("stores employeeId as a top-level mapped field", () => {
    const mappings: FieldMapping[] = [
      { fileColumn: "Name",        systemField: "name",      isMetadata: false },
      { fileColumn: "Employee ID", systemField: "employeeId",isMetadata: false },
    ];
    const rows = [{ Name: "Laptop", "Employee ID": "EMP-001" }];
    const validated = validateRows(rows, mappings, "Peripherals");
    expect(validated[0].mappedData.employeeId).toBe("EMP-001");
  });
});

// ── Dates ─────────────────────────────────────────────────────────────────────

describe("parseImportDate", () => {
  const day = (value: unknown) => parseImportDate(value)?.toISOString().slice(0, 10) ?? null;

  it("reads the forms a spreadsheet produces as the same calendar day", () => {
    expect(day("2028-01-15")).toBe("2028-01-15");
    expect(day("1/15/28")).toBe("2028-01-15");
    expect(day("01/15/2028")).toBe("2028-01-15");
    expect(day("15-Jan-28")).toBe("2028-01-15");
    expect(day("Jan 15, 2028")).toBe("2028-01-15");
  });

  it("falls back to day/month/year only when month/day/year is impossible", () => {
    expect(day("31/12/2027")).toBe("2027-12-31");
    expect(day("3/5/2025")).toBe("2025-03-05");
  });

  it("reads a raw Excel serial number", () => {
    expect(day("46500")).toBe("2027-04-23");
  });

  it("returns null for text, impossible dates and stray numbers", () => {
    expect(day("not sure")).toBeNull();
    expect(day("N/A")).toBeNull();
    expect(day("31/02/2027")).toBeNull();
    expect(day("123")).toBeNull();
    expect(day("")).toBeNull();
  });

  it("always lands on UTC midnight", () => {
    expect(parseImportDate("1/15/28")?.toISOString()).toBe("2028-01-15T00:00:00.000Z");
  });
});

describe("validateRows – dates", () => {
  const mappings: FieldMapping[] = [
    { fileColumn: "Name", systemField: "name", isMetadata: false },
    { fileColumn: "Warranty Expiry", systemField: "warrantyExpiry", isMetadata: false },
    { fileColumn: "Purchase Date", systemField: "purchaseDate", isMetadata: false },
  ];

  it("normalises warranty and purchase dates", () => {
    const [row] = validateRows([{ Name: "Laptop", "Warranty Expiry": "1/15/28", "Purchase Date": "2025-01-15" }], mappings, "Peripherals");
    expect(row.mappedData.warrantyExpiry).toBe("2028-01-15T00:00:00.000Z");
    expect(row.mappedData.purchaseDate).toBe("2025-01-15T00:00:00.000Z");
  });

  it("keeps the row importable when a date cannot be read", () => {
    const [row] = validateRows([{ Name: "Laptop", "Warranty Expiry": "not sure" }], mappings, "Peripherals");
    expect(row.isValid).toBe(true);
    expect(row.mappedData.warrantyExpiry).toBeUndefined();
    expect(row.warnings.some((w) => w.field === "warrantyExpiry")).toBe(true);
  });
});

// ── Name derived from Brand / Model ───────────────────────────────────────────

describe("validateRows – name fallback", () => {
  const mappings: FieldMapping[] = [
    { fileColumn: "Brand", systemField: "metadata", isMetadata: true, metadataKey: "brand" },
    { fileColumn: "Model", systemField: "metadata", isMetadata: true, metadataKey: "model" },
    { fileColumn: "Computer Name", systemField: "metadata", isMetadata: true, metadataKey: "computerName" },
    { fileColumn: "Serial Number", systemField: "serialNumber", isMetadata: false },
  ];

  it("builds the name from brand and model when there is no name column", () => {
    const [row] = validateRows([{ Brand: "Acer", Model: "Aspire 5", "Serial Number": "SN1" }], mappings, "Laptops");
    expect(row.mappedData.name).toBe("Acer Aspire 5");
    expect(row.isValid).toBe(true);
  });

  it("uses the computer name when brand and model are blank", () => {
    const [row] = validateRows([{ "Computer Name": "HR-LT-01", "Serial Number": "SN2" }], mappings, "Laptops");
    expect(row.mappedData.name).toBe("HR-LT-01");
  });

  it("still requires a name when nothing can stand in for it", () => {
    const [row] = validateRows([{ "Serial Number": "SN3" }], mappings, "Laptops");
    expect(row.isValid).toBe(false);
  });
});
