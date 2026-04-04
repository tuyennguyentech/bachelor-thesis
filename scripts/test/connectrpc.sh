curl \
  --header "Content-Type: application/json" \
  --data '{"user_id": "1", "name": "abc", "age": 1, "role": "USER_ROLE_ADMIN"}' \
  http://localhost:8080/tmp.v1.UserStoreService/PutUser | jq . && echo

buf curl \
  --schema ./proto/tmp/v1/tmp.proto \
  --protocol grpc \
  --http2-prior-knowledge \
  --data '{"user_id": "1", "name": "abc", "age": 1, "role": "USER_ROLE_ADMIN"}' \
  http://localhost:8080/tmp.v1.UserStoreService/PutUser | jq . && echo

buf curl \
  --schema ./proto \
  --data '{"user_id": "1", "name": "abc", "age": 1, "role": "USER_ROLE_ADMIN"}' \
  http://localhost:8080/tmp.v1.UserStoreService/PutUser | jq . && echo
