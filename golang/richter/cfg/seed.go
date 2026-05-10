package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type SeedCfg struct {
	DevSeedEnabled bool `mapstructure:"dev_seed_enabled"`
}

func NewSeedCfgSvc(i do.Injector) (s *SeedCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	s = &r.SeedCfg
	return
}
