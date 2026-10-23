import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcessAsync from "promisify-child-process";
import type { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { McpService } from "../mcp-service";
import { Terminal } from "../terminal";
import type { DockgeSocket } from "../util-server";
import { COMPLETED, PARTIAL, RUNNING, UNKNOWN } from "../../common/util-common";

const compose = `services:
  web:
    image: web
    depends_on:
      migrate:
        condition: service_completed_successfully
  migrate:
    image: web
  optional:
    image: web
    profiles: [setup]
  disabled:
    image: web
    deploy:
      replicas: 0
`;
const identity = { userId: 1,
    scopes: [ "read" ] };

test("list, refresh, metadata, service status and MCP verify share task-aware semantics", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-status-"));
    t.after(() => fs.rm(dir, { recursive: true,
        force: true }));
    await fs.mkdir(path.join(dir, "erpnext"));
    await fs.writeFile(path.join(dir, "erpnext", "compose.yaml"), compose);
    const server = { stacksDir: dir } as DockgeServer;
    const service = new McpService(server);
    let items = [
        { project: "erpnext",
            service: "web",
            name: "web-1",
            state: "running",
            health: "healthy",
            oneoff: "False",
            task: "",
            exitCode: 0,
            oom: false,
            error: false },
        { project: "erpnext",
            service: "migrate",
            name: "migrate-1",
            state: "exited",
            health: "",
            oneoff: "False",
            task: "",
            exitCode: 0,
            oom: false,
            error: false },
    ];
    let failInspect = false;
    let failDiscovery = false;
    const calls: string[][] = [];
    t.mock.method(childProcessAsync, "spawn", (async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "compose") {
            return { code: failDiscovery ? 1 : 0,
                stdout: JSON.stringify([{ Name: "erpnext",
                    Status: "exited(1), running(1)",
                    ConfigFiles: "compose.yaml" }]) };
        }
        if (args[0] === "ps") {
            return { code: 0,
                stdout: items.map((_, index) => (index + 1).toString(16)).join("\n") };
        }
        return { code: failInspect ? 1 : 0,
            stdout: items.map((item) => JSON.stringify(item)).join("\n") };
    }) as never);
    const listed = (await Stack.getStackList(server)).get("erpnext")!;
    assert.equal(listed.status, RUNNING);
    assert.equal(listed.hasActiveContainers, true);
    assert.equal((await Stack.getStatusList(server)).get("erpnext"), RUNNING);
    const fresh = await Stack.getStack(server, "erpnext");
    await fresh.updateStatus();
    assert.equal(fresh.status, RUNNING);
    const metadata = await service.execute("stack_get", { name: "erpnext" }, identity);
    assert.equal(metadata.status, RUNNING);
    assert.equal(metadata.hasActiveContainers, true);
    const statuses = await fresh.getServiceStatusList(true);
    assert.deepEqual(statuses.get("migrate"), [{ name: "migrate-1",
        status: "completed" }]);
    const verify = () => service.execute("stack_verify", { name: "erpnext",
        timeoutSeconds: 0 }, identity);
    assert.equal((await verify()).ok, true);
    items[1].state = "running";
    assert.equal((await verify()).ok, false);
    items[1].state = "exited";
    items[0].health = "starting";
    assert.equal((await verify()).ok, false);
    items[0].health = "";
    items[0].state = "exited";
    assert.equal((await verify()).ok, false);
    items[0].state = "running";
    items = items.slice(1);
    assert.equal((await Stack.getStackList(server, true)).get("erpnext")?.status, PARTIAL);
    assert.equal((await verify()).ok, false);
    // Local edits are visible despite the managed stack cache.
    await fs.writeFile(path.join(dir, "erpnext", "compose.yaml"), "services:\n  migrate:\n    image: web\n    labels:\n      dockge.task: 'true'\n");
    assert.equal((await Stack.getStackList(server, true)).get("erpnext")?.status, COMPLETED);
    assert.equal((await verify()).ok, true);
    failInspect = true;
    assert.equal((await Stack.getStackList(server, true)).get("erpnext")?.status, UNKNOWN);
    assert.equal(listed.hasActiveContainers, undefined);
    await fresh.updateStatus();
    assert.equal(fresh.status, UNKNOWN);
    assert.equal((await verify()).ok, false);
    failInspect = false;
    failDiscovery = true;
    assert.equal((await Stack.getStackList(server, true)).get("erpnext")?.status, UNKNOWN);
    assert.equal(calls.some((args) => args.includes("config")), false);
});

test("update restarts stacks with active abnormal containers but preserves stopped stacks", async (t) => {
    const stack = new Stack({ stacksDir: "/tmp" } as DockgeServer, "test", "services: {}", "", true);
    let active = true;
    t.mock.method(stack, "updateStatus", async () => {
        stack.hasActiveContainers = active;
    });
    const commands: string[][] = [];
    t.mock.method(Terminal, "exec", async (...args: unknown[]) => {
        commands.push(args[4] as string[]);
        return 0;
    });
    const socket = { endpoint: "" } as DockgeSocket;
    await stack.update(socket);
    assert.deepEqual(commands.map((args) => args[1]), [ "pull", "up" ]);
    active = false;
    commands.length = 0;
    await stack.update(socket);
    assert.deepEqual(commands.map((args) => args[1]), [ "pull" ]);
});
