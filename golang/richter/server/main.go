package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"sync"

	tmpv1 "example.com/buf/gen/tmp/v1"
	"example.com/buf/gen/tmp/v1/tmpv1connect"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"connectrpc.com/validate"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/rs/cors"
)

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

func runConnectRpcServer() {
	user := &tmpv1.PutUserRequest{
		UserId: "1",
		Name:   "Alice",
		Age:    25,
		Role:   tmpv1.UserRole_USER_ROLE_ADMIN,
	}
	fmt.Println("User:", user.GetName(), "Role:", user.GetRole())

	api := http.NewServeMux()
	path, handler := tmpv1connect.NewUserStoreServiceHandler(
		&UserServer{},
		connect.WithInterceptors(validate.NewInterceptor()),
	)
	api.Handle(path, handler)
	mux := http.NewServeMux()
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("Hello API\n"))
	})
	mux.Handle("/api/", http.StripPrefix("/api", api))
	corsHandler := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: connectcors.AllowedHeaders(),
		ExposedHeaders: connectcors.ExposedHeaders(),
	}).Handler(mux)
	p := new(http.Protocols)
	p.SetHTTP1(true)
	// Use h2c so we can serve HTTP/2 without TLS.
	p.SetUnencryptedHTTP2(true)
	s := http.Server{
		Addr:      ":8080",
		Handler:   corsHandler,
		Protocols: p,
	}
	s.ListenAndServe()
}

func sqlc() {
	run := func() error {
		ctx := context.Background()

		conn, err := pgx.Connect(ctx, "postgres://dyadia:dyadia@postgres:5432/dyadia")
		if err != nil {
			return err
		}
		defer conn.Close(ctx)

		queries := gen.New(conn)

		// list all users
		users, err := queries.ListUsers(ctx)
		if err != nil {
			return err
		}
		log.Println(users)

		// create an User
		insertedUser, err := queries.CreateUser(ctx, gen.CreateUserParams{
			Username: "Brian Kernighan",
			Password: "123456",
			Email:    pgtype.Text{},
		})
		if err != nil {
			return err
		}
		log.Println(insertedUser)

		// get the User we just inserted
		fetchedUser, err := queries.GetUser(ctx, insertedUser.ID)
		if err != nil {
			return err
		}

		// prints true
		log.Println(reflect.DeepEqual(insertedUser, fetchedUser))
		return nil
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func main() {
	var wg sync.WaitGroup
	// wg.Go(runConnectRpcServer)
	wg.Go(sqlc)
	wg.Wait()
}
