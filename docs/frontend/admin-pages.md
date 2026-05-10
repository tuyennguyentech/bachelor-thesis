# Admin Pages — `/admin`

All admin pages require `role=admin`. The admin layout server component handles the auth guard.

See [architecture.md](./architecture.md) for layout details and RPC client conventions.

---

## `/login`

| | |
|---|---|
| **Component** | Client component |
| **Function** | Email + password form, calls `AuthService.Login`, stores tokens in cookies, redirects `/dashboard` |
| **RPC** | `AuthService.Login` |

---

## `/admin/users`

**Purpose:** View and manage all users in the system.

| | |
|---|---|
| **Component** | Server component + client dialog |
| **RPC read** | `UserService.ListUsers` (limit, offset, query — server-side) |
| **RPC write** | `UserService.CreateUserWithRoleAndStatus`, `UserService.UpdateUserStatus`, `UserService.DeleteUser` |

**UI:**
- Table: Avatar | Email | Name | Role | Status | Created | Actions
- Filter bar: search by email/UUID, filter by role (all/normal/admin), filter by status (all/active/pending/disabled)
- Pagination: limit/offset
- **"+ Create user"** button → dialog (email, password, first/last name, role, status)
- Per-row dropdown Actions:
  - **View detail** → navigate `/admin/users/[id]`
  - **Activate / Disable** → `UpdateUserStatus` inline
  - **Delete** → confirm dialog → `DeleteUser`

---

## `/admin/users/[id]`

**Purpose:** View and edit a specific user.

| | |
|---|---|
| **Component** | Server component (load) + client form (edit) |
| **RPC read** | `UserService.GetUserById` |
| **RPC write** | `UserService.UpdateUserProfile`, `UserService.UpdateUserRole`, `UserService.UpdateUserStatus`, `UserService.UpdateUserPassword`, `UserService.DeleteUser` |

**UI sections:**

1. **Profile** — first name, last name, (optional middle name) → `UpdateUserProfile`
2. **Account** — email (read-only), role badge, status badge
   - Change role button (normal ↔ admin) → `UpdateUserRole`
   - Change status button (active/pending/disabled) → `UpdateUserStatus`
3. **Change password** — admin can reset password → `UpdateUserPassword`
4. **Organizations** — list of orgs the user belongs to → `OrganizationMemberService.ListUserMemberships`
5. **Danger zone** — Delete user button → confirm → `DeleteUser` → redirect `/admin/users`

---

## `/admin/organizations`

**Purpose:** View and manage all organizations.

| | |
|---|---|
| **Component** | Server component + client dialog |
| **RPC read** | `OrganizationService.ListOrganizations` (limit, offset, query) |
| **RPC write** | `OrganizationService.CreateOrganization`, `OrganizationService.UpdateOrganizationStatus`, `OrganizationService.DeleteOrganization` |

**UI:**
- Table: Name | Slug | Status | Created | Member count | Actions
- Filter: search by UUID/slug, filter by status (active/suspended/deleted)
- Pagination
- **"+ Create organization"** button → dialog (name, slug, creator — select user)
- Per-row dropdown Actions:
  - **View detail** → navigate `/admin/organizations/[slug]`
  - **View members** → navigate `/admin/organizations/[slug]/members`
  - **Suspend / Activate** → `UpdateOrganizationStatus` inline
  - **Delete** → confirm → `DeleteOrganization`

---

## `/admin/organizations/[slug]`

**Purpose:** View and edit a specific organization.

| | |
|---|---|
| **Component** | Server component + client form |
| **RPC read** | `OrganizationService.GetOrganizationBySlug` |
| **RPC write** | `OrganizationService.UpdateOrganization`, `OrganizationService.UpdateOrganizationStatus`, `OrganizationService.DeleteOrganization` |

**UI sections:**

1. **General info** — name, slug → `UpdateOrganization`
2. **Status** — status badge + Suspend/Activate button → `UpdateOrganizationStatus`
3. **Members (preview)** — list of 5 most recent members, link → `/admin/organizations/[slug]/members`
4. **Danger zone** — Delete org → confirm → `DeleteOrganization` → redirect `/admin/organizations`

---

## `/admin/organizations/[slug]/members`

**Purpose:** Manage all members of an organization.

| | |
|---|---|
| **Component** | Server component + client dialogs |
| **RPC read** | `OrganizationService.GetOrganizationBySlug`, `OrganizationMemberService.ListOrganizationMembers` (limit, offset) |
| **RPC write** | `OrganizationMemberService.AddOrganizationMember`, `OrganizationMemberService.UpdateOrganizationMemberRole`, `OrganizationMemberService.UpdateOrganizationMemberStatus`, `OrganizationMemberService.RemoveOrganizationMember` |

**UI:**
- Breadcrumb: Organizations → [org name] → Members
- Table: Avatar | Email | Name | Role | Status | Joined | Actions
- Filter: search by email, filter by role (owner/admin/teacher/student), filter by status (active/invited/suspended)
- Pagination
- **"+ Add member"** button → dialog (search/select user, select role) → `AddOrganizationMember`
- Per-row dropdown Actions:
  - **Change role** → inline select (owner cannot be changed)
  - **Change status** → inline select
  - **Remove from org** → confirm → `RemoveOrganizationMember`

---

## Implementation Order

1. Admin layout + auth guard
2. `/admin/users` — list + create dialog
3. `/admin/users/[id]` — detail + edit
4. `/admin/organizations` — list + create dialog
5. `/admin/organizations/[slug]` — detail + edit
6. `/admin/organizations/[slug]/members` — members table + add/edit/remove
