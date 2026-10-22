import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
// @ts-ignore -- composerize does not publish TypeScript declarations.
import composerize from "composerize";
import type { DockgeServer } from "./dockge-server";
import type { DockgeSocket } from "./util-server";
import { Stack } from "./stack";
import { composePlan, ComposeSnapshot, parseCompose, stackRevision } from "./mcp-compose";

type Arguments = Record<string, unknown>;
export interface McpIdentity {
    userId: number;
    scopes: string[];
}

export class McpError extends Error {
    constructor(public code: string, safeMessage: string) {
        super(safeMessage);
        this.name = "McpError";
    }
}

type ServiceStatus = { service: string; containers: { name: string; status: string }[] };
const mutationOperations = new Set([ "stack_save", "stack_deploy", "stack_apply", "stack_action", "service_action" ]);
const stackActions = new Set([ "start", "stop", "restart", "down", "delete", "update" ]);
const serviceActions = new Set([ "start", "stop", "restart" ]);
const destructiveActions = new Set([ "stop", "down", "delete" ]);

export class McpService {
    // Shared between sessions: a new service object must not bypass a running operation.
    private static locks = new WeakMap<DockgeServer, Map<string, Promise<void>>>();
    private static pending = new WeakMap<DockgeServer, Set<string>>();
    protected mutationTimeoutMs = 30000;

    constructor(private server: DockgeServer) {}

    async execute(operation: string, args: Arguments, identity: McpIdentity) : Promise<Record<string, unknown>> {
        try {
            this.requireScope(identity, "read");
            if (mutationOperations.has(operation)) {
                this.requireScope(identity, "write");
            }
            // Endpoint routing belongs to the transport and is never performed here.
            if (args.endpoint !== undefined && args.endpoint !== "") {
                throw new McpError("INVALID_ARGUMENT", "Local operations cannot select an endpoint");
            }
            switch (operation) {
                case "doctor": {
                    let dockerAvailable = false;
                    try {
                        await Stack.getStatusList();
                        dockerAvailable = true;
                    } catch {
                        // Return availability only; Docker errors can contain sensitive host data.
                    }
                    return { version: this.server.packageJSON?.version || "unknown",
                        nodeVersion: process.version,
                        platform: process.platform,
                        dockerAvailable };
                }
                case "stack_list": {
                    const stacks = await Stack.getStackList(this.server);
                    return { stacks: [ ...stacks.values() ].map((stack) => this.metadata(stack)) };
                }
                case "stack_get": {
                    if (args.includeSecrets === true) {
                        this.requireScope(identity, "secrets");
                    }
                    const stack = await this.getStack(args);
                    const result = { ...this.metadata(stack),
                        revision: stackRevision(this.snapshot(stack.name)) };
                    return args.includeSecrets === true ? { ...result,
                        composeYAML: stack.composeYAML,
                        composeENV: stack.composeENV } : result;
                }
                case "stack_ps": {
                    const stack = await this.getStack(args);
                    return { ...this.metadata(stack),
                        services: await this.serviceStatus(stack) };
                }
                case "service_status": {
                    const stack = await this.getStack(args);
                    return { name: stack.name,
                        services: await this.serviceStatus(stack) };
                }
                case "stack_logs":
                    this.requireScope(identity, "secrets");
                    return await this.logs(args);
                case "stack_plan":
                case "stack_diff": {
                    if (args.includeValues === true) {
                        this.requireScope(identity, "secrets");
                    }
                    const name = this.name(args);
                    const current = this.snapshot(name);
                    const desired = this.desired(name, args, current);
                    const plan = composePlan(name, current, desired);
                    return operation === "stack_diff" && args.includeValues === true ? {
                        ...plan,
                        old: { composeYAML: current.composeYAML,
                            composeENV: current.composeENV },
                        new: { composeYAML: desired.composeYAML,
                            composeENV: desired.composeENV },
                    } : plan;
                }
                case "stack_save":
                case "stack_deploy":
                case "stack_apply":
                    return await this.withLock(this.name(args), () => this.apply(operation, args, identity));
                case "stack_action":
                case "service_action":
                    return await this.withLock(this.name(args), () => this.action(operation, args, identity));
                case "stack_verify":
                    return await this.verify(args);
                case "network_list": {
                    const networks = await this.server.getDockerNetworkList();
                    return { networks: networks.filter((value) => typeof value === "string") };
                }
                case "composerize":
                    this.requireScope(identity, "secrets");
                    if (typeof args.command !== "string" || args.command.length === 0) {
                        throw new McpError("INVALID_ARGUMENT", "A Docker run command is required");
                    }
                    return { composeYAML: composerize(args.command, "", "latest") };
                default:
                    throw new McpError("UNKNOWN_OPERATION", "Unknown MCP operation");
            }
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            // Stack, Docker and YAML errors may contain .env values or terminal output.
            throw new McpError("OPERATION_FAILED", "Dockge operation failed");
        }
    }

