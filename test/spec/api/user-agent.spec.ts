import { CallIdFormat, Messager } from "../../../lib/api/index.js";
import { connectUserFake, makeUserFake, UserFake } from "../../support/api/user-fake.js";
import { soon } from "../../support/api/utils.js";

/**
 * TODO:
 * UserAgent Integration Tests
 */

describe("API UserAgent", () => {
  let alice: UserFake;
  let bob: UserFake;

  beforeEach(async () => {
    jasmine.clock().install();
    alice = await makeUserFake("alice", "example.com", "Alice");
    bob = await makeUserFake("bob", "example.com", "Bob");
    connectUserFake(alice, bob);
  });

  afterEach(async () => {
    return alice.userAgent
      .stop()
      .then(() => expect(alice.isShutdown()).toBe(true))
      .then(() => bob.userAgent.stop())
      .then(() => expect(bob.isShutdown()).toBe(true))
      .then(() => jasmine.clock().uninstall());
  });

  describe("Alice exists", () => {
    beforeEach(async () => {
      await soon();
    });

    it("has a configuration", () => {
      const configuration = alice.userAgent.configuration;
      expect(configuration).toBeDefined();
    });

    it("defaults to the legacy Call-ID format", () => {
      expect(alice.userAgent.configuration.callIdFormat).toBe("legacy");
    });
  });
});

describe("API UserAgent Call-ID format", () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const formats: Array<{ format: CallIdFormat; check: (callId: string, sipjsId: string) => void }> = [
    {
      format: "legacy",
      check: (callId, sipjsId): void => {
        expect(callId).toMatch(/^[0-9a-v]{20}$/);
        expect(callId.substr(0, 5)).toBe(sipjsId);
      }
    },
    {
      format: "uuid",
      check: (callId): void => {
        expect(callId).toMatch(uuidV4);
      }
    }
  ];

  formats.forEach(({ format, check }) => {
    describe(`"${format}"`, () => {
      let alice: UserFake;
      let bob: UserFake;
      let request: string;
      let callId: string;

      beforeEach(async () => {
        jasmine.clock().install();
        alice = await makeUserFake("alice", "example.com", "Alice", { callIdFormat: format });
        bob = await makeUserFake("bob", "example.com", "Bob");
        connectUserFake(alice, bob);
        bob.transport.receiveDropOnce();
        new Messager(alice.userAgent, bob.uri, "Hello").message();
        await soon();
        request = alice.transportSendSpy.calls.mostRecent().args[0];
        const match = request.match(/^Call-ID: (.*)\r$/m);
        callId = match ? match[1] : "";
        alice.transportSendSpy.calls.reset();
      });

      afterEach(async () => {
        return alice.userAgent
          .stop()
          .then(() => bob.userAgent.stop())
          .then(() => jasmine.clock().uninstall());
      });

      it("Alice's request has the expected Call-ID", () => {
        check(callId, alice.userAgent.configuration.sipjsId);
      });

      it("Alice rejects her own request looped back to her with a 482", async () => {
        alice.transport.receive(request);
        await soon();
        expect(alice.transportSendSpy).toHaveBeenCalledTimes(1);
        expect(alice.transportSendSpy.calls.mostRecent().args[0]).toMatch(/^SIP\/2\.0 482 /);
      });

      it("Alice does not reject a request with a different Call-ID", async () => {
        alice.transport.receive(request.replace(callId, "not-" + callId));
        await soon();
        expect(alice.transportSendSpy).toHaveBeenCalledTimes(1);
        expect(alice.transportSendSpy.calls.mostRecent().args[0]).not.toMatch(/^SIP\/2\.0 482 /);
      });
    });
  });
});
