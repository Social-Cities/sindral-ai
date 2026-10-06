import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Workflow, WorkflowEdge, WorkflowStep } from '@sindral/shared';
import { FEEDBACK_EVENT, REJECT_EVENT } from '@sindral/shared';

export const NODE_W = 130;
export const NODE_H = 44;
const MIN_W = 520;
const MIN_H = 320;
const PAD = 40;

type Point = { x: number; y: number };

/** Positions for every step: explicit `position` or a simple grid fallback. */
export function layoutPositions(workflow: Pick<Workflow, 'steps'>): Record<string, Point> {
  const positions: Record<string, Point> = {};
  const unpositioned = workflow.steps.filter((s) => !s.position);
  const cols = Math.max(1, Math.ceil(Math.sqrt(unpositioned.length)));
  let i = 0;
  for (const step of workflow.steps) {
    if (step.position) {
      positions[step.id] = step.position;
    } else {
      positions[step.id] = { x: 50 + (i % cols) * 170, y: 60 + Math.floor(i / cols) * 120 };
      i += 1;
    }
  }
  return positions;
}

/** Where a line from a node's centre in direction (dx, dy) exits its rectangle. */
function borderPoint(center: Point, dx: number, dy: number): Point {
  const hw = NODE_W / 2;
  const hh = NODE_H / 2;
  if (dx === 0 && dy === 0) return center;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

function Arrow({ from, to, label, dashed, curveSign }: { from: Point; to: Point; label?: string; dashed: boolean; curveSign: 1 | -1 }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const curve = 20 * curveSign;
  const start = borderPoint(from, dx, dy);
  const end = borderPoint(to, -dx, -dy);
  const cx = (start.x + end.x) / 2 + nx * curve;
  const cy = (start.y + end.y) / 2 + ny * curve;
  const angle = Math.atan2(end.y - cy, end.x - cx);
  const arrowLen = 7;
  const ax1 = end.x - arrowLen * Math.cos(angle - 0.4);
  const ay1 = end.y - arrowLen * Math.sin(angle - 0.4);
  const ax2 = end.x - arrowLen * Math.cos(angle + 0.4);
  const ay2 = end.y - arrowLen * Math.sin(angle + 0.4);
  // Point on the curve at t = 0.5 for the label.
  const lx = 0.25 * start.x + 0.5 * cx + 0.25 * end.x;
  const ly = 0.25 * start.y + 0.5 * cy + 0.25 * end.y;
  return (
    <g className="pointer-events-none">
      <path d={`M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`} fill="none" stroke="var(--color-canvas-edge)" strokeWidth="1.5" strokeDasharray={dashed ? '4 3' : undefined} />
      <path d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill="none" stroke="var(--color-canvas-edge)" strokeWidth="1.5" strokeLinejoin="round" />
      {label && (
        <text x={lx} y={ly - 6} textAnchor="middle" fontSize="9" fill="var(--color-canvas-label)" fontFamily="JetBrains Mono, monospace">
          {label}
        </text>
      )}
    </g>
  );
}

function SelfLoop({ at, label, dashed }: { at: Point; label?: string; dashed: boolean }) {
  const x = at.x + NODE_W / 2 - 10;
  const y = at.y;
  return (
    <g className="pointer-events-none">
      <path d={`M ${x - 20} ${y} C ${x - 20} ${y - 30}, ${x + 20} ${y - 30}, ${x + 20} ${y}`} fill="none" stroke="var(--color-canvas-edge)" strokeWidth="1.5" strokeDasharray={dashed ? '4 3' : undefined} />
      <path d={`M ${x + 16} ${y - 6} L ${x + 20} ${y} L ${x + 24} ${y - 6}`} fill="none" stroke="var(--color-canvas-edge)" strokeWidth="1.5" strokeLinejoin="round" />
      {label && (
        <text x={x} y={y - 26} textAnchor="middle" fontSize="9" fill="var(--color-canvas-label)" fontFamily="JetBrains Mono, monospace">
          {label}
        </text>
      )}
    </g>
  );
}

const NODE_STYLE: Record<WorkflowStep['type'], { fill: string; fillSelected: string; stroke: string; strokeSelected: string; text: string; dash?: string; glyph: string }> = {
  agent: { fill: 'var(--color-node-agent-fill)', fillSelected: 'var(--color-node-agent-fill-selected)', stroke: 'var(--color-node-agent-stroke)', strokeSelected: 'var(--color-node-agent-stroke-selected)', text: 'var(--color-node-agent-text)', glyph: '◆ agent' },
  human: { fill: 'var(--color-node-human-fill)', fillSelected: 'var(--color-node-human-fill-selected)', stroke: 'var(--color-node-human-stroke)', strokeSelected: 'var(--color-node-human-stroke-selected)', text: 'var(--color-node-human-text)', dash: '4 3', glyph: '◇ human' },
  end: { fill: 'var(--color-node-end-fill)', fillSelected: 'var(--color-node-end-fill-selected)', stroke: 'var(--color-node-end-stroke)', strokeSelected: 'var(--color-node-end-stroke-selected)', text: 'var(--color-node-end-text)', glyph: '● end' },
};

interface NodeProps {
  step: WorkflowStep;
  pos: Point;
  selected: boolean;
  isEntry: boolean;
  onPointerDown: (e: PointerEvent<SVGGElement>, stepId: string) => void;
  onKeyDown: (e: KeyboardEvent<SVGGElement>, stepId: string) => void;
  onDelete?: (stepId: string) => void;
}

function WorkflowNode({ step, pos, selected, isEntry, onPointerDown, onKeyDown, onDelete }: NodeProps) {
  const style = NODE_STYLE[step.type];
  return (
    <g
      transform={`translate(${pos.x}, ${pos.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${step.type} step ${step.label}${selected ? ' (selected)' : ''}`}
      aria-pressed={selected}
      data-testid={`node-${step.id}`}
      onPointerDown={(e) => onPointerDown(e, step.id)}
      onKeyDown={(e) => onKeyDown(e, step.id)}
      style={{ cursor: 'grab', outline: 'none' }}
    >
      <rect
        x={0}
        y={0}
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill={selected ? style.fillSelected : style.fill}
        stroke={selected ? style.strokeSelected : style.stroke}
        strokeWidth={1.5}
        strokeDasharray={style.dash}
      />
      {isEntry && <circle cx={0} cy={NODE_H / 2} r={3} fill="var(--color-accent)" />}
      <text x={NODE_W / 2} y={16} textAnchor="middle" fontSize="9" fill={style.text} fontFamily="JetBrains Mono, monospace" fontWeight="500">
        {style.glyph}
      </text>
      <text x={NODE_W / 2} y={30} textAnchor="middle" fontSize="11" fill={selected ? 'var(--color-foreground)' : 'var(--color-secondary-foreground)'} fontFamily="Inter, sans-serif" fontWeight="500">
        {step.label.length > 20 ? `${step.label.slice(0, 19)}…` : step.label}
      </text>
      {selected && onDelete && (
        <g
          role="button"
          tabIndex={0}
          aria-label={`Delete step ${step.label}`}
          transform={`translate(${NODE_W - 2}, 2)`}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDelete(step.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onDelete(step.id);
            }
          }}
        >
          <circle r={7} fill="var(--color-card)" stroke="color-mix(in srgb, var(--color-danger) 45%, transparent)" strokeWidth={1} />
          <path d="M-2.5 -2.5L2.5 2.5M2.5 -2.5L-2.5 2.5" stroke="var(--color-danger)" strokeWidth="1.2" strokeLinecap="round" />
        </g>
      )}
    </g>
  );
}

