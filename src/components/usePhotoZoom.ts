"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_SLOP_PX = 32;
const TAP_MOVE_SLOP_PX = 10;
const AXIS_LOCK_PX = 12;
const SWIPE_DISTANCE_PX = 60;
const DISMISS_DISTANCE_PX = 90;
const CLICK_SUPPRESS_MS = 400;
const SPRING = "transform 280ms cubic-bezier(0.2, 0.75, 0.2, 1)";

type GestureMode =
  | "idle"
  | "undecided"
  | "pinch"
  | "pan"
  | "swipe"
  | "dismiss";

interface GestureState {
  pointers: Map<number, { x: number; y: number }>;
  mode: GestureMode;
  scale: number;
  tx: number;
  ty: number;
  startScale: number;
  startTx: number;
  startTy: number;
  startDistance: number;
  startMidX: number;
  startMidY: number;
  startX: number;
  startY: number;
  dragDx: number;
  dragDy: number;
  moved: boolean;
  downOnImage: boolean;
  downOnBackdrop: boolean;
  lastTapTime: number;
  lastTapX: number;
  lastTapY: number;
  suppressClickUntil: number;
}

interface UsePhotoZoomOptions {
  imageRef: RefObject<HTMLImageElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  backdropRef: RefObject<HTMLButtonElement | null>;
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  onSwipePrevious: () => void;
  onSwipeNext: () => void;
  onDismiss: () => void;
  onTapOutside: () => void;
  onZoomStart: () => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function usePhotoZoom({
  imageRef,
  stageRef,
  backdropRef,
  canSwipePrevious,
  canSwipeNext,
  onSwipePrevious,
  onSwipeNext,
  onDismiss,
  onTapOutside,
  onZoomStart,
}: UsePhotoZoomOptions) {
  const [zoomed, setZoomed] = useState(false);
  const transitionTimer = useRef<number | null>(null);
  const gesture = useRef<GestureState>({
    pointers: new Map(),
    mode: "idle",
    scale: 1,
    tx: 0,
    ty: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    startDistance: 0,
    startMidX: 0,
    startMidY: 0,
    startX: 0,
    startY: 0,
    dragDx: 0,
    dragDy: 0,
    moved: false,
    downOnImage: false,
    downOnBackdrop: false,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
    suppressClickUntil: 0,
  });

  const clearTransitionSoon = useCallback(() => {
    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
    }
    transitionTimer.current = window.setTimeout(() => {
      const image = imageRef.current;
      if (image) image.style.transition = "";
      transitionTimer.current = null;
    }, 320);
  }, [imageRef]);

