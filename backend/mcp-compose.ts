import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import dotenv from "dotenv";
import yaml from "yaml";

export type ComposePath = string[];

export interface ComposeSnapshot {
    exists: boolean;
    composeYAML: string;
    composeENV: string;
}

/** Include existence and field boundaries so absent stacks and ambiguous concatenations differ. */
export function stackRevision(snapshot: ComposeSnapshot) : string {
    return createHash("sha256").update(JSON.stringify([
        snapshot.exists, snapshot.composeYAML, snapshot.composeENV,
    ])).digest("hex");
}

export function parseCompose(text: string) : Record<string, unknown> {
    const document = yaml.parseDocument(text, { logLevel: "silent" });
    if (document.errors.length || document.warnings.length) {
        throw new Error("Invalid compose document");
    }
    const value = document.toJS({ maxAliasCount: 50 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid compose document");
    }
    const ancestors = new Set<object>();
    const visit = (item: unknown, depth: number) => {
        if (item === null || typeof item !== "object") {
            return;
        }
        if (depth > 64 || ancestors.has(item)) {
            throw new Error("Invalid compose document");
        }
        ancestors.add(item);
        Object.values(item).forEach((child) => visit(child, depth + 1));
        ancestors.delete(item);
    };
    visit(value, 0);
    return value;
}

/** Paths remain arrays: service names and map keys may themselves contain dots. */
export function composeChangedPaths(current: string, desired: string) : ComposePath[] {
    const paths: ComposePath[] = [];
    const visit = (oldValue: unknown, newValue: unknown, path: ComposePath) => {
        if (isDeepStrictEqual(oldValue, newValue)) {
            return;
        }
        const oldMap = oldValue !== null && typeof oldValue === "object";
        const newMap = newValue !== null && typeof newValue === "object";
        if (oldMap && newMap && Array.isArray(oldValue) === Array.isArray(newValue)) {
            const oldRecord = oldValue as Record<string, unknown>;
            const newRecord = newValue as Record<string, unknown>;
            for (const key of [ ...new Set([ ...Object.keys(oldRecord), ...Object.keys(newRecord) ]) ].sort()) {
                visit(Object.hasOwn(oldRecord, key) ? oldRecord[key] : undefined, Object.hasOwn(newRecord, key) ? newRecord[key] : undefined, [ ...path, key ]);
            }
        } else {
            paths.push(path);
        }
    };
    visit(current ? parseCompose(current) : {}, parseCompose(desired), []);
    return paths;
}

export function envDelta(current: string, desired: string) {
    const oldEnv = dotenv.parse(current);
    const newEnv = dotenv.parse(desired);
    return {
        added: Object.keys(newEnv).filter((key) => !Object.hasOwn(oldEnv, key)).sort(),
        removed: Object.keys(oldEnv).filter((key) => !Object.hasOwn(newEnv, key)).sort(),
        changed: Object.keys(newEnv).filter((key) => Object.hasOwn(oldEnv, key) && oldEnv[key] !== newEnv[key]).sort(),
    };
}

export function composePlan(name: string, current: ComposeSnapshot, desired: ComposeSnapshot) {
    return {
        name,
        exists: current.exists,
        revision: stackRevision(current),
        compose_changed: current.composeYAML !== desired.composeYAML,
        changedPaths: composeChangedPaths(current.composeYAML, desired.composeYAML),
        env_changed: current.composeENV !== desired.composeENV,
        env_delta: envDelta(current.composeENV, desired.composeENV),
    };
}
