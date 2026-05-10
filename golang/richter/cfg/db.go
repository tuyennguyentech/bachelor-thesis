package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type DbCfg struct {
	PostgresCfg `mapstructure:"postgres"`
}

func NewDbCfgSvc(i do.Injector) (d *DbCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	d = &r.DbCfg
	return
}

type PostgresCfg struct {
	Host           string        `mapstructure:"host"`
	Port           uint16        `mapstructure:"port"`
	Database       string        `mapstructure:"database"`
	User           string        `mapstructure:"user"`
	Password       string        `mapstructure:"password"`
	ConnectTimeout time.Duration `mapstructure:"connect_timeout"`
}

func NewPostgreCfgSvc(i do.Injector) (p *PostgresCfg, err error) {
	d, err := do.Invoke[*DbCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	p = &d.PostgresCfg
	return
}
