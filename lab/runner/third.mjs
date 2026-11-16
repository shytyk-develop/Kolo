// "the uninvited third": two people are in a call, someone else has the link (and even the key)
import { callFacts, closeAll, connect, save, sleep, startCall, waitMedia } from "./lib.mjs";
import { joinAs } from "../e2e/helpers.mjs";

const call = await startCall();
const { host, guest, room } = call;
const result = { scenario: "third", ok: false, attempts: {} };
const third = await connect(process.env.CLIENT_B, "Mallory");
try {
  result.connected = await waitMedia([host, guest]);

  // 1. through the page, with the full link
  const answers = [];
  third.page.on("response", (r) => r.url().includes("/join") && answers.push(r.status()));
  await joinAs(third.page, room.url, "Mallory");
  await sleep(3000);
  result.attempts.page = { joinAnswers: answers, inCall: (await third.page.getByTestId("call").count()) > 0 };

  // 2. straight at the api, a few times in a row
  result.attempts.api = await third.page.evaluate(async (code) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`/api/v1/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: `Mallory ${i}` }),
      });
      statuses.push(r.status);
    }
    return statuses;
  }, room.code);

  // 3. the socket with a made-up ticket
  result.attempts.socket = await third.page.evaluate(
    (code) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`wss://api.kolo.lab/ws/rooms/${code}?token=eyJhbGciOiJub25lIn0.eyJzdWIiOiJwX3giLCJyb29tIjoieCJ9.`);
        ws.onclose = (e) => resolve({ closed: e.code, reason: e.reason });
        ws.onmessage = (e) => resolve({ message: e.data });
        setTimeout(() => resolve({ timeout: true }), 5000);
      }),
    room.code,
  );

  await sleep(1500);
  result.callAfter = await callFacts(call);
  const stillTalking = Object.values(result.callAfter).every((f) => f.state === "connected");
  result.ok =
    result.connected &&
    stillTalking &&
    !result.attempts.page.inCall &&
    answers.every((s) => s === 409) &&
    result.attempts.api.every((s) => s === 409 || s === 429) &&
    result.attempts.socket.closed === 4401;
} finally {
  save("5-third.json", result);
  console.log(JSON.stringify(result, null, 2));
  await closeAll(host, guest, third);
}
process.exit(result.ok ? 0 : 1);
