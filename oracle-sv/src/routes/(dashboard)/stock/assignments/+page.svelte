<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import { can } from '$lib/utils/permissions';
  import { onChange } from '$lib/ws';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import TableStates from '$lib/components/TableStates.svelte';

  type Status = 'active' | 'pending_return' | 'returned';
  interface ApiAssignment {
    id: string; status: Status; assignedAt: string; returnedAt: string | null;
    returnRequestedAt: string | null; returnNotes: string | null; notes: string | null;
    quantity: number;
    stockItem: { id: string; sku: string; name: string; category: string; unitOfMeasure: string };
    employee: { id: string; name: string; employeeId: string; department: { name: string } | null; branch: { name: string } | null };
    location: { id: string; name: string; branchId: string };
  }
  interface Stats { total: number; active: number; pendingReturn: number; returned: number }

  let assignments = $state<ApiAssignment[]>([]);
  let stats       = $state<Stats>({ total: 0, active: 0, pendingReturn: 0, returned: 0 });
  let loading     = $state(true);
  let error       = $state('');
  let disabled    = $state(false);
  let forbidden   = $state(false);

  let search       = $state('');
  let filterStatus = $state<'all' | Status>('all');

  const statusLabel: Record<Status, string> = { active: 'Active', pending_return: 'Pending Return', returned: 'Returned' };
  const statusClass: Record<Status, string> = { active: 'badge-green', pending_return: 'badge-amber', returned: 'badge-gray' };

  const filtered = $derived(assignments.filter((a) => {
    const q = search.trim().toLowerCase();
    const matchQ = !q || a.employee.name.toLowerCase().includes(q) || a.stockItem.name.toLowerCase().includes(q) || a.stockItem.sku.toLowerCase().includes(q);
    const matchS = filterStatus === 'all' || a.status === filterStatus;
    return matchQ && matchS;
  }));

  async function load() {
    loading = true; error = ''; disabled = false; forbidden = false;
    if (!can('view_stock')) { forbidden = true; loading = false; return; }
    try {
      const [raw, s] = await Promise.all([
        api.get<ApiAssignment[]>('/api/stock/assignments'),
        api.get<Stats>('/api/stock/assignments/stats'),
      ]);
      assignments = raw;
      stats = s;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to load assignments.';
      if (message === 'Tools and stock is disabled.') disabled = true;
      else error = message;
    } finally {
      loading = false;
    }
  }

  // ── Row actions ───────────────────────────────────────────────────────────────
  let actingId  = $state('');
  let actionErr = $state('');

  async function act(id: string, path: string, notes?: string) {
    actingId = id; actionErr = '';
    try {
      if (path === '/return' || path === '') {
        await api.post(`/api/stock/assignments/${id}${path}`, { notes: notes || undefined });
      } else {
        await api.put(`/api/stock/assignments/${id}${path}`, { notes: notes || undefined });
      }
      await load();
    } catch (caught) {
      actionErr = caught instanceof Error ? caught.message : 'Action failed.';
    } finally {
      actingId = '';
    }
  }

  load();
  onDestroy(onChange(['StockAssignment', 'StockMovement'], () => load()));
</script>

