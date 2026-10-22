import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DockgeServer } from "../dockge-server";
import type { DockgeSocket } from "../util-server";
import { McpError, McpService } from "../mcp-service";
import { Stack } from "../stack";
import childProcessAsync from "promisify-child-process";
import type { ComposeSnapshot } from "../mcp-compose";

const identity = { userId: 1,
    scopes: [ "read", "write", "destructive", "secrets" ] };
const oldCompose = "services:\n  web.api:\n    image: old-secret-image\n";
const newCompose = "services:\n  web.api:\n    image: new-secret-image\n";

async function context(t: TestContext, existing = true) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-mcp-"));
    t.after(() => fs.rm(dir, { recursive: true,
        force: true }));
    if (existing) {
        await fs.mkdir(path.join(dir, "test"));
        await fs.writeFile(path.join(dir, "test", "compose.yaml"), oldCompose);
        await fs.writeFile(path.join(dir, "test", ".env"), "TOKEN=env-secret\n");
    }
    const server = { stacksDir: dir,
        packageJSON: { version: "test" } } as DockgeServer;
    const service = new McpService(server);
    t.mock.method(Stack.prototype, "getServiceStatusList", async () => new Map([
        [ "web.api", [{ name: "test-web-1",
            status: "running",
            credentials: "hidden" }]],
    ]));
    return { dir,
        server,
        service };
}

function gate(plan: Record<string, unknown>) {
    return { expectedRevision: plan.revision,
        allowedPaths: plan.changedPaths,
        allowEnvChange: true,
        confirm: true };
}

function errorCode(code: string) {
    return (error: unknown) => error instanceof McpError && error.code === code;
}

test("every local operation checks read scope; all mutations also check write", async (t) => {
    const { service } = await context(t);
    for (const operation of [ "doctor", "stack_list", "stack_get", "stack_ps", "stack_logs", "stack_plan", "stack_diff", "stack_save", "stack_deploy", "stack_apply", "stack_verify", "stack_action", "service_status", "service_action", "network_list", "composerize" ]) {
        await assert.rejects(service.execute(operation, {}, { userId: 1,
            scopes: [] }), errorCode("FORBIDDEN"));
    }
    for (const operation of [ "stack_save", "stack_deploy", "stack_apply", "stack_action", "service_action" ]) {
        await assert.rejects(service.execute(operation, {}, { userId: 1,
            scopes: [ "read" ] }), errorCode("FORBIDDEN"));
    }
});

test("default reads allowlist metadata and nested service status; secrets opt-in is enforced", async (t) => {
    const { service } = await context(t);
    const data = await service.execute("stack_get", { name: "test" }, identity);
    assert.equal(JSON.stringify(data).includes("secret"), false);
    assert.equal(Object.hasOwn(data, "composeYAML"), false);
    const status = await service.execute("service_status", { name: "test" }, identity);
    assert.deepEqual(status.services, [{ service: "web.api",
        containers: [{ name: "test-web-1",
            status: "running" }] }]);
    assert.equal(JSON.stringify(status).includes("hidden"), false);
    for (const [ operation, args ] of [
        [ "stack_get", { name: "test",
            includeSecrets: true }],
        [ "stack_diff", { name: "test",
            composeYAML: newCompose,
            includeValues: true }],
        [ "stack_logs", { name: "test" }],
        [ "composerize", { command: "docker run nginx" }],
    ] as const) {
        await assert.rejects(service.execute(operation, args, { userId: 1,
            scopes: [ "read" ] }), errorCode("FORBIDDEN"));
    }
    const secretData = await service.execute("stack_get", { name: "test",
        includeSecrets: true }, identity);
    assert.equal(secretData.composeENV, "TOKEN=env-secret\n");
});

