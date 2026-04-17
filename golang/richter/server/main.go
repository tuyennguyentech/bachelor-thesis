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
	"example.com/sqlc/gen"
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

		conn, err := pgx.Connect(ctx, "user=pqgotest dbname=pqgotest sslmode=verify-full")
		if err != nil {
			return err
		}
		defer conn.Close(ctx)

		queries := gen.New(conn)

		// list all authors
		authors, err := queries.ListAuthors(ctx)
		if err != nil {
			return err
		}
		log.Println(authors)

		// create an author
		insertedAuthor, err := queries.CreateAuthor(ctx, gen.CreateAuthorParams{
			Name: "Brian Kernighan",
			Bio:  pgtype.Text{String: "Co-author of The C Programming Language and The Go Programming Language", Valid: true},
		})
		if err != nil {
			return err
		}
		log.Println(insertedAuthor)

		// get the author we just inserted
		fetchedAuthor, err := queries.GetAuthor(ctx, insertedAuthor.ID)
		if err != nil {
			return err
		}

		// prints true
		log.Println(reflect.DeepEqual(insertedAuthor, fetchedAuthor))
		return nil
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func main() {
	var wg sync.WaitGroup
	wg.Go(runConnectRpcServer)
	// wg.Go(sqlc)
	wg.Wait()
}
