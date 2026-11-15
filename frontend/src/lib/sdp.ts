// no imports: the node tests load this file as is

/** The "o=" line's session id: the same for a connection's whole life, another one for a new connection. */
export function sessionIdOf(sdp: string): string | null {
  return sdp.match(/^o=\S+ (\d+) /m)?.[1] ?? null;
}

// Opus saves bandwidth in silence (DTX) and repairs lost packets (FEC). Applies to what the other side sends us
export function preferOpusDtx(sdp: string): string {
  const opus = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!opus) return sdp;
  const fmtp = new RegExp(`a=fmtp:${opus} ([^\\r\\n]*)`);
  if (!fmtp.test(sdp)) return sdp.replace(new RegExp(`(a=rtpmap:${opus} [^\\r\\n]*)`), `$1\r\na=fmtp:${opus} useinbandfec=1;usedtx=1`);
  return sdp.replace(fmtp, (line, params: string) => {
    const extra = ["useinbandfec=1", "usedtx=1"].filter((x) => !params.includes(x.split("=")[0]));
    return extra.length ? `${line};${extra.join(";")}` : line;
  });
}
