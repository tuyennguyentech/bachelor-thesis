package ai

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/taskqueue"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// taskTypeFromKind maps the legacy LessonTaskKind enum (kept in the
// proto for FE compatibility) to the new string-based task_type
// stored in the tasks table.
func taskTypeFromKind(k richterv1.LessonTaskKind) (string, error) {
	switch k {
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT:
		return "transcribe", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_CHUNK_TRANSCRIPT:
		return "chunk", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS:
		return "quiz_gen", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_RUN_PIPELINE:
		return "pipeline_run", nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported task kind"))
	}
}

// lessonTaskInputForKind builds the per-kind input payload using
// protobuf. Each task type has its own proto message.
func lessonTaskInputForKind(k richterv1.LessonTaskKind, req *richterv1.StartLessonTaskRequest) ([]byte, string, error) {
	switch k {
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT:
		in := &richterv1.TranscribeTaskInput{LessonId: req.GetLessonId()}
		out, err := proto.Marshal(in)
		if err != nil {
			return nil, "", connect.NewError(connect.CodeInternal, fmt.Errorf("marshal transcribe input: %w", err))
		}
		return out, "Đã đưa tác vụ vào hàng đợi.", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_CHUNK_TRANSCRIPT:
		in := &richterv1.ChunkTaskInput{LessonId: req.GetLessonId()}
		out, err := proto.Marshal(in)
		if err != nil {
			return nil, "", connect.NewError(connect.CodeInternal, fmt.Errorf("marshal chunk input: %w", err))
		}
		return out, "Đã đưa tác vụ vào hàng đợi.", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS:
		genReq := req.GetGenerateInteractions()
		if genReq == nil {
			genReq = &richterv1.GenerateInteractionsRequest{LessonId: req.GetLessonId()}
		}
		if genReq.LessonId == "" {
			genReq.LessonId = req.GetLessonId()
		}
		if genReq.GetLessonId() != req.GetLessonId() {
			return nil, "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("generate_interactions.lesson_id must match lesson_id"))
		}
		in := &richterv1.QuizGenTaskInput{
			LessonId:         req.GetLessonId(),
			ChunkId:          genReq.GetChunkId(),
			ForceRegenerate:  genReq.GetForceRegenerate(),
			InteractionKinds: genReq.GetInteractionKinds(),
			CountPerChunk:    genReq.GetCountPerChunk(),
			Strategy:         genReq.GetStrategy(),
			Difficulty:       genReq.GetDifficulty(),
			FocusPrompt:      genReq.GetFocusPrompt(),
		}
		out, err := proto.Marshal(in)
		if err != nil {
			return nil, "", connect.NewError(connect.CodeInternal, fmt.Errorf("marshal quiz_gen input: %w", err))
		}
		return out, "Đã đưa tác vụ tạo bài tập vào hàng đợi.", nil
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_RUN_PIPELINE:
		genReq := req.GetGenerateInteractions()
		in := &richterv1.PipelineRunTaskInput{
			LessonId: req.GetLessonId(),
		}
		if genReq != nil {
			in.InteractionKinds = genReq.GetInteractionKinds()
			in.CountPerChunk = genReq.GetCountPerChunk()
			in.Strategy = genReq.GetStrategy()
			in.Difficulty = genReq.GetDifficulty()
			in.FocusPrompt = genReq.GetFocusPrompt()
			in.ForceRegenerate = genReq.GetForceRegenerate()
		}
		out, err := proto.Marshal(in)
		if err != nil {
			return nil, "", connect.NewError(connect.CodeInternal, fmt.Errorf("marshal pipeline_run input: %w", err))
		}
		return out, "Đã đưa tác vụ chạy toàn bộ quy trình vào hàng đợi.", nil
	}
	return nil, "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported task kind"))
}

