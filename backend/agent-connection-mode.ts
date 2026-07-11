export type DockgeClientType = "browser" | "cli" | "agent";

export function getDockgeClientType(endpoint : string, handshakeAuth : unknown) : DockgeClientType {
    if (endpoint) {
        return "agent";
    }

    if (
        typeof handshakeAuth === "object" &&
        handshakeAuth !== null &&
        "clientType" in handshakeAuth &&
        handshakeAuth.clientType === "dockgectl"
    ) {
        return "cli";
    }

    return "browser";
}

export function shouldEagerConnectAgents(clientType : DockgeClientType) {
    return clientType !== "cli";
}

export function getAgentConnectionMode(clientType : DockgeClientType) : "lazy" | undefined {
    return clientType === "cli" ? "lazy" : undefined;
}
