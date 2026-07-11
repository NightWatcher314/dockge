import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentManager, AgentManagerError } from "../agent-manager";
import { DockgeSocket } from "../util-server";
import { Agent } from "../models/agent";

type EventCallback = (...args : unknown[]) => void;

class FakeAgentClient {
    connected = false;
    handlers = new Map<string, EventCallback[]>();
    emitted : {
        event : string;
        args : unknown[];
    }[] = [];

    constructor(protected loginResponse? : object) {}

    on(event : string, callback : EventCallback) {
        const handlers = this.handlers.get(event) || [];
        handlers.push(callback);
        this.handlers.set(event, handlers);
        return this;
    }

    emit(event : string, ...args : unknown[]) {
        this.emitted.push({
            event,
            args,
        });
        if (event === "login" && this.loginResponse) {
            const callback = args.at(-1);
            if (typeof callback === "function") {
                callback(this.loginResponse);
            }
        }
        return true;
    }

    trigger(event : string, ...args : unknown[]) {
        if (event === "connect") {
            this.connected = true;
        } else if (event === "disconnect") {
            this.connected = false;
        }

        for (const callback of this.handlers.get(event) || []) {
            callback(...args);
        }
    }

    disconnect() {
        this.trigger("disconnect");
        return this;
    }
}

function agent(url : string) : Agent {
    return {
        url,
        username: "agent-user",
        password: "agent-password",
    } as unknown as Agent;
}

function parentSocket() : DockgeSocket {
    return {
        endpoint: "",
        emit: () => true,
    } as unknown as DockgeSocket;
}

test("an immediate proxy request waits for only its target endpoint", async () => {
    let releaseAgentList : ((list : Record<string, Agent>) => void) | undefined;
    const agentList = new Promise<Record<string, Agent>>((resolve) => {
        releaseAgentList = resolve;
    });
    const clients = new Map<string, FakeAgentClient>();
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: () => agentList,
        agentSocketFactory: ((url : string) => {
            const client = new FakeAgentClient(url.includes("arch") ? { ok: true } : undefined);
            clients.set(new URL(url).host, client);
            if (url.includes("arch")) {
                setTimeout(() => client.trigger("connect"), 0);
            }
            return client;
        }) as never,
        readyTimeout: 100,
    });

    const backgroundConnect = manager.connectAll();
    const proxyRequest = manager.emitToEndpoint("arch.example:5001", "getStack", "test");
    releaseAgentList?.({
        "arch.example:5001": agent("http://arch.example:5001"),
        "us.example:5001": agent("http://us.example:5001"),
    });

    await Promise.all([ backgroundConnect, proxyRequest ]);
    assert.equal(clients.get("us.example:5001")?.connected, false);
    assert.equal(
        clients.get("arch.example:5001")?.emitted.some(({ event }) => event === "agent"),
        true
    );
});

test("a lazy proxy request connects only its target endpoint", async () => {
    const createdEndpoints : string[] = [];
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: async () => ({
            "arch.example:5001": agent("http://arch.example:5001"),
            "us.example:5001": agent("http://us.example:5001"),
        }),
        agentSocketFactory: ((url : string) => {
            const client = new FakeAgentClient({ ok: true });
            createdEndpoints.push(new URL(url).host);
            setTimeout(() => client.trigger("connect"), 0);
            return client;
        }) as never,
        readyTimeout: 100,
    });

    await manager.emitToEndpoint("arch.example:5001", "getStack", "test");

    assert.deepEqual(createdEndpoints, [ "arch.example:5001" ]);
});

test("connectAll preserves eager browser behavior", async () => {
    const createdEndpoints : string[] = [];
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: async () => ({
            "arch.example:5001": agent("http://arch.example:5001"),
            "us.example:5001": agent("http://us.example:5001"),
        }),
        agentSocketFactory: ((url : string) => {
            createdEndpoints.push(new URL(url).host);
            return new FakeAgentClient();
        }) as never,
    });

    await manager.connectAll();

    assert.deepEqual(createdEndpoints.sort(), [ "arch.example:5001", "us.example:5001" ]);
});

test("an unknown endpoint fails immediately with AGENT_NOT_FOUND", async () => {
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: async () => ({}),
        readyTimeout: 100,
    });

    await assert.rejects(
        manager.ensureEndpointReady("missing.example:5001"),
        (error : unknown) => error instanceof AgentManagerError && error.code === "AGENT_NOT_FOUND"
    );
});

test("an offline configured endpoint times out without blocking another endpoint", async () => {
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: async () => ({
            "us.example:5001": agent("http://us.example:5001"),
        }),
        agentSocketFactory: (() => new FakeAgentClient()) as never,
        readyTimeout: 10,
    });

    await assert.rejects(
        manager.ensureEndpointReady("us.example:5001"),
        (error : unknown) => error instanceof AgentManagerError && error.code === "AGENT_NOT_READY"
    );
});

test("an explicit login rejection reports AGENT_AUTH_FAILED", async () => {
    const manager = new AgentManager(parentSocket(), {
        agentListLoader: async () => ({
            "arch.example:5001": agent("http://arch.example:5001"),
        }),
        agentSocketFactory: (() => {
            const client = new FakeAgentClient({
                ok: false,
                msg: "bad credentials",
            });
            setTimeout(() => client.trigger("connect"), 0);
            return client;
        }) as never,
        readyTimeout: 100,
    });

    await assert.rejects(
        manager.ensureEndpointReady("arch.example:5001"),
        (error : unknown) => error instanceof AgentManagerError && error.code === "AGENT_AUTH_FAILED"
    );
});
