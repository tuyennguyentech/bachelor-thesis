package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type JwtCfg struct {
	Secret string        `mapstructure:"secret"`
	Leeway time.Duration `mapstructure:"leeway"`
}

func NewJwtCfgSvc(i do.Injector) (l *JwtCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	l = &r.JwtCfg
	return
}

func NewJwtCfg() JwtCfg {
	return JwtCfg{
		Secret: "dyadia-default-secret-change-me",
		Leeway: 5 * time.Second,
	}
}
