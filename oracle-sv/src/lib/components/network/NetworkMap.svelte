<script module lang="ts">
  export type MapStats = { computers: number; wired: number; wifi: number; unmapped: number };
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api';
  import { onChange } from '$lib/ws';
  import { authStore } from '$lib/stores/auth.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import SearchInput from '$lib/components/SearchInput.svelte';
  import TableStates from '$lib/components/TableStates.svelte';

  type NodeType = 'isp' | 'firewall' | 'managed_switch' | 'switch';
  type NetNode = {
    id: string; branchId: string; branchName: string; type: NodeType; name: string;
    parentId: string | null; parentPort: string | null; portCount: number | null;
    location: string | null; notes: string | null; computers: number;
  };
  type Connection = {
    type: 'wired' | 'wifi'; switchPort: string | null; ispId: string | null; notes: string | null; updatedAt: string;
    pluggedIntoId: string | null; switchId: string | null; managedSwitchId: string | null; firewallId: string | null;
  };
  type Computer = {
    id: string; name: string; assetTag: string | null; computerName: string | null; category: string | null;
    branchId: string | null; branchName: string | null;
    employee: { id: string; name: string; position: string | null; department: string | null } | null;
    connection: Connection | null;
  };

  let { onstats }: { onstats?: (stats: MapStats) => void } = $props();

  const TYPE_LABEL: Record<NodeType, string> = { isp: 'ISP', firewall: 'Firewall', managed_switch: 'Managed switch', switch: 'Switch' };
  // Mirrors ALLOWED_PARENTS in oracle-api/src/routes/network-map.ts.
  const ALLOWED_PARENTS: Record<NodeType, NodeType[]> = { isp: [], firewall: [], managed_switch: ['firewall'], switch: ['managed_switch', 'switch', 'firewall'] };
  const COLUMNS: { type: NodeType; title: string; add: string }[] = [
    { type: 'isp', title: 'ISP', add: 'Add ISP' },
    { type: 'firewall', title: 'Firewall', add: 'Add firewall' },
    { type: 'managed_switch', title: 'Managed switch', add: 'Add managed switch' },
    { type: 'switch', title: 'Switches', add: 'Add switch' },
  ];

  const isSuperAdmin = $derived(authStore.user?.role === 'super_admin');

  let loading = $state(true);
  let error = $state('');
  let nodes = $state<NetNode[]>([]);
  let computers = $state<Computer[]>([]);
  let branches = $state<{ id: string; name: string }[]>([]);
  let branchFilter = $state('');
  let search = $state('');
  let filter = $state<'all' | 'wired' | 'wifi' | 'unmapped'>('all');
  let focusNodeId = $state<string | null>(null);

  const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));
  const nodeName = (id: string | null | undefined) => (id ? nodeById.get(id)?.name ?? 'Removed device' : null);

  const stats = $derived<MapStats>({
    computers: computers.length,
    wired: computers.filter((c) => c.connection?.type === 'wired').length,
    wifi: computers.filter((c) => c.connection?.type === 'wifi').length,
    unmapped: computers.filter((c) => !c.connection).length,
  });
  $effect(() => { onstats?.(stats); });

  // A node "contains" a computer when it's anywhere on that computer's path.
  function onPath(c: Computer, nodeId: string) {
    const k = c.connection;
    return Boolean(k && [k.pluggedIntoId, k.switchId, k.managedSwitchId, k.firewallId, k.ispId].includes(nodeId));
  }

  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return computers
      .filter((c) => {
        if (filter === 'wired' && c.connection?.type !== 'wired') return false;
        if (filter === 'wifi' && c.connection?.type !== 'wifi') return false;
        if (filter === 'unmapped' && c.connection) return false;
        if (focusNodeId && !onPath(c, focusNodeId)) return false;
        if (!q) return true;
        const k = c.connection;
        return [c.name, c.assetTag, c.computerName, c.employee?.name, c.employee?.department, k?.switchPort,
          nodeName(k?.pluggedIntoId), nodeName(k?.managedSwitchId), nodeName(k?.firewallId), nodeName(k?.ispId)]
          .some((v) => v?.toLowerCase().includes(q));
      })
      .sort((a, b) => (a.employee?.name ?? `~${a.name}`).localeCompare(b.employee?.name ?? `~${b.name}`));
  });

  async function refresh() {
    loading = true; error = '';
    try {
      const qs = branchFilter ? `?branchId=${encodeURIComponent(branchFilter)}` : '';
      const map = await api.get<{ nodes: NetNode[]; computers: Computer[] }>(`/api/network/map${qs}`);
      nodes = map.nodes; computers = map.computers;
      if (focusNodeId && !nodeById.has(focusNodeId)) focusNodeId = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function uplinkText(n: NetNode) {
    if (!n.parentId) return ALLOWED_PARENTS[n.type].length ? 'No uplink set' : null;
    return n.parentPort ? `${nodeName(n.parentId)} · port ${n.parentPort}` : nodeName(n.parentId);
  }

  // ── Node modal ────────────────────────────────────────────────────────────
  let nodeOpen = $state(false);
  let nodeBusy = $state(false);
  let nodeError = $state('');
  let editingNode = $state<NetNode | null>(null);
  let nf = $state({ type: 'switch' as NodeType, name: '', branchId: '', parentId: '', parentPort: '', portCount: '', location: '', notes: '' });

  const nodeBranch = $derived(editingNode?.branchId ?? nf.branchId);
  const parentChoices = $derived(nodes.filter((n) => n.id !== editingNode?.id && ALLOWED_PARENTS[nf.type].includes(n.type) && (!nodeBranch || n.branchId === nodeBranch)));

  function openNode(type: NodeType, node: NetNode | null = null) {
    nodeError = ''; editingNode = node;
    if (node) {
      nf = { type: node.type, name: node.name, branchId: node.branchId, parentId: node.parentId ?? '', parentPort: node.parentPort ?? '', portCount: node.portCount ? String(node.portCount) : '', location: node.location ?? '', notes: node.notes ?? '' };
    } else {
      const branchId = branchFilter || branches[0]?.id || '';
      // Suggest the obvious uplink: a managed switch → the firewall, a switch → the managed switch.
      const preferred: NodeType | null = type === 'managed_switch' ? 'firewall' : type === 'switch' ? 'managed_switch' : null;
      const candidates = nodes.filter((n) => n.type === preferred && (!branchId || n.branchId === branchId));
      nf = { type, name: '', branchId, parentId: candidates.length === 1 ? candidates[0].id : '', parentPort: '', portCount: type === 'switch' || type === 'managed_switch' ? '24' : '', location: '', notes: '' };
    }
    nodeOpen = true;
  }

  async function saveNode() {
    nodeError = '';
    if (!nf.name.trim()) { nodeError = 'Give it a name, e.g. "Bay 1 Switch".'; return; }
    nodeBusy = true;
    try {
      const body = {
        type: nf.type, name: nf.name.trim(),
        parentId: ALLOWED_PARENTS[nf.type].length ? nf.parentId || null : null,
        parentPort: nf.parentPort.trim() || null,
        portCount: nf.type === 'isp' || !nf.portCount ? null : Number(nf.portCount),
        location: nf.location.trim() || null, notes: nf.notes.trim() || null,
      };
      if (editingNode) await api.put(`/api/network/map/nodes/${editingNode.id}`, body);
      else await api.post('/api/network/map/nodes', { ...body, branchId: nf.branchId || undefined });
      nodeOpen = false;
      await refresh();
    } catch (e) {
      nodeError = (e as Error).message;
    } finally {
      nodeBusy = false;
    }
  }

  async function deleteNode() {
    if (!editingNode || !confirm(`Delete ${editingNode.name} from the network map?`)) return;
    nodeBusy = true;
    try {
      await api.delete(`/api/network/map/nodes/${editingNode.id}`);
      nodeOpen = false;
      await refresh();
    } catch (e) {
      nodeError = (e as Error).message;
    } finally {
      nodeBusy = false;
    }
  }

  // ── Connection modal ──────────────────────────────────────────────────────
  let connOpen = $state(false);
  let connBusy = $state(false);
  let connError = $state('');
  let target = $state<Computer | null>(null);
  let cf = $state({ type: 'wired' as 'wired' | 'wifi', switchId: '', switchPort: '', ispId: '', notes: '' });

  const inTargetBranch = (n: NetNode) => !target?.branchId || n.branchId === target.branchId;
  const switchChoices = $derived(nodes.filter((n) => (n.type === 'switch' || n.type === 'managed_switch') && inTargetBranch(n)));
  const ispChoices = $derived(nodes.filter((n) => n.type === 'isp' && inTargetBranch(n)));
  const chosenSwitch = $derived(cf.switchId ? nodeById.get(cf.switchId) ?? null : null);
  // Managed switch + firewall shown read-only — they come from the switch's uplinks.
  const derivedPath = $derived.by(() => {
    let managed: string | null = null, firewall: string | null = null;
    const seen = new Set<string>();
    for (let n = chosenSwitch; n && !seen.has(n.id); n = n.parentId ? nodeById.get(n.parentId) ?? null : null) {
      seen.add(n.id);
      if (n.type === 'managed_switch' && !managed) managed = n.name;
      if (n.type === 'firewall' && !firewall) firewall = n.name;
    }
    return { managed, firewall };
  });
  const portUsers = $derived.by(() => {
    const byPort = new Map<string, Computer[]>();
    for (const c of computers) {
      const k = c.connection;
      if (k?.type !== 'wired' || k.pluggedIntoId !== cf.switchId || c.id === target?.id || !k.switchPort) continue;
      byPort.set(k.switchPort, [...(byPort.get(k.switchPort) ?? []), c]);
    }
    return byPort;
  });
  const sharedWith = $derived(cf.type === 'wired' && cf.switchPort ? portUsers.get(cf.switchPort.trim()) ?? [] : []);
  const who = (c: Computer) => c.employee?.name ?? c.name;
  // Choices are limited to the computer's branch; say so when that's why the list is empty.
  function missingHint(what: 'switches' | 'ISPs') {
    const anyElsewhere = nodes.some((n) => (what === 'ISPs' ? n.type === 'isp' : n.type === 'switch' || n.type === 'managed_switch'));
    return anyElsewhere && target?.branchName
      ? `No ${what} in ${target.branchName} — this computer belongs to ${target.branchName}. Add ${what} for that branch in the map.`
      : `No ${what} yet — add them in the map first.`;
  }

  function openConnection(c: Computer) {
    target = c; connError = '';
    const k = c.connection;
    const isps = nodes.filter((n) => n.type === 'isp' && (!c.branchId || n.branchId === c.branchId));
    cf = {
      type: k?.type ?? 'wired',
      switchId: k?.pluggedIntoId ?? (focusNodeId && ['switch', 'managed_switch'].includes(nodeById.get(focusNodeId)?.type ?? '') ? focusNodeId : ''),
      switchPort: k?.switchPort ?? '',
      ispId: k?.ispId ?? (isps.length === 1 ? isps[0].id : ''),
      notes: k?.notes ?? '',
    };
    connOpen = true;
  }

  async function saveConnection() {
    if (!target) return;
    connError = '';
    if (cf.type === 'wired' && !cf.switchId) { connError = 'Pick the switch it is plugged into.'; return; }
    if (cf.type === 'wired' && !cf.switchPort.trim()) { connError = 'Pick the switch port.'; return; }
    if (!cf.ispId) { connError = 'Pick the ISP.'; return; }
    connBusy = true;
    try {
      await api.put(`/api/network/map/computers/${target.id}`, cf.type === 'wired'
        ? { type: 'wired', switchId: cf.switchId, switchPort: cf.switchPort.trim(), ispId: cf.ispId, notes: cf.notes.trim() || null }
        : { type: 'wifi', ispId: cf.ispId, notes: cf.notes.trim() || null });
      connOpen = false;
      await refresh();
    } catch (e) {
      connError = (e as Error).message;
    } finally {
      connBusy = false;
    }
  }

  async function clearConnection() {
    if (!target || !confirm(`Clear the network details for ${target.name}?`)) return;
    connBusy = true;
    try {
      await api.delete(`/api/network/map/computers/${target.id}`);
      connOpen = false;
      await refresh();
    } catch (e) {
      connError = (e as Error).message;
    } finally {
      connBusy = false;
    }
  }

  onMount(async () => {
    if (isSuperAdmin) branches = await api.get<{ id: string; name: string }[]>('/api/branches').catch(() => []);
    await refresh();
  });
  onDestroy(onChange(['NetworkNode', 'DeviceConnection', 'Asset', 'AssetAssignment'], () => refresh()));
</script>

<div class="map-wrap">
  {#if isSuperAdmin && branches.length > 1}
    <div class="toolbar">
      <select class="field-input sel" bind:value={branchFilter} onchange={() => refresh()} aria-label="Branch">
        <option value="">All branches</option>
        {#each branches as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
      </select>
    </div>
  {/if}

  {#if loading && nodes.length === 0 && computers.length === 0}
    <div class="card"><TableStates loading loadingText="Loading network map…" /></div>
  {:else if error && nodes.length === 0 && computers.length === 0}
    <div class="card"><TableStates {error} onRetry={refresh} /></div>
  {:else}
    {#if error}<div class="form-error">{error}</div>{/if}

    <!-- Laid out like the floor sketch: ISP → firewall → managed switch → switches. -->
    <div class="card diagram">
      {#each COLUMNS as col, i (col.type)}
        <div class="col">
          <div class="col-title">{col.title}</div>
          {#each nodes.filter((n) => n.type === col.type) as n (n.id)}
            <div class="node node-{n.type}" class:focused={focusNodeId === n.id}>
              <button type="button" class="node-main" onclick={() => (focusNodeId = focusNodeId === n.id ? null : n.id)} title="Show the computers that go through {n.name}">
                <span class="node-name">{n.name}</span>
                {#if uplinkText(n)}<span class="node-sub" class:warn={!n.parentId}>↑ {uplinkText(n)}</span>{/if}
                {#if n.portCount || n.location}<span class="node-sub">{[n.portCount ? `${n.portCount} ports` : '', n.location ?? ''].filter(Boolean).join(' · ')}</span>{/if}
                {#if isSuperAdmin && !branchFilter && branches.length > 1}<span class="node-sub">{n.branchName}</span>{/if}
                {#if n.computers > 0}<span class="node-count">{n.computers} computer{n.computers === 1 ? '' : 's'}</span>{/if}
              </button>
              <button type="button" class="node-edit" onclick={() => openNode(n.type, n)} aria-label="Edit {n.name}">Edit</button>
            </div>
          {/each}
          <button type="button" class="node-add" onclick={() => openNode(col.type)}>+ {col.add}</button>
        </div>
        {#if i < COLUMNS.length - 1}<div class="col-arrow" aria-hidden="true">→</div>{/if}
      {/each}
    </div>

    <div class="card">
      <div class="table-head">
        <div>
          <div class="table-title">Laptops & desktops</div>
          <div class="table-sub">
            {#if focusNodeId}
              Going through <strong>{nodeName(focusNodeId)}</strong>
              <button type="button" class="link-btn" onclick={() => (focusNodeId = null)}>Show all</button>
            {:else}
              Each employee computer and the port, switch, managed switch, firewall and ISP it uses.
            {/if}
          </div>
        </div>
        <div class="table-tools">
          <div class="seg" role="group" aria-label="Filter">
            <button type="button" class:active={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
            <button type="button" class:active={filter === 'wired'} onclick={() => (filter = 'wired')}>Wired</button>
            <button type="button" class:active={filter === 'wifi'} onclick={() => (filter = 'wifi')}>Wi-Fi</button>
            <button type="button" class:active={filter === 'unmapped'} onclick={() => (filter = 'unmapped')}>Not set</button>
          </div>
          <SearchInput bind:value={search} placeholder="Search employee, computer, switch…" />
        </div>
      </div>

      <TableStates empty={rows.length === 0} emptyTitle="No computers match"
        emptyMessage={computers.length === 0 ? 'No active laptops or desktops are recorded for this scope.' : 'Try a different search or filter.'} />
      {#if rows.length > 0}
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Employee</th><th>Computer</th><th>Connection</th><th>Port</th><th>Switch</th><th>Managed switch</th><th>Firewall</th><th>ISP</th><th></th></tr>
            </thead>
            <tbody>
              {#each rows as c (c.id)}
                {@const k = c.connection}
                <tr>
                  <td>
                    {#if c.employee}
                      {c.employee.name}
                      {#if c.employee.department || c.employee.position}<span class="td-sub">{[c.employee.department, c.employee.position].filter(Boolean).join(' · ')}</span>{/if}
                    {:else}<span class="muted">Unassigned</span>{/if}
                  </td>
                  <td>{c.name}<span class="td-sub">{[c.category, c.assetTag, c.computerName].filter(Boolean).join(' · ')}</span></td>
                  <td>
                    {#if !k}<span class="badge badge-none">Not set</span>
                    {:else if k.type === 'wired'}<span class="badge badge-wired">Wired</span>
                    {:else}<span class="badge badge-wifi">Wi-Fi</span>{/if}
                  </td>
                  <td>{#if k?.switchPort}<span class="port-pill">{k.switchPort}</span>{:else}<span class="muted">—</span>{/if}</td>
                  <td>{nodeName(k?.switchId) ?? '—'}</td>
                  <td>{nodeName(k?.managedSwitchId) ?? '—'}</td>
                  <td>{nodeName(k?.firewallId) ?? '—'}</td>
                  <td>{nodeName(k?.ispId) ?? '—'}</td>
                  <td class="actions"><button type="button" class="btn-ghost-sm" onclick={() => openConnection(c)}>{k ? 'Edit' : 'Set'}</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<Modal bind:open={nodeOpen} title={editingNode ? `Edit ${TYPE_LABEL[nf.type].toLowerCase()}` : `Add ${TYPE_LABEL[nf.type].toLowerCase()}`} maxWidth="520px">
  <form id="net-node-form" class="form" onsubmit={(e) => { e.preventDefault(); saveNode(); }}>
    {#if nodeError}<div class="form-error">{nodeError}</div>{/if}
    <div class="grid2">
      <div class="field">
        <label class="field-label" for="nn-type">Type</label>
        <select id="nn-type" class="field-input" bind:value={nf.type} onchange={() => (nf.parentId = '')}>
          {#each Object.entries(TYPE_LABEL) as [value, label]}<option {value}>{label}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="nn-name">Name</label>
        <input id="nn-name" class="field-input" bind:value={nf.name}
          placeholder={nf.type === 'isp' ? 'e.g. Converge' : nf.type === 'firewall' ? 'e.g. Firewall' : nf.type === 'managed_switch' ? 'e.g. Managed Switch 24' : 'e.g. Bay 1 Switch'} />
      </div>
      {#if !editingNode && isSuperAdmin && branches.length > 1}
        <div class="field">
          <label class="field-label" for="nn-branch">Branch</label>
          <select id="nn-branch" class="field-input" bind:value={nf.branchId} onchange={() => (nf.parentId = '')}>
            {#each branches as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
          </select>
        </div>
      {/if}
      {#if nf.type !== 'isp'}
        <div class="field">
          <label class="field-label" for="nn-ports">Number of ports</label>
          <input id="nn-ports" class="field-input" type="number" min="1" max="512" bind:value={nf.portCount} placeholder="e.g. 24" />
        </div>
      {/if}
      {#if ALLOWED_PARENTS[nf.type].length}
        <div class="field">
          <label class="field-label" for="nn-parent">Connected to</label>
          <select id="nn-parent" class="field-input" bind:value={nf.parentId}>
            <option value="">— Not set —</option>
            {#each parentChoices as p (p.id)}<option value={p.id}>{p.name} ({TYPE_LABEL[p.type]})</option>{/each}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="nn-pport">On its port <span class="opt">(optional)</span></label>
          <input id="nn-pport" class="field-input" bind:value={nf.parentPort} placeholder="e.g. 7" disabled={!nf.parentId} />
        </div>
      {/if}
      <div class="field">
        <label class="field-label" for="nn-loc">Location <span class="opt">(optional)</span></label>
        <input id="nn-loc" class="field-input" bind:value={nf.location} placeholder="e.g. Bay 1, server rack" />
      </div>
    </div>
    <div class="field">
      <label class="field-label" for="nn-notes">Notes <span class="opt">(optional)</span></label>
      <input id="nn-notes" class="field-input" bind:value={nf.notes} placeholder={nf.type === 'isp' ? 'e.g. 300 Mbps fiber, account no. on file' : 'e.g. uplink on port 1'} />
    </div>
  </form>
  {#snippet footer()}
    {#if editingNode}<button type="button" class="btn-danger-ghost" onclick={deleteNode} disabled={nodeBusy}>Delete</button>{/if}
    <span class="spacer"></span>
    <button type="button" class="btn-ghost" onclick={() => (nodeOpen = false)}>Cancel</button>
    <button type="submit" form="net-node-form" class="btn-primary" disabled={nodeBusy}>{nodeBusy ? 'Saving…' : 'Save'}</button>
  {/snippet}
</Modal>

<Modal bind:open={connOpen} title="Network connection" maxWidth="560px">
  <form id="net-conn-form" class="form" onsubmit={(e) => { e.preventDefault(); saveConnection(); }}>
    {#if target}
      <p class="who"><strong>{target.name}</strong>{target.employee ? ` — ${target.employee.name}` : ''}</p>
    {/if}
    {#if connError}<div class="form-error">{connError}</div>{/if}

    <div class="seg seg-lg" role="radiogroup" aria-label="Connection type">
      <button type="button" role="radio" aria-checked={cf.type === 'wired'} class:active={cf.type === 'wired'} onclick={() => (cf.type = 'wired')}>Wired (LAN cable)</button>
      <button type="button" role="radio" aria-checked={cf.type === 'wifi'} class:active={cf.type === 'wifi'} onclick={() => (cf.type = 'wifi')}>Wi-Fi</button>
    </div>

    {#if cf.type === 'wired'}
      <div class="field">
        <label class="field-label" for="nc-switch">Switch</label>
        <select id="nc-switch" class="field-input" bind:value={cf.switchId} onchange={() => (cf.switchPort = '')}>
          <option value="">— Choose switch —</option>
          {#each switchChoices as s (s.id)}<option value={s.id}>{s.name}{s.type === 'managed_switch' ? ' (managed)' : ''}</option>{/each}
        </select>
        {#if switchChoices.length === 0}<span class="hint">{missingHint('switches')}</span>{/if}
      </div>

      {#if chosenSwitch}
        <div class="field">
          <span class="field-label">Port</span>
          {#if chosenSwitch.portCount}
            <div class="port-grid" role="group" aria-label="Ports on {chosenSwitch.name}">
              {#each Array.from({ length: chosenSwitch.portCount }, (_, i) => String(i + 1)) as p (p)}
                {@const users = portUsers.get(p)}
                <button type="button" class="port" class:taken={users} class:chosen={cf.switchPort === p} onclick={() => (cf.switchPort = p)}
                  title={users ? `In use: ${users.map(who).join(', ')}` : `Port ${p} — free`}>{p}</button>
              {/each}
            </div>
            <span class="hint">Grey ports are already in use (hover to see by whom).</span>
          {:else}
            <input class="field-input" bind:value={cf.switchPort} placeholder="e.g. 4" aria-label="Port" />
          {/if}
        </div>
        <div class="derived">
          <span>Managed switch: <strong>{derivedPath.managed ?? 'not linked'}</strong></span>
          <span>Firewall: <strong>{derivedPath.firewall ?? 'not linked'}</strong></span>
          {#if !derivedPath.managed || !derivedPath.firewall}<span class="hint">Set the switch's "Connected to" in the map to fill these in.</span>{/if}
        </div>
      {/if}
      {#if sharedWith.length}
        <div class="form-warn">Port {cf.switchPort} is also recorded for <strong>{sharedWith.map(who).join(', ')}</strong>. That's fine if they share it through a small hub; otherwise pick another port.</div>
      {/if}
    {/if}

    <div class="field">
      <label class="field-label" for="nc-isp">ISP</label>
      <select id="nc-isp" class="field-input" bind:value={cf.ispId}>
        <option value="">— Choose ISP —</option>
        {#each ispChoices as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
      </select>
      {#if ispChoices.length === 0}<span class="hint">{missingHint('ISPs')}</span>{/if}
    </div>
    <div class="field">
      <label class="field-label" for="nc-notes">Notes <span class="opt">(optional)</span></label>
      <input id="nc-notes" class="field-input" bind:value={cf.notes} placeholder="e.g. wall jack B-12" />
    </div>
  </form>
  {#snippet footer()}
    {#if target?.connection}<button type="button" class="btn-danger-ghost" onclick={clearConnection} disabled={connBusy}>Clear</button>{/if}
    <span class="spacer"></span>
    <button type="button" class="btn-ghost" onclick={() => (connOpen = false)}>Cancel</button>
    <button type="submit" form="net-conn-form" class="btn-primary" disabled={connBusy}>{connBusy ? 'Saving…' : 'Save'}</button>
  {/snippet}
</Modal>

<style>
  .map-wrap { display: flex; flex-direction: column; gap: 16px; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sel { width: auto; min-width: 200px; }
  .spacer { flex: 1; }

  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); overflow: hidden; }

  .diagram { display: flex; align-items: stretch; gap: 8px; padding: 16px; overflow-x: auto; }
  .col { display: flex; flex-direction: column; gap: 8px; min-width: 180px; flex: 1; }
  .col-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--mute); font-family: var(--font-sans); }
  .col-arrow { align-self: center; color: var(--hairline-strong); font-size: 18px; }

  .node { position: relative; border: 1px solid var(--hairline); border-left: 3px solid var(--hairline-strong); border-radius: var(--r-md); background: var(--canvas); transition: border-color 120ms ease, box-shadow 120ms ease; }
  .node:hover { box-shadow: 0 1px 4px rgb(0 0 0 / 0.06); }
  .node.focused { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }
  .node-isp { border-left-color: var(--grad-preview-from); }
  .node-firewall { border-left-color: var(--grad-ship-from); }
  .node-managed_switch { border-left-color: var(--link); }
  .node-switch { border-left-color: var(--grad-develop-to); }
  .node-main { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; padding: 10px 44px 10px 12px; background: none; border: none; cursor: pointer; font-family: var(--font-sans); }
  .node-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
  .node-sub { font-size: 11.5px; color: var(--mute); line-height: 1.35; }
  .node-sub.warn { color: var(--warning); }
  .node-count { align-self: flex-start; margin-top: 2px; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--canvas-soft-2); color: var(--body); }
  .node-edit { position: absolute; top: 8px; right: 8px; font-size: 11px; padding: 2px 6px; border-radius: var(--r-xs); border: 1px solid transparent; background: none; color: var(--mute); cursor: pointer; font-family: var(--font-sans); }
  .node-edit:hover { border-color: var(--hairline); color: var(--ink); }
  .node-add { padding: 9px 12px; border: 1px dashed var(--hairline-strong); border-radius: var(--r-md); background: none; color: var(--mute); font-size: 12.5px; cursor: pointer; text-align: left; font-family: var(--font-sans); }
  .node-add:hover { color: var(--ink); border-color: var(--ink); }

  .table-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding: 14px 16px; }
  .table-title { font-size: 14px; font-weight: 600; color: var(--ink); font-family: var(--font-sans); }
  .table-sub { font-size: 12.5px; color: var(--mute); margin-top: 2px; font-family: var(--font-sans); }
  .table-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .seg { display: inline-flex; border: 1px solid var(--hairline); border-radius: var(--r-md); overflow: hidden; }
  .seg button { padding: 6px 10px; font-size: 12.5px; border: none; background: var(--canvas); color: var(--mute); cursor: pointer; font-family: var(--font-sans); }
  .seg button + button { border-left: 1px solid var(--hairline); }
  .seg button.active { background: var(--ink); color: var(--on-primary); }
  .seg-lg { align-self: flex-start; }
  .seg-lg button { padding: 8px 14px; font-size: 13px; }

  .table-wrap { overflow: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 11px 14px; border-top: 1px solid var(--hairline); font-size: 13.5px; font-family: var(--font-sans); }
  th { color: var(--mute); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--canvas-soft-2); white-space: nowrap; }
  td { color: var(--body); vertical-align: top; }
  .td-sub { display: block; color: var(--mute); font-size: 11.5px; margin-top: 2px; }
  .muted { color: var(--mute); }
  .actions { text-align: right; white-space: nowrap; }

  .badge { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge-wired { background: var(--link-bg-soft); color: var(--link-deep); }
  .badge-wifi { background: var(--warning-soft); color: var(--body); }
  .badge-none { background: var(--canvas-soft-2); color: var(--mute); }
  .port-pill { display: inline-block; min-width: 24px; text-align: center; padding: 1px 7px; border-radius: var(--r-xs); background: var(--canvas-soft-2); color: var(--ink); font-weight: 600; font-size: 12.5px; font-family: var(--font-mono, monospace); }

  .form { display: flex; flex-direction: column; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 12.5px; font-weight: 500; color: var(--body); font-family: var(--font-sans); }
  .opt, .hint { font-weight: 400; color: var(--mute); font-size: 12px; font-family: var(--font-sans); }
  .field-input { height: 34px; padding: 0 10px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--canvas); color: var(--ink); font-size: 13.5px; font-family: var(--font-sans); outline: none; width: 100%; box-sizing: border-box; }
  .field-input:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }
  .field-input:disabled { opacity: 0.5; }
  .who { margin: 0; font-size: 13.5px; color: var(--body); font-family: var(--font-sans); }
  .derived { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 10px 12px; border-radius: var(--r-sm); background: var(--canvas-soft-2); font-size: 12.5px; color: var(--body); font-family: var(--font-sans); }
  .derived .hint { flex-basis: 100%; }

  .port-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; }
  .port { height: 30px; border: 1px solid var(--hairline); border-radius: var(--r-xs); background: var(--canvas); color: var(--ink); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-mono, monospace); }
  .port:hover { border-color: var(--ink); }
  .port.taken { background: var(--canvas-soft-2); color: var(--mute); }
  .port.chosen { background: var(--ink); color: var(--on-primary); border-color: var(--ink); }

  .btn-primary { display: inline-flex; align-items: center; padding: 7px 13px; border-radius: var(--r-md); font-size: 13px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: none; background: var(--ink); color: var(--on-primary); line-height: 1; }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { display: inline-flex; align-items: center; padding: 7px 13px; border-radius: var(--r-md); font-size: 13px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink); line-height: 1; }
  .btn-ghost:hover { background: var(--canvas-soft-2); }
  .btn-danger-ghost { padding: 7px 13px; border-radius: var(--r-md); font-size: 13px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: 1px solid transparent; background: none; color: var(--error); line-height: 1; }
  .btn-danger-ghost:hover:not(:disabled) { background: var(--error-soft); }
  .btn-ghost-sm { padding: 4px 10px; border-radius: var(--r-sm); font-size: 12px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink); white-space: nowrap; }
  .btn-ghost-sm:hover { background: var(--canvas-soft-2); }
  .link-btn { background: none; border: none; padding: 0 0 0 6px; color: var(--link); font-size: 12.5px; cursor: pointer; font-family: var(--font-sans); }
  .link-btn:hover { text-decoration: underline; }

  .form-error { padding: 10px 14px; background: var(--error-soft); color: var(--error); border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans); }
  .form-warn { padding: 10px 14px; background: var(--warning-soft); color: var(--body); border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans); }

  @media (max-width: 900px) {
    .diagram { flex-direction: column; }
    .col-arrow { transform: rotate(90deg); align-self: flex-start; padding-left: 12px; }
    .col { min-width: 0; }
  }
  @media (max-width: 640px) {
    .grid2 { grid-template-columns: 1fr; }
    .port-grid { grid-template-columns: repeat(8, 1fr); }
  }
</style>
