import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginRateLimiter } from "../rate-limiter";
import {
    completeSuccessfulLogin,
    getLoginRateLimitKeys
} from "../socket-handlers/main-socket-handler";

class InspectableLoginRateLimiter extends LoginRateLimiter {
    get trackedBucketCount() {
        return this.attempts.size;
    }
}

test("successful login attempts do not consume the failed-attempt budget", () => {
    const limiter = new LoginRateLimiter(2, 10, 60000, "limited");
    const errors : object[] = [];
    const keys = getLoginRateLimitKeys("192.0.2.1", "Admin");

    const successfulAttempt = limiter.reserve(keys.account, keys.source, (error) => errors.push(error));
    assert.notEqual(successfulAttempt, null);
    if (successfulAttempt) {
        limiter.complete(successfulAttempt, "authenticated");
    }

    assert.notEqual(limiter.reserve(keys.account, keys.source, (error) => errors.push(error)), null);
    assert.notEqual(limiter.reserve(keys.account, keys.source, (error) => errors.push(error)), null);
    assert.equal(limiter.reserve(keys.account, keys.source, (error) => errors.push(error)), null);
    assert.deepEqual(errors, [{
        ok: false,
        msg: "limited",
    }]);
});

test("2FA challenge responses release reservations but invalid tokens retain them", () => {
    const callback = () => {};
    const keys = getLoginRateLimitKeys("192.0.2.1", "Admin");
    const challengeLimiter = new LoginRateLimiter(1, 10, 60000, "limited");
    const challenge = challengeLimiter.reserve(keys.account, keys.source, callback);
    assert.notEqual(challenge, null);
    if (challenge) {
        challengeLimiter.complete(challenge, "challenge-required");
    }
    assert.notEqual(challengeLimiter.reserve(keys.account, keys.source, callback), null);

    const invalidLimiter = new LoginRateLimiter(1, 10, 60000, "limited");
    const invalid = invalidLimiter.reserve(keys.account, keys.source, callback);
    assert.notEqual(invalid, null);
    if (invalid) {
        invalidLimiter.complete(invalid, "failed");
    }
    assert.equal(invalidLimiter.reserve(keys.account, keys.source, callback), null);
});

test("successful login completion waits for afterLogin", async () => {
    let releaseAfterLogin : (() => void) | undefined;
    let afterLoginFinished = false;
    const afterLoginGate = new Promise<void>((resolve) => {
        releaseAfterLogin = resolve;
    });
    const server = {
        afterLogin: async () => {
            await afterLoginGate;
            afterLoginFinished = true;
        },
    };
    let finalizeFinished = false;
    let completedResult : string | undefined;

    const completion = completeSuccessfulLogin(server as never, {} as never, {} as never, {
        id: 1,
        bucketKeys: [ "account:test" ],
    }, async () => {
        finalizeFinished = true;
    }, {
        complete: (_reservation, result) => {
            completedResult = result;
        },
    });
    await Promise.resolve();
    assert.equal(afterLoginFinished, false);
    assert.equal(finalizeFinished, true);
    assert.equal(completedResult, undefined);

    releaseAfterLogin?.();
    await completion;
    assert.equal(afterLoginFinished, true);
    assert.equal(finalizeFinished, true);
    assert.equal(completedResult, "authenticated");
});

test("failed-attempt budgets are isolated by source IP and username", () => {
    const limiter = new LoginRateLimiter(1, 10, 60000, "limited");
    const callback = () => {};
    const directKeys = getLoginRateLimitKeys("192.0.2.1", "admin");
    const otherSourceKeys = getLoginRateLimitKeys("192.0.2.2", "admin");
    const otherAccountKeys = getLoginRateLimitKeys("192.0.2.1", "other");

    assert.notEqual(limiter.reserve(directKeys.account, directKeys.source, callback), null);
    assert.equal(limiter.reserve(directKeys.account, directKeys.source, callback), null);
    assert.notEqual(limiter.reserve(otherSourceKeys.account, otherSourceKeys.source, callback), null);
    assert.notEqual(limiter.reserve(otherAccountKeys.account, otherAccountKeys.source, callback), null);
});

test("source-wide budget stops username spraying", () => {
    const limiter = new LoginRateLimiter(2, 2, 60000, "limited");
    const callback = () => {};
    const first = getLoginRateLimitKeys("192.0.2.1", "first");
    const second = getLoginRateLimitKeys("192.0.2.1", "second");
    const third = getLoginRateLimitKeys("192.0.2.1", "third");

    assert.notEqual(limiter.reserve(first.account, first.source, callback), null);
    assert.notEqual(limiter.reserve(second.account, second.source, callback), null);
    assert.equal(limiter.reserve(third.account, third.source, callback), null);
});

test("tracked login buckets are bounded under distributed spraying", () => {
    const limiter = new LoginRateLimiter(100, 100, 60000, "limited", () => 0, 3);
    const callbackErrors : object[] = [];
    const callback = (error : object) => callbackErrors.push(error);
    const first = getLoginRateLimitKeys("192.0.2.1", "first");
    const second = getLoginRateLimitKeys("192.0.2.1", "second");
    const distributed = getLoginRateLimitKeys("192.0.2.2", "third");

    assert.notEqual(limiter.reserve(first.account, first.source, callback), null);
    assert.notEqual(limiter.reserve(second.account, second.source, callback), null);
    assert.equal(limiter.reserve(distributed.account, distributed.source, callback), null);
    assert.deepEqual(callbackErrors, [{
        ok: false,
        msg: "limited",
    }]);
});

test("capacity pressure prunes unrelated expired buckets before rejecting", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(100, 100, 1000, "limited", () => now, 3);
    const first = getLoginRateLimitKeys("192.0.2.1", "first");
    const second = getLoginRateLimitKeys("192.0.2.1", "second");
    const third = getLoginRateLimitKeys("192.0.2.1", "third");
    const fourth = getLoginRateLimitKeys("192.0.2.1", "fourth");

    assert.notEqual(limiter.reserve(first.account, first.source, () => {}), null);
    now = 100;
    assert.notEqual(limiter.reserve(second.account, second.source, () => {}), null);
    now = 1000;
    assert.notEqual(limiter.reserve(third.account, third.source, () => {}), null);
    now = 1101;
    assert.notEqual(limiter.reserve(fourth.account, fourth.source, () => {}), null);
});

test("expired failures are removed from every tracked bucket", () => {
    let now = 0;
    const limiter = new InspectableLoginRateLimiter(1, 2, 1000, "limited", () => now);
    const oldKeys = getLoginRateLimitKeys("192.0.2.1", "admin");

    assert.notEqual(limiter.reserve(oldKeys.account, oldKeys.source, () => {}), null);
    assert.equal(limiter.trackedBucketCount, 2);
    now = 1001;
    const newKeys = getLoginRateLimitKeys("192.0.2.2", "other");
    assert.notEqual(limiter.reserve(newKeys.account, newKeys.source, () => {}), null);
    assert.equal(limiter.trackedBucketCount, 2);
    assert.notEqual(limiter.reserve(oldKeys.account, oldKeys.source, () => {}), null);
});
