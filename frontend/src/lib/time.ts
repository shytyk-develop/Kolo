const MIN = 60_000;
const DAY = 86_400_000;

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Yesterday", "Mon", "Oct 28": when a recent call was. */
export function dayLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** "24 min", "1 h 12 min": how long a call was. */
export function lengthLabel(ms: number): string {
  const min = Math.round(ms / MIN);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "just now", "2 min ago". */
export function agoLabel(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / MIN);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/** "12:41", 24h. */
export function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
