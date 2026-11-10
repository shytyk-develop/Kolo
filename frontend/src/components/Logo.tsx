// "kolo." from the mockup, dot-matrix letters. Units are mockup @2x pixels.
const B = 22;
const k = [0, 30, 60, 90, 120, 150, 180].map((y) => [0, y]).concat([
  [90, 60],
  [60, 90],
  [30, 120],
  [60, 150],
  [90, 180],
]);
const o = (x: number) => [
  [x, 90],
  [x, 120],
  [x, 150],
  [x + 30, 60],
  [x + 60, 60],
  [x + 90, 90],
  [x + 90, 120],
  [x + 90, 150],
  [x + 30, 180],
  [x + 60, 180],
];
const l = [0, 30, 60, 90, 120, 150, 180].map((y) => [292, y]);
const BLOCKS = [...k, ...o(145), ...l, ...o(350)];

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 517 202" role="img" aria-label="kolo.">
      {BLOCKS.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={B} height={B} rx={4} fill="currentColor" />
      ))}
      <rect x={495} y={175} width={B} height={B} rx={3} fill="var(--green)" />
    </svg>
  );
}
