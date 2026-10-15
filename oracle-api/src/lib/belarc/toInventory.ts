import type { ParsedSpecs } from './types';

/**
 * Turns a parsed Belarc report into the values the Computer / Laptop form
 * holds: asset name, serial, computer name, MAC, device profile and RAM /
 * storage rows. Only hardware identity and specs are taken — user accounts,
 * software licences and the rest of the report are never read here.
 */

export interface BelarcComponent {
  type: 'ram' | 'storage';
  slotOrBay?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  /** Plain number of GB, the way the intake form stores it. */
  capacity?: string;
  storageKind?: string;
}

export interface BelarcFill {
  /** Suggested asset name: "Brand Model", or the computer name. */
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
  /** YYYY-MM-DD */
  osInstallDate: string | null;
  components: BelarcComponent[];
  /** When Belarc took the profile, as printed in the report. */
  profileDate: string | null;
}

// Firmware leaves these where a real value belongs on unbranded and some
// OEM machines; they would only add noise or false duplicate matches.
const PLACEHOLDER =
  /^(to be filled by o\.?e\.?m\.?|default string|system (serial number|product name|manufacturer|version)|not (specified|applicable|available)|none|n\/?a|unknown|o\.?e\.?m\.?|0+|x+|1234567890?|0123456789abcdef|no asset tag|chassis serial number|invalid|empty|base board serial number)$/i;

function real(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text && !PLACEHOLDER.test(text) ? text : null;
}

function fieldValue(parsed: ParsedSpecs, section: string, key: string): string | null {
  return real(parsed.sections[section]?.fields.find((f) => f.key === key)?.value);
}

function sectionFields(parsed: ParsedSpecs, section: string) {
  return parsed.sections[section]?.fields ?? [];
}

const MANUFACTURERS: [RegExp, string][] = [
  [/^ASUSTeK COMPUTER INC\.?|^ASUSTeK\b|^ASUS\b/i, 'ASUS'],
  [/^LENOVO\b/i, 'Lenovo'],
  [/^Dell( Inc\.?)?(?=\s|$)/i, 'Dell'],
  [/^(Hewlett[- ]Packard|HP)( Development Company,? L\.?P\.?)?(?=\s|$)/i, 'HP'],
  [/^Acer( Inc\.?)?(?=\s|$)/i, 'Acer'],
  [/^Micro-Star International Co\.?,? Ltd\.?|^MSI(?=\s|$)/i, 'MSI'],
  [/^Gigabyte Technology Co\.?,? Ltd\.?|^GIGABYTE(?=\s|$)/i, 'Gigabyte'],
  [/^ASRock(?=\s|$)/i, 'ASRock'],
  [/^Microsoft Corporation(?=\s|$)/i, 'Microsoft'],
  [/^Apple Inc\.?(?=\s|$)/i, 'Apple'],
  [/^Samsung Electronics Co\.?,? Ltd\.?|^SAMSUNG(?=\s|$)/i, 'Samsung'],
  [/^Dynabook Inc\.?(?=\s|$)/i, 'Dynabook'],
  [/^TOSHIBA(?=\s|$)/i, 'Toshiba'],
  [/^FUJITSU( CLIENT COMPUTING LIMITED| LIMITED)?(?=\s|$)/i, 'Fujitsu'],
  [/^HUAWEI(?=\s|$)/i, 'Huawei'],
  [/^Intel( Corporation)?(?=\s|$)/i, 'Intel'],
  [/^Panasonic( Corporation)?(?=\s|$)/i, 'Panasonic'],
  [/^VMware,? Inc\.?(?=\s|$)/i, 'VMware'],
];

// Phrases generic firmware uses for "unknown" inside a longer model string.
const PLACEHOLDER_PHRASES = /to be filled by o\.?e\.?m\.?|system manufacturer|system product name|system version|default string/gi;

