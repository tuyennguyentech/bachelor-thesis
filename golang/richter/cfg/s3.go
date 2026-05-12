package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type S3Cfg struct {
	Endpoint        string `mapstructure:"endpoint"`
	AccessKeyID     string `mapstructure:"access_key_id"`
	SecretAccessKey string `mapstructure:"secret_access_key"`
	Bucket          string `mapstructure:"bucket"`
	UseSSL          bool   `mapstructure:"use_ssl"`
	// PublicEndpoint is the URL clients use to access the bucket (host-accessible).
	PublicEndpoint string `mapstructure:"public_endpoint"`
}

func NewS3Cfg() S3Cfg {
	return S3Cfg{
		Endpoint:       "storage:9000",
		Bucket:         "dyadia",
		UseSSL:         false,
		PublicEndpoint: "http://localhost:9000",
	}
}

func NewS3CfgSvc(i do.Injector) (*S3Cfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.S3Cfg, nil
}