    private requireScope(identity: McpIdentity, scope: string) {
        if (!Number.isInteger(identity.userId) || identity.userId <= 0 || !Array.isArray(identity.scopes) || !identity.scopes.includes(scope)) {
            throw new McpError("FORBIDDEN", "Required MCP scope is missing");
        }
    }

    private name(args: Arguments) : string {
        if (typeof args.name !== "string") {
            throw new McpError("INVALID_ARGUMENT", "A stack name is required");
        }
        try {
            new Stack(this.server, args.name, "services: {}\n", "", true).validate();
        } catch {
            throw new McpError("INVALID_ARGUMENT", "Invalid stack name");
        }
        return args.name;
    }

    private async getStack(args: Arguments) : Promise<Stack> {
        const name = this.name(args);
        try {
            return await Stack.getStack(this.server, name);
        } catch {
            throw new McpError("STACK_NOT_FOUND", "Stack not found");
        }
    }

    private snapshot(name: string) : ComposeSnapshot {
        const stack = new Stack(this.server, name);
        return { exists: stack.isManagedByDockge,
            composeYAML: stack.composeYAML,
            composeENV: stack.composeENV };
    }

    private metadata(stack: Stack) {
        return {
            name: stack.name,
            status: stack.status,
            isManagedByDockge: stack.isManagedByDockge,
            endpoint: "",
        };
    }

    private desired(name: string, args: Arguments, current: ComposeSnapshot, allowOmittedCompose = false) : ComposeSnapshot {
        const composeYAML = allowOmittedCompose && args.composeYAML === undefined ? current.composeYAML : args.composeYAML;
        const composeENV = args.composeENV === undefined ? current.composeENV : args.composeENV;
        if (typeof composeYAML !== "string" || typeof composeENV !== "string") {
            throw new McpError("INVALID_ARGUMENT", "Compose and env must be strings");
        }
        try {
            parseCompose(composeYAML);
            new Stack(this.server, name, composeYAML, composeENV, true).validate();
        } catch {
            throw new McpError("INVALID_COMPOSE", "Invalid Compose or env document");
        }
        return { exists: true,
            composeYAML,
            composeENV };
    }

    private revisionGate(args: Arguments, current: ComposeSnapshot) {
        if (typeof args.expectedRevision !== "string" || args.expectedRevision !== stackRevision(current)) {
            throw new McpError("REVISION_CONFLICT", "Expected stack revision is missing or stale; plan again");
        }
    }

