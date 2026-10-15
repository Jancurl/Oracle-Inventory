<script lang="ts">
  import { readBelarcReport, type BelarcApplied, type BelarcDiff, type BelarcReading } from '$lib/utils/belarc';

  interface Props {
    /** Puts the report's values into the form and says what changed. */
    apply: (reading: BelarcReading) => BelarcApplied & { notes?: string[] };
    /** Puts the form back the way it was before the last fill. */
    undo: () => void;
    /** Warn when the report matches a computer that is already in the inventory. */
    warnExisting?: boolean;
    disabled?: boolean;
  }
  let { apply, undo, warnExisting = false, disabled = false }: Props = $props();

  const inputId = $props.id();
  let busy  = $state(false);
  let error = $state('');
  let result = $state<{ reading: BelarcReading; filled: string[]; differs: BelarcDiff[]; notes: string[]; used: string[] } | null>(null);

  async function choose(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true; error = ''; result = null;
    try {
      const reading = await readBelarcReport(file);
      const applied = apply(reading);
      result = { reading, filled: applied.filled, differs: applied.differs, notes: applied.notes ?? [], used: [] };
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function useReportValue(diff: BelarcDiff) {
    if (!result) return;
    diff.use();
    result.used = [...result.used, diff.label];
  }

  function undoFill() {
    undo();
    result = null;
  }
</script>

<div class="belarc">
  <div class="belarc-bar">
    <label class="belarc-btn" class:belarc-btn-busy={busy || disabled} for={inputId}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6M9 15l3 3 3-3"/></svg>
      {busy ? 'Reading report…' : 'Fill from Belarc report'}
    </label>
    <input id={inputId} class="belarc-input" type="file" accept=".html,.htm,text/html" disabled={busy || disabled} onchange={choose} />
    <span class="belarc-hint">Pick the computer's Belarc Advisor report (.html). Empty fields are filled in for you to check — nothing is saved until you save.</span>
  </div>

  {#if error}<p class="belarc-error" role="alert">{error}</p>{/if}

  {#if result}
    {@const match = result.reading.match}
    <div class="belarc-result" role="status">
      <p class="belarc-summary">
        <strong>{result.filled.length ? `Filled ${result.filled.length} field${result.filled.length === 1 ? '' : 's'}` : 'Nothing new to fill'}</strong>
        from {result.reading.fileName}{result.reading.fill.profileDate ? `, a report taken ${result.reading.fill.profileDate}` : ''}.
        {#if result.filled.length}Check them before saving.{/if}
      </p>
      {#if result.filled.length}<p class="belarc-filled">{result.filled.join(' · ')}</p>{/if}
      {#each result.notes as note}<p class="belarc-filled">{note}</p>{/each}

      {#if warnExisting && match}
        <p class="belarc-warn">
          This computer may already be in the inventory:
          <a href="/assets/{match.id}">{[match.assetTag, match.name].filter(Boolean).join(' · ')}</a>{match.branch ? ` (${match.branch.name})` : ''},
          matched by {match.matchedBy}. To update it instead, open it and use Edit → Fill from Belarc report.
        </p>
      {/if}

      {#if result.differs.length}
        <p class="belarc-sub">Already filled in with something else — your value was kept:</p>
        <ul class="belarc-diffs">
          {#each result.differs as diff (diff.label)}
            <li>
              <span class="belarc-diff-label">{diff.label}</span>
              <span class="belarc-diff-values"><span>Yours: <b>{diff.current}</b></span><span>Report: <b>{diff.report}</b></span></span>
              {#if result.used.includes(diff.label)}
                <span class="belarc-used">Using report value</span>
              {:else}
                <button type="button" class="belarc-link" onclick={() => useReportValue(diff)}>Use report value</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="belarc-actions">
        <button type="button" class="belarc-link" onclick={undoFill}>Undo fill</button>
        <button type="button" class="belarc-link belarc-link-mute" onclick={() => (result = null)}>Dismiss</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .belarc { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .belarc-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .belarc-btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
    border-radius: var(--r-sm); border: 1px solid var(--hairline-strong); background: var(--canvas);
    color: var(--ink); font-family: var(--font-sans); font-size: 13px; font-weight: 500; cursor: pointer;
    white-space: nowrap; transition: background 120ms ease, border-color 120ms ease;
  }
  .belarc-btn:hover { background: var(--canvas-soft-2); }
  .belarc-btn-busy { opacity: 0.6; pointer-events: none; }
  .belarc-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .belarc-hint { font-size: 12px; color: var(--mute); flex: 1; min-width: 200px; }
  .belarc-error { margin: 0; font-size: 13px; color: var(--error); }
  .belarc-result {
    border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--canvas-soft);
    padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--body);
  }
  .belarc-result p { margin: 0; }
  .belarc-summary strong { color: var(--ink); }
  .belarc-filled { color: var(--mute); font-size: 12px; }
  .belarc-warn { padding: 8px 10px; border-radius: var(--r-sm); background: var(--warning-soft); color: var(--ink); }
  .belarc-warn a { color: var(--link); font-weight: 500; }
  .belarc-sub { font-weight: 500; color: var(--ink); }
  .belarc-diffs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .belarc-diffs li {
    display: grid; grid-template-columns: 130px 1fr auto; gap: 8px; align-items: baseline;
    padding: 5px 0; border-top: 1px solid var(--hairline);
  }
  .belarc-diff-label { font-weight: 500; color: var(--ink); }
  .belarc-diff-values { display: flex; flex-direction: column; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
  .belarc-diff-values b { font-weight: 500; color: var(--ink); }
  .belarc-used { font-size: 12px; color: var(--mute); }
  .belarc-actions { display: flex; gap: 14px; }
  .belarc-link {
    background: none; border: none; padding: 0; color: var(--link); font-family: var(--font-sans);
    font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap;
  }
  .belarc-link:hover { text-decoration: underline; }
  .belarc-link-mute { color: var(--mute); }
  @media (max-width: 560px) {
    .belarc-diffs li { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
