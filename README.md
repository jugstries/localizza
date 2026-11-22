# Localizza

Inquadra il paesaggio con il telefono, tocca un punto e scopri che posto è.

## Come funziona

1. **Posizione** – il GPS dice dove sei.
2. **Direzione** – bussola e inclinometro del telefono dicono dove punta la fotocamera;
   il punto toccato sullo schermo viene convertito in un angolo usando il campo visivo
   dell'obiettivo (e lo zoom).
3. **Raggio sul terreno** – da te parte un raggio in quella direzione, che viene seguito
   su un modello digitale delle quote (Terrain Tiles su AWS, dati aperti) tenendo conto
   della curvatura terrestre e della rifrazione, finché non incontra il terreno.
4. **Nome** – attorno al punto colpito si cercano paesi, cime, castelli e fari su
   OpenStreetMap; i candidati sono ordinati per quanto sono vicini alla linea di vista
   e per visibilità (quelli coperti da un rilievo vengono penalizzati).

Non servono chiavi API né un server: è una pagina statica.

## Provarla

Fotocamera e sensori funzionano solo su **HTTPS** (o `localhost`). Basta pubblicare la
cartella così com'è su un hosting statico (per esempio GitHub Pages) e aprirla dal
telefono con Chrome; dal menu si può poi «Aggiungere a schermata Home».

Senza telefono c'è la modalità demo, che simula posizione e direzione:

```
npx serve .
# poi apri  http://localhost:3000/?demo=38.1105,15.644,235.2,2.2
#           (lat, lon, azimut, elevazione: qui da Reggio Calabria verso l'Etna)
```

## Precisione

Il limite è la bussola del telefono, che sbaglia facilmente di 5–10° (a 20 km sono
2–3 km di lato). Per questo l'app:

- mostra più candidati, non uno solo, con lo scarto angolare di ciascuno;
- offre la **calibrazione con il sole** (☀): si centra il sole nel mirino e l'app
  corregge bussola e inclinazione confrontandole con la posizione astronomica;
- permette di regolare a mano campo visivo e correzioni nelle impostazioni (⚙).

La bussola indica il nord magnetico: in Italia la differenza dal nord vero è di pochi
gradi, e la calibrazione con il sole la assorbe.

Sviluppata e pensata per Chrome su Android. Su iPhone (Safari) il codice è predisposto
ma non è stato provato su un dispositivo reale.

## Test

```
node tests/e2e.mjs
```

Apre l'app in Chromium (serve Playwright) in modalità demo, usa il rilievo vero e
simula i servizi dei nomi. Verifica fra l'altro che un raggio lanciato da Reggio
Calabria verso la cima dell'Etna colpisca il vulcano a ~68 km.

## Struttura

- `js/geo.js` – geometria: orientamento → raggio, intersezione con il terreno, sole
- `js/dem.js` – download e lettura delle quote
- `js/places.js` – nomi dei luoghi (Overpass, Nominatim)
- `js/sensors.js` – fotocamera, GPS, bussola
- `js/app.js` – interfaccia
- `vendor/leaflet` – libreria della mappa (licenza BSD-2)
