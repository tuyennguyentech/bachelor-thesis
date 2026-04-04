package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

func main() {
	confManager := viper.New()

	confManager.SetConfigName("arthur")

	confManager.AddConfigPath("/etc/arthur/")
	confManager.AddConfigPath("$HOME/.arthur")
	confManager.AddConfigPath(".")

	confManager.SetConfigType("toml")

	confManager.SetDefault("database.host", 1111)
	viper.RegisterAlias("loud", "Verbose")

	var tomlConfig = []byte(`
[[database]]
host = "localhost"
port = 5432
[[database]]
host = "remotehost"
port = 5432
`)

	if err := confManager.ReadConfig(bytes.NewBuffer(tomlConfig)); err != nil {
		panic(fmt.Errorf("fatal error read config file from buffer: %w", err))
	}

	type Database struct {
		Host string `mapstructure:"host"`
		Port int    `mapstructure:"port"`
	}

	fmt.Println("get from buffer config:\n", confManager.Get("database"), confManager.Get("database.host"))

	if err := confManager.WriteConfigTo(os.Stdout); err != nil {
		panic(fmt.Errorf("fatal error write config file to stdout: %w", err))
	}

	if err := confManager.ReadInConfig(); err != nil {
		panic(fmt.Errorf("fatal error read config file: %w", err))
	}

	confManager.OnConfigChange(func(e fsnotify.Event) {
		fmt.Println("config file changed:", e.Name)
	})

	confManager.WatchConfig()

	fmt.Println("arthur configuration loaded successfully.")

	confManager.SetEnvPrefix("arthur")
	confManager.AutomaticEnv()
	os.Setenv("ARTHUR_ID", "13")
	fmt.Println(confManager.GetInt("id"))

	fmt.Println(os.UserHomeDir())

	var rootCmd = &cobra.Command{
		Use:   "arthur",
		Short: "short",
		Long:  "long",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("arthur command executed")
		},
		Args: cobra.MatchAll(),
	}
	cobra.OnInitialize(func() {
		fmt.Println("cobra initialized")
	})
	Execute := func() {
		if err := rootCmd.Execute(); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}
	Execute()
}
