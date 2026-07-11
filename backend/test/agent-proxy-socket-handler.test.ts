import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentManagerError } from "../agent-manager";
import { AgentProxySocketHandler } from "../socket-handlers/agent-proxy-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import { DockgeSocket } from "../util-server";
import { DockgeServer } from "../dockge-server";

type EventCallback = (...args : unknown[]) => unknown;

function proxySocket(error : Error) {
    let listener : EventCallback | undefined;
    const socket = {
        userID: 1,
        endpoint: "",
        on: (event : string, callback : EventCallback) => {
            if (event === "agent") {
                listener = callback;
            }
        },
        instanceManager: {
            emitToEndpoint: async () => {
                throw error;
            },
        },
    } as unknown as DockgeSocket;

    new AgentProxySocketHandler().create2(socket, {} as DockgeServer, new AgentSocket());
    return () => listener;
}

test("proxy readiness failures are returned through the original ACK", async () => {
    const getListener = proxySocket(new AgentManagerError("AGENT_NOT_READY", "agent is offline"));
    let response : unknown;

    await getListener()?.("arch.example:5001", "getStack", (value : unknown) => {
        response = value;
    });

    assert.deepEqual(response, {
        ok: false,
        code: "AGENT_NOT_READY",
        msg: "agent is offline",
    });
});

test("unexpected proxy failures use AGENT_PROXY_ERROR", async () => {
    const getListener = proxySocket(new Error("unexpected failure"));
    let response : unknown;

    await getListener()?.("arch.example:5001", "getStack", (value : unknown) => {
        response = value;
    });

    assert.deepEqual(response, {
        ok: false,
        code: "AGENT_PROXY_ERROR",
        msg: "unexpected failure",
    });
});
