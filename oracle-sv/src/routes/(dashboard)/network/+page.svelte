<script lang="ts">
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import NetworkMap, { type MapStats } from '$lib/components/network/NetworkMap.svelte';
  import DeviceCredentials from '$lib/components/network/DeviceCredentials.svelte';

  let activeTab = $state<'map' | 'credentials'>('map');
  let stats = $state<MapStats | null>(null);
</script>

<svelte:head><title>Network — Oracle Inventory</title></svelte:head>

<div class="page">
  <Breadcrumb crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Network' }]} />

  <div class="page-header">
    <h1 class="page-title">Network</h1>
    <p class="page-sub">Where every laptop and desktop connects — switch port, switch, managed switch, firewall and ISP. On Wi-Fi, just the ISP.</p>
  </div>

  <div class="stats-row">
    <StatCard value={stats?.computers ?? '—'} label="Computers" helper="Active laptops & desktops" />
    <StatCard value={stats?.wired ?? '—'} label="Wired" helper="Plugged into a switch port" />
    <StatCard value={stats?.wifi ?? '—'} label="Wi-Fi" helper="ISP only" />
    <StatCard value={stats?.unmapped ?? '—'} label="Not set" helper="No network details yet" />
  </div>

  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected={activeTab === 'map'} class="tab-btn" class:active={activeTab === 'map'} onclick={() => (activeTab = 'map')}>Network map</button>
    <button type="button" role="tab" aria-selected={activeTab === 'credentials'} class="tab-btn" class:active={activeTab === 'credentials'} onclick={() => (activeTab = 'credentials')}>Device credentials</button>
  </div>

  <!-- Kept mounted so the stat cards stay filled while on the credentials tab. -->
  <div hidden={activeTab !== 'map'}><NetworkMap onstats={(s) => (stats = s)} /></div>
  {#if activeTab === 'credentials'}<DeviceCredentials />{/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 16px; }
  .page-title { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; color: var(--ink); }
  .page-sub { font-size: 13px; color: var(--mute); margin-top: 3px; }
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

  .tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--hairline); flex-wrap: wrap; }
  .tab-btn {
    padding: 8px 2px 10px; margin-bottom: -1px;
    border: none; border-bottom: 2px solid transparent;
    background: transparent; color: var(--mute);
    font-size: 13px; font-weight: 500; font-family: var(--font-sans);
    cursor: pointer; transition: color 120ms ease, border-color 120ms ease;
  }
  .tab-btn:hover { color: var(--ink); }
  .tab-btn.active { color: var(--ink); border-bottom-color: var(--ink); }

  @media (max-width: 900px) { .stats-row { grid-template-columns: 1fr 1fr; } }
</style>
