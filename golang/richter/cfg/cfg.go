package cfg

import (
	"flag"
	"fmt"
	"log"
	"strings"
	"testing"

	"example.com/richter/internal"
	"github.com/samber/do/v2"
	"github.com/spf13/viper"
)

type CfgFile []string

var (
	Package = do.Package(
		do.Lazy(NewViperSvc),
		do.Lazy(NewRichterCfgSvc),
		do.Package(
			do.Lazy(NewLogCfgSvc),
			do.Lazy(NewDbCfgSvc),
			do.Package(
				do.Lazy(NewPostgreCfgSvc),
			),
			do.Lazy(NewApiCfgSvc),
			do.Lazy(NewJwtCfgSvc),
			do.Lazy(NewAuthCfgSvc),
			do.Lazy(NewAdminCfgSvc),
		),
	)
	Injector = internal.Injector.Scope("cfg")
)

func init() {
	testConfigFileStr := flag.String("config", "", "config files list")
	if testing.Testing() {
		do.Override(internal.Injector, func(i do.Injector) (*CfgFile, error) {
			flag.Parse()
			testConfigFile := strings.Split(*testConfigFileStr, ",")
			// fmt.Println(testConfigFile)
			return (*CfgFile)(&testConfigFile), nil
		})
	}

	Package(internal.Injector)
}

type RichterCfg struct {
	LogCfg   `mapstructure:"log"`
	DbCfg    `mapstructure:"db"`
	ApiCfg   `mapstructure:"api"`
	JwtCfg   `mapstructure:"jwt"`
	AuthCfg  `mapstructure:"auth"`
	AdminCfg `mapstructure:"admin"`
}

func NewConfig() RichterCfg {
	return RichterCfg{
		LogCfg:  NewLogCfg(),
		ApiCfg:  NewApiCfg(),
		JwtCfg:  NewJwtCfg(),
		AuthCfg: NewAuthCfg(),
	}
}

func NewRichterCfgSvc(i do.Injector) (richterCfg *RichterCfg, err error) {
	v, err := do.Invoke[*viper.Viper](i)
	if err != nil {
		err = fmt.Errorf("Viper cannot be invoked: %w", err)
		return
	}
	// fmt.Println(v.AllSettings())
	// if readErr := v.ReadInConfig(); readErr != nil {
	// 	if configFileNotFoundError, ok := errors.AsType[viper.ConfigFileNotFoundError](readErr); ok {
	// 		err = errors.Join(errors.New("config file is not found error"), configFileNotFoundError)
	// 	} else {
	// 		err = readErr
	// 	}
	// 	return
	// }
	// log.Println("config file is found at: ", v.ConfigFileUsed())
	cfg := NewConfig()
	richterCfg = &cfg
	err = v.Unmarshal(richterCfg)
	return
}

func NewViperSvc(i do.Injector) (v *viper.Viper, err error) {
	v = viper.New()
	cfgFile, err := do.Invoke[*CfgFile](i)
	if err != nil {
		err = fmt.Errorf("CfgFile cannot be invoked: %w", err)
		return
	}
	if cfgFile != nil && len(*cfgFile) != 0 {
		for _, file := range *cfgFile {
			v.SetConfigFile(file)
			if err := v.MergeInConfig(); err != nil {
				log.Fatalln(fmt.Sprintf("load config from %s error: ", file), err)
			}
			// log.Println("read config in", file)
		}
	} else {
		v.SetConfigName("richter")
		// v.SetConfigType("toml")
		v.AddConfigPath("/etc/richter")
		v.AddConfigPath("$HOME/.richter")
		v.AddConfigPath(".")
	}

	v.SetEnvPrefix("richter")
	v.AutomaticEnv()
	return
}
