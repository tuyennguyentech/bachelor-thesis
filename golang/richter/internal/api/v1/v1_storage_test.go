//go:build integ

package v1

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/samber/do/v2"
)

func TestStorageAuthz(t *testing.T) {
	t.Parallel()
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	adminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url)
	adminModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url)
	adminLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url)

	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

	nonMemberEmail, nonMemberPass, _ := createActiveUser(t, adminUsers)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)

	// create org (owner becomes OWNER automatically)
	orgRes, err := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(ownerToken), url).
		CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
		})
	if err != nil {
		t.Fatalf("setup: create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER},
		{studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := adminMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("setup: add member: %v", err)
		}
	}

	courseRes, err := adminCourses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("setup: create course: %v", err)
	}
	modRes, err := adminModules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create module: %v", err)
	}
	lessonRes, err := adminLessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create lesson: %v", err)
	}
	lessonID := lessonRes.Lesson.Id
	validKey := "lessons/" + lessonID + "/video.mp4"

	storageAnon := richterv1connect.NewStorageServiceClient(http.DefaultClient, url)
	storageOwner := richterv1connect.NewStorageServiceClient(httpClientWithToken(ownerToken), url)
	storageTeacher := richterv1connect.NewStorageServiceClient(httpClientWithToken(teacherToken), url)
	storageStudent := richterv1connect.NewStorageServiceClient(httpClientWithToken(studentToken), url)
	storageNonMember := richterv1connect.NewStorageServiceClient(httpClientWithToken(nonMemberToken), url)

	// --- GetUploadUrl ---
	t.Run("GetUploadUrl", func(t *testing.T) {
		req := &richterv1.GetUploadUrlRequest{
			Key: validKey, ContentType: "video/mp4", ExpiresInSeconds: 3600,
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageAnon.GetUploadUrl(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageNonMember.GetUploadUrl(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageStudent.GetUploadUrl(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := storageTeacher.GetUploadUrl(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := storageOwner.GetUploadUrl(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("InvalidKey/InvalidArgument", func(t *testing.T) {
			badReq := &richterv1.GetUploadUrlRequest{
				Key: "not/a/lesson/key", ContentType: "video/mp4", ExpiresInSeconds: 3600,
			}
			assertCode(t, func() error { _, e := storageTeacher.GetUploadUrl(ctx, badReq); return e }(), connect.CodeInvalidArgument)
		})
		t.Run("PathTraversal/InvalidArgument", func(t *testing.T) {
			badReq := &richterv1.GetUploadUrlRequest{
				Key: "lessons/../etc/passwd", ContentType: "video/mp4", ExpiresInSeconds: 3600,
			}
			assertCode(t, func() error { _, e := storageTeacher.GetUploadUrl(ctx, badReq); return e }(), connect.CodeInvalidArgument)
		})
	})

	// --- GetDownloadUrl (lessons/ path) ---
	t.Run("GetDownloadUrl", func(t *testing.T) {
		req := &richterv1.GetDownloadUrlRequest{Key: validKey, ExpiresInSeconds: 3600}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageAnon.GetDownloadUrl(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageNonMember.GetDownloadUrl(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := storageStudent.GetDownloadUrl(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := storageTeacher.GetDownloadUrl(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetDownloadUrl (seed/ path) ---
	// Seed keys use seed/<org-slug>/<path> format; org members can download them.
	t.Run("GetDownloadUrl/SeedPath", func(t *testing.T) {
		orgSlug := orgRes.Organization.Slug
		seedKey := "seed/" + orgSlug + "/demo/intro.mp4"
		req := &richterv1.GetDownloadUrlRequest{Key: seedKey, ExpiresInSeconds: 3600}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageAnon.GetDownloadUrl(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := storageNonMember.GetDownloadUrl(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := storageStudent.GetDownloadUrl(ctx, req); err != nil {
				t.Errorf("expected OK for seed key, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := storageTeacher.GetDownloadUrl(ctx, req); err != nil {
				t.Errorf("expected OK for seed key, got %v", err)
			}
		})
		t.Run("InvalidSeedKey/InvalidArgument", func(t *testing.T) {
			badReq := &richterv1.GetDownloadUrlRequest{Key: "seed/", ExpiresInSeconds: 3600}
			assertCode(t, func() error { _, e := storageTeacher.GetDownloadUrl(ctx, badReq); return e }(), connect.CodeInvalidArgument)
		})
	})

	// Verify upload URL uses public_endpoint (not internal storage endpoint) AND is reachable.
	// This catches misconfigured public_endpoint (e.g. using a container-only hostname like "caddy"
	// that a real host browser cannot reach).
	t.Run("GetUploadUrl/URL_uses_public_endpoint_and_is_reachable", func(t *testing.T) {
		s3cfg, err := do.Invoke[*cfg.S3Cfg](internal.Injector)
		if err != nil {
			t.Fatalf("get s3cfg: %v", err)
		}
		res, err := storageTeacher.GetUploadUrl(ctx, &richterv1.GetUploadUrlRequest{
			Key: validKey, ContentType: "video/mp4", ExpiresInSeconds: 3600,
		})
		if err != nil {
			t.Fatalf("GetUploadUrl: %v", err)
		}
		if !strings.HasPrefix(res.UploadUrl, s3cfg.PublicEndpoint) {
			t.Errorf("upload URL %q does not start with public_endpoint %q — internal endpoint leaked", res.UploadUrl, s3cfg.PublicEndpoint)
		}
		// PUT a small payload to the presigned URL to verify it is actually reachable.
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, res.UploadUrl, strings.NewReader("dummy"))
		if err != nil {
			t.Fatalf("build PUT request: %v", err)
		}
		req.Header.Set("Content-Type", "video/mp4")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("PUT to upload URL failed — public_endpoint %q unreachable: %v", s3cfg.PublicEndpoint, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			t.Errorf("PUT to upload URL returned HTTP %d, want 2xx", resp.StatusCode)
		}
	})

	_ = adminOrgs
}