  const stageCenter = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [stageRef]);

  const clampOffsets = useCallback(
    (scale: number, tx: number, ty: number) => {
      const image = imageRef.current;
      const stage = stageRef.current;
      if (!image || !stage) return { tx, ty };

      const boundX = Math.max(
        0,
        (image.offsetWidth * scale - stage.clientWidth) / 2,
      );
      const boundY = Math.max(
        0,
        (image.offsetHeight * scale - stage.clientHeight) / 2,
      );
      return {
        tx: clamp(tx, -boundX, boundX),
        ty: clamp(ty, -boundY, boundY),
      };
    },
    [imageRef, stageRef],
  );

  const applyTransform = useCallback(
    (spring: boolean) => {
      const image = imageRef.current;
      if (!image) return;

      const { scale, tx, ty } = gesture.current;
      image.style.transition = spring ? SPRING : "none";
      image.style.transform =
        scale === 1 && tx === 0 && ty === 0
          ? ""
          : `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
      if (spring) clearTransitionSoon();
    },
    [clearTransitionSoon, imageRef],
  );

  const restoreBackdrop = useCallback(
    (spring: boolean) => {
      const backdrop = backdropRef.current;
      if (!backdrop) return;
      backdrop.style.transition = spring ? "opacity 220ms ease" : "none";
      backdrop.style.opacity = "";
    },
    [backdropRef],
  );

  const resetZoom = useCallback(
    (spring = true) => {
      const state = gesture.current;
      state.scale = 1;
      state.tx = 0;
      state.ty = 0;
      state.mode = "idle";
      state.pointers.clear();
      applyTransform(spring);
      restoreBackdrop(spring);
      setZoomed(false);
    },
    [applyTransform, restoreBackdrop],
  );

  const commitZoomTo = useCallback(
    (clientX: number, clientY: number) => {
      const state = gesture.current;
      onZoomStart();
      const center = stageCenter();
      const scale = DOUBLE_TAP_SCALE;
      const anchorX = clientX - center.x;
      const anchorY = clientY - center.y;
      const clamped = clampOffsets(
        scale,
        anchorX * (1 - scale),
        anchorY * (1 - scale),
      );
      state.scale = scale;
      state.tx = clamped.tx;
      state.ty = clamped.ty;
      applyTransform(true);
      setZoomed(true);
    },
    [applyTransform, clampOffsets, onZoomStart, stageCenter],
  );

  const toggleZoom = useCallback(
    (clientX: number, clientY: number) => {
      if (gesture.current.scale > 1) resetZoom(true);
      else commitZoomTo(clientX, clientY);
    },
    [commitZoomTo, resetZoom],
  );

  const suppressClicks = useCallback(() => {
    gesture.current.suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
  }, []);

  const shouldSuppressClick = useCallback(
    () => Date.now() < gesture.current.suppressClickUntil,
    [],
  );

  const gestureTargetAllowed = useCallback((target: EventTarget | null) => {
    return !(target instanceof Element
      ? target.closest(".lightbox__topbar, .lightbox__nav")
      : false);
  }, []);

  const beginPinch = useCallback(() => {
    const state = gesture.current;
    const [first, second] = Array.from(state.pointers.values());
    if (!first || !second) return;

    // Interrupting a swipe/dismiss drag: put the photo back first.
    if (state.mode === "swipe" || state.mode === "dismiss") {
      restoreBackdrop(false);
    }

    const center = stageCenter();
    state.mode = "pinch";
    state.startDistance = Math.max(distance(first, second), 1);
    state.startMidX = (first.x + second.x) / 2 - center.x;
    state.startMidY = (first.y + second.y) / 2 - center.y;
    state.startScale = state.scale;
    state.startTx = state.tx;
    state.startTy = state.ty;
    state.moved = true;
    onZoomStart();
    suppressClicks();
  }, [onZoomStart, restoreBackdrop, stageCenter, suppressClicks]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!gestureTargetAllowed(event.target)) return;

      const state = gesture.current;
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
      }

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; gestures still work via bubbling.
      }

      state.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (state.pointers.size === 2) {
        beginPinch();
        return;
      }
      if (state.pointers.size !== 1) return;

      state.startX = event.clientX;
      state.startY = event.clientY;
      state.startTx = state.tx;
      state.startTy = state.ty;
      state.dragDx = 0;
      state.dragDy = 0;
      state.moved = false;
      state.downOnImage = event.target === imageRef.current;
      state.downOnBackdrop = event.target === backdropRef.current;
      state.mode =
        state.scale > 1
          ? "pan"
          : event.pointerType === "mouse"
            ? "idle"
            : "undecided";
    },
    [backdropRef, beginPinch, gestureTargetAllowed, imageRef],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = gesture.current;
      const pointer = state.pointers.get(event.pointerId);
      if (!pointer) return;

      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (state.mode === "pinch") {
        const [first, second] = Array.from(state.pointers.values());
        if (!first || !second) return;

        const center = stageCenter();
        const nextScale = clamp(
          (state.startScale * distance(first, second)) / state.startDistance,
          1,
          MAX_SCALE,
        );
        const midX = (first.x + second.x) / 2 - center.x;
        const midY = (first.y + second.y) / 2 - center.y;
        const anchorX = (state.startMidX - state.startTx) / state.startScale;
        const anchorY = (state.startMidY - state.startTy) / state.startScale;
        const next = clampOffsets(
          nextScale,
          midX - anchorX * nextScale,
          midY - anchorY * nextScale,
        );

        state.scale = nextScale;
        state.tx = next.tx;
        state.ty = next.ty;
        applyTransform(false);
        return;
      }

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      state.dragDx = dx;
      state.dragDy = dy;
      if (
        Math.abs(dx) > TAP_MOVE_SLOP_PX ||
        Math.abs(dy) > TAP_MOVE_SLOP_PX
      ) {
        state.moved = true;
      }

      if (state.mode === "pan") {
        const next = clampOffsets(
          state.scale,
          state.startTx + dx,
          state.startTy + dy,
        );
        state.tx = next.tx;
        state.ty = next.ty;
        applyTransform(false);
        return;
      }

      if (state.mode === "undecided") {
        if (Math.abs(dx) > AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy)) {
          state.mode = "swipe";
        } else if (
          Math.abs(dy) > AXIS_LOCK_PX &&
          Math.abs(dy) > Math.abs(dx)
        ) {
          state.mode = "dismiss";
        } else {
          return;
        }
      }

      const image = imageRef.current;
      if (!image) return;

      if (state.mode === "swipe") {
        const resistance =
          (dx > 0 && !canSwipePrevious) || (dx < 0 && !canSwipeNext)
            ? 0.3
            : 1;
        image.style.transition = "none";
        image.style.transform = `translate3d(${dx * resistance}px, 0, 0)`;
        return;
      }

      if (state.mode === "dismiss") {
        const shrink = 1 - Math.min(Math.abs(dy) / 1400, 0.08);
        image.style.transition = "none";
        image.style.transform = `translate3d(0, ${dy}px, 0) scale(${shrink})`;

        const backdrop = backdropRef.current;
        if (backdrop) {
          backdrop.style.transition = "none";
          backdrop.style.opacity = String(
            1 - Math.min(Math.abs(dy) / 260, 0.55),
          );
        }
      }
    },
    [
      applyTransform,
      backdropRef,
      canSwipeNext,
      canSwipePrevious,
      clampOffsets,
      imageRef,
      stageCenter,
    ],
  );

  const endPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const state = gesture.current;
      if (!state.pointers.has(event.pointerId)) return;

      const endedMode = state.mode;
      state.pointers.delete(event.pointerId);

      if (endedMode === "pinch") {
        if (state.pointers.size >= 2) return;

        if (state.scale <= 1.02) {
          resetZoom(true);
        } else {
          setZoomed(true);
        }
        suppressClicks();

        const remaining = Array.from(state.pointers.values())[0];
        if (remaining && state.scale > 1) {
          state.mode = "pan";
          state.startX = remaining.x;
          state.startY = remaining.y;
          state.startTx = state.tx;
          state.startTy = state.ty;
        } else {
          state.mode = "idle";
        }
        return;
      }

      if (state.pointers.size > 0) return;
      state.mode = "idle";

      if (endedMode === "pan") {
        if (state.moved) suppressClicks();
        return;
      }

      if (endedMode === "swipe") {
        suppressClicks();
        const dx = state.dragDx;
        if (dx >= SWIPE_DISTANCE_PX && canSwipePrevious) {
          onSwipePrevious();
          return;
        }
        if (dx <= -SWIPE_DISTANCE_PX && canSwipeNext) {
          onSwipeNext();
          return;
        }
        const image = imageRef.current;
        if (image) {
          image.style.transition = SPRING;
          image.style.transform = "";
          clearTransitionSoon();
        }
        return;
      }

      if (endedMode === "dismiss") {
        suppressClicks();
        if (Math.abs(state.dragDy) >= DISMISS_DISTANCE_PX) {
          onDismiss();
          return;
        }
        const image = imageRef.current;
        if (image) {
          image.style.transition = SPRING;
          image.style.transform = "";
          clearTransitionSoon();
        }
        restoreBackdrop(true);
        return;
      }

      // Tap handling for "undecided" (touch) and "idle" (mouse) endings.
      if (cancelled || state.moved) {
        if (state.moved) suppressClicks();
        return;
      }

      if (state.downOnBackdrop) {
        suppressClicks();
        onTapOutside();
        return;
      }

      if (event.pointerType !== "mouse" && state.downOnImage) {
        const now = Date.now();
        const isDoubleTap =
          now - state.lastTapTime < DOUBLE_TAP_WINDOW_MS &&
          Math.hypot(
            event.clientX - state.lastTapX,
            event.clientY - state.lastTapY,
          ) < DOUBLE_TAP_SLOP_PX;

        if (isDoubleTap) {
          state.lastTapTime = 0;
          toggleZoom(event.clientX, event.clientY);
        } else {
          state.lastTapTime = now;
          state.lastTapX = event.clientX;
          state.lastTapY = event.clientY;
        }
      }
    },
    [
      canSwipeNext,
      canSwipePrevious,
      clearTransitionSoon,
      imageRef,
      onDismiss,
      onSwipeNext,
      onSwipePrevious,
      onTapOutside,
      resetZoom,
      restoreBackdrop,
      suppressClicks,
      toggleZoom,
    ],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => endPointer(event, false),
    [endPointer],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => endPointer(event, true),
    [endPointer],
  );

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!gestureTargetAllowed(event.target)) return;
      if (event.target !== imageRef.current) return;
      toggleZoom(event.clientX, event.clientY);
    },
    [gestureTargetAllowed, imageRef, toggleZoom],
  );

  return {
    zoomed,
    resetZoom,
    shouldSuppressClick,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onDoubleClick,
    },
  };
}