test("existing writes enforce revision, exact paths, overwrite scope, confirmation and env gate", async (t) => {
    const { service, dir } = await context(t);
    const args = { name: "test",
        composeYAML: newCompose,
        composeENV: "TOKEN=changed-secret\n" };
    const plan = await service.execute("stack_plan", args, identity);
    const authorized = { ...args,
        ...gate(plan) };
    await assert.rejects(service.execute("stack_save", { ...authorized,
        expectedRevision: "stale" }, identity), errorCode("REVISION_CONFLICT"));
    await assert.rejects(service.execute("stack_save", { ...authorized,
        allowedPaths: [[ "services", "web.api" ]] }, identity), errorCode("PATH_NOT_ALLOWED"));
    await assert.rejects(service.execute("stack_save", { ...authorized,
        confirm: false }, identity), errorCode("CONFIRMATION_REQUIRED"));
    await assert.rejects(service.execute("stack_save", authorized, { userId: 1,
        scopes: [ "read", "write" ] }), errorCode("FORBIDDEN"));
    await assert.rejects(service.execute("stack_save", { ...authorized,
        allowEnvChange: false }, identity), errorCode("ENV_CHANGE_NOT_ALLOWED"));
    assert.equal(await fs.readFile(path.join(dir, "test", "compose.yaml"), "utf8"), oldCompose);
});

test("omitted env preserves it; explicitly empty env clears it with permission", async (t) => {
    const { service, dir } = await context(t);
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    assert.equal(plan.env_changed, false);
    await service.execute("stack_save", { ...args,
        ...gate(plan),
        allowEnvChange: false }, identity);
    assert.equal(await fs.readFile(path.join(dir, "test", ".env"), "utf8"), "TOKEN=env-secret\n");
    const clear = { ...args,
        composeENV: "" };
    const clearPlan = await service.execute("stack_plan", clear, identity);
    await service.execute("stack_save", { ...clear,
        ...gate(clearPlan) }, identity);
    assert.equal(await fs.readFile(path.join(dir, "test", ".env"), "utf8"), "");
});

test("new stacks require absent revision from plan and preserve omitted empty env", async (t) => {
    const { service, dir } = await context(t, false);
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    assert.equal(plan.exists, false);
    await assert.rejects(service.execute("stack_save", { ...args,
        allowedPaths: plan.changedPaths }, identity), errorCode("REVISION_CONFLICT"));
    const result = await service.execute("stack_save", { ...args,
        ...gate(plan) }, { userId: 1,
        scopes: [ "read", "write" ] });
    assert.equal(result.applied, true);
    await assert.rejects(fs.access(path.join(dir, "test", ".env")));
});

