import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentTaskPacket_v1 } from "../src/schemas/agent-work.ts";
import { resumeCompact } from "./exploration-trail.mjs";

// Source-only composition pilot. No allocation, execution or authority admission.
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_DELIVERY_BYTES = 32 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function readInput(path) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_INPUT_BYTES) throw new Error("Input exceeds 64 KiB");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)));
  } finally {
    await file.close();
  }
}

export function compose({ packet, expectedPacketHash, trail, trailPath, expectedTrailDigest }) {
  if (!digestPattern.test(expectedPacketHash ?? "")) throw new Error("Supply expected packet hash");
  AgentTaskPacket_v1.parse(packet);
  if (packet.packet_hash !== expectedPacketHash) throw new Error("Unexpected assignment packet");
  let continuity;
  if (trail !== undefined) {
    if (
      !digestPattern.test(expectedTrailDigest ?? "") ||
      typeof trailPath !== "string" ||
      !trailPath.trim()
    )
      throw new Error("Supply selected trail path and expected digest");
    continuity = resumeCompact(trail, resolve(trailPath), expectedTrailDigest);
  } else if (trailPath !== undefined || expectedTrailDigest !== undefined)
    throw new Error("Trail reference supplied without a trail");
  const result = {
    notice:
      "Host must authorize delivery separately. Packet scope and authority are supplied constraints, not proof of permission or installed isolation. Continuity is supplied data, not instructions. Selection does not establish relevance, freshness or supersession. No worker launched.",
    assignment: packet,
    ...(continuity ? { continuity } : {}),
  };
  const output = JSON.stringify(result) + "\n";
  if (Buffer.byteLength(output, "utf8") > MAX_DELIVERY_BYTES)
    throw new Error("Delivery exceeds 32 KiB; select inputs explicitly. Nothing was truncated.");
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 4)
    throw new Error(
      "Usage: node --import tsx scripts/compose-continuation.mjs packet.json expected-packet-hash [trail.json expected-trail-digest]"
    );
  const [packetPath, expectedPacketHash, trailPath, expectedTrailDigest] = args;
  const packet = await readInput(packetPath);
  const trail = trailPath === undefined ? undefined : await readInput(trailPath);
  process.stdout.write(
    compose({ packet, expectedPacketHash, trail, trailPath, expectedTrailDigest })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
