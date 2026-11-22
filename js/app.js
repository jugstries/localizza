import {
  rayFromMatrix, castRay, sightTo, angularSeparation, sunPosition,
  compassPoint, wrap180, wrap360,
} from './geo.js';
import { Dem } from './dem.js';
import { findPlaces, reverseGeocode } from './places.js';
import { Orientation, startCamera, watchPosition } from './sensors.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;

// ---------- Impostazioni (ricordate sul telefono) ----------

const DEFAULTS = { fov: 65, head: 0, pitch: 0, dist: 150 };
const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('localizza') || '{}'));
} catch { /* archivio non disponibile: si usano i valori predefiniti */ }
const saveSettings = () => {
  try { localStorage.setItem('localizza', JSON.stringify(settings)); } catch { /* idem */ }
};

// ---------- Stato ----------

const dem = new Dem();
const orientation = new Orientation();
let position = null;
let zoom = 1;
let zoomBase = 1;
let camera = null;
let busy = false;
let map = null;
let mapLayer = null;

const video = $('video');
const view = $('view');

// ---------- Dal tocco sullo schermo alla direzione nel mondo ----------

/** Tangenti degli angoli (destra, alto) fra l'asse ottico e il punto toccato. */
function tapTangents(x, y) {
  const W = view.clientWidth, H = view.clientHeight;
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  // Il video riempie lo schermo ritagliando i bordi (object-fit: cover).
  const scale = Math.max(W / vw, H / vh);
  const focal = (Math.max(vw, vh) / 2 / Math.tan((settings.fov / 2) * D2R)) * (zoom / zoomBase);
  return {
    tanX: (x - W / 2) / scale / focal,
    tanY: -(y - H / 2) / scale / focal,
  };
}

function directionAt(x, y) {
  if (!orientation.matrix) return null;
  const { tanX, tanY } = tapTangents(x, y);
  const angle = (screen.orientation && screen.orientation.angle) || 0;
  const ray = rayFromMatrix(orientation.matrix, tanX, tanY, angle);
  return { az: wrap360(ray.az + settings.head), el: ray.el + settings.pitch };
}

const centerDirection = () => directionAt(view.clientWidth / 2, view.clientHeight / 2);

// ---------- Identificazione ----------

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 20000 ? 1 : 0)} km`);

async function identify(dir) {
  const obs = position;
  const hit = await castRay(dem, obs, dir.az, dir.el, settings.dist * 1000);

  let target = hit;
  let note = null;
  if (hit.type === 'sky') {
    // Un piccolo errore d'inclinazione basta a "mancare" un crinale: se il
    // raggio passa appena sopra, si usa il crinale in quella direzione.
    if (hit.gap > 4 || hit.horizon.elev <= 0) return { kind: 'sky', dir, hit };
    target = { ...hit.horizon, type: 'terrain' };
    note = `Il punto toccato risulta ${hit.gap.toFixed(1)}° sopra il profilo del terreno: ti mostro il crinale in quella direzione.`;
  }
  if (target.type === 'sea') return { kind: 'sea', dir, hit: target };

  // Raggio di ricerca: copre circa 8° di errore della bussola a quella distanza.
  const radius = Math.min(20000, Math.max(1500, target.dist * Math.tan(8 * D2R)));
  const [placesRes, areaRes] = await Promise.allSettled([
    findPlaces(target.lat, target.lon, radius),
    reverseGeocode(target.lat, target.lon),
  ]);

  let candidates = [];
  if (placesRes.status === 'fulfilled') {
    const refEl = hit.type === 'sky' ? target.el : dir.el;
    candidates = await Promise.all(placesRes.value.map(async (p) => {
      const s = await sightTo(dem, obs, hit.h0, p.lat, p.lon);
      const sep = angularSeparation(dir.az, refEl, s.az, s.el);
      return { ...p, ...s, sep, score: sep + (s.visible ? 0 : 2.5) - p.weight };
    }));
    candidates.sort((a, b) => a.score - b.score);
  }
  return {
    kind: 'land', dir, hit: target, note, obs,
    candidates: candidates.slice(0, 6),
    area: areaRes.status === 'fulfilled' ? areaRes.value : null,
    placesFailed: placesRes.status === 'rejected',
  };
}

// ---------- Scheda dei risultati ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const mapsLink = (lat, lon, text) => el('a', {
  href: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`,
  target: '_blank', rel: 'noopener', textContent: text,
});