/** "ASUSTeK COMPUTER INC. ROG Strix G513IC_G513IC 1.0" → { brand: "ASUS", model: "ROG Strix G513IC_G513IC" } */
export function splitMaker(raw: string | null): { brand: string | null; model: string | null } {
  const text = raw?.replace(PLACEHOLDER_PHRASES, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { brand: null, model: null };
  let brand: string | null = null;
  let rest = text;
  for (const [pattern, name] of MANUFACTURERS) {
    const match = pattern.exec(text);
    if (match) {
      brand = name;
      rest = text.slice(match[0].length).trim();
      break;
    }
  }
  if (!brand) {
    const [first, ...others] = text.split(' ');
    brand = first;
    rest = others.join(' ');
  }
  // "HP HP ProBook 440 G8" — the product name repeats the maker
  rest = rest.replace(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
  // Trailing SMBIOS version, e.g. "… 1.0"
  rest = rest.replace(/\s+\d+\.\d+$/, '').trim();
  return { brand, model: real(rest) };
}

/** "Carter (in WORKGROUP)" → "Carter" */
function computerNameOf(raw: string | undefined): string | null {
  return real(raw?.replace(/\s*\(in\s+[^)]*\)\s*$/i, ''));
}

/** "Windows 11 Pro (x64) Version 25H2 (build 26200.8655)" → OS + version */
function splitOs(raw: string | null): { operatingSystem: string | null; osVersion: string | null } {
  if (!raw) return { operatingSystem: null, osVersion: null };
  const version = /^(.*?)\s+Version\s+(.+)$/i.exec(raw);
  if (version) return { operatingSystem: version[1].trim(), osVersion: version[2].trim() };
  const build = /^(.*?)\s*\((build [\d.]+)\)\s*$/i.exec(raw);
  if (build) return { operatingSystem: build[1].trim(), osVersion: build[2] };
  return { operatingSystem: raw, osVersion: null };
}

/**
 * Belarc prints dates in the PC's own format — "7/1/2025 6:48:01 AM" on a US
 * locale. Month/day order is taken as US unless the first number can only be
 * a day. Returns YYYY-MM-DD, or null when the text is not a usable date.
 */
export function belarcDate(raw: string | null): string | null {
  const m = raw ? /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/.exec(raw.trim()) : null;
  if (!m) return null;
  let [year, month, day] = [0, 0, 0];
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[1].length === 4) [year, month, day] = [a, b, c];
  else {
    year = m[3].length <= 2 ? 2000 + c : c;
    [month, day] = a > 12 ? [b, a] : [a, b];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1990) return null;
  return date.toISOString().slice(0, 10);
}

/** "2.90 gigahertz AMD Ryzen 7 4800H" → "AMD Ryzen 7 4800H @ 2.90 GHz" */
function processorName(raw: string | null): string | null {
  const m = raw ? /^([\d.]+)\s*(gigahertz|megahertz)\s+(.+)$/i.exec(raw) : null;
  if (!m) return raw;
  if (/\d\s*[gm]hz/i.test(m[3])) return m[3];
  return `${m[3]} @ ${m[1]} ${/^g/i.test(m[2]) ? 'GHz' : 'MHz'}`;
}

/** "16 GB", "8192 Megabytes", "1.02 TB" → size in GB */
function sizeInGb(raw: string | null): number | null {
  const m = raw ? /([\d.,]+)\s*(tb|terabytes?|gb|gigabytes?|mb|megabytes?)\b/i.exec(raw) : null;
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2][0].toLowerCase();
  return unit === 't' ? amount * 1000 : unit === 'm' ? amount / 1024 : amount;
}

function ramComponents(parsed: ParsedSpecs): BelarcComponent[] {
  const slots = new Map<string, { label: string; size?: string; serial?: string }>();
  for (const f of sectionFields(parsed, 'memory')) {
    const m = /^memory\.slot(\d+)\.(size|serial)$/.exec(f.key);
    if (!m) continue;
    const slot = slots.get(m[1]) ?? { label: f.label.replace(/\s+(size|serial)$/i, '') };
    if (m[2] === 'size') slot.size = f.value;
    else slot.serial = f.value;
    slots.set(m[1], slot);
  }
  const rows = [...slots.values()];
  // Several banks can report the same slot name; number them instead.
  const labelsUnique = new Set(rows.map((r) => r.label.toLowerCase())).size === rows.length;
  return rows.flatMap((row, i) => {
    const gb = sizeInGb(row.size ?? null);
    if (gb === null) return [];
    return [{
      type: 'ram' as const,
      slotOrBay: labelsUnique && real(row.label) ? row.label : `Slot ${i + 1}`,
      serialNumber: real(row.serial) ?? undefined,
      capacity: String(Math.round(gb * 10) / 10),
    }];
  });
}

const DRIVE_BRANDS: [RegExp, string][] = [
  [/^(WDC|WD|Western Digital)\b/i, 'Western Digital'],
  [/^Samsung\b/i, 'Samsung'],
  [/^Kingston\b/i, 'Kingston'],
  [/^Intel\b/i, 'Intel'],
  [/^(Crucial|CT\d)/i, 'Crucial'],
  [/^(Seagate|ST\d)/i, 'Seagate'],
  [/^KIOXIA\b/i, 'Kioxia'],
  [/^TOSHIBA\b/i, 'Toshiba'],
  [/^SanDisk\b/i, 'SanDisk'],
  [/^Micron\b/i, 'Micron'],
  [/^(SK ?hynix|HFS|HFM)/i, 'SK hynix'],
  [/^ADATA\b/i, 'ADATA'],
  [/^Lexar\b/i, 'Lexar'],
  [/^(Team|T-FORCE)\b/i, 'Team'],
  [/^(HGST|Hitachi)\b/i, 'HGST'],
  [/^Transcend\b/i, 'Transcend'],
  [/^(LITEON|LITE-ON)\b/i, 'Lite-On'],
  [/^PNY\b/i, 'PNY'],
  [/^Patriot\b/i, 'Patriot'],
  [/^SPCC\b/i, 'Silicon Power'],
  [/^Netac\b/i, 'Netac'],
  [/^Apacer\b/i, 'Apacer'],
  [/^Phison\b/i, 'Phison'],
  [/^BIWIN\b/i, 'BIWIN'],
  [/^HP\b/i, 'HP'],
];

