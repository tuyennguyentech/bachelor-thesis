# Auth Service — Permission Matrix

`richter.v1.AuthService`

## Endpoints

Ký hiệu: `✓` được phép · `✗` bị từ chối

| Operation | ANON | USER | SYS_ADMIN | Ghi chú |
|-----------|:----:|:----:|:---------:|---------|
| `Login` | ✓ | ✓ | ✓ | Public endpoint |
| `RefreshToken` | ✓ | ✓ | ✓ | Tự auth bằng refresh token trong request body |
| `Logout` | ✓ | ✓ | ✓ | Tự auth bằng refresh token trong request body |

## Notes

- `Login`, `RefreshToken`, `Logout` không yêu cầu `Authorization` header — JWT interceptor phải skip các endpoint này.
- `Logout` và `RefreshToken` xác thực thông qua refresh token trong body: token không hợp lệ → `CodeUnauthenticated`.
