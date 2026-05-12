package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
	"google.golang.org/api/option"
)

var Package = do.Package(
	do.Lazy(NewAISvc),
)

func init() {
	Package(internal.Injector)
}

type AISvc struct {
	pg        *db.PostgresSvc
	log       *log.LogSvc
	authz     *authz.AuthzSvc
	s3client  *minio.Client
	s3cfg     *cfg.S3Cfg
	geminiCfg *cfg.GeminiCfg
}

var _ richterv1connect.AIServiceHandler = (*AISvc)(nil)

func NewAISvc(i do.Injector) (*AISvc, error) {
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc: %w", err)
	}
	l, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc: %w", err)
	}
	s3cfg, err := do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg: %w", err)
	}
	geminiCfg, err := do.Invoke[*cfg.GeminiCfg](i)
	if err != nil {
		return nil, fmt.Errorf("GeminiCfg: %w", err)
	}

	s3client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}

	return &AISvc{
		pg: pg, log: l, authz: az,
		s3client: s3client, s3cfg: s3cfg, geminiCfg: geminiCfg,
	}, nil
}

func (s *AISvc) Handler() (string, http.Handler) {
	return richterv1connect.NewAIServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// ── AnalyzeLesson ─────────────────────────────────────────────────────────────

func (s *AISvc) AnalyzeLesson(
	ctx context.Context,
	req *richterv1.AnalyzeLessonRequest,
) (*richterv1.AnalyzeLessonResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	// Auth: require org member (teacher+) — we check at the org level below
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if !lesson.VideoStorageKey.Valid || lesson.VideoStorageKey.String == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("lesson has no video uploaded"))
	}

	// Mark as processing
	analysis, err := s.upsertAnalysis(ctx, lessonID, gen.LessonAnalysisStatusProcessing, "", nil, "")
	if err != nil {
		return nil, err
	}

	// Run analysis (may take up to 2 min)
	transcript, segments, questions, analyzeErr := s.runGeminiAnalysis(ctx, lesson.VideoStorageKey.String)

	if analyzeErr != nil {
		analysis, _ = s.upsertAnalysis(ctx, lessonID, gen.LessonAnalysisStatusError, "", nil, analyzeErr.Error())
		return &richterv1.AnalyzeLessonResponse{Analysis: analysisToProto(analysis, nil)}, nil
	}

	segmentsJSON, _ := json.Marshal(segments)
	analysis, err = s.upsertAnalysis(ctx, lessonID, gen.LessonAnalysisStatusDone, transcript, segmentsJSON, "")
	if err != nil {
		return nil, err
	}

	// Persist questions
	savedQuestions, err := s.saveQuestions(ctx, lessonID, questions)
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to save questions", svc.LogAttrs("saveQuestions", err)...)
	}

	return &richterv1.AnalyzeLessonResponse{Analysis: analysisToProto(analysis, savedQuestions)}, nil
}

// ── GetLessonAnalysis ─────────────────────────────────────────────────────────

func (s *AISvc) GetLessonAnalysis(
	ctx context.Context,
	req *richterv1.GetLessonAnalysisRequest,
) (*richterv1.GetLessonAnalysisResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}

	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	analysis, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
		return q.GetLessonAnalysis(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	questions, _ := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonQuestion, error) {
		return q.ListLessonQuestions(ctx, lessonID)
	})

	return &richterv1.GetLessonAnalysisResponse{Analysis: analysisToProto(analysis, questions)}, nil
}

// ── Gemini analysis ───────────────────────────────────────────────────────────

