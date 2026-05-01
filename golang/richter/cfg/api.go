package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type ApiCfg struct {
	Host string `mapstructure:"host"`
	Port uint16 `mapstructure:"port"`
}

func NewApiCfgSvc(i do.Injector) (l *ApiCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	l = &r.ApiCfg
	return
}

func NewApiCfg() ApiCfg {
	return ApiCfg{
		Host: "localhost",
		Port: 8080,
	}
}
