import assert from "node:assert/strict";
import { test } from "node:test";
import childProcessAsync from "promisify-child-process";
import { ContainerState, readContainerStates, serviceState, stackPolicy, summarizeStack } from "../stack-status";
import { aggregateServiceStatus, COMPLETED, EXITED, PARTIAL, RUNNING, STARTING, UNHEALTHY, UNKNOWN, statusColor, statusName } from "../../common/util-common";

function container(service = "web", changes: Partial<ContainerState> = {}): ContainerState {
    return { project: "erpnext",
        service,
        name: service + "-1",
        oneoff: "False",
        task: "",
        state: "running",
        health: "",
        exitCode: 0,
        oom: false,
        error: false,
        ...changes };
}

const erpCompose = `services:
  web:
    image: web
    depends_on:
      configurator:
        condition: service_completed_successfully
  configurator:
    image: web
    restart: "no"
  create-site:
    image: web
    profiles: [setup]
  disabled:
    image: web
    deploy:
      replicas: 0
`;

test("ERPNext successful configurator coexists with healthy long-running services", () => {
    const policy = stackPolicy(erpCompose);
    const items = [ container(), container("configurator", { state: "exited" }) ];
    assert.equal(serviceState(items[1], policy), "completed");
    assert.equal(summarizeStack([ items[0], container("configurator") ], policy).status, STARTING);
    assert.deepEqual(summarizeStack(items, policy), { status: RUNNING,
        hasActiveContainers: true });
    assert.equal(summarizeStack([ container("configurator", { state: "exited" }) ], policy).status, PARTIAL);
    assert.equal(summarizeStack([ container("web", { state: "exited" }), items[1] ], policy).status, EXITED);
});

test("container state matrix keeps abnormal, starting, stopped and task states distinct", () => {
    const policy = stackPolicy("services:\n  web:\n    image: web\n");
    const cases: [Partial<ContainerState>, string, number][] = [
        [{}, "running", RUNNING ],
        [{ health: "healthy" }, "healthy", RUNNING ],
        [{ health: "unhealthy" }, "unhealthy", UNHEALTHY ],
        [{ health: "starting" }, "starting", STARTING ],
        [{ state: "created" }, "starting", STARTING ],
        [{ state: "created",
            error: true }, "unhealthy", UNHEALTHY ],
        [{ state: "restarting" }, "unhealthy", UNHEALTHY ],
        [{ state: "dead" }, "unhealthy", UNHEALTHY ],
        [{ state: "exited",
            exitCode: 1 }, "unhealthy", UNHEALTHY ],
        [{ oom: true }, "unhealthy", UNHEALTHY ],
        [{ state: "exited",
            oom: true }, "unhealthy", UNHEALTHY ],
        [{ state: "exited" }, "exited", EXITED ],
        [{ state: "exited",
            health: "unhealthy" }, "exited", EXITED ],
        [{ state: "paused" }, "paused", PARTIAL ],
        [{ state: "removing" }, "unknown", UNKNOWN ],
        [{ health: "unexpected" }, "unknown", UNKNOWN ],
        [{ state: "exited",
            task: "true" }, "completed", COMPLETED ],
        [{ task: "true" }, "starting", STARTING ],
        [{ state: "exited",
            task: "true",
            exitCode: 2 }, "unhealthy", UNHEALTHY ],
    ];
    for (const [ changes, service, status ] of cases) {
        const item = container("web", changes);
        assert.equal(serviceState(item, policy), service, JSON.stringify(changes));
        assert.equal(summarizeStack([ item ], policy).status, status, JSON.stringify(changes));
    }
    assert.equal(summarizeStack([], policy).status, UNKNOWN);
    assert.equal(summarizeStack([ container() ], stackPolicy("invalid: [")).status, UNKNOWN);
});

test("task detection never guesses from restart policy or successful exit", () => {
    for (const restart of [ "no", "always", "unless-stopped", "on-failure" ]) {
        const policy = stackPolicy(`services:\n  web:\n    image: web\n    restart: "${restart}"\n`);
        assert.equal(serviceState(container("web", { state: "exited" }), policy), "exited");
    }
    const inherited = stackPolicy("x-task: &task\n  labels: {dockge.task: 'true'}\nservices:\n  web:\n    <<: *task\n    image: web\n");
    assert.equal(serviceState(container("web", { state: "exited" }), inherited), "completed");
    for (const labels of [ "{dockge.task: 'true'}", "[dockge.task=true]" ]) {
        const policy = stackPolicy(`services:\n  web:\n    image: web\n    labels: ${labels}\n`);
        assert.equal(summarizeStack([ container("web", { state: "exited" }) ], policy).status, COMPLETED);
    }
});

