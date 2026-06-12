package v1

import (
	"net/http"

	"example.com/richter/internal"
	"example.com/richter/internal/svc/ai"
	_ "example.com/richter/internal/svc/aitasks/executors"
	"example.com/richter/internal/svc/auth"
	"example.com/richter/internal/svc/coursemodules"
	"example.com/richter/internal/svc/coursemembers"
	"example.com/richter/internal/svc/courses"
	"example.com/richter/internal/svc/interactions"
	"example.com/richter/internal/svc/lessons"
	"example.com/richter/internal/svc/orgmembers"
	"example.com/richter/internal/svc/organizations"
	"example.com/richter/internal/svc/storage"
	"example.com/richter/internal/svc/users"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewS1Svc),
)

func init() {
	Package(internal.Injector)
}

type V1Svc struct {
	Mux *http.ServeMux
}

func NewS1Svc(i do.Injector) (v1 *V1Svc, err error) {
	authSvc, err := do.Invoke[*auth.AuthSvc](i)
	if err != nil {
		return
	}
	usersSvc, err := do.Invoke[*users.UsersSvc](i)
	if err != nil {
		return
	}
	orgsSvc, err := do.Invoke[*organizations.OrganizationsSvc](i)
	if err != nil {
		return
	}
	orgMembersSvc, err := do.Invoke[*orgmembers.OrgMembersSvc](i)
	if err != nil {
		return
	}
	coursesSvc, err := do.Invoke[*courses.CoursesSvc](i)
	if err != nil {
		return
	}
	courseModulesSvc, err := do.Invoke[*coursemodules.CourseModulesSvc](i)
	if err != nil {
		return
	}
	courseMembersSvc, err := do.Invoke[*coursemembers.CourseMembersSvc](i)
	if err != nil {
		return
	}
	lessonsSvc, err := do.Invoke[*lessons.LessonsSvc](i)
	if err != nil {
		return
	}
	storageSvc, err := do.Invoke[*storage.StorageSvc](i)
	if err != nil {
		return
	}
	aiSvc, err := do.Invoke[*ai.AISvc](i)
	if err != nil {
		return
	}
	interactionsSvc, err := do.Invoke[*interactions.InteractionsSvc](i)
	if err != nil {
		return
	}

	mux := http.NewServeMux()
	path, handler := authSvc.Handler()
	mux.Handle(path, handler)
	path, handler = usersSvc.Handler()
	mux.Handle(path, handler)
	path, handler = orgsSvc.Handler()
	mux.Handle(path, handler)
	path, handler = orgMembersSvc.Handler()
	mux.Handle(path, handler)
	path, handler = coursesSvc.Handler()
	mux.Handle(path, handler)
	path, handler = courseModulesSvc.Handler()
	mux.Handle(path, handler)
	path, handler = courseMembersSvc.Handler()
	mux.Handle(path, handler)
	path, handler = lessonsSvc.Handler()
	mux.Handle(path, handler)
	path, handler = storageSvc.Handler()
	mux.Handle(path, handler)
	path, handler = aiSvc.Handler()
	mux.Handle(path, handler)
	path, handler = interactionsSvc.Handler()
	mux.Handle(path, handler)

	// Test-only seed endpoint. Enabled when RICHTER_ALLOW_TEST_SEED=true
	// (set in richter.test.toml). Returns ("", nil) in production and is
	// never registered.
	if seedPath, seedHandler := aiSvc.TestSeedHandler(); seedHandler != nil {
		mux.Handle(seedPath, seedHandler)
	}

	v1 = &V1Svc{Mux: mux}
	return
}
