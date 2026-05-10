# User Pages — `/` and `/dashboard`

Pages accessible to authenticated normal users (`role=normal`). Admin users land on `/admin` instead.

See [architecture.md](./architecture.md) for layout details and RPC client conventions.

---

## `/` — Landing Page

**Redirect logic:**
- Session = admin → `/admin/users`
- Session = normal → `/dashboard`
- No session → render landing page (do NOT redirect to `/login`)

**UI (static, server component):**
```
Hero: "Dyadia — Nền tảng học tập chủ động qua video bài giảng"
      [Đăng nhập]  [Đăng ký]

Features:
  📹 Video bài giảng tương tác
  🤖 Câu hỏi tự động từ AI
  📊 Theo dõi tiến trình học tập

Footer: © 2026 Dyadia
```

**Files:** `src/app/page.tsx`

---

## `/register` — Register

| | |
|---|---|
| **Auth** | Public (no login required) |
| **RPC** | `UserService.RegisterUser` |
| **Redirect** | On success → `/login` + message "Tài khoản đang chờ kích hoạt" |

**Form fields:**
- Email
- Password (≥ 8 characters)
- Last name
- First name

**Note:** Newly registered users have `status=PENDING` — cannot log in until an admin activates the account.

**Files:**
- `src/app/register/page.tsx`
- `src/components/register-form.tsx` — `"use client"`, `useActionState(registerUser)`
- `src/app/actions/auth.ts` — add `registerUser()` action

---

## `/dashboard` — Home after login

| | |
|---|---|
| **Auth** | `requireAnyUser()` |
| **RPC** | `OrganizationMemberService.ListUserMemberships` (userId, limit=5) |
| **Then** | `OrganizationService.GetOrganizationById` for each membership (parallel `Promise.all`) |

**UI:**
```
Xin chào, Nguyễn Văn A! 👋

[ Tổ chức của tôi ]          [ Hồ sơ ]
  3 tổ chức                    Cập nhật thông tin

─── Tổ chức gần đây ───────────────────────
│ HUST AI Lab    │ Giảng viên  │ Hoạt động │  →
│ Dyadia Dev     │ Học viên    │ Hoạt động │  →
│ Research Group │ Chủ sở hữu │ Đã mời    │  →
─────────────────────────────────────────────
                          [Xem tất cả →]
```

**Files:** `src/app/dashboard/page.tsx`

---

## `/dashboard/profile` — Personal Profile

| | |
|---|---|
| **Auth** | `requireAnyUser()` |
| **RPC read** | `UserService.GetUserById(session.claims.sub)` |
| **RPC write** | `UserService.UpdateUserProfile`, `UserService.UpdateUserPassword` |

**UI — 2 sections:**

**Section 1: Personal info**
```
[  VÂ  ]  ← Avatar (initials)
Nguyễn Văn A
user@dyadia.local
[Hoạt động]  [Thường]

Form: Last name* | Middle name | First name*     [Save changes]
```

**Section 2: Change password**
```
New password*      ________
Confirm password*  ________
                  [Change password]
```

**Server actions (`src/app/actions/me.ts`):**
```ts
// Different from actions/users.ts (which uses requireAdmin)
// me.ts uses requireSession() and only allows editing own profile
export async function updateMyProfile(_state, formData): Promise<ActionState>
export async function updateMyPassword(_state, formData): Promise<ActionState>
```

**Files:**
- `src/app/dashboard/profile/page.tsx`
- `src/app/dashboard/profile/edit-profile-form.tsx`
- `src/app/dashboard/profile/edit-password-form.tsx`
- `src/app/actions/me.ts`

---

## `/dashboard/organizations` — My Organizations

| | |
|---|---|
| **Auth** | `requireAnyUser()` |
| **RPC** | `ListUserMemberships(userId, limit=20, offset)` → then `GetOrganizationById` parallel |

**UI:**
```
Tổ chức của tôi                              [Page 1]

┌───────────────────────────────────────────────────┐
│ Name              │ Role        │ Status     │ ... │
│ HUST AI Lab       │ Giảng viên  │ Hoạt động  │  →  │
│ Dyadia Dev Team   │ Học viên    │ Hoạt động  │  →  │
│ Research Group    │ Chủ sở hữu │ Đã mời     │  →  │
└───────────────────────────────────────────────────┘
```

**Files:** `src/app/dashboard/organizations/page.tsx`

---

## `/dashboard/organizations/[slug]` — Org Detail

| | |
|---|---|
| **Auth** | `requireOrgMember(org.id)` — must be an active member |
| **RPC** | `GetOrganizationBySlug(slug)`, `GetOrganizationMember(orgId, userId)` |

**UI:**
```
← Tổ chức của tôi

HUST AI Lab
/hust-ai-lab    [Hoạt động]

Thông tin chung:
  Ngày tạo: 01/01/2026

Vai trò của bạn:
  [Giảng viên]  [Hoạt động]
  Tham gia: 15/03/2026
```

**Files:** `src/app/dashboard/organizations/[slug]/page.tsx`

---

## Implementation Order

1. `src/app/page.tsx` — landing page + redirect logic
2. `/register` — register form + `registerUser()` action
3. `/dashboard` layout + sidebar
4. `/dashboard` home page — welcome + recent memberships
5. `/dashboard/profile` — profile view + edit forms + `me.ts` actions
6. `/dashboard/organizations` — list memberships
7. `/dashboard/organizations/[slug]` — org detail for members
