package cmd

import (
	"context"
	"fmt"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/api"
	"example.com/richter/internal/seed"
	"example.com/richter/log"
	"github.com/samber/do/v2"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var (
	Package = do.Package(
		do.Lazy(NewCfgFileSvc),
		do.Lazy(NewRootCmdSvc),
	)
	Injector = internal.Injector.Scope("cmd")
)

func NewCfgFileSvc(i do.Injector) (*cfg.CfgFile, error) {
	return &cfgFile, nil
}

var (
	cfgFile  cfg.CfgFile
	logLevel string

	richterCtx context.Context = context.Background()
	richterCfg *cfg.RichterCfg

	rootCmd = cobra.Command{
		Use:   "richter",
		Short: "Richter is backend service",
		Long:  "Richter is backend service of Dyadia project",
		PreRunE: func(cmd *cobra.Command, args []string) (err error) {
			return preRunE(&richterCtx, internal.Injector)
		},
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			return runE(richterCtx, internal.Injector)
		},
	}
)

func NewRootCmdSvc(i do.Injector) (*cobra.Command, error) {
	v, err := do.Invoke[*viper.Viper](i)
	if err != nil {
		return nil, fmt.Errorf("Viper cannot be invoked: %w", err)
	}
	v.BindPFlag("log.level", rootCmd.PersistentFlags().Lookup("log.level"))
	return &rootCmd, nil
}

func init() {
	Package(internal.Injector)

	rootCmd.PersistentFlags().StringSliceVarP(
		(*[]string)(&cfgFile),
		"config",
		"c",
		[]string{},
		"specify config file location (default is /etc/richter/richter.toml >> $HOME/.richter/richter.toml >> ./richter.toml)",
	)
	rootCmd.PersistentFlags().StringVar(
		&logLevel,
		"log.level",
		"info",
		"set log level",
	)

}

func Execute() error {
	return rootCmd.Execute()
}

func preRunE(ctx *context.Context, i do.Injector) (err error) {
	richterCfg, err = do.Invoke[*cfg.RichterCfg](i)
	if err != nil {
		return fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	fmt.Println("-c", cfgFile, "--log.level", logLevel)
	fmt.Printf("run with cfg: %#+v\n", richterCfg)

	logSvc, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	*ctx = log.WithLogger(*ctx, logSvc)

	_ = log.FromCtx(*ctx)
	logSvc.DebugContext(*ctx, "preRunE succeeds")

	seeder, err := do.Invoke[*seed.SeederSvc](i)
	if err != nil {
		return fmt.Errorf("SeederSvc cannot be invoked: %w", err)
	}
	if err = seeder.Seed(*ctx); err != nil {
		return fmt.Errorf("seed failed: %w", err)
	}
	return
}

func runE(ctx context.Context, i do.Injector) (err error) {
	api, err := do.Invoke[*api.ServerSvc](i)
	if err != nil {
		return fmt.Errorf("ServerSvc cannot be invoked: %w", err)
	}
	api.Start(ctx)
	i.RootScope().ShutdownOnSignalsWithContext(ctx)
	return
}
