package main

import (
	"os"

	"example.com/richter/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		// cobra already printed the error; the exit CODE is what matters —
		// swallowing it made richter exit 0 on failure, so callers like
		// seed-reset.sh (set -e) carried on and reported a failed seed as
		// "SEED-RESET COMPLETE".
		os.Exit(1)
	}
}
