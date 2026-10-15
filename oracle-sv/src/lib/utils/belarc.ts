import { api } from '$lib/api';

// Values a Belarc Advisor report gives for a computer — see
// oracle-api/src/lib/belarc/toInventory.ts for how they are read.
export interface BelarcComponent {
  type: 'ram' | 'storage';
  slotOrBay?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  capacity?: string;
  storageKind?: string;
}

export interface BelarcFill {
  name: string | null;
  computerName: string | null;
  serialNumber: string | null;
  macAddress: string | null;
  deviceType: 'computer' | 'laptop';
  brand: string | null;
  model: string | null;
  processor: string | null;
  motherboard: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  osInstallDate: string | null;
  components: BelarcComponent[];
  profileDate: string | null;
}

export interface BelarcPlanItem {
  key: string;
  label: string;
  report: string;
  current: string | null;
  action: 'fill' | 'same' | 'differs';
}

/** An asset already in the inventory that looks like the same computer. */
export interface BelarcMatch {
  id: string;
  name: string;
  assetTag: string | null;
  branch: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  matchedBy: string;
  plan: {
    fields: BelarcPlanItem[];
    components: { report: number; current: number; action: 'fill' | 'keep' };
  };
}

export interface BelarcReading {
  fileName: string;
  fill: BelarcFill;
  match: BelarcMatch | null;
}

/** Sends one report to be read. Nothing is saved. */
export async function readBelarcReport(file: File): Promise<BelarcReading> {
  const form = new FormData();
  form.append('file', file);
  const res = await api.raw('/api/belarc-import/read', { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as Partial<BelarcReading> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Could not read ${file.name} (HTTP ${res.status}).`);
  return body as BelarcReading;
}

const isLaptopCategory = (name: string) => /laptop|notebook/i.test(name);

/** Laptop category for a laptop, Desktop (or Computer) for anything else. */
export function computerCategoryFor(categories: { id: string; name: string }[], deviceType: 'computer' | 'laptop'): string {
  const laptop = categories.find((c) => isLaptopCategory(c.name));
  const desktop =
    categories.find((c) => /desktop/i.test(c.name)) ??
    categories.find((c) => /computer/i.test(c.name) && !isLaptopCategory(c.name));
  return (deviceType === 'laptop' ? laptop ?? desktop : desktop ?? laptop)?.id ?? '';
}

/** "2 × 16 GB RAM, 512 GB NVMe" */
export function describeComponents(rows: BelarcComponent[]): string {
  const ram = rows.filter((r) => r.type === 'ram');
  const parts: string[] = [];
  if (ram.length) {
    const sizes = [...new Set(ram.map((r) => r.capacity ?? '?'))];
    parts.push(sizes.length === 1 ? `${ram.length > 1 ? `${ram.length} × ` : ''}${sizes[0]} GB RAM` : `${ram.reduce((sum, r) => sum + Number(r.capacity ?? 0), 0)} GB RAM`);
  }
  for (const drive of rows.filter((r) => r.type === 'storage')) {
    const size = Number(drive.capacity ?? 0);
    parts.push(`${size >= 1000 ? `${Math.round(size / 100) / 10} TB` : `${size} GB`} ${drive.slotOrBay ?? 'storage'}`);
  }
  return parts.join(', ');
}

/** One form field a report can fill. */
export interface BelarcTarget {
  label: string;
  value: string | null;
  get: () => string;
  set: (value: string) => void;
}

/** A field that already held a different value; `use` puts the report's value in. */
export interface BelarcDiff {
  label: string;
  current: string;
  report: string;
  use: () => void;
}

export interface BelarcApplied {
  filled: string[];
  differs: BelarcDiff[];
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/** Fills the empty fields only; anything already typed is kept and listed as differing. */
export function fillBlanks(targets: BelarcTarget[]): BelarcApplied {
  const filled: string[] = [];
  const differs: BelarcDiff[] = [];
  for (const target of targets) {
    const value = target.value;
    if (!value) continue;
    const current = target.get().trim();
    if (!current) {
      target.set(value);
      filled.push(target.label);
    } else if (!sameText(current, value)) {
      differs.push({ label: target.label, current, report: value, use: () => target.set(value) });
    }
  }
  return { filled, differs };
}

type Row = { type: 'ram' | 'storage'; capacity?: string; serialNumber?: string; model?: string; brand?: string };
const rowKey = (r: Row) => `${r.type}|${Number(r.capacity ?? 0)}|${(r.serialNumber ?? '').toLowerCase()}`;

/**
 * RAM / storage rows follow the same rule as single fields: rows are filled
 * in when the form has none, and only offered as a replacement otherwise.
 */
export function fillHardwareRows<T extends Row>(
  current: T[],
  report: BelarcComponent[],
  toRow: (c: BelarcComponent) => T,
  setRows: (rows: T[]) => void,
  result: BelarcApplied,
) {
  if (report.length === 0) return;
  const empty = current.every((r) => !r.capacity?.trim() && !r.model?.trim() && !r.serialNumber?.trim() && !r.brand?.trim());
  const label = `RAM and storage (${describeComponents(report)})`;
  if (empty) {
    setRows(report.map(toRow));
    result.filled.push(label);
    return;
  }
  const same = current.map(rowKey).sort().join() === report.map((c) => rowKey(c as Row)).sort().join();
  if (!same) {
    result.differs.push({
      label: 'RAM and storage',
      current: `${current.length} row${current.length === 1 ? '' : 's'}`,
      report: describeComponents(report),
      use: () => setRows(report.map(toRow)),
    });
  }
}
