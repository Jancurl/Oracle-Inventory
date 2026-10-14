<script lang="ts">
  import { api } from '$lib/api';
  import { avatarStore, userPhotoPath } from '$lib/stores/avatars.svelte';
  import { shrinkAvatar } from '$lib/utils/photo';
  import UserAvatar from './UserAvatar.svelte';

  interface Props {
    userId: string;
    name: string;
    size?: number;
    canEdit?: boolean;
  }
  let { userId, name, size = 72, canEdit = false }: Props = $props();

  let busy = $state(false);
  let error = $state('');
  const hasPhoto = $derived(!!avatarStore.url(userPhotoPath(userId)));
  const inputId = $derived(`avatar-input-${userId}`);

  async function failure(res: Response): Promise<string> {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return body.error ?? `Could not save the photo (HTTP ${res.status}).`;
  }

  async function choose(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const original = input.files?.[0];
    input.value = '';
    if (!original) return;
    busy = true; error = '';
    try {
      const photo = await shrinkAvatar(original);
      const form = new FormData();
      form.append('file', photo);
      const res = await api.raw(`/api/users/${userId}/avatar`, { method: 'PUT', body: form });
      if (!res.ok) throw new Error(await failure(res));
      avatarStore.set(userPhotoPath(userId), photo);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    busy = true; error = '';
    try {
      const res = await api.raw(`/api/users/${userId}/avatar`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await failure(res));
      avatarStore.set(userPhotoPath(userId), null);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="avatar-editor">
  <UserAvatar id={userId} {name} {size} />
  {#if canEdit}
    <div class="avatar-actions">
      <label class="avatar-btn" class:avatar-btn-busy={busy} for={inputId}>
        {busy ? 'Saving…' : hasPhoto ? 'Change photo' : 'Add photo'}
      </label>
      <input id={inputId} class="avatar-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onchange={choose} />
      {#if hasPhoto}
        <button type="button" class="avatar-btn avatar-btn-remove" disabled={busy} onclick={remove}>Remove</button>
      {/if}
    </div>
    {#if error}<span class="avatar-error" role="alert">{error}</span>{/if}
  {/if}
</div>

<style>
  .avatar-editor { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .avatar-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
  .avatar-btn {
    padding: 4px 10px; border-radius: var(--r-sm); border: 1px solid var(--hairline);
    background: var(--canvas); color: var(--body); font-family: var(--font-sans);
    font-size: 12px; font-weight: 500; cursor: pointer; line-height: 1.4;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .avatar-btn:hover { background: var(--canvas-soft-2); border-color: var(--hairline-strong); }
  .avatar-btn-remove { color: var(--error); }
  .avatar-btn-busy, .avatar-btn:disabled { opacity: 0.6; pointer-events: none; }
  .avatar-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .avatar-error { font-size: 12px; color: var(--error); text-align: center; max-width: 220px; }
</style>
