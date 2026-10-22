import { z } from "zod";

const endpoint = z.string().max(255).default("").describe("Configured agent endpoint (host:port); empty selects this server. Never falls back to another host.");
const name = z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/);
const revision = z.string().min(1).max(128).describe("Revision from stack_get or stack_plan. Required for mutations; stale revisions fail without writing.");
const content = z.string().max(1024 * 1024);
const desired = {
    endpoint,
    name,
    composeYAML: content,
    composeENV: content.optional().describe("Omit to preserve existing .env; explicitly empty clears it."),
};
const gate = {
    expectedRevision: revision,
    allowedPaths: z.array(z.array(z.string().max(255)).min(1).max(32)).max(1000).describe("Exact structural Compose paths approved for change, e.g. [[\"services\",\"web\",\"image\"]]. No wildcards."),
    allowEnvChange: z.boolean().default(false),
    confirm: z.boolean().default(false).describe("Explicit authorization to overwrite or perform a destructive operation."),
};
const verification = {
    healthUrl: z.string().url().max(2048).optional().describe("Optional HTTP(S) health probe executed from the target server; credentials in URL are rejected."),
    services: z.array(z.string().min(1).max(128)).max(100).optional(),
    timeoutSeconds: z.number().min(0).max(120).default(30),
    pollSeconds: z.number().min(0.25).max(30).default(1),
};
const plan = z.object(desired).strict();
const apply = z.object({ ...desired,
    ...gate,
    ...verification,
    mode: z.enum([ "save", "deploy" ]).default("deploy"),
    verify: z.boolean().default(true) }).strict();

/** Shared schemas also validate requests forwarded by authenticated agents. */
export const mcpTools = {
    get_guide: { schema: z.object({}).strict(),
        description: "Read the Dockge operating guide: scopes, safe change workflow, endpoint selection and timeout recovery. No side effects." },
    whoami: { schema: z.object({}).strict(),
        description: "Current API key identity, scopes and connection transport; never returns the key or agent credentials." },
    agent_list: { schema: z.object({}).strict(),
        description: "List configured node endpoints and names without connecting to them or returning credentials." },
    doctor: { schema: z.object({ endpoint }).strict(),
        description: "Read target server version and Docker availability. Connects only to the requested endpoint." },
    stack_list: { schema: z.object({ endpoint,
        allEndpoints: z.boolean().default(false) }).strict(),
    description: "List safe stack metadata. allEndpoints explicitly queries each node and returns independent per-node errors." },
    stack_get: { schema: z.object({ endpoint,
        name,
        includeSecrets: z.boolean().default(false) }).strict(),
    description: "Read safe stack metadata and revision. includeSecrets requires secrets scope and returns raw Compose and .env; keep them out of recorded output." },
    stack_ps: { schema: z.object({ endpoint,
        name }).strict(),
    description: "Read stack and service runtime state without raw Compose or .env." },
    stack_logs: { schema: z.object({ endpoint,
        name,
        tail: z.number().int().min(0).max(1000).default(200),
        waitSeconds: z.number().min(0).max(10).default(0).describe("Collection window before fetching logs; max 10 seconds. Use 2 for the CLI default wait window."),
        grep: z.string().max(256).optional(),
        since: z.string().datetime().optional(),
        offset: z.number().int().nonnegative().default(0) }).strict(),
    description: "Read bounded log snapshot (secrets scope), optionally after waitSeconds to collect new output. Literal grep, tail <=1000. Poll returned since for follow; offset selects within one snapshot and is not a rolling cursor. Logs may contain credentials." },
    stack_plan: { schema: plan,
        description: "Compare desired Compose structurally against current files; returns revision, exact changed paths and env key delta without values. Does not save. Omitted env preserves current values." },
    stack_diff: { schema: plan.extend({ includeValues: z.boolean().default(false) }),
        description: "Structural Compose/env diff; values omitted by default. includeValues needs secrets scope and can expose credentials. Does not save." },
    stack_save: { schema: z.object({ ...desired,
        ...gate }).strict(),
    description: "Persist Compose and .env without deploying. Requires write; overwriting needs destructive + confirm. First plan, supply expectedRevision and exact allowedPaths; env changes additionally require allowEnvChange. No mutation retries." },
    stack_deploy: { schema: z.object({ ...desired,
        composeYAML: content.optional(),
        ...gate,
        ...verification,
        verify: z.boolean().default(true) }).strict(),
    description: "Save then deploy, or deploy current files when composeYAML omitted. Same revision/allowlist/confirmation gate as stack_save. Poll read-only verification after ambiguous timeout; never retry a timed-out write." },
    stack_apply: { schema: apply,
        description: "Plan-gated save/deploy with persistence readback and optional service/HTTP verification. Existing stacks require destructive + confirm; expectedRevision and exact allowedPaths prevent unrelated changes. Omitted env preserves it. Timeout reports outcomeUnknown; inspect state before any new mutation." },
    stack_verify: { schema: z.object({ endpoint,
        name,
        ...verification,
        requireServices: z.boolean().default(true) }).strict(),
    description: "Poll target stack/service state and optional HTTP health without mutation. Health probes send HTTP(S) GET from the selected server to the supplied URL (read scope), return only status/ok and never follow redirects. Empty or unhealthy service sets fail; health null means no HTTP check was requested." },
    stack_action: { schema: z.object({ endpoint,
        name,
        expectedRevision: revision,
        action: z.enum([ "start", "stop", "restart", "update", "down", "delete" ]),
        confirm: z.boolean().default(false) }).strict(),
    description: "Execute one lifecycle action, never retry. Requires write and current revision; stop/down/delete also require destructive + confirm. update pulls and restarts workloads. Verify services separately after success or timeout." },
    service_status: { schema: z.object({ endpoint,
        name,
        allEndpoints: z.boolean().default(false) }).strict(),
    description: "Read safe service runtime status; allEndpoints returns per-node results including independent offline errors." },
    service_action: { schema: z.object({ endpoint,
        name,
        expectedRevision: revision,
        service: z.string().min(1).max(128),
        action: z.enum([ "start", "stop", "restart" ]),
        confirm: z.boolean().default(false) }).strict(),
    description: "Start/stop/restart one service. Requires write and current revision; stop additionally requires destructive + confirm. No automatic retry; read service_status to resolve timeout." },
    network_list: { schema: z.object({ endpoint }).strict(),
        description: "Read existing Docker network names from the selected endpoint." },
    composerize: { schema: z.object({ endpoint,
        command: z.string().min(1).max(65536) }).strict(),
    description: "Convert docker run text into Compose without executing it. Requires secrets scope because command/output may contain credentials." },
};

export type McpOperation = keyof typeof mcpTools;

/** Reject unknown tool names and unknown fields before business execution. */
export function parseMcpInput(operation: string, args: unknown): Record<string, unknown> {
    if (!Object.hasOwn(mcpTools, operation)) {
        throw new Error("Unknown MCP operation");
    }
    return mcpTools[operation as McpOperation].schema.parse(args);
}
