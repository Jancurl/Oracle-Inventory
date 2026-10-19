<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';

  type AssetRef = { name: string; assetTag: string | null };
  type AssetOption = AssetRef & {
    id: string; branchId: string | null; macAddress: string | null;
    branch: { id: string; name: string } | null; category: { id: string; name: string } | null;
  };
  type Interface = { id: string; interfaceName: string; assetId: string; asset?: AssetRef | null };
  type Vlan = { id: string; vlanNumber: number; vlanName: string | null; branchId: string };
  type Port = { id: string; portNumber: string; assetId: string; asset?: AssetRef | null };

  let assets  = $state<AssetOption[]>([]);
  let loading = $state(true);
  let loadErr = $state('');

  function assetLabel(a: AssetRef | null | undefined) {
    return a ? `${a.name}${a.assetTag ? ` · ${a.assetTag}` : ''}` : '';
  }

  async function listOf<T>(path: string): Promise<T[]> {
    return api.get<{ items: T[] }>(path).then(r => r.items).catch(() => []);
  }

  onMount(async () => {
    try {
      assets = (await api.get<AssetOption[]>('/api/assets')).sort((a, b) => a.name.localeCompare(b.name));
      // An asset's page links here with ?asset=<id> to start on that device
      const fromLink = $page.url.searchParams.get('asset');
      if (fromLink && assets.some(a => a.id === fromLink)) {
        deviceId = fromLink;
        void chooseDevice();
      }
    } catch (e) {
      loadErr = (e as Error).message;
    } finally {
      loading = false;
    }
  });

  // ── Device: picked once; every section below records against it ───────────
  let deviceId = $state('');
  const device     = $derived(assets.find(a => a.id === deviceId) ?? null);
  const branchId   = $derived(device?.branchId ?? '');
  const branchName = $derived(device?.branch?.name ?? '');

  let deviceInterfaces = $state<Interface[]>([]);
  let devicePorts      = $state<Port[]>([]);
  let branchVlans      = $state<Vlan[]>([]);
  let branchPorts      = $state<Port[]>([]);
  let branchInterfaces = $state<Interface[]>([]);
  let listsLoading     = $state(false);

  async function chooseDevice() {
    const id = deviceId;
    const chosen = assets.find(a => a.id === id) ?? null;
    resetSections();
    deviceInterfaces = []; devicePorts = []; branchVlans = []; branchPorts = []; branchInterfaces = [];
    if (!chosen) { listsLoading = false; return; }

    listsLoading = true;
    const bId = chosen.branchId ?? '';
    const [ifs, ps, vl, bps, bifs] = await Promise.all([
      listOf<Interface>(`/api/network/interfaces?assetId=${id}&pageSize=100`),
      listOf<Port>(`/api/network/ports?assetId=${id}&pageSize=100`),
      bId ? listOf<Vlan>(`/api/network/vlans?branchId=${bId}`) : Promise.resolve([]),
      bId ? listOf<Port>(`/api/network/ports?branchId=${bId}&pageSize=100`) : Promise.resolve([]),
      bId ? listOf<Interface>(`/api/network/interfaces?branchId=${bId}&pageSize=100`) : Promise.resolve([]),
    ]);
    if (deviceId !== id) return; // another device was picked while these loaded
    deviceInterfaces = ifs; devicePorts = ps; branchVlans = vl; branchPorts = bps; branchInterfaces = bifs;
    ipInterfaceId = ifs[0]?.id ?? '';
    assignInterfaceId = ifs[0]?.id ?? '';
    connFromPortId = ps[0]?.id ?? '';
    // A device's first interface usually carries the MAC already on the asset
    if (ifs.length === 0 && chosen.macAddress) ifMac = chosen.macAddress;
    listsLoading = false;
  }

  function resetSections() {
    ifName = ''; ifMac = ''; ifDescription = ''; ifError = ''; ifSaved = '';
    ipInterfaceId = ''; ipAddress = ''; ipPrefix = ''; ipMode = 'static'; ipGateway = ''; ipDns = ''; ipError = ''; ipSaved = false;
    vlanNumber = ''; vlanName = ''; vlanCidr = ''; vlanGateway = ''; vlanError = ''; vlanSaved = '';
    assignInterfaceId = ''; assignVlanId = ''; assignTagging = 'access'; assignNative = false; assignError = ''; assignSaved = false;
    portNumberField = ''; portLabel = ''; portMedium = ''; portSpeed = ''; portPoe = ''; portError = ''; portSaved = '';
    connFromPortId = ''; connTargetType = 'port'; connToPortId = ''; connToInterfaceId = ''; connLinkType = 'physical'; connError = ''; connSaved = false;
    credUsername = ''; credPassword = ''; credSnmpCommunity = ''; credVpnKey = ''; credWifiPassword = ''; credApiKey = ''; credRecoveryCode = ''; credError = ''; credSaved = false;
  }

  // ── 1. Interface ─────────────────────────────────────────────────────────────
  let ifName = $state(''); let ifMac = $state(''); let ifDescription = $state('');
  let ifSaving = $state(false); let ifError = $state(''); let ifSaved = $state('');
  async function submitInterface() {
    ifError = ''; ifSaved = '';
    if (!ifName.trim()) { ifError = 'Interface name is required.'; return; }
    ifSaving = true;
    try {
      const created = await api.post<Interface>('/api/network/interfaces', {
        assetId: deviceId, interfaceName: ifName.trim(),
        macAddress: ifMac.trim() || undefined, description: ifDescription.trim() || undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      const withAsset = { ...created, asset: device ? { name: device.name, assetTag: device.assetTag } : null };
      deviceInterfaces = [withAsset, ...deviceInterfaces];
      if (branchId) branchInterfaces = [withAsset, ...branchInterfaces];
      // Ready for the IP address and VLAN assignment sections
      ipInterfaceId = created.id;
      assignInterfaceId = created.id;
      ifName = ''; ifMac = ''; ifDescription = '';
      ifSaved = `Interface ${created.interfaceName} saved.`;
    } catch (e) { ifError = (e as Error).message; }
    finally { ifSaving = false; }
  }

  // ── 2. IP observation ───────────────────────────────────────────────────────
  let ipInterfaceId = $state(''); let ipAddress = $state(''); let ipPrefix = $state('');
  let ipMode = $state<'static' | 'dhcp' | 'dynamic' | 'unknown'>('static');
  let ipGateway = $state(''); let ipDns = $state('');
  let ipSaving = $state(false); let ipError = $state(''); let ipSaved = $state(false);
  async function submitIpObservation() {
    ipError = ''; ipSaved = false;
    const prefix = Number(ipPrefix);
    if (!ipInterfaceId || !ipAddress.trim() || !Number.isInteger(prefix)) { ipError = 'Interface, address, and prefix length are required.'; return; }
    ipSaving = true;
    try {
      await api.post(`/api/network/interfaces/${ipInterfaceId}/ip-observations`, {
        address: ipAddress.trim(), prefixLength: prefix, addressingMode: ipMode,
        gateway: ipGateway.trim() || undefined,
        dnsServers: ipDns.trim() ? ipDns.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      ipAddress = ''; ipPrefix = ''; ipGateway = ''; ipDns = '';
      ipSaved = true;
    } catch (e) { ipError = (e as Error).message; }
    finally { ipSaving = false; }
  }

  // ── 3. VLAN (belongs to the device's branch) ─────────────────────────────────
  let vlanNumber = $state(''); let vlanName = $state('');
  let vlanCidr = $state(''); let vlanGateway = $state('');
  let vlanSaving = $state(false); let vlanError = $state(''); let vlanSaved = $state('');
  async function submitVlan() {
    vlanError = ''; vlanSaved = '';
    const num = Number(vlanNumber);
    if (!Number.isInteger(num) || num < 1 || num > 4094) { vlanError = 'A VLAN number 1-4094 is required.'; return; }
    vlanSaving = true;
    try {
      const created = await api.post<Vlan>('/api/network/vlans', {
        branchId, vlanNumber: num,
        vlanName: vlanName.trim() || undefined, cidr: vlanCidr.trim() || undefined, gateway: vlanGateway.trim() || undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      branchVlans = [...branchVlans, created].sort((a, b) => a.vlanNumber - b.vlanNumber);
      assignVlanId = created.id; // ready for the VLAN assignment section
      vlanNumber = ''; vlanName = ''; vlanCidr = ''; vlanGateway = '';
      vlanSaved = `VLAN ${created.vlanNumber} saved.`;
    } catch (e) {
      // Already recorded: point to it instead of asking for it again
      const existing = branchVlans.find(v => v.vlanNumber === num);
      if ((e as { code?: string }).code === 'DUPLICATE_VLAN' && existing) {
        assignVlanId = existing.id;
        vlanNumber = ''; vlanName = ''; vlanCidr = ''; vlanGateway = '';
        vlanSaved = `VLAN ${num} is already recorded for ${branchName}, so it was not added again. It is selected in section 4.`;
      } else {
        vlanError = (e as Error).message;
      }
    }
    finally { vlanSaving = false; }
  }

  // ── 4. VLAN assignment ──────────────────────────────────────────────────────
  let assignInterfaceId = $state(''); let assignVlanId = $state('');
  let assignTagging = $state<'access' | 'tagged' | 'trunk'>('access'); let assignNative = $state(false);
  let assignSaving = $state(false); let assignError = $state(''); let assignSaved = $state(false);
  async function submitVlanAssignment() {
    assignError = ''; assignSaved = false;
    if (!assignInterfaceId || !assignVlanId) { assignError = 'Interface and VLAN are required.'; return; }
    assignSaving = true;
    try {
      await api.post('/api/network/vlan-assignments', {
        interfaceId: assignInterfaceId, vlanId: assignVlanId, taggingMode: assignTagging, isNative: assignNative,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      assignSaved = true;
    } catch (e) { assignError = (e as Error).message; }
    finally { assignSaving = false; }
  }

  // ── 5. Port ──────────────────────────────────────────────────────────────────
  let portNumberField = $state(''); let portLabel = $state('');
  let portMedium = $state(''); let portSpeed = $state(''); let portPoe = $state('');
  let portSaving = $state(false); let portError = $state(''); let portSaved = $state('');
  async function submitPort() {
    portError = ''; portSaved = '';
    if (!portNumberField.trim()) { portError = 'Port number is required.'; return; }
    portSaving = true;
    try {
      const created = await api.post<Port>('/api/network/ports', {
        assetId: deviceId, portNumber: portNumberField.trim(),
        portLabel: portLabel.trim() || undefined, medium: portMedium.trim() || undefined,
        speedMbps: portSpeed.trim() ? Number(portSpeed) : undefined, poeCapability: portPoe.trim() || undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      const withAsset = { ...created, asset: device ? { name: device.name, assetTag: device.assetTag } : null };
      devicePorts = [withAsset, ...devicePorts];
      if (branchId) branchPorts = [withAsset, ...branchPorts];
      connFromPortId = created.id; // ready for the topology section
      portNumberField = ''; portLabel = ''; portMedium = ''; portSpeed = ''; portPoe = '';
      portSaved = `Port ${created.portNumber} saved.`;
    } catch (e) { portError = (e as Error).message; }
    finally { portSaving = false; }
  }

  // ── 6. Topology connection (in the device's branch) ─────────────────────────
  let connFromPortId = $state('');
  let connTargetType = $state<'port' | 'interface'>('port');
  let connToPortId = $state(''); let connToInterfaceId = $state('');
  let connLinkType = $state<'physical' | 'logical' | 'wan'>('physical');
  let connSaving = $state(false); let connError = $state(''); let connSaved = $state(false);
  // Targets: any port in the device's branch except the source port itself
  const targetPorts = $derived(branchPorts.filter(p => p.id !== connFromPortId));
  async function submitConnection() {
    connError = ''; connSaved = false;
    const target = connTargetType === 'port' ? connToPortId : connToInterfaceId;
    if (!connFromPortId || !target) { connError = 'A source port and a target are required.'; return; }
    connSaving = true;
    try {
      await api.post('/api/network/connections', {
        branchId, fromPortId: connFromPortId, linkType: connLinkType,
        toPortId: connTargetType === 'port' ? connToPortId : undefined,
        toInterfaceId: connTargetType === 'interface' ? connToInterfaceId : undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      connSaved = true;
    } catch (e) { connError = (e as Error).message; }
    finally { connSaving = false; }
  }

  // ── 7. Device credentials (optional) ────────────────────────────────────────
  let credUsername = $state(''); let credPassword = $state('');
  let credSnmpCommunity = $state(''); let credVpnKey = $state(''); let credWifiPassword = $state('');
  let credApiKey = $state(''); let credRecoveryCode = $state('');
  let credSaving = $state(false); let credError = $state(''); let credSaved = $state(false);
  async function submitCredentials() {
    credError = ''; credSaved = false;
    credSaving = true;
    try {
      await api.post('/api/network/device-credentials', {
        assetId: deviceId,
        username: credUsername.trim() || undefined,
        password: credPassword.trim() || undefined,
        snmpCommunity: credSnmpCommunity.trim() || undefined,
        vpnKey: credVpnKey.trim() || undefined,
        wifiPassword: credWifiPassword.trim() || undefined,
        apiKey: credApiKey.trim() || undefined,
        recoveryCode: credRecoveryCode.trim() || undefined,
      });
      credUsername = ''; credPassword = ''; credSnmpCommunity = ''; credVpnKey = ''; credWifiPassword = ''; credApiKey = ''; credRecoveryCode = '';
      credSaved = true;
    } catch (e) { credError = (e as Error).message; }
    finally { credSaving = false; }
  }
</script>

<svelte:head><title>Network Intake | Oracle Inventory</title></svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Network', href: '/network' }, { label: 'Network Intake' }]} />

  <div class="page-header">
    <div>
      <h1 class="page-title">Network intake</h1>
      <p class="page-sub">Pick a device, then record its interfaces, IP addressing, VLANs, ports, topology links, and (optionally) credentials. Credentials are encrypted at rest and only a super admin can reveal them.</p>
    </div>
  </div>

  {#if loading}
    <div class="card"><div class="card-body"><p class="page-subtitle">Loading assets…</p></div></div>
  {:else if loadErr}
    <div class="card"><div class="card-body"><div class="form-error">{loadErr}</div></div></div>
  {:else}

  <!-- Device: chosen once for every section -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">Device</h2></div>
    <div class="card-body">
      <p class="ci-hint">Every section below records against this device, and VLANs and topology links use its branch.</p>
      <div class="fields-grid">
        <div class="field field-span-2">
          <label class="field-label" for="device">Device <span class="required">*</span></label>
          <select id="device" class="field-select" bind:value={deviceId} onchange={() => void chooseDevice()}>
            <option value="">— Select device —</option>
            {#each assets as a (a.id)}<option value={a.id}>{assetLabel(a)}{a.branch ? ` — ${a.branch.name}` : ''}</option>{/each}
          </select>
        </div>
      </div>
      {#if device}
        <dl class="device-facts">
          <div><dt>Branch</dt><dd>{branchName || 'None — set one on the asset page to record VLANs and topology links'}</dd></div>
          <div><dt>Category</dt><dd>{device.category?.name ?? '—'}</dd></div>
          <div><dt>Already recorded</dt><dd>{listsLoading ? 'Loading…' : `${deviceInterfaces.length} interface${deviceInterfaces.length === 1 ? '' : 's'} · ${devicePorts.length} port${devicePorts.length === 1 ? '' : 's'}`}</dd></div>
          <div><dt>Asset</dt><dd><a class="link" href="/assets/{device.id}">Open asset page</a></dd></div>
        </dl>
      {/if}
    </div>
  </section>

  {#if !device}
    <div class="card"><div class="card-body"><p class="ci-hint ci-hint-last">Choose a device above to record its network details.</p></div></div>
  {:else}

  <!-- 1. Interface -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">1. Interface</h2></div>
    <div class="card-body">
      {#if ifError}<div class="form-error">{ifError}</div>{/if}
      {#if ifSaved}<div class="form-notice">{ifSaved}</div>{/if}
      <div class="fields-grid">
        <div class="field">
          <label class="field-label" for="if-name">Interface Name <span class="required">*</span></label>
          <input id="if-name" class="field-input" bind:value={ifName} placeholder="e.g. eth0, LAN1, mgmt" />
        </div>
        <div class="field">
          <label class="field-label" for="if-mac">MAC Address</label>
          <input id="if-mac" class="field-input" bind:value={ifMac} placeholder="AA:BB:CC:DD:EE:FF" />
        </div>
        <div class="field">
          <label class="field-label" for="if-desc">Description</label>
          <input id="if-desc" class="field-input" bind:value={ifDescription} />
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="btn-primary" onclick={submitInterface} disabled={ifSaving}>{ifSaving ? 'Saving…' : 'Save interface'}</button>
      </div>
    </div>
  </section>

  <!-- 2. IP observation -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">2. IP Address</h2></div>
    <div class="card-body">
      <p class="ci-hint">Static rows are official addressing; dynamic/DHCP rows are dated observations.</p>
      {#if ipError}<div class="form-error">{ipError}</div>{/if}
      {#if ipSaved}<div class="form-notice">IP address recorded.</div>{/if}
      <div class="fields-grid">
        <div class="field">
          <label class="field-label" for="ip-interface">Interface <span class="required">*</span></label>
          <select id="ip-interface" class="field-select" bind:value={ipInterfaceId}>
            <option value="">— Select interface —</option>
            {#each deviceInterfaces as i (i.id)}<option value={i.id}>{i.interfaceName}</option>{/each}
          </select>
          {#if !listsLoading && deviceInterfaces.length === 0}<p class="field-hint">Save this device's interface in section 1 first.</p>{/if}
        </div>
        <div class="field">
          <label class="field-label" for="ip-address">Address <span class="required">*</span></label>
          <input id="ip-address" class="field-input" bind:value={ipAddress} placeholder="192.168.1.10" />
        </div>
        <div class="field">
          <label class="field-label" for="ip-prefix">Prefix Length <span class="required">*</span></label>
          <input id="ip-prefix" type="number" min="0" max="128" class="field-input" bind:value={ipPrefix} placeholder="24" />
        </div>
        <div class="field">
          <label class="field-label" for="ip-mode">Addressing Mode</label>
          <select id="ip-mode" class="field-select" bind:value={ipMode}>
            <option value="static">Static</option>
            <option value="dhcp">DHCP</option>
            <option value="dynamic">Dynamic</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="ip-gateway">Gateway</label>
          <input id="ip-gateway" class="field-input" bind:value={ipGateway} placeholder="192.168.1.1" />
        </div>
        <div class="field">
          <label class="field-label" for="ip-dns">DNS Servers <span class="optional">(comma-separated)</span></label>
          <input id="ip-dns" class="field-input" bind:value={ipDns} placeholder="8.8.8.8, 1.1.1.1" />
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="btn-primary" onclick={submitIpObservation} disabled={ipSaving}>{ipSaving ? 'Saving…' : 'Save IP address'}</button>
      </div>
    </div>
  </section>

  <!-- 3. VLAN -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">3. VLAN</h2></div>
    <div class="card-body">
      {#if !branchId}
        <p class="ci-hint ci-hint-last">This device has no branch, so its VLANs can't be recorded yet. Set its branch on the asset page first.</p>
      {:else}
        <p class="ci-hint">
          VLANs belong to {branchName}.
          {#if branchVlans.length}Already recorded there: {branchVlans.map(v => v.vlanNumber).join(', ')}.{/if}
        </p>
        {#if vlanError}<div class="form-error">{vlanError}</div>{/if}
        {#if vlanSaved}<div class="form-notice">{vlanSaved}</div>{/if}
        <div class="fields-grid">
          <div class="field">
            <label class="field-label" for="vlan-number">VLAN Number <span class="required">*</span></label>
            <input id="vlan-number" type="number" min="1" max="4094" class="field-input" bind:value={vlanNumber} />
          </div>
          <div class="field">
            <label class="field-label" for="vlan-name">Name</label>
            <input id="vlan-name" class="field-input" bind:value={vlanName} />
          </div>
          <div class="field">
            <label class="field-label" for="vlan-cidr">CIDR</label>
            <input id="vlan-cidr" class="field-input" bind:value={vlanCidr} placeholder="192.168.10.0/24" />
          </div>
          <div class="field">
            <label class="field-label" for="vlan-gateway">Gateway</label>
            <input id="vlan-gateway" class="field-input" bind:value={vlanGateway} />
          </div>
        </div>
        <div class="card-actions">
          <button type="button" class="btn-primary" onclick={submitVlan} disabled={vlanSaving}>{vlanSaving ? 'Saving…' : 'Save VLAN'}</button>
        </div>
      {/if}
    </div>
  </section>

  <!-- 4. VLAN assignment -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">4. VLAN Assignment</h2></div>
    <div class="card-body">
      {#if assignError}<div class="form-error">{assignError}</div>{/if}
      {#if assignSaved}<div class="form-notice">VLAN assignment saved.</div>{/if}
      <div class="fields-grid">
        <div class="field">
          <label class="field-label" for="assign-interface">Interface <span class="required">*</span></label>
          <select id="assign-interface" class="field-select" bind:value={assignInterfaceId}>
            <option value="">— Select interface —</option>
            {#each deviceInterfaces as i (i.id)}<option value={i.id}>{i.interfaceName}</option>{/each}
          </select>
          {#if !listsLoading && deviceInterfaces.length === 0}<p class="field-hint">Save this device's interface in section 1 first.</p>{/if}
        </div>
        <div class="field">
          <label class="field-label" for="assign-vlan">VLAN <span class="required">*</span></label>
          <select id="assign-vlan" class="field-select" bind:value={assignVlanId}>
            <option value="">— Select VLAN —</option>
            {#each branchVlans as v (v.id)}<option value={v.id}>VLAN {v.vlanNumber}{v.vlanName ? ` — ${v.vlanName}` : ''}</option>{/each}
          </select>
          {#if !listsLoading && branchVlans.length === 0}<p class="field-hint">{branchId ? `No VLANs recorded for ${branchName} yet — add one in section 3.` : 'This device has no branch.'}</p>{/if}
        </div>
        <div class="field">
          <label class="field-label" for="assign-tagging">Tagging Mode</label>
          <select id="assign-tagging" class="field-select" bind:value={assignTagging}>
            <option value="access">Access</option>
            <option value="tagged">Tagged</option>
            <option value="trunk">Trunk</option>
          </select>
        </div>
      </div>
      <label class="checkbox-row" style="margin-top: 12px;">
        <input type="checkbox" class="checkbox" bind:checked={assignNative} />
        <span class="checkbox-label">Native VLAN on this interface</span>
      </label>
      <div class="card-actions">
        <button type="button" class="btn-primary" onclick={submitVlanAssignment} disabled={assignSaving}>{assignSaving ? 'Saving…' : 'Save assignment'}</button>
      </div>
    </div>
  </section>

  <!-- 5. Port -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">5. Port</h2></div>
    <div class="card-body">
      {#if portError}<div class="form-error">{portError}</div>{/if}
      {#if portSaved}<div class="form-notice">{portSaved}</div>{/if}
      <div class="fields-grid">
        <div class="field">
          <label class="field-label" for="port-number">Port Number <span class="required">*</span></label>
          <input id="port-number" class="field-input" bind:value={portNumberField} placeholder="e.g. Gi0/1" />
        </div>
        <div class="field">
          <label class="field-label" for="port-label">Port Label</label>
          <input id="port-label" class="field-input" bind:value={portLabel} />
        </div>
        <div class="field">
          <label class="field-label" for="port-medium">Medium</label>
          <input id="port-medium" class="field-input" bind:value={portMedium} placeholder="e.g. copper, fiber" />
        </div>
        <div class="field">
          <label class="field-label" for="port-speed">Speed Mbps</label>
          <input id="port-speed" type="number" min="0" class="field-input" bind:value={portSpeed} />
        </div>
        <div class="field">
          <label class="field-label" for="port-poe">PoE Capability</label>
          <input id="port-poe" class="field-input" bind:value={portPoe} placeholder="e.g. 802.3af" />
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="btn-primary" onclick={submitPort} disabled={portSaving}>{portSaving ? 'Saving…' : 'Save port'}</button>
      </div>
    </div>
  </section>

  <!-- 6. Topology connection -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">6. Topology Link</h2></div>
    <div class="card-body">
      {#if !branchId}
        <p class="ci-hint ci-hint-last">This device has no branch, so its topology links can't be recorded yet. Set its branch on the asset page first.</p>
      {:else}
        <p class="ci-hint">Connect one of this device's ports to another port or interface in {branchName}.</p>
        {#if connError}<div class="form-error">{connError}</div>{/if}
        {#if connSaved}<div class="form-notice">Topology link saved.</div>{/if}
        <div class="fields-grid">
          <div class="field">
            <label class="field-label" for="conn-from">Source Port <span class="required">*</span></label>
            <select id="conn-from" class="field-select" bind:value={connFromPortId}>
              <option value="">— Select port —</option>
              {#each devicePorts as p (p.id)}<option value={p.id}>{p.portNumber}</option>{/each}
            </select>
            {#if !listsLoading && devicePorts.length === 0}<p class="field-hint">Save this device's port in section 5 first.</p>{/if}
          </div>
          <div class="field">
            <label class="field-label" for="conn-link-type">Link Type</label>
            <select id="conn-link-type" class="field-select" bind:value={connLinkType}>
              <option value="physical">Physical</option>
              <option value="logical">Logical</option>
              <option value="wan">WAN</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="conn-target-type">Target Type</label>
            <select id="conn-target-type" class="field-select" bind:value={connTargetType}>
              <option value="port">Another Port</option>
              <option value="interface">An Interface</option>
            </select>
          </div>
          {#if connTargetType === 'port'}
            <div class="field">
              <label class="field-label" for="conn-to-port">Target Port <span class="required">*</span></label>
              <select id="conn-to-port" class="field-select" bind:value={connToPortId}>
                <option value="">— Select port —</option>
                {#each targetPorts as p (p.id)}<option value={p.id}>{p.portNumber} · {assetLabel(p.asset)}</option>{/each}
              </select>
            </div>
          {:else}
            <div class="field">
              <label class="field-label" for="conn-to-interface">Target Interface <span class="required">*</span></label>
              <select id="conn-to-interface" class="field-select" bind:value={connToInterfaceId}>
                <option value="">— Select interface —</option>
                {#each branchInterfaces as i (i.id)}<option value={i.id}>{i.interfaceName} · {assetLabel(i.asset)}</option>{/each}
              </select>
            </div>
          {/if}
        </div>
        <div class="card-actions">
          <button type="button" class="btn-primary" onclick={submitConnection} disabled={connSaving}>{connSaving ? 'Saving…' : 'Save topology link'}</button>
        </div>
      {/if}
    </div>
  </section>

  <!-- 7. Device credentials -->
  <section class="card">
    <div class="card-header"><h2 class="card-title">7. Device Credentials <span class="optional">(Optional)</span></h2></div>
    <div class="card-body">
      <p class="ci-hint">Encrypted at rest and only ever decrypted by a super admin. Leave any field blank if you don't have it or don't want to record it. Saving replaces the credentials already stored for this device.</p>
      {#if credError}<div class="form-error">{credError}</div>{/if}
      {#if credSaved}<div class="form-notice">Device credentials saved.</div>{/if}
      <div class="fields-grid">
        <div class="field">
          <label class="field-label" for="cred-username">Username <span class="optional">(optional)</span></label>
          <input id="cred-username" class="field-input" bind:value={credUsername} autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-password">Password <span class="optional">(optional)</span></label>
          <input id="cred-password" type="password" class="field-input" bind:value={credPassword} autocomplete="new-password" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-snmp">SNMP Community <span class="optional">(optional)</span></label>
          <input id="cred-snmp" type="password" class="field-input" bind:value={credSnmpCommunity} autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-vpn">VPN Pre-Shared Key <span class="optional">(optional)</span></label>
          <input id="cred-vpn" type="password" class="field-input" bind:value={credVpnKey} autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-wifi">Wi-Fi Password <span class="optional">(optional)</span></label>
          <input id="cred-wifi" type="password" class="field-input" bind:value={credWifiPassword} autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-apikey">API Key <span class="optional">(optional)</span></label>
          <input id="cred-apikey" type="password" class="field-input" bind:value={credApiKey} autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="cred-recovery">Recovery Code <span class="optional">(optional)</span></label>
          <input id="cred-recovery" type="password" class="field-input" bind:value={credRecoveryCode} autocomplete="off" />
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="btn-primary" onclick={submitCredentials} disabled={credSaving}>{credSaving ? 'Saving…' : 'Save credentials'}</button>
      </div>
    </div>
  </section>

  {/if}
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 16px; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-title  { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .page-sub    { font-size: 13px; color: var(--mute); margin-top: 3px; max-width: 640px; }

  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); }
  .card-header { padding: 16px 20px 12px; border-bottom: 1px solid var(--hairline); }
  .card-title { font-size: 14px; font-weight: 600; color: var(--ink); font-family: var(--font-sans); letter-spacing: -0.2px; }
  .card-body { padding: 20px; }

  .ci-hint { font-size: 12.5px; color: var(--mute); font-family: var(--font-sans); margin: 0 0 14px; }
  .ci-hint-last { margin-bottom: 0; }

  .fields-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px 16px; }
  .field-span-2 { grid-column: span 2; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 12.5px; font-weight: 500; color: var(--body); font-family: var(--font-sans); }
  .field-hint { font-size: 11.5px; color: var(--mute); margin: 2px 0 0; }
  .required { color: var(--error); }
  .optional { color: var(--mute); font-weight: 400; }

  .field-input, .field-select {
    height: 34px; padding: 0 10px;
    border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink);
    font-size: 13.5px; font-family: var(--font-sans);
    outline: none; width: 100%;
  }
  .field-select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; padding-right: 30px; cursor: pointer;
  }
  .field-input:focus, .field-select:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }

  .device-facts {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px 16px;
    margin: 14px 0 0; padding: 12px 14px; border-radius: var(--r-md); background: var(--canvas-soft-2);
    font-family: var(--font-sans);
  }
  .device-facts dt { font-size: 11.5px; color: var(--mute); }
  .device-facts dd { margin: 2px 0 0; font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
  .link { color: var(--link); font-weight: 500; text-decoration: none; }
  .link:hover { text-decoration: underline; }

  .checkbox-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .checkbox { width: 15px; height: 15px; accent-color: var(--link); cursor: pointer; flex-shrink: 0; }
  .checkbox-label { font-size: 13.5px; font-weight: 500; color: var(--ink); font-family: var(--font-sans); }

  .card-actions { display: flex; justify-content: flex-end; margin-top: 16px; }

  .btn-primary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--r-md);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; border: none;
    background: var(--ink); color: var(--on-primary);
    transition: opacity 120ms ease; line-height: 1;
  }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .form-error {
    padding: 10px 14px; background: var(--error-soft); color: var(--error);
    border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans); margin-bottom: 14px;
  }
  .form-notice {
    padding: 10px 14px; background: var(--canvas-soft-2); color: var(--body);
    border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans); margin-bottom: 14px;
  }

  @media (max-width: 900px) { .fields-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 640px) { .fields-grid { grid-template-columns: 1fr; } .field-span-2 { grid-column: auto; } .page-header { flex-direction: column; } }
</style>