function showSheet(...nodes) {
  $('sheet-body').replaceChildren(...nodes);
  $('sheet').hidden = false;
  $('hint').hidden = true;
  $('zoom-bar').hidden = true;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('marker').hidden = true;
  $('hint').hidden = false;
  $('zoom-bar').hidden = !(camera && camera.zoom);
}

function render(result) {
  const { dir } = result;
  const dirText = `direzione ${compassPoint(dir.az)} ${Math.round(dir.az)}°`;
  $('map').hidden = result.kind !== 'land';

  if (result.kind === 'sky') {
    showSheet(
      el('p', { className: 'eyebrow', textContent: 'Nessun terreno' }),
      el('h2', { textContent: 'Cielo' }),
      el('p', { className: 'facts', textContent: `In ${dirText} non c'è terreno visibile entro ${settings.dist} km. Tocca più in basso, sul profilo del paesaggio.` }),
    );
    return;
  }
  if (result.kind === 'sea') {
    showSheet(
      el('p', { className: 'eyebrow', textContent: 'Acqua' }),
      el('h2', { textContent: 'Mare' }),
      el('p', { className: 'facts', textContent: `Superficie dell'acqua a circa ${fmtDist(result.hit.dist)}, ${dirText}. Per una costa lontana tocca un po' più in alto.` }),
    );
    return;
  }

  const { hit, candidates, area } = result;
  const best = candidates[0];
  const nodes = [
    el('p', { className: 'eyebrow', textContent: best ? `${best.label} · più probabile` : 'Punto del terreno' }),
    el('h2', { textContent: best ? best.name : (area || 'Luogo senza nome') }),
    el('p', {
      className: 'facts',
      textContent: [
        `a ${fmtDist(best ? best.dist : hit.dist)}`,
        `${Math.round(best ? best.elev : hit.elev)} m s.l.m.`,
        dirText,
        best && best.population ? `${best.population.toLocaleString('it-IT')} abitanti` : null,
      ].filter(Boolean).join(' · '),
    }),
  ];
  if (area) nodes.push(el('p', { className: 'small', textContent: `Zona del punto toccato: ${area}` }));
  if (result.note) nodes.push(el('p', { className: 'note', textContent: result.note }));
  if (result.placesFailed) {
    nodes.push(el('p', { className: 'note', textContent: 'Non sono riuscito a scaricare i nomi dei luoghi (rete lenta o servizio occupato). Il punto sulla mappa è comunque quello calcolato.' }));
  }
  nodes.push(el('div', { className: 'links' },
    mapsLink(best ? best.lat : hit.lat, best ? best.lon : hit.lon, 'Apri in Google Maps'),
    ...(best ? [el('a', {
      href: `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(best.name)}`,
      target: '_blank', rel: 'noopener', textContent: 'Cerca su Wikipedia',
    })] : []),
  ));

  if (candidates.length > 1) {
    nodes.push(el('h3', { textContent: 'Potrebbe anche essere' }));
    const list = el('ul');
    for (const c of candidates.slice(1)) {
      const side = wrap180(c.az - dir.az);
      const item = el('li', {},
        el('span', { className: 'name', textContent: `${c.name} — ${c.label.toLowerCase()}` }),
        el('span', {
          className: 'meta',
          textContent: `${fmtDist(c.dist)} · ${Math.abs(side).toFixed(1)}° ${side < 0 ? 'a sinistra' : 'a destra'}${c.visible ? '' : ' · nascosto'}`,
        }),
      );
      item.addEventListener('click', () => map && map.setView([c.lat, c.lon], 13));
      list.append(item);
    }
    nodes.push(list);
  }
  showSheet(...nodes);
  drawMap(result);
}

