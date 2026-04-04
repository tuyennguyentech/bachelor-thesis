package main

import (
	"context"
	"log"
	"net/http"

	"connectrpc.com/connect"
	tmpv1 "example.com/buf/gen/tmp/v1"
	"example.com/buf/gen/tmp/v1/tmpv1connect"
)

func main() {
	client := tmpv1connect.NewUserStoreServiceClient(
		http.DefaultClient,
		"http://localhost:8080",
		connect.WithGRPC(),
	)
	res, err := client.PutUser(
		context.TODO(),
		&tmpv1.PutUserRequest{
			UserId: "1",
			Name:   "a",
			Age:    10,
			Role:   tmpv1.UserRole_USER_ROLE_USER,
		},
	)
	if err != nil {
		log.Println(err)
		return
	}
	log.Println(res)
}
