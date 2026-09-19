// Shared primitives for the small 2D canvas panels (PopChart, RateChart).

export const AXIS_COLOR = 'rgba(255, 255, 255, 0.12)'
export const LABEL_COLOR = '#6b7484'

export function scaleCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

export function fmtTime(t) {
  if (!isFinite(t)) return '—'
  return Math.abs(t) >= 10 ? t.toFixed(0) : t.toFixed(1)
}

export function drawAxisMax(ctx, x, y, text, align, baseline, size = 9) {
  ctx.fillStyle = LABEL_COLOR
  ctx.font = `${size}px system-ui, sans-serif`
  ctx.textAlign = align
  ctx.textBaseline = baseline
  ctx.fillText(text, x, y)
}

export function drawYLabel(ctx, pad, h, text) {
  ctx.save()
  ctx.fillStyle = LABEL_COLOR
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.translate(pad.l - 3, (pad.t + h - pad.b) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

export function drawAxes(ctx, pad, w, h, xLabel) {
  ctx.strokeStyle = AXIS_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad.l, pad.t)
  ctx.lineTo(pad.l, h - pad.b)
  ctx.lineTo(w - pad.r, h - pad.b)
  ctx.stroke()
  if (xLabel) {
    ctx.fillStyle = LABEL_COLOR
    ctx.font = '9px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(xLabel, (pad.l + w - pad.r) / 2, h - 3)
  }
}
