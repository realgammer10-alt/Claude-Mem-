# Server API

REST V1 is mounted under `/v1`; legacy worker routes remain under `/api`.

## Worker health endpoints

The local worker exposes `GET /api/health` for liveness,
`GET /api/readiness` for initialization readiness, and `GET /api/stats` for
worker and database statistics. The viewer polls these endpoints every 10
seconds and also reports the live SSE stream connection. A degraded health
response or an initializing worker is shown separately from an unavailable
endpoint.

Available beta endpoints:

- `GET /healthz`
- `GET /v1/info`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/:id`
- `POST /v1/sessions/start`
- `POST /v1/sessions/:id/end`
- `GET /v1/sessions/:id`
- `POST /v1/events`
- `POST /v1/events/batch`
- `GET /v1/events/:id`
- `POST /v1/memories`
- `GET /v1/memories/:id`
- `PATCH /v1/memories/:id`
- `POST /v1/search`
- `POST /v1/context`
- `GET /v1/audit?projectId=<id>`

When `CLAUDE_MEM_AUTH_MODE=api-key`, send `Authorization: Bearer <key>`. Read endpoints require `memories:read`; write endpoints require `memories:write`.

`POST /v1/sessions/start` is idempotent for a given project and
`externalSessionId`. Reusing that identifier with a different normalized
`platformSource` returns `409 Conflict` rather than mixing platforms in one
session.

`POST /v1/memories` accepts an optional `platformSource` for sessionless
manual observations. The value is normalized and returned as
`platformSource` on the memory response. When `serverSessionId` is supplied,
the source must match the attached session or the request returns `409 Conflict`.

## Platform source filtering

Read endpoints that return sessions, events, observations, prompts, search
results, context, or viewer aggregates accept an optional `platformSource`
filter. For `POST /v1/search` and `POST /v1/context`, include it in the JSON
body; legacy viewer filters use the query string. Source aliases are normalized consistently: `claude-code` maps to
`claude`, `codex-cli` and `transcript` map to `codex`, and `cursor-*` maps to
`cursor`. Omitting the filter preserves the complete team/project scope.

## Event generation semantics

`POST /v1/events` accepts two query flags that control observation generation:

- `generate=false` — write the event but do not enqueue a generation job.
- `wait=true` — return the `generationJob` descriptor in the response, so
  callers can poll `GET /v1/jobs/:id` for completion.

Without `wait=true`, the response includes the new event row and a best-
effort `generationJob` field. With `wait=true`, the `generationJob` field is
always populated (or `null` only when generation was explicitly disabled).
The actual provider call happens in a separate BullMQ worker process
(`claude-mem server worker start`); the HTTP path never blocks on a
provider response.
