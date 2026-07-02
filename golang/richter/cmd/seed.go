package cmd

import (
	"fmt"

	"example.com/richter/internal"
	"example.com/richter/internal/seed"
	"github.com/samber/do/v2"
	"github.com/spf13/cobra"
)

var seedDev bool

// gen-exercises subcommand flags.
var (
	genLessonID     string
	genOrgSlug      string
	genCourseTitle  string
	genLessonTitle  string
	genKinds        []string
	genCountPerChnk int32
	genDifficulty   string
	genForce        bool
)

// gen-ml-spec subcommand flags.
var (
	mlSpecVideoDir   string
	mlSpecCoursePath string
	mlSpecVideosPath string
)

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

// seedGenExercisesCmd is the Go replacement for scripts/seed/gen-exercises.py:
// it (re)generates exercises for one lesson IN-PROCESS through the real
// generation service, so exercise seeding always goes through richter (no python).
var seedGenExercisesCmd = cobra.Command{
	Use:   "gen-exercises",
	Short: "(Re)generate exercises for one lesson via the real generation service (in-process)",
	PreRunE: func(cmd *cobra.Command, args []string) error {
		return preRunE(&richterCtx, internal.Injector)
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		seeder, err := do.Invoke[*seed.SeederSvc](internal.Injector)
		if err != nil {
			return fmt.Errorf("SeederSvc cannot be invoked: %w", err)
		}
		return seeder.GenExercises(richterCtx, seed.GenExercisesParams{
			LessonID:      genLessonID,
			OrgSlug:       genOrgSlug,
			CourseTitle:   genCourseTitle,
			LessonTitle:   genLessonTitle,
			Kinds:         genKinds,
			CountPerChunk: genCountPerChnk,
			Difficulty:    genDifficulty,
			Force:         genForce,
		})
	},
}

// seedGenMLSpecCmd is the Go replacement for scripts/seed/generate-ml-seed-data.py:
// it (re)generates the committed ML course seed artifacts (tu-hoc-ml.json +
// videos.json) from the downloaded playlist videos. Run from the repo root.
var seedGenMLSpecCmd = cobra.Command{
	Use:   "gen-ml-spec",
	Short: "(Re)generate the committed ML course seed JSON from downloaded playlist videos",
	PreRunE: func(cmd *cobra.Command, args []string) error {
		return preRunE(&richterCtx, internal.Injector)
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		seeder, err := do.Invoke[*seed.SeederSvc](internal.Injector)
		if err != nil {
			return fmt.Errorf("SeederSvc cannot be invoked: %w", err)
		}
		return seeder.GenMLSpec(richterCtx, seed.GenMLSpecParams{
			VideoDir:       mlSpecVideoDir,
			CourseJSONPath: mlSpecCoursePath,
			VideosJSONPath: mlSpecVideosPath,
		})
	},
}

// seedRescaleFixturesCmd re-fits the golden-fixture demo lessons (NON-ML) to their
// real mapped-video durations IN PLACE, repairing a DB seeded before that fit
// existed — without a destructive full reseed (the ML course + FoundationDB are left
// untouched, so no root FDB re-configure and no GPU rerun).
var seedRescaleFixturesCmd = cobra.Command{
	Use:   "rescale-fixtures",
	Short: "Re-fit demo (non-ML) fixture lessons to their real video duration, in place",
	PreRunE: func(cmd *cobra.Command, args []string) error {
		return preRunE(&richterCtx, internal.Injector)
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		seeder, err := do.Invoke[*seed.SeederSvc](internal.Injector)
		if err != nil {
			return fmt.Errorf("SeederSvc cannot be invoked: %w", err)
		}
		return seeder.RescaleFixtures(richterCtx)
	},
}

func init() {
	rootCmd.AddCommand(&seedCmd)
	seedCmd.Flags().BoolVar(&seedDev, "dev", false, "seed dev data (users, orgs, courses)")

	seedCmd.AddCommand(&seedRescaleFixturesCmd)

	seedCmd.AddCommand(&seedGenExercisesCmd)
	f := seedGenExercisesCmd.Flags()
	f.StringVar(&genLessonID, "lesson-id", "", "target lesson UUID (takes priority over title resolution)")
	f.StringVar(&genOrgSlug, "org", "hust-cs", "org slug (used when resolving by title)")
	f.StringVar(&genCourseTitle, "course-title", "Tự học Machine Learning", "course title (used when resolving by title)")
	f.StringVar(&genLessonTitle, "lesson-title", "", "lesson title, resolved within --org/--course-title")
	f.StringSliceVar(&genKinds, "kinds", []string{"single_choice", "fill_blank"}, "interaction kinds (single_choice,multiple_choice,fill_blank,listening,reading,writing)")
	f.Int32Var(&genCountPerChnk, "count", 1, "exercises generated per transcript chunk")
	f.StringVar(&genDifficulty, "difficulty", "medium", "difficulty: easy|medium|hard")
	f.BoolVar(&genForce, "force", false, "regenerate even if a chunk already has exercises")

	seedCmd.AddCommand(&seedGenMLSpecCmd)
	g := seedGenMLSpecCmd.Flags()
	g.StringVar(&mlSpecVideoDir, "video-dir", "", "ML playlist video dir (default seed-assets/videos/ml)")
	g.StringVar(&mlSpecCoursePath, "course-json", "", "output course spec path (default committed tu-hoc-ml.json)")
	g.StringVar(&mlSpecVideosPath, "videos-json", "", "output videos manifest path (default committed videos.json)")
}
