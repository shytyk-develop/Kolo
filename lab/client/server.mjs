// one browser, driven from the runner over the side network
import { chromium, firefox } from "playwright";

const engine = process.env.LAB_BROWSER === "firefox" ? firefox : chromium;
const options =
  engine === firefox
    ? {
        firefoxUserPrefs: {
          "media.navigator.streams.fake": true,
          "media.navigator.permission.disabled": true,
          "security.enterprise_roots.enabled": true,
        },
      }
    : {
        args: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          // like a real user who allowed the camera: real local addresses instead of
          // .local names (there is no mDNS between the containers)
          "--disable-features=WebRtcHideLocalIpsWithMdns",
        ],
      };

const server = await engine.launchServer({ ...options, host: "0.0.0.0", port: 9323, wsPath: "/pw" });
console.log("browser ready:", server.wsEndpoint());
