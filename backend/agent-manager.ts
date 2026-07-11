import { DockgeSocket } from "./util-server";
import { io, Socket as SocketClient } from "socket.io-client";
import { log } from "./log";
import { Agent } from "./models/agent";
import { isDev, LooseObject } from "../common/util-common";
import semver from "semver";
import { R } from "redbean-node";

export const AGENT_READY_TIMEOUT = 10000;

export type AgentManagerErrorCode = "AGENT_NOT_FOUND" | "AGENT_AUTH_FAILED" | "AGENT_NOT_READY";

export class AgentManagerError extends Error {
    code : AgentManagerErrorCode;

    constructor(code : AgentManagerErrorCode, message : string) {
        super(message);
        this.code = code;
    }
}

type AgentSocketFactory = typeof io;
type AgentListLoader = typeof Agent.getAgentList;

interface AgentManagerOptions {
    agentSocketFactory? : AgentSocketFactory;
    agentListLoader? : AgentListLoader;
    readyTimeout? : number;
}

/**
 * Dockge Instance Manager
 * One AgentManager per Socket connection
 */
export class AgentManager {

    protected socket : DockgeSocket;
    protected agentSocketList : Record<string, SocketClient> = {};
    protected agentLoggedInList : Record<string, boolean> = {};
    protected agentLoginFailureList : Record<string, AgentManagerError | undefined> = {};
    protected agentSocketFactory : AgentSocketFactory;
    protected agentListLoader : AgentListLoader;
    protected readyTimeout : number;
    protected agentListPromise? : Promise<Record<string, Agent>>;

    constructor(socket: DockgeSocket, options : AgentManagerOptions = {}) {
        this.socket = socket;
        this.agentSocketFactory = options.agentSocketFactory || io;
        this.agentListLoader = options.agentListLoader || Agent.getAgentList;
        this.readyTimeout = options.readyTimeout ?? AGENT_READY_TIMEOUT;
    }

    test(url : string, username : string, password : string) : Promise<void> {
        return new Promise((resolve, reject) => {
            let obj = new URL(url);
            let endpoint = obj.host;

            if (!endpoint) {
                reject(new Error("Invalid Dockge URL"));
            }

            if (this.agentSocketList[endpoint]) {
                reject(new Error("The Dockge URL already exists"));
            }

            let client = this.agentSocketFactory(url, {
                reconnection: false,
                extraHeaders: {
                    endpoint,
                }
            });

            client.on("connect", () => {
                client.emit("login", {
                    username: username,
                    password: password,
                }, (res : LooseObject) => {
                    if (res.ok) {
                        resolve();
                    } else {
                        reject(new Error(res.msg));
                    }
                    client.disconnect();
                });
            });

            client.on("connect_error", (err) => {
                if (err.message === "xhr poll error") {
                    reject(new Error("Unable to connect to the Dockge instance"));
                } else {
                    reject(err);
                }
                client.disconnect();
            });
        });
    }

    /**
     *
     * @param url
     * @param username
     * @param password
     * @param name
     */
    async add(url: string, username: string, password: string, name: string): Promise<Agent> {
        let bean = R.dispense("agent") as Agent;
        bean.url = url;
        bean.username = username;
        bean.password = password;
        bean.name = (name || "").trim();
        await R.store(bean);
        return bean;
    }

    /**
     *
     * @param url
     */
    async remove(url : string) {
        let bean = await R.findOne("agent", " url = ? ", [
            url,
        ]);

        if (bean) {
            await R.trash(bean);
            let endpoint = bean.endpoint;
            this.disconnect(endpoint);
            this.sendAgentList();
            delete this.agentSocketList[endpoint];
        } else {
            throw new Error("Agent not found");
        }
    }

    /**
     *
     * @param url
     * @param updatedName
     */
    async update(url: string, updatedName: string) {
        const agent = await R.findOne("agent", " url = ? ", [
            url,
        ]);
        if (agent) {
            agent.name = (updatedName || "").trim();
            await R.store(agent);
        } else {
            throw new Error("Agent not found");
        }
    }

