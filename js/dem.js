// Modello digitale del terreno: quote da "Terrain Tiles" (formato Terrarium),
// dataset aperto ospitato su AWS, gratuito e senza chiave API.
// Ogni pixel codifica la quota: r*256 + g + b/256 - 32768 metri.

const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const SIZE = 256;
const MAX_TILES = 120;

function tileCoords(lat, lon, z) {
  const n = 2 ** z;
  const φ = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.asinh(Math.tan(φ)) / Math.PI) / 2) * n,
  };
}

export class Dem {
  constructor() {
    this.tiles = new Map();
    this.pending = new Map();
  }

  /** Scarica (se servono) le tessere che coprono i punti dati: [{lat, lon, z}]. */
  async ensure(points) {
    const keys = new Set();
    for (const p of points) {
      const { x, y } = tileCoords(p.lat, p.lon, p.z);
      keys.add(`${p.z}/${Math.floor(x)}/${Math.floor(y)}`);
    }
    // Rinfresca l'ordine d'uso delle tessere richieste, poi scarta le più vecchie.
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (t) { this.tiles.delete(k); this.tiles.set(k, t); }
    }
    for (const k of this.tiles.keys()) {
      if (this.tiles.size <= MAX_TILES) break;
      if (!keys.has(k)) this.tiles.delete(k);
    }
    await Promise.all([...keys].filter((k) => !this.tiles.has(k)).map((k) => this.load(k)));
  }

  load(key) {
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetchTile(key)
        .then((data) => { this.tiles.set(key, data); })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  async fetchTile(key) {
    const [z, x, y] = key.split('/').map(Number);
    const res = await fetch(TILE_URL(z, x, y), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Quote del terreno non disponibili (${res.status})`);
    // Niente conversioni di colore: i byte dei pixel sono dati, non un'immagine.
    const bmp = await createImageBitmap(await res.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(SIZE, SIZE)
      : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const out = new Int16Array(SIZE * SIZE);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.round(px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
    }
    return out;
  }

  /** Quota in metri (interpolata). Richiede che la tessera sia già stata caricata. */
  get(lat, lon, z) {
    const { x, y } = tileCoords(lat, lon, z);
    const tx = Math.floor(x), ty = Math.floor(y);
    const t = this.tiles.get(`${z}/${tx}/${ty}`);
    if (!t) throw new Error('Tessera del terreno non caricata');
    const clamp = (v) => Math.max(0, Math.min(SIZE - 1, v));
    const fx = clamp((x - tx) * SIZE - 0.5), fy = clamp((y - ty) * SIZE - 0.5);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(SIZE - 1, x0 + 1), y1 = Math.min(SIZE - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = t[y0 * SIZE + x0] * (1 - ax) + t[y0 * SIZE + x1] * ax;
    const bot = t[y1 * SIZE + x0] * (1 - ax) + t[y1 * SIZE + x1] * ax;
    return top * (1 - ay) + bot * ay;
  }
}
