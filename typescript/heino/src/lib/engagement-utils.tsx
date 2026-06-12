import { Badge } from "@/components/ui/badge";

/** Return a rendered Badge for an engagement score (0–100). */
export function engagementBadge(score: number): React.ReactElement {
  if (score >= 70)
    return (
      <Badge className="bg-green-100 text-green-800 border-green-300 hover:bg-green-100">
        {score.toFixed(0)}
      </Badge>
    );
  if (score >= 40)
    return (
      <Badge className="bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100">
        {score.toFixed(0)}
      </Badge>
    );
  return (
    <Badge className="bg-red-100 text-red-800 border-red-300 hover:bg-red-100">
      {score.toFixed(0)}
    </Badge>
  );
}
