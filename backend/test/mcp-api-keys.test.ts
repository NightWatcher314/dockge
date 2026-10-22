import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import knex from "knex";
// @ts-ignore
import Dialect from "knex/lib/dialects/sqlite3/index.js";
import sqlite from "@louislam/sqlite3";
import { R } from "redbean-node";
import { up } from "../migrations/2026-10-23-0000-mcp-api-key-table";
import { authenticateMcpKey, createMcpApiKey, listMcpApiKeys, requireMcpScope, revokeMcpApiKey } from "../mcp-api-keys";
import { MainSocketHandler } from "../socket-handlers/main-socket-handler";
import { Settings } from "../settings";

Dialect.prototype._driver = () => sqlite;
const db = knex({
    client: Dialect,
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
});

before(async () => {
    // @ts-ignore redbean's public typings do not include Knex instances.
    R.setup(db);
    await db.raw("PRAGMA foreign_keys = ON");
    await db.schema.createTable("user", (table) => {
        table.increments("id");
        table.boolean("active").notNullable().defaultTo(true);
    });
    await up(db);
});

beforeEach(async () => {
    await db("mcp_api_key").delete();
    await db("user").delete();
    await db("user").insert([{ id: 1 }, { id: 2 }]);
});

after(async () => {
    await db.destroy();
});

test("keys use independent 256-bit tokens and persist only hashes; lists omit credentials", async () => {
    const first = await createMcpApiKey(1, { name: " client ",
        scopes: [ "write", "write" ],
        expiresInDays: 30 });
    const second = await createMcpApiKey(1, { name: "second",
        scopes: [],
        expiresInDays: 7 });
    assert.match(first.token, /^dockge_mcp_[a-f0-9]{64}$/);
    assert.notEqual(first.token, second.token);
    assert.deepEqual(first.key.scopes, [ "read", "write" ]);
    assert.equal(first.key.name, "client");
    const stored = await db("mcp_api_key").where("id", first.key.id).first();
    assert.equal(stored.key_hash, createHash("sha256").update(first.token).digest("hex"));
    assert.equal(JSON.stringify(stored).includes(first.token), false);
    const listed = await listMcpApiKeys(1);
    assert.equal(listed.length, 2);
    assert.equal("key_hash" in listed[0], false);
    assert.equal("token" in listed[0], false);
    assert.deepEqual(await listMcpApiKeys(2), []);
    assert.deepEqual(await authenticateMcpKey(first.token), { id: first.key.id,
        userId: 1,
        scopes: [ "read", "write" ] });
    assert.equal(await authenticateMcpKey(first.token.slice(0, -1)), null);
    assert.equal(await authenticateMcpKey("dockge_mcp_" + "0".repeat(64)), null);
});

test("revocation is immediate and cannot target another user's key", async () => {
    const { key, token } = await createMcpApiKey(1, { name: "client",
        scopes: [],
        expiresInDays: 30 });
    await assert.rejects(revokeMcpApiKey(2, key.id), /not found/);
    assert.notEqual(await authenticateMcpKey(token), null);
    await revokeMcpApiKey(1, key.id);
    assert.equal(await authenticateMcpKey(token), null);
    assert.equal(typeof (await listMcpApiKeys(1))[0].revokedAt, "number");
});

test("expiry and current user activity are checked for every authentication", async () => {
    const { key, token } = await createMcpApiKey(1, { name: "client",
        scopes: [],
        expiresInDays: 1 });
    await db("mcp_api_key").where("id", key.id).update({ expires_at: Date.now() });
    assert.equal(await authenticateMcpKey(token), null);
    await db("mcp_api_key").where("id", key.id).update({ expires_at: Date.now() + 60000 });
    assert.notEqual(await authenticateMcpKey(token), null);
    await db("user").where("id", 1).update({ active: 0 });
    assert.equal(await authenticateMcpKey(token), null);
    await assert.rejects(createMcpApiKey(1, { name: "client",
        scopes: [],
        expiresInDays: 1 }), /inactive/);
    await db("user").where("id", 1).update({ active: 1 });
    assert.notEqual(await authenticateMcpKey(token), null);
    await db("user").where("id", 1).delete();
    assert.equal(await authenticateMcpKey(token), null);
    assert.deepEqual(await listMcpApiKeys(1), []);
});

test("creation rejects invalid names, scope escalation and unbounded expiry", async () => {
    for (const data of [
        null,
        { name: " ",
            scopes: [],
            expiresInDays: 30 },
        { name: "a".repeat(101),
            scopes: [],
            expiresInDays: 30 },
        { name: "client",
            scopes: [ "admin" ],
            expiresInDays: 30 },
        { name: "client",
            scopes: "write",
            expiresInDays: 30 },
        { name: "client",
            scopes: [],
            expiresInDays: 0 },
        { name: "client",
            scopes: [],
            expiresInDays: 366 },
        { name: "client",
            scopes: [],
            expiresInDays: 1.5 },
    ]) {
        await assert.rejects(createMcpApiKey(1, data));
    }
    assert.deepEqual(await listMcpApiKeys(1), []);
});

test("scopes require explicit grants and do not imply destructive or secret access", () => {
    const identity = { id: 1,
        userId: 1,
        scopes: [ "read", "write" ] };
    requireMcpScope(identity, "read");
    requireMcpScope(identity, "write");
    assert.throws(() => requireMcpScope(identity, "destructive"), /destructive/);
    assert.throws(() => requireMcpScope(identity, "secrets"), /secrets/);
});

test("socket management rejects anonymous/auto-login sessions and disabled authentication", async (context) => {
    const handlers = new Map<string, (...args : unknown[]) => unknown>();
    let leftRoom = "";
    let disconnectedAgents = false;
    const socket = {
        userID: 1,
        data: { mcpKeyManagementSession: false },
        on: (event : string, handler : (...args : unknown[]) => unknown) => handlers.set(event, handler),
        leave: (room : string) => {
            leftRoom = room;
        },
        instanceManager: {
            disconnectAll: () => {
                disconnectedAgents = true;
            },
        },
    };
    new MainSocketHandler().create(socket as never, {} as never);
    let disabledAuth = false;
    context.mock.method(Settings, "get", async () => disabledAuth);
    const request = async () => {
        let response : { ok : boolean; msg? : string; keys? : unknown[] } | undefined;
        await handlers.get("listMcpApiKeys")?.((res : typeof response) => {
            response = res;
        });
        return response;
    };
    assert.equal((await request())?.ok, false);
    socket.data.mcpKeyManagementSession = true;
    assert.equal((await request())?.ok, true);
    disabledAuth = true;
    assert.equal((await request())?.ok, false);
    disabledAuth = false;
    await db("user").where("id", 1).update({ active: 0 });
    assert.equal((await request())?.ok, false);
    socket.userID = 0;
    assert.equal((await request())?.ok, false);
    socket.userID = 1;
    await handlers.get("logout")?.(() => {});
    assert.equal(socket.data.mcpKeyManagementSession, false);
    assert.equal(socket.userID, 0);
    assert.equal(leftRoom, "1");
    assert.equal(disconnectedAgents, true);
});
