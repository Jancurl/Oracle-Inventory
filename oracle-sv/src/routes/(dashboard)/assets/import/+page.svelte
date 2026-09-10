<script lang="ts">
  import { goto } from '$app/navigation';
  import { authStore } from '$lib/stores/auth.svelte';
  import { can } from '$lib/utils/permissions';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import StatCard from '$lib/components/StatCard.svelte';

  const TEMPLATE_COLUMNS = ['Tool', 'Brand', 'Model', 'Color', 'Acquisition Date', 'Serial Number', 'Quantity', 'Remarks'];

  let file        = $state<File | null>(null);
  let dragOver    = $state(false);
  let uploading   = $state(false);
  let error       = $state('');
  let result      = $state<{ created: number; skipped: number; errors: { row: number; tool: string; message: string }[] } | null>(null);

  function fmtSize(bytes: number) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setFile(f: File | null) {
    file = f;
    result = null;
    error = '';
  }

  function onFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    setFile(input.files?.[0] ?? null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) setFile(dropped);
  }

  async function downloadTemplate() {
    const res = await fetch('/api/stock/import/template', {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });
    if (!res.ok) { error = 'Could not download the template.'; return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tools-stock-import-template.xlsx';
    a.click(); URL.revokeObjectURL(url);
  }

  async function upload() {
    if (!file) { error = 'Choose a file first.'; return; }
    error = ''; result = null; uploading = true;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/stock/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authStore.token}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) { error = data.error ?? 'Import failed.'; return; }
      result = data;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to import file.';
    } finally {
      uploading = false;
    }
  }
</script>

