package cfg

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
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

// DSN builds the postgres:// connection string from the config. Both the
// pgxpool (db package) and the LISTEN/NOTIFY listener (taskqueue package)
// need an identical DSN, so this is the single source of truth for it.
func (c PostgresCfg) DSN() string {
	return (&url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.User, c.Password),
		Host:   net.JoinHostPort(c.Host, strconv.FormatUint(uint64(c.Port), 10)),
		Path:   c.Database,
	}).String()
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
