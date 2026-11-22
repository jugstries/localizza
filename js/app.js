import {
  rayFromMatrix, castProfile, pickTarget, sightTo, angularSeparation, sunPosition,
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
let job = 0; // identifica la ricerca in corso: le risposte di quelle vecchie si ignorano
let frozen = null; // { matrix } quando l'immagine è bloccata
let map = null;
let mapLayer = null;
let startedAt = 0;

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
  const matrix = frozen ? frozen.matrix : orientation.matrix;
  if (!matrix) return null;
  const { tanX, tanY } = tapTangents(x, y);
  const angle = (screen.orientation && screen.orientation.angle) || 0;
  const ray = rayFromMatrix(matrix, tanX, tanY, angle);
  return { az: wrap360(ray.az + settings.head), el: ray.el + settings.pitch };
}

const centerDirection = () => directionAt(view.clientWidth / 2, view.clientHeight / 2);

// ---------- Identificazione ----------

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 20000 ? 1 : 0)} km`);

/**
 * `profile` e `index` servono a ripetere la ricerca su un altro tratto visibile
 * della stessa direzione, senza rilanciare il raggio.
 */
async function identify(dir, profile = null, index = null, onUpdate = () => {}) {
  const obs = profile ? profile.obs : position;
  if (!profile) {
    profile = await castProfile(dem, obs, dir.az, settings.dist * 1000);
    profile.obs = obs;
  }
  const pick = pickTarget(profile, dir.el, index);
  const base = { dir, obs, profile, pick, tech: techInfo(dir, profile) };
  if (pick.kind !== 'land') return { ...base, kind: pick.kind };

  const target = pick.point;
  let note = null;
  if (index == null && Math.abs(pick.miss) > 0.3) {
    note = `La direzione toccata passa ${Math.abs(pick.miss).toFixed(1)}° ${pick.miss > 0 ? 'sopra' : 'sotto'} il terreno visibile più vicino: ti mostro quello.`;
  }

  // Il punto sul terreno è già noto: lo si mostra subito, i nomi arrivano dopo.
  const result = { ...base, kind: 'land', hit: target, note, candidates: [], area: null, pending: true };
  onUpdate({ ...result });

  const areaDone = reverseGeocode(target.lat, target.lon).then((area) => {
    result.area = area;
    if (result.pending) onUpdate({ ...result });
  });

  // Raggio di ricerca: copre circa 8° di errore della bussola a quella distanza.
  const radius = Math.min(20000, Math.max(1500, target.dist * Math.tan(8 * D2R)));
  try {
    const places = await findPlaces(target.lat, target.lon, radius);
    const candidates = await Promise.all(places.map(async (p) => {
      const s = await sightTo(dem, obs, profile.h0, p.lat, p.lon);
      const sep = angularSeparation(dir.az, target.el, s.az, s.el);
      return { ...p, ...s, sep, score: sep + (s.visible ? 0 : 2.5) - p.weight };
    }));
    candidates.sort((a, b) => a.score - b.score);
    result.candidates = candidates.slice(0, 6);
  } catch (err) {
    console.error(err);
    result.placesFailed = true;
  }
  result.pending = false;
  await areaDone;
  return result;
}

/** Righe di diagnostica mostrate in fondo alla scheda. */
function techInfo(dir, profile) {
  const stretches = profile.segments.map((seg) => {
    const a = seg[0], b = seg[seg.length - 1];
    return `${fmtDist(a.dist)}–${fmtDist(b.dist)} (${a.el.toFixed(1)}°…${b.el.toFixed(1)}°)`;
  });
  return [
    `Direzione ${dir.az.toFixed(1)}°, inclinazione ${dir.el >= 0 ? '+' : ''}${dir.el.toFixed(2)}°`,
    `Bussola: ${orientation.absolute ? 'riferita al nord' : 'NON riferita al nord'}`,
    `Zoom ${(zoom / zoomBase).toFixed(1)}×, campo visivo ${settings.fov}°, correzioni ${settings.head}° / ${settings.pitch}°`,
    `Posizione ${profile.obs.lat.toFixed(5)}, ${profile.obs.lon.toFixed(5)} (±${Math.round(profile.obs.accuracy || 0)} m), occhi a ${Math.round(profile.h0)} m s.l.m.`,
    `Terreno visibile in questa direzione: ${stretches.join('; ') || 'nessuno'}`,
  ];
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
  job++; // un'eventuale ricerca in corso non deve riaprire la scheda
  $('sheet').hidden = true;
  $('marker').hidden = true;
  $('marker').classList.remove('busy');
  $('hint').hidden = false;
  syncFreeze();
}

// ---------- Blocco dell'immagine ----------
// Al tocco l'immagine e la direzione vengono fissate: si può abbassare il
// telefono mentre arrivano i risultati, e toccare con calma altri punti.

function freeze() {
  if (frozen) return;
  frozen = { matrix: orientation.matrix && [...orientation.matrix] };
  video.pause();
  syncFreeze();
}

function unfreeze() {
  if (!frozen) return;
  frozen = null;
  if (video.srcObject) video.play().catch(() => {});
  syncFreeze();
}

function syncFreeze() {
  const btn = $('btn-freeze');
  btn.textContent = frozen ? '▶' : '⏸';
  btn.title = frozen ? 'Riprendi la fotocamera' : 'Blocca l\'immagine';
  btn.setAttribute('aria-label', btn.title);
  $('hint').textContent = frozen
    ? 'Immagine bloccata: tocca un punto, oppure ▶ per riprendere'
    : 'Tocca il punto che vuoi riconoscere (⏸ per bloccare l\'immagine)';
  $('zoom-bar').hidden = !!frozen || !(camera && camera.zoom) || !$('sheet').hidden;
}

function showProgress() {
  $('map').hidden = true;
  showSheet(
    el('p', { className: 'eyebrow', textContent: 'Direzione registrata' }),
    el('h2', { textContent: 'Sto cercando…' }),
    el('p', { className: 'facts', textContent: 'Puoi abbassare il telefono: immagine e direzione sono state fissate nel momento del tocco.' }),
    el('p', { className: 'small', textContent: 'Scarico il rilievo del terreno in quella direzione…' }),
  );
}

/** Esegue una ricerca mostrando i risultati man mano che arrivano. */
async function run(dir, profile = null, index = null) {
  const id = ++job;
  $('marker').classList.add('busy');
  if (!profile) showProgress();
  try {
    const final = await identify(dir, profile, index, (partial) => { if (id === job) render(partial); });
    if (id === job) render(final);
  } catch (err) {
    console.error(err);
    if (id === job) showError(`Non sono riuscito a scaricare il rilievo del terreno: controlla la connessione e riprova. (${err.message})`);
  } finally {
    if (id === job) $('marker').classList.remove('busy');
  }
}

function render(result) {
  const { dir } = result;
  const dirText = `direzione ${compassPoint(dir.az)} ${Math.round(dir.az)}°`;
  $('map').hidden = result.kind !== 'land';

  if (result.kind !== 'land') {
    const sky = result.kind === 'sky';
    const nodes = [
      el('p', { className: 'eyebrow', textContent: sky ? 'Nessun terreno' : 'Acqua' }),
      el('h2', { textContent: sky ? 'Cielo' : 'Mare' }),
      el('p', {
        className: 'facts',
        textContent: sky
          ? `In ${dirText} il punto toccato è sopra tutto il terreno visibile entro ${settings.dist} km.`
          : `In ${dirText} il punto toccato cade sull'acqua${result.pick.dist ? `, a circa ${fmtDist(result.pick.dist)}` : ''}.`,
      }),
    ];
    if (result.pick.nearest != null) {
      const go = el('button', { textContent: 'Mostra il terreno più vicino a questa direzione' });
      go.addEventListener('click', () => step(result, result.pick.nearest));
      nodes.push(go);
    }
    nodes.push(techBlock(result));
    showSheet(...nodes);
    return;
  }

  const { hit, candidates, area } = result;
  const best = candidates[0];
  const nodes = [
    el('p', { className: 'eyebrow', textContent: best ? `${best.label} · più probabile` : (result.pending ? 'Punto trovato · cerco i nomi…' : 'Punto del terreno') }),
    el('h2', { textContent: best ? best.name : (area || (result.pending ? `Terreno a ${fmtDist(hit.dist)}` : 'Luogo senza nome')) }),
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
  if (area && best) nodes.push(el('p', { className: 'small', textContent: `Zona del punto toccato: ${area}` }));
  if (result.pending) nodes.push(el('p', { className: 'small', textContent: 'Sto cercando paesi e cime attorno a questo punto: può volerci qualche secondo.' }));
  if (!orientation.absolute) {
    nodes.push(el('p', { className: 'note', textContent: 'Attenzione: questo browser non fornisce una bussola riferita al nord, quindi la direzione può essere del tutto sbagliata. Usa ☀ per calibrarla con il sole.' }));
  }
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
  const total = result.profile.segments.length;
  if (total > 1) {
    const i = result.pick.index;
    const nearer = el('button', { textContent: '◂ Più vicino', disabled: i === 0 });
    const farther = el('button', { textContent: 'Più lontano ▸', disabled: i === total - 1 });
    nearer.addEventListener('click', () => step(result, i - 1));
    farther.addEventListener('click', () => step(result, i + 1));
    nodes.push(
      el('h3', { textContent: `Non è questo? In questa direzione si vedono ${total} tratti di terreno (questo è il ${i + 1}°)` }),
      el('div', { className: 'row step' }, nearer, farther),
    );
  }
  nodes.push(techBlock(result));
  showSheet(...nodes);
  drawMap(result);
}

