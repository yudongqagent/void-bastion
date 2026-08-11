// Texture loading, with a real progress bar and a persistent cache.
//
// Three properties matter here, in this order:
//
//   1. THE GAME NEVER WAITS. Textures are an enhancement, not a dependency.
//      The renderer boots with materials off and falls back to the original
//      position-based shading, so a slow link, a failed fetch or a browser with
//      no Cache Storage costs surface detail and nothing else. Nothing in this
//      file is allowed to block or throw into the boot path.
//   2. PROGRESS IS REAL. The bar is driven by Content-Length and streamed
//      chunks, not by a timer pretending to be one. A stalled download shows a
//      stalled bar, which is the honest thing to show.
//   3. REPEAT VISITS ARE FREE. Filenames carry a content hash, so a cached
//      entry is valid forever and a regenerated atlas simply misses under its
//      new name. No cache-busting query strings, no staleness, no versioning.

const CACHE_NAME = 'void-bastion-tex-v1';

/** Fetch one URL, reporting bytes as they arrive. Resolves to a Blob. */
async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);

  // Without a readable body or a length we cannot report progress; take the
  // whole thing and count it once rather than faking a ramp.
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const blob = await res.blob();
    onBytes(blob.size, blob.size);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, total);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || 'image/png' });
}

/**
 * Load the material atlases.
 *
 * @param {(frac:number, label:string)=>void} onProgress 0..1
 * @returns {Promise<{albedo:ImageBitmap, surface:ImageBitmap}|null>} null when
 *   textures are unavailable for any reason — callers treat that as "run
 *   without materials", never as an error.
 */
export async function loadMaterials(base, onProgress = () => {}) {
  try {
    const manifest = await (await fetch(base + 'manifest.json')).json();
    const names = [manifest.material, manifest.surface,
      manifest.craft_albedo, manifest.craft_surface].filter(Boolean);
    if (names.length < 2) return null;

    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch {
      // Private browsing, or an insecure origin. Fall through to plain fetch.
    }

    // Sizes are unknown until headers arrive, so weight the two files equally
    // and track each one's own fraction. Overstating early progress is the
    // usual sin of loading bars; this cannot, because it only ever reports
    // bytes that actually landed.
    const frac = names.map(() => 0);
    const report = (i, got, total) => {
      frac[i] = total ? got / total : 1;
      onProgress(frac.reduce((a, v) => a + v, 0) / frac.length, 'materials');
    };

    const blobs = await Promise.all(names.map(async (name, i) => {
      const url = base + name;
      if (cache) {
        const hit = await cache.match(url);
        if (hit) { report(i, 1, 1); return hit.blob(); }
      }
      const blob = await fetchWithProgress(url, (got, total) => report(i, got, total));
      if (cache) {
        // Store under the hashed name; a later regeneration misses cleanly.
        try { await cache.put(url, new Response(blob, { headers: { 'content-type': 'image/png' } })); }
        catch { /* quota, or a private window — not worth failing the load for */ }
      }
      return blob;
    }));

    const imgs = await Promise.all(blobs.map((b) => createImageBitmap(b)));
    onProgress(1, 'materials');
    return {
      albedo: imgs[0], surface: imgs[1],
      craftAlbedo: imgs[2] || null, craftSurface: imgs[3] || null,
      craftGrid: manifest.craftGrid || 5,
      craftOrder: manifest.craftOrder || null,
    };
  } catch (err) {
    console.warn('[void-bastion] materials unavailable, running untextured:', err);
    return null;
  }
}

/** Evict every cached atlas. Exposed for debugging, not used by the game. */
export async function clearMaterialCache() {
  try { return await caches.delete(CACHE_NAME); } catch { return false; }
}
