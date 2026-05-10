# Organization Member Service — Permission Matrix

`richter.v1.OrganizationMemberService`

## Endpoints

Ký hiệu: `✓` được phép · `✗` bị từ chối · `SELF` chỉ được với resource của chính mình (`claims.sub == request.user_id`) · `–` không áp dụng

| Operation | ANON | USER | ORG_STUDENT | ORG_TEACHER | ORG_ADMIN | ORG_OWNER | SYS_ADMIN |
|-----------|:----:|:----:|:-----------:|:-----------:|:---------:|:---------:|:---------:|
| `AddOrganizationMember` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| `GetOrganizationMember` | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ListOrganizationMembers` | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ListUserMemberships` | ✗ | ✗ | SELF | SELF | SELF | SELF | ✓ |
| `UpdateOrganizationMemberRole` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| `UpdateOrganizationMemberStatus` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| `RemoveOrganizationMember` | ✗ | ✗ | SELF | SELF | ✓ | ✓ | ✓ |

## Notes

- **`ListUserMemberships`**: `USER` không phải org member cũng không được gọi. Chỉ bản thân (`claims.sub == request.user_id`) hoặc `SYS_ADMIN`.
- **`UpdateOrganizationMemberRole`**: `ORG_ADMIN` không được thay đổi role của `ORG_OWNER`. Chỉ `ORG_OWNER` hoặc `SYS_ADMIN` mới thay đổi được role của owner.
- **`RemoveOrganizationMember`**: `ORG_ADMIN` không được remove `ORG_OWNER`. `ORG_STUDENT`/`ORG_TEACHER` chỉ được tự remove mình khỏi org.
