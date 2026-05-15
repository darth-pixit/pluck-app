/**
 * Silent-paste confirmation pill. Used live by `NudgeView` (in the
 * dedicated nudge window) after a long-press fires, and as a still-shot
 * by the activation tour. The CSS animation in `index.css` runs on the
 * live variant; pass `static` to opt out (the tour wants the pill to
 * stay visible while the user reads the caption).
 */
export default function PasteConfirmPill({ static: isStatic = false }: { static?: boolean } = {}) {
  return (
    <div className={`paste-confirm-pill${isStatic ? " paste-confirm-pill-static" : ""}`}>
      <span className="paste-confirm-dot" />
      <span className="paste-confirm-lead">Pasted</span>
      <span className="paste-confirm-kbd">
        <span className="kc">⌃</span>
        <span className="kc">⇧</span>
        <span className="kc">V</span>
        <span className="paste-confirm-trail">more</span>
      </span>
    </div>
  );
}
