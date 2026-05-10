package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type AdminCfg struct {
	Email     string `mapstructure:"email"`
	Password  string `mapstructure:"password"`
	FirstName string `mapstructure:"first_name"`
	LastName  string `mapstructure:"last_name"`
}

func NewAdminCfgSvc(i do.Injector) (a *AdminCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	a = &r.AdminCfg
	return
}
