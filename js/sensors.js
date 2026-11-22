// Accesso a fotocamera, GPS e bussola/inclinazione del telefono.

import { rotationMatrix } from './geo.js';

/** Orientamento del telefono come matrice dispositivo -> mondo, filtrata dal tremolio. */
export class Orientation {
  constructor() {
    this.matrix = null;
    this.absolute = false;
    this.onEvent = this.onEvent.bind(this);
  }

  async start() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error('Questo dispositivo non ha sensori di orientamento');
    // iOS chiede un permesso esplicito, e solo in risposta a un tocco.
    if (typeof DOE.requestPermission === 'function') {
      if ((await DOE.requestPermission()) !== 'granted') {
        throw new Error('Permesso ai sensori di movimento negato');
      }
    }
    const type = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
    window.addEventListener(type, this.onEvent);
  }

  onEvent(e) {
    if (e.beta == null || e.gamma == null) return;
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number') {
      // Safari: alpha è relativo, la bussola arriva a parte.
      alpha = 360 - e.webkitCompassHeading;
      this.absolute = true;
    } else {
      this.absolute = e.absolute === true;
    }
    if (alpha == null) return;
    this.push(rotationMatrix(alpha, e.beta, e.gamma));
  }

  push(m) {
    if (!this.matrix) { this.matrix = m; return; }
    const k = 0.2;
    this.matrix = this.matrix.map((v, i) => v + (m[i] - v) * k);
  }

  /** Orientamento finto (modalità demo): telefono verticale puntato verso az/el. */
  setManual(az, el) {
    this.matrix = rotationMatrix(360 - az, 90 + el, 0);
    this.absolute = true;
  }
}

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  return {
    track,
    zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null,
  };
}

export function watchPosition(onFix, onError) {
  if (!navigator.geolocation) {
    onError(new Error('GPS non disponibile'));
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
    (err) => onError(new Error(err.code === 1 ? 'Permesso alla posizione negato' : 'Posizione non disponibile')),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}
