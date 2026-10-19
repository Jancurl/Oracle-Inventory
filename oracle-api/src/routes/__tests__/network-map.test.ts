import { describe, expect, it } from "vitest";
import { resolvePath, wouldCycle, ALLOWED_PARENTS, type TreeNode } from "../network-map";

// The Cubao layout from "network sample.pdf".
const nodes = new Map<string, TreeNode>(
  [
    { id: "converge", type: "isp", parentId: null },
    { id: "globe", type: "isp", parentId: null },
    { id: "firewall", type: "firewall", parentId: null },
    { id: "managed", type: "managed_switch", parentId: "firewall" },
    { id: "bay1", type: "switch", parentId: "managed" },
    { id: "tsd", type: "switch", parentId: "managed" },
    { id: "desk-hub", type: "switch", parentId: "bay1" },
    { id: "orphan", type: "switch", parentId: null },
  ].map((n) => [n.id, n as TreeNode]),
);

describe("resolvePath", () => {
  it("reads managed switch and firewall off the tree for a bay switch", () => {
    expect(resolvePath("bay1", nodes)).toEqual({ switchId: "bay1", managedSwitchId: "managed", firewallId: "firewall" });
  });

  it("reports the switch the computer is plugged into, not one further up", () => {
    expect(resolvePath("desk-hub", nodes)).toEqual({ switchId: "desk-hub", managedSwitchId: "managed", firewallId: "firewall" });
  });

  it("handles a computer plugged straight into the managed switch", () => {
    expect(resolvePath("managed", nodes)).toEqual({ switchId: null, managedSwitchId: "managed", firewallId: "firewall" });
  });

  it("leaves gaps when a switch has no uplink recorded", () => {
    expect(resolvePath("orphan", nodes)).toEqual({ switchId: "orphan", managedSwitchId: null, firewallId: null });
  });

  it("survives a corrupt cycle", () => {
    const cyclic = new Map<string, TreeNode>([
      ["a", { id: "a", type: "switch", parentId: "b" }],
      ["b", { id: "b", type: "switch", parentId: "a" }],
    ]);
    expect(resolvePath("a", cyclic)).toEqual({ switchId: "a", managedSwitchId: null, firewallId: null });
  });
});

describe("wouldCycle", () => {
  it("rejects making a device's own downstream switch its parent", () => {
    expect(wouldCycle("bay1", "desk-hub", nodes)).toBe(true);
    expect(wouldCycle("bay1", "bay1", nodes)).toBe(true);
  });
  it("allows a sibling or upstream parent", () => {
    expect(wouldCycle("bay1", "tsd", nodes)).toBe(false);
    expect(wouldCycle("desk-hub", "managed", nodes)).toBe(false);
  });
});

describe("ALLOWED_PARENTS", () => {
  it("keeps ISPs and firewalls as roots", () => {
    expect(ALLOWED_PARENTS.isp).toEqual([]);
    expect(ALLOWED_PARENTS.firewall).toEqual([]);
  });
});