function techBlock(result) {
  return el('details', { className: 'tech' },
    el('summary', { textContent: 'Dati tecnici' }),
    ...result.tech.map((line) => el('p', { textContent: line })),
  );
}

/** Ripete la ricerca su un altro tratto visibile della stessa direzione. */
const step = (result, index) => run(result.dir, result.profile, index);

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

function showCompassHelp() {
  $('map').hidden = true;
  const retry = el('button', { className: 'primary', textContent: 'Riprova' });
  retry.addEventListener('click', async () => {
    await orientation.start();
    closeSheet();
  });
  showSheet(
    el('p', { className: 'eyebrow', textContent: 'Bussola non disponibile' }),
    el('h2', { textContent: 'Sensori di movimento bloccati' }),
    el('p', { className: 'facts', textContent: 'Il browser non sta passando alla pagina bussola e inclinazione, e senza non posso sapere dove punta la fotocamera.' }),
    el('p', { className: 'small', textContent: 'In Chrome: tocca l\'icona a sinistra dell\'indirizzo → Autorizzazioni (o Impostazioni sito) → Sensori di movimento → Consenti. Se non c\'è la voce: menu ⋮ → Impostazioni → Impostazioni sito → Sensori di movimento. Se hai aperto il link da dentro un\'altra app, aprilo direttamente in Chrome. Poi premi Riprova o ricarica la pagina.' }),
    retry,
  );
}

