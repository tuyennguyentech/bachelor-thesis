package main

import (
	"context"
	"fmt"
	"net/http"

	tmpv1 "example.com/buf/tmp/v1"
	"example.com/buf/tmp/v1/tmpv1connect"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
)

const address = "localhost:8080"

type UserServer struct{}

func (s *UserServer) PutUser(ctx context.Context, req *tmpv1.PutUserRequest) (*tmpv1.PutUserResponse, error) {
	fmt.Printf("%v\n", ctx)
	fmt.Println("Received PutPet request:", req.GetName(), "Age:", req.GetAge(), "Role:", req.GetRole())
	return &tmpv1.PutUserResponse{
		UserId: req.GetUserId(),
		Name:   req.GetName(),
		Age:    req.GetAge(),
		Role:   req.GetRole(),
	}, nil
}

func main() {
	user := &tmpv1.PutUserRequest{
		UserId: "1",
		Name:   "Alice",
		Age:    25,
		Role:   tmpv1.UserRole_USER_ROLE_ADMIN,
	}
	fmt.Println("User:", user.GetName(), "Role:", user.GetRole())

	mux := http.NewServeMux()
	path, handler := tmpv1connect.NewUserStoreServiceHandler(
		&UserServer{},
		connect.WithInterceptors(validate.NewInterceptor()),
	)

	mux.Handle(path, handler)
	p := new(http.Protocols)
	p.SetHTTP1(true)
	// Use h2c so we can serve HTTP/2 without TLS.
	p.SetUnencryptedHTTP2(true)
	s := http.Server{
		Addr:      "localhost:8080",
		Handler:   mux,
		Protocols: p,
	}
	s.ListenAndServe()
}
