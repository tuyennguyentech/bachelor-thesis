package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

// LessonsCfg groups runtime knobs for the lessons service: page sizes
// for list queries. All limit fields accept 0 to mean "use the safe
// default" rather than "unlimited" (unlimited list queries are
// dangerous in SQL; we always cap at a sensible value).
type LessonsCfg struct {
	// ListLimit bounds how many lessons / modules we fetch per page
	// when loading a course. 0 = use safe default (10000).
	ListLimit int `mapstructure:"list_limit"`
}

func NewLessonsCfg() LessonsCfg {
	return LessonsCfg{
		ListLimit: 10000,
	}
}

func NewLessonsCfgSvc(i do.Injector) (*LessonsCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.LessonsCfg, nil
}