<svelte:head><title>Stock Assignments | Tools & Stock | Oracle Inventory</title></svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Tools & Stock', href: '/stock' }, { label: 'Stock Assignments' }]} />

  <div class="page-header">
    <div>
      <h1 class="page-title">Stock Assignments</h1>
      <p class="page-sub">Tools and stock currently checked out to employees, and their return status.</p>
    </div>
    {#if can('manage_stock')}
      <button class="btn-primary" onclick={() => goto('/stock/assignments/assign')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Assign item
      </button>
    {/if}
  </div>

  <div class="stats-row">
    <StatCard value={loading ? '—' : stats.total} label="Total Assignments" helper="All time" />
    <StatCard value={loading ? '—' : stats.active} label="Active" helper="Currently checked out" />
    <StatCard value={loading ? '—' : stats.pendingReturn} label="Pending Return" helper="Awaiting approval" />
    <StatCard value={loading ? '—' : stats.returned} label="Returned" helper="Closed out" />
  </div>

  <div class="card table-card">
    {#if forbidden}
      <TableStates error="You do not have permission to view tools and stock." />
    {:else if disabled}
      <TableStates error="Tools & Stock is prepared but is not enabled for this environment yet." />
    {:else}
      <TableStates
        loading={loading}
        error={error}
        empty={!loading && !error && assignments.length === 0}
        loadingText="Loading assignments…"
        emptyTitle="No assignments yet"
        emptyMessage="Assign a stock item to an employee to start tracking who has what."
        onRetry={load}
      />
      {#if !loading && !error && assignments.length > 0}
        <div class="toolbar">
          <input class="search-input" type="search" placeholder="Search employee, item, or SKU…" bind:value={search} />
          <select class="filter-select" bind:value={filterStatus}>
            <option value="all">All status</option>
            <option value="active">Active</option>
            <option value="pending_return">Pending Return</option>
            <option value="returned">Returned</option>
          </select>
        </div>
        {#if actionErr}<div class="action-err">{actionErr}</div>{/if}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Item</th><th>Quantity</th><th>Location</th>
                <th>Date out</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each filtered as a (a.id)}
                <tr>
                  <td>
                    {a.employee.name}
                    <span class="sub">{a.employee.employeeId}{a.employee.department ? ` · ${a.employee.department.name}` : ''}</span>
                  </td>
                  <td>
                    {a.stockItem.name}
                    <span class="sub">{a.stockItem.sku}</span>
                  </td>
                  <td>{a.quantity} {a.stockItem.unitOfMeasure}</td>
                  <td>{a.location.name}</td>
                  <td>{new Date(a.assignedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td><span class="badge {statusClass[a.status]}">{statusLabel[a.status]}</span></td>
                  <td class="actions">
                    {#if a.status === 'active' && can('manage_stock')}
                      <button class="btn-link" disabled={actingId === a.id} onclick={() => act(a.id, '/request-return')}>Request return</button>
                    {/if}
                    {#if a.status === 'pending_return' && can('approve_transactions')}
                      <button class="btn-link" disabled={actingId === a.id} onclick={() => act(a.id, '/approve-return')}>Approve</button>
                      <button class="btn-link danger" disabled={actingId === a.id} onclick={() => act(a.id, '/reject-return')}>Reject</button>
                    {/if}
                    {#if a.status !== 'returned' && can('approve_transactions')}
                      <button class="btn-link" disabled={actingId === a.id} onclick={() => act(a.id, '/return')}>Return now</button>
                    {/if}
                    {#if a.status === 'returned'}
                      <span class="sub">{a.returnedAt ? new Date(a.returnedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
                    {/if}
                  </td>
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

  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); }
  .table-card { overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 0; }

  .toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--hairline); flex-shrink: 0; flex-wrap: wrap; }
  .search-input {
    flex: 1; min-width: 200px; height: 32px; padding: 0 10px;
    border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink);
    font-size: 13px; font-family: var(--font-sans); outline: none;
  }
  .search-input:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }
  .filter-select {
    height: 32px; padding: 0 8px;
    border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink);
    font-size: 13px; font-family: var(--font-sans); cursor: pointer;
  }

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
  .sub { display: block; margin-top: 2px; font-size: 11px; color: var(--mute); font-weight: 500; }

  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 500; }
  .badge-green { background: oklch(93% 0.06 155); color: oklch(35% 0.15 155); }
  .badge-amber { background: oklch(93% 0.08 80); color: oklch(40% 0.15 70); }
  .badge-gray  { background: var(--canvas-soft-2); color: var(--mute); }

  .actions { display: flex; gap: 10px; align-items: center; }
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
