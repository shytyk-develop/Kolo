// mic / voice level for the bars. One AudioContext, one rAF loop for every subscriber.

interface Meter {
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  level: number;
}

let ctx: AudioContext | null = null;
const meters = new WeakMap<MediaStreamTrack, Meter>();
const subscribers = new Set<(now: number) => void>();
let frame = 0;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || !window.AudioContext) return null;
  ctx ??= new AudioContext();
  // made before a click it starts suspended
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

function meterFor(track: MediaStreamTrack): Meter | null {
  const existing = meters.get(track);
  if (existing) return existing;
  const ac = audioContext();
  if (!ac) return null;
  try {
    const source = ac.createMediaStreamSource(new MediaStream([track]));
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    // not connected to the speakers, only read
    source.connect(analyser);
    const meter = { analyser, buf: new Float32Array(analyser.fftSize), level: 0 };
    meters.set(track, meter);
    return meter;
  } catch {
    return null;
  }
}

/** 0..1, smoothed: fast up, slow down. */
export function readLevel(stream: MediaStream | null): number {
  const track = stream?.getAudioTracks()[0];
  if (!track || track.readyState === "ended" || !track.enabled) return 0;
  const meter = meterFor(track);
  if (!meter) return 0;
  meter.analyser.getFloatTimeDomainData(meter.buf);
  let sum = 0;
  for (let i = 0; i < meter.buf.length; i++) sum += meter.buf[i] * meter.buf[i];
  const rms = Math.sqrt(sum / meter.buf.length);
  // -55 dB is silence, -18 dB is loud speech
  const db = 20 * Math.log10(rms + 1e-9);
  const target = Math.min(1, Math.max(0, (db + 55) / 37));
  meter.level += (target - meter.level) * (target > meter.level ? 0.55 : 0.12);
  return meter.level;
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
