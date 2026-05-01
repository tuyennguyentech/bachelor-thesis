package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type LogCfg struct {
	Level string `mapstructure:"level"`
}

func NewLogCfgSvc(i do.Injector) (l *LogCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	l = &r.LogCfg
	return
}

func NewLogCfg() LogCfg {
	return LogCfg{
		Level: "info",
	}
}
