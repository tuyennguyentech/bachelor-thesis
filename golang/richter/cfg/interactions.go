package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

// InteractionsCfg groups runtime knobs for the interactions service:
// AI-graded attempt timeout and the page size for list queries. All
// duration fields accept 0 to mean "unlimited" (no deadline) where that
// is meaningful for the underlying context.
type InteractionsCfg struct {
	// GradingTimeout caps a single AI-graded attempt (audio upload
	// + LLM judge). 0 = unlimited.
	GradingTimeout time.Duration `mapstructure:"grading_timeout"`
	// ListLimit bounds how many interactions we fetch per page when
	// loading a lesson's interactions. 0 = use safe default (500).
	ListLimit int `mapstructure:"list_limit"`
}

func NewInteractionsCfg() InteractionsCfg {
	return InteractionsCfg{
		GradingTimeout: 25 * time.Second,
		ListLimit:      500,
	}
}

func NewInteractionsCfgSvc(i do.Injector) (*InteractionsCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.InteractionsCfg, nil
}
