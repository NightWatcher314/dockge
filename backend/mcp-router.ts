import express, { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticateMcpKey, McpKeyIdentity } from "./mcp-api-keys";
import { mcpTools, parseMcpInput } from "./mcp-tools";
import { mcpGuide } from "./mcp-guide";
import type { McpGateway } from "./mcp-gateway";

interface McpRouterOptions {
    version: string;
    authenticate?: typeof authenticateMcpKey;
    execute: McpGateway["execute"];
    safeError: (error: unknown) => { code: string; message: string };
    allowedHosts?: string[];
}

/** Stateless Streamable HTTP: each request revalidates the bearer key. */
export function createMcpRouter(options: McpRouterOptions): Router {
    const router = express.Router();
    const allowedHosts = new Set((options.allowedHosts || process.env.DOCKGE_MCP_ALLOWED_HOSTS?.split(",") || [ "localhost", "127.0.0.1", "[::1]" ]).map((host) => host.trim().toLowerCase()).filter(Boolean));
    router.use("/mcp", async (req, res, next) => {
        try {
            const host = req.headers.host || "";
            const parsed = new URL("http://" + host);
            // URL strips the HTTP default port; permit its explicit canonical
            // spelling without accepting userinfo, paths or other normalization.
            const canonicalHost = parsed.host === host.toLowerCase() || (!parsed.port && host.toLowerCase() === `${parsed.hostname}:80`);
            const authorities = [ parsed.host, parsed.hostname, `${parsed.hostname}:${parsed.port || "80"}` ];
            if (!canonicalHost || parsed.username || parsed.password || !authorities.some((value) => allowedHosts.has(value))) {
                throw new Error();
            }
        } catch {
            res.status(403).json({ error: "Host is not allowed" });
            return;
        }
        // Browsers must send a same-host Origin. Native remote clients omit Origin.
        if (req.headers.origin) {
            try {
                const origin = new URL(req.headers.origin);
                if (![ "http:", "https:" ].includes(origin.protocol) || origin.host !== new URL(`${origin.protocol}//${req.headers.host}`).host) {
                    res.status(403).json({ error: "Origin is not allowed" });
                    return;
                }
            } catch {
                res.status(403).json({ error: "Origin is not allowed" });
                return;
            }
        }
        const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || "");
        try {
            const identity = match && await (options.authenticate || authenticateMcpKey)(match[1]);
            if (!identity) {
                res.setHeader("WWW-Authenticate", "Bearer realm=\"Dockge MCP\"");
                res.status(401).json({ error: "Invalid or expired API key" });
                return;
            }
            res.locals.mcpIdentity = identity;
            next();
        } catch {
            res.status(503).json({ error: "Authentication unavailable" });
        }
    });
    router.post("/mcp", express.json({ limit: "3mb" }), async (req, res) => {
        const identity = res.locals.mcpIdentity as McpKeyIdentity;
        const server = new McpServer({ name: "dockge",
            version: options.version }, { instructions: mcpGuide });
        for (const [ name, definition ] of Object.entries(mcpTools)) {
            const readOnly = ![ "stack_save", "stack_deploy", "stack_apply", "stack_action", "service_action" ].includes(name);
            server.registerTool(name, {
                description: definition.description,
                inputSchema: definition.schema,
                outputSchema: z.object({}).catchall(z.unknown()),
                annotations: { readOnlyHint: readOnly,
                    destructiveHint: !readOnly,
                    idempotentHint: readOnly,
                    openWorldHint: [ "stack_verify", "stack_apply", "stack_deploy" ].includes(name) },
            }, async (input: unknown): Promise<CallToolResult> => {
                try {
                    const args = parseMcpInput(name, input);
                    const result = await options.execute(name, args, identity);
                    return { content: [{ type: "text",
                        text: JSON.stringify(result) }],
                    structuredContent: result };
                } catch (error) {
                    const result = { error: options.safeError(error) };
                    return { isError: true,
                        content: [{ type: "text",
                            text: JSON.stringify(result) }],
                        structuredContent: result };
                }
            });
        }
        server.registerResource("dockge-guide", "dockge://guide", { description: "Safe native MCP operating guide",
            mimeType: "text/markdown" }, async () => ({ contents: [{ uri: "dockge://guide",
            mimeType: "text/markdown",
            text: mcpGuide }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined,
            enableJsonResponse: true });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch {
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP request failed" });
            }
        }
    });
    router.all("/mcp", (_req, res) => {
        res.setHeader("Allow", "POST");
        res.status(405).json({ error: "Use stateless Streamable HTTP POST" });
    });
    // Never echo malformed JSON (which may contain secrets) via Express's default error page.
    router.use("/mcp", (error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid MCP request body" });
    });
    return router;
}
