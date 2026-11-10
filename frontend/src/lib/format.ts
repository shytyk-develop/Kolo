/** First letter for an avatar, null for an empty name. */
export function initial(name: string): string | null {
  const ch = name.trim().slice(0, 1);
  return ch ? ch.toUpperCase() : null;
}

/** 785000 ms -> "13:05", over an hour "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}
