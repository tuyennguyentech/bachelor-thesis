# Organization Service — Permission Matrix

`richter.v1.OrganizationService`

## Endpoints

Ký hiệu: `✓` được phép · `✗` bị từ chối · `SELF` chỉ được với resource của chính mình · `–` không áp dụng

| Operation | ANON | USER | ORG_MEMBER | ORG_ADMIN | ORG_OWNER | SYS_ADMIN | Ghi chú |
|-----------|:----:|:----:|:----------:|:---------:|:---------:|:---------:|---------|
| `CreateOrganization` | ✗ | ✓ | – | – | – | ✓ | `created_by` phải bằng `claims.sub` |
| `GetOrganizationById` | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `GetOrganizationBySlug` | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `ListOrganizations` | ✗ | ✗ | – | – | – | ✓ | Admin-only: xem tất cả orgs trong hệ thống |
| `ListOrganizationsByUser` | ✗ | SELF | – | – | – | ✓ | USER chỉ list orgs của chính mình |
| `UpdateOrganization` | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | |
| `UpdateOrganizationStatus` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | |
| `DeleteOrganization` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | |

## Notes

- **`CreateOrganization`**: Sau khi insert org thành công, phải insert `organization_members(org_id, user_id=created_by, role=OWNER, status=ACTIVE)` trong cùng transaction. Xem [overview.md — Special Rules](./overview.md).
- **`ListOrganizationsByUser`**: `USER` được phép gọi nhưng `request.user_id` phải bằng `claims.sub`. Nếu khác → `CodePermissionDenied`.
- **`UpdateOrganizationStatus`**: `ORG_ADMIN` không có quyền — chỉ owner hoặc system admin mới được suspend/archive org.
