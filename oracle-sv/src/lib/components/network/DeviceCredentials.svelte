<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { authStore } from '$lib/stores/auth.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import TableStates from '$lib/components/TableStates.svelte';

  type AssetRef = { name: string; assetTag: string | null } | null;
  type CredentialRow = {
    id: string; assetId: string; asset: AssetRef; updatedAt: string;
    hasUsername: boolean; hasPassword: boolean; hasSnmpCommunity: boolean;
    hasVpnKey: boolean; hasWifiPassword: boolean; hasApiKey: boolean; hasRecoveryCode: boolean;
  };
  type Revealed = { username?: string; password?: string; snmpCommunity?: string; vpnKey?: string; wifiPassword?: string; apiKey?: string; recoveryCode?: string };
  type AssetOption = { id: string; name: string; assetTag: string | null; category?: { name: string } | null };

  const COLUMNS: { key: keyof Revealed; flag: keyof CredentialRow; label: string }[] = [
    { key: 'username', flag: 'hasUsername', label: 'Username' },
    { key: 'password', flag: 'hasPassword', label: 'Password' },
    { key: 'snmpCommunity', flag: 'hasSnmpCommunity', label: 'SNMP community' },
    { key: 'vpnKey', flag: 'hasVpnKey', label: 'VPN key' },
    { key: 'wifiPassword', flag: 'hasWifiPassword', label: 'Wi-Fi password' },
    { key: 'apiKey', flag: 'hasApiKey', label: 'API key' },
    { key: 'recoveryCode', flag: 'hasRecoveryCode', label: 'Recovery code' },
  ];

  const isSuperAdmin = $derived(authStore.user?.role === 'super_admin');

  let loading = $state(true);
  let error = $state('');
  let rows = $state<CredentialRow[]>([]);
  let revealed = $state<Record<string, Revealed>>({});

  async function refresh() {
    loading = true; error = '';
    try {
      rows = (await api.get<{ items: CredentialRow[] }>('/api/network/device-credentials')).items;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // ── Reveal (super admin, step-up password) ────────────────────────────────
  let revealOpen = $state(false);
  let revealAssetId = $state('');
  let revealPassword = $state('');
  let revealError = $state('');
  let revealBusy = $state(false);

  function openReveal(assetId: string) {
    revealAssetId = assetId; revealPassword = ''; revealError = ''; revealOpen = true;
  }

  async function confirmReveal() {
    revealError = '';
    if (!revealPassword) { revealError = 'Enter your account password.'; return; }
    revealBusy = true;
    try {
      const payload = await api.post<Revealed>(`/api/network/device-credentials/${revealAssetId}/reveal`, { currentPassword: revealPassword });
      revealed = { ...revealed, [revealAssetId]: payload };
      revealOpen = false;
    } catch (e) {
      revealError = (e as Error).message;
    } finally {
      revealBusy = false;
    }
  }

  function hide(assetId: string) {
    const next = { ...revealed };
    delete next[assetId];
    revealed = next;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  let saveOpen = $state(false);
  let saveBusy = $state(false);
  let saveError = $state('');
  let assets = $state<AssetOption[]>([]);
  let form = $state<{ assetId: string } & Required<Record<keyof Revealed, string>>>({ assetId: '', username: '', password: '', snmpCommunity: '', vpnKey: '', wifiPassword: '', apiKey: '', recoveryCode: '' });

  async function openSave(assetId = '') {
    saveError = '';
    form = { assetId, username: '', password: '', snmpCommunity: '', vpnKey: '', wifiPassword: '', apiKey: '', recoveryCode: '' };
    saveOpen = true;
    if (assets.length === 0) {
      assets = await api.get<AssetOption[]>('/api/assets').catch(() => []);
      // Network gear first — that's what credentials are almost always for.
      assets = [...assets].sort((a, b) => Number(!/network|switch|router|access|firewall|nvr/i.test(a.category?.name ?? '')) - Number(!/network|switch|router|access|firewall|nvr/i.test(b.category?.name ?? '')) || a.name.localeCompare(b.name));
    }
  }

  async function save() {
    saveError = '';
    if (!form.assetId) { saveError = 'Pick the device these credentials belong to.'; return; }
    saveBusy = true;
    try {
      const body: Record<string, string> = { assetId: form.assetId };
      for (const c of COLUMNS) if (form[c.key].trim()) body[c.key] = form[c.key].trim();
      await api.post('/api/network/device-credentials', body);
      hide(form.assetId);
      saveOpen = false;
      await refresh();
    } catch (e) {
      saveError = (e as Error).message;
    } finally {
      saveBusy = false;
    }
  }

  onMount(refresh);
</script>

<div class="card">
  <div class="table-head">
    <div>
      <div class="table-title">Device credentials</div>
      <div class="table-sub">Switch, router and access-point logins. Encrypted at rest; only a super admin can reveal them, and every reveal is logged.</div>
    </div>
    <button type="button" class="btn-primary" onclick={() => openSave()}>+ Save credentials</button>
  </div>
  <TableStates {loading} {error} onRetry={refresh} empty={!loading && !error && rows.length === 0} emptyTitle="No device credentials saved" emptyMessage="Saved logins for switches, routers and access points will appear here." />
  {#if !loading && rows.length > 0}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Device</th>
            {#each COLUMNS as col}<th>{col.label}</th>{/each}
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td>{row.asset ? (row.asset.assetTag ? `${row.asset.name} · ${row.asset.assetTag}` : row.asset.name) : '—'}</td>
              {#each COLUMNS as col}
                <td>
                  {#if !row[col.flag]}<span class="muted">—</span>
                  {:else if revealed[row.assetId]}<span class="cred-value">{revealed[row.assetId][col.key] ?? '—'}</span>
                  {:else}<span class="cred-masked">••••••••</span>{/if}
                </td>
              {/each}
              <td>{new Date(row.updatedAt).toLocaleString()}</td>
              <td class="actions">
                {#if isSuperAdmin}
                  {#if revealed[row.assetId]}
                    <button type="button" class="btn-ghost-sm" onclick={() => hide(row.assetId)}>Hide</button>
                  {:else}
                    <button type="button" class="btn-ghost-sm" onclick={() => openReveal(row.assetId)}>Reveal</button>
                  {/if}
                {/if}
                <button type="button" class="btn-ghost-sm" onclick={() => openSave(row.assetId)}>Replace</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<Modal bind:open={revealOpen} title="Confirm it's you" maxWidth="400px">
  <form id="reveal-credentials-form" class="form" onsubmit={(e) => { e.preventDefault(); confirmReveal(); }}>
    <p class="hint-p">
      This is <strong>not</strong> the device password you're trying to view — enter the login password
      for <strong>your own Oracle Inventory account</strong>{authStore.user?.email ? ` (${authStore.user.email})` : ''} to confirm it's really you. This reveal is logged.
    </p>
    {#if revealError}<div class="form-error">{revealError}</div>{/if}
    <div class="field">
      <label class="field-label" for="reveal-password">Your Oracle Inventory login password</label>
      <input id="reveal-password" type="password" class="field-input" bind:value={revealPassword} autocomplete="current-password" placeholder="Not the device's password" />
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn-ghost" onclick={() => (revealOpen = false)}>Cancel</button>
    <button type="submit" form="reveal-credentials-form" class="btn-primary" disabled={revealBusy}>{revealBusy ? 'Verifying…' : 'Confirm'}</button>
  {/snippet}
</Modal>

<Modal bind:open={saveOpen} title="Save device credentials" maxWidth="520px">
  <form id="save-credentials-form" class="form" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <p class="hint-p">Saving replaces everything stored for this device — fill in every value you want to keep.</p>
    {#if saveError}<div class="form-error">{saveError}</div>{/if}
    <div class="field">
      <label class="field-label" for="cred-asset">Device</label>
      <select id="cred-asset" class="field-input" bind:value={form.assetId}>
        <option value="">— Choose device —</option>
        {#each assets as a (a.id)}<option value={a.id}>{a.name}{a.assetTag ? ` · ${a.assetTag}` : ''}{a.category?.name ? ` (${a.category.name})` : ''}</option>{/each}
      </select>
    </div>
    <div class="grid2">
      {#each COLUMNS as col}
        <div class="field">
          <label class="field-label" for="cred-{col.key}">{col.label} <span class="opt">(optional)</span></label>
          <input id="cred-{col.key}" class="field-input" type={col.key === 'username' ? 'text' : 'password'} bind:value={form[col.key]} autocomplete={col.key === 'password' ? 'new-password' : 'off'} />
        </div>
      {/each}
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn-ghost" onclick={() => (saveOpen = false)}>Cancel</button>
    <button type="submit" form="save-credentials-form" class="btn-primary" disabled={saveBusy}>{saveBusy ? 'Saving…' : 'Save'}</button>
  {/snippet}
</Modal>

<style>
  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); overflow: hidden; }
  .table-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding: 14px 16px; }
  .table-title { font-size: 14px; font-weight: 600; color: var(--ink); font-family: var(--font-sans); }
  .table-sub { font-size: 12.5px; color: var(--mute); margin-top: 2px; font-family: var(--font-sans); max-width: 640px; }
  .table-wrap { overflow: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 11px 14px; border-top: 1px solid var(--hairline); font-size: 13.5px; font-family: var(--font-sans); }
  th { color: var(--mute); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--canvas-soft-2); white-space: nowrap; }
  td { color: var(--body); vertical-align: top; }
  .actions { text-align: right; white-space: nowrap; }
  .actions .btn-ghost-sm + .btn-ghost-sm { margin-left: 6px; }
  .muted { color: var(--mute); }
  .cred-masked { color: var(--mute); font-family: var(--font-mono, monospace); letter-spacing: 1px; }
  .cred-value { color: var(--ink); font-family: var(--font-mono, monospace); }

  .form { display: flex; flex-direction: column; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 12.5px; font-weight: 500; color: var(--body); font-family: var(--font-sans); }
  .opt { font-weight: 400; color: var(--mute); font-size: 12px; }
  .hint-p { margin: 0; font-size: 12.5px; color: var(--mute); font-family: var(--font-sans); }
  .field-input { height: 34px; padding: 0 10px; border: 1px solid var(--hairline); border-radius: var(--r-sm); background: var(--canvas); color: var(--ink); font-size: 13.5px; font-family: var(--font-sans); outline: none; width: 100%; box-sizing: border-box; }
  .field-input:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }

  .btn-primary { display: inline-flex; align-items: center; padding: 7px 13px; border-radius: var(--r-md); font-size: 13px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: none; background: var(--ink); color: var(--on-primary); line-height: 1; }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { display: inline-flex; align-items: center; padding: 7px 13px; border-radius: var(--r-md); font-size: 13px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink); line-height: 1; }
  .btn-ghost:hover { background: var(--canvas-soft-2); }
  .btn-ghost-sm { padding: 4px 10px; border-radius: var(--r-sm); font-size: 12px; font-weight: 500; font-family: var(--font-sans); cursor: pointer; border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink); white-space: nowrap; }
  .btn-ghost-sm:hover { background: var(--canvas-soft-2); }
  .form-error { padding: 10px 14px; background: var(--error-soft); color: var(--error); border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans); }

  @media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
</style>
