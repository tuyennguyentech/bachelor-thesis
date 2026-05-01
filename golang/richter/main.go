package main

import (
	"example.com/richter/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		// log.Fatalln(err)
	}
}
