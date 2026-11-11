// waiting room: the host waits on "Knock, knock", the guest knocks with the code,
// the host lets them in from the home screen, both land in the call.
// run: node e2e/lobby.mjs (backend on :8000, frontend on :3000)
import { createRoom, hostJoins, joinWithCode, launch, person, shotOnFail, waitConnected, WEB } from "./helpers.mjs";

const browser = await launch();
try {
  const host = await person(browser, "Anya");
  const guest = await person(browser, "Bob");

  const room = await createRoom(host, "Anya", { lobby: true });
  console.log("Room with a waiting room:", room.url);
  await hostJoins(host);
  await host.getByTestId("host-lobby").waitFor();

  await joinWithCode(guest, room.code, "Bob");
  const waiting = await guest.getByTestId("guest-waiting").innerText({ timeout: 10_000 });
  console.log(`Guest sees: "${waiting.replace(/\s+/g, " ")}"`);
  if (!waiting.includes("Anya")) throw new Error("The guest should see who they're waiting for");

  await host.getByText("Bob wants to join").waitFor({ timeout: 10_000 });
  await host.getByTestId("knock-admit").click();
  console.log("Host let the guest in");

  await host.waitForURL(`${WEB}/r/${room.code}`);
  await guest.waitForURL(`${WEB}/r/${room.code}`);
  await waitConnected(host, "Anya");
  await waitConnected(guest, "Bob");
  console.log("Call connected");
  console.log("E2E OK");
} catch (err) {
  await shotOnFail(browser, "lobby");
  throw err;
} finally {
  await browser.close();
}
