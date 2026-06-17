import type { Metadata } from "next";
import "./globals.css";
import "vidstack/styles/base.css";
import "vidstack/styles/defaults.css";
import "vidstack/styles/community-skin/video.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";

// Font: match how soict.hust.edu.vn actually renders. Its Flatsome theme declares
// `body{font-family:"Roboto"}` but the Roboto webfont never loads there, so the
// site you see is the plain Arial/Helvetica fallback (Liberation Sans on Linux).
// We therefore use the same Arial-first system stack instead of a real Roboto
// webfont — no download, identical look to the live site. The stack lives in
// globals.css (`--font-sans`); nothing to load here.

export const metadata: Metadata = {
  title: "Dyadia",
  description: "Nền tảng học tập chủ động qua video bài giảng",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="vi"
      className={cn("h-full antialiased font-sans")}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background">
        <ThemeProvider
          defaultTheme="system"
        >
          {children}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
