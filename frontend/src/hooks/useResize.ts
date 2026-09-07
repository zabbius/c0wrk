import { useRef, useCallback, useEffect, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

interface UseResizeOptions {
  initialWidth: number
  min: number
  max: number
  /** Set to -1 for right-side panels where drag-right should shrink. Default: 1. */
  direction?: 1 | -1
  /**
   * Which axis the handle drags along: 'x' (horizontal handle, resize by
   * width — the default) or 'y' (vertical handle, resize by height). The
   * keyboard mapping follows the axis: on 'y', ArrowUp shrinks and
   * ArrowDown grows (a bottom panel), mirroring the drag direction.
   */
  axis?: 'x' | 'y'
  onChange: (width: number) => void
}

interface UseResizeReturn {
  handleMouseDown: (e: ReactMouseEvent) => void
  handleKeyDown: (e: ReactKeyboardEvent) => void
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

export function useResize({ initialWidth, min, max, direction = 1, axis = 'x', onChange }: UseResizeOptions): UseResizeReturn {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(initialWidth)
  const moveRef = useRef<((ev: globalThis.MouseEvent) => void) | null>(null)
  const upRef = useRef<(() => void) | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // The row-variant drag cursor class (see index.css): the column variant is
  // the default 'resize-dragging'.
  const dragClass = axis === 'y' ? 'resize-dragging-row' : 'resize-dragging'

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (moveRef.current) document.removeEventListener('mousemove', moveRef.current)
      if (upRef.current) document.removeEventListener('mouseup', upRef.current)
      dragging.current = false
      document.body.classList.remove(dragClass)
    }
  }, [dragClass])

  const handleMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = axis === 'y' ? e.clientY : e.clientX
    startWidth.current = initialWidth

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ((axis === 'y' ? ev.clientY : ev.clientX) - startX.current) * direction
      onChangeRef.current(clamp(startWidth.current + delta, min, max))
    }

    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.classList.remove(dragClass)
      moveRef.current = null
      upRef.current = null
    }

    // Clean up any stale handlers
    if (moveRef.current) document.removeEventListener('mousemove', moveRef.current)
    if (upRef.current) document.removeEventListener('mouseup', upRef.current)

    moveRef.current = onMouseMove
    upRef.current = onMouseUp
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.classList.add(dragClass)
  }, [initialWidth, min, max, direction, axis, dragClass])

  const handleKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 50 : 10
    // Axis-aware keys: on 'x' the left/up pair shrinks; on 'y' (a bottom
    // panel with a horizontal handle) up shrinks and down grows, matching
    // the drag direction.
    const shrinkKey = axis === 'y' ? 'ArrowUp' : 'ArrowLeft'
    const growKey = axis === 'y' ? 'ArrowDown' : 'ArrowRight'
    if (e.key === shrinkKey || (axis === 'x' && e.key === 'ArrowUp')) {
      e.preventDefault()
      onChangeRef.current(clamp(initialWidth - step * direction, min, max))
    } else if (e.key === growKey || (axis === 'x' && e.key === 'ArrowDown')) {
      e.preventDefault()
      onChangeRef.current(clamp(initialWidth + step * direction, min, max))
    }
  }, [initialWidth, min, max, direction, axis])

  return { handleMouseDown, handleKeyDown }
}
