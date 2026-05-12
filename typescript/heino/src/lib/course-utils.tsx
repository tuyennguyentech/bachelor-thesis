import { Badge } from "@/components/ui/badge";
import { CourseStatus } from "buf/gen/richter/v1/courses_pb";

export function courseStatusBadge(status: CourseStatus) {
  if (status === CourseStatus.PUBLISHED)
    return <Badge variant="outline" className="border-green-500 text-green-600">Đã xuất bản</Badge>;
  if (status === CourseStatus.DRAFT)
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">Nháp</Badge>;
  return <Badge variant="secondary">Lưu trữ</Badge>;
}

export function courseStatusLabel(status: CourseStatus): string {
  switch (status) {
    case CourseStatus.PUBLISHED: return "Đã xuất bản";
    case CourseStatus.DRAFT:     return "Nháp";
    case CourseStatus.ARCHIVED:  return "Lưu trữ";
    default:                     return "Không xác định";
  }
}