// StartLessonTask creates a new pending task in the new tasks
// table. The Scanner picks it up within seconds and promotes it to
// inqueued, then the Worker claims it. Returns the task row.
func (s *AISvc) StartLessonTask(
	ctx context.Context,
	req *richterv1.StartLessonTaskRequest,
) (*richterv1.StartLessonTaskResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	kind := req.GetKind()
	if kind == richterv1.LessonTaskKind_LESSON_TASK_KIND_UNSPECIFIED {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported task kind"))
	}

	taskType, err := taskTypeFromKind(kind)
	if err != nil {
		return nil, err
	}

	// Auth check and get userID
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	claims, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	)
	if err != nil {
		return nil, err
	}
	userIDStr := claims.GetSub()
	userID, err := svc.ParseUUID(userIDStr)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("invalid token subject"))
	}

	// IDOR guard for quiz_gen with a chunk_id
	var chunkIDpg pgtype.UUID
	if kind == richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS {
		genReq := req.GetGenerateInteractions()
		if genReq != nil && genReq.GetChunkId() != "" {
			parsedChunkID, parseErr := svc.ParseUUID(genReq.GetChunkId())
			if parseErr != nil {
				return nil, parseErr
			}
			chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
				return q.GetLessonTranscriptChunk(ctx, parsedChunkID)
			})
			if err != nil {
				return nil, svc.ConnectDBError(err)
			}
			if chunk.LessonID != lessonID {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunk_id does not belong to lesson_id"))
			}
			chunkIDpg = parsedChunkID
		}
	}

	resp, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, tx pgx.Tx) (*richterv1.StartLessonTaskResponse, error) {
		var dummyID pgtype.UUID
		err := tx.QueryRow(ctx, "SELECT id FROM lessons WHERE id = $1 FOR UPDATE", lessonID).Scan(&dummyID)
		if err != nil {
			return nil, svc.ConnectDBError(err)
		}

		// Uniqueness check: return existing active task if any
		activeTask, err := q.GetActiveTask(ctx, gen.GetActiveTaskParams{
			LessonID: lessonID,
			TaskType: taskType,
			ChunkID:  chunkIDpg,
		})
		if err == nil {
			return &richterv1.StartLessonTaskResponse{Task: lessonTaskToProto(taskqueue.FromGen(activeTask))}, nil
		}

		// User cap check
		if s.taskCfg.MaxActivePerUser > 0 {
			activeCount, err := q.CountActiveTasksByUser(ctx, userID)
			if err != nil {
				return nil, svc.ConnectDBError(err)
			}
			if activeCount >= int64(s.taskCfg.MaxActivePerUser) {
				return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("bạn đã chạy quá nhiều tác vụ cùng lúc, giới hạn là %d", s.taskCfg.MaxActivePerUser))
			}
		}

		// Preflight: each kind requires the previous step to have produced the
		// expected artifact. Surface FailedPrecondition here so the UI gets an
		// immediate error instead of a queued task that the worker then fails.
		if err := s.preflightLessonTask(ctx, kind, lessonID); err != nil {
			return nil, err
		}

		inputPayload, _, err := lessonTaskInputForKind(kind, req)
		if err != nil {
			return nil, err
		}

		taskID := uuid.New()
		taskIDpg, err := uuidToPGType(taskID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("start lesson task: %w", err))
		}
		// InsertTask births the row already 'inqueued' with a queue_seq, so it is
		// claimable the instant this transaction commits. The pg_notify(task_created)
		// fired on INSERT is delivered at COMMIT — by then the row is inqueued, so the
		// worker the Listener wakes claims it at once (no scanner round-trip, no wait).
		// ('pending' was a FoundationDB-era parking state; the queue is Postgres-only now.)
		t, err := q.InsertTask(ctx, gen.InsertTaskParams{
			ID:           taskIDpg,
			LessonID:     lessonID,
			ChunkID:      chunkIDpg,
			TaskType:     taskType,
			InputPayload: inputPayload,
			CreatedBy:    userID,
		})
		if err != nil {
			return nil, svc.ConnectDBError(err)
		}
		s.log.InfoContext(ctx, "taskqueue: task created + inqueued",
			"task_id", taskID.String(), "task_type", taskType, "lesson_id", req.GetLessonId())
		return &richterv1.StartLessonTaskResponse{Task: lessonTaskToProto(taskqueue.FromGen(t))}, nil
	})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *AISvc) GetLessonTask(
	ctx context.Context,
	req *richterv1.GetLessonTaskRequest,
) (*richterv1.GetLessonTaskResponse, error) {
	parsedID, err := svc.ParseUUID(req.GetTaskId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("task not found"))
	}
	t, err := s.tqDB.GetTask(ctx, parsedID)
	if err != nil {
		return nil, mapTaskDBError(err)
	}
	if err := s.requireLessonMember(ctx, t.LessonID); err != nil {
		return nil, err
	}
	return &richterv1.GetLessonTaskResponse{Task: lessonTaskToProto(t)}, nil
}

