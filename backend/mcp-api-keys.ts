import { createHash, randomBytes } from "node:crypto";
import { R } from "redbean-node";

export const MCP_SCOPES = [ "read", "write", "destructive", "secrets" ] as const;
export type McpScope = typeof MCP_SCOPES[number];

export interface McpKeyIdentity {
    id : number;
    userId : number;
    scopes : string[];
}

export interface McpApiKey {
    id : number;
    name : string;
    scopes : string[];
    createdAt : number;
    expiresAt : number;
    revokedAt : number | null;
}

interface KeyRow {
    id : number;
    user_id : number;
    name : string;
    scopes : string;
    created_at : number;
    expires_at : number;
    revoked_at : number | null;
}

/** Return only public key metadata, never the stored hash. */
function keyMetadata(row : KeyRow) : McpApiKey {
    return {
        id: row.id,
        name: row.name,
        scopes: JSON.parse(row.scopes),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
    };
}

/** List keys belonging to one user without disclosing credentials. */
export async function listMcpApiKeys(userId : number) : Promise<McpApiKey[]> {
    const rows = await R.knex("mcp_api_key").where("user_id", userId)
        .select("id", "name", "scopes", "created_at", "expires_at", "revoked_at")
        .orderBy("id", "desc");
    return rows.map(keyMetadata);
}

/** Create a scoped key. The plaintext token is returned only by this call. */
export async function createMcpApiKey(userId : number, input : unknown) : Promise<{ key : McpApiKey; token : string }> {
    const data = input as { name? : unknown; scopes? : unknown; expiresInDays? : unknown } | null;
    if (!data || typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 100) {
        throw new Error("MCP key name must contain 1 to 100 characters.");
    }
    if (!Array.isArray(data.scopes) || data.scopes.some((scope) => !MCP_SCOPES.includes(scope))) {
        throw new Error("Invalid MCP key scopes.");
    }
    const scopes = data.scopes;
    if (typeof data.expiresInDays !== "number" || !Number.isInteger(data.expiresInDays) || data.expiresInDays < 1 || data.expiresInDays > 365) {
        throw new Error("MCP key expiry must be between 1 and 365 days.");
    }
    const user = await R.knex("user").where({
        id: userId,
        active: 1,
    }).first("id");
    if (!user) {
        throw new Error("User is inactive or deleted.");
    }
    const token = "dockge_mcp_" + randomBytes(32).toString("hex");
    const now = Date.now();
    const row = {
        user_id: userId,
        name: data.name.trim(),
        key_hash: createHash("sha256").update(token).digest("hex"),
        scopes: JSON.stringify(MCP_SCOPES.filter((scope) => scope === "read" || scopes.includes(scope))),
        created_at: now,
        expires_at: now + data.expiresInDays * 86400000,
        revoked_at: null,
    };
    const [ id ] = await R.knex("mcp_api_key").insert(row);
    return {
        key: keyMetadata({
            ...row,
            id,
        }),
        token,
    };
}

/** Revoke only a key owned by the current user. */
export async function revokeMcpApiKey(userId : number, id : unknown) : Promise<void> {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
        throw new Error("Invalid MCP key ID.");
    }
    const updated = await R.knex("mcp_api_key").where({
        id,
        user_id: userId,
    }).whereNull("revoked_at")
        .update({ revoked_at: Date.now() });
    if (!updated) {
        throw new Error("MCP key not found or already revoked.");
    }
}

/** Authenticate against current key and user state on every request. */
export async function authenticateMcpKey(token : string) : Promise<McpKeyIdentity | null> {
    if (!/^dockge_mcp_[a-f0-9]{64}$/.test(token)) {
        return null;
    }
    const row = await R.knex("mcp_api_key as key")
        .join("user", "user.id", "key.user_id")
        .where("key.key_hash", createHash("sha256").update(token).digest("hex"))
        .where("user.active", 1)
        .whereNull("key.revoked_at")
        .where("key.expires_at", ">", Date.now())
        .first("key.id", "key.user_id", "key.scopes");
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        userId: row.user_id,
        scopes: JSON.parse(row.scopes),
    };
}

/** Require an explicit scope; permissions do not imply other permissions. */
export function requireMcpScope(identity : McpKeyIdentity, scope : McpScope) : void {
    if (!identity.scopes.includes(scope)) {
        throw new Error(`MCP key requires the ${scope} scope.`);
    }
}
