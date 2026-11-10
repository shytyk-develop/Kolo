/** Safety code from two DTLS fingerprints. Same formula as tools/safety_code.py. */
export async function safetyCode(fingerprintA: string, fingerprintB: string): Promise<string> {
  const material = [fingerprintA.toUpperCase(), fingerprintB.toUpperCase()].sort().join("|");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
  // first 8 bytes as a number
  let value = 0n;
  for (const byte of digest.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  const text = (value % 10_000_000_000n).toString().padStart(10, "0");
  return `${text.slice(0, 5)} ${text.slice(5)}`;
}

/** Gets the a=fingerprint:... value out of an SDP. */
export function fingerprintFromSdp(sdp: string | undefined): string | null {
  const line = sdp?.split(/\r?\n/).find((l) => l.startsWith("a=fingerprint:"));
  return line ? line.slice("a=fingerprint:".length).trim() : null;
}