    private fileGate(name: string, args: Arguments, identity: McpIdentity, current: ComposeSnapshot, desired: ComposeSnapshot) {
        this.requireScope(identity, "read");
        this.requireScope(identity, "write");
        this.revisionGate(args, current);
        if (current.exists) {
            this.requireScope(identity, "destructive");
            if (args.confirm !== true) {
                throw new McpError("CONFIRMATION_REQUIRED", "Confirm overwriting the existing stack");
            }
        }
        if (!Array.isArray(args.allowedPaths) || !args.allowedPaths.every((item) => Array.isArray(item) && item.every((part) => typeof part === "string"))) {
            throw new McpError("PATHS_REQUIRED", "Exact allowed Compose paths are required");
        }
        const allowed = new Set(args.allowedPaths.map((item) => JSON.stringify(item)));
        const plan = composePlan(name, current, desired);
        if (plan.changedPaths.some((item) => !allowed.has(JSON.stringify(item)))) {
            throw new McpError("PATH_NOT_ALLOWED", "Compose changes exceed the allowed paths");
        }
        if (plan.env_changed && args.allowEnvChange !== true) {
            throw new McpError("ENV_CHANGE_NOT_ALLOWED", "Explicit permission is required to change env");
        }
    }

    private fakeSocket(identity: McpIdentity) : DockgeSocket {
        // Stack mutations and Terminal.exec use only these fields; no live socket
        // or agent manager is needed and terminal output is never forwarded.
        return {
            id: "mcp-" + randomUUID(),
            userID: identity.userId,
            endpoint: "",
            connected: false,
            emitAgent: () => undefined,
        } as unknown as DockgeSocket;
    }

    private async withLock<T>(name: string, operation: () => Promise<T>) : Promise<T> {
        let locks = McpService.locks.get(this.server);
        if (!locks) {
            locks = new Map();
            McpService.locks.set(this.server, locks);
        }
        const previous = locks.get(name) || Promise.resolve();
        let release: () => void = () => undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        locks.set(name, current);
        await previous;
        try {
            if (McpService.pending.get(this.server)?.has(name)) {
                throw new McpError("OPERATION_PENDING", "An earlier operation may still be running; verify before another mutation");
            }
            return await operation();
        } finally {
            release();
            if (locks.get(name) === current) {
                locks.delete(name);
            }
        }
    }

