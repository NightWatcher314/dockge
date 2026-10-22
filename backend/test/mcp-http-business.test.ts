import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { createServer } from "node:http";
import knex from "knex";
// @ts-ignore Knex's dialect adapter supports the project's SQLite driver.
import Dialect from "knex/lib/dialects/sqlite3/index.js";
import sqlite from "@louislam/sqlite3";
import { R } from "redbean-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { up } from "../migrations/2026-10-23-0000-mcp-api-key-table";
import { createMcpApiKey, revokeMcpApiKey } from "../mcp-api-keys";
import { McpService } from "../mcp-service";
import { createMcpRouter } from "../mcp-router";
import { safeMcpError } from "../mcp-gateway";
import { Stack } from "../stack";
import type { DockgeServer } from "../dockge-server";

test("official HTTP client exercises real scoped keys, plan/save/readback/env preservation and revocation", async (t) => {
    Dialect.prototype._driver = () => sqlite;
    const db = knex({ client: Dialect,
        connection: { filename: ":memory:" },
        useNullAsDefault: true });
    // @ts-ignore redbean's typings omit Knex instance support.
    R.setup(db);
    await db.schema.createTable("user", (table) => {
        table.increments("id");
        table.boolean("active").notNullable().defaultTo(true);
    });
    await up(db);
    await db("user").insert({ id: 1 });
    t.after(() => db.destroy());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-mcp-http-"));
    t.after(() => fs.rm(root, { recursive: true,
        force: true }));
    await fs.mkdir(path.join(root, "app"));
    await fs.writeFile(path.join(root, "app", "compose.yaml"), "services: {web: {image: old}}\n");
    await fs.writeFile(path.join(root, "app", ".env"), "TOKEN=private-fixture\n");
    t.mock.method(Stack.prototype, "getServiceStatusList", async () => new Map());
    const service = new McpService({ stacksDir: root,
        packageJSON: { version: "test" } } as DockgeServer);
    const app = express();
    app.use(createMcpRouter({ version: "test",
        execute: service.execute.bind(service),
        safeError: safeMcpError }));
    const http = createServer(app);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const clients: Client[] = [];
    t.after(async () => {
        await Promise.all(clients.map((client) => client.close()));
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    async function connect(scopes: string[]) {
        const key = await createMcpApiKey(1, { name: "fixture",
            scopes,
            expiresInDays: 1 });
        const client = new Client({ name: "real-business-test",
            version: "1" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: "Bearer " + key.token } } }));
        return { client,
            key };
    }
    const reader = await connect([ "read" ]);
    const writer = await connect([ "read", "write", "destructive", "secrets" ]);
    const desired = { name: "app",
        composeYAML: "services: {web: {image: new}}\n" };
    const plan = (await reader.client.callTool({ name: "stack_plan",
        arguments: desired })).structuredContent as Record<string, unknown>;
    assert.deepEqual(plan.changedPaths, [[ "services", "web", "image" ]]);
    assert.equal(plan.env_changed, false);
    const input = { ...desired,
        expectedRevision: plan.revision,
        allowedPaths: plan.changedPaths,
        confirm: true };
    assert.equal((await reader.client.callTool({ name: "stack_save",
        arguments: input })).isError, true);
    const saved = await writer.client.callTool({ name: "stack_save",
        arguments: input });
    assert.equal(saved.isError, undefined);
    assert.equal((saved.structuredContent as Record<string, unknown>).saved, true);
    assert.equal(await fs.readFile(path.join(root, "app", ".env"), "utf8"), "TOKEN=private-fixture\n");
    const status = await reader.client.callTool({ name: "stack_get",
        arguments: { name: "app" } });
    assert.doesNotMatch(JSON.stringify(status), /private-fixture|composeYAML|composeENV/);
    assert.equal((await reader.client.callTool({ name: "stack_get",
        arguments: { name: "app",
            includeSecrets: true } })).isError, true);
    assert.equal((await writer.client.callTool({ name: "stack_save",
        arguments: input })).isError, true);
    const nextPlan = (await writer.client.callTool({ name: "stack_plan",
        arguments: { ...desired,
            composeENV: "" } })).structuredContent as Record<string, unknown>;
    const clear = { ...desired,
        composeENV: "",
        expectedRevision: nextPlan.revision,
        allowedPaths: [],
        allowEnvChange: true,
        confirm: true };
    assert.equal((await writer.client.callTool({ name: "stack_save",
        arguments: clear })).isError, undefined);
    assert.equal(await fs.readFile(path.join(root, "app", ".env"), "utf8"), "");
    await revokeMcpApiKey(1, writer.key.key.id);
    await assert.rejects(() => writer.client.callTool({ name: "stack_get",
        arguments: { name: "app" } }), /401|Invalid or expired/);
});