func (s *AISvc) ListLessonTasks(
	ctx context.Context,
	req *richterv1.ListLessonTasksRequest,
) (*richterv1.ListLessonTasksResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireLessonMember(ctx, lessonID); err != nil {
		return nil, err
	}
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = 20
	}
	tasks, err := s.tqDB.ListTasksByLesson(ctx, lessonID, limit, int(req.GetOffset()))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list lesson tasks: %w", err))
	}
	out := make([]*richterv1.LessonTask, 0, len(tasks))
	for _, t := range tasks {
		if req.GetActiveOnly() {
			if t.Status != string(taskqueue.StatusInqueued) &&
				t.Status != string(taskqueue.StatusProcessing) {
				continue
			}
		}
		out = append(out, lessonTaskToProto(t))
	}
	return &richterv1.ListLessonTasksResponse{Tasks: out}, nil
}

func (s *AISvc) ListAllTasks(
	ctx context.Context,
	req *richterv1.ListAllTasksRequest,
) (*richterv1.ListAllTasksResponse, error) {
	// Require system-level ADMIN role
	_, err := s.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN)
	if err != nil {
		return nil, err
	}

	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = 20
	}
	offset := int(req.GetOffset())

	var tasks []taskqueue.Task
	if req.GetActiveOnly() {
		tasks, err = s.tqDB.ListActiveTasks(ctx, limit, offset)
	} else {
		tasks, err = s.tqDB.ListAllTasks(ctx, limit, offset)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list all tasks: %w", err))
	}

	out := make([]*richterv1.LessonTask, len(tasks))
	for i, t := range tasks {
		out[i] = lessonTaskToProto(t)
	}

	counts, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CountTaskStatusBucketsRow, error) {
		return q.CountTaskStatusBuckets(ctx)
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("count tasks: %w", err))
	}

	return &richterv1.ListAllTasksResponse{
		Tasks:                 out,
		TotalActive:           counts.Active,
		TotalSucceeded:        counts.Succeeded,
		TotalFailedOrCanceled: counts.FailedOrCancelled,
	}, nil
}

func (s *AISvc) CancelLessonTask(
	ctx context.Context,
	req *richterv1.CancelLessonTaskRequest,
) (*richterv1.CancelLessonTaskResponse, error) {
	parsedID, err := svc.ParseUUID(req.GetTaskId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("task not found"))
	}
	t, err := s.tqDB.GetTask(ctx, parsedID)
	if err != nil {
		return nil, mapTaskDBError(err)
	}
	_, adminErr := s.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN)
	if adminErr != nil {
		if err := s.requireTeacherRole(ctx, t.LessonID); err != nil {
			return nil, err
		}
	}
	if err := s.tqDB.MarkCancelled(ctx, parsedID); err != nil {
		return nil, mapTaskDBError(err)
	}
	t, err = s.tqDB.GetTask(ctx, parsedID)
	if err != nil {
		return nil, mapTaskDBError(err)
	}
	return &richterv1.CancelLessonTaskResponse{Task: lessonTaskToProto(t)}, nil
}

func (s *AISvc) requireLessonMember(ctx context.Context, lessonID pgtype.UUID) error {
	_, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID)
	return err
}

func mapTaskDBError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeNotFound, fmt.Errorf("task not found"))
	}
	return connect.NewError(connect.CodeInternal, err)
}

// uuidToPGType converts a google/uuid UUID to pgtype.UUID.
func uuidToPGType(u uuid.UUID) (pgtype.UUID, error) {
	if u == [16]byte{} {
		return pgtype.UUID{}, fmt.Errorf("empty uuid")
	}
	return pgtype.UUID{Bytes: u, Valid: true}, nil
}

