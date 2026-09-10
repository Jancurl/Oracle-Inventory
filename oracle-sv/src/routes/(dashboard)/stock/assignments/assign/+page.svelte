<script lang="ts">
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import { can } from '$lib/utils/permissions';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';

  interface ApiEmployee { id: string; name: string; employeeId: string; department: { name: string } | null }
  interface ApiStockItem { id: string; sku: string; name: string; unitOfMeasure: string; balance: number }
  interface ApiLocation { id: string; name: string }
  interface Page<T> { items: T[] }

  let employeeQuery    = $state('');
  let employees         = $state<ApiEmployee[]>([]);
  let employeeLoading   = $state(false);
  let selectedEmployee  = $state<ApiEmployee | null>(null);

  let itemQuery    = $state('');
  let items        = $state<ApiStockItem[]>([]);
  let itemLoading  = $state(false);
  let selectedItem = $state<ApiStockItem | null>(null);

  let locations       = $state<ApiLocation[]>([]);
  let locationsLoaded  = $state(false);
  let locationId       = $state('');

  let quantity   = $state('');
  let notes      = $state('');
  let saving     = $state(false);
  let error      = $state('');

  let empDebounce: ReturnType<typeof setTimeout>;
  $effect(() => {
    const term = employeeQuery;
    if (selectedEmployee) return;
    clearTimeout(empDebounce);
    empDebounce = setTimeout(async () => {
      employeeLoading = true;
      try {
        const qs = new URLSearchParams({ isActive: 'true', limit: '8' });
        if (term.trim()) qs.set('q', term.trim());
        const resp = await api.get<Page<ApiEmployee>>(`/api/employees?${qs}`);
        employees = resp.items;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : 'Unable to load employees.';
      } finally {
        employeeLoading = false;
      }
    }, 250);
    return () => clearTimeout(empDebounce);
  });

  let itemDebounce: ReturnType<typeof setTimeout>;
  $effect(() => {
    const term = itemQuery;
    if (selectedItem) return;
    clearTimeout(itemDebounce);
    itemDebounce = setTimeout(async () => {
      itemLoading = true;
      try {
        const qs = new URLSearchParams({ pageSize: '8' });
        if (term.trim()) qs.set('q', term.trim());
        const resp = await api.get<{ items: ApiStockItem[] }>(`/api/stock/items?${qs}`);
        items = resp.items;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : 'Unable to load stock items.';
      } finally {
        itemLoading = false;
      }
    }, 250);
    return () => clearTimeout(itemDebounce);
  });

  async function ensureLocationsLoaded() {
    if (locationsLoaded) return;
    try {
      const resp = await api.get<Page<ApiLocation>>('/api/stock/locations');
      locations = resp.items;
      locationsLoaded = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to load locations.';
    }
  }

  const canSubmit = $derived(
    Boolean(selectedEmployee) && Boolean(selectedItem) && Boolean(locationId) &&
    Number.isFinite(Number(quantity)) && Number(quantity) > 0 && !saving
  );

  async function submit() {
    if (!canSubmit || !selectedEmployee || !selectedItem) return;
    error = '';
    saving = true;
    try {
      await api.post('/api/stock/assignments', {
        stockItemId: selectedItem.id,
        employeeId: selectedEmployee.id,
        locationId,
        quantity: Number(quantity),
        notes: notes.trim() || undefined,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      await goto('/stock/assignments');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to create assignment.';
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>Assign Item | Tools & Stock | Oracle Inventory</title></svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Tools & Stock', href: '/stock' }, { label: 'Stock Assignments', href: '/stock/assignments' }, { label: 'Assign Item' }]} />

  <div class="page-header">
    <div>
      <h1 class="page-title">Assign item</h1>
      <p class="page-sub">Issue a quantity of a stock item to an employee. Reduces the on-hand count at the chosen location until it's returned.</p>
    </div>
    <div class="header-actions">
      <button type="button" class="btn-ghost" onclick={() => goto('/stock/assignments')} disabled={saving}>Cancel</button>
      <button type="submit" form="assign-form" class="btn-primary" disabled={!canSubmit}>{saving ? 'Assigning…' : 'Assign item'}</button>
    </div>
  </div>

  {#if !can('manage_stock')}
    <div class="card notice-card">
      <h2 class="notice-title">Permission required</h2>
      <p class="notice-text">You do not have permission to assign stock items.</p>
    </div>
  {:else}
    {#if error}<div class="form-error">{error}</div>{/if}

    <form id="assign-form" onsubmit={(event) => { event.preventDefault(); submit(); }} class="form-body">
      <section class="card">
        <div class="card-header"><h2 class="card-title">Employee</h2></div>
        <div class="card-body">
          {#if selectedEmployee}
            <div class="picked-row">
              <div>
                <div class="picked-name">{selectedEmployee.name}</div>
                <div class="picked-sub">{selectedEmployee.employeeId}{selectedEmployee.department ? ` · ${selectedEmployee.department.name}` : ''}</div>
              </div>
              <button type="button" class="change-link" onclick={() => { selectedEmployee = null; employeeQuery = ''; }}>Change</button>
            </div>
          {:else}
            <input class="field-input" type="search" placeholder="Search employee name or ID…" bind:value={employeeQuery} />
            <div class="pick-list">
              {#if employeeLoading}
                <div class="pick-empty">Loading…</div>
              {:else if employees.length === 0}
                <div class="pick-empty">No employees match your search.</div>
              {:else}
                {#each employees as emp}
                  <button type="button" class="pick-row" onclick={() => { selectedEmployee = emp; }}>
                    <span>{emp.name}</span>
                    <span class="pick-sub">{emp.employeeId}{emp.department ? ` · ${emp.department.name}` : ''}</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      </section>

      <section class="card">
        <div class="card-header"><h2 class="card-title">Stock item</h2></div>
        <div class="card-body">
          {#if selectedItem}
            <div class="picked-row">
              <div>
                <div class="picked-name">{selectedItem.name}</div>
                <div class="picked-sub">{selectedItem.sku} · {selectedItem.balance} {selectedItem.unitOfMeasure} on hand</div>
              </div>
              <button type="button" class="change-link" onclick={() => { selectedItem = null; itemQuery = ''; }}>Change</button>
            </div>
          {:else}
            <input class="field-input" type="search" placeholder="Search item name or SKU…" bind:value={itemQuery} />
            <div class="pick-list">
              {#if itemLoading}
                <div class="pick-empty">Loading…</div>
              {:else if items.length === 0}
                <div class="pick-empty">No items match your search.</div>
              {:else}
                {#each items as it}
                  <button type="button" class="pick-row" onclick={() => { selectedItem = it; ensureLocationsLoaded(); }}>
                    <span>{it.name}</span>
                    <span class="pick-sub">{it.sku} · {it.balance} {it.unitOfMeasure} on hand</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      </section>

      <section class="card">
        <div class="card-header"><h2 class="card-title">Details</h2></div>
        <div class="card-body">
          <div class="fields-grid">
            <div class="field">
              <label class="field-label" for="location">Issue from location <span class="required">*</span></label>
              <select id="location" class="field-select" bind:value={locationId} onfocus={ensureLocationsLoaded}>
                <option value="">Select a location…</option>
                {#each locations as loc}<option value={loc.id}>{loc.name}</option>{/each}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="quantity">Quantity <span class="required">*</span></label>
              <input id="quantity" type="number" min="1" step="1" class="field-input" bind:value={quantity} placeholder="e.g. 1" />
            </div>
          </div>
          <div class="field field-textarea">
            <label class="field-label" for="notes">Notes <span class="optional">(optional)</span></label>
            <textarea id="notes" class="field-textarea-input" bind:value={notes} rows="3" maxlength="1000" placeholder="Reason for issuing, condition notes…"></textarea>
          </div>
        </div>
      </section>
    </form>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 16px; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-title  { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .page-sub    { font-size: 13px; color: var(--mute); margin-top: 3px; max-width: 560px; }

  .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

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

  .btn-ghost {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 13px; border-radius: var(--r-md);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; border: 1px solid var(--hairline);
    background: var(--canvas); color: var(--ink);
    transition: background 100ms ease; line-height: 1;
  }
  .btn-ghost:hover:not(:disabled) { background: var(--canvas-soft-2); }
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

  .form-body { display: flex; flex-direction: column; gap: 16px; }

  .card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); }
  .card-header { padding: 16px 20px 12px; border-bottom: 1px solid var(--hairline); }
  .card-title { font-size: 14px; font-weight: 600; color: var(--ink); font-family: var(--font-sans); letter-spacing: -0.2px; }
  .card-body { padding: 20px; display: flex; flex-direction: column; gap: 12px; }

  .notice-card { padding: 20px; }
  .notice-title { font-size: 14px; font-weight: 600; color: var(--ink); margin: 0 0 6px; }
  .notice-text { font-size: 13px; color: var(--body); margin: 0; }

  .fields-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 12.5px; font-weight: 500; color: var(--body); font-family: var(--font-sans); letter-spacing: -0.1px; }
  .required { color: var(--error); }
  .optional { color: var(--mute); font-weight: 400; }

  .field-input, .field-select {
    height: 34px; padding: 0 10px;
    border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink);
    font-size: 13.5px; font-family: var(--font-sans);
    outline: none; transition: border-color 120ms ease, box-shadow 120ms ease;
    width: 100%;
  }
  .field-select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
    cursor: pointer;
  }
  .field-input:focus, .field-select:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }
  .field-input::placeholder { color: var(--mute); }

  .field-textarea-input {
    width: 100%; padding: 10px 12px;
    border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink);
    font-size: 13.5px; font-family: var(--font-sans);
    outline: none; resize: vertical; line-height: 1.5;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .field-textarea-input:focus { border-color: var(--link); box-shadow: 0 0 0 3px var(--link-bg-soft); }

  .form-error {
    padding: 10px 14px; background: var(--error-soft); color: var(--error);
    border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans);
  }

  /* Pick lists (employee / stock item) */
  .pick-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--hairline); border-radius: var(--r-sm); }
  .pick-row {
    display: flex; flex-direction: column; gap: 2px; width: 100%;
    padding: 8px 12px; border: none; border-bottom: 1px solid var(--hairline);
    background: var(--canvas); text-align: left; cursor: pointer; font-family: var(--font-sans);
    font-size: 13px; color: var(--ink); transition: background 100ms ease;
  }
  .pick-row:last-child { border-bottom: none; }
  .pick-row:hover { background: var(--canvas-soft); }
  .pick-sub { font-size: 11.5px; color: var(--mute); }
  .pick-empty { padding: 16px 12px; text-align: center; font-size: 12.5px; color: var(--mute); }

  .picked-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 2px; }
  .picked-name { font-size: 13.5px; font-weight: 500; color: var(--ink); }
  .picked-sub  { font-size: 12px; color: var(--mute); margin-top: 2px; }
  .change-link { background: none; border: none; padding: 0; font-size: 12.5px; font-weight: 500; color: var(--link); cursor: pointer; font-family: var(--font-sans); flex-shrink: 0; }
  .change-link:hover { text-decoration: underline; }

  @media (max-width: 900px) { .fields-grid { grid-template-columns: 1fr; } }
  @media (max-width: 600px) { .page-header { flex-direction: column; } .header-actions { width: 100%; } .header-actions .btn-ghost, .header-actions .btn-primary { flex: 1; justify-content: center; } }
</style>
