# Heino Frontend Architecture

## Overview

```
Browser → Caddy (reverse proxy) → Heino (Next.js App Router)
                                       ↓ server components
                                   Richter (Connect RPC :8080)
```

- **Server components** call `createRichterClient()` (HTTP/2, `RICHTER_BASE_URL`)
- **Client components** use hook `useRichterWebClient()` (browser, `NEXT_PUBLIC_RICHTER_BASE_URL`)
- Auth state stored in cookies (`dyadia_access`, `dyadia_refresh`) — read server-side via `cookies()`

---

## Route Tree

```
/
├── (public)
│   ├── /                           landing page (redirect if logged in)
│   ├── /login                      login
│   └── /register                   register new account
│
└── (protected — proxy.ts checks cookie)
    ├── /dashboard                  home for normal users (role=normal)
    │   ├── /dashboard/profile      personal profile + change password
    │   └── /dashboard/organizations
    │       ├── /                   list of orgs the user is a member of
    │       └── /[slug]             org detail (view only)
    │
    └── /admin                      admin role only
        ├── /admin/users            user list
        ├── /admin/users/[id]       user detail / edit
        │
        ├── /admin/organizations         organization list
        ├── /admin/organizations/[slug]  org detail / edit
        └── /admin/organizations/[slug]/members   manage org members
```

---

## Layouts

### Root layout (`/app/layout.tsx`)
- Applies ThemeProvider, font
- No navigation (each section has its own layout)

### Admin layout (`/app/admin/layout.tsx`)
- Server component — reads cookie, checks `role=admin`, redirects `/login` if not
- Fixed sidebar with: Users, Organizations
- Header shows admin name + logout button

### Dashboard layout (`/app/dashboard/layout.tsx`)
- Server component — calls `requireAnyUser()`, redirects `/login` if no session
- Sidebar (220px fixed) + header

```
┌───────────────────────────────────────────────────┐
│  Dyadia          Nguyen Van A    [🌙]  [Logout]    │  ← Header
├─────────────┬─────────────────────────────────────┤
│ Dashboard   │                                     │
│ Profile     │           Page content              │
│ Orgs        │                                     │
│             │                                     │
│ (Courses    │                                     │
│  — coming)  │                                     │
└─────────────┴─────────────────────────────────────┘
             Sidebar fixed 220px
```

**Files:**
- `src/app/dashboard/layout.tsx` — server component, `requireAnyUser()`, renders sidebar + header
- `src/components/dashboard/sidebar.tsx` — `"use client"`, uses `usePathname` for active link

---

## Auth Flow

```
Request hits protected route
    ↓
Admin layout / middleware reads dyadia_access cookie
    ↓
Decode JWT (via jose verifyJwt)
    ↓
role != admin → redirect /login?next=[url]
role == admin → render page
    ↓
Token expired during use
    ↓
getSession() silent refresh: calls AuthService.RefreshToken → retries
If refresh fails → redirect /login
```

### 3-tier auth helpers (`src/lib/auth.ts`)

| Helper | Purpose |
|---|---|
| `requireSession()` | Any authenticated user; redirects `/login` if not |
| `requireRole(...roles)` | Specific roles; redirects `/login` if wrong role |
| `requireAdmin()` | Shorthand for `requireRole(UserRole.ADMIN)` |
| `requireOrgMember(orgId)` | Must be active member of that org |

`getSession()` is wrapped in React `cache()` — deduplicates calls within same render pass. Also performs silent token refresh when access token is expired.

---

## RPC Clients

| Client | File | When to use |
|---|---|---|
| `createRichterClient(Service)` | `src/lib/connect-client.ts` | Server components, server actions |
| `createRichterClient(Service, token)` | same | Server actions needing auth header |
| `useRichterWebClient(Service)` | `src/lib/connect-webclient.ts` | Client components (browser) |

Transport is cached per token per request via React `cache()`.

---

## Component Conventions

| Type | When to use | Location |
|---|---|---|
| Server component | initial data fetch, SEO | `page.tsx`, `layout.tsx` |
| Client component | interactive (form, dialog, table actions) | `src/components/` with `"use client"` |
| Server Action | mutation from form | `src/app/actions/` |

- shadcn/ui components in `src/components/ui/`
- Custom components in `src/components/`
- Routes in `src/app/`

## Search Pattern (admin tables)

Exact-match dispatch on unique fields — no full-table scan:
- UUID input → `GetById` (primary key index)
- Email input (contains `@`) → `GetByEmail` (unique index)
- Text input → `GetBySlug` (unique index)

Dispatch logic in Go service layer. Proto request has `optional string query`. Avoids `ILIKE '%...%'` which can't use B-tree indexes.
