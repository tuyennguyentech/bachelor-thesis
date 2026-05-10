package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type AuthCfg struct {
	AccessTokenDuration  time.Duration `mapstructure:"access_token_duration"`
	RefreshTokenDuration time.Duration `mapstructure:"refresh_token_duration"`
}

func NewAuthCfgSvc(i do.Injector) (a *AuthCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	a = &r.AuthCfg
	return
}

func NewAuthCfg() AuthCfg {
	return AuthCfg{
		AccessTokenDuration:  15 * time.Minute,
		RefreshTokenDuration: 7 * 24 * time.Hour,
	}
}
