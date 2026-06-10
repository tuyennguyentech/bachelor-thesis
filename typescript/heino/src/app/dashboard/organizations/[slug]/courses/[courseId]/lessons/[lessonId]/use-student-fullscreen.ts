"use client";

import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

interface FullscreenExtensions {
  webkitFullscreenElement?: Element;
  mozFullScreenElement?: Element;
  msFullscreenElement?: Element;
  webkitExitFullscreen?: () => void;
  webkitRequestFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
}

interface UseStudentFullscreenInput {
  activeId: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export function useStudentFullscreen({
  activeId,
  containerRef,
  videoRef,
}: UseStudentFullscreenInput) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenTip, setShowFullscreenTip] = useState(false);

  const isNativeVideoFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return false;
    const docExt = document as Document & FullscreenExtensions;
    const vidExt = video as HTMLVideoElement & FullscreenExtensions;
    return (
      document.fullscreenElement === video ||
      docExt.webkitFullscreenElement === video ||
      docExt.mozFullScreenElement === video ||
      docExt.msFullscreenElement === video ||
      vidExt.webkitDisplayingFullscreen === true
    );
  }, [videoRef]);

  const exitNativeVideoFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const vidExt = video as HTMLVideoElement & FullscreenExtensions;
    const docExt = document as Document & FullscreenExtensions;
    try {
      if (typeof vidExt.webkitExitFullscreen === "function") {
        vidExt.webkitExitFullscreen();
      } else if (typeof document.exitFullscreen === "function") {
        document.exitFullscreen();
      } else if (typeof docExt.webkitExitFullscreen === "function") {
        docExt.webkitExitFullscreen();
      }
    } catch {
      // Browser-specific fullscreen APIs fail silently in some embedded contexts.
    }
  }, [videoRef]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const docExt = document as Document & FullscreenExtensions;
    const contExt = container as HTMLDivElement & FullscreenExtensions;
    if (!document.fullscreenElement && !docExt.webkitFullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (contExt.webkitRequestFullscreen) {
        contExt.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (docExt.webkitExitFullscreen) {
        docExt.webkitExitFullscreen();
      }
    }
  }, [containerRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleNativeFullscreenRedirect = () => {
      if (isNativeVideoFullscreen()) {
        exitNativeVideoFullscreen();
        if (!isFullscreen) {
          setShowFullscreenTip(true);
        }
      }
    };

    const handleWebkitBeginFullscreen = (e: Event) => {
      e.preventDefault();
      exitNativeVideoFullscreen();
      if (!isFullscreen) {
        setShowFullscreenTip(true);
      }
    };

    document.addEventListener("fullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("webkitfullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("mozfullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("MSFullscreenChange", handleNativeFullscreenRedirect);
    video.addEventListener("webkitbeginfullscreen", handleWebkitBeginFullscreen);

    return () => {
      document.removeEventListener("fullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("webkitfullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("mozfullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("MSFullscreenChange", handleNativeFullscreenRedirect);
      video.removeEventListener("webkitbeginfullscreen", handleWebkitBeginFullscreen);
    };
  }, [exitNativeVideoFullscreen, isFullscreen, isNativeVideoFullscreen, videoRef]);

  useEffect(() => {
    if (activeId && isNativeVideoFullscreen()) {
      exitNativeVideoFullscreen();
    }
  }, [activeId, exitNativeVideoFullscreen, isNativeVideoFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleDblClick = (e: MouseEvent) => {
      e.preventDefault();
      toggleFullscreen();
    };

    video.addEventListener("dblclick", handleDblClick);
    return () => {
      video.removeEventListener("dblclick", handleDblClick);
    };
  }, [toggleFullscreen, videoRef]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.hasAttribute("contenteditable"))
      ) {
        return;
      }
      e.preventDefault();
      toggleFullscreen();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
    };
  }, [containerRef]);

  return {
    isFullscreen,
    setShowFullscreenTip,
    showFullscreenTip,
    toggleFullscreen,
  };
}
