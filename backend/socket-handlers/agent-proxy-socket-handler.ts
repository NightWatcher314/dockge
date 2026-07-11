import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { checkLogin, DockgeSocket } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { ALL_ENDPOINTS } from "../../common/util-common";
import { AgentManagerError } from "../agent-manager";

type AgentProxyErrorCode = "AGENT_NOT_FOUND" | "AGENT_NOT_READY" | "AGENT_AUTH_FAILED" | "AGENT_PROXY_ERROR";

function acknowledgeProxyError(args : unknown[], code : AgentProxyErrorCode, msg : string) {
    const callback = args.at(-1);
    if (typeof callback === "function") {
        callback({
            ok: false,
            code,
            msg,
        });
    }
}

export class AgentProxySocketHandler extends SocketHandler {

    create2(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Agent - proxying requests if needed
        socket.on("agent", async (endpoint : unknown, eventName : unknown, ...args : unknown[]) => {
            try {
                checkLogin(socket);

                // Check Type
                if (typeof(endpoint) !== "string") {
                    throw new Error("Endpoint must be a string: " + endpoint);
                }
                if (typeof(eventName) !== "string") {
                    throw new Error("Event name must be a string");
                }

                if (endpoint === ALL_ENDPOINTS) {      // Send to all endpoints
                    log.debug("agent", "Sending to all endpoints: " + eventName);
                    socket.instanceManager.emitToAllEndpoints(eventName, ...args);

                } else if (!endpoint || endpoint === socket.endpoint) {      // Direct connection or matching endpoint
                    log.debug("agent", "Matched endpoint: " + eventName);
                    agentSocket.call(eventName, ...args);

                } else {
                    log.debug("agent", "Proxying request to " + endpoint + " for " + eventName);
                    await socket.instanceManager.emitToEndpoint(endpoint, eventName, ...args);
                }
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("agent", e.message);
                    const code = e instanceof AgentManagerError ? e.code : "AGENT_PROXY_ERROR";
                    acknowledgeProxyError(args, code, e.message);
                } else {
                    acknowledgeProxyError(args, "AGENT_PROXY_ERROR", "Unknown agent proxy error");
                }
            }
        });
    }

    create(socket : DockgeSocket, server : DockgeServer) {
        throw new Error("Method not implemented. Please use create2 instead.");
    }
}