function drawMap({ obs, hit, candidates }) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  L.polyline([[obs.lat, obs.lon], [hit.lat, hit.lon]], { color: '#ffb020', weight: 3 }).addTo(mapLayer);
  L.circleMarker([obs.lat, obs.lon], { radius: 6, color: '#fff', fillColor: '#2f7de1', fillOpacity: 1 })
    .bindTooltip('Tu').addTo(mapLayer);
  L.circleMarker([hit.lat, hit.lon], { radius: 7, color: '#201400', fillColor: '#ffb020', fillOpacity: 1 })
    .bindTooltip('Punto toccato').addTo(mapLayer);
  candidates.forEach((c, i) => {
    L.circleMarker([c.lat, c.lon], {
      radius: i === 0 ? 6 : 4, color: '#fff', weight: 1,
      fillColor: i === 0 ? '#e5484d' : '#6b7c8c', fillOpacity: 1,
    }).bindTooltip(c.name, { permanent: i === 0 }).addTo(mapLayer);
  });
  map.invalidateSize();
  map.fitBounds(L.latLngBounds([[obs.lat, obs.lon], [hit.lat, hit.lon]]).pad(0.2));
}

function showError(message) {
  $('map').hidden = true;
  showSheet(
    el('p', { className: 'eyebrow', textContent: 'Non riuscito' }),
    el('h2', { textContent: 'Riprova' }),
    el('p', { className: 'facts', textContent: message }),
  );
}

// ---------- Tocco ----------

view.addEventListener('pointerup', async (e) => {
  if (e.target.closest('#hud, #zoom-bar') || busy || !$('sun').hidden) return;
  if (!$('sheet').hidden) { closeSheet(); return; }

  const marker = $('marker');
  marker.style.left = `${e.clientX}px`;
  marker.style.top = `${e.clientY}px`;
  marker.hidden = false;

  // La direzione va letta subito: mentre si aspetta la rete il telefono si muove.
  const dir = directionAt(e.clientX, e.clientY);
  if (!position) return showError('Sto ancora aspettando la posizione GPS. Mettiti all\'aperto e riprova fra qualche secondo.');
  if (!dir) return showError('La bussola del telefono non sta inviando dati.');

  busy = true;
  marker.classList.add('busy');
  try {
    render(await identify(dir));
  } catch (err) {
    console.error(err);
    showError(`Serve una connessione a internet per scaricare il rilievo del terreno. (${err.message})`);
  } finally {
    busy = false;
    marker.classList.remove('busy');
  }
});

$('sheet-close').addEventListener('click', closeSheet);

// ---------- Barra in alto ----------

function updateHud() {
  const dir = centerDirection();
  if (dir) {
    $('hud-dir').textContent = `${compassPoint(dir.az)} ${Math.round(dir.az)}° · ${dir.el >= 0 ? '+' : ''}${dir.el.toFixed(1)}°`;
    if (!$('sun').hidden && position) {
      const sun = sunPosition(new Date(), position.lat, position.lon);
      $('sun-info').textContent = sun.el < 2
        ? 'Il sole è troppo basso o sotto l\'orizzonte: riprova di giorno.'
        : `Il sole ora è a ${compassPoint(sun.az)} ${Math.round(sun.az)}°, alto ${Math.round(sun.el)}°. Scarto attuale: ${wrap180(sun.az - dir.az).toFixed(1)}°.`;
    }
  }
  requestAnimationFrame(updateHud);
}

function onFix(fix) {
  position = fix;
  const pill = $('hud-gps');
  pill.textContent = `GPS ±${Math.round(fix.accuracy)} m`;
  pill.className = `pill ${fix.accuracy <= 50 ? 'ok' : ''}`;
  // Scarica in anticipo il terreno sotto i piedi: il primo tocco è più rapido.
  dem.ensure([{ lat: fix.lat, lon: fix.lon, z: 11 }]).catch(() => {});
}

