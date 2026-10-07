import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { humanAnswerFixture } from "../store/worker-human-answer-fixture.js";
import { TrustedHumanAnswerVerifier } from "../../src/runs/trusted-human-answer-verifier.js";
import { WorkerHumanAnswerPayload } from "../../src/schemas/worker-human-answer.js";

let fixture: Awaited<ReturnType<typeof humanAnswerFixture>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
describe("explicit human-host cryptographic boundary", () => {
  it.each(["private-key", "wrong-algorithm", "duplicate-key", "duplicate-actor", "empty"])(
    "rejects invalid trust configuration: %s",
    async (attack) => {
      fixture = await humanAnswerFixture("memory");
      const entries = attack === "empty" ? [] : [{ ...fixture.trust }];
      if (attack === "private-key")
        entries[0].publicKeyPem = fixture.keys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString();
      if (attack === "wrong-algorithm")
        entries[0].publicKeyPem = generateKeyPairSync("x25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString();
      if (attack === "duplicate-key") entries.push({ ...entries[0] });
      if (attack === "duplicate-actor") entries[0].actorIds = ["human-1", "human-1"];
      expect(() => new TrustedHumanAnswerVerifier(entries)).toThrow();
    }
  );
  it("bounds UTF-8 answer bytes and rejects duplicate question IDs", async () => {
    fixture = await humanAnswerFixture("memory");
    const challenge = await fixture.challenge(await fixture.record());
    const payload = fixture.signed(challenge).payload;
    expect(
      WorkerHumanAnswerPayload.safeParse({
        ...payload,
        answers: [payload.answers[0], payload.answers[0]],
      }).success
    ).toBe(false);
    expect(
      WorkerHumanAnswerPayload.safeParse({
        ...payload,
        answers: Array.from({ length: 8 }, (_, i) => ({
          questionId: `q${i}`,
          value: "界".repeat(4096),
        })),
      }).success
    ).toBe(false);
    expect(
      fixture.verifier.verify({ ...fixture.signed(challenge), signature: "A".repeat(86) })
    ).toBe(false);
  });
  it("preserves literal special question IDs and free-text answer bytes in the portable contract", async () => {
    fixture = await humanAnswerFixture("memory");
    const capture = fixture.capture();
    capture.questions[0] = { ...capture.questions[0], id: "__proto__", options: null };
    const challenge = await fixture.challenge(await fixture.record(capture));
    const answer = fixture.signed(challenge, {
      answers: [{ questionId: "__proto__", value: "<script>untrusted display text</script>\n界" }],
    });
    expect(
      await fixture.service.admitWorkerAnswer({ ...(await fixture.mutation("answer")), answer })
    ).toMatchObject({ ok: true });
    expect(
      (await fixture.service.getWorkerAnswer("run", challenge.requestId))!.answer.payload.answers
    ).toEqual(answer.payload.answers);
  });
});
