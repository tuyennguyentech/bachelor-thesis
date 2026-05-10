# User Service — Permission Matrix

`richter.v1.UserService`

## Endpoints

Ký hiệu: `✓` được phép · `✗` bị từ chối · `SELF` chỉ được với resource của chính mình (`claims.sub == request.id`) · `–` không áp dụng

| Operation | ANON | USER | SELF | SYS_ADMIN | Ghi chú |
|-----------|:----:|:----:|:----:|:---------:|---------|
| `RegisterUser` | ✓ | ✓ | – | ✓ | Public self-registration; role=NORMAL, status=PENDING |
| `CreateUser` | ✗ | ✗ | – | ✓ | |
| `CreateUserWithRoleAndStatus` | ✗ | ✗ | – | ✓ | |
| `GetUserById` | ✗ | ✓ | ✓ | ✓ | Authenticated users xem được profile cơ bản |
| `GetUserByEmail` | ✗ | ✗ | ✓ | ✓ | |
| `ListUsers` | ✗ | ✗ | – | ✓ | |
| `UpdateUserProfile` | ✗ | ✗ | ✓ | ✓ | |
| `UpdateUserPassword` | ✗ | ✗ | ✓ | ✓ | |
| `UpdateUserRole` | ✗ | ✗ | ✗ | ✓ | |
| `UpdateUserStatus` | ✗ | ✗ | ✗ | ✓ | |
| `DeleteUser` | ✗ | ✗ | ✗ | ✓ | |

## Notes

- `GetUserById`: USER chỉ xem được thông tin public (tên, email). Thông tin nhạy cảm hơn (role, status) chỉ trả về cho SELF hoặc SYS_ADMIN — có thể implement bằng cách filter fields trong response.
- `UpdateUserPassword`: cần verify current password trước khi đổi (trừ SYS_ADMIN).