    private async boundedMutation(name: string, operation: () => Promise<number>) {
        let pending = McpService.pending.get(this.server);
        if (!pending) {
            pending = new Set();
            McpService.pending.set(this.server, pending);
        }
        pending.add(name);
        let timer: NodeJS.Timeout | undefined;
        const completion = Promise.resolve().then(operation).then((exitCode) => {
            if (exitCode !== 0) {
                throw new McpError("APPLY_FAILED", "Docker operation failed");
            }
        }).finally(() => pending?.delete(name));
        try {
            await Promise.race([
                completion,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new McpError("OUTCOME_UNKNOWN", "Operation timed out; it may still be running")), this.mutationTimeoutMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async apply(operation: string, args: Arguments, identity: McpIdentity) {
        const name = this.name(args);
        const mode = operation === "stack_save" ? "save" : operation === "stack_deploy" ? "deploy" : args.mode;
        if (mode !== "save" && mode !== "deploy") {
            throw new McpError("INVALID_ARGUMENT", "Apply mode must be save or deploy");
        }
        this.verifyOptions(args);
        const current = this.snapshot(name);
        const desired = this.desired(name, args, current, operation === "stack_deploy");
        this.fileGate(name, args, identity, current, desired);
        const stack = new Stack(this.server, name, desired.composeYAML, desired.composeENV);
        // Recheck after filesystem awaits, immediately before the synchronous write.
        await stack.save(!current.exists, () => this.fileGate(name, args, identity, this.snapshot(name), desired));
        const persisted = this.snapshot(name);
        if (!persisted.exists || persisted.composeYAML !== desired.composeYAML || persisted.composeENV !== desired.composeENV) {
            throw new McpError("PERSISTENCE_FAILED", "Stack readback did not match the submitted documents");
        }
        let applyError: { code: string; message: string } | undefined;
        if (mode === "deploy") {
            try {
                await this.boundedMutation(name, () => stack.deploy(this.fakeSocket(identity)));
            } catch (error) {
                applyError = error instanceof McpError ? { code: error.code,
                    message: error.message } : { code: "APPLY_FAILED",
                    message: "Docker operation failed" };
            }
        }
        const outcomeUnknown = applyError?.code === "OUTCOME_UNKNOWN";
        const verification = args.verify !== false ? await this.verify({ ...args,
            name }, desired, mode === "deploy") : undefined;
        return {
            name,
            revision: stackRevision(persisted),
            saved: true,
            applied: !applyError,
            outcomeUnknown,
            ...(applyError ? { apply_error: applyError } : {}),
            ...(verification ? { verification } : {}),
        };
    }

    private async action(operation: string, args: Arguments, identity: McpIdentity) {
        const name = this.name(args);
        const action = args.action;
        const isService = operation === "service_action";
        if (typeof action !== "string" || !(isService ? serviceActions : stackActions).has(action)) {
            throw new McpError("INVALID_ARGUMENT", "Invalid action");
        }
        this.requireScope(identity, "read");
        this.requireScope(identity, "write");
        this.revisionGate(args, this.snapshot(name));
        if (destructiveActions.has(action)) {
            this.requireScope(identity, "destructive");
            if (args.confirm !== true) {
                throw new McpError("CONFIRMATION_REQUIRED", "Confirm the destructive action");
            }
        }
        const stack = await this.getStack(args);
        const service = isService ? this.serviceName(args, stack) : "";
        this.revisionGate(args, this.snapshot(name));
        const socket = this.fakeSocket(identity);
        const commands: Record<string, () => Promise<number>> = isService ? {
            start: () => stack.startService(socket, service),
            stop: () => stack.stopService(socket, service),
            restart: () => stack.restartService(socket, service),
        } : {
            start: () => stack.start(socket),
            stop: () => stack.stop(socket),
            restart: () => stack.restart(socket),
            down: () => stack.down(socket),
            delete: () => stack.delete(socket),
            update: () => stack.update(socket),
        };
        try {
            await this.boundedMutation(name, commands[action]);
            return { name,
                action,
                ...(isService ? { service } : {}),
                applied: true,
                outcomeUnknown: false };
        } catch (error) {
            return {
                name,
                action,
                applied: false,
                outcomeUnknown: error instanceof McpError && error.code === "OUTCOME_UNKNOWN",
                apply_error: { code: error instanceof McpError ? error.code : "APPLY_FAILED",
                    message: "Docker operation did not complete successfully; verify its state" },
                verification: action === "delete" ? { exists: this.snapshot(name).exists } : await this.verify({ name,
                    timeoutSeconds: 0 }, undefined, false),
            };
        }
    }

    private serviceName(args: Arguments, stack: Stack) : string {
        const name = args.service;
        const services = parseCompose(stack.composeYAML).services;
        if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !services || typeof services !== "object" || !Object.hasOwn(services, name)) {
            throw new McpError("INVALID_ARGUMENT", "Unknown or invalid service name");
        }
        return name;
    }

    private async serviceStatus(stack: Stack) : Promise<ServiceStatus[]> {
        const statuses = await stack.getServiceStatusList(true);
        return [ ...statuses ].filter(([ service ]) => typeof service === "string").map(([ service, values ]) => ({
            service,
            containers: values.map((value) => {
                const item = value as Record<string, unknown>;
                return { name: typeof item.name === "string" ? item.name : "",
                    status: typeof item.status === "string" ? item.status : "unknown" };
            }),
        }));
    }

    private verifyOptions(args: Arguments) {
        const timeout = args.timeoutSeconds ?? 30;
        const poll = args.pollSeconds ?? 1;
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 120 || typeof poll !== "number" || !Number.isFinite(poll) || poll < 0.25 || poll > 120) {
            throw new McpError("INVALID_ARGUMENT", "Invalid verification timeout or polling interval");
        }
        let healthUrl: URL | undefined;
        if (args.healthUrl !== undefined) {
            try {
                healthUrl = new URL(String(args.healthUrl));
                if (![ "http:", "https:" ].includes(healthUrl.protocol) || healthUrl.username || healthUrl.password) {
                    throw new Error();
                }
            } catch {
                throw new McpError("INVALID_ARGUMENT", "Health URL must use HTTP or HTTPS without credentials");
            }
        }
        if (args.services !== undefined && (!Array.isArray(args.services) || !args.services.every((service) => typeof service === "string"))) {
            throw new McpError("INVALID_ARGUMENT", "Verification services must be a list of names");
        }
        return { timeout,
            poll,
            healthUrl };
    }

    private async verify(args: Arguments, desired?: ComposeSnapshot, requireServices = true) {
        const name = this.name(args);
        const options = this.verifyOptions(args);
        requireServices = requireServices && args.requireServices !== false;
        const deadline = Date.now() + options.timeout * 1000;
        do {
            let services: ServiceStatus[] = [];
            const current = this.snapshot(name);
            let servicesOK = !requireServices;
            try {
                services = await this.serviceStatus(await this.getStack(args));
                const serviceMap = parseCompose(current.composeYAML).services;
                const expected = args.services as string[] | undefined ?? Object.keys(serviceMap && typeof serviceMap === "object" ? serviceMap : {});
                servicesOK = !requireServices || (expected.length > 0 && expected.every((service) => {
                    const containers = services.find((item) => item.service === service)?.containers;
                    return !!containers?.length && containers.every((item) => [ "running", "healthy", "started", "up" ].includes(item.status.toLowerCase()));
                }));
            } catch {
                servicesOK = !requireServices;
            }
            const health = options.healthUrl ? await this.health(options.healthUrl, Math.max(1, Math.min(5000, deadline - Date.now()))) : null;
            const persisted = !desired || (current.composeYAML === desired.composeYAML && current.composeENV === desired.composeENV);
            const ok = current.exists && persisted && servicesOK && (!health || health.ok);
            const result = { name,
                ok,
                exists: current.exists,
                revision: stackRevision(current),
                persisted,
                servicesOK,
                services,
                health };
            if (ok || Date.now() >= deadline) {
                return result;
            }
            await delay(Math.min(options.poll * 1000, Math.max(0, deadline - Date.now())));
        } while (true);
    }

    private async health(url: URL, timeout: number) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(timeout),
                redirect: "manual" });
            await response.body?.cancel();
            return { ok: response.status >= 200 && response.status < 400,
                status: response.status };
        } catch {
            return { ok: false };
        }
    }

    private async logs(args: Arguments) {
        const stack = await this.getStack(args);
        const waitSeconds = args.waitSeconds ?? 0;
        if (typeof waitSeconds !== "number" || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 10) {
            throw new McpError("INVALID_ARGUMENT", "Invalid log collection window");
        }
        const tail = args.tail ?? 200;
        const offset = args.offset ?? 0;
        if (typeof tail !== "number" || !Number.isInteger(tail) || tail < 0 || tail > 1000 || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || (args.grep !== undefined && typeof args.grep !== "string")) {
            throw new McpError("INVALID_ARGUMENT", "Invalid log limit or filter");
        }
        let since: string | undefined;
        if (args.since !== undefined) {
            if (typeof args.since !== "string" || !Number.isFinite(Date.parse(args.since))) {
                throw new McpError("INVALID_ARGUMENT", "Invalid log timestamp");
            }
            since = new Date(args.since).toISOString();
        }
        if (waitSeconds > 0) {
            await delay(waitSeconds * 1000);
        }
        const startedAt = new Date().toISOString();
        const text = await stack.boundedLogs(tail, since);
        const lines = text.split("\n").filter((line) => line.length > 0);
        const selected = lines.slice(offset).filter((line) => args.grep === undefined || line.includes(args.grep as string));
        return { name: stack.name,
            lines: selected,
            nextOffset: lines.length,
            since: startedAt };
    }
}