function storageKindOf(type: string | null): string | undefined {
  if (!type) return undefined;
  if (/nvme/i.test(type)) return 'nvme';
  if (/ssd|solid/i.test(type)) return 'ssd';
  if (/hdd|hard|rotat/i.test(type)) return 'hdd';
  return type.toLowerCase();
}

function storageComponents(parsed: ParsedSpecs): BelarcComponent[] {
  const drives = new Map<string, Record<string, string>>();
  for (const f of sectionFields(parsed, 'localStorage')) {
    const m = /^localStorage\.drive(\d+)\.(model|size|type|serial)$/.exec(f.key);
    if (!m) continue;
    const drive = drives.get(m[1]) ?? {};
    drive[m[2]] = f.value;
    drives.set(m[1], drive);
  }
  return [...drives.values()].flatMap((drive) => {
    const gb = sizeInGb(drive.size ?? null);
    const model = real(drive.model);
    if (gb === null && !model) return [];
    const type = real(drive.type);
    return [{
      type: 'storage' as const,
      slotOrBay: type ?? undefined,
      brand: model ? DRIVE_BRANDS.find(([pattern]) => pattern.test(model))?.[1] : undefined,
      model: model ?? undefined,
      serialNumber: real(drive.serial) ?? undefined,
      capacity: gb === null ? undefined : String(Math.max(1, Math.round(gb))),
      storageKind: storageKindOf(type),
    }];
  });
}

// Adapters that are not the machine's own network card.
const VIRTUAL_ADAPTER =
  /virtual|bluetooth|wi-?fi direct|vpn|zerotier|tap-|\btun\b|tunnel|loopback|miniport|npcap|teredo|isatap|hyper-v|vmware|virtualbox|vbox|docker|wsl|tailscale|hamachi|fortinet|anyconnect|pangp|wireguard|kernel debug|rndis|remote ndis|cellular|mobile broadband|wwan/i;
const WIRELESS_ADAPTER = /wireless|wi-?fi|wlan|802\.11/i;

/** The built-in wired card's MAC, else the Wi-Fi card's. */
function primaryMac(parsed: ParsedSpecs): string | null {
  const adapters = new Map<string, { name: string; mac?: string }>();
  for (const f of sectionFields(parsed, 'communications')) {
    const m = /^communications\.adapter(\d+)\.(name|mac)$/.exec(f.key);
    if (!m) continue;
    const adapter = adapters.get(m[1]) ?? { name: '' };
    if (m[2] === 'name') adapter.name = f.value;
    else adapter.mac = f.value;
    adapters.set(m[1], adapter);
  }
  const physical = [...adapters.values()].filter((a) => {
    const mac = a.mac?.replace(/[^0-9a-f]/gi, '') ?? '';
    return mac.length === 12 && !/^0+$/.test(mac) && !VIRTUAL_ADAPTER.test(a.name);
  });
  const chosen = physical.find((a) => !WIRELESS_ADAPTER.test(a.name)) ?? physical[0];
  if (!chosen?.mac) return null;
  const hex = chosen.mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

function deviceTypeOf(parsed: ParsedSpecs): 'computer' | 'laptop' {
  const enclosure = fieldValue(parsed, 'systemModel', 'systemModel.enclosure_type');
  if (enclosure) {
    return /notebook|laptop|portable|hand ?held|tablet|convertible|detachable/i.test(enclosure) ? 'laptop' : 'computer';
  }
  // No enclosure line: a built-in battery means a laptop.
  return sectionFields(parsed, 'mainBoard').some((f) => /^mainBoard\.battery\d+$/.test(f.key)) ? 'laptop' : 'computer';
}

export function belarcToInventory(parsed: ParsedSpecs): BelarcFill {
  const { brand, model } = splitMaker(fieldValue(parsed, 'systemModel', 'systemModel.model'));
  const board = splitMaker(fieldValue(parsed, 'mainBoard', 'mainBoard.board'));
  const computerName = computerNameOf(parsed.meta.computerName);
  const os = splitOs(fieldValue(parsed, 'operatingSystem', 'operatingSystem.description'));
  return {
    name: [brand, model].filter(Boolean).join(' ') || computerName,
    computerName,
    serialNumber:
      fieldValue(parsed, 'systemModel', 'systemModel.system_serial_number') ??
      fieldValue(parsed, 'systemModel', 'systemModel.chassis_serial_number'),
    macAddress: primaryMac(parsed),
    deviceType: deviceTypeOf(parsed),
    brand,
    model,
    processor: processorName(fieldValue(parsed, 'processor', 'processor.name')),
    motherboard: [board.brand, board.model].filter(Boolean).join(' ') || null,
    ...os,
    osInstallDate: belarcDate(fieldValue(parsed, 'operatingSystem', 'operatingSystem.installed')),
    components: [...ramComponents(parsed), ...storageComponents(parsed)],
    profileDate: real(parsed.meta.profileDate),
  };
}
