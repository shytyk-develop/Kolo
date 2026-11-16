// debugging aid: which ICE candidates and pairs a call in the lab ends up with
import { closeAll, sleep, startCall, waitMedia } from "./lib.mjs";

const call = await startCall();
const ok = await waitMedia([call.host, call.guest], Number(process.env.CONNECT_MS ?? 25_000));
await sleep(1500);
for (const person of [call.host, call.guest]) {
  const lines = await person.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__koloPcs) {
      const r = await pc.getStats();
      out.push(`pc ${pc.connectionState} ice=${pc.iceConnectionState} gathering=${pc.iceGatheringState}`);
      r.forEach((s) => {
        if (s.type === "local-candidate" || s.type === "remote-candidate") out.push(`${s.type} ${s.candidateType} ${s.protocol} ${s.address}:${s.port} ${s.relayProtocol ?? ""} ${s.url ?? ""}`);
        if (s.type === "candidate-pair") out.push(`pair ${s.state} nominated=${s.nominated} ${r.get(s.localCandidateId)?.candidateType}/${r.get(s.localCandidateId)?.relayProtocol ?? r.get(s.localCandidateId)?.protocol} -> ${r.get(s.remoteCandidateId)?.candidateType}/${r.get(s.remoteCandidateId)?.address}:${r.get(s.remoteCandidateId)?.port}`);
      });
    }
    return out;
  });
  console.log(`--- ${person.name} (media ${ok ? "flowing" : "NOT flowing"})\n${[...new Set(lines)].sort().join("\n")}`);
}
await closeAll(call.host, call.guest);
