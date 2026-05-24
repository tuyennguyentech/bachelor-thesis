<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Next.js 16 Rules

- Middleware is `src/proxy.ts` exporting `proxy()`, not `middleware.ts` / `middleware()`.
- `startTransition` callback must return `void`; wrap server actions as `startTransition(async () => { await action(); })`.
- `<form action={fn}>` only accepts `(formData: FormData) => void | Promise<void>`. State-returning actions must be called through a client component with `useActionState`.
- Do not set cookies from Server Component rendering. Silent refresh belongs in `src/proxy.ts`; `src/lib/auth.ts` should remain read-only for session inspection.

## Heino Conventions

- Server RPC: `src/lib/connect-client.ts`, reads `RICHTER_BASE_URL`, uses Node HTTP/2.
- Browser RPC: `useRichterWebClient()` from `src/lib/connect-webclient.ts`, reads `NEXT_PUBLIC_RICHTER_BASE_URL`.
- Auth cookies: `dyadia_access` and `dyadia_refresh`, httpOnly, sameSite lax.
- Auth helpers: `getSession()` cached per render, `requireAdmin()`, `requireAnyUser()`, `requireOrgMember(orgId, ...roles)`.
- JWT claims use snake_case protobuf JSON names; `role` is `1` normal and `2` admin.
- Proto imports use workspace alias, for example `import { UserService, UserRole } from "buf/gen/richter/v1/users_pb"`.
- Enum members use short names like `UserRole.ADMIN`, not generated prefix names.
- Pagination uses `number` `limit`/`offset`; `hasNext = rows.length === LIMIT` because responses generally do not include totals.
- Use shadcn/ui components via the shadcn CLI from this directory when adding UI primitives; installed components include button, input, label, badge, dialog, alert-dialog, select, table, avatar, skeleton, dropdown-menu, card, separator, field.

## Playwright Notes

- E2E baseURL is Caddy `http://localhost` on port 80, not `localhost:3000`.
- Run Playwright through `./scripts/setup/environment.dev/container-shell.sh heino -- pnpm --filter heino exec playwright test`.
- Radix `DropdownMenuItem` with `asChild` + `Link` is flaky in Firefox; read the `href` attribute instead of relying on click navigation.
- After server actions with `revalidatePath`, wait for the updated UI in-place; do not `page.goto` back just to refresh.
- Use `?q=` search params to find seed records; page 1 may not contain older seeded data.
<!-- END:nextjs-agent-rules -->
