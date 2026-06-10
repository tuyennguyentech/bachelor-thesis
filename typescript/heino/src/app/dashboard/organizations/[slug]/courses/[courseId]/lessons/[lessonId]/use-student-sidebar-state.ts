"use client";

import { useEffect, useState } from "react";

const STUDENT_SIDEBAR_KEY = "dyadia_student_sidebar_open";

export function useStudentSidebarState() {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const saved = localStorage.getItem(STUDENT_SIDEBAR_KEY);
      if (saved !== null) {
        setSidebarOpen(saved === "true");
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  const handleToggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(STUDENT_SIDEBAR_KEY, String(open));
  };

  return { handleToggleSidebar, sidebarOpen };
}
