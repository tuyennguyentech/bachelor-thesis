package cmd

import (
	"context"
	"fmt"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/api"
	_ "example.com/richter/internal/svc/aitasks/executors"
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

	rootCmd = cobra.Command{
		Use:   "richter",
		Short: "Richter is backend service",
		Long:  "Richter is backend service of Dyadia project",
		// A RUNTIME failure (seed step failed, DB down, port in use) must print
		// just the error — cobra's default of dumping the full usage/help block
		// on ANY RunE error buries the real message (a failed `seed --dev` ended
		// with the error truncated above 20 lines of help text). Root-level
		// SilenceUsage covers every subcommand; genuine CLI-syntax mistakes
		// still show usage via the FlagErrorFunc set in init().
		SilenceUsage: true,
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

	// Counterpart of SilenceUsage: for a genuine CLI-SYNTAX mistake (unknown
	// flag / bad flag value) the usage block IS the helpful output — print it
	// for the mistyped command, then return the error as usual.
	rootCmd.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		cmd.Println(cmd.UsageString())
		return err
	})
}

func Execute() error {
	return rootCmd.Execute()
}

func preRunE(ctx *context.Context, i do.Injector) (err error) {
	logSvc, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	*ctx = log.WithLogger(*ctx, logSvc)
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
