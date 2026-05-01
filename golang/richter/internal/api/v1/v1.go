package v1

import (
	"net/http"

	"example.com/richter/internal"
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
	users, err := do.Invoke[*users.UsersSvc](i)
	if err != nil {
		return
	}
	path, handler := users.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	v1 = &V1Svc{
		Mux: mux,
	}
	return
}