function onFixError(err) {
  if (position) return;
  const pill = $('hud-gps');
  pill.textContent = err.message;
  pill.className = 'pill bad';
}

// ---------- Zoom ----------

function setupZoom() {
  if (!camera.zoom) return;
  const z = $('zoom');
  zoomBase = Math.max(1, camera.zoom.min);
  zoom = zoomBase;
  Object.assign(z, { min: camera.zoom.min, max: camera.zoom.max, step: camera.zoom.step, value: zoom });
  $('zoom-bar').hidden = false;
  z.addEventListener('input', async () => {
    const value = Number(z.value);
    try {
      await camera.track.applyConstraints({ advanced: [{ zoom: value }] });
      zoom = value;
      $('zoom-label').textContent = `${(zoom / zoomBase).toFixed(1)}×`;
    } catch { /* il dispositivo ha rifiutato questo valore */ }
  });
}

// ---------- Impostazioni ----------

function syncSettings() {
  $('fov').value = settings.fov; $('fov-out').textContent = `${settings.fov}°`;
  $('head').value = settings.head; $('head-out').textContent = `${settings.head > 0 ? '+' : ''}${settings.head}°`;
  $('pitch').value = settings.pitch; $('pitch-out').textContent = `${settings.pitch > 0 ? '+' : ''}${settings.pitch}°`;
  $('dist').value = settings.dist; $('dist-out').textContent = `${settings.dist} km`;
}
for (const key of ['fov', 'head', 'pitch', 'dist']) {
  $(key).addEventListener('input', (e) => {
    settings[key] = Number(e.target.value);
    syncSettings();
    saveSettings();
  });
}
$('btn-settings').addEventListener('click', () => { syncSettings(); $('settings').hidden = false; });
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
$('settings-reset').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  syncSettings();
  saveSettings();
});

// ---------- Calibrazione con il sole ----------

$('btn-sun').addEventListener('click', () => { closeSheet(); $('sun').hidden = false; });
$('sun-cancel').addEventListener('click', () => { $('sun').hidden = true; });
$('sun-ok').addEventListener('click', () => {
  const dir = centerDirection();
  if (!dir || !position) return;
  const sun = sunPosition(new Date(), position.lat, position.lon);
  if (sun.el < 2) return;
  const round = (v, step) => Math.round(v / step) * step;
  settings.head = round(wrap180(settings.head + sun.az - dir.az), 0.5);
  settings.pitch = round(Math.max(-10, Math.min(10, settings.pitch + sun.el - dir.el)), 0.1);
  saveSettings();
  $('sun').hidden = true;
});

// ---------- Avvio ----------

async function start() {
  const errorBox = $('start-error');
  errorBox.hidden = true;
  try {
    // I permessi vanno chiesti dentro il tocco sul pulsante.
    await orientation.start();
    camera = await startCamera(video);
    setupZoom();
    watchPosition(onFix, onFixError);
    $('start').hidden = true;
    requestAnimationFrame(updateHud);
  } catch (err) {
    console.error(err);
    errorBox.textContent = err.name === 'NotAllowedError'
      ? 'Permesso alla fotocamera negato: abilitalo nelle impostazioni del browser e riprova.'
      : `Non riesco ad avviare: ${err.message}`;
    errorBox.hidden = false;
  }
}
$('btn-start').addEventListener('click', start);

// Modalità demo, per provare senza telefono: ?demo=lat,lon,azimut,elevazione
const demo = new URLSearchParams(location.search).get('demo');
if (demo) {
  const [lat, lon, az, elv] = demo.split(',').map(Number);
  orientation.setManual(az, elv || 0);
  onFix({ lat, lon, accuracy: 5 });
  $('start').hidden = true;
  $('hint').textContent = 'Demo: tocca un punto (il centro è la direzione impostata)';
  requestAnimationFrame(updateHud);
}

// Per i test automatici.
window.localizza = { dem, orientation, settings, identify };
