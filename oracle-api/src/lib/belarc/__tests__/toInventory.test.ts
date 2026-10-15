import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBelarc } from '../parseBelarc';
import { belarcDate, belarcToInventory, splitMaker } from '../toInventory';
import type { ParsedSpecs, SpecField } from '../types';

const fixture = readFileSync(join(__dirname, 'fixtures', 'carter.html'), 'utf-8');

function specsWith(sections: Record<string, [string, string, string?][]>, computerName?: string): ParsedSpecs {
  const out: ParsedSpecs['sections'] = {};
  for (const [key, rows] of Object.entries(sections)) {
    out[key] = {
      key,
      name: key,
      fields: rows.map(([k, value, label = '']): SpecField => ({ key: k, label, value, tier: 'hard' })),
    };
  }
  return { version: 1, sections: out, meta: { computerName, missingSections: [] } };
}

describe('belarcToInventory — sample report', () => {
  const fill = belarcToInventory(parseBelarc(fixture));

  it('reads the machine identity', () => {
    expect(fill.computerName).toBe('Carter');
    expect(fill.brand).toBe('ASUS');
    expect(fill.model).toBe('ROG Strix G513IC_G513IC');
    expect(fill.name).toBe('ASUS ROG Strix G513IC_G513IC');
    expect(fill.serialNumber).toMatch(/016$/);
    expect(fill.deviceType).toBe('laptop');
  });

  it('reads the specs', () => {
    expect(fill.processor).toBe('AMD Ryzen 7 4800H with Radeon Graphics @ 2.90 GHz');
    expect(fill.motherboard).toBe('ASUS G513IC');
    expect(fill.operatingSystem).toBe('Windows 11 Home Single Language (x64)');
    expect(fill.osVersion).toBe('25H2 (build 26200.8655)');
    expect(fill.osInstallDate).toBe('2025-07-01');
  });

  it('picks the wired network card, not Bluetooth or virtual adapters', () => {
    expect(fill.macAddress).toBe('50:EB:F6:4A:7C:0C');
  });

  it('lists RAM sticks and internal drives, not USB drives', () => {
    const ram = fill.components.filter((c) => c.type === 'ram');
    const storage = fill.components.filter((c) => c.type === 'storage');
    expect(ram).toHaveLength(2);
    expect(ram.map((r) => r.capacity)).toEqual(['16', '16']);
    // Both sticks report the same slot name, so they are numbered instead
    expect(ram.map((r) => r.slotOrBay)).toEqual(['Slot 1', 'Slot 2']);
    expect(ram.every((r) => r.serialNumber)).toBe(true);
    expect(storage).toEqual([
      expect.objectContaining({ brand: 'Intel', model: 'INTEL SSDPEKNU512GZ', capacity: '512', storageKind: 'nvme', slotOrBay: 'NVMe' }),
    ]);
  });

  it('never carries anything from outside the hardware sections', () => {
    const text = JSON.stringify(fill);
    expect(text).not.toMatch(/administrator|product key|license/i);
  });
});

describe('belarcToInventory — other machines', () => {
  it('handles a desktop with a placeholder serial and only Wi-Fi', () => {
    const fill = belarcToInventory(specsWith({
      systemModel: [
        ['systemModel.model', 'To Be Filled By O.E.M. To Be Filled By O.E.M.'],
        ['systemModel.system_serial_number', 'To Be Filled By O.E.M.'],
        ['systemModel.enclosure_type', 'Desktop'],
      ],
      memory: [['memory.slot0.size', '8192 Megabytes', 'DIMM1 size'], ['memory.slot0.serial', '00000000', 'DIMM1 serial']],
      communications: [
        ['communications.adapter0.name', 'Intel(R) Wi-Fi 6 AX201 160MHz'],
        ['communications.adapter0.mac', 'a4-b1-c1-d2-e3-f4'],
      ],
    }, 'DESKTOP-7Q2 (in CORP)'));
    expect(fill.brand).toBeNull();
    expect(fill.model).toBeNull();
    expect(fill.serialNumber).toBeNull();
    expect(fill.name).toBe('DESKTOP-7Q2');
    expect(fill.deviceType).toBe('computer');
    expect(fill.components).toEqual([{ type: 'ram', slotOrBay: 'DIMM1', serialNumber: undefined, capacity: '8' }]);
    expect(fill.macAddress).toBe('A4:B1:C1:D2:E3:F4');
  });

  it('treats a machine with a battery but no enclosure line as a laptop', () => {
    const fill = belarcToInventory(specsWith({ mainBoard: [['mainBoard.battery0', 'Battery | 90%']] }));
    expect(fill.deviceType).toBe('laptop');
  });
});

describe('splitMaker', () => {
  it.each([
    ['Dell Inc. Latitude 5520', 'Dell', 'Latitude 5520'],
    ['HP HP ProBook 440 G8 Notebook PC', 'HP', 'ProBook 440 G8 Notebook PC'],
    ['Hewlett-Packard HP Compaq 8200 Elite SFF PC', 'HP', 'Compaq 8200 Elite SFF PC'],
    ['LENOVO 20W0S0XX00', 'Lenovo', '20W0S0XX00'],
    ['Acer Aspire A515-56 V1.11', 'Acer', 'Aspire A515-56 V1.11'],
    ['Micro-Star International Co., Ltd. MS-7C95 1.0', 'MSI', 'MS-7C95'],
    ['Gateway NE56R', 'Gateway', 'NE56R'],
  ])('%s', (raw, brand, model) => {
    expect(splitMaker(raw)).toEqual({ brand, model });
  });
});

describe('belarcDate', () => {
  it.each([
    ['7/1/2025 6:48:01 AM', '2025-07-01'],
    ['25/12/2023 10:00:00', '2023-12-25'],
    ['2024-03-09 08:00', '2024-03-09'],
    ['2/30/2024', null],
    ['not a date', null],
  ])('%s', (raw, expected) => {
    expect(belarcDate(raw)).toBe(expected);
  });
});
