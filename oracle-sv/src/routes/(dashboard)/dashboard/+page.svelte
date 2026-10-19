<svelte:head>
  <title>Dashboard — Oracle Inventory</title>
</svelte:head>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api';
  import { can } from '$lib/utils/permissions';
  import { onChange } from '$lib/ws';
  import { toCsv, downloadCsv } from '$lib/utils/csv';
  import StatCard    from '$lib/components/StatCard.svelte';
  import SectionCard from '$lib/components/SectionCard.svelte';
  import SearchInput from '$lib/components/SearchInput.svelte';

  // ── Types ──────────────────────────────────────────────────────────────────
  interface DeptStat { name: string; assets: number; employees: number; categories?: Record<string, number>; }
  interface BranchDeptStat { id: string; name: string; assets: number; departments: DeptStat[]; }
  interface ConditionCounts { forRepair: number; forDisposal: number; }
  interface ActivityLog {
    id:        string;
    action:    string;
    entity:    string;
    entityId:  string;
    metadata:  Record<string, unknown> | null;
    createdAt: string;
    user:      { id: string; name: string; email: string } | null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let conditionCounts = $state<ConditionCounts | null>(null);
  let deptStats  = $state<DeptStat[]>([]);
  let branchStats = $state<BranchDeptStat[]>([]);
  // Branch picked in the By Department card; null shows every branch
  let selectedBranchId = $state<string | null>(null);
  let activities = $state<ActivityLog[]>([]);
  let loading    = $state(true);
  let loadErr    = $state('');
  let search     = $state('');

  // ── Export (full asset snapshot CSV) ───────────────────────────────────────
  let exporting = $state(false);

  async function exportAllCsv() {
    if (exporting) return;
    exporting = true;
    try {
      const data = await api.get<{
        columns: { key: string; label: string }[];
        rows: Record<string, string>[];
      }>('/api/reports/total-assets');
      const cols = data.columns.flatMap(c =>
        c.key === '_asset' ? [{ key: 'name', label: 'Asset' }, { key: 'id', label: 'Asset ID' }] : [c]
      );
      downloadCsv(toCsv(cols, data.rows), `oracle-inventory-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch {
      alert('Export failed. Please try again.');
    } finally {
      exporting = false;
    }
  }

  // Only the categories a department actually holds, most first
  function heldCategories(counts: Record<string, number> | undefined): [string, number][] {
    return Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  const selectedBranch = $derived(branchStats.find(b => b.id === selectedBranchId) ?? null);
  const shownDepts     = $derived(selectedBranch ? selectedBranch.departments : deptStats);
  const allHeld        = $derived(deptStats.reduce((sum, d) => sum + d.assets, 0));

  const deptTotals = $derived.by(() => {
    const byCategory: Record<string, number> = {};
    for (const d of shownDepts) {
      for (const [name, count] of Object.entries(d.categories ?? {})) byCategory[name] = (byCategory[name] ?? 0) + count;
    }
    return {
      employees: shownDepts.reduce((sum, d) => sum + d.employees, 0),
      assets:    shownDepts.reduce((sum, d) => sum + d.assets, 0),
      byCategory,
    };
  });

  const filteredActivity = $derived(
    activities.filter(a => {
      if (!search) return true;
      const q    = search.toLowerCase();
      const name = String(a.metadata?.name ?? a.entityId ?? '').toLowerCase();
      return name.includes(q) || a.entity.toLowerCase().includes(q);
    })
  );

  // ── Formatters ─────────────────────────────────────────────────────────────
  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-PH', {
      hour: '2-digit', minute: '2-digit',
    });
  }
  function actionLabel(log: ActivityLog): string {
    const name = String(log.metadata?.name ?? log.entityId ?? '');
    const MAP: Record<string, string> = {
      create: 'Created', update: 'Updated', assign: 'Assigned',
      return: 'Returned', delete: 'Deleted', import: 'Imported',
    };
    return `${MAP[log.action] ?? log.action} — ${name}`;
  }
  function statusText(action: string): string {
    if (action === 'assign')                     return 'Assigned';
    if (action === 'return')                     return 'Returned';
    if (action === 'repair' || action === 'maintenance') return 'Maintenance';
    return '';
  }

  // ── Data fetch ─────────────────────────────────────────────────────────────
  async function loadSummary() {
    try {
      if (can('view_reports')) {
        const summary = await api.get<{ kpi: ConditionCounts; deptStats: DeptStat[]; deptStatsByBranch?: BranchDeptStat[] }>('/api/reports/summary');
        conditionCounts = { forRepair: summary.kpi.forRepair, forDisposal: summary.kpi.forDisposal };
        deptStats = summary.deptStats;
        branchStats = summary.deptStatsByBranch ?? [];
      } else if (can('view_inventory')) {
        // The reports summary is closed to this role; the condition counts
        // come from the inventory stats it is allowed to read instead.
        const stats = await api.get<ConditionCounts>('/api/assets/stats');
        conditionCounts = { forRepair: stats.forRepair, forDisposal: stats.forDisposal };
      }
      loadErr = '';
    } catch (e) {
      loadErr = (e as Error).message || 'Dashboard data could not be loaded.';
    }
  }

  async function loadDashboard() {
    // Fetch independently — a 403 on one endpoint must not blank the other
    const [, act] = await Promise.all([
      loadSummary(),
      can('access_logs')
        ? api.get<{ logs: ActivityLog[] }>('/api/activity?limit=15').catch(() => null)
        : Promise.resolve(null),
    ]);
    if (act) activities = act.logs;
    loading = false;
  }

  onMount(() => { void loadDashboard(); });
  onDestroy(onChange(['Asset', 'Assignment', 'Employee'], () => loadDashboard()));
</script>

<div class="page">

  <!-- ── Page header ──────────────────────────────────────────────────────── -->
  <div class="page-header">
    <div>
      <h1 class="page-title">Overview</h1>
      <p class="page-sub">Summary of overall inventory data</p>
    </div>
    {#if can('view_reports')}
      <div class="header-actions">
        <button class="btn-export" onclick={exportAllCsv} disabled={exporting}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
    {/if}
  </div>

  {#if loadErr}
    <div class="load-error" role="alert">
      <span>Dashboard data could not be loaded: {loadErr}</span>
      <button class="load-error-retry" onclick={() => loadDashboard()}>Retry</button>
    </div>
  {/if}

  <!-- ── Condition counts ─────────────────────────────────────────────────── -->
  {#if can('view_reports') || can('view_inventory')}
    <div class="stat-row">
      <StatCard
        label="Under Repair"
        helper="Currently being serviced"
        value={(conditionCounts?.forRepair ?? 0).toLocaleString()}
        {loading}
        href={can('view_inventory') ? '/assets?condition=for_repair' : undefined}
      />
      <StatCard
        label="For Disposal"
        helper="Flagged for retirement"
        value={(conditionCounts?.forDisposal ?? 0).toLocaleString()}
        {loading}
        href={can('view_inventory') ? '/assets?condition=for_disposal' : undefined}
      />
    </div>
  {/if}

  <!-- ── By department ────────────────────────────────────────────────────── -->
  <SectionCard
    title="By Department"
    subtitle={selectedBranch ? `Assets held per department in ${selectedBranch.name}` : 'Assets held per department · click a branch to see only that branch'}
    flush
  >
    {#if loading}
      <div class="table-empty">Loading…</div>
    {:else if !deptStats.length && !branchStats.length}
      <div class="table-empty">No department data yet.</div>
    {:else}
      <div class="dept-summary" role="group" aria-label="Show one branch">
        {#each branchStats as b (b.id)}
          {@const active = selectedBranchId === b.id}
          <button type="button" class="dept-tile" class:dept-tile-active={active} aria-pressed={active} onclick={() => (selectedBranchId = active ? null : b.id)}>
            <span class="dept-tile-name" title={b.name}>{b.name}</span>
            <span class="dept-tile-value">{b.assets}</span>
            <span class="dept-tile-sub">{b.assets === 1 ? 'asset' : 'assets'} held · {b.departments.length} {b.departments.length === 1 ? 'department' : 'departments'}</span>
          </button>
        {/each}
        <button type="button" class="dept-tile" class:dept-tile-active={!selectedBranch} aria-pressed={!selectedBranch} onclick={() => (selectedBranchId = null)}>
          <span class="dept-tile-name">Total</span>
          <span class="dept-tile-value">{allHeld}</span>
          <span class="dept-tile-sub">{allHeld === 1 ? 'asset' : 'assets'} held · all branches</span>
        </button>
      </div>
      {#if !shownDepts.length}
        <div class="table-empty">No assets are held in {selectedBranch?.name ?? 'any department'} yet.</div>
      {:else}
        <div class="table-scroll">
          <table class="data-table dept-table">
            <thead>
              <tr>
                <th>Department</th>
                <th class="td-r">Employees</th>
                <th>Assets Held</th>
                <th class="td-r">Total</th>
              </tr>
            </thead>
            <tbody>
              {#each shownDepts as d}
                <tr>
                  <td class="td-name">{d.name}</td>
                  <td class="td-r td-mono">{d.employees}</td>
                  <td class="td-chips">
                    <div class="cat-chips">
                      {#each heldCategories(d.categories) as [name, count]}<span class="cat-chip">{name} <b>{count}</b></span>{/each}
                    </div>
                  </td>
                  <td class="td-r td-mono td-total">{d.assets}</td>
                </tr>
              {/each}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td class="td-r td-mono">{deptTotals.employees}</td>
                <td class="td-chips">
                  <div class="cat-chips">
                    {#each heldCategories(deptTotals.byCategory) as [name, count]}<span class="cat-chip">{name} <b>{count}</b></span>{/each}
                  </div>
                </td>
                <td class="td-r td-mono">{deptTotals.assets}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      {/if}
    {/if}
  </SectionCard>

  <!-- ── Recent activity ──────────────────────────────────────────────────── -->
  <SectionCard title="Recent Activity" subtitle="Last 15 events" flush>
    {#snippet action()}
      <SearchInput bind:value={search} placeholder="Search activity…" />
    {/snippet}

    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Activity</th>
            <th>Type</th>
            <th>By</th>
            <th>Date</th>
            <th>Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {#if loading}
            <tr><td colspan="6" class="table-empty">Loading…</td></tr>
          {:else if filteredActivity.length === 0}
            <tr><td colspan="6" class="table-empty">No activity yet.</td></tr>
          {:else}
            {#each filteredActivity as row}
              {@const status = statusText(row.action)}
              <tr>
                <td>
                  <span class="act-label">{actionLabel(row)}</span>
                </td>
                <td class="td-mono td-mute">{row.entity}</td>
                <td>{row.user?.name ?? '—'}</td>
                <td class="td-mono td-mute">{fmtDate(row.createdAt)}</td>
                <td class="td-mono td-mute">{fmtTime(row.createdAt)}</td>
                <td>
                  {#if status}
                    <span
                      class="badge"
                      class:badge--assigned={status === 'Assigned'}
                      class:badge--returned={status === 'Returned'}
                      class:badge--maintenance={status === 'Maintenance'}
                    >{status}</span>
                  {:else}
                    <span class="badge">{row.action}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </SectionCard>

</div>

<style>
  .load-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 1px solid var(--error); border-radius: var(--r-md); background: var(--error-soft); color: var(--error); font-size: 13px; }
  .load-error-retry { border: 1px solid var(--error); background: transparent; color: var(--error); border-radius: var(--r-sm); padding: 4px 10px; font-size: 12px; cursor: pointer; }

  /* ── Page layout ── */
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    min-width: 0;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--ink);
    font-family: var(--font-sans);
    letter-spacing: -0.5px;
    line-height: 1.2;
  }

  .page-sub {
    font-size: 13px;
    color: var(--mute);
    font-family: var(--font-sans);
    margin-top: 3px;
  }

  /* ── Export button ── */
  .btn-export {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    border-radius: var(--r-md);
    font-size: 13px;
    font-weight: 500;
    font-family: var(--font-sans);
    cursor: pointer;
    border: 1px solid var(--hairline);
    background: var(--canvas);
    color: var(--ink);
    transition: background 100ms ease;
    line-height: 1;
    flex-shrink: 0;
  }

  .btn-export:hover:not(:disabled) { background: var(--canvas-soft-2); }
  .btn-export:disabled { opacity: 0.55; cursor: not-allowed; }

  /* ── Stat cards ── */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  /* ── Shared table chrome ── */
  .table-scroll {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
  }

  .data-table th {
    font-size: 11px;
    font-weight: 500;
    color: var(--mute);
    font-family: var(--font-mono);
    text-align: left;
    padding: 8px 20px;
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    background: var(--canvas-soft);
    white-space: nowrap;
    letter-spacing: 0.2px;
    text-transform: uppercase;
  }

  .data-table td {
    padding: 11px 20px;
    font-size: 13px;
    font-family: var(--font-sans);
    color: var(--body);
    border-bottom: 1px solid var(--hairline);
    white-space: nowrap;
  }

  .data-table tbody tr:last-child td { border-bottom: none; }
  .data-table tbody tr:hover td { background: var(--canvas-soft); }

  .table-empty {
    text-align: center;
    color: var(--mute);
    font-size: 13px;
    font-family: var(--font-sans);
    padding: 28px 20px;
  }

  .td-r    { text-align: right; }
  .td-mono { font-family: var(--font-mono); font-size: 12px; }
  .td-mute { color: var(--mute); }
  .td-name { font-weight: 500; color: var(--ink); }

  /* ── Branch tiles, then Total; the active one filters the table ── */
  .dept-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    padding: 14px 20px;
  }
  .dept-tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--r-md);
    background: var(--canvas-soft-2);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .dept-tile:hover { background: var(--canvas-soft); border-color: var(--hairline-strong); }
  .dept-tile:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  /* Up to two lines, so long names stay readable and the numbers line up */
  .dept-tile-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--body);
    line-height: 1.35;
    min-height: 2.7em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .dept-tile-value {
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.5px;
    line-height: 1.1;
    margin-top: 2px;
  }
  .dept-tile-sub { font-size: 11px; color: var(--mute); }
  .dept-tile-active, .dept-tile-active:hover { background: var(--ink); border-color: var(--ink); }
  .dept-tile-active .dept-tile-name,
  .dept-tile-active .dept-tile-value { color: var(--on-primary, #fff); }
  .dept-tile-active .dept-tile-sub { color: var(--on-primary, #fff); opacity: 0.7; }

  /* ── Department table: categories held ── */
  .dept-table .td-total { font-weight: 600; color: var(--ink); }
  .dept-table .td-chips { white-space: normal; min-width: 220px; width: 50%; }
  .cat-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .cat-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    border-radius: var(--r-full);
    border: 1px solid var(--hairline);
    background: var(--canvas-soft-2);
    font-size: 12px;
    font-weight: 500;
    color: var(--body);
    white-space: nowrap;
  }
  .cat-chip b { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
  .dept-table tfoot td {
    font-weight: 600;
    color: var(--ink);
    background: var(--canvas-soft);
    border-top: 1px solid var(--hairline);
    border-bottom: none;
  }
  /* On a phone a long department name would fill the screen; let it wrap */
  @media (max-width: 640px) {
    .dept-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 16px; }
    .dept-table td:first-child { white-space: normal; min-width: 120px; }
    .dept-table .td-chips { min-width: 180px; }
  }

  /* ── Activity table specific ── */
  .act-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--ink);
    font-family: var(--font-sans);
  }

  /* ── Status badges ── */
  .badge {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--r-full);
    font-size: 11px;
    font-weight: 500;
    font-family: var(--font-sans);
    background: var(--canvas-soft-2);
    color: var(--mute);
    border: 1px solid var(--hairline);
  }

  .badge--assigned    { background: oklch(94% 0.04 152); color: oklch(38% 0.16 152); border-color: oklch(88% 0.06 152); }
  .badge--returned    { background: oklch(94% 0.04 264); color: oklch(40% 0.18 264); border-color: oklch(88% 0.06 264); }
  .badge--maintenance { background: oklch(95% 0.06  80); color: oklch(45% 0.16  80); border-color: oklch(88% 0.08  80); }
</style>
