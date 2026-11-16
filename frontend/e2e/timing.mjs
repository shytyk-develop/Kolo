// how long from "Instant meeting" to the other person's video, a few rounds.
// run: node e2e/timing.mjs (backend on :8000, frontend on :3000)
import { createRoom, hostJoins, joinAs, launch, person, waitConnected } from "./helpers.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 5);
const browser = await launch();
const times = [];
try {
  for (let i = 0; i < ROUNDS; i++) {
    const host = await person(browser, "Anya");
    const guest = await person(browser, "Bob");
    const start = Date.now();
    const room = await createRoom(host, "Anya");
    await hostJoins(host);
    await host.getByTestId("call").waitFor();
    const guestStart = Date.now();
    await joinAs(guest, room.url, "Bob");
    await waitConnected(guest, "Bob");
    const now = Date.now();
    times.push({ total: now - start, guest: now - guestStart });
    await host.context().close();
    await guest.context().close();
  }
  const mid = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`rounds: ${ROUNDS}`);
  console.log(`create room -> guest sees video, median: ${mid(times.map((t) => t.total))} ms`);
  console.log(`guest opens link -> sees video, median: ${mid(times.map((t) => t.guest))} ms`);
  console.log("all:", JSON.stringify(times));
} finally {
  await browser.close();
}
