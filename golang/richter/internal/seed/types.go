package seed

import (
	"fmt"
	"strings"
)

// devSeedData is the in-memory representation of all dev seed JSON files.
// Specs are grouped by entity (users/orgs/courses/etc.) so each seeder can
// iterate independently over its own slice.
type devSeedData struct {
	Users         []devUserSpec
	Organizations []devOrgSpec
	OrgMembers    []devOrgMemberSpec
	Courses       []devCourseSpec
	CourseMembers []devCourseMemberSpec
	Attempts      []devAttemptSpec
	Videos        []devVideoSpec
}

type devUserSpec struct {
	Email     string `json:"email"`
	Password  string `json:"password"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Role      string `json:"role"`
	Status    string `json:"status"`
}

type devOrgSpec struct {
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	CreatorEmail string `json:"creator_email"`
}

type devOrgMemberSpec struct {
	OrgSlug   string `json:"org_slug"`
	UserEmail string `json:"user_email"`
	Role      string `json:"role"`
	Status    string `json:"status"`
}

type devCourseSpec struct {
	OrgSlug     string          `json:"org_slug"`
	OwnerEmail  string          `json:"owner_email"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Status      string          `json:"status"`
	Modules     []devModuleSpec `json:"modules"`
}

type devModuleSpec struct {
	Title   string          `json:"title"`
	Lessons []devLessonSpec `json:"lessons"`
}

type devLessonSpec struct {
	Title        string           `json:"title"`
	Description  string           `json:"description"`
	Analysis     *devAnalysisSpec `json:"analysis,omitempty"`
	VideoKey     string           `json:"video_key,omitempty"`
	DurationSecs int32            `json:"duration_secs,omitempty"`
}

type devChunkSpec struct {
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Summary      string  `json:"summary"`
}

type devAnalysisSpec struct {
	Transcript string            `json:"transcript"`
	Chunks     []devChunkSpec    `json:"chunks"`
	Questions  []devQuestionSpec `json:"questions"`
}

type devQuestionSpec struct {
	QuestionText  string   `json:"question_text"`
	Options       []string `json:"options"`
	CorrectAnswer int32    `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
	StartSeconds  float64  `json:"start_seconds"`
}

type devVideoSpec struct {
	LocalPath string `json:"local_path"`
	S3Key     string `json:"s3_key"`
}

type devCourseMemberSpec struct {
	OrgSlug     string `json:"org_slug"`
	CourseTitle string `json:"course_title"`
	UserEmail   string `json:"user_email"`
	Role        string `json:"role"`
}

type devAttemptSpec struct {
	UserEmail          string  `json:"user_email"`
	OrgSlug            string  `json:"org_slug"`
	CourseTitle        string  `json:"course_title"`
	ModuleTitle        string  `json:"module_title"`
	LessonTitle        string  `json:"lesson_title"`
	Answers            []int32 `json:"answers"`
	VideoWatchFraction float32 `json:"video_watch_fraction"`
}

func parseDevData() (devSeedData, error) {
	var data devSeedData
	if err := readDevJSON("data/dev/users.json", &data.Users); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/organizations.json", &data.Organizations); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/org_members.json", &data.OrgMembers); err != nil {
		return devSeedData{}, err
	}
	entries, err := devDataFS.ReadDir("data/dev/courses")
	if err != nil {
		return devSeedData{}, fmt.Errorf("read courses dir: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var courses []devCourseSpec
		if err := readDevJSON("data/dev/courses/"+entry.Name(), &courses); err != nil {
			return devSeedData{}, err
		}
		data.Courses = append(data.Courses, courses...)
	}
	if err := readDevJSON("data/dev/course_members.json", &data.CourseMembers); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/quiz_attempts.json", &data.Attempts); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/videos.json", &data.Videos); err != nil {
		return devSeedData{}, err
	}
	return data, nil
}
