<script lang="ts">
  import { avatarStore, employeePhotoPath, userPhotoPath } from '$lib/stores/avatars.svelte';
  import { avatarColor, initials } from '$lib/utils/avatarColor';

  interface Props {
    id: string;
    name: string;
    /** A login account (Users page) or an employee record. */
    kind?: 'user' | 'employee';
    size?: number;
    /** false when the caller already knows there is no photo; leave unset when unknown. */
    hasPhoto?: boolean;
    /** Shown instead of the stored photo, e.g. a new one picked but not saved yet. */
    preview?: string;
  }
  let { id, name, kind = 'user', size = 36, hasPhoto, preview }: Props = $props();

  const path = $derived(kind === 'employee' ? employeePhotoPath(id) : userPhotoPath(id));

  $effect(() => {
    if (!id) return;
    if (hasPhoto === false) avatarStore.markNone(path);
    else void avatarStore.load(path);
  });

  const url = $derived(preview ?? avatarStore.url(path) ?? '');
</script>

{#if url}
  <img class="user-avatar" src={url} alt="" style="width:{size}px;height:{size}px" />
{:else}
  <span
    class="user-avatar user-avatar-initials"
    style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.36)}px;background:{avatarColor(id)}"
    aria-hidden="true"
  >{initials(name)}</span>
{/if}

<style>
  .user-avatar { border-radius: 999px; flex-shrink: 0; object-fit: cover; display: block; }
  .user-avatar-initials {
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-family: var(--font-sans); letter-spacing: 0.3px;
    color: oklch(99% 0.003 106);
  }
</style>
