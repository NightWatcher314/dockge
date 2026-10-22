# Native remote MCP

Dockge serves the official TypeScript MCP SDK at `POST /mcp` in its existing
Express process. Streamable HTTP is stateless and JSON responses carry both text
and structured results. Configure a remote MCP client with:

```json
{
  "url": "https://dockge.example.com/mcp",
  "headers": { "Authorization": "Bearer <your-api-key>" }
}
```

Use the equivalent remote HTTP/headers fields of your client. No local executable,
Python, CLI, OAuth or Authentik is involved. TLS validation belongs to the client;
keep it enabled. This endpoint requires a bearer key even when web authentication
is disabled. GET/SSE sessions and legacy HTTP+SSE are not provided; clients should
use standard Streamable HTTP POST.

For remote access, set `DOCKGE_MCP_ALLOWED_HOSTS=dockge.example.com` on the Dockge
server. Comma-separated exact hostnames or host:port values are accepted; there
are no wildcards. The default allows loopback hosts only. Include every intended
proxy/internal hostname. This affects `/mcp` only. Host and browser Origin are
checked before authentication; cross-host browser requests are rejected. Reverse
proxies must preserve the original `Host` header.

## Keys and scopes

In **Settings → Security → MCP API Keys**, create a named key with a 1–365 day
expiry and selected permissions. The UI offers 7/30/90/365 days. Copy the token
when first shown; hide it afterwards. Lists never return the token or its hash.
Only a real password/token login session with an active user can manage its keys;
automatic `disableAuth` sessions cannot create persistent credentials. Revoke in
the same page. Each HTTP request rechecks revocation, expiry and active user state,
including requests from an already initialized MCP client. Revocation does not
cancel an operation already in progress.

The database migration stores SHA-256 of a 256-bit random key, owner ID, scopes,
expiry and revocation time. No bearer token is stored. Each scope is checked in
the server business service, including forwarded agent calls:

| Scope | Access |
| --- | --- |
| `read` | Required for all tools; metadata, structural plans, state and network inspection |
| `write` | Stack save/deploy/apply, stack and service lifecycle actions |
| `destructive` | Existing stack overwrite, stack stop/down/delete, service stop; also requires `confirm: true` |
| `secrets` | Raw Compose/.env, logs, valued diffs and composerize input/output |

Permissions are independent; write does not imply destructive or secrets.
`stack_get` defaults to safe metadata plus revision. Raw documents require
`includeSecrets: true`. Plans/diffs report changed paths and env key names without
values; `stack_diff.includeValues` explicitly requests secrets. Ordinary tools,
verification and errors never embed raw stack objects or agent credentials.

## Safe workflow

1. Use `agent_list`; empty `endpoint` explicitly selects this server. A configured
   remote endpoint uses the existing AgentManager and credentials internally.
   Connections are lazy; unrelated offline agents do not block a selected node.
   Remote errors never fall back locally. `allEndpoints` explicitly queries each
   configured node and returns independent per-node results/errors.
2. Run `stack_plan` with `name`, desired `composeYAML` and optional `composeENV`.
   Omitted env preserves the current `.env`; an explicit empty string clears it.
   The plan returns a SHA-256 revision including existence and exact document bytes,
   `changedPaths` as arrays, and env key deltas. New stacks also require a plan.
3. Supply that `expectedRevision` and task-approved exact `allowedPaths` to
   save/deploy/apply. For example `[["services", "web", "image"]]` allows only that
   image field. Keys containing dots remain unambiguous. Added/removed objects are
   reported at their structural path; use the exact plan result. No wildcard or
   parent-prefix approval exists. Env changes additionally need `allowEnvChange`.
   Existing stack writes require destructive scope and `confirm: true`.
4. `stack_apply` defaults to deploy + verify; `mode: "save"` persists without
   starting containers. `stack_deploy` can omit Compose to deploy current files.
   Save readback compares both submitted files. Mutations share a per-stack lock;
   the revision is reread immediately before saving. Lifecycle/service mutations
   also require current revision. External editors are not part of this mutex;
   avoid simultaneous external writes while applying.
5. Check `saved`, `applied`, `outcomeUnknown`, `apply_error` and `verification`.
   Deploy/lifecycle calls wait at most 30 seconds before reporting an ambiguous
   outcome, without replaying the mutation. While it still runs, further MCP
   mutations on the stack are blocked. Use read-only state/log/verification tools
   before deciding on another write. A remote transport timeout likewise means
   the result can be unknown.
6. Verification polls actual service state and optional HTTP health on the target
   server. Defaults: 30 seconds, 1-second interval; maximum 120 seconds. Expected
   Compose services must have nonempty running/healthy/started/up containers.
   HTTP probes allow HTTP(S), reject URL userinfo, use bounded timeouts and return
   only status/boolean, with no authentication headers/cookies or response body.
   Read-scoped callers can explicitly probe the target server's internal HTTP
   services; grant read access with this network reachability in mind. Redirects
   are not followed. A successful save/container state does not prove full
   application functionality; test real endpoints as appropriate.

