# API contract (frontend)

Freeze this shape for the current content slice. Do not change it mid-slice without a team notice.

Base URL (local): `http://localhost:4000`  
Prefix: `/api/v1`

## Request ID

- Client may send `x-request-id`.
- If missing, the API generates one.
- The same value is returned on the response as `x-request-id`.
- Errors include the same value as `requestId` in the JSON body.

## Error body

All failed HTTP responses use this JSON:

```json
{
  "statusCode": 401,
  "message": "Missing access token.",
  "error": "Unauthorized",
  "requestId": "f4272af4-99e4-41ff-8126-7ce35c5f9601",
  "path": "/api/v1/me",
  "timestamp": "2026-09-15T12:38:26.229Z"
}
```

Notes:

- `message` may be a string or a string array (validation errors).
- `statusCode` matches the HTTP status.
- Treat missing/invalid Bearer tokens as `401`.
- Treat cross-workspace or unauthorized workspace access as `403` or `404` depending on the route (do not leak other tenants).

## Auth header

Protected routes require:

```http
Authorization: Bearer <accessToken>
```

Optional workspace override:

```http
x-workspace-id: <workspaceId>
```

If omitted, the API uses the user's saved `current_workspace_id` (after workspace switch).

## Frozen routes for this slice

### Public

| Method | Path                           | Notes                             |
| ------ | ------------------------------ | --------------------------------- |
| GET    | `/api/v1/health`               | Live check                        |
| GET    | `/api/v1/health/ready`         | Integration readiness             |
| GET    | `/api/v1/jobs/inngest`         | Inngest handshake (still skipped) |
| POST   | `/api/v1/auth/login`           | Email/password via Supabase Auth  |
| GET    | `/api/v1/auth/oauth/health`    | Social login readiness            |
| GET    | `/api/v1/auth/oauth/:provider` | `google` or `facebook`            |
| POST   | `/api/v1/auth/oauth/callback`  | Body: `{ "accessToken": "..." }`  |

### Identity and workspaces (Bearer required)

| Method | Path                        | Notes                                  |
| ------ | --------------------------- | -------------------------------------- |
| GET    | `/api/v1/me`                | Current user + active workspace        |
| GET    | `/api/v1/workspaces`        | Memberships only; includes `isCurrent` |
| POST   | `/api/v1/workspaces/switch` | Body: `{ "workspaceId": "..." }`       |

### Brand brief (Bearer required)

| Method | Path                  | Notes                                     |
| ------ | --------------------- | ----------------------------------------- |
| GET    | `/api/v1/brand-brief` | Current workspace brief, or `404` if none |
| PUT    | `/api/v1/brand-brief` | Create or update current workspace brief  |

PUT body:

```json
{
  "name": "Pilot Alpha",
  "tone": "clear and direct",
  "approvedFacts": "Ships in 19 working days.",
  "prohibitedClaims": "Do not promise unlimited scale."
}
```

`name` is required. Other fields are optional strings.

### Content (Bearer required)

| Method | Path                         | Notes                                                     |
| ------ | ---------------------------- | --------------------------------------------------------- |
| POST   | `/api/v1/content/requests`   | Create generation job + draft; supports `Idempotency-Key` |
| GET    | `/api/v1/content/jobs/:id`   | Job status for current workspace                          |
| GET    | `/api/v1/content/drafts`     | Draft list for current workspace                          |
| GET    | `/api/v1/content/drafts/:id` | One draft for current workspace                           |

### Providers / social / ads (current tip)

These exist for health and stub connection flows. Marketing social and ads are still stubs for live OAuth/API exchange. Prefer:

- `GET /api/v1/providers/health`
- Social under `/api/v1/social/...`
- Ads under `/api/v1/ads/...`

Login (Google/Facebook) is not the same as marketing channel connection (Instagram / LinkedIn / X / Facebook Page).

## Frontend typing tips

1. Always read `x-request-id` from responses for support logs.
2. On non-2xx, parse the error body above; do not assume a different envelope.
3. Send the Bearer token on every protected call.
4. After `POST /workspaces/switch`, later calls can omit `x-workspace-id` and still use the switched workspace.
