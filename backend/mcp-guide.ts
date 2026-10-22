/** One static guide is shared by both the MCP resource and get_guide tool. */
export const mcpGuide = `# Dockge remote MCP

Connect using Streamable HTTP at /mcp and Authorization: Bearer <API key>.
Remote access requires DOCKGE_MCP_ALLOWED_HOSTS to include the requested hostname;
the default permits loopback hosts only. The reverse proxy must preserve Host.
Create, expire or revoke keys in Settings > Security using an authenticated web session.
No Python, CLI, local profile, OAuth or Authentik is required.

Scopes: read for inspection; write for mutations; destructive for overwrites,
stop/down/delete and service stop; secrets for raw Compose/.env, logs, valued diffs
and composerize. Every HTTP request rechecks key expiry, revocation and active user.
API keys are shown once; list and identity tools never reveal them or agent credentials.

Use agent_list to select endpoint. Empty endpoint explicitly means this server.
Only the selected node connects; failure never falls back locally. allEndpoints
explicitly queries all nodes and reports independent failures.

Safe changes:
1. stack_get returns metadata/revision; includeSecrets=true only when content is needed.
2. stack_plan with desired composeYAML and optional composeENV returns exact changed
   paths and current revision. Paths are arrays, e.g. ["services","web","image"].
3. Approve only task-specific paths. Supply expectedRevision, allowedPaths and
   confirm=true for overwrites. Env edits require allowEnvChange=true.
4. stack_apply defaults to deploy + verify; mode=save persists without deploying.
   Omitted composeENV preserves existing .env; explicit empty string clears it.
5. Inspect persistence, service state and optional health result. health=null means
   no HTTP probe. Health URLs are actively fetched from the selected server with
   read permission; this can reach its internal HTTP services. No authentication
   headers/cookies or response bodies are forwarded and redirects are not followed.
   A successful save does not prove workload or application health.

Never retry ambiguous write timeouts. outcomeUnknown means the operation may still
be running. Use stack_get/stack_verify/service_status/logs first; only start another
mutation after establishing its result. Stale revisions fail before mutation.
Lifecycle and service actions also take the current stack revision.

stack_logs returns finite bounded snapshots. Poll since (ISO timestamp) for
follow-equivalent behavior; offset selects within one snapshot and is not a durable
rolling cursor. Optional waitSeconds (0–10, default 0) collects output before a
snapshot; use 2 for the CLI default wait. Tail is limited to 1000 lines. Poll responses can
overlap when timestamps or the bounded buffer overlap; deduplicate as appropriate.
Log and raw content tools require secrets scope; avoid copying their output into
chats, task logs or reports. Structural plans/diffs do not return values by default.

Client URL/TLS/profiles and login/logout are connection configuration: set URL and
Bearer header in your MCP client, validate TLS, switch endpoint per tool, remove the
client header to logout, revoke the key in Security to invalidate it everywhere.
`;