<svelte:head><title>Import Tools | Oracle Inventory</title></svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Tools & Stock', href: '/stock' }, { label: 'Import Tools' }]} />

  <div class="page-header">
    <div>
      <h1 class="page-title">Import tools</h1>
      <p class="page-sub">Bulk-add tools to Tools &amp; Stock from an Excel file. Rows whose Remarks mention "disposed" are added as inactive with no stock quantity; everything else is added as active stock.</p>
    </div>
    <div class="header-actions">
      <button type="button" class="btn-ghost" onclick={() => goto('/stock')}>Back to Tools &amp; Stock</button>
    </div>
  </div>

  {#if !can('manage_stock')}
    <div class="panel notice-panel">
      <h2 class="notice-title">Permission required</h2>
      <p class="notice-text">You do not have permission to import stock items.</p>
    </div>
  {:else}
    {#if error}
      <div class="form-error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v5" stroke-linecap="round"/><circle cx="12" cy="16" r="0.75" fill="currentColor" stroke="none"/></svg>
        <span>{error}</span>
      </div>
    {/if}

    <div class="panel">
      <div class="step-head"><span class="step-num">1</span> Download the template</div>
      <p class="step-hint">Use this exact column layout — the importer only accepts files matching this header row.</p>
      <div class="template-cols" aria-hidden="true">
        {#each TEMPLATE_COLUMNS as col}<span class="col-chip">{col}</span>{/each}
      </div>
      <button type="button" class="btn-outline" onclick={downloadTemplate}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v12" stroke-linecap="round"/><path d="M7 10l5 5 5-5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke-linecap="round"/></svg>
        Download template
      </button>
    </div>

    <div class="panel">
      <div class="step-head"><span class="step-num">2</span> Upload your file</div>
      <label
        class="dropzone"
        class:drag-over={dragOver}
        ondragover={(e) => { e.preventDefault(); dragOver = true; }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span>Drop your Excel file here, or <span class="link">browse</span></span>
        <span class="hint">Accepted: .xlsx, .xls — must match the template above</span>
        <input type="file" accept=".xlsx,.xls" onchange={onFileInput} hidden />
      </label>

      {#if file}
        <div class="file-status">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          <span class="file-name">{file.name}</span>
          <span class="file-size">{fmtSize(file.size)}</span>
        </div>
      {/if}

      <div class="header-actions">
        <button type="button" class="btn-primary" disabled={!file || uploading} onclick={upload}>
          {uploading ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>

    {#if result}
      <div class="panel">
        <div class="step-head"><span class="step-num">3</span> Result</div>
        <div class="result-grid">
          <StatCard value={result.created} label="Created" />
          <StatCard value={result.skipped} label="Skipped" helper="already existed" />
          <StatCard value={result.errors.length} label="Errors" />
        </div>

        {#if result.errors.length}
          <div class="error-table-wrap">
            <table class="error-table">
              <thead><tr><th>Row</th><th>Tool</th><th>Error</th></tr></thead>
              <tbody>
                {#each result.errors as e}
                  <tr><td>{e.row}</td><td>{e.tool}</td><td>{e.message}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <div class="header-actions" style="margin-top: 14px;">
          <button type="button" class="btn-primary" onclick={() => goto('/stock')}>View Tools &amp; Stock →</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 16px; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-title  { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .page-sub    { font-size: 13px; color: var(--mute); margin-top: 3px; max-width: 620px; }

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

  .btn-outline {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 7px 14px; border-radius: var(--r-md);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; border: 1px solid var(--hairline-strong, var(--hairline));
    background: var(--canvas); color: var(--ink);
    transition: background 100ms ease, border-color 100ms ease;
  }
  .btn-outline:hover { background: var(--canvas-soft-2); border-color: var(--ink); }

  .panel {
    background: var(--canvas); border: 1px solid var(--hairline);
    border-radius: var(--r-md, 8px); padding: 18px 20px;
    display: flex; flex-direction: column; gap: 12px;
  }

  .notice-panel { padding: 20px; }
  .notice-title { font-size: 14px; font-weight: 600; color: var(--ink); margin: 0 0 6px; }
  .notice-text { font-size: 13px; color: var(--body); margin: 0; }

  .step-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--ink); }
  .step-num {
    width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
    background: var(--ink); color: var(--on-primary, #fff);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600;
  }
  .step-hint { font-size: 12.5px; color: var(--mute); margin: -4px 0 0; }

  .template-cols { display: flex; flex-wrap: wrap; gap: 6px; }
  .col-chip {
    font-size: 12px; font-family: var(--font-mono); color: var(--body);
    background: var(--canvas-soft-2); border: 1px solid var(--hairline);
    border-radius: var(--r-sm, 6px); padding: 4px 9px;
  }

  .dropzone {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 30px 16px; cursor: pointer; text-align: center;
    border: 1.5px dashed var(--hairline-strong, var(--hairline)); border-radius: var(--r-md, 8px);
    color: var(--body); font-size: 13px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .dropzone:hover, .dropzone.drag-over { border-color: var(--ink); background: var(--canvas-soft-2); }
  .dropzone .link { text-decoration: underline; }
  .dropzone .hint { font-size: 12px; color: var(--mute); }

  .file-status {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: var(--r-sm, 6px);
    background: var(--canvas-soft-2); border: 1px solid var(--hairline);
    font-size: 13px; color: var(--ink);
  }
  .file-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-size { color: var(--mute); flex-shrink: 0; margin-left: auto; }

  .form-error {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; background: var(--error-soft); color: var(--error);
    border-radius: var(--r-sm); font-size: 13px; font-family: var(--font-sans);
  }

  .result-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .result-grid { grid-template-columns: 1fr; } }

  .error-table-wrap { overflow-x: auto; border: 1px solid var(--hairline); border-radius: var(--r-sm, 6px); }
  .error-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-family: var(--font-sans); }
  .error-table th, .error-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--hairline); }
  .error-table tr:last-child td { border-bottom: none; }
  .error-table th { color: var(--mute); font-weight: 500; background: var(--canvas-soft-2); }

  @media (max-width: 600px) { .page-header { flex-direction: column; } .header-actions { width: 100%; } }
</style>
