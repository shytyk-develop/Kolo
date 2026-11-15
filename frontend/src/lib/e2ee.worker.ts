// Runs off the main thread: every encoded audio / video frame passes through here
// right before it's sent and right after it's received.
import { clearBytes, deriveRoomKeys, FrameCipher } from "./e2ee";

export interface FrameCryptoOptions {
  side: "send" | "receive";
  kind: "audio" | "video";
  roomKey: string;
  roomCode: string;
  // whose frames these are: every sender has their own key
  senderId: string;
}

interface EncodedFrame {
  data: ArrayBuffer;
  type?: string;
}

interface Transformer {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options: FrameCryptoOptions;
}

let dropped = 0;

function run({ readable, writable, options }: Transformer): void {
  const cipher = deriveRoomKeys(options.roomKey, options.roomCode)
    .then((keys) => keys.frameKey(options.senderId))
    .then((key) => new FrameCipher(key));

  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      // empty frames happen (e.g. Chrome with muted video), nothing to do
      if (frame.data.byteLength === 0) return controller.enqueue(frame);
      try {
        const c = await cipher;
        frame.data =
          options.side === "send"
            ? await c.encrypt(frame.data, clearBytes(options.kind, frame.type === "key"))
            : await c.decrypt(frame.data);
        controller.enqueue(frame);
      } catch {
        // can't be decrypted: drop it, never let it through unencrypted
        dropped += 1;
        if (dropped === 1 || dropped % 200 === 0) postMessage({ type: "dropped", side: options.side, kind: options.kind, count: dropped });
      }
    },
  });
  readable.pipeThrough(transform).pipeTo(writable).catch(() => {});
}

const scope = self as unknown as {
  onrtctransform: ((event: { transformer: Transformer }) => void) | null;
  onmessage: ((event: MessageEvent<Transformer>) => void) | null;
};

// Safari, Firefox, new Chrome: RTCRtpScriptTransform
scope.onrtctransform = (event) => run(event.transformer);
// older Chrome: the streams are sent over by hand
scope.onmessage = (event) => run(event.data);
