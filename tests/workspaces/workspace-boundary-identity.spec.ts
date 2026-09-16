import { describe, expect, it } from "vitest";
import { createWorkspaceBoundaryDirectoryIdentity } from "../../src/workspaces/workspace-boundary.js";
import { sameWorkspaceBoundaryIdentity } from "../../src/workspaces/workspace-boundary-identity.js";
const linux = (device = "1", inode = "2", canonical_path = "/repo") =>
  createWorkspaceBoundaryDirectoryIdentity({
    schema_version: "1.0.0",
    backend_kind: "linux-native",
    identity_kind: "linux-device-inode",
    path_comparison: "case-sensitive",
    device,
    inode,
    canonical_path,
  });
const windows = (volume = "01", file = "02", canonical_path = "D:\\repo") =>
  createWorkspaceBoundaryDirectoryIdentity({
    schema_version: "1.0.0",
    backend_kind: "windows-native",
    identity_kind: "windows-volume-file-id",
    path_comparison: "case-insensitive",
    volume_serial_number: volume,
    file_id: file,
    canonical_path,
  });
describe("portable broker directory identity", () => {
  it("detects replacement at the same path on either backend", () => {
    expect(sameWorkspaceBoundaryIdentity(linux(), linux("1", "3"))).toBe(false);
    expect(sameWorkspaceBoundaryIdentity(windows(), windows("01", "03"))).toBe(false);
  });
  it("distinguishes reused IDs on different volumes", () => {
    expect(sameWorkspaceBoundaryIdentity(linux(), linux("2"))).toBe(false);
    expect(sameWorkspaceBoundaryIdentity(windows(), windows("03"))).toBe(false);
  });
  it("never conflates identity backends", () => {
    expect(sameWorkspaceBoundaryIdentity(linux(), windows())).toBe(false);
  });
  it("compares physical identity independently from historical path spelling", () => {
    expect(sameWorkspaceBoundaryIdentity(windows(), windows("01", "02", "d:\\REPO"))).toBe(true);
    expect(sameWorkspaceBoundaryIdentity(linux(), linux("1", "2", "/renamed"))).toBe(true);
  });
});
