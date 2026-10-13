/** Longest side, in pixels, that a stored asset photo is reduced to. */
const MAX_SIDE = 1600;

/** Photos already under this size and within MAX_SIDE are uploaded untouched. */
const SMALL_ENOUGH_BYTES = 1_000_000;

/**
 * Phone and camera photos run to several megabytes, more than the API accepts
 * in one request, so they are scaled down and re-encoded as JPEG in the
 * browser before upload. Throws when the file is not an image the browser can
 * read.
 */
export async function shrinkPhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" is not a photo this browser can read. Use a JPG, PNG or WebP image.`);
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SMALL_ENOUGH_BYTES) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error(`"${file.name}" could not be prepared for upload.`);
  }
  // JPEG has no transparency; without a backdrop, transparent PNG areas turn black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error(`"${file.name}" could not be prepared for upload.`);
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
}
