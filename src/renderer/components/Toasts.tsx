import { dismissToast, useStore } from '../state/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)} title="Click to dismiss">
          {t.text}
        </div>
      ))}
    </div>
  );
}
