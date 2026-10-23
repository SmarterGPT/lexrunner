import { createHash } from "node:crypto";

import type { Plan } from "../schema.js";

export interface GateArtifactDeclarationSelection {
  plan: Plan;
  onlyItem?: string;
  onlyGate?: string;
}

export interface UnsupportedGateArtifactDeclaration {
  itemName: string;
  gateName: string;
  declarationIndex: number;
  declaration: string;
}

/** Artifact collection is intentionally literal; expansion would make retained evidence ambiguous. */
export function findUnsupportedArtifactDeclaration(
  input: GateArtifactDeclarationSelection
): UnsupportedGateArtifactDeclaration | null {
  for (const item of input.plan.items) {
    if (input.onlyItem && item.name !== input.onlyItem) continue;
    for (const gate of item.gates) {
      if (input.onlyGate && gate.name !== input.onlyGate) continue;
      for (const [declarationIndex, declaration] of (gate.artifacts ?? []).entries()) {
        if (isUnsupportedArtifactDeclaration(declaration)) {
          return { itemName: item.name, gateName: gate.name, declarationIndex, declaration };
        }
      }
    }
  }
  return null;
}

export function artifactDeclarationErrorMessage(
  unsupported: UnsupportedGateArtifactDeclaration,
  subject: "Gate" | "Durable gate"
): string {
  return `${subject} artifact declaration is unsupported for item ${boundedDiagnostic(
    unsupported.itemName
  )}, gate ${boundedDiagnostic(unsupported.gateName)}, artifacts[${unsupported.declarationIndex}]: ${boundedDiagnostic(
    unsupported.declaration
  )}; exact literal paths are required`;
}

export function isUnsupportedArtifactDeclaration(declaration: string): boolean {
  return (
    declaration.length === 0 ||
    declaration.includes("\0") ||
    ["*", "?", "[", "]", "{", "}"].some((token) => declaration.includes(token)) ||
    /[@+!]\(/u.test(declaration)
  );
}

function boundedDiagnostic(value: string): string {
  const maxBytes = 256;
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character, "utf8") > maxBytes) break;
    prefix += character;
  }
  const rendered = JSON.stringify(prefix);
  if (prefix === value) return rendered;
  const digest = createHash("sha256").update(value).digest("hex");
  return `${rendered}… (sha256:${digest})`;
}