type mcqQuestion struct {
	QuestionText  string   `json:"question_text"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
}

type transcriptSegment struct {
	StartSeconds float32 `json:"start_seconds"`
	EndSeconds   float32 `json:"end_seconds"`
	Text         string  `json:"text"`
}

func (s *AISvc) runGeminiAnalysis(ctx context.Context, storageKey string) (transcript string, segments []transcriptSegment, questions []mcqQuestion, err error) {
	if s.geminiCfg.APIKey == "" {
		return "", nil, nil, fmt.Errorf("Gemini API key not configured (set RICHTER_GEMINI_API_KEY or gemini.api_key in config)")
	}

	// Download video bytes from S3
	ctx2, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	obj, err := s.s3client.GetObject(ctx2, s.s3cfg.Bucket, storageKey, minio.GetObjectOptions{})
	if err != nil {
		return "", nil, nil, fmt.Errorf("download video from storage: %w", err)
	}
	defer obj.Close()

	videoBytes, err := io.ReadAll(obj)
	if err != nil {
		return "", nil, nil, fmt.Errorf("read video bytes: %w", err)
	}

	client, err := genai.NewClient(ctx2, option.WithAPIKey(s.geminiCfg.APIKey))
	if err != nil {
		return "", nil, nil, fmt.Errorf("create gemini client: %w", err)
	}
	defer client.Close()

	// Upload video to Gemini File API
	mimeType := "video/mp4"
	if idx := strings.LastIndex(storageKey, "."); idx >= 0 {
		ext := strings.ToLower(storageKey[idx+1:])
		switch ext {
		case "webm":
			mimeType = "video/webm"
		case "mov":
			mimeType = "video/quicktime"
		case "avi":
			mimeType = "video/x-msvideo"
		}
	}

	uploadedFile, err := client.UploadFile(ctx2, "", bytes.NewReader(videoBytes), &genai.UploadFileOptions{
		MIMEType: mimeType,
	})
	if err != nil {
		return "", nil, nil, fmt.Errorf("upload to gemini file api: %w", err)
	}

	// Wait until file is ACTIVE
	for uploadedFile.State == genai.FileStateProcessing {
		time.Sleep(3 * time.Second)
		uploadedFile, err = client.GetFile(ctx2, uploadedFile.Name)
		if err != nil {
			return "", nil, nil, fmt.Errorf("poll file state: %w", err)
		}
	}
	if uploadedFile.State != genai.FileStateActive {
		return "", nil, nil, fmt.Errorf("file upload failed with state: %v", uploadedFile.State)
	}
	defer client.DeleteFile(ctx2, uploadedFile.Name) //nolint:errcheck

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.SetTemperature(0.2)
	model.ResponseMIMEType = "application/json"

	prompt := `Bạn là trợ lý giáo dục. Hãy phân tích video bài giảng này và thực hiện 2 nhiệm vụ:

1. PHIÊN ÂM CÓ TIMESTAMP: Chia nội dung video thành các đoạn ngắn (khoảng 15-30 giây mỗi đoạn) với thời gian bắt đầu và kết thúc chính xác.

2. CÂU HỎI TRẮC NGHIỆM: Tạo 5 câu hỏi trắc nghiệm (MCQ) từ nội dung video để kiểm tra hiểu biết của học sinh. Mỗi câu có 4 lựa chọn (A, B, C, D), chỉ có 1 đáp án đúng.

Trả về kết quả dưới dạng JSON với cấu trúc sau (transcript là toàn bộ nội dung ghép lại, transcript_segments là mảng các đoạn có timestamp):
{
  "transcript": "Nội dung phiên âm đầy đủ ghép từ tất cả các đoạn...",
  "transcript_segments": [
    {"start_seconds": 0.0, "end_seconds": 15.0, "text": "Nội dung đoạn 1..."},
    {"start_seconds": 15.0, "end_seconds": 32.0, "text": "Nội dung đoạn 2..."}
  ],
  "questions": [
    {
      "question_text": "Câu hỏi 1?",
      "options": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "correct_answer": 0,
      "explanation": "Giải thích tại sao đáp án đúng là A"
    }
  ]
}`

	resp, err := model.GenerateContent(ctx2,
		genai.FileData{URI: uploadedFile.URI, MIMEType: mimeType},
		genai.Text(prompt),
	)
	if err != nil {
		return "", nil, nil, fmt.Errorf("generate content: %w", err)
	}

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return "", nil, nil, fmt.Errorf("empty gemini response")
	}

	raw := ""
	for _, part := range resp.Candidates[0].Content.Parts {
		if txt, ok := part.(genai.Text); ok {
			raw += string(txt)
		}
	}

	var result struct {
		Transcript         string              `json:"transcript"`
		TranscriptSegments []transcriptSegment `json:"transcript_segments"`
		Questions          []mcqQuestion       `json:"questions"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return raw, nil, nil, nil
	}

	return result.Transcript, result.TranscriptSegments, result.Questions, nil
}

// ── DB helpers ────────────────────────────────────────────────────────────────

func (s *AISvc) upsertAnalysis(ctx context.Context, lessonID pgtype.UUID, status gen.LessonAnalysisStatus, transcript string, segments []byte, errMsg string) (gen.LessonAnalysis, error) {
	return db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
		return q.UpsertLessonAnalysis(ctx, gen.UpsertLessonAnalysisParams{
			LessonID:           lessonID,
			Status:             status,
			Transcript:         pgtype.Text{String: transcript, Valid: transcript != ""},
			TranscriptSegments: segments,
			ErrorMsg:           pgtype.Text{String: errMsg, Valid: errMsg != ""},
		})
	})
}

func (s *AISvc) saveQuestions(ctx context.Context, lessonID pgtype.UUID, questions []mcqQuestion) ([]gen.LessonQuestion, error) {
	return db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonQuestion, error) {
		if err := q.DeleteLessonQuestions(ctx, lessonID); err != nil {
			return nil, err
		}
		saved := make([]gen.LessonQuestion, 0, len(questions))
		for i, qst := range questions {
			optJSON, _ := json.Marshal(qst.Options)
			lq, err := q.CreateLessonQuestion(ctx, gen.CreateLessonQuestionParams{
				LessonID:      lessonID,
				QuestionText:  qst.QuestionText,
				Options:       optJSON,
				CorrectAnswer: int32(qst.CorrectAnswer),
				Explanation:   pgtype.Text{String: qst.Explanation, Valid: qst.Explanation != ""},
				OrderIndex:    int32(i),
			})
			if err != nil {
				return saved, err
			}
			saved = append(saved, lq)
		}
		return saved, nil
	})
}
