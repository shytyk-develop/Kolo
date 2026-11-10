// waiting room: the guest waits, the host lets them in, the call connects.
// run: node e2e/lobby.mjs (backend on :8000, frontend on :3000)
import { createRoom, joinAs, launch, person, waitConnected } from "./helpers.mjs";

const browser = await launch();
try {
  const host = await person(browser, "Anya");
  const guest = await person(browser, "Bob");

  const roomUrl = await createRoom(host, { lobby: true });
  console.log("Room with a waiting room:", roomUrl);
  await joinAs(host, null, "Anya");
  // the host is in before the guest knocks
  await host.getByTestId("call").waitFor();

  await joinAs(guest, roomUrl, "Bob");
  await guest.getByTestId("lobby-wait").waitFor({ timeout: 10_000 });
  console.log("Guest is in the waiting room");

  await host.getByTestId("admit").click({ timeout: 10_000 });
  await waitConnected(host, "Anya");
  await waitConnected(guest, "Bob");
  console.log("Host let the guest in, call connected");
  console.log("E2E OK");
} catch (err) {
  await Promise.all(browser.contexts().map((c, i) => c.pages()[0]?.screenshot({ path: `e2e/lobby-fail-${i}.png` })));
  throw err;
} finally {
  await browser.close();
}
