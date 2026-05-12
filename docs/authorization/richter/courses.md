# Authorization — Courses, Modules, Lessons

## Role Matrix

Legend: ✓ allowed | ✗ denied | – not applicable

### CourseService

| Operation | Anon | Student | Teacher | OrgAdmin | Owner | SysAdmin |
|-----------|------|---------|---------|----------|-------|----------|
| CreateCourse | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| GetCourseById | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ListCourses | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| UpdateCourse (title/desc) | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| **UpdateCourseStatus** | ✗ | ✗ | **✗** | ✓ | ✓ | ✓ |
| **DeleteCourse** | ✗ | ✗ | **✗** | ✓ | ✓ | ✓ |

> `UpdateCourseStatus` and `DeleteCourse` are restricted to ADMIN/OWNER only.
> Teachers can edit course content but cannot publish/archive/delete a course.

### CourseModuleService

| Operation | Anon | Student | Teacher | OrgAdmin | Owner | SysAdmin |
|-----------|------|---------|---------|----------|-------|----------|
| CreateCourseModule | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| GetCourseModuleById | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ListCourseModules | ✗ | ✓¹ | ✓ | ✓ | ✓ | ✓ |
| UpdateCourseModule | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| DeleteCourseModule | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |

¹ ListCourseModules is allowed for any authenticated user (non-member OK).

### LessonService

| Operation | Anon | Student | Teacher | OrgAdmin | Owner | SysAdmin |
|-----------|------|---------|---------|----------|-------|----------|
| CreateLesson | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| GetLessonById | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ListLessons | ✗ | ✓¹ | ✓ | ✓ | ✓ | ✓ |
| ListLessonsByCourse | ✗ | ✓¹ | ✓ | ✓ | ✓ | ✓ |
| UpdateLesson | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| DeleteLesson | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |

¹ List operations allowed for any authenticated user (non-member OK).

---

## Frontend Enforcement

### Dashboard course detail (`/dashboard/organizations/[slug]/courses/[courseId]`)

Two separate flags control UI visibility:

```ts
const CAN_MANAGE = [OWNER, ADMIN, TEACHER];     // edit title, manage modules/lessons
const CAN_CHANGE_STATUS = [OWNER, ADMIN];        // status select + delete button
```

- `canManage` → shows "Thông tin chung" (edit form), "Thêm chương", module/lesson actions
- `canChangeStatus` → shows `CourseStatusSelect` dropdown and "Xóa khóa học" danger zone
- Students see course content (modules/lessons) read-only only

### Key design decision

Teachers are content authors — they create and edit course content.
Course lifecycle (draft → published → archived) and deletion are admin-level operations
to prevent accidental publishing or permanent data loss.
