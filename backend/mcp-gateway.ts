import { randomUUID } from "node:crypto";
import { AgentManager, AgentManagerError } from "./agent-manager";
import { Agent } from "./models/agent";
import type { DockgeServer } from "./dockge-server";
import type { DockgeSocket } from "./util-server";
import type { McpKeyIdentity } from "./mcp-api-keys";
import { McpService, McpError } from "./mcp-service";
import { mcpGuide } from "./mcp-guide";

/** Lazy per-call routing through the existing agent manager, never localhost fallback. */
export class McpGateway {
    private service: McpService;

    constructor(private server: DockgeServer) {
        this.service = new McpService(server);
    }

    async execute(operation: string, args: Record<string, unknown>, identity: McpKeyIdentity): Promise<Record<string, unknown>> {
        if (!identity.scopes.includes("read")) {
            throw new McpError("FORBIDDEN", "Required scope: read");
        }
        if (operation === "get_guide") {
            return { guide: mcpGuide };
        }
        if (operation === "whoami") {
            return { keyId: identity.id,
                userId: identity.userId,
                scopes: identity.scopes,
                transport: "streamable-http",
                endpoint: "" };
        }
        if (operation === "agent_list") {
            return { agents: await this.agents() };
        }
        if (args.allEndpoints && [ "stack_list", "service_status" ].includes(operation)) {
            const nodes = await this.agents();
            const results = await Promise.all(nodes.map(async (node) => {
                try {
                    return [ node.endpoint, await this.target(operation, { ...args,
                        allEndpoints: false,
                        endpoint: node.endpoint }, identity) ];
                } catch (error) {
                    return [ node.endpoint, { error: safeMcpError(error) }];
                }
            }));
            return { endpoints: Object.fromEntries(results) };
        }
        return this.target(operation, args, identity);
    }

    private async agents() {
        const agents = await Agent.getAgentList();
        return [{ endpoint: "",
            name: "Local" }, ...Object.entries(agents).map(([ endpoint, agent ]) => ({ endpoint,
            name: agent.name || "" })) ];
    }

    private async target(operation: string, args: Record<string, unknown>, identity: McpKeyIdentity): Promise<Record<string, unknown>> {
        const endpoint = String(args.endpoint || "");
        if (!endpoint) {
            return this.service.execute(operation, args, identity);
        }
        const socket = { id: "mcp-" + randomUUID(),
            endpoint: "",
            userID: identity.userId,
            emit: () => undefined } as unknown as DockgeSocket;
        const manager = new AgentManager(socket);
        try {
            const client = await manager.ensureEndpointReady(endpoint);
            const response = await client.timeout(180000).emitWithAck("agent", endpoint, "mcpOperation", operation, { ...args,
                endpoint: "" }, identity.scopes);
            if (!response || !response.ok) {
                throw new McpError(response?.error?.code || "AGENT_OPERATION_FAILED", response?.error?.message || "Agent operation failed; check that the selected node supports native MCP.");
            }
            return { ...response.result,
                endpoint };
        } catch (error) {
            if (error instanceof McpError || error instanceof AgentManagerError) {
                throw error;
            }
            throw new McpError("AGENT_TIMEOUT", "Agent response unavailable; mutation outcome may be unknown. Query this endpoint before another mutation.");
        } finally {
            manager.disconnectAll();
        }
    }
}

/** Only explicitly safe application errors cross HTTP/agent trust boundaries. */
export function safeMcpError(error: unknown): { code: string; message: string } {
    if (error instanceof McpError) {
        return { code: error.code,
            message: error.message };
    }
    if (error instanceof AgentManagerError) {
        return { code: error.code,
            message: "Selected agent is not available; no fallback was attempted." };
    }
    return { code: "OPERATION_FAILED",
        message: "Operation failed. Inspect server state before retrying a mutation." };
}
