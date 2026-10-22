import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import { checkLogin, DockgeSocket } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { McpService } from "../mcp-service";
import { safeMcpError } from "../mcp-gateway";
import { parseMcpInput } from "../mcp-tools";

/** Authenticated same-process service entry for existing multi-agent connections. */
export class McpSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket) {
        const service = new McpService(server);
        agentSocket.on("mcpOperation", async (operation, args, scopes, callback) => {
            if (typeof callback !== "function") {
                return;
            }
            try {
                checkLogin(socket);
                if (typeof operation !== "string" || !Array.isArray(scopes) || scopes.some((scope) => ![ "read", "write", "destructive", "secrets" ].includes(scope))) {
                    throw new Error("Invalid operation");
                }
                const input = parseMcpInput(operation, args);
                if (input.endpoint || input.allEndpoints) {
                    throw new Error("Recursive forwarding is not supported");
                }
                callback({ ok: true,
                    result: await service.execute(operation, input, { userId: socket.userID,
                        scopes }) });
            } catch (error) {
                callback({ ok: false,
                    error: safeMcpError(error) });
            }
        });
    }
}
