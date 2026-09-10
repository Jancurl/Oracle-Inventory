<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import { can } from '$lib/utils/permissions';
  import { authStore } from '$lib/stores/auth.svelte';
  import { onChange } from '$lib/ws';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import TableStates from '$lib/components/TableStates.svelte';

  type StockItem = { id: string; sku: string; name: string; category: string; unitOfMeasure: string; balance: number; description: string | null };

  // Item descriptions are a single "Label: value · Label: value" free-text
  // field (see oracle-api scripts/import-motorpool-tools-2026.ts) — there's
  // no dedicated Model/Color/Acquisition Date/Serial column in the schema.
  // Split it back out for display; anything unrecognized (or a description
  // that was never structured this way, e.g. hand-entered items) falls back
  // into Remarks rather than being dropped silently.
  type ItemDetails = { model: string; color: string; location: string; acquisitionDate: string; serial: string; quantity: string; remarks: string; asOfDate: string };
  const DETAIL_LABELS: Record<string, keyof ItemDetails> = {
    model: 'model', color: 'color', location: 'location',
    'acquisition date': 'acquisitionDate', acquired: 'acquisitionDate',
    serial: 'serial', 'serial number': 'serial',
    quantity: 'quantity',
    remarks: 'remarks',
    'as of date': 'asOfDate',
  };
  function parseDetails(description: string | null): ItemDetails {
    const out: ItemDetails = { model: '', color: '', location: '', acquisitionDate: '', serial: '', quantity: '', remarks: '', asOfDate: '' };
    if (!description) return out;
    const leftovers: string[] = [];
    let recognized = false;
    for (const segment of description.split('·').map((s) => s.trim()).filter(Boolean)) {
      const match = segment.match(/^([A-Za-z ]+):\s*(.*)$/);
      const label = match?.[1].trim().toLowerCase();
      const key = label ? DETAIL_LABELS[label] : undefined;
      if (key) {
        recognized = true;
        const value = match![2].trim();
        out[key] = value && value.toUpperCase() !== 'N/A' ? value : '';
      } else if (label === 'brand') {
        recognized = true; // known label, just not its own column here
      } else {
        leftovers.push(segment);
      }
    }
    if (!recognized) out.remarks = description;
    else if (leftovers.length && !out.remarks) out.remarks = leftovers.join(' · ');
    return out;
  }

  // Quantity (expected/recorded amount) vs Count (item.balance, the actual
  // on-hand total derived from stock movements) — Variance is how far off
  // the two are. null when no expected Quantity was recorded, so it's not
  // confused with a confirmed zero variance.
  function variance(details: ItemDetails, balance: number): number | null {
    const expected = Number(details.quantity);
    if (!details.quantity || !Number.isFinite(expected)) return null;
    return expected - balance;
  }

  let items      = $state<StockItem[]>([]);
  let loading    = $state(true);
  let error      = $state('');
  let disabled   = $state(false);
  let forbidden  = $state(false);

  const totalOnHand   = $derived(items.reduce((sum, i) => sum + i.balance, 0));
  const totalCategories = $derived(new Set(items.map(i => i.category)).size);
  // Deleting a stock item is Super Admin only — stricter than manage_stock,
  // which regular admins/managers already have for create/edit.
  const isSuperAdmin = $derived((authStore.user?.role ?? '').trim().toLowerCase() === 'super_admin');

  let deletingId = $state('');
  let deleteErr  = $state('');

  async function deleteItem(item: StockItem) {
    if (!confirm(`Archive "${item.name}"? It will disappear from All Items, but its history is kept and this can be undone.`)) return;
    deletingId = item.id; deleteErr = '';
    try {
      await api.delete(`/api/stock/items/${item.id}`);
      items = items.filter((i) => i.id !== item.id);
    } catch (caught) {
      deleteErr = caught instanceof Error ? caught.message : 'Unable to archive item.';
    } finally {
      deletingId = '';
    }
  }

  async function load() {
    loading = true; error = ''; disabled = false; forbidden = false;
    if (!can('view_stock')) {
      forbidden = true;
      loading = false;
      return;
    }
    try {
      items = (await api.get<{ items: StockItem[] }>('/api/stock/items')).items;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to load stock.';
      if (message === 'Tools and stock is disabled.') {
        disabled = true;
      } else {
        error = message;
      }
    } finally {
      loading = false;
    }
  }

  load();
  onDestroy(onChange(['StockMovement', 'StockCountSession'], () => load()));
</script>

<svelte:head>
  <title>Tools & Stock | Oracle Inventory</title>
</svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Tools & Stock' }]} />

  <div class="page-header">
    <div>
      <h1 class="page-title">Tools & Stock</h1>
      <p class="page-sub">Quantity-managed tools, consumables, locations, and count controls.</p>
    </div>
    <div class="header-actions">
      <button class="btn-ghost" onclick={() => goto('/stock/assignments')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Stock Assignments
      </button>
      {#if can('manage_stock')}
        <button class="btn-primary" onclick={() => goto('/inventory/intake/tools-stock')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Record opening stock
        </button>
      {/if}
    </div>
  </div>

  <div class="stats-row">
    <StatCard value={loading ? '—' : items.length} label="Stock Items" helper="Distinct SKUs tracked" />
    <StatCard value={loading ? '—' : totalOnHand} label="Units On Hand" helper="Summed across all items" />
    <StatCard value={loading ? '—' : totalCategories} label="Categories" helper="In use across stock" />
  </div>

  <div class="card table-card">
    {#if forbidden}
      <TableStates error="You do not have permission to view tools and stock." />
    {:else if disabled}
      <TableStates error="Tools & Stock is prepared but is not enabled for this environment yet. No stock records are shown or changed while the rollout is disabled." />
    {:else}
      <TableStates
        loading={loading}
        error={error}
        empty={!loading && !error && items.length === 0}
        loadingText="Loading stock…"
        emptyTitle="No stock items yet"
        emptyMessage="Record opening stock to start tracking quantity-managed tools and consumables."
        onRetry={load}
      />
      {#if deleteErr}<div class="action-err">{deleteErr}</div>{/if}
      {#if !loading && !error && items.length > 0}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th><th>U/M</th><th>Quantity</th><th>Count</th><th>Variance</th>
                <th>Model</th><th>Color</th><th>Location</th><th>Acquisition Date</th><th>Serial Number</th><th>Remarks</th><th>As Of Date</th>
                {#if isSuperAdmin}<th>Actions</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each items as item (item.id)}
                {@const details = parseDetails(item.description)}
                {@const v = variance(details, item.balance)}
                <tr>
                  <td>
                    {item.name}
                    <span class="sku">{item.sku}</span>
                  </td>
                  <td>{item.unitOfMeasure}</td>
                  <td>{details.quantity || '—'}</td>
                  <td>{item.balance}</td>
                  <td class:variance-off={v !== null && v !== 0}>{v === null ? '—' : v > 0 ? `+${v}` : v}</td>
                  <td>{details.model || '—'}</td>
                  <td>{details.color || '—'}</td>
                  <td>{details.location || '—'}</td>
                  <td>{details.acquisitionDate || '—'}</td>
                  <td>{details.serial || '—'}</td>
                  <td>{details.remarks || '—'}</td>
                  <td>{details.asOfDate || '—'}</td>
                  {#if isSuperAdmin}
                    <td>
                      <button class="btn-link danger" disabled={deletingId === item.id} onclick={() => deleteItem(item)}>
                        {deletingId === item.id ? 'Archiving…' : 'Delete'}
                      </button>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 16px; height: calc(100vh - 64px); min-height: 0; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-title  { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .page-sub    { font-size: 13px; color: var(--mute); margin-top: 3px; }

  .btn-primary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--r-md);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; border: none;
    background: var(--ink); color: var(--on-primary);
    transition: opacity 120ms ease; line-height: 1;
  }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }

  .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .btn-ghost {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--r-md);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; border: 1px solid var(--hairline);
    background: var(--canvas); color: var(--ink);
    transition: background 100ms ease; line-height: 1;
  }
  .btn-ghost:hover { background: var(--canvas-soft-2); }

  .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); }
  .table-card { overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 0; }

  .action-err {
    margin: 10px 16px 0; padding: 8px 12px;
    background: var(--error-soft); color: var(--error);
    border-radius: var(--r-sm); font-size: 12.5px; font-family: var(--font-sans);
  }

  .table-wrap { overflow: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px 16px; border-top: 1px solid var(--hairline); font-size: 13.5px; font-family: var(--font-sans); white-space: nowrap; }
  th { color: var(--mute); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; border-top: none; background: var(--canvas-soft-2); }
  td { color: var(--body); }
  .sku { display: block; margin-top: 2px; font-size: 11px; color: var(--mute); font-weight: 500; }
  .variance-off { color: var(--error); font-weight: 600; }

  .btn-link {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: 12.5px; font-weight: 500; color: var(--link); font-family: var(--font-sans);
  }
  .btn-link:hover:not(:disabled) { text-decoration: underline; }
  .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-link.danger { color: var(--error); }

  @media (max-width: 900px) { .stats-row { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 640px) { .stats-row { grid-template-columns: 1fr; } .page-header { flex-direction: column; } }
</style>
