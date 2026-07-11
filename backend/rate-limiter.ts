// "limit" is bugged in Typescript, use "limiter-es6-compat" instead
// See https://github.com/jhurliman/node-rate-limiter/issues/80
import { RateLimiter, RateLimiterOpts } from "limiter-es6-compat";
import { log } from "./log";

export interface KumaRateLimiterOpts extends RateLimiterOpts {
    errorMessage : string;
}

export type KumaRateLimiterCallback = (err : object) => void;

class KumaRateLimiter {

    errorMessage : string;
    rateLimiter : RateLimiter;

    /**
     * @param {object} config Rate limiter configuration object
     */
    constructor(config : KumaRateLimiterOpts) {
        this.errorMessage = config.errorMessage;
        this.rateLimiter = new RateLimiter(config);
    }

    /**
     * Callback for pass
     * @callback passCB
     * @param {object} err Too many requests
     */

    /**
     * Should the request be passed through
     * @param callback Callback function to call with decision
     * @param {number} num Number of tokens to remove
     * @returns {Promise<boolean>} Should the request be allowed?
     */
    async pass(callback : KumaRateLimiterCallback, num = 1) {
        const remainingRequests = await this.removeTokens(num);
        log.info("rate-limit", "remaining requests: " + remainingRequests);
        if (remainingRequests < 0) {
            if (callback) {
                callback({
                    ok: false,
                    msg: this.errorMessage,
                });
            }
            return false;
        }
        return true;
    }

    /**
     * Remove a given number of tokens
     * @param {number} num Number of tokens to remove
     * @returns {Promise<number>} Number of remaining tokens
     */
    async removeTokens(num = 1) {
        return await this.rateLimiter.removeTokens(num);
    }
}

interface LoginAttempt {
    id : number;
    timestamp : number;
}

export interface LoginRateLimitReservation {
    id : number;
    bucketKeys : string[];
}

export type LoginAttemptResult = "authenticated" | "challenge-required" | "failed";

export class LoginRateLimiter {
    protected attempts = new Map<string, LoginAttempt[]>();
    protected nextID = 1;
    protected nextGlobalPruneAt = 0;
    protected nextCapacityPruneAt = 0;

    constructor(
        protected maxAttemptsPerAccount : number,
        protected maxAttemptsPerSource : number,
        protected interval : number,
        protected errorMessage : string,
        protected now : () => number = Date.now,
        protected maxTrackedBuckets = 10000
    ) {}

    reserve(accountKey : string, sourceKey : string, callback : KumaRateLimiterCallback) : LoginRateLimitReservation | null {
        const buckets = [
            {
                key: "account:" + accountKey,
                limit: this.maxAttemptsPerAccount,
            },
            {
                key: "source:" + sourceKey,
                limit: this.maxAttemptsPerSource,
            },
        ];

        const now = this.now();
        if (now >= this.nextGlobalPruneAt) {
            this.pruneExpiredAttempts(now);
            this.nextGlobalPruneAt = now + this.interval;
        }
        for (const { key } of buckets) {
            this.pruneBucket(key, now);
        }

        let newBucketCount = buckets.filter(({ key }) => !this.attempts.has(key)).length;
        if (
            this.attempts.size + newBucketCount > this.maxTrackedBuckets &&
            now >= this.nextCapacityPruneAt
        ) {
            this.pruneExpiredAttempts(now);
            this.nextCapacityPruneAt = now + Math.min(this.interval, 5000);
            newBucketCount = buckets.filter(({ key }) => !this.attempts.has(key)).length;
        }
        if (this.attempts.size + newBucketCount > this.maxTrackedBuckets) {
            callback({
                ok: false,
                msg: this.errorMessage,
            });
            return null;
        }

        if (buckets.some(({ key, limit }) => (this.attempts.get(key)?.length || 0) >= limit)) {
            callback({
                ok: false,
                msg: this.errorMessage,
            });
            return null;
        }

        const id = this.nextID++;
        for (const { key } of buckets) {
            const attempts = this.attempts.get(key) || [];
            attempts.push({
                id,
                timestamp: now,
            });
            this.attempts.set(key, attempts);
        }

        log.info("rate-limit", "remaining account login attempts: " +
            (this.maxAttemptsPerAccount - (this.attempts.get(buckets[0].key)?.length || 0)));
        return {
            id,
            bucketKeys: buckets.map(({ key }) => key),
        };
    }

    recordSuccess(reservation : LoginRateLimitReservation) {
        for (const key of reservation.bucketKeys) {
            const attempts = (this.attempts.get(key) || []).filter((attempt) => attempt.id !== reservation.id);
            if (attempts.length === 0) {
                this.attempts.delete(key);
            } else {
                this.attempts.set(key, attempts);
            }
        }
    }

    complete(reservation : LoginRateLimitReservation, result : LoginAttemptResult) {
        if (result !== "failed") {
            this.recordSuccess(reservation);
        }
    }

    protected pruneBucket(key : string, now : number) {
        const attempts = this.attempts.get(key);
        if (!attempts) {
            return;
        }
        const cutoff = now - this.interval;
        const currentAttempts = attempts.filter((attempt) => attempt.timestamp > cutoff);
        if (currentAttempts.length === 0) {
            this.attempts.delete(key);
        } else if (currentAttempts.length !== attempts.length) {
            this.attempts.set(key, currentAttempts);
        }
    }

    protected pruneExpiredAttempts(now : number) {
        const cutoff = now - this.interval;
        for (const [ key, attempts ] of this.attempts) {
            const currentAttempts = attempts.filter((attempt) => attempt.timestamp > cutoff);
            if (currentAttempts.length === 0) {
                this.attempts.delete(key);
            } else {
                this.attempts.set(key, currentAttempts);
            }
        }
    }
}

export const loginRateLimiter = new LoginRateLimiter(
    20,
    100,
    60 * 1000,
    "Too frequently, try again later."
);

export const apiRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 60,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later."
});

export const twoFaRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 30,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later."
});
