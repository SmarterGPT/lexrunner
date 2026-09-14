// Controlled protocol peer. It performs no filesystem or worker operations.
import { randomBytes } from "node:crypto";
const mode = process.argv[2];
const digest = process.argv[3];
const encode = (value) => {
  const ordered = (v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, ordered(v[key])])
        )
      : v;
  const payload = Buffer.from(JSON.stringify(ordered(value), null, 2) + "\n");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};
let input = Buffer.alloc(0);
let sent = false;
if (mode === "early-exit") process.exit(2);
process.stdin.on("data", (chunk) => {
  if (sent && mode === "session-exit") process.exit(0);
  input = Buffer.concat([input, chunk]);
  if (input.length > 4_100) process.exit(3);
  if (sent || input.length < 4 || input.length < 4 + input.readUInt32BE()) return;
  sent = true;
  if (mode === "silent") return;
  const request = JSON.parse(input.subarray(4).toString("utf8"));
  const response = {
    ...request,
    kind: "hello_result",
    session_nonce: randomBytes(32).toString("hex"),
    helper: { artifact_sha256: digest, architecture: process.arch, process_id: process.pid },
  };
  if (mode === "wrong-pid") response.helper.process_id++;
  if (mode === "wrong-nonce") response.client_nonce = "d".repeat(64);
  if (mode === "wrong-digest") response.helper.artifact_sha256 = `sha256:${"e".repeat(64)}`;
  const frame = encode(response);
  if (mode === "garbage") {
    process.stdout.write(Buffer.from([0, 0, 0, 1, 0xff]));
    return;
  }
  if (mode === "partial") {
    process.stdout.write(frame.subarray(0, frame.length - 1), () => process.exit(0));
    return;
  }
  if (mode === "stderr-overflow") {
    process.stderr.write(Buffer.alloc(65_537, 120));
    return;
  }
  if (mode === "fragmented") {
    process.stdout.write(frame.subarray(0, 2));
    setTimeout(() => process.stdout.write(frame.subarray(2)), 10);
  } else process.stdout.write(frame);
  if (mode === "duplicate") process.stdout.write(frame);
  if (mode === "trailing-partial") process.stdout.write(Buffer.from([0, 0]));
});
process.stdin.on("end", () => {
  if (mode === "ignore-eof") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "nonzero-exit") process.exitCode = 7;
});
