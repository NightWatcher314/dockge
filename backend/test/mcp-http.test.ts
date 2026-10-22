import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, request, Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpRouter } from "../mcp-router";
import { mcpGuide } from "../mcp-guide";
import { mcpTools } from "../mcp-tools";

let server: Server;
let url: URL;
let revoked = false;
let executeCount = 0;
let authenticatedRequests = 0;
const clients: Client[] = [];

before(async () => {
    const app = express();
    app.use(createMcpRouter({
        version: "test",
        allowedHosts: [ "127.0.0.1", "example.test:80", "secure.test:443" ],
        authenticate: async (token) => {
            authenticatedRequests++;
            return token === "test-key" && !revoked ? { id: 1,
                userId: 7,
                scopes: [ "read" ] } : null;
        },
        execute: async (operation, args, identity) => {
            executeCount++;
            if (operation === "stack_save") {
                throw new Error("password=must-not-leak");
            }
            return { operation,
                args,
                userId: identity.userId };
        },
        safeError: () => ({ code: "FORBIDDEN",
            message: "Required scope: write" }),
    }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
});

after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect() {
    const client = new Client({ name: "dockge-integration-test",
        version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer test-key" } } }));
    return client;
}

test("native HTTP endpoint rejects missing/invalid credentials before executing any tool", async () => {
    const count = executeCount;
    for (const headers of [{}, { Authorization: "Bearer invalid" }] as Record<string, string>[]) {
        const response = await fetch(url, { method: "POST",
            headers });
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate") || "", /Bearer/);
    }
    assert.equal(executeCount, count);
});

test("official SDK initializes and lists typed tools plus shared guide resource over real HTTP", async () => {
    const client = await connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), Object.keys(mcpTools).sort());
    const save = tools.tools.find((tool) => tool.name === "stack_save");
    assert.ok(save?.inputSchema.required?.includes("expectedRevision"));
    assert.equal(save?.inputSchema.additionalProperties, false);
    const resources = await client.listResources();
    assert.equal(resources.resources[0].uri, "dockge://guide");
    const guide = await client.readResource({ uri: "dockge://guide" });
    assert.ok("text" in guide.contents[0]);
    assert.equal(guide.contents[0].text, mcpGuide);
    const result = await client.callTool({ name: "stack_get",
        arguments: { name: "app" } });
    assert.deepEqual(result.structuredContent, { operation: "stack_get",
        args: { endpoint: "",
            name: "app",
            includeSecrets: false },
        userId: 7 });
});

test("SDK rejects invalid parameters before business execution and returns safe scope errors", async () => {
    const client = await connect();
    for (const args of [{ name: "../../escape" }, { name: "app",
        tail: 1001 }, { name: "app",
        arbitrary: "value" }]) {
        const count = executeCount;
        const result = await client.callTool({ name: "stack_logs",
            arguments: args });
        assert.equal(result.isError, true);
        assert.equal(executeCount, count);
    }
    const result = await client.callTool({ name: "stack_save",
        arguments: { name: "app",
            composeYAML: "services: {}",
            expectedRevision: "revision",
            allowedPaths: [] } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: { code: "FORBIDDEN",
        message: "Required scope: write" } });
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test("every request reauthenticates; revoking a key invalidates an already initialized SDK client", async () => {
    const client = await connect();
    const count = authenticatedRequests;
    await client.listTools();
    await client.callTool({ name: "doctor",
        arguments: {} });
    assert.ok(authenticatedRequests >= count + 2);
    revoked = true;
    const executed = executeCount;
    try {
        await assert.rejects(() => client.callTool({ name: "doctor",
            arguments: {} }), /401|Unauthorized|Invalid or expired/);
        assert.equal(executeCount, executed);
    } finally {
        revoked = false;
    }
});

test("cross-origin browser requests and malformed secret-bearing JSON fail safely", async () => {
    const maliciousHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url, { method: "POST",
            headers: { Authorization: "Bearer test-key",
                Host: "attacker.invalid" } }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(maliciousHost, 403);
    const response = await fetch(url, { method: "POST",
        headers: { Authorization: "Bearer test-key",
            Origin: "https://attacker.invalid" } });
    assert.equal(response.status, 403);
    const malformed = await fetch(url, { method: "POST",
        headers: { Authorization: "Bearer test-key",
            "Content-Type": "application/json" },
        body: "{\"password\":\"must-not-leak\"" });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /must-not-leak/);
    const get = await fetch(url, { headers: { Authorization: "Bearer test-key" } });
    assert.equal(get.status, 405);
});

test("HTTP authority checks normalize default ports without admitting malformed or unapproved hosts", async () => {
    async function status(host: string, origin?: string) {
        return new Promise<number | undefined>((resolve, reject) => {
            const req = request(url, {
                method: "GET",
                headers: { Authorization: "Bearer test-key",
                    Host: host,
                    ...(origin ? { Origin: origin } : {}) },
            }, (response) => {
                response.resume();
                resolve(response.statusCode);
            });
            req.on("error", reject);
            req.end();
        });
    }
    // 405 confirms Host, Origin and authentication passed before the POST-only route.
    assert.equal(await status("example.test:80"), 405);
    assert.equal(await status("example.test:80", "http://example.test"), 405);
    assert.equal(await status("example.test", "http://example.test:80"), 405);
    assert.equal(await status("secure.test:443", "https://secure.test"), 405);
    assert.equal(await status("example.test:80", "https://example.test"), 403);
    for (const host of [ "attacker.invalid:80", "example.test:8080", "user@example.test:80", "example.test:80/path", "example.test:80?query", "example.test:80#fragment", "example.test:80\\path", "example.test:080" ]) {
        assert.equal(await status(host), 403, host);
    }
});
