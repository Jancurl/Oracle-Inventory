import { api } from '$lib/api';

/** Where a login account's profile photo is served. */
export const userPhotoPath = (id: string) => `/api/users/${id}/avatar`;
/** Where an employee's profile photo is served. */
export const employeePhotoPath = (id: string) => `/api/employees/${id}/photo`;

// photo path → object URL of the image; '' once we know there is none.
// Photos need the auth header, so each is fetched once and shared by every
// place that shows the same person (table row, profile, sidebar).
let photos = $state<Record<string, string>>({});
const loading = new Set<string>();

function remember(path: string, url: string) {
  const previous = photos[path];
  if (previous) URL.revokeObjectURL(previous);
  photos = { ...photos, [path]: url };
}

export const avatarStore = {
  /** The photo's URL, '' when there is none, undefined while still unknown. */
  url(path: string): string | undefined {
    return photos[path];
  },

  /** Fetch the photo unless it is already known or on its way. */
  async load(path: string) {
    if (path in photos || loading.has(path)) return;
    loading.add(path);
    try {
      const res = await api.raw(path);
      remember(path, res.ok ? URL.createObjectURL(await res.blob()) : '');
    } catch {
      remember(path, '');
    } finally {
      loading.delete(path);
    }
  },

  /** Record a photo just uploaded (or null when it was removed) without refetching. */
  set(path: string, photo: Blob | null) {
    remember(path, photo ? URL.createObjectURL(photo) : '');
  },

  /** The caller already knows there is no photo — skip the request. */
  markNone(path: string) {
    if (!(path in photos)) remember(path, '');
  },
};