test("missing default services and replicas fail closed, inactive profiles and zero replicas do not", () => {
    const policy = stackPolicy(erpCompose);
    const items = [ container(), container("configurator", { state: "exited" }) ];
    assert.equal(summarizeStack(items, policy).status, RUNNING);
    assert.equal(summarizeStack([ ...items, container("create-site", { state: "exited" }) ], policy).status, PARTIAL);
    const scaled = stackPolicy("services:\n  web:\n    image: web\n    deploy:\n      replicas: 2\n");
    assert.equal(summarizeStack([ container() ], scaled).status, PARTIAL);
    assert.equal(summarizeStack([ container(), container("web", { name: "web-2" }) ], scaled).status, RUNNING);
    const dependency = stackPolicy("services:\n  web:\n    image: web\n    depends_on:\n      helper:\n        condition: service_started\n  helper:\n    image: web\n    profiles: [setup]\n");
    assert.equal(summarizeStack([ container() ], dependency).status, PARTIAL);
    const optional = stackPolicy("services:\n  web:\n    image: web\n    depends_on:\n      helper:\n        condition: service_started\n        required: false\n  helper:\n    image: web\n    profiles: [setup]\n");
    assert.equal(summarizeStack([ container() ], optional).status, RUNNING);
    assert.equal(summarizeStack([ container() ], stackPolicy("services:\n  web:\n    image: web\n    scale: ${COUNT}\n")).status, UNKNOWN);
});

test("public status numbers remain compatible and stopped is gray", () => {
    assert.deepEqual([ UNKNOWN, RUNNING, EXITED, COMPLETED, PARTIAL, UNHEALTHY, STARTING ], [ 0, 3, 4, 5, 6, 7, 8 ]);
    assert.equal(statusColor(EXITED), "secondary");
    assert.equal(statusColor(COMPLETED), statusColor(RUNNING));
    for (const status of [ COMPLETED, PARTIAL, UNHEALTHY, STARTING ]) {
        assert.notEqual(statusName(status), "unknown");
    }
});

test("snapshot uses all containers, minimal batched inspect and excludes compose run helpers", async (t) => {
    const calls: string[][] = [];
    t.mock.method(childProcessAsync, "spawn", (async (_command: string, args: string[]) => {
        calls.push(args);
        return { code: 0,
            stdout: args[0] === "ps" ? "abc123\ndef456\n" : [ container(), container("helper", { oneoff: "True" }) ].map((item) => JSON.stringify(item)).join("\n") };
    }) as never);
    assert.equal((await readContainerStates("erpnext")).length, 1);
    assert.deepEqual(calls[0], [ "ps", "-aq", "--filter", "label=com.docker.compose.project=erpnext" ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(-2), [ "abc123", "def456" ]);
    assert.equal(calls[1][2].includes(".Config.Env"), false);
    assert.equal(calls[1][2].includes("json .State}}"), false);
    assert.equal(calls[1][2].includes(".State.Error"), true);
});

test("deleted containers, incomplete output and Docker failures reject the whole snapshot", async (t) => {
    for (const result of [{ code: 1,
        stdout: "" }, { code: 0,
        stdout: "" }, { code: 0,
        stdout: "{}" }]) {
        t.mock.method(childProcessAsync, "spawn", (async (_command: string, args: string[]) => args[0] === "ps" ? { code: 0,
            stdout: "abc123\n" } : result) as never);
        await assert.rejects(readContainerStates());
    }
});

test("service cards aggregate the worst replica instead of displaying the first", () => {
    for (const state of [ "unhealthy", "unknown", "starting", "paused", "exited" ]) {
        assert.equal(aggregateServiceStatus([ "healthy", state ]), state);
        assert.equal(aggregateServiceStatus([ state, "healthy" ]), state);
    }
    assert.equal(aggregateServiceStatus([ "completed", "running" ]), "running");
    assert.equal(aggregateServiceStatus([ "completed", "completed" ]), "completed");
    assert.equal(aggregateServiceStatus([ "healthy", "unexpected" ]), "unknown");
    assert.equal(aggregateServiceStatus([]), "unknown");
});
