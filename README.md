# HalalFoods Finance v2 — Backend

Node + Express + TypeScript + Mongoose. Multi-tenant: one master Mongo for users/roles/companies, three per-company Mongos for operational data.

## Quickstart

```bash
cd be
cp .env.example .env
# Fill in: ENCRYPTION_KEY (64 hex), JWT_SECRET, MASTER_MONGO_URI, TENANT_*_MONGO_URI, seed users
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # encryption key
npm install
npm run seed       # creates 3 companies, permissions, default roles, seed users
npm run dev        # http://localhost:4000/api/health
```

## Architecture

- `src/config/env.ts` — Zod-validated env. Process exits on bad config.
- `src/db/master.ts` — Master Mongo connection (singleton).
- `src/db/tenant.ts` — Per-company connection pool. Connections opened lazily on first `X-Company` use; URIs decrypted from the Company doc. Eviction on config rotation.
- `src/lib/crypto.ts` — AES-256-GCM. Used to encrypt SAP password and tenant Mongo URI at rest.
- `src/lib/jwt.ts` — HS256 session tokens. `jti` matches AuthSession id for instant revocation.
- `src/lib/audit.ts` — Append-only, hash-chained master audit log. Every mutation routes through here.
- `src/middleware/auth.ts` — httpOnly cookie → JWT → AuthSession lookup → user active check.
- `src/middleware/csrf.ts` — Double-submit token: non-httpOnly cookie + `X-CSRF-Token` header on mutations.
- `src/middleware/tenant.ts` — `X-Company` header → resolves UserCompanyAccess → builds permission set.
- `src/middleware/rbac.ts` — `requirePermission('users.create')` etc. Operation-based, not tab-based.

## Routes (all mounted under `/api`)

| Path                            | Auth                | Notes                                        |
| ------------------------------- | ------------------- | -------------------------------------------- |
| `POST /auth/login`              | rate-limited        | Sets session + CSRF cookies                  |
| `POST /auth/logout`             | required            |                                              |
| `GET  /auth/me`                 | required            | + permissions[] when `X-Company` is set      |
| `PATCH /auth/me`                | required            | name, language                               |
| `POST /auth/me/password`        | required, limited   |                                              |
| `GET/POST/PATCH /users[/:id]`   | + permission        | `users.view/create/update`                   |
| `POST /users/:id/deactivate`    | + permission        | `users.deactivate`                           |
| `POST /users/:id/reset-password`| + permission        | `users.reset_password`                       |
| `GET/POST/PATCH/DELETE /roles`  | + permission        | `roles.*`                                    |
| `GET /permissions`              | + permission        | `permissions.view`                           |
| `GET/POST/PATCH /companies`     | + permission        | `companies.*`                                |
| `POST /companies/:k/rotate-sap` | + permission        | `companies.rotate_sap_creds`                 |
| `GET/POST/PATCH /access`        | + permission        | UserCompanyAccess management                 |
| `GET /audit`                    | + permission        | `audit.view`                                 |

## Notes

- Super-admins (`User.isSuperAdmin = true`) bypass per-company permission checks.
- Roles can be templates (`companyKey: null`) or per-company. Seeds create per-company `Owner` and `Accountant` system roles for paris/bordeaux/lyon.
- Tenant operational models will live under `src/models/tenant/...` once we layer in payments / Z-reports / bank reconciliation.