interface WorkflowCanvasProps {
  workflow: Workflow;
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
  onMoveStep?: (stepId: string, position: Point) => void;
  onDeleteStep?: (stepId: string) => void;
}

interface DragState {
  stepId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  current: Point;
  moved: boolean;
}

export function WorkflowCanvas({ workflow, selectedStepId, onSelectStep, onMoveStep, onDeleteStep }: WorkflowCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const positions = useMemo(() => layoutPositions(workflow), [workflow]);
  const effective = useMemo(() => {
    if (!drag) return positions;
    return { ...positions, [drag.stepId]: drag.current };
  }, [positions, drag]);

  const size = useMemo(() => {
    let w = MIN_W;
    let h = MIN_H;
    for (const p of Object.values(effective)) {
      w = Math.max(w, p.x + NODE_W + PAD);
      h = Math.max(h, p.y + NODE_H + PAD);
    }
    return { w, h };
  }, [effective]);

  const scale = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return 1;
    const rect = svg.getBoundingClientRect();
    return rect.width > 0 ? size.w / rect.width : 1;
  }, [size.w]);

  const handlePointerDown = useCallback(
    (e: PointerEvent<SVGGElement>, stepId: string) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const origin = positions[stepId] ?? { x: 0, y: 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag({ stepId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin, current: origin, moved: false });
    },
    [positions],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const k = scale();
      const dx = (e.clientX - drag.startX) * k;
      const dy = (e.clientY - drag.startY) * k;
      const moved = drag.moved || Math.hypot(dx, dy) > 3;
      if (!moved) return;
      const current = { x: Math.max(0, Math.round(drag.origin.x + dx)), y: Math.max(0, Math.round(drag.origin.y + dy)) };
      setDrag({ ...drag, current, moved: true });
    },
    [drag, scale],
  );

  const endDrag = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.moved) {
        onMoveStep?.(drag.stepId, drag.current);
        onSelectStep(drag.stepId);
      } else {
        onSelectStep(selectedStepId === drag.stepId ? null : drag.stepId);
      }
      setDrag(null);
    },
    [drag, onMoveStep, onSelectStep, selectedStepId],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<SVGGElement>, stepId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectStep(selectedStepId === stepId ? null : stepId);
        return;
      }
      const delta = e.shiftKey ? 20 : 5;
      const pos = positions[stepId];
      if (!pos || !onMoveStep) return;
      const moves: Record<string, Point> = {
        ArrowUp: { x: pos.x, y: Math.max(0, pos.y - delta) },
        ArrowDown: { x: pos.x, y: pos.y + delta },
        ArrowLeft: { x: Math.max(0, pos.x - delta), y: pos.y },
        ArrowRight: { x: pos.x + delta, y: pos.y },
      };
      const next = moves[e.key];
      if (next) {
        e.preventDefault();
        onMoveStep(stepId, next);
      }
    },
    [positions, onMoveStep, onSelectStep, selectedStepId],
  );

  const edgeCurveSign = (edge: WorkflowEdge): 1 | -1 => (edge.event === FEEDBACK_EVENT || edge.event === REJECT_EVENT ? -1 : 1);

  return (
    <svg
      ref={svgRef}
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      style={{ overflow: 'visible', touchAction: 'none', maxWidth: '100%' }}
      role="img"
      aria-label={`Workflow graph for ${workflow.name}`}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).getAttribute('data-canvas-bg') === 'true') onSelectStep(null);
      }}
    >
      <defs>
        <pattern id="wf-dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="var(--color-canvas-dot)" />
        </pattern>
      </defs>
      <rect width={size.w} height={size.h} fill="url(#wf-dots)" rx={8} data-canvas-bg="true" />

      {workflow.edges.map((edge, i) => {
        const from = effective[edge.from];
        const to = effective[edge.to];
        if (!from || !to) return null;
        const dashed = edge.event === FEEDBACK_EVENT || edge.event === REJECT_EVENT;
        const label = edge.label ?? edge.event;
        if (edge.from === edge.to) return <SelfLoop key={`${edge.from}-${edge.event}-${i}`} at={from} label={label} dashed={dashed} />;
        return (
          <Arrow
            key={`${edge.from}-${edge.event}-${i}`}
            from={{ x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 }}
            to={{ x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 }}
            label={label}
            dashed={dashed}
            curveSign={edgeCurveSign(edge)}
          />
        );
      })}

      {workflow.steps.map((step) => {
        const pos = effective[step.id];
        if (!pos) return null;
        return (
          <WorkflowNode
            key={step.id}
            step={step}
            pos={pos}
            selected={selectedStepId === step.id}
            isEntry={workflow.entryStepId === step.id}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyDown}
            onDelete={onDeleteStep}
          />
        );
      })}
    </svg>
  );
}