// preflightLessonTask validates that the inputs needed to run the requested
// task kind are present.
func (s *AISvc) preflightLessonTask(
	ctx context.Context,
	kind richterv1.LessonTaskKind,
	lessonID pgtype.UUID,
) error {
	switch kind {
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT:
		if _, _, err := s.authorizeAndLoadLesson(ctx, lessonID.String()); err != nil {
			return err
		}
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_CHUNK_TRANSCRIPT:
		// Check tasks table: must have a successful transcribe task
		tasks, err := s.tqDB.ListLatestTaskPerLesson(ctx, []pgtype.UUID{lessonID})
		if err != nil {
			return connect.NewError(connect.CodeInternal, fmt.Errorf("preflight chunk: %w", err))
		}
		ok := false
		for _, t := range tasks {
			if t.TaskType == "transcribe" && t.Status == string(taskqueue.StatusSucceeded) {
				ok = true
				break
			}
		}
		if !ok {
			return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript found — run Step 2 (extract transcript) first"))
		}
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS:
		chunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
			return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
				LessonID: lessonID, Limit: 1, Offset: 0,
			})
		})
		if err != nil {
			return svc.ConnectDBError(err)
		}
		if len(chunks) == 0 {
			return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript chunks found — run Step 4 (chunk transcript) first"))
		}
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_RUN_PIPELINE:
		// Only requirement: lesson must have a video_storage_key (same as EXTRACT).
		if _, _, err := s.authorizeAndLoadLesson(ctx, lessonID.String()); err != nil {
			return err
		}
	default:
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported task kind"))
	}
	return nil
}

func lessonTaskToProto(t taskqueue.Task) *richterv1.LessonTask {
	message := t.Message
	if t.Status == string(taskqueue.StatusSucceeded) ||
		t.Status == string(taskqueue.StatusFailed) ||
		t.Status == string(taskqueue.StatusCancelled) {
		message = deriveTaskMessage(t.Status)
	} else if message == "" {
		message = deriveTaskMessage(t.Status)
	}
	out := &richterv1.LessonTask{
		Id:              pgUUIDToString(t.ID),
		LessonId:        pgUUIDToString(t.LessonID),
		ChunkId:         pgUUIDToString(t.ChunkID),
		Kind:            taskTypeToProtoKind(t.TaskType),
		Status:          taskStatusToProtoStatus(t.Status),
		ProgressStep:    t.ProgressStep,
		ProgressCurrent: t.ProgressCurrent,
		ProgressTotal:   t.ProgressTotal,
		Message:         message,
		ErrorMsg:        t.ErrorMsg,
	}
	if t.CreatedAt.Valid {
		out.CreatedAt = timestamppb.New(t.CreatedAt.Time)
	}
	if t.UpdatedAt.Valid {
		out.UpdatedAt = timestamppb.New(t.UpdatedAt.Time)
	}
	if t.StartedAt.Valid {
		out.StartedAt = timestamppb.New(t.StartedAt.Time)
	}
	if t.FinishedAt.Valid {
		out.FinishedAt = timestamppb.New(t.FinishedAt.Time)
	}
	if t.Heartbeat.Valid {
		out.LastHeartbeat = timestamppb.New(t.Heartbeat.Time)
	}
	return out
}

func pgUUIDToString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	return uuid.UUID(u.Bytes).String()
}

func taskTypeToProtoKind(t string) richterv1.LessonTaskKind {
	switch t {
	case "transcribe":
		return richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT
	case "chunk":
		return richterv1.LessonTaskKind_LESSON_TASK_KIND_CHUNK_TRANSCRIPT
	case "quiz_gen":
		return richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS
	case "pipeline_run":
		return richterv1.LessonTaskKind_LESSON_TASK_KIND_RUN_PIPELINE
	}
	return richterv1.LessonTaskKind_LESSON_TASK_KIND_UNSPECIFIED
}

func taskStatusToProtoStatus(s string) richterv1.LessonTaskStatus {
	switch s {
	case string(taskqueue.StatusInqueued):
		return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED
	case string(taskqueue.StatusProcessing):
		return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING
	case string(taskqueue.StatusSucceeded):
		return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_SUCCEEDED
	case string(taskqueue.StatusFailed):
		return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_FAILED
	case string(taskqueue.StatusCancelled):
		return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_CANCELED
	}
	return richterv1.LessonTaskStatus_LESSON_TASK_STATUS_UNSPECIFIED
}

func deriveTaskMessage(status string) string {
	switch status {
	case string(taskqueue.StatusInqueued):
		return "Đang chờ..."
	case string(taskqueue.StatusProcessing):
		return "Đang xử lý..."
	case string(taskqueue.StatusSucceeded):
		return "Hoàn thành"
	case string(taskqueue.StatusFailed):
		return "Thất bại"
	case string(taskqueue.StatusCancelled):
		return "Đã hủy."
	default:
		return ""
	}
}