// ---------- Tocco ----------

view.addEventListener('pointerup', (e) => {
  if (e.target.closest('#hud, #zoom-bar') || !$('sun').hidden) return;
  if (!$('sheet').hidden) { closeSheet(); return; }

  // La direzione si legge nell'istante del tocco, poi si blocca tutto.
  const dir = directionAt(e.clientX, e.clientY);
  freeze();

  const marker = $('marker');
  marker.style.left = `${e.clientX}px`;
  marker.style.top = `${e.clientY}px`;
  marker.hidden = false;

  if (!position) return showError('Sto ancora aspettando la posizione GPS. Mettiti all\'aperto e riprova fra qualche secondo.');
  if (!dir) return showCompassHelp();
  run(dir);
});

$('btn-freeze').addEventListener('click', () => {
  if (frozen) { closeSheet(); unfreeze(); } else freeze();
});
$('sheet-close').addEventListener('click', closeSheet);
$('hud-dir').addEventListener('click', () => { if (!orientation.matrix) showCompassHelp(); });

// ---------- Barra in alto ----------

function updateHud() {
  const dir = centerDirection();
  const pill = $('hud-dir');
  if (!dir && performance.now() - startedAt > 3000) {
    pill.textContent = 'Bussola assente · tocca';
    pill.className = 'pill bad';
  }
  if (dir) {
    pill.className = 'pill';
    pill.textContent = `${compassPoint(dir.az)} ${Math.round(dir.az)}° · ${dir.el >= 0 ? '+' : ''}${dir.el.toFixed(1)}°`;
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

$('btn-sun').addEventListener('click', () => { closeSheet(); unfreeze(); $('sun').hidden = false; });
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
    startedAt = performance.now();
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
  requestAnimationFrame(updateHud);
}

syncFreeze();

// Per i test automatici.
window.localizza = { dem, orientation, settings, identify };
