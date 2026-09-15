# Operation System — Backend

NestJS 11 API for the AI Marketing & Sales platform. Express adapter, TypeScript, Prisma, Supabase, and Inngest.

## Setup

```bash
npm install
cp .env.example .env
```

Put the real database password into `DATABASE_URL` in `.env` (replace `YOUR_PASSWORD`). Then:

```bash
npm run start:dev
```

API listens on [http://localhost:4000](http://localhost:4000). Next.js stays on port 3000.

## Health

- `GET /api/v1/health` → `{ "status": "ok" }`
- `GET /api/v1/health/ready` → `database` and `supabase` are `ok` when credentials work; `inngest` stays `skipped`
- `GET /api/v1/jobs/inngest` → placeholder; no events are sent

## Scripts

```bash
npm run start:dev
npm run build
npm run lint
npm run test
npm run test:e2e
npm run prisma:generate
```

## API contract

Frontend-facing error shape, `x-request-id`, and the frozen route list for this slice live in [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). Keep that document stable mid-slice.

## Next

Wire Storage and Inngest functions after the content slice is live on the frontend.
