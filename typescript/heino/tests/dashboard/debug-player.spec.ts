import { test, expect, goToSeededLesson, SEED_DSA_LESSON_BIG_O as SEEDED_LESSON } from "../fixtures";
import path from "path";

test("debug player layout and styles", async ({ teacherPage: page }) => {
  // 1. Navigate to the teacher view
  const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
  console.log("NAVIGATED TO TEACHER DETAIL PAGE:", lessonHref);
  
  // Wait for the video player container to be visible
  const playerContainer = page.locator('[data-testid="video-player"]');
  await expect(playerContainer).toBeVisible();

  // Print container box and classes
  const containerBox = await playerContainer.boundingBox();
  console.log("CONTAINER BOUNDING BOX:", containerBox);

  // Dump elements under data-testid="video-player"
  const innerHtml = await playerContainer.innerHTML();
  console.log("CONTAINER INNER HTML:", innerHtml);

  // Take a screenshot of the teacher view
  await page.screenshot({ path: "scratch_teacher_player.png" });
  console.log("SAVED SCRATCH TEACHER SCREENSHOT");

  // 2. Navigate to preview mode
  await page.goto(`${lessonHref}?preview=1`);
  console.log("NAVIGATED TO PREVIEW PAGE");
  
  const previewPlayer = page.locator('[data-testid="video-player"]');
  await expect(previewPlayer).toBeVisible();

  const previewBox = await previewPlayer.boundingBox();
  console.log("PREVIEW CONTAINER BOUNDING BOX:", previewBox);

  // Wait a bit and take a screenshot of preview mode
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "scratch_preview_player.png" });
  console.log("SAVED SCRATCH PREVIEW SCREENSHOT");
});
