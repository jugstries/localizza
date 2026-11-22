// Geometria pura: nessuna dipendenza dal browser, così è testabile da sola.
// Convenzioni: angoli in gradi verso l'esterno, azimut da nord in senso orario,
// distanze e quote in metri. Sistema "mondo": x = est, y = nord, z = alto.

export const R_EARTH = 6371008.8;
// Coefficiente di rifrazione atmosferica standard: la luce curva un po' verso
// il basso, quindi si vede leggermente "oltre" l'orizzonte geometrico.
export const REFRACTION = 0.13;
export const EYE_HEIGHT = 1.7;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => wrap360(a + 180) - 180;

/** Punto raggiunto partendo da (lat, lon) lungo l'azimut `az` per `d` metri. */
export function destination(lat, lon, az, d) {
  const φ1 = lat * D2R, λ1 = lon * D2R, θ = az * D2R, δ = d / R_EARTH;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * sinφ2,
  );
  return { lat: φ2 * R2D, lon: wrap180(λ2 * R2D) };
}

export function distance(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R;
  const dφ = φ2 - φ1, dλ = (lon2 - lon1) * D2R;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, dλ = (lon2 - lon1) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return wrap360(Math.atan2(y, x) * R2D);
}

/** Di quanto un punto a distanza d "scende" sotto il piano orizzontale dell'osservatore. */
export const curvatureDrop = (d) => (d * d) / (2 * R_EARTH) * (1 - REFRACTION);

/** Angolo di elevazione (gradi) con cui si vede una quota `h` a distanza `d` da quota `h0`. */
export const elevationAngle = (h0, h, d) => Math.atan2(h - curvatureDrop(d) - h0, d) * R2D;

/**
 * Matrice di rotazione dispositivo -> mondo dagli angoli DeviceOrientation
 * (alpha, beta, gamma secondo la specifica W3C, Z-X'-Y'').
 */
export function rotationMatrix(alpha, beta, gamma) {
  const z = alpha * D2R, x = beta * D2R, y = gamma * D2R;
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const cX = Math.cos(x), sX = Math.sin(x);
  const cY = Math.cos(y), sY = Math.sin(y);
  return [
    cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX,
    -cX * sY, sX, cX * cY,
  ];
}

/**
 * Direzione nel mondo del raggio che passa per un punto dello schermo.
 * tanX / tanY: tangente dell'angolo rispetto all'asse ottico (destra / alto positivi),
 * screenAngle: screen.orientation.angle (0 = verticale).
 */
export function rayFromMatrix(m, tanX = 0, tanY = 0, screenAngle = 0) {
  const a = screenAngle * D2R;
  const dx = tanX * Math.cos(a) + tanY * Math.sin(a);
  const dy = -tanX * Math.sin(a) + tanY * Math.cos(a);
  const dz = -1; // la fotocamera posteriore guarda lungo -z del dispositivo
  const e = m[0] * dx + m[1] * dy + m[2] * dz;
  const n = m[3] * dx + m[4] * dy + m[5] * dz;
  const u = m[6] * dx + m[7] * dy + m[8] * dz;
  const len = Math.hypot(e, n, u);
  return { az: wrap360(Math.atan2(e, n) * R2D), el: Math.asin(u / len) * R2D };
}

