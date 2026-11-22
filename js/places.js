// Nomi dei luoghi da OpenStreetMap: Overpass per cercare paesi/cime attorno
// a un punto, Nominatim per sapere in che comune cade il punto.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const KIND = {
  city: { label: 'Città', weight: 1.0 },
  town: { label: 'Cittadina', weight: 0.8 },
  village: { label: 'Paese', weight: 0.6 },
  hamlet: { label: 'Frazione', weight: 0.3 },
  suburb: { label: 'Quartiere', weight: 0.2 },
  locality: { label: 'Località', weight: 0 },
  isolated_dwelling: { label: 'Casa isolata', weight: 0 },
  peak: { label: 'Cima', weight: 0.4 },
  volcano: { label: 'Vulcano', weight: 0.8 },
  cape: { label: 'Capo', weight: 0.3 },
  castle: { label: 'Castello', weight: 0.4 },
  fort: { label: 'Forte', weight: 0.4 },
  monastery: { label: 'Monastero', weight: 0.3 },
  lighthouse: { label: 'Faro', weight: 0.4 },
};

function classify(tags) {
  const k = tags.place || tags.natural || tags.historic || tags.man_made;
  return KIND[k] ? { kind: k, ...KIND[k] } : null;
}

/** Luoghi con nome entro `radius` metri da (lat, lon). */
export async function findPlaces(lat, lon, radius) {
  const a = `(around:${Math.round(radius)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const query = `[out:json][timeout:20];(
    node${a}[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"][name];
    node${a}[natural~"^(peak|volcano|cape)$"][name];
    nwr${a}[historic~"^(castle|fort|monastery)$"][name];
    nwr${a}[man_made=lighthouse][name];
  );out center tags 120;`;

  let lastError;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return json.elements.flatMap((e) => {
        const pos = e.center || e;
        const cls = e.tags && classify(e.tags);
        if (!cls || pos.lat == null) return [];
        return [{
          name: e.tags['name:it'] || e.tags.name,
          lat: pos.lat, lon: pos.lon,
          population: Number(e.tags.population) || null,
          ele: Number(e.tags.ele) || null,
          ...cls,
        }];
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Comune / provincia in cui cade il punto (o null se il servizio non risponde). */
export async function reverseGeocode(lat, lon) {
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&addressdetails=1'
      + `&accept-language=it&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const a = (await res.json()).address;
    if (!a) return null;
    const town = a.city || a.town || a.village || a.municipality || a.hamlet;
    const area = a.county || a.province || a.state;
    return [town, area, a.country].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}
