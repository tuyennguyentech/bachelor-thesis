package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type StorageCfg struct {
	// StudentUploadsPerWindow is the maximum number of student audio
	// presigned-upload requests allowed per (user, lesson) per window.
	// Set to 0 to disable the rate limit entirely (useful for dev / tests).
	StudentUploadsPerWindow int `mapstructure:"student_uploads_per_window"`
	// StudentUploadWindow is the rolling window over which the per-user
	// rate limit is counted. Only meaningful when StudentUploadsPerWindow > 0.
	StudentUploadWindow time.Duration `mapstructure:"student_upload_window"`
}

func NewStorageCfg() StorageCfg {
	return StorageCfg{
		StudentUploadsPerWindow: 5,
		StudentUploadWindow:     time.Minute,
	}
}

func NewStorageCfgSvc(i do.Injector) (*StorageCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.StorageCfg, nil
}
