// voice meter for the equalizer bars. One AudioContext, one rAF loop for every subscriber.
// Each bar is a real frequency band of the voice, so the bars move with the actual sound.

// Hz, low to high, roughly where speech lives
const BANDS: [number, number][] = [
  [90, 320],
  [320, 900],
  [900, 2200],
  [2200, 5500],
];
// speech gets quieter up the spectrum; lift the high bands so all four get to move (dB)
const TILT = [0, 4, 10, 16];
// a band this many dB under the loudest one sits at the bottom
const SPREAD = 24;
// never trust a "noise floor" below this: digital silence would open the gate for any click
const NOISE_MIN = -72;

export interface MeterReading {
  // 0..1, how much voice there is (gated by the noise floor)
  level: number;
  // 0..1 per band, already smoothed
  bands: number[];
}

interface Meter {
  analyser: AnalyserNode;
  time: Float32Array<ArrayBuffer>;
  freq: Float32Array<ArrayBuffer>;
  bins: [number, number][];
  // noise floor of the whole signal in dB. It adapts, so a quiet laptop mic
  // and a loud headset both fill the bars, and a steady fan stops counting.
  noise: number;
  reading: MeterReading;
  frame: number;
}

let ctx: AudioContext | null = null;
let sink: GainNode | null = null;
const meters = new WeakMap<MediaStreamTrack, Meter>();
const subscribers = new Set<(now: number) => void>();
let frame = 0;

const SILENT: MeterReading = { level: 0, bands: [0, 0, 0, 0] };

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || !window.AudioContext) return null;
  if (!ctx) {
    ctx = new AudioContext();
    // silent output: safari only feeds an analyser that ends up at the speakers
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    // made before a click it starts suspended, wake it on the first one
    const wake = () => {
      if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    };
    ["pointerdown", "keydown", "touchend"].forEach((t) => window.addEventListener(t, wake, { passive: true }));
    document.addEventListener("visibilitychange", wake);
  }
  if (ctx.state !== "running") void ctx.resume().catch(() => {});
  return ctx;
}

function meterFor(track: MediaStreamTrack): Meter | null {
  const existing = meters.get(track);
  if (existing) return existing;
  const ac = audioContext();
  if (!ac || !sink) return null;
  try {
    const source = ac.createMediaStreamSource(new MediaStream([track]));
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    analyser.connect(sink);
    track.addEventListener("ended", () => source.disconnect(), { once: true });

    const hz = ac.sampleRate / analyser.fftSize;
    const meter: Meter = {
      analyser,
      time: new Float32Array(analyser.fftSize),
      freq: new Float32Array(analyser.frequencyBinCount),
      bins: BANDS.map(([lo, hi]) => [Math.max(1, Math.floor(lo / hz)), Math.ceil(hi / hz)]),
      noise: -60,
      reading: { level: 0, bands: [0, 0, 0, 0] },
      frame: -1,
    };
    meters.set(track, meter);
    return meter;
  } catch {
    return null;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// fast up, slower down, like a vu meter
const ease = (cur: number, target: number) => cur + (target - cur) * (target > cur ? 0.5 : 0.16);

/** Current voice reading of a stream's first audio track. Same frame = cached, safe to call twice. */
export function readMeter(stream: MediaStream | null, now: number): MeterReading {
  const track = stream?.getAudioTracks()[0];
  if (!track || track.readyState === "ended" || !track.enabled) return SILENT;
  const m = meterFor(track);
  if (!m) return SILENT;
  if (m.frame === now) return m.reading;
  m.frame = now;

  // loudness from the waveform
  m.analyser.getFloatTimeDomainData(m.time);
  let sum = 0;
  for (let i = 0; i < m.time.length; i++) sum += m.time[i] * m.time[i];
  const db = 20 * Math.log10(Math.sqrt(sum / m.time.length) + 1e-9);
  // noise floor: drops fast, creeps up ~1 dB/s
  const floor = db < m.noise ? m.noise + (db - m.noise) * 0.3 : Math.min(m.noise + 0.016, -25);
  m.noise = Math.max(floor, NOISE_MIN);
  // how much louder than the room it is right now, 0..1
  const voice = clamp01((db - m.noise - 6) / 30);

  // shape from the spectrum: each band against the loudest one in this frame
  m.analyser.getFloatFrequencyData(m.freq);
  let top = -Infinity;
  const levels = m.bins.map(([lo, hi], b) => {
    let acc = 0;
    for (let i = lo; i <= hi && i < m.freq.length; i++) acc += Math.max(m.freq[i], -140);
    const band = acc / (hi - lo + 1) + TILT[b];
    top = Math.max(top, band);
    return band;
  });
  const r = m.reading;
  levels.forEach((band, b) => {
    const shape = clamp01(1 - (top - band) / SPREAD);
    r.bands[b] = ease(r.bands[b], voice * (0.25 + 0.75 * shape));
  });
  r.level = ease(r.level, voice);
  return r;
}

function loop(now: number) {
  subscribers.forEach((fn) => fn(now));
  frame = subscribers.size ? requestAnimationFrame(loop) : 0;
}

export function onFrame(fn: (now: number) => void): () => void {
  subscribers.add(fn);
  if (!frame) frame = requestAnimationFrame(loop);
  return () => {
    subscribers.delete(fn);
  };
}
