package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type LessonTaskCfg struct {
	// Workers is the number of concurrent task workers in the pool.
	// 0 = auto = runtime.NumCPU() (Go's best practice for CPU-bound
	// work; STT transcription is the dominant cost). Set a positive
	// integer to pin the worker count for production sizing.
	Workers int `mapstructure:"workers"`
	// MaxActivePerUser caps how many active tasks a single user may
	// have in-flight simultaneously. 0 = unlimited (not recommended in
	// production; a single user can otherwise monopolise the worker pool).
	MaxActivePerUser int `mapstructure:"max_active_per_user"`
	// ActiveTimeout marks a RUNNING task as stale if its StartedAt is
	// older than this. Used by reclaim to recover tasks abandoned by a
	// crashed worker. 0 = unlimited (never mark stale; risk: crashed
	// tasks stay QUEUED/RUNNING forever and block the active_target
	// index until manually cleared).
	ActiveTimeout time.Duration `mapstructure:"active_timeout"`
	// PollInterval is how often each worker scans the task queue for
	// work. 0 = unlimited (don't poll; pool effectively disabled). Use
	// a small value (1-5s) for low-latency pickup.
	PollInterval time.Duration `mapstructure:"poll_interval"`
	// StaleCheckInterval is how often the runner scans for stale
	// RUNNING tasks to reclaim. 0 = unlimited (never reclaim; only
	// useful for debugging).
	StaleCheckInterval time.Duration `mapstructure:"stale_check_interval"`
	// HeartbeatInterval is how often workers emit a heartbeat timestamp
	// to the task record. This allows the system to detect tasks whose
	// worker has crashed without updating progress. 0 = disabled (no
	// heartbeat emission; stale detection relies solely on ActiveTimeout).
	HeartbeatInterval time.Duration `mapstructure:"heartbeat_interval"`
	// HeartbeatTimeout marks a RUNNING task as dead if its last heartbeat
	// is older than this. Used by ReclaimDeadTasks on startup to detect
	// tasks abandoned by a crashed server. 0 = disabled (never mark dead
	// based on heartbeat; only ActiveTimeout-based reclaim applies).
	HeartbeatTimeout time.Duration `mapstructure:"heartbeat_timeout"`
}

func NewLessonTaskCfg() LessonTaskCfg {
	return LessonTaskCfg{
		Workers:            0, // 0 = runtime.NumCPU() at startup
		MaxActivePerUser:   3,
		ActiveTimeout:      2 * time.Minute,
		PollInterval:       2 * time.Second,
		StaleCheckInterval: time.Minute,
		HeartbeatInterval:  15 * time.Second,
		HeartbeatTimeout:   time.Minute,
	}
}

func NewLessonTaskCfgSvc(i do.Injector) (*LessonTaskCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.LessonTaskCfg, nil
}
