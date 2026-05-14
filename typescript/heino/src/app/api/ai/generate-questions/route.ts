import { type NextRequest } from "next/server";
import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { AIService, GenerateQuestionsStep } from "buf/gen/richter/v1/ai_pb";

export async function GET(request: NextRequest) {
  const lessonId = request.nextUrl.searchParams.get("lessonId");
  if (!lessonId) {
    return new Response("Missing lessonId", { status: 400 });
  }
  const chunkId = request.nextUrl.searchParams.get("chunkId") ?? "";
  const forceRegenerate = request.nextUrl.searchParams.get("forceRegenerate") === "1";

  let token: string;
  try {
    const session = await requireAnyUser();
    token = session.token;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createRichterClient(AIService, token);
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      const send = (step: number, message: string, chunkIndex: number, totalChunks: number) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ step, message, chunkIndex, totalChunks })}\n\n`),
        );
      };

      try {
        for await (const event of client.generateQuestionsStream({ lessonId, chunkId, forceRegenerate })) {
          send(event.step, event.message, event.chunkIndex, event.totalChunks);
        }
      } catch {
        send(GenerateQuestionsStep.ERROR, "Tạo câu hỏi thất bại. Vui lòng thử lại.", 0, 0);
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
