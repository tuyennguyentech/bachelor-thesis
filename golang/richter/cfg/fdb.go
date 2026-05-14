package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type FdbCfg struct {
	ClusterFile string `mapstructure:"cluster_file"`
	APIVersion  int    `mapstructure:"api_version"`
}

func NewFdbCfg() FdbCfg {
	return FdbCfg{
		ClusterFile: "fdb.cluster",
		APIVersion:  730,
	}
}

func NewFdbCfgSvc(i do.Injector) (*FdbCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.FdbCfg, nil
}
