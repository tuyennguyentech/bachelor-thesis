package cmd

import (
	"fmt"

	"example.com/richter/internal"
	"example.com/richter/internal/seed"
	"github.com/samber/do/v2"
	"github.com/spf13/cobra"
)

var seedDev bool

var seedCmd = cobra.Command{
	Use:   "seed",
	Short: "Seed the database",
	PreRunE: func(cmd *cobra.Command, args []string) error {
		return preRunE(&richterCtx, internal.Injector)
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		seeder, err := do.Invoke[*seed.SeederSvc](internal.Injector)
		if err != nil {
			return fmt.Errorf("SeederSvc cannot be invoked: %w", err)
		}
		if err := seeder.SeedAdmin(richterCtx); err != nil {
			return fmt.Errorf("seed admin: %w", err)
		}
		if seedDev {
			if err := seeder.SeedDev(richterCtx); err != nil {
				return fmt.Errorf("seed dev: %w", err)
			}
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(&seedCmd)
	seedCmd.Flags().BoolVar(&seedDev, "dev", false, "seed dev data (users, orgs, courses)")
}