`stack_logs` returns at most 1000 lines (default 200), bounded to 1 MiB and a
10-second Docker call. `grep` is a literal substring. Optional `waitSeconds`
collects new output before the snapshot (0–10 seconds; default 0, use 2 for the
CLI default collection window). Poll with returned `since`
for follow-equivalent finite snapshots; timestamp overlap can duplicate lines,
so deduplicate as needed. `offset` selects within one bounded snapshot and is not
a durable cursor across rolling log tails. Logs require secrets scope.

`get_guide` and the `dockge://guide` resource expose the same concise operating
guide to agents. Tool descriptions state side effects and prerequisite scopes.

## Complete dockgectl 0.2.6 mapping

This inventory covers the CLI at `1176582`, including client-only commands.
Formatting (`-o json/yaml/table`), shell completion and command help become MCP
schemas, structured results, descriptions and the guide.

| CLI command / option | Native MCP or connection equivalent |
| --- | --- |
| `version` | `doctor.version` (server), MCP initialize `serverInfo.version`; no separate client version |
| `doctor` | `doctor`, `whoami`, `agent_list`; client connection/TLS checked by MCP client |
| `composerize` | `composerize {command, endpoint}`; never executes the command |
| `agent list` | `agent_list`; endpoints/names only, no credential disclosure or eager connection |
| `auth login` | Create key in authenticated Security UI, set client Bearer header |
| `auth status` | `whoami`; `doctor` for target connectivity |
| `auth logout` | Remove client Bearer header; revoke key in Security to invalidate all clients |
| `auth forget-password` | Remove locally saved client credentials; use existing Dockge password recovery for account access |
| `config set-url`, `config get` | MCP client remote URL/headers; `whoami` describes current authorization |
| `config set-endpoint` | Per-tool `endpoint`; empty string selects local server |
| `config set-tls-verify` | MCP client's TLS validation policy; keep validation enabled |
| `config profile list/add/use/current/remove` | MCP client's named server connections; no meaningless server-side local profile files |
| `stack list` | `stack_list` |
| `stack list --all-endpoints` | `stack_list {allEndpoints:true}` with independent per-endpoint failures |
| `stack get` | `stack_get`; raw CLI content via explicit `includeSecrets:true` |
| `stack ps` | `stack_ps`; safe runtime state without raw stack embed |
| `stack logs --tail/--grep/--wait/--follow` | `stack_logs {tail,grep,waitSeconds,since,offset}`; bounded snapshots, optional collection window (CLI default `--wait 2` → `waitSeconds:2`), poll `since` instead of unbounded stream |
| `stack plan -f --env-file` | `stack_plan {composeYAML,composeENV}`; client supplies file contents, omitted env preserves |
| `stack diff` | `stack_diff`; exact structural paths + env key deltas; no raw values by default |
| `stack diff --include-env-values` | `stack_diff {includeValues:true}` with secrets scope; includes both document values |
| `stack save` | `stack_save` with revision, exact allowlist, env-change permission and overwrite confirmation |
| `stack deploy` | `stack_deploy`; same gates, optional current Compose deployment |
| `stack save/deploy --dry-run` | `stack_plan`; no file changes |
| `stack save/deploy --yes` | `confirm:true` plus destructive scope for existing stacks |
| `stack apply --mode save/deploy` | `stack_apply {mode:"save"/"deploy"}` |
| `stack apply --dry-run` | `stack_plan` |
| `stack apply --verify/--no-verify` | `stack_apply {verify:true/false}`; persistence readback always enforced |
| `stack apply --health-url/--timeout/--interval` | `healthUrl`, `timeoutSeconds`, `pollSeconds`; standalone `stack_verify` for read-only recovery |
| `stack start/stop/restart/update/down/delete` | `stack_action {action,...}`; expected revision always, destructive+confirm for stop/down/delete |
| `service status` | `service_status` |
| `service status --all-endpoints` | `service_status {allEndpoints:true}` |
| `service start/stop/restart` | `service_action {service,action,...}`; stop needs destructive+confirm |
| `network list` | `network_list` |
| Global `--endpoint`, `DOCKGECTL_ENDPOINT` | Explicit per-tool `endpoint` |
| `DOCKGECTL_PROFILE`, URL/auth/TLS environment config | Named remote connection in MCP client, never server filesystem config |

The CLI exposes agent inventory only. Agent add/rename/remove remain existing web
controls; no client CLI capability is omitted by keeping those outside MCP.

## Validation and compatibility

Run `npm run test:backend`, `npm run check-ts` and `npm run build:frontend` with the
project's Node 22 runtime. Tests use the official SDK client over real loopback
HTTP, real SQLite key lifecycle, and controlled business mocks for change gates,
env persistence, locks, timeouts and secret-safe responses. Existing multi-agent
and web handlers remain in place; forwarding uses one authenticated internal
agent event. Remote nodes must run this fork version to support the new event;
old nodes fail without fallback.

SDK source reference: [official TypeScript SDK v1.x](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).
The pinned 1.x SDK targets existing 2025 Streamable HTTP clients and receives
maintenance updates; the independently packaged v2 SDK is not required here.