test("concurrent MCP writes serialize and the loser observes a stale revision", async (t) => {
    const { service, server } = await context(t);
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    const args2 = { ...args,
        ...gate(plan),
        composeYAML: newCompose.replace("new-secret-image", "other-secret-image") };
    const results = await Promise.allSettled([
        service.execute("stack_save", { ...args,
            ...gate(plan) }, identity),
        new McpService(server).execute("stack_save", args2, identity),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") {
        assert.equal(results[1].reason.code, "REVISION_CONFLICT");
    }
});

test("a web write before the final gate is detected and preserved", async (t) => {
    const { service, dir } = await context(t);
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    const internal = service as unknown as { snapshot: (name: string) => ComposeSnapshot };
    const snapshot = internal.snapshot.bind(service);
    let reads = 0;
    const webCompose = newCompose.replace("new-secret-image", "web-secret-image");
    t.mock.method(internal, "snapshot", (name: string) => {
        if (++reads === 2) {
            writeFileSync(path.join(dir, "test", "compose.yaml"), webCompose);
        }
        return snapshot(name);
    });
    await assert.rejects(service.execute("stack_save", { ...args,
        ...gate(plan) }, identity), errorCode("REVISION_CONFLICT"));
    assert.equal(await fs.readFile(path.join(dir, "test", "compose.yaml"), "utf8"), webCompose);
});

test("persistence readback failure prevents deploying", async (t) => {
    const { service } = await context(t);
    t.mock.method(Stack.prototype, "save", async () => undefined);
    let deploys = 0;
    t.mock.method(Stack.prototype, "deploy", async () => {
        deploys++;
        return 0;
    });
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    await assert.rejects(service.execute("stack_deploy", { ...args,
        ...gate(plan) }, identity), errorCode("PERSISTENCE_FAILED"));
    assert.equal(deploys, 0);
});

test("the Stack save callback rechecks revision after asynchronous filesystem checks", async (t) => {
    const { service, dir } = await context(t);
    const originalSave = Stack.prototype.save;
    const webCompose = newCompose.replace("new-secret-image", "late-web-secret-image");
    t.mock.method(Stack.prototype, "save", async function (this: Stack, isAdd: boolean, beforeWrite?: () => void) {
        await fs.writeFile(path.join(dir, "test", "compose.yaml"), webCompose);
        return originalSave.call(this, isAdd, beforeWrite);
    });
    const args = { name: "test",
        composeYAML: newCompose };
    const plan = await service.execute("stack_plan", args, identity);
    await assert.rejects(service.execute("stack_save", { ...args,
        ...gate(plan) }, identity), errorCode("REVISION_CONFLICT"));
    assert.equal(await fs.readFile(path.join(dir, "test", "compose.yaml"), "utf8"), webCompose);
});

test("start and restart need write without destructive scope or confirmation", async (t) => {
    const { service } = await context(t);
    t.mock.method(Stack.prototype, "start", async () => 0);
    t.mock.method(Stack.prototype, "restartService", async () => 0);
    const stack = await service.execute("stack_get", { name: "test" }, identity);
    const args = { name: "test",
        expectedRevision: stack.revision };
    const writer = { userId: 1,
        scopes: [ "read", "write" ] };
    assert.equal((await service.execute("stack_action", { ...args,
        action: "start" }, writer)).applied, true);
    assert.equal((await service.execute("service_action", { ...args,
        action: "restart",
        service: "web.api" }, writer)).applied, true);
});

test("strict service status detects nonzero Docker exit and malformed output", async (t) => {
    const { service } = await context(t);
    t.mock.restoreAll();
    const processMock = t.mock.method(childProcessAsync, "spawn", (() => Promise.resolve({ code: 7,
        stdout: "DOCKER_SECRET" })) as never);
    await assert.rejects(service.execute("service_status", { name: "test" }, identity), errorCode("OPERATION_FAILED"));
    const options = (processMock.mock.calls[0].arguments as unknown as [string, string[], { timeout: number; maxBuffer: number }])[2];
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    t.mock.method(childProcessAsync, "spawn", (() => Promise.resolve({ code: 0,
        stdout: "{\"Service\":\"web.api\",\"State\":\"running\",\"Name\":\"web-1\",\"Health\":\"healthy\",\"Env\":\"hidden\"}\n" })) as never);
    assert.deepEqual((await service.execute("service_status", { name: "test" }, identity)).services, [{ service: "web.api",
        containers: [{ name: "web-1",
            status: "healthy" }] }]);
    t.mock.method(childProcessAsync, "spawn", (() => Promise.resolve({ code: 0,
        stdout: "DOCKER_SECRET" })) as never);
    await assert.rejects(service.execute("service_status", { name: "test" }, identity), errorCode("OPERATION_FAILED"));
});

test("runtime actions check revision, service existence, destructive gate and nonzero exit", async (t) => {
    const { service } = await context(t);
    const stack = await service.execute("stack_get", { name: "test" }, identity);
    const args = { name: "test",
        expectedRevision: stack.revision,
        service: "web.api",
        action: "stop" };
    let calls = 0;
    t.mock.method(Stack.prototype, "stopService", async (socket: DockgeSocket) => {
        calls++;
        assert.equal(socket.connected, false);
        assert.equal(socket.endpoint, "");
        assert.equal(socket.emitAgent("terminalWrite", "secret"), undefined);
        return 2;
    });
    await assert.rejects(service.execute("service_action", args, identity), errorCode("CONFIRMATION_REQUIRED"));
    await assert.rejects(service.execute("service_action", { ...args,
        confirm: true }, { userId: 1,
        scopes: [ "read", "write" ] }), errorCode("FORBIDDEN"));
    await assert.rejects(service.execute("service_action", { ...args,
        confirm: true,
        service: "--bad" }, identity), errorCode("INVALID_ARGUMENT"));
    const result = await service.execute("service_action", { ...args,
        confirm: true }, identity);
    assert.equal(result.applied, false);
    assert.equal(calls, 1);
});

test("verification requires every configured service and rejects unhealthy or empty status", async (t) => {
    const { service } = await context(t);
    const args = { name: "test",
        timeoutSeconds: 0 };
    assert.equal((await service.execute("stack_verify", args, identity)).ok, true);
    t.mock.method(Stack.prototype, "getServiceStatusList", async () => new Map([[ "web.api", [{ name: "x",
        status: "unhealthy" }]]]));
    assert.equal((await service.execute("stack_verify", args, identity)).ok, false);
    t.mock.method(Stack.prototype, "getServiceStatusList", async () => new Map());
    assert.equal((await service.execute("stack_verify", args, identity)).ok, false);
    assert.equal((await service.execute("stack_verify", { ...args,
        requireServices: false }, identity)).ok, true);
    await assert.rejects(service.execute("stack_verify", { ...args,
        healthUrl: "https://user:secret@example.com" }, identity), errorCode("INVALID_ARGUMENT"));
    await assert.rejects(service.execute("stack_verify", { ...args,
        pollSeconds: 0 }, identity), errorCode("INVALID_ARGUMENT"));
    await assert.rejects(service.execute("stack_verify", { ...args,
        timeoutSeconds: 121 }, identity), errorCode("INVALID_ARGUMENT"));
});

test("deploy timeout executes once, reports unknown outcome and blocks further mutations while pending", async (t) => {
    const { service } = await context(t);
    Object.assign(service, { mutationTimeoutMs: 10 });
    let finish: (code: number) => void = () => undefined;
    let calls = 0;
    const completion = new Promise<number>((resolve) => {
        finish = resolve;
    });
    t.mock.method(Stack.prototype, "deploy", async () => {
        calls++;
        return completion;
    });
    const args = { name: "test",
        composeYAML: newCompose,
        mode: "deploy",
        timeoutSeconds: 0 };
    const plan = await service.execute("stack_plan", args, identity);
    const result = await service.execute("stack_apply", { ...args,
        ...gate(plan) }, identity);
    assert.equal(result.applied, false);
    assert.equal(result.outcomeUnknown, true);
    assert.equal((result.apply_error as { code: string }).code, "OUTCOME_UNKNOWN");
    assert.equal(calls, 1);
    await assert.rejects(service.execute("stack_apply", { ...args,
        ...gate(plan) }, identity), errorCode("OPERATION_PENDING"));
    assert.equal(calls, 1);
    assert.equal((await service.execute("stack_verify", { name: "test",
        timeoutSeconds: 0 }, identity)).ok, true);
    finish(0);
});

test("log requests remain bounded and literal; errors never expose arbitrary secret text", async (t) => {
    const { service } = await context(t);
    const logMock = t.mock.method(Stack.prototype, "boundedLogs", async () => "first\n[a.*] literal\nother\n");
    const logs = await service.execute("stack_logs", { name: "test",
        grep: "a.*",
        offset: 1 }, identity);
    assert.deepEqual(logs.lines, [ "[a.*] literal" ]);
    assert.equal(logMock.mock.calls[0].arguments[0], 200);
    await assert.rejects(service.execute("stack_logs", { name: "test",
        tail: 1001 }, identity), errorCode("INVALID_ARGUMENT"));
    t.mock.method(Stack.prototype, "boundedLogs", async () => {
        throw "ENV=hidden-secret";
    });
    await assert.rejects(service.execute("stack_logs", { name: "test" }, identity), (error: unknown) => {
        assert.equal(String(error).includes("hidden-secret"), false);
        return error instanceof McpError && error.code === "OPERATION_FAILED";
    });
});

test("log collection window gathers newly arrived output and enforces its bound", async (t) => {
    const { service } = await context(t);
    let arrived = false;
    t.mock.method(Stack.prototype, "boundedLogs", async () => arrived ? "new output\n" : "");
    const timer = setTimeout(() => {
        arrived = true;
    }, 1);
    t.after(() => clearTimeout(timer));
    const result = await service.execute("stack_logs", { name: "test",
        waitSeconds: 0.01 }, identity);
    assert.deepEqual(result.lines, [ "new output" ]);
    for (const waitSeconds of [ -1, 11, Number.NaN ]) {
        await assert.rejects(service.execute("stack_logs", { name: "test",
            waitSeconds }, identity), errorCode("INVALID_ARGUMENT"));
    }
});
