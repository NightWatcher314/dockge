import yaml from "yaml";
import childProcessAsync from "promisify-child-process";
import { COMPLETED, EXITED, PARTIAL, RUNNING, STARTING, UNHEALTHY, UNKNOWN } from "../common/util-common";

export interface ContainerState {
    project: string;
    service: string;
    name: string;
    oneoff: string | null;
    task: string | null;
    state: string;
    health: string;
    exitCode: number;
    oom: boolean;
    error: boolean;
}

export interface ServicePolicy {
    task: boolean;
    replicas: number;
    optional: boolean;
}

export interface StackPolicy {
    services: Map<string, ServicePolicy>;
    known: boolean;
}

/** Read only local Compose structure; never interpolate secrets or spawn compose config. */
export function stackPolicy(compose?: string): StackPolicy {
    const services = new Map<string, ServicePolicy>();
    if (compose === undefined) {
        return { services,
            known: true };
    }
    try {
        const config = yaml.parse(compose, { merge: true });
        if (!config?.services || typeof config.services !== "object" || config.include) {
            return { services,
                known: false };
        }
        let known = true;
        const dependencies = new Set<string>();
        const tasks = new Set<string>();
        for (const [ name, service ] of Object.entries(config.services) as [string, Record<string, unknown>][]) {
            if (!service || typeof service !== "object" || service.extends) {
                known = false;
                continue;
            }
            const labels = service.labels;
            const task = Array.isArray(labels) ? labels.includes("dockge.task=true") : (labels as Record<string, unknown> | undefined)?.["dockge.task"] === "true" || (labels as Record<string, unknown> | undefined)?.["dockge.task"] === true;
            const deploy = service.deploy as { replicas?: unknown } | undefined;
            const replicas = service.scale ?? deploy?.replicas ?? 1;
            if (typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 0) {
                known = false;
            }
            services.set(name, { task,
                replicas: typeof replicas === "number" ? replicas : 1,
                optional: Array.isArray(service.profiles) && service.profiles.length > 0 });
            const depends = service.depends_on;
            if (depends && typeof depends === "object" && !Array.isArray(depends)) {
                for (const [ dependency, options ] of Object.entries(depends)) {
                    if ((options as { condition?: string })?.condition === "service_completed_successfully") {
                        tasks.add(dependency);
                    }
                }
            }
        }
        // Dependencies of default services are required even when they have profiles.
        const requireDependencies = (name: string) => {
            if (dependencies.has(name)) {
                return;
            }
            dependencies.add(name);
            const service = config.services[name];
            const depends = service?.depends_on;
            for (const dependency of Array.isArray(depends) ? depends : Object.keys(depends || {})) {
                if (!Array.isArray(depends) && depends[dependency]?.required === false) {
                    continue;
                }
                const policy = services.get(dependency);
                if (policy) {
                    policy.optional = false;
                    requireDependencies(dependency);
                } else {
                    known = false;
                }
            }
        };
        for (const [ name, policy ] of services) {
            if (tasks.has(name)) {
                policy.task = true;
            }
            if (!policy.optional && policy.replicas > 0) {
                requireDependencies(name);
            }
        }
        return { services,
            known };
    } catch {
        return { services,
            known: false };
    }
}

export function serviceState(container: ContainerState, policy: StackPolicy): string {
    if (container.error || container.oom || [ "restarting", "dead" ].includes(container.state) || (container.state === "exited" && container.exitCode !== 0) || (container.state === "running" && container.health === "unhealthy")) {
        return "unhealthy";
    }
    if (container.state === "running") {
        if (container.health === "starting" || container.task === "true" || policy.services.get(container.service)?.task) {
            return "starting";
        }
        return container.health === "healthy" ? "healthy" : container.health ? "unknown" : "running";
    }
    if (container.state === "exited") {
        return container.task === "true" || policy.services.get(container.service)?.task ? "completed" : "exited";
    }
    if (container.state === "created") {
        return "starting";
    }
    return container.state === "paused" ? "paused" : "unknown";
}

export function summarizeStack(containers: ContainerState[], policy: StackPolicy) {
    const states = containers.map((container) => serviceState(container, policy));
    const hasActiveContainers = containers.some((container) => [ "running", "restarting", "paused" ].includes(container.state));
    let missing = false;
    for (const [ name, service ] of policy.services) {
        const count = containers.filter((container) => container.service === name).length;
        if ((!service.optional || count > 0) && count < service.replicas) {
            missing = true;
        }
    }
    let status = UNKNOWN;
    if (states.includes("unhealthy")) {
        status = UNHEALTHY;
    } else if (!policy.known || states.includes("unknown") || states.length === 0) {
        status = UNKNOWN;
    } else if (missing) {
        status = PARTIAL;
    } else if (states.includes("starting")) {
        status = STARTING;
    } else if (states.includes("paused")) {
        status = PARTIAL;
    } else if (states.includes("exited")) {
        status = hasActiveContainers ? PARTIAL : EXITED;
    } else if (states.every((state) => state === "completed")) {
        status = COMPLETED;
    } else if (states.every((state) => [ "running", "healthy", "completed" ].includes(state))) {
        status = RUNNING;
    }
    return { status,
        hasActiveContainers };
}

// Deliberately omit Config.Env, healthcheck output and every other inspect field.
const inspectFormat = "{\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"service\":{{json (index .Config.Labels \"com.docker.compose.service\")}},\"oneoff\":{{json (index .Config.Labels \"com.docker.compose.oneoff\")}},\"task\":{{json (index .Config.Labels \"dockge.task\")}},\"name\":{{json .Name}},\"state\":{{json .State.Status}},\"exitCode\":{{json .State.ExitCode}},\"oom\":{{json .State.OOMKilled}},\"error\":{{if .State.Error}}true{{else}}false{{end}},\"health\":{{if .State.Health}}{{json .State.Health.Status}}{{else}}\"\"{{end}}}";

/** One project-label scan, then bounded inspect batches. Deletion races fail the snapshot. */
export async function readContainerStates(project?: string): Promise<ContainerState[]> {
    const options = { encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL" as const };
    const result = await childProcessAsync.spawn("docker", [ "ps", "-aq", "--filter", `label=com.docker.compose.project${project ? "=" + project : ""}` ], options);
    if (result.code !== 0) {
        throw new Error("Failed to list containers");
    }
    const ids = result.stdout?.toString().trim().split(/\s+/).filter(Boolean) || [];
    if (ids.some((id) => !/^[a-f0-9]+$/.test(id))) {
        throw new Error("Invalid container list");
    }
    const containers: ContainerState[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const inspected = await childProcessAsync.spawn("docker", [ "inspect", "--format", inspectFormat, ...batch ], options);
        if (inspected.code !== 0) {
            throw new Error("Failed to inspect containers");
        }
        const lines = inspected.stdout?.toString().trim().split("\n").filter(Boolean) || [];
        if (lines.length !== batch.length) {
            throw new Error("Incomplete container snapshot");
        }
        for (const line of lines) {
            const item = JSON.parse(line) as ContainerState;
            if (!item.project || !item.service || typeof item.name !== "string" || typeof item.state !== "string" || typeof item.health !== "string" || typeof item.exitCode !== "number" || typeof item.oom !== "boolean" || typeof item.error !== "boolean") {
                throw new Error("Invalid container snapshot");
            }
            if (item.oneoff?.toLowerCase() !== "true") {
                containers.push({ ...item,
                    name: item.name.replace(/^\//, "") });
            }
        }
    }
    return containers;
}
