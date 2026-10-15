<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import { can } from '$lib/utils/permissions';
  import { authStore } from '$lib/stores/auth.svelte';
  import { computerCategoryFor, describeComponents, readBelarcReport, type BelarcMatch, type BelarcReading } from '$lib/utils/belarc';

  interface Option { id: string; name: string; }
  type Action = 'create' | 'update' | 'skip';
  type RowState = 'reading' | 'ready' | 'unreadable' | 'saving' | 'saved' | 'failed';
  interface SaveResult { action: 'created' | 'updated' | 'unchanged'; assetId: string; assetTag: string | null; name: string; filled?: string[]; }
  type CommitResult = ({ index: number; ok: true } & SaveResult) | { index: number; ok: false; error: string };
  interface Row {
    key: string;
    file: File;
    fileName: string;
    state: RowState;
    error: string;
    reading: BelarcReading | null;
    action: Action;
    name: string;
    categoryId: string;
    branchId: string;
    /** Key of an earlier report in this batch for the same computer. */
    sameAs: string | null;
    result: SaveResult | null;
  }

  const STATE_LABEL: Record<RowState, string> = {
    reading: 'Reading…', ready: 'Ready', unreadable: 'Not readable', saving: 'Saving…', saved: 'Saved', failed: 'Not saved',
  };

  const role      = $derived((authStore.user?.role ?? '').trim().toLowerCase());
  const allowed   = $derived(can('create_inventory') && (role === 'admin' || role === 'super_admin'));
  const canUpdate = $derived(can('edit_inventory'));

  let branches        = $state<Option[]>([]);
  let categories      = $state<Option[]>([]);
  let defaultBranchId = $state('');
  let lookupErr       = $state('');
  let rows            = $state<Row[]>([]);
  let dragOver        = $state(false);
  let notice          = $state('');
  let saving          = $state(false);
  let saveErr         = $state('');

  onMount(async () => {
    if (!allowed) return;
    try {
      const lookup = await api.get<{ branches: Option[]; categories: Option[] }>('/api/computer-intake/lookups');
      branches = lookup.branches;
      categories = lookup.categories;
      if (branches.length === 1) defaultBranchId = branches[0].id;
    } catch (e) {
      lookupErr = (e as Error).message;
    }
  });

  // ── Reading ─────────────────────────────────────────────────────────────────
  function pickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    addFiles(files);
  }
  function dropFiles(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  function addFiles(files: File[]) {
    const reports = files.filter(f => /\.html?$/i.test(f.name));
    const ignored = files.length - reports.length;
    notice = ignored ? `${ignored} file${ignored === 1 ? ' was' : 's were'} skipped — only Belarc reports saved as .html can be read.` : '';
    const added: Row[] = reports.map(file => ({
      key: crypto.randomUUID(), file, fileName: file.name, state: 'reading', error: '', reading: null,
      action: 'skip', name: '', categoryId: '', branchId: defaultBranchId, sameAs: null, result: null,
    }));
    rows = [...rows, ...added];
    void readAll(added.map(r => r.key));
  }

  // A few at a time: quick for a big batch without flooding the server.
  async function readAll(keys: string[]) {
    const queue = [...keys];
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) await readOne(key);
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  const rowByKey = (key: string) => rows.find(r => r.key === key);
  const rowNumber = (key: string) => rows.findIndex(r => r.key === key) + 1;
  // A report with nothing the existing record lacks is skipped by default.
  const hasSomethingToFill = (match: BelarcMatch) =>
    match.plan.fields.some(f => f.action === 'fill') || match.plan.components.action === 'fill';
  function defaultAction(r: Row): Action {
    const match = r.reading?.match;
    if (!match) return 'create';
    return canUpdate && hasSomethingToFill(match) ? 'update' : 'skip';
  }

  async function readOne(key: string) {
    const file = rowByKey(key)?.file;
    if (!file) return;
    try {
      const reading = await readBelarcReport(file);
      const row = rowByKey(key);
      if (!row) return; // removed while it was being read
      row.reading = reading;
      row.name = reading.fill.name ?? reading.fill.computerName ?? '';
      row.categoryId = computerCategoryFor(categories, reading.fill.deviceType);
      row.action = defaultAction(row);
      row.state = 'ready';
    } catch (e) {
      const row = rowByKey(key);
      if (!row) return;
      row.state = 'unreadable';
      row.error = (e as Error).message;
    }
    markRepeats();
  }

  // The same computer read twice in one batch is only saved once.
  function markRepeats() {
    const first = new Map<string, string>();
    for (const row of rows) {
      const fill = row.reading?.fill;
      const id = (fill?.serialNumber ?? fill?.macAddress ?? fill?.computerName ?? '').toLowerCase();
      const earlier = id ? first.get(id) ?? null : null;
      if (id && !earlier) first.set(id, row.key);
      if (earlier !== row.sameAs) {
        row.sameAs = earlier;
        if (row.state === 'ready') row.action = earlier ? 'skip' : defaultAction(row);
      }
    }
  }

  function removeRow(key: string) {
    rows = rows.filter(r => r.key !== key);
    markRepeats();
  }

  function clearAll() {
    rows = [];
    notice = '';
    saveErr = '';
  }

  function setDefaultBranch(id: string) {
    for (const row of rows) {
      if (row.state !== 'saved' && (!row.branchId || row.branchId === defaultBranchId)) row.branchId = id;
    }
    defaultBranchId = id;
  }

  // ── Saving ──────────────────────────────────────────────────────────────────
  const toSave    = $derived(rows.filter(r => (r.state === 'ready' || r.state === 'failed') && r.action !== 'skip'));
  const creating  = $derived(toSave.filter(r => r.action === 'create').length);
  const updating  = $derived(toSave.filter(r => r.action === 'update').length);
  const stillReading = $derived(rows.filter(r => r.state === 'reading').length);
  const savedRows = $derived(rows.filter(r => r.state === 'saved'));

  async function saveAll() {
    saveErr = '';
    const queue = [...toSave];
    if (queue.some(r => r.action === 'create' && !r.branchId)) {
      saveErr = 'Choose a branch for every computer being added.';
      return;
    }
    saving = true;
    try {
      for (let i = 0; i < queue.length; i += 5) {
        const batch = queue.slice(i, i + 5);
        for (const row of batch) { row.state = 'saving'; row.error = ''; }
        try {
          const { results } = await api.post<{ results: CommitResult[] }>('/api/belarc-import/commit', {
            items: batch.map(row => ({
              action: row.action,
              fill: row.reading!.fill,
              assetId: row.action === 'update' ? row.reading!.match?.id : undefined,
              name: row.name,
              categoryId: row.categoryId,
              branchId: row.branchId,
              fileName: row.fileName,
            })),
          });
          for (const result of results) {
            const row = batch[result.index];
            if (result.ok) { row.state = 'saved'; row.result = result; }
            else { row.state = 'failed'; row.error = result.error; }
          }
        } catch (e) {
          for (const row of batch) if (row.state === 'saving') { row.state = 'failed'; row.error = (e as Error).message; }
        }
      }
    } finally {
      saving = false;
    }
  }

  function resultText(result: SaveResult): string {
    if (result.action === 'created') return `Added as ${result.assetTag ?? result.name}`;
    if (result.action === 'unchanged') return `${result.assetTag ?? result.name} already had everything in this report`;
    return `Filled on ${result.assetTag ?? result.name}: ${result.filled?.join(', ')}`;
  }
</script>

<svelte:head><title>Import Belarc Reports · Oracle Inventory</title></svelte:head>

<div class="page-wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <button class="crumb-link" onclick={() => goto('/dashboard')}>Dashboard</button>
    <svg class="crumb-sep" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    <button class="crumb-link" onclick={() => goto('/assets')}>Assets</button>
    <svg class="crumb-sep" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    <span class="crumb-current">Import Belarc Reports</span>
  </nav>

  <div class="page-head">
    <div>
      <h1 class="page-title">Import Belarc Reports</h1>
      <p class="page-sub">Add computers, or fill in missing specs on ones already listed, from Belarc Advisor reports. Nothing is saved until you click Save.</p>
    </div>
  </div>

  {#if !allowed}
    <div class="panel notice">Only an Admin or Super Admin with permission to add inventory can import computers.</div>
  {:else}
    {#if lookupErr}<div class="panel notice notice-error" role="alert">{lookupErr}</div>{/if}

    <div class="panel settings">
      <label class="lbl" for="default-branch">Branch for new computers</label>
      <select id="default-branch" class="input" value={defaultBranchId} onchange={(e) => setDefaultBranch(e.currentTarget.value)} disabled={saving}>
        <option value="">Choose branch</option>
        {#each branches as b}<option value={b.id}>{b.name}</option>{/each}
      </select>
      <p class="hint">Each report can still go to a different branch below. Laptops go in the Laptop category and other computers in Desktop; you can change that per report too.</p>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <label
      class="drop"
      class:drop-over={dragOver}
      class:drop-compact={rows.length > 0}
      for="belarc-files"
      ondragover={(e) => { e.preventDefault(); dragOver = true; }}
      ondragleave={() => (dragOver = false)}
      ondrop={dropFiles}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 12v6M9 15l3-3 3 3"/></svg>
      <span class="drop-title">{rows.length ? 'Add more reports' : 'Drop Belarc reports here, or click to choose'}</span>
      {#if !rows.length}
        <span class="drop-hint">Belarc Advisor opens its report in your web browser — save that page (Ctrl+S) as .html, one per computer. You can pick many at once.</span>
      {/if}
    </label>
    <input id="belarc-files" class="file-input" type="file" accept=".html,.htm,text/html" multiple disabled={saving} onchange={pickFiles} />
    {#if notice}<p class="hint hint-warn">{notice}</p>{/if}

    {#if rows.length}
      <div class="reports">
        {#each rows as row, i (row.key)}
          {@const fill = row.reading?.fill}
          {@const match = row.reading?.match}
          <article class="report" class:report-saved={row.state === 'saved'} class:report-bad={row.state === 'unreadable' || row.state === 'failed'} class:report-skip={row.state === 'ready' && row.action === 'skip'}>
            <header class="report-head">
              <span class="report-num">{i + 1}</span>
              <span class="report-file" title={row.fileName}>{row.fileName}</span>
              <span class="chip chip-{row.state}">{STATE_LABEL[row.state]}</span>
              {#if row.state !== 'saving' && row.state !== 'saved' && !saving}
                <button type="button" class="icon-btn" aria-label="Remove {row.fileName}" onclick={() => removeRow(row.key)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              {/if}
            </header>

            {#if row.state === 'reading'}
              <p class="muted">Reading report…</p>
            {:else if row.state === 'unreadable'}
              <p class="error">{row.error}</p>
            {:else if fill}
              <div class="report-body">
                <div>
                  <div class="report-title">
                    {fill.name ?? fill.computerName ?? 'Unnamed computer'}
                    <span class="tag">{fill.deviceType === 'laptop' ? 'Laptop' : 'Desktop'}</span>
                  </div>
                  <dl class="specs">
                    <div><dt>Computer name</dt><dd>{fill.computerName ?? '—'}</dd></div>
                    <div><dt>Serial number</dt><dd class="mono">{fill.serialNumber ?? '—'}</dd></div>
                    <div><dt>Processor</dt><dd>{fill.processor ?? '—'}</dd></div>
                    <div><dt>Memory and storage</dt><dd>{describeComponents(fill.components) || '—'}</dd></div>
                    <div><dt>Operating system</dt><dd>{[fill.operatingSystem, fill.osVersion].filter(Boolean).join(' ') || '—'}</dd></div>
                    <div><dt>MAC address</dt><dd class="mono">{fill.macAddress ?? '—'}</dd></div>
                  </dl>
                  {#if fill.profileDate}<p class="muted small">Report taken {fill.profileDate}</p>{/if}
                </div>

                <div class="report-action">
                  {#if row.state === 'saved' && row.result}
                    <p class="saved">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                      {resultText(row.result)}
                    </p>
                    <a class="link" href="/assets/{row.result.assetId}">Open asset</a>
                  {:else}
                    {#if row.sameAs}
                      <p class="note">Same computer as report {rowNumber(row.sameAs)}, so it is skipped unless you choose otherwise.</p>
                    {/if}
                    {#if match}
                      <p class="note">
                        Already in the inventory:
                        <a class="link" href="/assets/{match.id}" target="_blank" rel="noopener">{[match.assetTag, match.name].filter(Boolean).join(' · ')}</a>{match.branch ? ` (${match.branch.name})` : ''},
                        matched by {match.matchedBy}.{hasSomethingToFill(match) ? '' : ' Everything in this report is already recorded there.'}
                      </p>
                    {:else}
                      <p class="note">Not in the inventory yet.</p>
                    {/if}

                    <label class="lbl" for="action-{row.key}">What to do</label>
                    <select id="action-{row.key}" class="input" bind:value={row.action} disabled={saving}>
                      <option value="create">Add as a new computer</option>
                      {#if match}<option value="update" disabled={!canUpdate}>Fill empty fields on {match.assetTag ?? match.name}{canUpdate ? '' : ' (needs edit permission)'}</option>{/if}
                      <option value="skip">Skip</option>
                    </select>

                    {#if row.action === 'create'}
                      <div class="create-grid">
                        <div class="full">
                          <label class="lbl" for="name-{row.key}">Asset name</label>
                          <input id="name-{row.key}" class="input" bind:value={row.name} disabled={saving} />
                        </div>
                        <div>
                          <label class="lbl" for="cat-{row.key}">Category</label>
                          <select id="cat-{row.key}" class="input" bind:value={row.categoryId} disabled={saving}>
                            <option value="">No category</option>
                            {#each categories as c}<option value={c.id}>{c.name}</option>{/each}
                          </select>
                        </div>
                        <div>
                          <label class="lbl" for="branch-{row.key}">Branch</label>
                          <select id="branch-{row.key}" class="input" class:input-missing={!row.branchId} bind:value={row.branchId} disabled={saving}>
                            <option value="">Choose branch</option>
                            {#each branches as b}<option value={b.id}>{b.name}</option>{/each}
                          </select>
                        </div>
                      </div>
                      {#if match}<p class="hint hint-warn">This adds a second record for a computer that is already listed.</p>{/if}
                    {:else if row.action === 'update' && match}
                      {@const fills = match.plan.fields.filter(f => f.action === 'fill')}
                      {@const differs = match.plan.fields.filter(f => f.action === 'differs')}
                      {@const addRows = match.plan.components.action === 'fill'}
                      <ul class="plan">
                        {#each fills as f}<li class="plan-fill"><span>Fill {f.label}</span><b>{f.report}</b></li>{/each}
                        {#if addRows}<li class="plan-fill"><span>Add RAM and storage</span><b>{describeComponents(fill.components)}</b></li>{/if}
                        {#each differs as f}<li class="plan-keep"><span>Keep {f.label}</span><b>{f.current}</b><em>report says {f.report}</em></li>{/each}
                        {#if match.plan.components.action === 'keep' && match.plan.components.current > 0 && match.plan.components.report > 0}
                          <li class="plan-keep"><span>Keep RAM and storage</span><b>{match.plan.components.current} rows already recorded</b></li>
                        {/if}
                        {#if !fills.length && !addRows}<li class="plan-none">Nothing to fill — everything in this report is already recorded.</li>{/if}
                      </ul>
                    {/if}

                    {#if row.state === 'failed'}<p class="error">{row.error}</p>{/if}
                  {/if}
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>

      <div class="savebar">
        <span class="savebar-text">
          {#if stillReading}Reading {stillReading} report{stillReading === 1 ? '' : 's'}…
          {:else if toSave.length}{[creating ? `${creating} to add` : '', updating ? `${updating} to fill in` : ''].filter(Boolean).join(', ')}
          {:else if savedRows.length}{savedRows.length} saved. Drop more reports to keep going.
          {:else}Nothing selected to save.{/if}
        </span>
        {#if saveErr}<span class="error" role="alert">{saveErr}</span>{/if}
        <span class="savebar-actions">
          <button type="button" class="btn-ghost" onclick={clearAll} disabled={saving}>Clear list</button>
          <button type="button" class="btn-primary" onclick={saveAll} disabled={saving || stillReading > 0 || toSave.length === 0}>
            {saving ? 'Saving…' : toSave.length ? `Save ${toSave.length} computer${toSave.length === 1 ? '' : 's'}` : 'Save'}
          </button>
        </span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .breadcrumb { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  .crumb-link { background: none; border: none; padding: 0; font-size: 12.5px; color: var(--mute); font-family: var(--font-sans); cursor: pointer; transition: color 120ms ease; }
  .crumb-link:hover { color: var(--body); }
  .crumb-sep { color: var(--hairline-strong); flex-shrink: 0; }
  .crumb-current { font-size: 12.5px; color: var(--body); font-family: var(--font-sans); }

  .page-wrap { display: flex; flex-direction: column; width: 100%; gap: 14px; padding-bottom: 24px; }
  .page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
  .page-title { font-size: 22px; font-weight: 700; color: var(--ink); font-family: var(--font-sans); letter-spacing: -0.4px; }
  .page-sub { font-size: 13px; color: var(--mute); font-family: var(--font-sans); margin-top: 2px; max-width: 720px; }

  .panel { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); padding: 16px 18px; font-family: var(--font-sans); }
  .notice { font-size: 13px; color: var(--body); }
  .notice-error { color: var(--error); }
  .settings { display: grid; grid-template-columns: auto minmax(180px, 280px) 1fr; align-items: center; gap: 8px 14px; }
  .settings .lbl { margin: 0; }

  .lbl { display: block; font-size: 12px; font-weight: 500; color: var(--body); font-family: var(--font-sans); margin: 10px 0 4px; }
  .input {
    width: 100%; padding: 7px 10px; border: 1px solid var(--hairline); border-radius: var(--r-sm);
    background: var(--canvas); color: var(--ink); font-family: var(--font-sans); font-size: 13px;
  }
  .input:focus { outline: none; border-color: var(--ink); }
  .input-missing { border-color: var(--warning); }
  .hint { font-size: 12px; color: var(--mute); font-family: var(--font-sans); margin: 0; }
  .hint-warn { color: var(--warning); }

  .drop {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    border: 1px dashed var(--hairline-strong); border-radius: var(--r-lg); background: var(--canvas-soft);
    padding: 36px 24px; text-align: center; cursor: pointer; color: var(--mute); font-family: var(--font-sans);
    transition: border-color 150ms ease, background 150ms ease;
  }
  .drop:hover, .drop-over { border-color: var(--link); background: var(--link-bg-soft, var(--canvas-soft-2)); }
  .drop-compact { flex-direction: row; padding: 12px 16px; }
  .drop-title { font-size: 13px; font-weight: 500; color: var(--ink); }
  .drop-hint { font-size: 12px; max-width: 520px; }
  .file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

  .reports { display: flex; flex-direction: column; gap: 10px; }
  .report { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg); padding: 12px 16px; font-family: var(--font-sans); }
  .report-saved { border-color: oklch(75% 0.12 145); }
  .report-bad { border-color: var(--error); }
  .report-skip { opacity: 0.7; }
  .report-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .report-num {
    width: 22px; height: 22px; border-radius: 999px; background: var(--canvas-soft-2); color: var(--body);
    font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .report-file { font-size: 12.5px; color: var(--mute); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--canvas-soft-2); color: var(--body); white-space: nowrap; }
  .chip-saved { background: oklch(94% 0.05 145); color: oklch(40% 0.12 145); }
  .chip-unreadable, .chip-failed { background: var(--error-soft); color: var(--error); }
  .icon-btn { background: none; border: none; padding: 4px; color: var(--mute); cursor: pointer; border-radius: var(--r-sm); display: flex; }
  .icon-btn:hover { background: var(--canvas-soft-2); color: var(--ink); }

  .report-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; margin-top: 10px; }
  .report-title { font-size: 14px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tag { font-size: 11px; font-weight: 500; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hairline); color: var(--body); }
  .specs { display: grid; grid-template-columns: 1fr; gap: 3px; margin: 8px 0 0; }
  .specs div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px; font-size: 12.5px; }
  .specs dt { color: var(--mute); }
  .specs dd { margin: 0; color: var(--body); overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .muted { font-size: 12.5px; color: var(--mute); margin: 8px 0 0; }
  .small { font-size: 11.5px; }
  .error { font-size: 12.5px; color: var(--error); margin: 8px 0 0; }

  .report-action { border-left: 1px solid var(--hairline); padding-left: 20px; min-width: 0; }
  .note { font-size: 12.5px; color: var(--body); margin: 0 0 4px; }
  .link { color: var(--link); font-weight: 500; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .saved { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; color: oklch(40% 0.12 145); font-weight: 500; margin: 0 0 6px; }
  .saved svg { flex-shrink: 0; margin-top: 2px; }
  .create-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
  .create-grid .full { grid-column: 1 / -1; }

  .plan { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; }
  .plan li { display: grid; grid-template-columns: 150px minmax(0, 1fr); column-gap: 8px; padding: 3px 0; border-top: 1px solid var(--hairline); }
  .plan li span { color: var(--mute); }
  .plan li b { font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
  .plan li em { grid-column: 2; font-style: normal; color: var(--mute); font-size: 11.5px; overflow-wrap: anywhere; }
  .plan-fill span::before { content: '+ '; color: oklch(50% 0.14 145); font-weight: 700; }
  .plan-none { display: block !important; color: var(--mute); }

  .savebar {
    position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-lg);
    padding: 12px 16px; box-shadow: var(--shadow-l2); font-family: var(--font-sans);
  }
  .savebar-text { font-size: 13px; color: var(--body); flex: 1; min-width: 160px; }
  .savebar .error { margin: 0; }
  .savebar-actions { display: flex; gap: 8px; margin-left: auto; }
  .btn-primary { background: var(--ink); color: var(--on-primary, #fff); border: none; border-radius: var(--r-md); padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--font-sans); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { background: none; border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 9px 16px; font-size: 13px; cursor: pointer; color: var(--body); font-family: var(--font-sans); }
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 860px) {
    .settings { grid-template-columns: 1fr; }
    .report-body { grid-template-columns: 1fr; gap: 12px; }
    .report-action { border-left: none; border-top: 1px solid var(--hairline); padding: 12px 0 0; }
    .specs div, .plan li { grid-template-columns: 120px minmax(0, 1fr); }
  }
</style>
