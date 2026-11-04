// Diagrams the model draws itself as Unicode text.
//
// - `DIAGRAM_GUIDE` tells the model how to draw them.
// - `validateDiagram` repairs unambiguous slips (a corner or side a column or two off, padding that drifts row by
//   row), then lints a drawing for alignment mistakes; errors reject it with findings the model can fix.
// - `renderDiagram` shows it as a themed card that always fits the width; `DiagramView` scrolls wide ones.
export { DIAGRAM_GUIDE, diagramGuide, diagramMaxWidth, GUIDE_EXAMPLE } from "./guide.ts";
export { type DiagramFinding, type Severity } from "./lint.ts";
export { STATUSES, type Status } from "./markers.ts";
export { type RenderOptions, renderDiagram } from "./render.ts";
export { type Diagram, type DiagramColor, DiagramSchema, type DiagramTheme } from "./types.ts";
export {
	DEFAULT_MAX_WIDTH,
	type DiagramCheck,
	type DiagramRepair,
	MAX_FINDINGS,
	normalizeBody,
	repairLines,
	type ValidateOptions,
	validateDiagram,
} from "./validate.ts";
export { DiagramView, type DiagramViewOptions, SCROLL_STEP } from "./view.ts";