/** Separazione angolare (gradi) fra due direzioni azimut/elevazione. */
export function angularSeparation(az1, el1, az2, el2) {
  const a1 = az1 * D2R, e1 = el1 * D2R, a2 = az2 * D2R, e2 = el2 * D2R;
  const c = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(a1 - a2);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

const zoomFor = (d) => (d < 40000 ? 11 : 10);

function sampleDistances(maxDist) {
  const out = [];
  let d = 15;
  while (d < maxDist) {
    out.push(d);
    d += Math.min(250, Math.max(10, d * 0.008));
  }
  return out;
}

/** Quota degli occhi dell'osservatore, presa dal modello del terreno. */
export async function observerHeight(dem, lat, lon) {
  await dem.ensure([{ lat, lon, z: 11 }]);
  return Math.max(dem.get(lat, lon, 11), 0) + EYE_HEIGHT;
}

/**
 * Profilo di ciò che si vede guardando lungo l'azimut `az`.
 * `dem` deve offrire `ensure(punti)` (asincrono) e `get(lat, lon, z)` (sincrono).
 *
 * Ritorna { h0, visible, segments }:
 *  - `visible`: i campioni non coperti da terreno più vicino, in ordine di
 *    distanza (e quindi di angolo crescente), mare compreso;
 *  - `segments`: gli stessi campioni di terraferma raggruppati in tratti
 *    continui (es. la riva vicina, la costa di fronte, il crinale dietro).
 */
export async function castProfile(dem, obs, az, maxDist = 150000) {
  const h0 = await observerHeight(dem, obs.lat, obs.lon);
  const dists = sampleDistances(maxDist);
  const pts = dists.map((d) => ({ ...destination(obs.lat, obs.lon, az, d), d, z: zoomFor(d) }));
  await dem.ensure(pts);

  const visible = [];
  const segments = [];
  let current = null;
  let maxAng = -Infinity;
  for (const p of pts) {
    const raw = dem.get(p.lat, p.lon, p.z);
    const elev = Math.max(raw, 0);
    // Il rilievo ha pixel di ~60 m e include edifici: vicino all'osservatore
    // piccoli dossi fasulli non devono coprire il panorama. Si alza quindi
    // l'occhio di qualche metro (effetto trascurabile sui punti lontani).
    const el = elevationAngle(h0 + Math.min(8, p.d * 0.03), elev, p.d);
    if (el <= maxAng) { current = null; continue; }
    maxAng = el;
    const s = { lat: p.lat, lon: p.lon, dist: p.d, elev, el, land: raw > 0 };
    visible.push(s);
    if (!s.land) { current = null; continue; }
    if (!current) {
      const last = segments[segments.length - 1];
      const gap = last ? p.d - last[last.length - 1].dist : Infinity;
      if (gap < Math.max(500, p.d * 0.05)) current = last;
      else segments.push(current = []);
    }
    current.push(s);
  }
  return { h0, az, visible, segments };
}

/**
 * Sceglie cosa si sta indicando con l'elevazione `el` lungo un profilo.
 * L'inclinometro del telefono sbaglia di 1-2°, quindi non si prende alla
 * lettera il primo punto colpito: si cerca il tratto di terraferma visibile
 * più vicino in angolo, sfavorendo ciò che sta a pochi passi (chi inquadra
 * l'orizzonte non sta chiedendo del terreno sotto i piedi).
 *
 * Con `index` si forza un tratto preciso (comandi "più vicino / più lontano").
 * Ritorna { kind: 'land', index, point, miss } oppure { kind: 'sea' | 'sky', nearest }.
 */
export function pickTarget(profile, el, index = null) {
  const { segments, visible } = profile;
  const closest = (seg) => seg.reduce((a, b) => (Math.abs(b.el - el) < Math.abs(a.el - el) ? b : a));
  const missOf = (seg) => {
    if (el < seg[0].el) return el - seg[0].el;
    const top = seg[seg.length - 1].el;
    return el > top ? el - top : 0;
  };

  let best = index;
  if (best == null) {
    let bestScore = Infinity;
    segments.forEach((seg, i) => {
      const near = closest(seg).dist < 1000 && el > -4;
      const score = Math.abs(missOf(seg)) + (near ? 1.5 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    });
  }
  if (best == null) {
    return { kind: visible.some((s) => s.el >= el) ? 'sea' : 'sky', nearest: null };
  }
  const miss = missOf(segments[best]);
  if (index == null && Math.abs(miss) > 1.5) {
    const water = visible.find((s) => s.el >= el);
    return { kind: water ? 'sea' : 'sky', nearest: best, dist: water && water.dist };
  }
  return { kind: 'land', index: best, point: closest(segments[best]), miss };
}

/**
 * Direzione e visibilità di un punto noto (es. un paese) dall'osservatore.
 * `visible` è falso se il terreno in mezzo lo copre.
 */
export async function sightTo(dem, obs, h0, lat, lon) {
  const dist = distance(obs.lat, obs.lon, lat, lon);
  const az = bearing(obs.lat, obs.lon, lat, lon);
  const n = Math.round(Math.min(400, Math.max(20, dist / 150)));
  const pts = [{ lat, lon, z: zoomFor(dist) }];
  for (let i = 1; i < n; i++) {
    const d = (dist * 0.97 * i) / n;
    pts.push({ ...destination(obs.lat, obs.lon, az, d), d, z: zoomFor(d) });
  }
  await dem.ensure(pts);
  const elev = Math.max(dem.get(lat, lon, zoomFor(dist)), 0);
  // Un paese non è un punto a livello del suolo: campanili e case sporgono.
  const el = elevationAngle(h0, elev + 10, dist);
  let visible = true;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (elevationAngle(h0, Math.max(dem.get(p.lat, p.lon, p.z), 0), p.d) > el + 0.05) {
      visible = false;
      break;
    }
  }
  return { az, el, dist, elev, visible };
}

/** Posizione del sole (azimut ed elevazione in gradi), precisione ~0.1°. */
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15;
  const ha = wrap360(gmst + lon) * D2R - ra;
  const φ = lat * D2R;
  const el = Math.asin(Math.sin(φ) * Math.sin(dec) + Math.cos(φ) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(φ) - Math.sin(φ) * Math.cos(ha));
  return { az: wrap360(az * R2D), el: el * R2D };
}

const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const compassPoint = (az) => WINDS[Math.round(wrap360(az) / 45) % 8];
