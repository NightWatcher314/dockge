import assert from "node:assert/strict";
import { test } from "node:test";
import { composeChangedPaths, composePlan, envDelta, parseCompose, stackRevision } from "../mcp-compose";

test("revisions distinguish existence and compose/env boundaries", () => {
    const current = { exists: true,
        composeYAML: "ab",
        composeENV: "c" };
    assert.match(stackRevision(current), /^[a-f0-9]{64}$/);
    assert.notEqual(stackRevision(current), stackRevision({ ...current,
        exists: false }));
    assert.notEqual(stackRevision(current), stackRevision({ ...current,
        composeYAML: "a",
        composeENV: "bc" }));
    assert.equal(stackRevision(current), stackRevision({ ...current }));
});

test("changed paths preserve dotted keys and array indices", () => {
    const current = "services:\n  web.api:\n    image: old\n    ports: [80:80]\n";
    const desired = "services:\n  web.api:\n    image: new\n    ports: [81:80]\n";
    assert.deepEqual(composeChangedPaths(current, desired), [
        [ "services", "web.api", "image" ],
        [ "services", "web.api", "ports", "0" ],
    ]);
    assert.deepEqual(composeChangedPaths("services: {}", "services:\n  web: {image: new}"), [[ "services", "web" ]]);
    assert.deepEqual(composeChangedPaths("services: {}\n", "# comment\nservices: {}\n"), []);
});

test("plan and env delta contain keys and paths without values", () => {
    const plan = composePlan("test", { exists: true,
        composeYAML: "services: {web: {image: old-secret}}",
        composeENV: "OLD=secret1\nSAME=secret2\n" },
    { exists: true,
        composeYAML: "services: {web: {image: new-secret}}",
        composeENV: "NEW=secret3\nSAME=changed-secret\n" });
    assert.deepEqual(plan.env_delta, { added: [ "NEW" ],
        removed: [ "OLD" ],
        changed: [ "SAME" ] });
    assert.equal(plan.env_changed, true);
    assert.equal(JSON.stringify(plan).includes("secret"), false);
    assert.deepEqual(envDelta("# OLD=secret\nexport X='one'\n", "X=one\n"), { added: [],
        removed: [],
        changed: [] });
});

test("invalid and non-mapping YAML fails rather than returning raw parser errors", () => {
    assert.throws(() => parseCompose("services: ["));
    assert.throws(() => parseCompose("- a\n- b"));
    assert.throws(() => parseCompose(""));
    assert.throws(() => parseCompose("services: &self {web: *self}"));
    assert.throws(() => parseCompose("services: !unsupported {}"));
});
