package main

import (
	"fmt"

	"github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/spf13/viper"
)

func main() {
	// fmt.Println(os.Getenv("FDB_API_VERSION"))
	// viper.SetConfigName(".env")
	viper.SetConfigFile(".env")
	viper.AddConfigPath(".")
	err := viper.ReadInConfig()
	if err != nil {
		fmt.Println("Error reading config file:", err)
	}
	fdbAPIVersion := viper.GetInt("FDB_API_VERSION")
	fmt.Println(fdbAPIVersion)
	fdb.MustAPIVersion(fdbAPIVersion)
	db := fdb.MustOpenDatabase(viper.GetString("FDB_CLUSTER_FILE"))
	ret, err := db.Transact(func(tr fdb.Transaction) (any, error) {
		tr.Set(fdb.Key("hello"), []byte("world"))
		return tr.Get(fdb.Key("hello")).MustGet(), nil
	})
	if err != nil {
		fmt.Println("Transaction failed:", err)
	} else {
		fmt.Println("Transaction result:", ret)
	}
}
