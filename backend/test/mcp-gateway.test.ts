import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { McpGateway, safeMcpError } from "../mcp-gateway";
import { McpError, McpService } from "../mcp-service";
import { Agent } from "../models/agent";
import type { DockgeServer } from "../dockge-server";
import type { DockgeSocket } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { McpSocketHandler } from "../agent-socket-handlers/mcp-socket-handler";
import { AgentManager } from "../agent-manager";

const identity = { id: 1,
    userId: 7,
    scopes: [ "read" ] };

test("real agent transport selects only its target and binds execution to the remote login identity", async (t) => {
    const http = createServer();
    const io = new Server(http);
    const remoteServer = {} as DockgeServer;
    let connections = 0;
    io.on("connection", (socket) => {
        connections++;
        const localSocket = socket as DockgeSocket;
        const agent = new AgentSocket();
        new McpSocketHandler().create(localSocket, remoteServer, agent);
        socket.on("login", (_data, callback) => {
            localSocket.userID = 41;
            callback({ ok: true });
        });
        socket.on("agent", (_endpoint, operation, ...args) => agent.call(operation, ...args));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        await new Promise<void>((resolve) => io.close(() => resolve()));
    });
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `127.0.0.1:${address.port}`;
    t.mock.method(Agent, "getAgentList", async () => ({
        [endpoint]: { url: `http://${endpoint}`,
            username: "fixture",
            password: "secret",
            name: "Target" } as unknown as Agent,
        "offline.invalid": { url: "http://offline.invalid",
            username: "private",
            password: "credential",
            name: "Offline" } as unknown as Agent,
    }));
    const execute = t.mock.method(McpService.prototype, "execute", async function (this: McpService, operation: string, args: Record<string, unknown>, actualIdentity: { userId: number; scopes: string[] }) {
        assert.equal(operation, "doctor");
        assert.equal(args.endpoint, "");
        assert.deepEqual(actualIdentity, { userId: 41,
            scopes: [ "read" ] });
        return { version: "remote" };
    });
    const gateway = new McpGateway({} as DockgeServer);
    const agents = await gateway.execute("agent_list", {}, identity);
    assert.equal(connections, 0);
    assert.doesNotMatch(JSON.stringify(agents), /secret|credential|username|password/);
    assert.deepEqual(await gateway.execute("doctor", { endpoint }, identity), { version: "remote",
        endpoint });
    assert.equal(connections, 1);
    assert.equal(execute.mock.callCount(), 1);
});

test("unknown remote endpoints never execute locally; multi-endpoint errors remain independent and secret-safe", async (t) => {
    t.mock.method(Agent, "getAgentList", async () => ({ "offline.invalid": { name: "Offline" } as unknown as Agent }));
    const targets: string[] = [];
    t.mock.method(AgentManager.prototype, "ensureEndpointReady", async (endpoint: string) => {
        targets.push(endpoint);
        throw new Error("password=private-underlying-error");
    });
    const execute = t.mock.method(McpService.prototype, "execute", async () => ({ stacks: [{ name: "local" }] }));
    const gateway = new McpGateway({} as DockgeServer);
    await assert.rejects(gateway.execute("stack_list", { endpoint: "missing" }, identity), (error: unknown) => {
        const safe = safeMcpError(error);
        assert.equal(safe.code, "AGENT_TIMEOUT");
        assert.doesNotMatch(safe.message, /private-underlying/);
        return true;
    });
    assert.equal(execute.mock.callCount(), 0);
    const result = await gateway.execute("stack_list", { allEndpoints: true }, identity);
    const endpoints = result.endpoints as Record<string, Record<string, unknown>>;
    assert.deepEqual(endpoints[""], { stacks: [{ name: "local" }] });
    assert.ok(endpoints["offline.invalid"].error);
    assert.doesNotMatch(JSON.stringify(result), /private-underlying/);
    assert.deepEqual(targets, [ "missing", "offline.invalid" ]);
    assert.equal(execute.mock.callCount(), 1);
});

test("authenticated agent service checks scopes and schema independently", async (t) => {
    const agent = new AgentSocket();
    const socket = { userID: 41 } as DockgeSocket;
    new McpSocketHandler().create(socket, {} as DockgeServer, agent);
    const invoke = (operation: string, args: unknown, scopes: string[]) => new Promise<Record<string, unknown>>((resolve) => agent.call("mcpOperation", operation, args, scopes, resolve));
    t.mock.method(McpService.prototype, "execute", async () => {
        throw new McpError("FORBIDDEN", "Required MCP scope is missing");
    });
    const denied = await invoke("stack_save", { name: "app",
        composeYAML: "services: {}",
        expectedRevision: "revision",
        allowedPaths: [] }, [ "read" ]);
    assert.equal(denied.ok, false);
    const invalid = await invoke("stack_logs", { name: "app",
        tail: 1001 }, [ "read", "secrets" ]);
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(JSON.stringify(invalid), /1001|ZodError/);
    socket.userID = 0;
    assert.equal((await invoke("doctor", {}, [ "read" ])).ok, false);
});
