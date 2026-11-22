// Prova end-to-end: avvia l'app in Chromium in modalità demo, con il rilievo
// vero (scaricato una volta in tests/.cache) e i servizi dei nomi simulati.
// Uso: node tests/e2e.mjs
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Playwright può essere installato globalmente: require lo trova, import no.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'tests/.cache');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'text/html' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exitCode = 1; });

await mkdir(cache, { recursive: true });
await page.route('**/elevation-tiles-prod/**', async (route) => {
  const url = route.request().url();
  const file = join(cache, url.split('/terrarium/')[1].replaceAll('/', '_'));
  if (!existsSync(file)) await writeFile(file, execFileSync('curl', ['-sf', url], { maxBuffer: 1 << 24 }));
  await route.fulfill({ body: await readFile(file), contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
});
await page.route('**/api/interpreter', async (route) => {
  const [, lat, lon] = decodeURIComponent(route.request().postData()).match(/around:\d+,([\d.-]+),([\d.-]+)/);
  await route.fulfill({ json: { elements: [
    { type: 'node', lat: +lat + 0.002, lon: +lon, tags: { place: 'village', name: 'Paese di Prova', population: '1234' } },
    { type: 'node', lat: +lat + 0.03, lon: +lon + 0.03, tags: { natural: 'peak', name: 'Monte Finto' } },
  ] }, headers: { 'access-control-allow-origin': '*' } });
});
await page.route('**/nominatim.openstreetmap.org/**', (route) => route.fulfill({
  json: { address: { village: 'Comune Finto', county: 'Provincia Finta', country: 'Italia' } },
  headers: { 'access-control-allow-origin': '*' },
}));
await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());

// Osservatore sul lungomare di Reggio Calabria, bersaglio la cima dell'Etna.
const obs = { lat: 38.1105, lon: 15.644 };
const etna = { lat: 37.751, lon: 14.993 };

await page.goto(`${base}/?demo=${obs.lat},${obs.lon},0,0`);
const r = await page.evaluate(async ({ obs, etna }) => {
  const geo = await import('./js/geo.js');
  const { dem } = window.localizza;
  const h0 = await geo.observerHeight(dem, obs.lat, obs.lon);
  const sight = await geo.sightTo(dem, obs, h0, etna.lat, etna.lon);
  const hit = await geo.castRay(dem, obs, sight.az, sight.el - 0.2, 150000);
  const m = geo.rotationMatrix(360 - 120, 90 + 10, 0);
  return {
    h0, sight, hit,
    miss: hit.lat ? geo.distance(hit.lat, hit.lon, etna.lat, etna.lon) : null,
    sky: await geo.castRay(dem, obs, sight.az, 20, 150000),
    sea: await geo.castRay(dem, obs, 270, -2, 150000),
    center: geo.rayFromMatrix(m),
    right: geo.rayFromMatrix(m, Math.tan(Math.PI / 18), 0),
    up: geo.rayFromMatrix(m, 0, Math.tan(Math.PI / 36)),
    landscape: geo.rayFromMatrix(geo.rotationMatrix(0, 0, -90), 0, Math.tan(Math.PI / 36), 90),
    sun: geo.sunPosition(new Date('2026-11-22T13:55:00Z'), obs.lat, obs.lon),
  };
}, { obs, etna });
console.log(JSON.stringify(r, null, 1));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
assert.ok(r.h0 < 30, 'osservatore vicino al livello del mare');
assert.ok(r.sight.visible, 'Etna visibile da Reggio');
assert.ok(r.sight.elev > 3000, 'quota della cima');
assert.equal(r.hit.type, 'terrain');
assert.ok(r.miss < 6000, `il raggio colpisce il fianco dell'Etna (scarto ${r.miss} m)`);
assert.equal(r.sky.type, 'sky');
assert.equal(r.sea.type, 'sea');
near(r.center.az, 120, 0.01, 'azimut centro'); near(r.center.el, 10, 0.01, 'elevazione centro');
near(r.right.az, 130.1, 0.3, 'tocco a destra'); near(r.up.el, 15, 0.01, 'tocco in alto');
near(r.landscape.az, 90, 0.01, 'orizzontale: azimut'); near(r.landscape.el, 5, 0.01, 'orizzontale: tocco in alto');
near(r.sun.az, 222, 6, 'azimut del sole'); near(r.sun.el, 20, 6, 'altezza del sole');

// Interfaccia: punta l'Etna, tocca il centro, deve comparire il paese simulato.
await page.goto(`${base}/?demo=${obs.lat},${obs.lon},${r.sight.az},${r.sight.el - 0.2}`);
await page.mouse.click(195, 422);
await page.waitForSelector('#sheet:not([hidden]) h2');
const title = await page.textContent('#sheet h2');
const facts = await page.textContent('#sheet .facts');
console.log(title, '|', facts);
assert.equal(title, 'Paese di Prova');
assert.match(facts, /6\d km/);
await page.screenshot({ path: join(cache, 'risultato.png') });

await page.click('#sheet-close');
await page.mouse.click(195, 100); // molto sopra il crinale
await page.waitForSelector('#sheet:not([hidden]) h2');
assert.equal(await page.textContent('#sheet h2'), 'Cielo');

await browser.close();
server.close();
console.log(process.exitCode ? 'FALLITO' : 'OK');