    connect(url : string, username : string, password : string) {
        let obj = new URL(url);
        let endpoint = obj.host;

        this.socket.emit("agentStatus", {
            endpoint: endpoint,
            status: "connecting",
        });

        if (!endpoint) {
            log.error("agent-manager", "Invalid endpoint: " + endpoint + " URL: " + url);
            return;
        }

        if (this.agentSocketList[endpoint]) {
            log.debug("agent-manager", "Already connected to the socket server: " + endpoint);
            return;
        }

        log.info("agent-manager", "Connecting to the socket server: " + endpoint);
        let client = this.agentSocketFactory(url, {
            extraHeaders: {
                endpoint,
            }
        });
        this.agentSocketList[endpoint] = client;
        this.agentLoggedInList[endpoint] = false;
        delete this.agentLoginFailureList[endpoint];

        client.on("connect", () => {
            log.info("agent-manager", "Connected to the socket server: " + endpoint);

            client.emit("login", {
                username: username,
                password: password,
            }, (res : LooseObject) => {
                if (res.ok) {
                    log.info("agent-manager", "Logged in to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = true;
                    delete this.agentLoginFailureList[endpoint];
                    this.socket.emit("agentStatus", {
                        endpoint: endpoint,
                        status: "online",
                    });
                } else {
                    log.error("agent-manager", "Failed to login to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = false;
                    this.agentLoginFailureList[endpoint] = new AgentManagerError(
                        "AGENT_AUTH_FAILED",
                        "Failed to authenticate with agent endpoint: " + endpoint
                    );
                    this.socket.emit("agentStatus", {
                        endpoint: endpoint,
                        status: "offline",
                        msg: res.msg,
                    });
                }
            });
        });

        client.on("connect_error", (err) => {
            log.error("agent-manager", "Error from the socket server: " + endpoint);
            this.socket.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("disconnect", () => {
            log.info("agent-manager", "Disconnected from the socket server: " + endpoint);
            this.agentLoggedInList[endpoint] = false;
            this.socket.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("agent", (...args : unknown[]) => {
            this.socket.emit("agent", ...args);
        });

        client.on("info", (res) => {
            log.debug("agent-manager", res);

            // Disconnect if the version is lower than 1.4.0
            if (!isDev && semver.satisfies(res.version, "< 1.4.0")) {
                this.socket.emit("agentStatus", {
                    endpoint: endpoint,
                    status: "offline",
                    msg: `${endpoint}: Unsupported version: ` + res.version,
                });
                client.disconnect();
            }
        });

    }

    disconnect(endpoint : string) {
        let client = this.agentSocketList[endpoint];
        client?.disconnect();
    }

    async connectAll() {
        if (this.socket.endpoint) {
            log.info("agent-manager", "This connection is connected as an agent, skip connectAll()");
            return;
        }

        const list = await this.loadAgentList();

        if (Object.keys(list).length !== 0) {
            log.info("agent-manager", "Connecting to all instance socket server(s)...");
        }

        for (let endpoint in list) {
            let agent = list[endpoint];
            this.connect(agent.url, agent.username, agent.password);
        }
    }

    protected loadAgentList() : Promise<Record<string, Agent>> {
        if (!this.agentListPromise) {
            this.agentListPromise = this.agentListLoader().finally(() => {
                this.agentListPromise = undefined;
            });
        }
        return this.agentListPromise;
    }

    disconnectAll() {
        for (let endpoint in this.agentSocketList) {
            this.disconnect(endpoint);
        }
    }

    async ensureEndpointReady(endpoint : string) : Promise<SocketClient> {
        let client = this.agentSocketList[endpoint];
        if (!client) {
            const list = await this.loadAgentList();
            const agent = list[endpoint];
            if (!agent) {
                throw new AgentManagerError(
                    "AGENT_NOT_FOUND",
                    "Agent endpoint is not configured: " + endpoint
                );
            }

            this.connect(agent.url, agent.username, agent.password);
            client = this.agentSocketList[endpoint];
        }

        const startedAt = Date.now();
        while (!client.connected || !this.agentLoggedInList[endpoint]) {
            const loginFailure = this.agentLoginFailureList[endpoint];
            if (loginFailure) {
                throw loginFailure;
            }

            if (Date.now() - startedAt >= this.readyTimeout) {
                throw new AgentManagerError(
                    "AGENT_NOT_READY",
                    "Agent endpoint did not become ready within " + this.readyTimeout + "ms: " + endpoint
                );
            }

            await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.readyTimeout)));
            client = this.agentSocketList[endpoint];
        }

        return client;
    }

    async emitToEndpoint(endpoint: string, eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to endpoint: " + endpoint);
        const client = await this.ensureEndpointReady(endpoint);

        client.emit("agent", endpoint, eventName, ...args);
    }

    emitToAllEndpoints(eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to all endpoints");
        for (let endpoint in this.agentSocketList) {
            this.emitToEndpoint(endpoint, eventName, ...args).catch((e) => {
                log.warn("agent-manager", e.message);
            });
        }
    }

    async sendAgentList() {
        let list = await Agent.getAgentList();
        let result : Record<string, LooseObject> = {};

        // Myself
        result[""] = {
            url: "",
            username: "",
            endpoint: "",
            name: "",
            updatedName: "",
        };

        for (let endpoint in list) {
            let agent = list[endpoint];
            result[endpoint] = agent.toJSON();
        }

        this.socket.emit("agentList", {
            ok: true,
            agentList: result,
        });
    }
}
