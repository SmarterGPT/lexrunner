import type { OwnedWindowsDirectoryScope } from "./owned-windows-boundary-handshake.js";
import type {
  WindowsRemovalPayload,
  WindowsRemovalResultPayload,
} from "./windows-removal-protocol.js";

// Private transport association; no raw directory token enters durable records.
interface Channel {
  owner: object;
  token: string;
  invoke(payload: WindowsRemovalPayload): Promise<WindowsRemovalResultPayload>;
}
const channels = new WeakMap<OwnedWindowsDirectoryScope, Channel>();
export function registerWindowsRemovalChannel(
  scope: OwnedWindowsDirectoryScope,
  channel: Channel
): void {
  channels.set(scope, channel);
}
export function windowsRemovalChannel(
  root: OwnedWindowsDirectoryScope,
  registration: OwnedWindowsDirectoryScope,
  slot: OwnedWindowsDirectoryScope
) {
  const first = channels.get(root),
    second = channels.get(registration),
    third = channels.get(slot);
  if (!first || !second || !third || first.owner !== second.owner || first.owner !== third.owner)
    throw new Error("Removal parents must belong to one live owned session");
  return {
    tokens: {
      root_parent_token: first.token,
      registration_parent_token: second.token,
      slot_parent_token: third.token,
    },
    invoke: first.invoke,
  };
}
